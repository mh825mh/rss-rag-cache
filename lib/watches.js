// Saved "watch" queries. A watch stores a search query plus optional filters;
// after every refresh the plugin re-runs it and reports how many NEW articles
// matched (and the top hit), so the user gets a digest without a chat pass.
//
// Evaluation is deliberately cheap: retrieves read through the normal ranking
// pipeline but are bounded to a small window (after: lastRun), so a dozen
// watches add milliseconds, not minutes, to a refresh.

import { getDb } from "./db.js";
import { retrieve } from "./retriever.js";
import { log } from "./log.js";

const MAX_WATCHES = 50;

// Upper bound for a watch's `after` window: even a never-run watch only looks
// back 30 days.
const DEFAULT_LOOKBACK_MS = 30 * 24 * 3600 * 1000;

const FILTER_KEYS = ["days", "feed", "author", "tag", "collection", "sort"];

const clampInt = (v, min, max, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
};

function nnFilters(filters) {
  const out = {};
  for (const [k, v] of Object.entries(filters || {})) {
    if (v === undefined || v === null || v === "") continue;
    if (FILTER_KEYS.includes(k)) out[k] = k === "days" ? clampInt(v, 1, 365, undefined) : String(v);
  }
  return out;
}

export function listWatches() {
  const db = getDb();
  return db.prepare(`SELECT * FROM watches ORDER BY id ASC`).all().map((w) => ({
    ...w,
    savedFilters: safeParse(w.filters),
  }));
}

function safeParse(s) {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

export function addWatch({ name, query, ...filters }, settings) {
  const db = getDb();
  const nm = String(name || "").trim();
  const q = String(query || "").trim();
  if (!nm || !q) return { ok: false, reason: "name and query are required" };
  const count = db.prepare(`SELECT COUNT(*) AS c FROM watches`).get().c;
  if (count >= MAX_WATCHES) return { ok: false, reason: `Watch limit reached (${MAX_WATCHES})` };
  const clean = nnFilters(filters);
  const info = db.prepare(`
    INSERT INTO watches (name, query, filters, created_at)
    VALUES (?, ?, ?, ?)
  `).run(nm, q, JSON.stringify(clean), Date.now());
  return { ok: true, id: Number(info.lastInsertRowid), savedFilters: clean };
}

export function removeWatch(id) {
  const db = getDb();
  const wid = clampInt(id, 1, Number.MAX_SAFE_INTEGER, 0);
  const info = db.prepare(`DELETE FROM watches WHERE id = ?`).run(wid);
  return info.changes ? { ok: true, removed: wid } : { ok: false, reason: `No watch with id ${id}` };
}

// Runs every watch against the current cache. Called after a refresh; results
// are returned to the caller (refresh reports embed them as `watchHits`) and
// summarized into each watch row (last_run, last_hits) for `list`.
export async function evaluateWatches(settings) {
  const watches = listWatches();
  const hits = [];
  if (!watches.length) return hits;

  for (const w of watches) {
    const since = Number.isFinite(Number(w.last_run)) && w.last_run > 0
      ? Number(w.last_run) + 1
      : Date.now() - DEFAULT_LOOKBACK_MS;
    try {
      const res = await retrieve(w.query, settings, {
        ...w.savedFilters,
        after: new Date(since).toISOString(),
        limit: 10,
        offset: 0,
      });
      const fresh = res.filter((r) => {
        const ts = Number(r.pub_date);
        return Number.isFinite(ts) ? ts >= since : false;
      });
      // Advance the marker even when nothing matched so the window keeps
      // moving; a stale window could otherwise evaluate months of history.
      markRun(w.id, fresh.length);
      if (fresh.length) {
        hits.push({
          id: w.id,
          name: w.name,
          query: w.query,
          newCount: fresh.length,
          top: fresh.slice(0, 3).map((r) => ({
            title: r.title,
            link: r.link,
            date: r.pub_date_iso,
            score: typeof r.score === "number" ? Number(r.score.toFixed(3)) : undefined,
          })),
        });
      }
    } catch (e) {
      log.warn(`Watch "${w.name}" failed: ${e.message}`);
    }
  }
  return hits;
}

function markRun(id, hitCount) {
  const db = getDb();
  db.prepare(`UPDATE watches SET last_run = ?, last_hits = ? WHERE id = ?`).run(Date.now(), hitCount, Number(id));
}

// Test hook: forget everything a watch remembers (useful for fresh fixtures).
export function resetWatches() {
  const db = getDb();
  db.exec(`DELETE FROM watches`);
}
