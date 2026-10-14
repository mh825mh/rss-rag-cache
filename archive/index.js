import { loadSettings, loadFeeds } from "./lib/config.js";
import { getDb } from "./lib/db.js";
import { runRetention, getLastRefresh } from "./lib/retention.js";
import { refreshFeeds, retrieve } from "./lib/retriever.js";

// Force settings.json → DB init on load
const settings = loadSettings();
getDb();

let refreshTimer = null;

async function maybeAutoRefresh() {
  const last = getLastRefresh();
  const due = Date.now() - last > settings.refreshIntervalHours * 3600 * 1000;
  if (due) {
    try {
      const feeds = loadFeeds(settings);
      const res = await refreshFeeds(settings, feeds);
      runRetention(settings.retentionDays);
      console.log("[rss-rag] refresh:", res);
    } catch (e) {
      console.error("[rss-rag] refresh error:", e.message);
    }
  }
}

maybeAutoRefresh();
refreshTimer = setInterval(maybeAutoRefresh, Math.max(1, settings.refreshIntervalHours) * 3600 * 1000);

// ── LM Studio tool registration ───────────────────────────────────────────
// Adapt the wrapper to whatever SDK version you target. The deep-swarm plugin
// uses lmstudio's tool server; this is the equivalent minimal shape.
export const tools = [
  {
    name: "search_rss_cache",
    description:
      "Semantic search over the local RSS RAG cache. Use this to answer questions about recent news, " +
      "blog posts, kernel lists, or any feed the user has subscribed to in feeds.txt. " +
      "Returns matching entries with title, link, date, source feed, and a content snippet.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language query describing what you want from the RSS archive." },
        days: { type: "number", description: "Optional: restrict to entries newer than N days. Omit to search everything in cache." },
      },
      required: ["query"],
    },
    async run({ query, days }) {
      const s = loadSettings();
      const results = await retrieve(query, s);
      const cutoff = days ? Date.now() - days * 86400 * 1000 : 0;
      const filtered = results.filter((r) => r.pub_date >= cutoff);
      if (!filtered.length) return { count: 0, results: [], note: "No matches in RSS cache. Try refreshing feeds first." };
      return {
        count: filtered.length,
        retentionDays: s.retentionDays,
        results: filtered.map((r) => ({
          title: r.title,
          link: r.link,
          author: r.author,
          date: r.pub_date_iso,
          feed: r.feed_url,
          snippet: r.text.slice(0, 600),
        })),
      };
    },
  },
  {
    name: "refresh_rss_feeds",
    description: "Force-refresh all RSS feeds listed in feeds.txt, index new items, and apply the retention policy.",
    parameters: { type: "object", properties: {} },
    async run() {
      const s = loadSettings();
      const feeds = loadFeeds(s);
      const res = await refreshFeeds(s, feeds);
      const ret = runRetention(s.retentionDays);
      return { feeds: feeds.length, ...res, retention: ret };
    },
  },
  {
    name: "list_rss_feeds",
    description: "List the RSS/Atom feeds currently configured in feeds.txt and cache stats.",
    parameters: { type: "object", properties: {} },
    async run() {
      const s = loadSettings();
      const feeds = loadFeeds(s);
      const db = getDb();
      const stats = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM entries) AS entries,
          (SELECT COUNT(*) FROM chunks)   AS chunks,
          (SELECT MIN(cached_at) FROM entries) AS oldest,
          (SELECT MAX(cached_at) FROM entries) AS newest
      `).get();
      return {
        feeds,
        retentionDays: s.retentionDays,
        embeddingModel: s.embeddingModel,
        stats: {
          entries: stats.entries,
          chunks: stats.chunks,
          oldest: stats.oldest ? new Date(stats.oldest).toISOString() : null,
          newest: stats.newest ? new Date(stats.newest).toISOString() : null,
        },
      };
    },
  },
];