// Suppress Node.js experimental warnings before anything else loads
if (typeof process !== 'undefined' && process.removeAllListeners) {
  process.removeAllListeners('warning');
}

import { PluginContext } from "@lmstudio/sdk";
import { configSchematics } from "./config";
import { toolsProvider } from "./toolsProvider";
import { loadSettings, loadFeeds } from "../lib/config.js";
import { getDb } from "../lib/db.js";
import { runRetention, getLastRefresh } from "../lib/retention.js";
import { refreshFeeds } from "../lib/retriever.js";

export async function main(context: PluginContext): Promise<void> {
  // Register UI settings and tools
  context.withConfigSchematics(configSchematics);
  context.withToolsProvider(toolsProvider);

  // Initialize DB
  getDb();

  // Auto-refresh timer
  async function maybeAutoRefresh() {
    const s = loadSettings();
    const last = getLastRefresh();
    const due = Date.now() - last > s.refreshIntervalHours * 3600 * 1000;
    if (due) {
      try {
        const feeds = loadFeeds(s);
        const res = await refreshFeeds(s, feeds);
        runRetention(s.retentionDays);
        console.log("[rss-rag] auto-refresh complete:", res);
      } catch (e) {
        console.error("[rss-rag] auto-refresh error:", (e as Error).message);
      }
    }
  }

  // Run once on startup, then check every hour
  maybeAutoRefresh();
  setInterval(maybeAutoRefresh, 3600000); 
}