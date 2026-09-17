import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const pluginDataDir = join(homedir(), ".lmstudio", "plugin-data", "rss-rag-cache");
mkdirSync(pluginDataDir, { recursive: true });

export function loadSettings() {
  const file = join(pluginDataDir, "settings.json");
  const defaults = {
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
  if (!existsSync(file)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return defaults;
  }
}

export function loadFeeds(settings) {
  const file = join(pluginDataDir, settings.feedsFile);

  if (!existsSync(file)) {
    const localFile = join(process.cwd(), settings.feedsFile);
    if (!existsSync(localFile)) return [];
    return readFileSync(localFile, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  }

  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function feedsFilePath(settings) {
  return join(pluginDataDir, settings.feedsFile);
}

export function appendFeed(url, settings = {}) {
  const path = feedsFilePath(settings);
  const existing = existsSync(path)
    ? readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.trim())
    : [];
  const normalized = String(url).trim();
  if (!normalized) return { ok: false, reason: "Empty URL" };
  if (existing.some((l) => l === normalized)) return { ok: false, reason: "Feed already in list" };
  try {
    new URL(normalized); // validate
  } catch {
    return { ok: false, reason: "Invalid URL" };
  }
  const line = existing.length && existing.at(-1) !== "" ? `\n${normalized}` : normalized;
  appendFileSync(path, line + "\n");
  return { ok: true, feeds: appendFeedList(settings).length };
}

function appendFeedList(settings) {
  const path = feedsFilePath(settings);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

export function removeFeed(url, settings = {}) {
  const path = feedsFilePath(settings);
  if (!existsSync(path)) return { ok: false, reason: "No feeds file" };
  const normalized = String(url).trim();
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const had = lines.some((l) => {
    const t = l.trim();
    return t && !t.startsWith("#") && (t === normalized || t.includes(normalized));
  });
  if (!had) return { ok: false, reason: "Feed not found in list" };
  const kept = lines.filter((l) => { const t = l.trim(); return t && (t.startsWith("#") || (t !== normalized && !t.includes(normalized))); });
  writeFileSync(path, kept.join("\n") + (kept.length ? "\n" : ""));
  return { ok: true, feeds: appendFeedList(settings).length };
}

export function getDbPath() {
  return join(pluginDataDir, "cache.db");
}