import { getDb } from "./db.js";

export function runRetention(retentionDays) {
  const db = getDb();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const info = db.prepare(`DELETE FROM entries WHERE cached_at < ?`).run(cutoff);
  // FTS triggers handle chunk cleanup via ON DELETE CASCADE? They don't — clean explicitly:
  db.prepare(`DELETE FROM chunks WHERE entry_id NOT IN (SELECT id FROM entries)`).run();
  return { deletedEntries: info.changes, cutoff };
}

export function getLastRefresh() {
  const db = getDb();
  const row = db.prepare(`SELECT MAX(cached_at) AS m FROM entries`).get();
  return row?.m ?? 0;
}