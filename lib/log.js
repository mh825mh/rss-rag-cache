// Tiny leveled logger. Level is controlled by RSS_RAG_LOG_LEVEL
// (debug | info | warn | error | silent); defaults to "info".
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function threshold() {
  const lvl = String(process.env.RSS_RAG_LOG_LEVEL || "info").toLowerCase();
  return LEVELS[lvl] ?? LEVELS.info;
}

function emit(level, scope, args) {
  if ((LEVELS[level] ?? LEVELS.info) < threshold()) return;
  const prefix = `[rss-rag${scope ? ":" + scope : ""}]`;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(prefix, ...args);
}

export function createLogger(scope) {
  return {
    debug: (...a) => emit("debug", scope, a),
    info: (...a) => emit("info", scope, a),
    warn: (...a) => emit("warn", scope, a),
    error: (...a) => emit("error", scope, a),
  };
}

export const log = createLogger();
