import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Data directory is overridable (useful for tests and for relocating the cache).
const pluginDataDir =
  process.env.RSS_RAG_DATA_DIR || join(homedir(), ".lmstudio", "plugin-data", "rss-rag-cache");
mkdirSync(pluginDataDir, { recursive: true });

export const DEFAULT_SETTINGS = {
  retentionDays: 90,
  refreshIntervalHours: 6,
  embeddingModel: "nomic-embed-text-v1.5",
  topK: 8,
  chunkSize: 800,
  embedBatchSize: 16,
  scrapeFullText: false,
  semanticScanLimit: 50000,
  refreshOnStartup: true,
  maxConcurrentFeeds: 8,
  htmlLinkPatterns: "news,article,post,blog,stories,press",
  retentionBasis: "publish_date",
  feedsFile: "feeds.txt",
  lmStudioBaseUrl: "http://localhost:1234",
};

const toBool = (v) => v === true || v === "true" || v === 1 || v === "1";
const toInt = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
};
const clampInt = (v, min, max, def) => Math.min(max, Math.max(min, toInt(v, def)));

// Coerce raw settings (which may arrive as strings from the LM Studio UI, e.g.
// the "retentionDays" select yields "90") into a consistent, bounded shape.
export function normalizeSettings(raw = {}) {
  const s = { ...DEFAULT_SETTINGS, ...raw };
  return {
    ...s,
    retentionDays: clampInt(s.retentionDays, 1, 3650, DEFAULT_SETTINGS.retentionDays),
    refreshIntervalHours: clampInt(s.refreshIntervalHours, 1, 168, DEFAULT_SETTINGS.refreshIntervalHours),
    topK: clampInt(s.topK, 1, 50, DEFAULT_SETTINGS.topK),
    chunkSize: clampInt(s.chunkSize, 200, 3000, DEFAULT_SETTINGS.chunkSize),
    embedBatchSize: clampInt(s.embedBatchSize, 1, 128, DEFAULT_SETTINGS.embedBatchSize),
    maxConcurrentFeeds: clampInt(s.maxConcurrentFeeds, 1, 32, DEFAULT_SETTINGS.maxConcurrentFeeds),
    semanticScanLimit: clampInt(s.semanticScanLimit, 1000, 5000000, DEFAULT_SETTINGS.semanticScanLimit),
    scrapeFullText: toBool(s.scrapeFullText),
    refreshOnStartup: toBool(s.refreshOnStartup),
    retentionBasis: s.retentionBasis === "cached_at" ? "cached_at" : "publish_date",
    feedsFile: String(s.feedsFile || DEFAULT_SETTINGS.feedsFile),
    embeddingModel: String(s.embeddingModel || DEFAULT_SETTINGS.embeddingModel),
    htmlLinkPatterns: String(s.htmlLinkPatterns || DEFAULT_SETTINGS.htmlLinkPatterns),
    lmStudioBaseUrl: String(s.lmStudioBaseUrl || DEFAULT_SETTINGS.lmStudioBaseUrl).replace(/\/+$/, ""),
  };
}

// File-based loader: used as the fallback before a chat controller is available
// (background auto-refresh) and as an optional power-user override layer.
export function loadSettings() {
  const file = join(pluginDataDir, "settings.json");
  if (!existsSync(file)) return normalizeSettings(DEFAULT_SETTINGS);
  try {
    return normalizeSettings(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS);
  }
}

// Cached, controller-resolved settings (written by the tools provider) so that
// background tasks see the same values the UI is showing.
let cachedSettings = null;
export function setSettings(settings) {
  cachedSettings = normalizeSettings(settings);
  return cachedSettings;
}
export function getSettings() {
  return cachedSettings || loadSettings();
}

export function loadFeeds(settings = getSettings()) {
  const file = join(pluginDataDir, settings.feedsFile);
  const path = existsSync(file) ? file : join(process.cwd(), settings.feedsFile);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

// Creates feeds.txt with a helpful header on first run (docs promise this).
export function ensureFeedsFile(settings = getSettings()) {
  const path = join(pluginDataDir, settings.feedsFile);
  if (existsSync(path)) return path;
  try {
    writeFileSync(
      path,
      "# Add one RSS/Atom URL per line.\n" +
        "# Lines starting with # are ignored. Blank lines are ignored.\n",
    );
  } catch {
    /* ignore */
  }
  return path;
}

function feedsFilePath(settings) {
  return join(pluginDataDir, settings.feedsFile);
}

const normalizeUrlKey = (s) => String(s).trim().replace(/\/+$/, "");

export function appendFeed(url, settings = getSettings()) {
  const path = feedsFilePath(settings);
  const normalized = String(url).trim();
  if (!normalized) return { ok: false, reason: "Empty URL" };
  let parsed;
  try {
    parsed = new URL(normalized); // validate
  } catch {
    return { ok: false, reason: "Invalid URL" };
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return { ok: false, reason: "Only http(s) URLs are supported" };
  }
  const existing = existsSync(path)
    ? readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    : [];
  if (existing.some((l) => !l.startsWith("#") && normalizeUrlKey(l) === normalizeUrlKey(normalized))) {
    return { ok: false, reason: "Feed already in list" };
  }
  appendFileSync(path, normalized + "\n");
  return { ok: true, feeds: loadFeeds(settings).length };
}

export function removeFeed(url, settings = getSettings()) {
  const path = feedsFilePath(settings);
  if (!existsSync(path)) return { ok: false, reason: "No feeds file" };
  const target = normalizeUrlKey(url);
  const lines = readFileSync(path, "utf8").split(/\r?\n/);

  // Exact (trailing-slash-tolerant) match only. A substring match would let
  // removing "example.com" also delete "example.com/feed".
  const isMatch = (line) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return false;
    return normalizeUrlKey(t) === target;
  };
  if (!target || !lines.some(isMatch)) return { ok: false, reason: "Feed not found in list" };

  const kept = lines.filter((l) => !isMatch(l));
  writeFileSync(path, kept.join("\n") + (kept.length ? "\n" : ""));
  return { ok: true, feeds: loadFeeds(settings).length };
}

export function getDbPath() {
  return join(pluginDataDir, "cache.db");
}
