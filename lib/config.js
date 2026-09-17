import { readFileSync, existsSync, mkdirSync } from "node:fs";
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

export function getDbPath() {
  return join(pluginDataDir, "cache.db");
}