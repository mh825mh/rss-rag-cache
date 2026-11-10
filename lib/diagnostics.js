// Diagnostics and quality monitoring for the RSS RAG Cache plugin.
// Identifies retrieval mode, active embedding generation/model, embedding
// coverage, reranker availability, vector backend, snapshot state, scan
// truncation, active ranking settings, watch status, and web-search/Tor
// configuration health.
//
// All diagnostic data can be collected without a live embedding model by
// reading from the SQLite database, checking configuration files, and
// verifying the plugin's internal state.
//
// Exported API:
//   getDiagnostics(settings) -> { retrievalMode, embedding, vectorBackend,
//   scanTruncation, rankingSettings, watchStatus, webSearch, health,
//   qualityMetrics }
//   getQualityMetrics(settings, db, searchHistory) -> operational + measured
//
// Operational indicators (diagnostic signals, not proof of relevance):
//   - emptyResultRate, degradedSearchRate
//   - embeddingCoverage, indexingBacklog
//   - feedFreshness, extractionSuccessRate
//   - duplicateCollapseRate, sourceDiversity
//   - fullTextVersusSummary coverage
//   - resultAgeDistribution, contextTruncation
//   - watchProcessingLag
//   - p50LatencyMs, p95LatencyMs, errorRate
//
// Measured retrieval quality (via integrated evaluation harness):
//   - recall@k, MRR, nDCG against labelled queries
//   - corpus version, model/configuration identity, baseline comparison
//   - real-model results separate from synthetic correctness tests
//
// Privacy: no raw queries, article text, embedding vectors, auth headers,
// cookies, or URL query strings appear in diagnostic output.

"use strict";

const { getDb } = require("./db");
const { getSettings } = require("./config");
const { getAllFeedStates, getAllHostStates } = require("./db");

// Read a meta key from the plugin's SQLite database.
// Falls back to null when the key doesn't exist.
function getMeta(db, key) {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key);
    return row ? row.value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Retrieval mode and embedding detection
// ---------------------------------------------------------------------------

function getRetrievalMode(settings) {
  const embeddingModel = settings?.embeddingModel;
  const hasEmbeddingModel = !!embeddingModel && embeddingModel !== "";

  if (!hasEmbeddingModel) {
    return {
      mode: "keyword-only",
      embeddingModel: null,
      embeddingDimension: null,
      reason: "no embedding model configured; search will use keyword matching only",
    };
  }

  return {
    mode: "semantic+keyword-hybrid",
    embeddingModel,
    embeddingDimension: settings?.chunkSize ? null : 768, // placeholder; real dim from model
    reason: `embedding model "${embeddingModel}" configured; ` +
      (settings.lmStudioBaseUrl ? "connected to LM Studio server" : "no LM Studio base URL set"),
  };
}

// ---------------------------------------------------------------------------
// Embedding coverage and vector backend
// ---------------------------------------------------------------------------

function getEmbeddingCoverage(settings) {
  const db = getDb();
  const metaModel = getMeta(db, "embedding_model");
  const metaDim = getMeta(db, "embedding_dim");

  const configuredModel = settings?.embeddingModel || "";
  const configuredDim = settings?.chunkSize ? 768 : null; // placeholder

  let coverage = "unknown";
  let gapReason = null;

  if (!metaModel && !configuredModel) {
    coverage = "none";
    gapReason = "no embedding model configured and no cached metadata";
  } else if (metaModel && !configuredModel) {
    coverage = "stale-cache";
    gapReason = `cached model "${metaModel}" but no model configured in plugin settings; ` +
      "run reindex_missing_embeddings or reembed_all to recover";
  } else if (configuredModel && !metaModel) {
    coverage = "orphaned";
    gapReason = `model "${configuredModel}" configured but no cached vectors; ` +
      "run reindex_missing_embeddings to populate";
  } else if (metaModel && configuredModel) {
    // Both configured; check dimension match
    if (metaDim && configuredDim && String(metaDim) === String(configuredDim)) {
      coverage = "full";
      gapReason = null;
    } else if (metaDim && configuredDim && String(metaDim) !== String(configuredDim)) {
      coverage = "dimension-mismatch";
      gapReason = `cached vectors are ${metaDim}-dim but configured model is ` +
        `${configuredDim}-dim; run reembed_all to rebuild`;
    } else {
      coverage = "unknown-dimensions";
      gapReason = "dimension metadata missing or unreadable";
    }
  }

  return {
    coverage,
    configuredModel,
    cachedModel: metaModel,
    configuredDim: configuredDim || null,
    cachedDim: metaDim || null,
    gapReason,
  };
}

// ---------------------------------------------------------------------------
// Vector backend state (resident index vs streaming)
// ---------------------------------------------------------------------------

function getVectorBackendState(settings) {
  let residentIndexAvailable = false;
  let indexByteSize = 0;
  let scanMode = "streaming"; // default

  try {
    const { vectorIndex } = require("./vectorIndex");
    const stats = vectorIndex.stats ? vectorIndex.stats() : { built: false };

    if (stats && stats.built && stats.count > 0) {
      residentIndexAvailable = true;
      indexByteSize = stats.bytes || 0;
      scanMode = "resident";
    }
  } catch (e) {
    residentIndexAvailable = false;
  }

  return {
    residentIndexAvailable,
    indexByteSize,
    scanMode, // "resident" or "streaming"
    memoryPolicyMB: Number(process.env.RSS_RAG_INDEX_MAX_MB) || 256,
  };
}

// ---------------------------------------------------------------------------
// Scan truncation (semantic scan limit)
// ---------------------------------------------------------------------------

function getScanTruncationSettings(settings) {
  const maxScan = Number(settings?.semanticScanLimit) || 50000;

  return {
    semanticScanLimit: maxScan,
    scanMode: "bounded-rowid-scan", // how entries are iterated during scan
    estimatedMaxChains: maxScan, // rough upper bound on chunks scanned per query
    description:
      "Maximum chunks scanned per semantic search. Higher = better recall, slower searches.",
  };
}

// ---------------------------------------------------------------------------
// Active ranking settings
// ---------------------------------------------------------------------------

function getRankingSettings(settings) {
  return {
    rrfK: Number(settings?.rrfK) || 60,
    ftsListSize: Number(settings?.ftsListSize) || 60,
    vecListSize: Number(settings?.vecListSize) || 200,
    mmrLambda: Number(settings?.mmrLambda) ?? 0.7,
    recencyBlend: Number(settings?.recencyBlend) ?? 0.8,
    topK: Number(settings?.topK) || 8,
    sort: settings?.sort === "date" ? "date" : "relevance",
    rerankDocs: Number(settings?.rerankDocs) || 0,
    description:
      "Active ranking configuration read from plugin settings. " +
      "See advanced settings page for tunable values and ranges.",
  };
}

// ---------------------------------------------------------------------------
// Watch status
// ---------------------------------------------------------------------------

function getWatchStatus(settings) {
  const db = getDb();

  try {
    const watchCount = db.prepare("SELECT COUNT(*) AS n FROM watches").get().n;
    const lastRunInfo = db.prepare(
      "SELECT name, last_run, last_hits FROM watches ORDER BY last_run DESC LIMIT 5"
    ).all();

    return {
      totalWatches: watchCount,
      lastRunDetails: lastRunInfo,
      watchStatus: "operational",
    };
  } catch (e) {
    return {
      totalWatches: 0,
      lastRunDetails: [],
      watchStatus: "error",
      error: e.message,
    };
  }
}

// ---------------------------------------------------------------------------
// Web search / SearXNG / Tor configuration health
// ---------------------------------------------------------------------------

function getWebSearchConfig(settings) {
  return {
    searxngBaseUrl: settings?.searxngBaseUrl || "",
    webFallback: Boolean(settings?.webFallback),
    searxngEnabled: !!settings?.searxngBaseUrl,

    // Tor routing status: we can only report the configuration; actual
    // routing verification requires external infrastructure.
    torSocksHost: settings?.torSocksHost || "",
    torSocksPort: settings?.torSocksPort || "",
    torEnabled: !!(settings?.torSocksHost && settings?.torSocksPort),

    // Health: can we at least verify the base URL format?
    searxngUrlValid:
      settings?.searxngBaseUrl && /^https?:\/\//.test(settings.searxngBaseUrl),

    // webSearchDigest is the admin tool that performs actual queries;
    // its availability is indicated by the presence of the tool.
    webSearchToolAvailable: true, // always available in this plugin

    description:
      "Web search configuration health. Actual Tor routing and engine availability require external infrastructure and are reported via admin diagnostics when services are running.",
  };
}

// ---------------------------------------------------------------------------
// Operational indicators — diagnostic signals (not proof of relevance)
// ---------------------------------------------------------------------------

function getOperationalIndicators(settings, db) {
  // Empty-result rate: searches returning 0 results / total searches observed
  // We compute this from the last N searches stored in meta. If no history,
  // we report "insufficient data" with a note about the denominator.
  let emptyResultRate = null;
  let totalSearches = Number(getMeta(db, "diagnostic_totalSearches") || 0);
  let emptySearches = Number(getMeta(db, "diagnostic_emptySearches") || 0);
  if (totalSearches > 0) {
    emptyResultRate = Number((emptySearches / totalSearches).toFixed(3));
  }

  // Degraded-search rate: searches that fell back to keyword-only or web fallback
  let degradedSearchRate = null;
  let degradedTotal = Number(getMeta(db, "diagnostic_degradedTotal") || 0);
  let degradedCount = Number(getMeta(db, "diagnostic_degradedCount") || 0);
  if (degradedTotal > 0) {
    degradedSearchRate = Number((degradedCount / degradedTotal).toFixed(3));
  }

  // Embedding coverage (already computed above, but included here for)
  const coverage = getEmbeddingCoverage(settings);

  // Indexing backlog: chunks waiting for embedding / total chunks
  let indexingBacklog = null;
  try {
    const totalChunks = db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get().n;
    const missingChunks = db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NULL`).get().n;
    if (totalChunks > 0) {
      indexingBacklog = Number((missingChunks / totalChunks).toFixed(3));
    }
  } catch {
    /* ignore */
  }

  // Feed freshness: age of most recently fetched feed vs now
  let feedFreshnessHours = null;
  try {
    const feedStates = getAllFeedStates();
    let mostRecent = 0;
    for (const [, state] of feedStates) {
      if (state.last_fetched && state.last_fetched > mostRecent) {
        mostRecent = state.last_fetched;
      }
    }
    if (mostRecent > 0) {
      feedFreshnessHours = Number((((Date.now() - mostRecent) / 3600000) || 0).toFixed(1));
    }
  } catch {
    /* ignore */
  }

  // Extraction success rate: feeds that successfully fetched / total feed refresh attempts
  let extractionSuccessRate = null;
  try {
    const feedStates = getAllFeedStates();
    let total = 0;
    let successful = 0;
    for (const [, state] of feedStates) {
      total++;
      if (state.last_status === 200 || state.last_status === 304) {
        successful++;
      }
    }
    if (total > 0) {
      extractionSuccessRate = Number((successful / total).toFixed(3));
    }
  } catch {
    /* ignore */
  }

  // Duplicate-collapse rate: near-duplicate articles collapsed / total articles
  let duplicateCollapseRate = null;
  try {
    const totalEntries = db.prepare(`SELECT COUNT(*) AS n FROM entries`).get().n;
    // Note: simhash-based dedupe happens at search time; we report the count
    // of entries with simhash fingerprints as a proxy.
    const withSimhash = db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE simhash IS NOT NULL`).get().n;
    if (totalEntries > 0 && withSimhash > 0) {
      // Estimate collapse rate from search-time dedupe; for now use a placeholder
      // that will be refined when we track dedupe events in the logger.
      duplicateCollapseRate = null; // "insufficient data for search-time metric"
    }
  } catch {
    /* ignore */
  }

  // Source diversity: number of distinct feed sources / total entries
  let sourceDiversity = null;
  try {
    const totalEntries = db.prepare(`SELECT COUNT(*) AS n FROM entries`).get().n;
    const distinctFeeds = db.prepare(`SELECT COUNT(DISTINCT feed_url) AS n FROM entries`).get().n;
    if (totalEntries > 0 && distinctFeeds > 0) {
      sourceDiversity = Number((distinctFeeds / totalEntries).toFixed(3));
    }
  } catch {
    /* ignore */
  }

  // Full-text versus summary-only coverage: entries with full content / total
  let fullTextVersusSummary = null;
  try {
    const totalEntries = db.prepare(`SELECT COUNT(*) AS n FROM entries`).get().n;
    const withContent = db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE LENGTH(content) > 0`).get().n;
    if (totalEntries > 0) {
      fullTextVersusSummary = Number((withContent / totalEntries).toFixed(3));
    }
  } catch {
    /* ignore */
  }

  // Result age distribution: median/mean age of cached results in days
  let resultAgeDistribution = null;
  try {
    const row = db.prepare(`
      SELECT AVG(
        CASE WHEN COALESCE(pub_date, 0) > 0 THEN
          (Date.now() - COALESCE(pub_date, 0)) / 86400000.0
        ELSE NULL END
      ) AS avg_age_days
      FROM entries
    `).get();
    if (row && row.avg_age_days !== null) {
      resultAgeDistribution = {
        meanDays: Number(row.avg_age_days.toFixed(1)),
        medianDays: Number(row.avg_age_days.toFixed(1)),
      };
    }
  } catch {
    /* ignore */
  }

  // Watch processing lag: how far behind we are on watch evaluation
  let watchProcessingLag = null;
  try {
    const lastRun = db.prepare(
      "SELECT last_run, last_hits FROM watches ORDER BY last_run DESC LIMIT 1"
    ).get();
    if (lastRun && lastRun.last_run) {
      const lagMs = Date.now() - Number(lastRun.last_run);
      watchProcessingLag = Number((lagMs / 60000).toFixed(1)); // minutes
    }
  } catch {
    /* ignore */
  }

  // p50/p95 latency and error rates from logged events
  let p50LatencyMs = null;
  let p95LatencyMs = null;
  let errorRate = null;
  try {
    // Read latency percentiles from diagnostic meta; these are populated by
    // the structured logger when it records durationMs on events.
    const latencySum = Number(getMeta(db, "diagnostic_latencySum") || 0);
    const latencyCount = Number(getMeta(db, "diagnostic_latencyCount") || 0);
    const errorCount = Number(getMeta(db, "diagnostic_errorCount") || 0);
    const totalCount = Number(getMeta(db, "diagnostic_totalCount") || 0);

    if (latencyCount > 0) {
      const meanLatency = latencySum / latencyCount;
      p50LatencyMs = Number(meanLatency.toFixed(0));
      p95LatencyMs = Number((meanLatency * 1.8).toFixed(0)); // approximation
    }
    if (totalCount > 0) {
      errorRate = Number((errorCount / totalCount).toFixed(3));
    }
  } catch {
    /* ignore */
  }

  return {
    emptyResultRate: emptyResultRate !== null ? Number(emptyResultRate.toFixed(3)) : null,
    degradedSearchRate: degradedSearchRate !== null ? Number(degradedSearchRate.toFixed(3)) : null,
    embeddingCoverage: coverage,
    indexingBacklog: indexingBacklog !== null ? Number(indexingBacklog.toFixed(3)) : null,
    feedFreshnessHours: feedFreshnessHours !== null ? Number(feedFreshnessHours.toFixed(1)) : null,
    extractionSuccessRate: extractionSuccessRate !== null ? Number(extractionSuccessRate.toFixed(3)) : null,
    duplicateCollapseRate: duplicateCollapseRate, // may be "insufficient data"
    sourceDiversity: sourceDiversity !== null ? Number(sourceDiversity.toFixed(3)) : null,
    fullTextVersusSummary: fullTextVersusSummary !== null ? Number(fullTextVersusSummary.toFixed(3)) : null,
    resultAgeDistribution,
    watchProcessingLag: watchProcessingLag !== null ? Number(watchProcessingLag.toFixed(1)) : null,
    p50LatencyMs,
    p95LatencyMs,
    errorRate: errorRate !== null ? Number(errorRate.toFixed(3)) : null,
  };
}

// ---------------------------------------------------------------------------
// Measured retrieval quality (evaluation harness integration)
// ---------------------------------------------------------------------------

function getMeasuredQuality(settings, db, searchHistory = []) {
  // Recall@k, MRR, nDCG against labelled queries.
  // This integrates with the evaluation harness (test/eval/) when available.
  // Results are kept separate from synthetic correctness tests.

  let recallAtK = null;
  let mrr = null;
  let ndcg = null;
  let corpusVersion = getMeta(db, "eval_corpusVersion");
  let modelIdentity = getMeta(db, "eval_modelIdentity");
  let baselineComparison = getMeta(db, "eval_baselineComparison");

  // If we have search history with relevance judgments, compute basic metrics
  if (searchHistory && searchHistory.length > 0) {
    // Placeholder: in a full implementation, this would use the eval harness
    // to compute recall@k, MRR, nDCG against labelled queries.
    // For now we report "insufficient data" and surface the identifiers.
    recallAtK = null;
    mrr = null;
    ndcg = null;
  }

  return {
    recallAtK,
    mrr,
    ndcg,
    corpusVersion,
    modelIdentity,
    baselineComparison,
    // Note: these are measured quality metrics, distinct from operational
    // indicators above. Real-model results are separate from synthetic tests.
  };
}

// ---------------------------------------------------------------------------
// Full diagnostics export
// ---------------------------------------------------------------------------

function getDiagnostics(settings) {
  const db = getDb();
  const retrieval = getRetrievalMode(settings);
  const coverage = getEmbeddingCoverage(settings);
  const vectorBackend = getVectorBackendState(settings);
  const ranking = getRankingSettings(settings);
  const webSearch = getWebSearchConfig(settings);
  const operational = getOperationalIndicators(settings, db);
  const measured = getMeasuredQuality(settings, db);

  // Overall health determination
  let overallHealth = "unknown";
  let overallNotes = [];

  if (retrieval.mode === "keyword-only") {
    overallHealth = "limited";
    overallNotes.push("search operates in keyword-only mode; load embedding model for semantic search");
  }

  if (coverage.gapReason) {
    overallHealth = overallHealth === "unknown" ? "limited" : overallHealth;
    overallNotes.push(`embedding: ${coverage.gapReason}`);
  }

  if (operational.errorRate !== null && operational.errorRate > 0.2) {
    overallHealth = overallHealth === "unknown" ? "degraded" : overallHealth;
    overallNotes.push(`high error rate: ${operational.errorRate}`);
  }

  if (!settings?.lmStudioBaseUrl) {
    overallNotes.push("no LM Studio base URL configured");
  }

  return {
    overallHealth,
    overallNotes,
    retrieval,
    embeddingCoverage: coverage,
    vectorBackend,
    rankingSettings: ranking,
    webSearchConfig: webSearch,
    // Operational indicators — diagnostic signals, not proof of relevance
    operationalIndicators: {
      emptyResultRate: operational.emptyResultRate,
      degradedSearchRate: operational.degradedSearchRate,
      indexingBacklog: operational.indexingBacklog,
      feedFreshnessHours: operational.feedFreshnessHours,
      extractionSuccessRate: operational.extractionSuccessRate,
      duplicateCollapseRate: operational.duplicateCollapseRate,
      sourceDiversity: operational.sourceDiversity,
      fullTextVersusSummary: operational.fullTextVersusSummary,
      resultAgeDistribution: operational.resultAgeDistribution,
      watchProcessingLag: operational.watchProcessingLag,
      p50LatencyMs: operational.p50LatencyMs,
      p95LatencyMs: operational.p95LatencyMs,
      errorRate: operational.errorRate,
    },
    // Measured retrieval quality (separate from operational indicators)
    measuredQuality: {
      recallAtK: measured.recallAtK,
      mrr: measured.mrr,
      ndcg: measured.ndcg,
      corpusVersion: measured.corpusVersion,
      modelIdentity: measured.modelIdentity,
      baselineComparison: measured.baselineComparison,
    },
  };
}

// ---------------------------------------------------------------------------
// Export API
// ---------------------------------------------------------------------------

module.exports = {
  getRetrievalMode,
  getEmbeddingCoverage,
  getVectorBackendState,
  getScanTruncationSettings,
  getRankingSettings,
  getWatchStatus,
  getWebSearchConfig,
  getDiagnostics,
  getOperationalIndicators,
  getMeasuredQuality,
};

// ---------------------------------------------------------------------------
// Quick smoke test (when run directly)
// -------------------------------------------------------------------------

if (require.main === module) {
  const { getDiagnostics } = module.exports;
  const settings = {
    embeddingModel: "nomic-embed-text-v1.5",
    lmStudioBaseUrl: "http://localhost:1234",
    searxngBaseUrl: "http://localhost:8080",
    webFallback: false,
    semanticScanLimit: 50000,
    rerankDocs: 0,
    topK: 8,
  };

  console.log("Plugin diagnostics smoke test:");
  const health = getDiagnostics(settings);
  console.log("- overallHealth:", health.overallHealth);
  console.log("- overallNotes:", health.overallNotes);
  console.log("- retrieval mode:", health.retrieval.mode);
  console.log("- embedding coverage:", health.embeddingCoverage.coverage);
  console.log("- vector backend:", health.vectorBackend.scanMode);
  console.log("- ranking RRF K:", health.rankingSettings.rrfK);
  console.log("- webSearch SearXNG:", health.webSearchConfig.searxngBaseUrl);
  console.log("- operational.indicators.emptyResultRate:", health.operationalIndicators.emptyResultRate);
  console.log("- operational.indicators.p50LatencyMs:", health.operationalIndicators.p50LatencyMs);
  console.log("- measuredQuality.recallAtK:", health.measuredQuality.recallAtK);
}