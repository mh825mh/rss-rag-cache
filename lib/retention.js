import { getDb } from "./db.js";

export function runRetention(retentionDays, basis = "publish_date") {
  const db = getDb();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const col = basis === "cached_at" ? "cached_at" : "COALESCE(pub_date, cached_at)";
  const info = db.prepare(`DELETE FROM entries WHERE ${col} < ?`).run(cutoff);
  // FTS triggers handle chunk cleanup via ON DELETE CASCADE when FK is on;
  // the explicit sweep below is a safety net.
  db.prepare(`DELETE FROM chunks WHERE entry_id NOT IN (SELECT id FROM entries)`).run();
  return { deletedEntries: info.changes, cutoff, basis };
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
  return { removed: info.changes };
}

export function getLastRefresh() {
  const db = getDb();
  const row = db.prepare(`SELECT MAX(cached_at) AS m FROM entries`).get();
  return row?.m ?? 0;
}