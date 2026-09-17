import { tool } from "@lmstudio/sdk";
import { z } from "zod";
import { statSync } from "node:fs";
import { getDb, getMeta, setMeta } from "../lib/db.js";
import { getDbPath } from "../lib/config.js";
import { runRetention, pruneRemovedFeeds, getLastRefresh } from "../lib/retention.js";
import { refreshFeeds, retrieve, reindexMissing } from "../lib/retriever.js";
import { testFeed } from "../lib/fetcher.js";
import { loadSettings, loadFeeds, appendFeed, removeFeed } from "../lib/config.js";

function isoDate(ts) {
  return Number.isFinite(ts) ? new Date(ts).toISOString() : new Date(Date.now()).toISOString();
}

function getStats() {
  const db = getDb();
  const stats = db.prepare(`
    SELECT (SELECT COUNT(*) FROM entries) AS entries,
           (SELECT COUNT(*) FROM chunks) AS chunks,
           (SELECT COUNT(*) FROM chunks WHERE embedding IS NULL) AS missing_embeddings
  `).get();
  let dbSize = 0;
  try {
    dbSize = statSync(getDbPath()).size;
  } catch { /* ignore */ }
  return { ...stats, dbSize };
}

async function refreshAll(s) {
  const feeds = loadFeeds(s);
  const res = await refreshFeeds(s, feeds);
  const ret = runRetention(s.retentionDays, s.retentionBasis || "publish_date");
  setMeta("last_refresh", JSON.stringify({
    timestamp: Date.now(),
    added: res.added,
    totalTimeSeconds: res.totalTimeSeconds,
    fastSuccess: res.fastMode.success,
    slowSuccess: res.slowMode.success.length,
    failedFeeds: res.failedFeeds,
    retention: ret,
  }));
  return { feeds: feeds.length, added: res.added, failedCount: res.failedFeeds.length, failedFeeds: res.failedFeeds, retention: ret };
}

export async function toolsProvider(_ctl: any) {
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
        const s = loadSettings();
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
            snippet: r.text.slice(0, 600),
          })),
        };
      }
    }),
    tool({
      name: "refresh_rss_feeds",
      description: "Force-refresh all RSS feeds listed in feeds.txt, index new items, and apply retention.",
      parameters: {},
      implementation: async () => {
        const s = loadSettings();
        return refreshAll(s);
      }
    }),
    tool({
      name: "list_rss_feeds",
      description: "List configured feeds and cache statistics (entry/chunk counts, missing embeddings, DB size).",
      parameters: {},
      implementation: async () => {
        const s = loadSettings();
        const feeds = loadFeeds(s);
        const stats = getStats();
        const lastRefresh = getLastRefresh();
        let lastReport = null;
        try {
          const raw = getMeta("last_refresh");
          lastReport = raw ? JSON.parse(raw) : null;
        } catch { /* ignore */ }
        return {
          feeds,
          entries: stats.entries,
          chunks: stats.chunks,
          missingEmbeddings: stats.missing_embeddings,
          dbSizeBytes: stats.dbSize,
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
        const s = loadSettings();
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
        const s = loadSettings();
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
        const s = loadSettings();
        const feeds = loadFeeds(s);
        return pruneRemovedFeeds(feeds);
      }
    }),
    tool({
      name: "reindex_missing_embeddings",
      description: "Re-embed chunks that were stored as text-only when the embedding model was offline. Call once the model is loaded.",
      parameters: {
        limit: z.number().optional()
      },
      implementation: async ({ limit }: { limit?: number }) => {
        const s = loadSettings();
        return reindexMissing(s, Math.max(1, Math.min(Number(limit) || 2000, 20000)));
      }
    }),
  ];
}