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
import { getSettings, loadEnabledFeeds, ensureFeedsFile } from "../lib/config.js";
import { getDb, setMeta } from "../lib/db.js";
import { runRetention, getLastRefresh } from "../lib/retention.js";
import { refreshFeedsShared, isRefreshing, backfillEmbeddings } from "../lib/retriever.js";
import { listModels } from "../lib/embedder.js";
import { log } from "../lib/log.js";

export async function main(context: PluginContext): Promise<void> {
  // Register UI settings and tools
  context.withConfigSchematics(configSchematics);
  context.withGlobalConfigSchematics(globalConfigSchematics);
  context.withToolsProvider(toolsProvider);

  // Initialize DB (runs migrations)
  getDb();

  // Create feeds.txt with a helpful header on first run (as documented).
  ensureFeedsFile();

  // Non-fatal: warn if the configured embedding model isn't loaded in the server.
  async function checkModel(): Promise<boolean> {
    try {
      const s = getSettings();
      const models = await listModels(s.lmStudioBaseUrl);
      const short = String(s.embeddingModel).split(/[/:]/).pop();
      if (models.length && !models.some((m) => String(m).includes(String(short)))) {
        log.warn(`Embedding model "${s.embeddingModel}" not detected in LM Studio server (got: ${models.slice(0, 5).join(", ") || "none"}). Search will fall back to keywords until it is loaded.`);
        return false;
      }
      return models.length > 0;
    } catch (e) {
      log.warn("Could not check embedding model:", (e as Error).message);
      return false;
    }
  }

  // Heal embedding gaps left behind by an offline model, in the background.
  async function startupBackfill() {
    const s = getSettings();
    try {
      const res = await backfillEmbeddings(s, { batchSize: 500, maxBatches: 20 });
      if (res.updated > 0 || res.entriesRechunked > 0) {
        log.info(`Backfill: embedded ${res.updated} chunk(s), re-chunked ${res.entriesRechunked} entry(ies).`);
      }
    } catch (e) {
      log.warn("Startup backfill failed:", (e as Error).message);
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
      const feeds = loadEnabledFeeds(s);
      const res = await refreshFeedsShared(s, feeds);
      const ret = runRetention(s.retentionDays, s.retentionBasis || "publish_date");
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
        notModified: res.notModified,
        totalTimeSeconds: res.totalTimeSeconds,
        failedFeeds: res.failedFeeds,
        retention: ret,
        backfill,
      }));
      log.info("auto-refresh complete:", { added: res.added, updated: res.updated ?? 0, notModified: res.notModified, failed: res.failedFeeds.length });
    } catch (e) {
      log.error("auto-refresh error:", (e as Error).message);
    }
  }

  checkModel().then((ok) => {
    if (ok) startupBackfill();
  });

  const s0 = getSettings();
  if (s0.refreshOnStartup) {
    maybeAutoRefresh();
  } else {
    log.info("Startup refresh disabled by settings.");
  }
  setInterval(maybeAutoRefresh, 3600000);
}
