// Suppress only Node's ExperimentalWarning (node:sqlite) instead of removing
// *all* warning listeners, which also hid real plugin warnings.
const originalEmitWarning = process.emitWarning.bind(process);
(process as any).emitWarning = (warning: any, ...args: any[]) => {
  const type = typeof args[0] === "string" ? args[0] : args[0]?.type;
  const name = type || warning?.name;
  if (name === "ExperimentalWarning") return;
  return (originalEmitWarning as any)(warning, ...args);
};

import { PluginContext } from "@lmstudio/sdk";
import { configSchematics, globalConfigSchematics } from "./config";
import { toolsProvider } from "./toolsProvider";
import { getSettings, loadFeeds, ensureFeedsFile } from "../lib/config.js";
import { getDb, setMeta } from "../lib/db.js";
import { runRetention, getLastRefresh } from "../lib/retention.js";
import { refreshFeedsShared, isRefreshing } from "../lib/retriever.js";
import { listModels } from "../lib/embedder.js";

export async function main(context: PluginContext): Promise<void> {
  // Register UI settings and tools
  context.withConfigSchematics(configSchematics);
  context.withGlobalConfigSchematics(globalConfigSchematics);
  context.withToolsProvider(toolsProvider);

  // Initialize DB
  getDb();

  // Create feeds.txt with a helpful header on first run (as documented).
  ensureFeedsFile();

  // Non-fatal: warn if the configured embedding model isn't loaded in the server
  async function checkModel() {
    try {
      const s = getSettings();
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
    const s = getSettings();
    const last = getLastRefresh();
    const due = Date.now() - last > s.refreshIntervalHours * 3600 * 1000;
    if (!due) return;
    if (isRefreshing()) return; // a manual refresh is already running
    try {
      const feeds = loadFeeds(s);
      const res = await refreshFeedsShared(s, feeds);
      const ret = runRetention(s.retentionDays, s.retentionBasis || "publish_date");
      setMeta("last_refresh", JSON.stringify({
        timestamp: Date.now(),
        added: res.added,
        notModified: res.notModified,
        totalTimeSeconds: res.totalTimeSeconds,
        failedFeeds: res.failedFeeds,
        retention: ret,
      }));
      console.log("[rss-rag] auto-refresh complete:", res);
    } catch (e) {
      console.error("[rss-rag] auto-refresh error:", (e as Error).message);
    }
  }

  checkModel();
  const s0 = getSettings();
  if (s0.refreshOnStartup) {
    maybeAutoRefresh();
  } else {
    console.log("[rss-rag] Startup refresh disabled by settings.");
  }
  setInterval(maybeAutoRefresh, 3600000);
}
