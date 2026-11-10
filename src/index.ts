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
import { getSettings, loadEnabledFeeds, loadFeedConfig, ensureFeedsFile } from "../lib/config.js";
import { getDb, setMeta } from "../lib/db.js";
import { runRetention, getLastRefresh } from "../lib/retention.js";
import { refreshFeedsShared, isRefreshing, backfillEmbeddings } from "../lib/retriever.js";
import { listModels } from "../lib/embedder.js";
import { evaluateWatches } from "../lib/watches.js";
import { log, configId, indexId } from "../lib/log.js";

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
        log.warn("embed-model-not-detected", {
          version: "1.6.0",
          model: s.embeddingModel,
          availableModels: models.slice(0, 5).join(", ") || "none",
          lmStudioBaseUrl: s.lmStudioBaseUrl,
        });
        return false;
      }
      return models.length > 0;
    } catch (e) {
      log.warn("could-not-check-embed-model", {
        version: "1.6.0",
        error: (e as Error).message,
      });
      return false;
    }
  }

  // Heal embedding gaps left behind by an offline model, in the background.
  async function startupBackfill() {
    const s = getSettings();
    try {
      const res = await backfillEmbeddings(s, { batchSize: 500, maxBatches: 20 });
      if (res.updated > 0 || res.entriesRechunked > 0) {
        log.info("backfill-complete", {
          version: "1.6.0",
          added: res.updated,
          reChunked: res.entriesRechunked,
          configId: configId(s),
          indexId: indexId(s, getDb()),
        });
      }
    } catch (e) {
      log.warn("startup-backfill-failed", {
        version: "1.6.0",
        error: (e as Error).message,
        configId: configId(s),
      });
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
      const ret = runRetention(s.retentionDays, s.retentionBasis || "publish_date", loadFeedConfig(s), s.webSourceRetentionDays);
      let watchHits: any = [];
      try {
        watchHits = await evaluateWatches(s);
      } catch (e) {
        log.warn("Watch evaluation failed:", (e as Error).message);
      }
      if (watchHits.length) {
        log.info(`Watches: ${watchHits.map((w) => `"${w.name}" matched ${w.newCount} new`).join(", ")}`);
      }
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
        watchHits,
      }));
      log.info("auto-refresh-complete", {
    version: "1.6.0",
    operationId: /* will be set by refreshFeedsShared */ "",
    added: res.added,
    updated: res.updated ?? 0,
    notModified: res.notModified,
    failedFeeds: res.failedFeeds.length,
    configId: configId(s),
    indexId: indexId(s, getDb()),
    totalTimeSeconds: res.totalTimeSeconds,
  });
      const blocked = (res as any).blockedHosts ?? [];
      if (blocked.length) {
        log.warn(
          `⚠️ Anti-ban: ${blocked.length} host(s) are blocking this crawler and have been paused — ` +
          blocked.map((h: any) => `${h.host} (~${h.retryInMinutes}m)`).join(", "),
        );
      }
    } catch (e) {
      log.error("auto-refresh error:", (e as Error).message);
    }
  }

  checkModel().then((ok) => {
    if (ok) {
      // fire-and-forget: backfill may fail if model is offline; plugin stays
      // available in keyword-only mode. Rejections are logged inside startupBackfill.
      startupBackfill().catch((e) => {
        log.error("startup-backfill-uncaught-error:", e.message);
      });
    }
  });

  const s0 = getSettings();
  if (s0.refreshOnStartup) {
    maybeAutoRefresh();
  } else {
    log.info("Startup refresh disabled by settings.");
  }
  setInterval(maybeAutoRefresh, 3600000);
}
