import { tool } from "@lmstudio/sdk";
import { z } from "zod";
import { getDb } from "../lib/db.js";
import { runRetention } from "../lib/retention.js";
import { refreshFeeds, retrieve } from "../lib/retriever.js";
import { loadSettings, loadFeeds } from "../lib/config.js";

export async function toolsProvider(_ctl: any) {
  return [
    tool({
      name: "search_rss_cache",
      description: "Semantic search over the local RSS RAG cache.",
      parameters: {
        query: z.string(),
        days: z.number().optional()
      },
      implementation: async ({ query, days }: { query: string; days?: number }) => {
        const s = loadSettings();
        const results = await retrieve(query, s);
        const cutoff = days ? Date.now() - days * 86400 * 1000 : 0;
        const filtered = results.filter((r: any) => r.pub_date >= cutoff);
        
        if (!filtered.length) return { count: 0, results: [], note: "No matches." };
        
        return {
          count: filtered.length,
          results: filtered.map((r: any) => ({
            title: r.title,
            link: r.link,
            date: r.pub_date_iso,
            snippet: r.text.slice(0, 600),
          })),
        };
      }
    }),
        tool({
      name: "refresh_rss_feeds",
      description: "Force-refresh all RSS feeds listed in feeds.txt.",
      parameters: {},
      implementation: async () => {
        const s = loadSettings();
        const feeds = loadFeeds(s);
        const res = await refreshFeeds(s, feeds);
        const ret = runRetention(s.retentionDays);
        return { 
          feeds: feeds.length, 
          added: res.added, 
          failedCount: res.failed,
          failedFeeds: res.failedFeeds, 
          retention: ret 
        };
      }
    }),
    tool({
      name: "list_rss_feeds",
      description: "List the RSS/Atom feeds currently configured.",
      parameters: {},
      implementation: async () => {
        const s = loadSettings();
        const feeds = loadFeeds(s);
        const db = getDb();
        const stats = db.prepare(`SELECT (SELECT COUNT(*) FROM entries) as entries, (SELECT COUNT(*) FROM chunks) as chunks`).get() as any;
        return { feeds, entries: stats.entries, chunks: stats.chunks };
      }
    }), // <-- THIS WAS MISSING!
    tool({
      name: "get_recent_cache_articles",
      description: "Get the most recent articles added to the cache. Use this to see what news is available or to summarize recent events without guessing search keywords.",
      parameters: {
        limit: z.number().optional()
      },
      implementation: async ({ limit }: { limit?: number }) => {
        const db = getDb();
        const lim = limit || 20;
        const articles = db.prepare(`SELECT title, link, pub_date, feed_url FROM entries ORDER BY pub_date DESC LIMIT ?`).all(lim);
        return { 
          count: articles.length, 
          articles: articles.map((a: any) => ({ 
            title: a.title, 
            link: a.link, 
            date: new Date(a.pub_date).toISOString(), 
            feed: a.feed_url 
          })) 
        };
      }
    })
	  ]; // <--- ADD THIS
}     // <--- AND THIS