import { statSync, existsSync } from "node:fs";
import { getDb, getMeta, getAllFeedStates } from "./db.js";
import { getDbPath, loadFeedConfig } from "./config.js";

const iso = (ts) => (Number.isFinite(Number(ts)) ? new Date(Number(ts)).toISOString() : null);

// One-call health report for the cache: coverage, size, feed state and a short
// list of suggested next actions. Designed to be cheap enough for the model to
// call before deciding whether a repair is needed.
export function getDiagnostics(settings = {}) {
  const db = getDb();
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM entries) AS entries,
      (SELECT COUNT(*) FROM chunks) AS chunks,
      (SELECT COUNT(*) FROM chunks WHERE embedding IS NULL) AS missingEmbeddings,
      (SELECT COUNT(*) FROM entries e WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.entry_id = e.id)) AS chunklessEntries,
      (SELECT COUNT(DISTINCT feed_url) FROM entries) AS feedsWithEntries,
      (SELECT MIN(pub_date) FROM entries) AS oldest,
      (SELECT MAX(pub_date) FROM entries) AS newest
  `).get();

  const embeddingModel = getMeta("embedding_model");
  const embeddingDim = getMeta("embedding_dim");
  const coverage = stats.chunks > 0 ? 1 - stats.missingEmbeddings / stats.chunks : 1;

  let schemaVersion = 0;
  try {
    schemaVersion = Number(db.prepare(`PRAGMA user_version`).get()?.user_version) || 0;
  } catch {
    /* ignore */
  }

  const feedConfig = loadFeedConfig(settings);
  const now = Date.now();
  const failingFeeds = [...getAllFeedStates().values()]
    .filter((s) => s.next_retry_at && s.next_retry_at > now)
    .map((s) => ({ url: s.url, error: s.last_error || undefined, retryAt: iso(s.next_retry_at), failCount: s.fail_count ?? 0 }));

  let dbSizeBytes = 0;
  let walSizeBytes = 0;
  try { dbSizeBytes = statSync(getDbPath()).size; } catch { /* ignore */ }
  try {
    const wal = `${getDbPath()}-wal`;
    if (existsSync(wal)) walSizeBytes = statSync(wal).size;
  } catch { /* ignore */ }

  const suggestions = [];
  if (!feedConfig.length) suggestions.push("No feeds are configured. Add one with add_rss_feed.");
  if (stats.missingEmbeddings > 0 || stats.chunklessEntries > 0) {
    suggestions.push("Embedding gaps detected. Load the embedding model, then run reindex_missing_embeddings.");
  }
  if (coverage < 0.9) suggestions.push(`Embedding coverage is ${(coverage * 100).toFixed(1)}%; run reindex_missing_embeddings.`);
  if (embeddingModel && settings.embeddingModel && embeddingModel !== settings.embeddingModel) {
    suggestions.push(`Cache was built with "${embeddingModel}" but settings now use "${settings.embeddingModel}". Run reembed_all.`);
  }
  if (walSizeBytes > 50 * 1024 * 1024) suggestions.push("The WAL file is large; run optimize_rss_cache to checkpoint and reclaim space.");
  if (failingFeeds.length) suggestions.push(`${failingFeeds.length} feed(s) are in backoff; verify their URLs.`);
  if (!suggestions.length) suggestions.push("Cache looks healthy.");

  return {
    entries: stats.entries,
    chunks: stats.chunks,
    missingEmbeddings: stats.missingEmbeddings,
    chunklessEntries: stats.chunklessEntries,
    embeddingCoveragePct: Math.round(coverage * 1000) / 10,
    feedsConfigured: feedConfig.length,
    feedsEnabled: feedConfig.filter((f) => f.enabled !== false).length,
    feedsWithEntries: stats.feedsWithEntries,
    oldestEntry: iso(stats.oldest),
    newestEntry: iso(stats.newest),
    embeddingModel,
    embeddingDim,
    schemaVersion,
    dbSizeBytes,
    walSizeBytes,
    failingFeeds,
    lastRefresh: (() => {
      const raw = getMeta("last_refresh");
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return raw; }
    })(),
    suggestions,
  };
}
