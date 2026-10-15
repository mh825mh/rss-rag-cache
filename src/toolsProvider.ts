import { tool, ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { statSync } from "node:fs";
import { getDb, getMeta, setMeta, getAllFeedStates } from "../lib/db.js";
import {
  getDbPath,
  getSettings,
  setSettings,
  loadFeeds,
  loadEnabledFeeds,
  loadFeedConfig,
  appendFeed,
  removeFeed,
  setFeedOptions
} from "../lib/config.js";
import { configSchematics, globalConfigSchematics } from "./config";
import { runRetention, pruneRemovedFeeds, getLastRefresh } from "../lib/retention.js";
import {
  refreshFeedsShared,
  retrieve,
  reindexMissing,
  reembedAll,
  backfillEmbeddings
} from "../lib/retriever.js";
import { getDiagnostics } from "../lib/diagnostics.js";
import { testFeed, discoverFeed } from "../lib/fetcher.js";
import {
  CORE_TOOLS,
  ADMIN_TOOL,
  GRANULAR_TOOLS,
  resolveToolSurface
} from "../lib/toolSurface.js";

export { CORE_TOOLS, ADMIN_TOOL, GRANULAR_TOOLS, resolveToolSurface };

function isoDate(ts: number) {
  return Number.isFinite(ts) ? new Date(ts).toISOString() : new Date(Date.now()).toISOString();
}

function settingsFromController(ctl: ToolsProviderController) {
  try {
    const g = ctl.getGlobalPluginConfig(globalConfigSchematics);
    const c = ctl.getPluginConfig(configSchematics);
    return setSettings({
      ...getSettings(),
      retentionDays: g.get("retentionDays"),
      refreshIntervalHours: g.get("refreshIntervalHours"),
      embeddingModel: g.get("embeddingModel"),
      chunkSize: g.get("chunkSize"),
      contextualChunks: g.get("contextualChunks"),
      contextChunks: g.get("contextChunks"),
      embedBatchSize: g.get("embedBatchSize"),
      embedConcurrency: g.get("embedConcurrency"),
      maxConcurrentFeeds: g.get("maxConcurrentFeeds"),
      semanticScanLimit: g.get("semanticScanLimit"),
      htmlLinkPatterns: g.get("htmlLinkPatterns"),
      scrapeFullText: g.get("scrapeFullText"),
      retentionBasis: g.get("retentionBasis"),
      refreshOnStartup: g.get("refreshOnStartup"),
      lmStudioBaseUrl: g.get("lmStudioBaseUrl"),
      enableAdminTools: g.get("enableAdminTools"),
      exposeGranularAdminTools: g.get("exposeGranularAdminTools"),
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
  const feeds = loadEnabledFeeds(s);
  const res = await refreshFeedsShared(s, feeds, { force });
  const ret = runRetention(s.retentionDays, s.retentionBasis || "publish_date", loadFeedConfig(s));

  let backfill: any = null;
  try {
    backfill = await backfillEmbeddings(s, { batchSize: 500, maxBatches: 8 });
  } catch (e) {
    backfill = { error: (e as Error).message };
  }

  setMeta("last_refresh", JSON.stringify({
    timestamp: Date.now(),
    added: res.added,
    updated: res.updated ?? 0,
    totalTimeSeconds: res.totalTimeSeconds,
    notModified: res.notModified,
    fastSuccess: res.fastMode.success,
    slowSuccess: res.slowMode.success.length,
    failedFeeds: res.failedFeeds,
    retention: ret,
    backfill,
  }));
  return {
    feeds: feeds.length,
    added: res.added,
    updated: res.updated ?? 0,
    notModified: res.notModified,
    skippedBackoff: res.skippedBackoff?.length ?? 0,
    failedCount: res.failedFeeds.length,
    failedFeeds: res.failedFeeds,
    retention: ret,
    backfill,
  };
}

// ---------------------------------------------------------------------------
// 1. Core Tools
// ---------------------------------------------------------------------------

const searchRssCacheTool = tool({
  name: "search_rss_cache",
  description: "Semantic + keyword hybrid search over the local RSS RAG cache. Filter by recency (days or after/before), feed (URL substring), author, tag, or collection. Sort by relevance (default) or date, and paginate with limit/offset.",
  parameters: {
    query: z.string(),
    days: z.number().optional(),
    after: z.string().optional(),
    before: z.string().optional(),
    feed: z.string().optional(),
    author: z.string().optional(),
    tag: z.string().optional(),
    collection: z.string().optional(),
    sort: z.enum(["relevance", "date"]).optional(),
    limit: z.number().optional(),
    offset: z.number().optional(),
  },
  implementation: async ({ query, days, after, before, feed, author, tag, collection, sort, limit, offset }: {
    query: string; days?: number; after?: string; before?: string; feed?: string; author?: string;
    tag?: string; collection?: string; sort?: "relevance" | "date"; limit?: number; offset?: number;
  }) => {
    const s = getSettings();
    const results = await retrieve(query, s, { days, after, before, feed, author, tag, collection, sort, limit, offset });
    if (!results.length) return { count: 0, results: [], note: "No matches." };
    return {
      count: results.length,
      results: results.map((r: any) => ({
        entryId: r.entry_id ?? r.id,
        title: r.title,
        link: r.link,
        feed: r.feed,
        author: r.author,
        date: r.pub_date_iso,
        tags: r.tags,
        score: typeof r.score === "number" ? Number(r.score.toFixed(3)) : undefined,
        similarity: typeof r.similarity === "number" ? Number(r.similarity.toFixed(3)) : undefined,
        snippet: (r.text || "").slice(0, 600),
      })),
    };
  }
});

const getRssArticleTool = tool({
  name: "get_rss_article",
  description: "Fetch the full text content, metadata, and chunk layout of a cached article by numeric entry ID or canonical URL.",
  parameters: {
    entryId: z.number().optional(),
    url: z.string().optional(),
    maxChars: z.number().optional(),
    offset: z.number().optional(),
    includeChunks: z.boolean().optional(),
  },
  implementation: async ({ entryId, url, maxChars, offset, includeChunks }: {
    entryId?: number;
    url?: string;
    maxChars?: number;
    offset?: number;
    includeChunks?: boolean;
  }) => {
    if (!entryId && !url) {
      return { error: "Must provide either entryId (number) or url (string)." };
    }
    const db = getDb();
    let entry: any;
    if (entryId) {
      entry = db.prepare(`
        SELECT id, guid, feed_url, title, link, pub_date, author, tags, collection, content, cached_at
        FROM entries WHERE id = ?
      `).get(entryId);
    } else if (url) {
      entry = db.prepare(`
        SELECT id, guid, feed_url, title, link, pub_date, author, tags, collection, content, cached_at
        FROM entries WHERE link = ? OR guid = ? LIMIT 1
      `).get(url, url);
    }

    if (!entry) {
      return { found: false, message: `No article found matching ${entryId ? `id=${entryId}` : `url="${url}"`}` };
    }

    const rawContent = entry.content || "";
    const totalChars = rawContent.length;
    const lim = Math.min(Math.max(Number(maxChars) || 12000, 500), 50000);
    const off = Math.max(Number(offset) || 0, 0);
    const slicedContent = rawContent.slice(off, off + lim);
    const hasMore = off + lim < totalChars;

    let parsedTags: string[] = [];
    try {
      parsedTags = entry.tags ? JSON.parse(entry.tags) : [];
    } catch {
      parsedTags = entry.tags ? String(entry.tags).split(",").map((t: string) => t.trim()) : [];
    }

    const res: Record<string, any> = {
      found: true,
      article: {
        id: entry.id,
        title: entry.title,
        link: entry.link,
        guid: entry.guid,
        feedUrl: entry.feed_url,
        pubDate: isoDate(entry.pub_date),
        author: entry.author || null,
        collection: entry.collection || null,
        tags: parsedTags,
        cachedAt: entry.cached_at ? isoDate(entry.cached_at) : null,
        totalChars,
        offset: off,
        returnedChars: slicedContent.length,
        hasMore,
        nextOffset: hasMore ? off + lim : null,
        content: slicedContent,
      }
    };

    if (includeChunks) {
      res.chunks = db.prepare(`
        SELECT chunk_index, text, embed_style
        FROM chunks WHERE entry_id = ? ORDER BY chunk_index ASC
      `).all(entry.id);
    }

    return res;
  }
});

const getRecentCacheArticlesTool = tool({
  name: "get_recent_cache_articles",
  description: "Get the most recent articles added to the cache. Use this to see what news is available or to summarize recent events without guessing search keywords.",
  parameters: {
    limit: z.number().optional()
  },
  implementation: async ({ limit }: { limit?: number }) => {
    const db = getDb();
    const lim = Math.max(1, Math.min(Number(limit) || 20, 100));
    const articles = db.prepare(`SELECT id, title, link, pub_date, feed_url FROM entries ORDER BY pub_date DESC LIMIT ?`).all(lim);
    return {
      count: articles.length,
      articles: articles.map((a: any) => ({
        entryId: a.id,
        title: a.title,
        link: a.link,
        date: isoDate(a.pub_date),
        feed: a.feed_url,
      }))
    };
  }
});

const manageRssFeedsTool = tool({
  name: "manage_rss_feeds",
  description: "Manage RSS/Atom feeds: list feeds, add a feed (with auto-discovery), remove a feed, test a URL, configure per-feed overrides, or trigger a refresh.",
  parameters: {
    action: z.enum(["list", "add", "remove", "test", "configure", "refresh"]),
    url: z.string().optional(),
    options: z.record(z.any()).optional(),
    force: z.boolean().optional(),
  },
  implementation: async ({ action, url, options, force }: {
    action: "list" | "add" | "remove" | "test" | "configure" | "refresh";
    url?: string;
    options?: Record<string, any>;
    force?: boolean;
  }) => {
    const s = getSettings();
    switch (action) {
      case "list": {
        const feedConfigs = loadFeedConfig(s);
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
          feeds: feedConfigs,
          feedUrls: feedConfigs.map((f: any) => f.url),
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
      case "add": {
        if (!url) return { error: "url is required for action 'add'" };
        let targetUrl = url;
        const looksLikeFeed = /\.(xml|rss|atom)(\?|$)/i.test(url) || /\/(rss|feed|feeds)(\/|$|\?)/i.test(url);
        let discoveredInfo: any = null;
        if (!looksLikeFeed) {
          try {
            const found = await discoverFeed(url);
            if (found.found && found.feedUrl && found.feedUrl !== url) {
              targetUrl = found.feedUrl;
              discoveredInfo = { requestedUrl: url, discoveredFeedUrl: found.feedUrl, type: found.type, candidates: found.candidates };
            }
          } catch { /* ignore */ }
        }
        const added = appendFeed(targetUrl, s);
        if (options && Object.keys(options).length > 0) {
          setFeedOptions(targetUrl, options, s);
        }
        return discoveredInfo ? { ...added, ...discoveredInfo } : added;
      }
      case "remove": {
        if (!url) return { error: "url is required for action 'remove'" };
        return removeFeed(url, s);
      }
      case "test": {
        if (!url) return { error: "url is required for action 'test'" };
        return testFeed(url);
      }
      case "configure": {
        if (!url) return { error: "url is required for action 'configure'" };
        if (!options || Object.keys(options).length === 0) return { ok: false, reason: "No options supplied" };
        return setFeedOptions(url, options, s);
      }
      case "refresh": {
        return refreshAll(s, force !== false);
      }
      default:
        return { error: `Unknown action: ${action}` };
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Admin Multiplexer Tool
// ---------------------------------------------------------------------------

const adminRssCacheTool = tool({
  name: "admin_rss_cache",
  description: "Cache administration: health diagnostics, VACUUM/optimize, prune removed feeds, reindex missing embeddings, rebuild vector index, or debug hybrid search.",
  parameters: {
    action: z.enum(["diagnostics", "optimize", "prune", "reindex", "reembed", "debug_search"]),
    query: z.string().optional(),
    days: z.number().optional(),
    after: z.string().optional(),
    before: z.string().optional(),
    feed: z.string().optional(),
    author: z.string().optional(),
    tag: z.string().optional(),
    collection: z.string().optional(),
    limit: z.number().optional(),
    offset: z.number().optional(),
    batchSize: z.number().optional(),
    rechunk: z.boolean().optional(),
  },
  implementation: async ({ action, query, days, after, before, feed, author, tag, collection, limit, offset, batchSize, rechunk }: {
    action: "diagnostics" | "optimize" | "prune" | "reindex" | "reembed" | "debug_search";
    query?: string;
    days?: number;
    after?: string;
    before?: string;
    feed?: string;
    author?: string;
    tag?: string;
    collection?: string;
    limit?: number;
    offset?: number;
    batchSize?: number;
    rechunk?: boolean;
  }) => {
    const s = getSettings();
    switch (action) {
      case "diagnostics":
        return getDiagnostics(s);
      case "optimize": {
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
      case "prune": {
        const feeds = loadFeeds(s);
        return pruneRemovedFeeds(feeds);
      }
      case "reindex": {
        return reindexMissing(s, Math.max(1, Math.min(Number(limit) || 2000, 20000)));
      }
      case "reembed": {
        return reembedAll(s, {
          batchSize: Math.max(50, Math.min(Number(batchSize) || 500, 5000)),
          rechunk: !!rechunk,
        });
      }
      case "debug_search": {
        if (!query) return { error: "query is required for action 'debug_search'" };
        const results = await retrieve(query, s, { days, after, before, feed, author, tag, collection, limit, offset, debug: true });
        return {
          count: results.length,
          results: results.map((r: any) => ({
            title: r.title,
            link: r.link,
            feed: r.feed,
            author: r.author,
            date: r.pub_date_iso,
            tags: r.tags,
            score: typeof r.score === "number" ? Number(r.score.toFixed(3)) : undefined,
            similarity: typeof r.similarity === "number" ? Number(r.similarity.toFixed(3)) : undefined,
            debug: r._debug || null,
            snippet: (r.text || "").slice(0, 600),
          })),
        };
      }
      default:
        return { error: `Unknown action: ${action}` };
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Granular Tools (Backwards Compatibility)
// ---------------------------------------------------------------------------

const refreshRssFeedsTool = tool({
  name: "refresh_rss_feeds",
  description: "Refresh all RSS feeds listed in feeds.txt, index new items, and apply retention. Feeds are normally fetched with ETag/Last-Modified validators so unchanged feeds cost almost nothing and temporarily-failing feeds back off. Set force=true to ignore validators and backoff and re-download everything.",
  parameters: { force: z.boolean().optional() },
  implementation: async ({ force }: { force?: boolean }) => {
    const s = getSettings();
    return refreshAll(s, force !== false);
  }
});

const listRssFeedsTool = tool({
  name: "list_rss_feeds",
  description: "List configured feeds and cache statistics (entry/chunk counts, missing embeddings, DB size).",
  parameters: {},
  implementation: async () => {
    const s = getSettings();
    const feedConfigs = loadFeedConfig(s);
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
      feeds: feedConfigs,
      feedUrls: feedConfigs.map((f: any) => f.url),
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
});

const addRssFeedTool = tool({
  name: "add_rss_feed",
  description: "Add an RSS/Atom feed URL or plain webpage URL to feeds.txt. If `url` is a homepage, it tries to auto-discover an alternate RSS/Atom feed and adds the discovered feed instead (returning `discoveredFeedUrl`).",
  parameters: { url: z.string() },
  implementation: async ({ url }: { url: string }) => {
    const s = getSettings();
    const looksLikeFeed = /\.(xml|rss|atom)(\?|$)/i.test(url) || /\/(rss|feed|feeds)(\/|$|\?)/i.test(url);
    if (!looksLikeFeed) {
      try {
        const found = await discoverFeed(url);
        if (found.found && found.feedUrl && found.feedUrl !== url) {
          const added = appendFeed(found.feedUrl, s);
          return { ...added, requestedUrl: url, discoveredFeedUrl: found.feedUrl, type: found.type, candidates: found.candidates };
        }
      } catch { /* ignore */ }
    }
    return appendFeed(url, s);
  }
});

const removeRssFeedTool = tool({
  name: "remove_rss_feed",
  description: "Remove a feed URL from feeds.txt. Cached articles are kept unless you also run prune_removed_feeds.",
  parameters: { url: z.string() },
  implementation: async ({ url }: { url: string }) => {
    const s = getSettings();
    return removeFeed(url, s);
  }
});

const testFeedTool = tool({
  name: "test_feed",
  description: "Check whether a URL is a working RSS/Atom feed or a scrapeable HTML page, and how many items it exposes.",
  parameters: { url: z.string() },
  implementation: async ({ url }: { url: string }) => {
    return testFeed(url);
  }
});

const pruneRemovedFeedsTool = tool({
  name: "prune_removed_feeds",
  description: "Delete cached articles whose source feed is no longer listed in feeds.txt. Run refresh first, then this.",
  parameters: {},
  implementation: async () => {
    const s = getSettings();
    const feeds = loadFeeds(s);
    return pruneRemovedFeeds(feeds);
  }
});

const reindexMissingEmbeddingsTool = tool({
  name: "reindex_missing_embeddings",
  description: "Re-embed chunks stored text-only when the embedding model was offline, and re-chunk entries that have no chunks. Call once the model is loaded.",
  parameters: { limit: z.number().optional() },
  implementation: async ({ limit }: { limit?: number }) => {
    const s = getSettings();
    return reindexMissing(s, Math.max(1, Math.min(Number(limit) || 2000, 20000)));
  }
});

const reembedAllTool = tool({
  name: "reembed_all",
  description: "Rebuild the entire vector index with the currently configured embedding model. Use after changing the embedding model (or on a dimension-mismatch warning). The model must be loaded; this can take a while on large caches.",
  parameters: { batchSize: z.number().optional(), rechunk: z.boolean().optional() },
  implementation: async ({ batchSize, rechunk }: { batchSize?: number; rechunk?: boolean }) => {
    const s = getSettings();
    return reembedAll(s, {
      batchSize: Math.max(50, Math.min(Number(batchSize) || 500, 5000)),
      rechunk: !!rechunk,
    });
  }
});

const optimizeRssCacheTool = tool({
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
});

const setFeedOptionsTool = tool({
  name: "set_feed_options",
  description: "Set per-feed options (stored in feeds.json): enabled, tags, scrapeFullText, linkPatterns, maxItems, headers, retentionDays, collection. Only the supplied fields change. Use tags/collection later as search filters.",
  parameters: {
    url: z.string(),
    enabled: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    scrapeFullText: z.boolean().optional(),
    linkPatterns: z.string().optional(),
    maxItems: z.number().optional(),
    headers: z.record(z.string()).optional(),
    retentionDays: z.number().optional(),
    collection: z.string().optional(),
  },
  implementation: async (args: {
    url: string; enabled?: boolean; tags?: string[]; scrapeFullText?: boolean;
    linkPatterns?: string; maxItems?: number; headers?: Record<string, string>;
    retentionDays?: number; collection?: string;
  }) => {
    const s = getSettings();
    const { url, ...options } = args;
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(options)) if (v !== undefined) cleaned[k] = v;
    if (!Object.keys(cleaned).length) return { ok: false, reason: "No options supplied" };
    return setFeedOptions(url, cleaned, s);
  }
});

const searchRssCacheDebugTool = tool({
  name: "search_rss_cache_debug",
  description: "Debug version of search_rss_cache: returns ranking details for each result (per-list ranks, RRF contribution, cosine similarity, fused combined score). Use with debug options.",
  parameters: {
    query: z.string(),
    days: z.number().optional(),
    after: z.string().optional(),
    before: z.string().optional(),
    feed: z.string().optional(),
    author: z.string().optional(),
    tag: z.string().optional(),
    collection: z.string().optional(),
    sort: z.enum(["relevance", "date"]).optional(),
    limit: z.number().optional(),
    offset: z.number().optional(),
  },
  implementation: async ({ query, days, after, before, feed, author, tag, collection, sort, limit, offset }: {
    query: string; days?: number; after?: string; before?: string; feed?: string; author?: string;
    tag?: string; collection?: string; sort?: "relevance" | "date"; limit?: number; offset?: number;
  }) => {
    const s = getSettings();
    const results = await retrieve(query, s, { days, after, before, feed, author, tag, collection, sort, limit, offset, debug: true });
    return {
      count: results.length,
      results: results.map((r: any) => ({
        title: r.title,
        link: r.link,
        feed: r.feed,
        author: r.author,
        date: r.pub_date_iso,
        tags: r.tags,
        score: typeof r.score === "number" ? Number(r.score.toFixed(3)) : undefined,
        similarity: typeof r.similarity === "number" ? Number(r.similarity.toFixed(3)) : undefined,
        debug: r._debug || null,
        snippet: (r.text || "").slice(0, 600),
      })),
    };
  }
});

const cacheDiagnosticsTool = tool({
  name: "cache_diagnostics",
  description: "Report cache health: entry/chunk counts, embedding coverage and gaps (including contextual-embedding upgrade progress), DB/WAL size, resident vector-index stats, feed backoff state, embedding model/dimension, schema version, and suggested actions.",
  parameters: {},
  implementation: async () => {
    return getDiagnostics(getSettings());
  }
});

// ---------------------------------------------------------------------------
// 4. Main Provider Entrypoint
// ---------------------------------------------------------------------------

export async function toolsProvider(ctl: ToolsProviderController) {
  const s = settingsFromController(ctl);

  const toolsMap: Record<string, any> = {
    search_rss_cache: searchRssCacheTool,
    get_rss_article: getRssArticleTool,
    get_recent_cache_articles: getRecentCacheArticlesTool,
    manage_rss_feeds: manageRssFeedsTool,
    admin_rss_cache: adminRssCacheTool,
    refresh_rss_feeds: refreshRssFeedsTool,
    list_rss_feeds: listRssFeedsTool,
    add_rss_feed: addRssFeedTool,
    remove_rss_feed: removeRssFeedTool,
    test_feed: testFeedTool,
    prune_removed_feeds: pruneRemovedFeedsTool,
    reindex_missing_embeddings: reindexMissingEmbeddingsTool,
    reembed_all: reembedAllTool,
    optimize_rss_cache: optimizeRssCacheTool,
    set_feed_options: setFeedOptionsTool,
    search_rss_cache_debug: searchRssCacheDebugTool,
    cache_diagnostics: cacheDiagnosticsTool,
  };

  const allowedNames = resolveToolSurface({
    enableAdminTools: Boolean(s.enableAdminTools),
    exposeGranularAdminTools: Boolean(s.exposeGranularAdminTools),
  });

  return allowedNames.map((name: string) => toolsMap[name]).filter(Boolean);
}

