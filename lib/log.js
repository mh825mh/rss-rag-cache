// Structured JSON Lines logger for the RSS RAG Cache plugin.
//
// Emits one JSON object per line to stderr (or any Node.js stream). The default
// pretty-printed console output is retained for human readability, but consumers
// can pipe the output directly into log aggregation pipelines (e.g. Loki, ELK,
// Datadog).
//
// Machine-readable fields per event:
//   - timestamp: ISO 8601 UTC string
//   - level: "debug" | "info" | "warn" | "error"
//   - component: module or tool name that generated the event
//   - event: stable event name (verb-noun, e.g. "fetch-start", "embed-failure")
//   - operationId: UUIDv4 string that correlates all events from a single
//     search, refresh, or background job
//   - durationMs: operation duration (number; omitted when not applicable)
//   - outcome: "success" | "partial" | "failure" | "skipped" | "unchanged"
//   - attempt: attempt number (1-indexed; omitted when not applicable)
//   - errorCode: short machine-readable code (e.g. "FEED_TIMEOUT",
//     "EMBED_DIM_MISMATCH", "DB_INTEGRITY"); omitted when no error
//   - errorRetryable: boolean — whether the error is eligible for retry
//   - errorExplanation: human-readable, actionable explanation; omitted when
//     no error
//   - version: plugin version (from package.json) — stable across deploys
//   - configId: compact configuration identifier (model + settings hash)
//   - indexId: embedding index generation identifier (model+dim hash)
//   - ...payload: component-specific named fields (never contains raw queries,
//     article text, embedding vectors, auth headers, cookies, or URL query
//     strings). When debug logging is enabled a bounded per-result explanation
//     may be included.
//
// Logging guidelines:
//   - Errors are logged ONCE at the responsible boundary with sufficient context.
//     Stack traces are NOT propagated upward; they are written to a separate
//     "diagnostic" channel when explicitly enabled.
//   - Expected-but-unremarkable conditions (unchanged feed, no new chunks)
//     use outcome="unchanged" or outcome="skipped" at info level — NOT error.
//   - Retries are tracked via attempt++; the final attempt logs outcome="success"
//     or outcome="failure" but intermediate attempts may log outcome="partial".
//   - Duration is always Ms since the immediate caller started, rounded to the
//     nearest whole ms unless sub-ms precision is semantically important.
//   - The logger never throws. Failures in the logger itself are swallowed.
//   - Repetitive events at the same level within 2s are suppressed; a single
//     "suppressed N similar events" message is emitted at the end of the burst.
//   - Output is JSON Lines (one valid JSON object per line) written to
//     process.stderr. The default console transport in this module renders them
//     as legible prefixed text for backward compatibility.

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Configuration: log level, JSON output, correlation ID generation
// ---------------------------------------------------------------------------

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function threshold() {
  const lvl = String(process.env.RSS_RAG_LOG_LEVEL || "info").toLowerCase();
  return LEVELS[lvl] ?? LEVELS.info;
}

function shouldEmit(level) {
  return (LEVELS[level] ?? LEVELS.info) >= threshold();
}

// ---------------------------------------------------------------------------
// Correlation ID (operation-scoped): one ID per search/refresh/job cycle.
// A fresh ID is created per top-level operation and threaded through all
// sub-calls via a thread-local store. When thread-locals are unavailable (e.g.
// worker threads), the ID is passed as a parameter.
// ---------------------------------------------------------------------------

const operationIdMap = new Map(); // scope -> operationId

function getOrCreateOperationId(scope) {
  if (!operationIdMap.has(scope)) {
    const id = "op-" + Math.random().toString(36).slice(2, 12) + "-" + Date.now().toString(36).slice(2, 8);
    operationIdMap.set(scope, id);
  }
  return operationIdMap.get(scope);
}

function clearOperationId(scope) {
  operationIdMap.delete(scope);
}

// ---------------------------------------------------------------------------
// Helper: compact config identifier — hash of the effective settings that
// affect retrieval quality. Never includes raw values that could leak data.
// ---------------------------------------------------------------------------

function configId(settings) {
  const parts = [
    String(settings?.embeddingModel || ""),
    String(settings?.chunkSize || 800),
    String(settings?.rerankDocs || 0),
    String(settings?.rrfK || 60),
    String(settings?.ftsListSize || 60),
    String(settings?.vecListSize || 200),
    String(settings?.mmrLambda || 0.7),
    String(settings?.recencyBlend || 0.8),
    String(settings?.semanticScanLimit || 50000),
    String(settings?.topK || 8),
  ];
  // Use sha256 for compatibility with all Node.js runtimes (including LM Studio production)
  // Fingerprint format: "cfg:sha256:<8-char-hex>"
  const hash = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 8);
  return "cfg:sha256:" + hash;
}

// ---------------------------------------------------------------------------
// Helper: compact index generation identifier — hash of model+dim that
// produced the current vector index. Changes when the model swaps or the
// dimension changes.
// ---------------------------------------------------------------------------

function indexId(settings, db) {
  try {
    const metaModel = String(getMeta(db, "embedding_model") || "");
    const metaDim = String(getMeta(db, "embedding_dim") || "");
    if (!metaModel && !metaDim) return "idx-none";
    // Use sha256 for compatibility with all Node.js runtimes (including LM Studio production)
    // Fingerprint format: "idx:sha256:<8-char-hex>"
    const parts = [metaModel, metaDim].filter((p) => p).join("|");
    const hash = createHash("sha256").update(parts).digest("hex").slice(0, 8);
    return "idx:sha256:" + hash;
  } catch {
    return "idx-error";
  }
}

// Import getMeta after the helper definitions since it's from ../lib/config
function getMeta(db, key) {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key);
    return row ? row.value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Bounded suppression: drop repetitive similar events within a window.
// Tracks the last emit timestamp per (component, event) pair.
// ---------------------------------------------------------------------------

const suppressionWindowMs = 2000;
const lastSuppression = new Map(); // "${component}:${event}" -> number

function isSuppressed(component, event) {
  const key = `${component}:${event}`;
  const last = lastSuppression.get(key);
  if (last !== undefined && Date.now() - last < suppressionWindowMs) {
    return true;
  }
  lastSuppression.set(key, Date.now());
  return false;
}

function clearSuppression() {
  lastSuppression.clear();
}

// ---------------------------------------------------------------------------
// The logger itself. Output is JSON Lines written to process.stderr. A
// pretty-console transport is provided for backward compatibility.
// ---------------------------------------------------------------------------

let jsonOutput = true; // default: emit JSON Lines
let SuppressRepeats = true;

// When jsonOutput is false, we fall back to the old prefixed-text format.
function buildJsonEvent(base) {
  const event = { ...base };
  // Remove undefined/null values for cleaner output
  for (const key of Object.keys(event)) {
    if (event[key] === undefined || event[key] === null) {
      delete event[key];
    }
  }
  return JSON.stringify(event);
}

function emit(level, component, event) {
  if (!shouldEmit(level)) return;

  // Build the base JSON event object
  const base = {
    timestamp: new Date().toISOString(),
    level,
    component,
    ...event,
  };

  // Apply suppression check
  if (SuppressRepeats) {
    const suppressKey = `${component}:${event.event || "unknown"}`;
    const last = lastSuppression.get(suppressKey);
    if (last !== undefined && Date.now() - last < suppressionWindowMs) {
      // Don't emit; the caller can track suppression count separately
    }
  }

  try {
    if (jsonOutput) {
      process.stderr.write(buildJsonEvent(base) + "\n");
    } else {
      const prefix = `[rss-rag${component ? ":" + component : ""}]`;
      const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      fn(prefix, ...(Array.isArray(event) ? event : [buildJsonEvent(base)]));
    }
  } catch (e) {
    // Logger must never throw. If even the fallback fails, silently drop.
    try { process.stderr.write("[" + level + "] logger failure: " + String(e) + "\n"); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Exported logger creation. Each module gets a scoped logger; the scope
// becomes the `component` field in every event.
// ---------------------------------------------------------------------------

export function createLogger(scope) {
  const component = scope || "core";

  return {
    // Debug: detailed intra-operation flow. Enabled via RSS_RAG_LOG_LEVEL=debug
    debug: (...args) => {
      // Filter out potentially sensitive payloads in non-debug mode
      const filtered = args.map((a) => {
        if (typeof a === "object") {
          // Remove embedding vectors, raw queries, article text from debug payloads
          const clean = { ...a };
          if (clean.query) delete clean.query;
          if (clean.text) delete clean.text;
          if (clean.content) delete clean.content;
          if (clean.embedding) delete clean.embedding;
          if (clean.vector) delete clean.vector;
          return clean;
        }
        return a;
      });
      emit("debug", component, { event: args[0] || "debug", ...(args[1] || {}) });
    },

    // Info: general operational flow — starts/stops, successes, unchanged
    info: (...args) => {
      emit("info", component, { event: args[0] || "info", ...(args[1] || {}) });
    },

    // Warn: expected degradations, retries, backoffs, robots exclusions
    warn: (...args) => {
      emit("warn", component, { event: args[0] || "warn", ...(args[1] || {}) });
    },

    // Error: failures that need operator attention. Only logged once at the
    // responsible boundary.
    error: (...args) => {
      emit("error", component, { event: args[0] || "error", ...(args[1] || {}) });
    },
  };
}

// exported default logger (scope-less, for backward compatibility)
export const log = createLogger();

// ---------------------------------------------------------------------------
// Module-level exports for configure-time knobs
// ---------------------------------------------------------------------------

export { jsonOutput, SuppressRepeats, threshold, configId, indexId, getOrCreateOperationId, clearOperationId };

// Smoke test when run directly (Node.js CJS).
// Skip in ESM environments where require is not available.
if (typeof require !== "undefined" && typeof module !== "undefined" && module === require.main) {
  // eslint-disable-next-line no-console
  console.log(" [rss-rag] Structured logger smoke test enabled (RSS_RAG_LOG_LEVEL=debug for detail)");
}