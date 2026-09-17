// Suppress Node.js experimental warnings before anything else loads
if (typeof process !== 'undefined' && process.removeAllListeners) {
  process.removeAllListeners('warning');
}

import { PluginContext } from "@lmstudio/sdk";
import { configSchematics } from "./config";
import { toolsProvider } from "./toolsProvider";
import { loadSettings, loadFeeds } from "../lib/config.js";
import { getDb, setMeta } from "../lib/db.js";
import { runRetention, getLastRefresh } from "../lib/retention.js";
import { refreshFeeds } from "../lib/retriever.js";
import { listModels } from "../lib/embedder.js";

export async function main(context: PluginContext): Promise<void> {
  // Register UI settings and tools
  context.withConfigSchematics(configSchematics);
  context.withToolsProvider(toolsProvider);

  // Initialize DB
  getDb();

  // Non-fatal: warn if the configured embedding model isn't loaded in the server
  async function checkModel() {
    try {
      const s = loadSettings();
      const models = await listModels(s.lmStudioBaseUrl);
      if (models.length && !models.some((m) => String(m).includes(String(s.embeddingModel).split(/[/:]/).pop()))) {
        console.warn(`[rss-rag] Embedding model "${s.embeddingModel}" not detected in LM Studio server (got: ${models.slice(0, 5).join(", ") || "none"}). Search will fall back to keywords until it is loaded.`);
      }
    } catch (e) {
      console.warn("[rss-rag] Could not check embedding model:", (e as Error).message);
    }
  }

  // Auto-refresh timer
  async function maybeAutoRefresh() {
    const s = loadSettings();
    const last = getLastRefresh();
    const due = Date.now() - last > s.refreshIntervalHours * 3600 * 1000;
    if (due) {
      try {
        const feeds = loadFeeds(s);
        const res = await refreshFeeds(s, feeds);
        const ret = runRetention(s.retentionDays, s.retentionBasis || "publish_date");
        setMeta("last_refresh", JSON.stringify({
          timestamp: Date.now(),
          added: res.added,
          totalTimeSeconds: res.totalTimeSeconds,
          failedFeeds: res.failedFeeds,
          retention: ret,
        }));
        console.log("[rss-rag] auto-refresh complete:", res);
      } catch (e) {
        console.error("[rss-rag] auto-refresh error:", (e as Error).message);
      }
    }
  }

  checkModel();
  const s0 = loadSettings();
  if (s0.refreshOnStartup !== false && s0.refreshOnStartup !== "false") {
    maybeAutoRefresh();
  } else {
    console.log("[rss-rag] Startup refresh disabled by settings.");
  }
  setInterval(maybeAutoRefresh, 3600000);
}