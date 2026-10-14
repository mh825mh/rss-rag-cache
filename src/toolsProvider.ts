import { tool, ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { statSync } from "node:fs";
import { getDb, getMeta, setMeta, getAllFeedStates } from "../lib/db.js";
import { getDbPath, getSettings, setSettings, loadFeeds, appendFeed, removeFeed } from "../lib/config.js";
import { configSchematics, globalConfigSchematics } from "./config";
import { runRetention, pruneRemovedFeeds, getLastRefresh } from "../lib/retention.js";
import { refreshFeedsShared, retrieve, reindexMissing, reembedAll } from "../lib/retriever.js";
import { testFeed } from "../lib/fetcher.js";

function isoDate(ts: number) {
  return Number.isFinite(ts) ? new Date(ts).toISOString() : new Date(Date.now()).toISOString();
}

// Reads the values the user set in the LM Studio config UI and caches them so
// background tasks (the auto-refresh timer) see the same configuration.
// Previously nothing ever read the schematics, so the UI was inert and every
// lookup fell back to hard-coded defaults.
function settingsFromController(ctl: ToolsProviderController) {
  try {
    const g = ctl.getGlobalPluginConfig(globalConfigSchematics);
    const c = ctl.getPluginConfig(configSchematics);
    return setSettings({
      ...getSettings(),
      // global (shared cache/index) settings
      retentionDays: g.get("retentionDays"),
      refreshIntervalHours: g.get("refreshIntervalHours"),
      embeddingModel: g.get("embeddingModel"),
      chunkSize: g.get("chunkSize"),
      embedBatchSize: g.get("embedBatchSize"),
      maxConcurrentFeeds: g.get("maxConcurrentFeeds"),
      semanticScanLimit: g.get("semanticScanLimit"),
      htmlLinkPatterns: g.get("htmlLinkPatterns"),
      scrapeFullText: g.get("scrapeFullText"),
      retentionBasis: g.get("retentionBasis"),
      refreshOnStartup: g.get("refreshOnStartup"),
      lmStudioBaseUrl: g.get("lmStudioBaseUrl"),
      // per-chat setting
      topK: c.get("topK"),
    });
  } catch (e) {
    console.warn("[rss-rag] Could not read plugin config; using defaults:", (e as Error).message);
    return getSettings();
  }
}

function getStats() {
  const db = getDb();
  const stats = db.prepare(`
    SELECT (SELECT COUNT(*) FROM entries) AS entries,
           (SELECT COUNT(*) FROM chunks) AS chunks,
           (SELECT COUNT(*) FROM chunks WHERE embedding IS NULL) AS missing_embeddings,
           (SELECT COUNT(*) FROM entries e WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.entry_id = e.id)) AS chunkless_entries
  `).get();
  let dbSize = 0;
  try {
    dbSize = statSync(getDbPath()).size;
  } catch { /* ignore */ }
  return { ...stats, dbSize };
}

async function refreshAll(s: ReturnType<typeof getSettings>, force = true) {
  const feeds = loadFeeds(s);
  const res = await refreshFeedsShared(s, feeds, { force });
  const ret = runRetention(s.retentionDays, s.retentionBasis || "publish_date");
  setMeta("last_refresh", JSON.stringify({
    timestamp: Date.now(),
    added: res.added,
    totalTimeSeconds: res.totalTimeSeconds,
    notModified: res.notModified,
    fastSuccess: res.fastMode.success,
    slowSuccess: res.slowMode.success.length,
    failedFeeds: res.failedFeeds,
    retention: ret,
  }));
  return {
    feeds: feeds.length,
    added: res.added,
    notModified: res.notModified,
    skippedBackoff: res.skippedBackoff?.length ?? 0,
    failedCount: res.failedFeeds.length,
    failedFeeds: res.failedFeeds,
    retention: ret,
  };
}

export async function toolsProvider(ctl: ToolsProviderController) {
  // Resolve UI config once when the provider is created.
  settingsFromController(ctl);

  return [
    tool({
      name: "search_rss_cache",
      description: "Semantic + keyword search over the local RSS RAG cache. Optionally filter by days, feed (URL substring), or author.",
      parameters: {
        query: z.string(),
        days: z.number().optional(),
        feed: z.string().optional(),
        author: z.string().optional(),
      },
      implementation: async ({ query, days, feed, author }: { query: string; days?: number; feed?: string; author?: string }) => {
        const s = getSettings();
        const results = await retrieve(query, s, { days, feed, author });

        if (!results.length) return { count: 0, results: [], note: "No matches." };

        return {
          count: results.length,
          results: results.map((r: any) => ({
            title: r.title,
            link: r.link,
            feed: r.feed,
            author: r.author,
            date: r.pub_date_iso,
            score: typeof r.score === "number" ? Number(r.score.toFixed(3)) : undefined,
            snippet: (r.text || "").slice(0, 600),
          })),
        };
      }
    }),
    tool({
      name: "refresh_rss_feeds",
      description: "Refresh all RSS feeds listed in feeds.txt, index new items, and apply retention. Feeds are normally fetched with ETag/Last-Modified validators so unchanged feeds cost almost nothing and temporarily-failing feeds back off. Set force=true to ignore validators and backoff and re-download everything.",
      parameters: {
        force: z.boolean().optional(),
      },
      implementation: async ({ force }: { force?: boolean }) => {
        const s = getSettings();
        return refreshAll(s, force !== false);
      }
    }),
    tool({
      name: "list_rss_feeds",
      description: "List configured feeds and cache statistics (entry/chunk counts, missing embeddings, DB size).",
      parameters: {},
      implementation: async () => {
        const s = getSettings();
        const feeds = loadFeeds(s);
        const stats = getStats();
        const lastRefresh = getLastRefresh();
        let lastReport = null;
        try {
          const raw = getMeta("last_refresh");
          lastReport = raw ? JSON.parse(raw) : null;
        } catch { /* ignore */ }
        const now = Date.now();
        const feedStates = [...getAllFeedStates().values()].map((f: any) => ({
          url: f.url,
          lastStatus: f.last_status ?? null,
          lastFetched: f.last_fetched ? isoDate(f.last_fetched) : null,
          failCount: f.fail_count ?? 0,
          nextRetry: f.next_retry_at ? isoDate(f.next_retry_at) : null,
          backingOff: !!f.next_retry_at && f.next_retry_at > now,
          error: f.last_error || undefined,
        }));
        return {
          feeds,
          feedStates,
          entries: stats.entries,
          chunks: stats.chunks,
          missingEmbeddings: stats.missing_embeddings,
          chunklessEntries: stats.chunkless_entries,
          dbSizeBytes: stats.dbSize,
          embeddingModel: getMeta("embedding_model"),
          embeddingDim: getMeta("embedding_dim"),
          lastRefresh: lastRefresh ? isoDate(lastRefresh) : null,
          lastRefreshReport: lastReport,
        };
      }
    }),
    tool({
      name: "get_recent_cache_articles",
      description: "Get the most recent articles added to the cache. Use this to see what news is available or to summarize recent events without guessing search keywords.",
      parameters: {
        limit: z.number().optional()
      },
      implementation: async ({ limit }: { limit?: number }) => {
        const db = getDb();
        const lim = Math.max(1, Math.min(Number(limit) || 20, 100));
        const articles = db.prepare(`SELECT title, link, pub_date, feed_url FROM entries ORDER BY pub_date DESC LIMIT ?`).all(lim);
        return {
          count: articles.length,
          articles: articles.map((a: any) => ({
            title: a.title,
            link: a.link,
            date: isoDate(a.pub_date),
            feed: a.feed_url,
          }))
        };
      }
    }),
    tool({
      name: "add_rss_feed",
      description: "Add an RSS/Atom feed URL or plain webpage URL to feeds.txt.",
      parameters: {
        url: z.string()
      },
      implementation: async ({ url }: { url: string }) => {
        const s = getSettings();
        return appendFeed(url, s);
      }
    }),
    tool({
      name: "remove_rss_feed",
      description: "Remove a feed URL from feeds.txt. Cached articles are kept unless you also run prune_removed_feeds.",
      parameters: {
        url: z.string()
      },
      implementation: async ({ url }: { url: string }) => {
        const s = getSettings();
        return removeFeed(url, s);
      }
    }),
    tool({
      name: "test_feed",
      description: "Check whether a URL is a working RSS/Atom feed or a scrapeable HTML page, and how many items it exposes.",
      parameters: {
        url: z.string()
      },
      implementation: async ({ url }: { url: string }) => {
        return testFeed(url);
      }
    }),
    tool({
      name: "prune_removed_feeds",
      description: "Delete cached articles whose source feed is no longer listed in feeds.txt. Run refresh first, then this.",
      parameters: {},
      implementation: async () => {
        const s = getSettings();
        const feeds = loadFeeds(s);
        return pruneRemovedFeeds(feeds);
      }
    }),
    tool({
      name: "reindex_missing_embeddings",
      description: "Re-embed chunks stored text-only when the embedding model was offline, and re-chunk entries that have no chunks. Call once the model is loaded.",
      parameters: {
        limit: z.number().optional()
      },
      implementation: async ({ limit }: { limit?: number }) => {
        const s = getSettings();
        return reindexMissing(s, Math.max(1, Math.min(Number(limit) || 2000, 20000)));
      }
    }),
    tool({
      name: "reembed_all",
      description: "Rebuild the entire vector index with the currently configured embedding model. Use after changing the embedding model (or on a dimension-mismatch warning). The model must be loaded; this can take a while on large caches.",
      parameters: {
        batchSize: z.number().optional(),
        rechunk: z.boolean().optional()
      },
      implementation: async ({ batchSize, rechunk }: { batchSize?: number; rechunk?: boolean }) => {
        const s = getSettings();
        return reembedAll(s, {
          batchSize: Math.max(50, Math.min(Number(batchSize) || 500, 5000)),
          rechunk: !!rechunk,
        });
      }
    }),
    tool({
      name: "optimize_rss_cache",
      description: "Reclaim disk space and refresh query statistics (WAL checkpoint + VACUUM + ANALYZE). Can take a while on large caches.",
      parameters: {},
      implementation: async () => {
        const db = getDb();
        const sizeOf = () => {
          try { return statSync(getDbPath()).size; } catch { return 0; }
        };
        const beforeBytes = sizeOf();
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.exec("VACUUM");
        db.exec("ANALYZE");
        const afterBytes = sizeOf();
        return { beforeBytes, afterBytes, savedBytes: Math.max(0, beforeBytes - afterBytes) };
      }
    }),
  ];
}
