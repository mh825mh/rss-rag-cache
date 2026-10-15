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
  embedConcurrency: 3,
  contextualChunks: true,
  contextChunks: 1,
  htmlLinkPatterns: "news,article,post,blog,stories,press",
  retentionBasis: "publish_date",
  feedsFile: "feeds.txt",
  feedsConfigFile: "feeds.json",
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
    embedConcurrency: clampInt(s.embedConcurrency, 1, 16, DEFAULT_SETTINGS.embedConcurrency),
    contextChunks: clampInt(s.contextChunks, 0, 2, DEFAULT_SETTINGS.contextChunks),
    semanticScanLimit: clampInt(s.semanticScanLimit, 1000, 5000000, DEFAULT_SETTINGS.semanticScanLimit),
    scrapeFullText: toBool(s.scrapeFullText),
    refreshOnStartup: toBool(s.refreshOnStartup),
    contextualChunks: s.contextualChunks === undefined ? true : toBool(s.contextualChunks),
    retentionBasis: s.retentionBasis === "cached_at" ? "cached_at" : "publish_date",
    feedsFile: String(s.feedsFile || DEFAULT_SETTINGS.feedsFile),
    feedsConfigFile: String(s.feedsConfigFile || DEFAULT_SETTINGS.feedsConfigFile),
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

function readFeedsTxt(settings) {
  const file = join(pluginDataDir, settings.feedsFile);
  const path = existsSync(file) ? file : join(process.cwd(), settings.feedsFile);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function feedsJsonPath(settings) {
  return join(pluginDataDir, settings.feedsConfigFile || "feeds.json");
}

function readFeedsJson(settings) {
  const path = feedsJsonPath(settings);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const list = Array.isArray(raw) ? raw : raw?.feeds;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// Merges feeds.txt (simple list) with the optional feeds.json override layer
// into full per-feed config objects: { url, enabled, tags, collection,
// retentionDays, scrapeFullText, linkPatterns, maxItems, headers }. feeds.txt
// entries default to enabled.
export function loadFeedConfig(settings = getSettings()) {
  const map = new Map();
  for (const url of readFeedsTxt(settings)) map.set(normalizeUrlKey(url), { url, enabled: true });

  for (const f of readFeedsJson(settings)) {
    if (!f || !f.url) continue;
    const key = normalizeUrlKey(f.url);
    const base = map.get(key) || { url: String(f.url).trim(), enabled: true };
    const tags = Array.isArray(f.tags)
      ? f.tags.map(String)
      : typeof f.tags === "string"
        ? f.tags.split(",").map((t) => t.trim()).filter(Boolean)
        : base.tags || [];
    const collection = f.collection != null && String(f.collection).trim()
      ? String(f.collection).trim()
      : base.collection || null;
    map.set(key, { ...base, ...f, url: base.url, enabled: f.enabled !== false, tags, collection });
  }
  return [...map.values()];
}

// Backwards-compatible: every configured feed URL (enabled or not). Used for
// listing and for computing which cached entries are still "owned" by a feed.
export function loadFeeds(settings = getSettings()) {
  return loadFeedConfig(settings).map((f) => f.url);
}

// Only the feeds that should actually be fetched on a refresh.
export function loadEnabledFeeds(settings = getSettings()) {
  return loadFeedConfig(settings).filter((f) => f.enabled !== false);
}

// Upserts per-feed options into feeds.json (created on first use).
export function setFeedOptions(url, options = {}, settings = getSettings()) {
  const normalized = String(url || "").trim();
  if (!normalized) return { ok: false, reason: "Empty URL" };
  try {
    // validate as http(s) like appendFeed does
    const parsed = new URL(normalized);
    if (!/^https?:$/.test(parsed.protocol)) return { ok: false, reason: "Only http(s) URLs are supported" };
  } catch {
    return { ok: false, reason: "Invalid URL" };
  }

  const path = feedsJsonPath(settings);
  let raw = [];
  if (existsSync(path)) {
    try {
      const j = JSON.parse(readFileSync(path, "utf8"));
      raw = Array.isArray(j) ? j : Array.isArray(j?.feeds) ? j.feeds : [];
    } catch {
      raw = [];
    }
  }
  const key = normalizeUrlKey(normalized);
  const idx = raw.findIndex((f) => f?.url && normalizeUrlKey(f.url) === key);
  const merged = { ...(idx >= 0 ? raw[idx] : {}), ...options, url: idx >= 0 ? raw[idx].url : normalized };
  if (idx >= 0) raw[idx] = merged;
  else raw.push(merged);

  try {
    writeFileSync(path, JSON.stringify({ feeds: raw }, null, 2) + "\n");
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  return { ok: true, feed: merged };
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
  const target = normalizeUrlKey(url);
  if (!target) return { ok: false, reason: "Feed not found in list" };

  let removed = false;

  // 1) Remove from feeds.txt. Exact (trailing-slash-tolerant) match only: a
  // substring match would let removing "example.com" also delete
  // "example.com/feed".
  const path = feedsFilePath(settings);
  if (existsSync(path)) {
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    const isMatch = (line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return false;
      return normalizeUrlKey(t) === target;
    };
    if (lines.some(isMatch)) {
      const kept = lines.filter((l) => !isMatch(l));
      writeFileSync(path, kept.join("\n") + (kept.length ? "\n" : ""));
      removed = true;
    }
  }

  // 2) Drop any feeds.json override for the same URL too.
  const jpath = feedsJsonPath(settings);
  if (existsSync(jpath)) {
    try {
      const j = JSON.parse(readFileSync(jpath, "utf8"));
      const list = Array.isArray(j) ? j : Array.isArray(j?.feeds) ? j.feeds : [];
      const kept = list.filter((f) => !(f?.url && normalizeUrlKey(f.url) === target));
      if (kept.length !== list.length) {
        writeFileSync(jpath, JSON.stringify({ feeds: kept }, null, 2) + "\n");
        removed = true;
      }
    } catch {
      /* ignore malformed feeds.json */
    }
  }

  if (!removed) return { ok: false, reason: "Feed not found in list" };
  return { ok: true, feeds: loadFeeds(settings).length };
}

export function getDbPath() {
  return join(pluginDataDir, "cache.db");
}
