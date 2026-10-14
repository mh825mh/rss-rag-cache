import { getDb } from "./db.js";

export function runRetention(retentionDays, basis = "publish_date") {
  const db = getDb();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const col = basis === "cached_at" ? "cached_at" : "COALESCE(pub_date, cached_at)";
  const info = db.prepare(`DELETE FROM entries WHERE ${col} < ?`).run(cutoff);
  // FTS triggers handle chunk cleanup via ON DELETE CASCADE when FK is on;
  // the explicit sweep below is a safety net.
  db.prepare(`DELETE FROM chunks WHERE entry_id NOT IN (SELECT id FROM entries)`).run();
  return { deletedEntries: info.changes, cutoff, basis, maintenance: autoMaintain(db) };
}

// Cheap upkeep on every retention pass: refresh planner statistics, and VACUUM
// only once a meaningful share of pages are free — so a routine refresh doesn't
// rewrite the entire multi-hundred-MB file every time.
export function autoMaintain(db = getDb()) {
  const out = { ok: false, vacuumed: false, pageCount: 0, freelistCount: 0 };
  try {
    out.pageCount = Number(db.prepare(`PRAGMA page_count`).get()?.page_count) || 0;
    out.freelistCount = Number(db.prepare(`PRAGMA freelist_count`).get()?.freelist_count) || 0;
    if (out.pageCount > 0 && out.freelistCount / out.pageCount > 0.2) {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.exec("VACUUM");
      out.vacuumed = true;
      out.freelistCount = Number(db.prepare(`PRAGMA freelist_count`).get()?.freelist_count) || 0;
    }
    db.exec("PRAGMA optimize");
    out.ok = true;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

// Removes cached articles whose source feed is no longer in feeds.txt.
// Returns without deleting when no feeds are configured (would wipe the cache).
export function pruneRemovedFeeds(activeFeedUrls) {
  const db = getDb();
  const list = (activeFeedUrls || []).map((u) => String(u).trim()).filter(Boolean);
  if (!list.length) return { removed: 0, note: "No feeds configured; nothing pruned." };
  const placeholders = list.map(() => "?").join(",");
  const info = db.prepare(`DELETE FROM entries WHERE feed_url NOT IN (${placeholders})`).run(...list);
  db.prepare(`DELETE FROM chunks WHERE entry_id NOT IN (SELECT id FROM entries)`).run();
  // Drop health/validator state for feeds that are no longer configured.
  db.prepare(`DELETE FROM feeds_state WHERE url NOT IN (${placeholders})`).run(...list);
  return { removed: info.changes };
}

export function getLastRefresh() {
  const db = getDb();
  // Prefer the explicit completion marker written by refreshFeeds(). Using
  // MAX(cached_at) here meant a poll yielded "now" whenever *any* entry was
  // inserted, so the interval could never elapse and every idle tick re-fetched
  // all feeds. Fall back to MAX(cached_at) only for pre-marker databases.
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'last_refresh'`).get();
  if (row?.value) {
    try {
      const parsed = JSON.parse(row.value);
      const ts = typeof parsed === "number" ? parsed : parsed?.timestamp;
      if (Number.isFinite(ts)) return ts;
    } catch {
      const ts = Number(row.value);
      if (Number.isFinite(ts)) return ts;
    }
  }
  const legacy = db.prepare(`SELECT MAX(cached_at) AS m FROM entries`).get();
  return legacy?.m ?? 0;
}