import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

export function loadSettings() {
  const file = join(ROOT, "settings.json");
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
  const file = join(ROOT, settings.feedsFile);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

export const PATHS = {
  root: ROOT,
  db: join(ROOT, "data", "cache.db"),
};