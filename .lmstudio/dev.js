var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/config.ts
var import_sdk, configSchematics;
var init_config = __esm({
  "src/config.ts"() {
    import_sdk = require("@lmstudio/sdk");
    configSchematics = (0, import_sdk.createConfigSchematics)().field(
      "retentionDays",
      "select",
      {
        displayName: "Retention Period",
        subtitle: "How long to keep cached RSS entries in the local database.",
        options: [
          { value: "30", displayName: "30 Days" },
          { value: "60", displayName: "60 Days" },
          { value: "90", displayName: "90 Days" },
          { value: "365", displayName: "365 Days" }
        ]
      },
      "90"
    ).field(
      "refreshIntervalHours",
      "numeric",
      {
        displayName: "Refresh Interval (Hours)",
        subtitle: "How often to automatically fetch new RSS items.",
        min: 1,
        max: 168,
        int: true,
        slider: { step: 1, min: 1, max: 24 }
      },
      6
    ).field(
      "embeddingModel",
      "select",
      {
        displayName: "Embedding Model",
        subtitle: "The embedding model loaded in LM Studio server.",
        options: [
          { value: "nomic-embed-text-v1.5", displayName: "nomic-embed-text-v1.5" },
          { value: "text-embedding-nomic-embed-text-v1.0", displayName: "text-embedding-nomic-embed-text-v1.0" },
          { value: "bge-large-en-v1.5", displayName: "bge-large-en-v1.5" },
          { value: "all-MiniLM-L6-v2", displayName: "all-MiniLM-L6-v2" }
        ]
      },
      "nomic-embed-text-v1.5"
    ).build();
  }
});

// lib/config.js
function loadSettings() {
  const file = (0, import_node_path.join)(pluginDataDir, "settings.json");
  const defaults = {
    retentionDays: 90,
    refreshIntervalHours: 6,
    embeddingModel: "nomic-embed-text-v1.5",
    topK: 8,
    feedsFile: "feeds.txt",
    lmStudioBaseUrl: "http://localhost:1234"
  };
  if (!(0, import_node_fs.existsSync)(file)) return defaults;
  try {
    return { ...defaults, ...JSON.parse((0, import_node_fs.readFileSync)(file, "utf8")) };
  } catch {
    return defaults;
  }
}
function loadFeeds(settings) {
  const file = (0, import_node_path.join)(pluginDataDir, settings.feedsFile);
  if (!(0, import_node_fs.existsSync)(file)) {
    const localFile = (0, import_node_path.join)(process.cwd(), settings.feedsFile);
    if (!(0, import_node_fs.existsSync)(localFile)) return [];
    return (0, import_node_fs.readFileSync)(localFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  }
  return (0, import_node_fs.readFileSync)(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}
function getDbPath() {
  return (0, import_node_path.join)(pluginDataDir, "cache.db");
}
var import_node_fs, import_node_path, import_node_os, pluginDataDir;
var init_config2 = __esm({
  "lib/config.js"() {
    import_node_fs = require("node:fs");
    import_node_path = require("node:path");
    import_node_os = require("node:os");
    pluginDataDir = (0, import_node_path.join)((0, import_node_os.homedir)(), ".lmstudio", "plugin-data", "rss-rag-cache");
    (0, import_node_fs.mkdirSync)(pluginDataDir, { recursive: true });
  }
});

// lib/db.js
function getDb() {
  if (db) return db;
  const dbPath = getDbPath();
  (0, import_node_fs2.mkdirSync)((0, import_node_path2.dirname)(dbPath), { recursive: true });
  db = new import_node_sqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      guid        TEXT UNIQUE,
      feed_url    TEXT,
      title       TEXT,
      link        TEXT,
      author      TEXT,
      pub_date    INTEGER,
      summary     TEXT,
      content     TEXT,
      cached_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id     INTEGER NOT NULL,
      chunk_index  INTEGER NOT NULL,
      text         TEXT NOT NULL,
      embedding    BLOB,
      FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_entries_pub   ON entries(pub_date);
    CREATE INDEX IF NOT EXISTS idx_entries_cache ON entries(cached_at);
    CREATE INDEX IF NOT EXISTS idx_chunks_entry  ON chunks(entry_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text, content='chunks', content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
    END;
  `);
  return db;
}
var import_node_sqlite, import_node_fs2, import_node_path2, db;
var init_db = __esm({
  "lib/db.js"() {
    import_node_sqlite = require("node:sqlite");
    import_node_fs2 = require("node:fs");
    import_node_path2 = require("node:path");
    init_config2();
  }
});

// lib/retention.js
function runRetention(retentionDays) {
  const db2 = getDb();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1e3;
  const info = db2.prepare(`DELETE FROM entries WHERE cached_at < ?`).run(cutoff);
  db2.prepare(`DELETE FROM chunks WHERE entry_id NOT IN (SELECT id FROM entries)`).run();
  return { deletedEntries: info.changes, cutoff };
}
function getLastRefresh() {
  const db2 = getDb();
  const row = db2.prepare(`SELECT MAX(cached_at) AS m FROM entries`).get();
  return row?.m ?? 0;
}
var init_retention = __esm({
  "lib/retention.js"() {
    init_db();
  }
});

// lib/embedder.js
async function embed(texts, { baseUrl: baseUrl2, model }) {
  if (!texts.length) return [];
  const res = await fetch(`${baseUrl2}/v1/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: texts })
  });
  if (!res.ok) throw new Error(`Embedding request failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.data.map((d) => new Float32Array(d.embedding));
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function float32ToBuffer(arr) {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}
function bufferToFloat32(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}
var init_embedder = __esm({
  "lib/embedder.js"() {
  }
});

// lib/parser.js
function getText(xml, tag) {
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = xml.match(regex);
  return match ? match[1].trim() : "";
}
function getAttr(xml, tag, attr) {
  const regex = new RegExp(`<${tag}[^>]*${attr}=["']([^"']*)["'][^>]*>`, "i");
  const match = xml.match(regex);
  return match ? match[1].trim() : "";
}
function stripTags(html) {
  return html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, "").trim();
}
function parseRss(xml, feedUrl) {
  const items = [];
  const rssItems = xml.match(/<item[\s\S]*?<\/item>/ig) || [];
  for (const itemXml of rssItems) {
    const title = stripTags(getText(itemXml, "title"));
    let link = getText(itemXml, "link");
    if (!link) link = getAttr(itemXml, "link", "href");
    items.push({
      guid: String(getText(itemXml, "guid") || link || `${feedUrl}#${title}`),
      feed_url: feedUrl,
      title,
      link,
      author: getText(itemXml, "dc:creator") || getText(itemXml, "author"),
      pub_date: getText(itemXml, "pubDate") ? Date.parse(getText(itemXml, "pubDate")) : Date.now(),
      summary: stripTags(getText(itemXml, "description")),
      content: stripTags(getText(itemXml, "content:encoded") || getText(itemXml, "description"))
    });
  }
  const atomEntries = xml.match(/<entry[\s\S]*?<\/entry>/ig) || [];
  for (const entryXml of atomEntries) {
    const title = stripTags(getText(entryXml, "title"));
    let link = getAttr(entryXml, "link", "href");
    if (!link) link = getText(entryXml, "link");
    const updated = getText(entryXml, "updated") || getText(entryXml, "published");
    items.push({
      guid: String(getText(entryXml, "id") || link || `${feedUrl}#${title}`),
      feed_url: feedUrl,
      title,
      link,
      author: getText(entryXml, "name"),
      pub_date: updated ? Date.parse(updated) : Date.now(),
      summary: stripTags(getText(entryXml, "summary")),
      content: stripTags(getText(entryXml, "content") || getText(entryXml, "summary"))
    });
  }
  return items;
}
function parseHtml(html, feedUrl) {
  const $ = cheerio.load(html);
  const items = [];
  const seenLinks = /* @__PURE__ */ new Set();
  $("a").each((i, el) => {
    let link = $(el).attr("href");
    let title = $(el).text().trim();
    if (!link || !title) return;
    try {
      link = new URL(link, feedUrl).href;
    } catch {
      return;
    }
    if (title.length < 15) return;
    if (link.endsWith("/news/") || link.endsWith("/")) return;
    if (link.includes("twitter.com") || link.includes("facebook.com") || link.includes("linkedin.com")) return;
    const lowerLink = link.toLowerCase();
    if (!lowerLink.includes("/news/") && !lowerLink.includes("/article/") && !lowerLink.includes("/post/") && !lowerLink.includes("/blog/")) {
      return;
    }
    if (seenLinks.has(link)) return;
    seenLinks.add(link);
    items.push({
      guid: link,
      feed_url: feedUrl,
      title,
      link,
      author: "Web Scrape",
      pub_date: Date.now(),
      summary: title,
      content: title
    });
  });
  return items;
}
var cheerio;
var init_parser = __esm({
  "lib/parser.js"() {
    cheerio = __toESM(require("cheerio"));
  }
});

// lib/fetcher.js
var fetcher_exports = {};
__export(fetcher_exports, {
  fetchAll: () => fetchAll,
  fetchFeed: () => fetchFeed
});
async function fetchFeed(url, { timeoutMs = 2e4 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1"
      },
      signal: ctrl.signal,
      redirect: "follow"
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    if (!text || text.length < 50) throw new Error("Empty or invalid response");
    const lowerText = text.trim().toLowerCase();
    if (lowerText.includes("<rss") || lowerText.includes("<feed") || lowerText.includes("<?xml")) {
      return parseRss(text, url);
    }
    if (lowerText.startsWith("<!doctype") || lowerText.startsWith("<html") || res.headers.get("content-type")?.includes("text/html")) {
      console.log(`[rss-rag] No RSS found at ${url}. Scraping HTML for links...`);
      const scrapedItems = parseHtml(text, url);
      if (scrapedItems.length === 0) throw new Error("No articles found on HTML page");
      return scrapedItems;
    }
    return parseRss(text, url);
  } finally {
    clearTimeout(t);
  }
}
async function fetchAll(feeds) {
  const rssFeeds = [];
  const htmlFeeds = [];
  for (const url of feeds) {
    if (looksLikeRss(url)) {
      rssFeeds.push(url);
    } else {
      htmlFeeds.push(url);
    }
  }
  const results = [];
  console.log(`[rss-rag] Fast-fetching ${rssFeeds.length} RSS feeds...`);
  const rssPromises = rssFeeds.map(
    (url) => fetchFeed(url).then((items) => ({ url, ok: true, items, mode: "fast" })).catch((err) => ({ url, ok: false, error: String(err.message || err), mode: "fast" }))
  );
  const rssResults = await Promise.all(rssPromises);
  results.push(...rssResults);
  if (htmlFeeds.length > 0) {
    const estTime = (htmlFeeds.length * 2.25).toFixed(0);
    console.log(`[rss-rag] Slow-fetching ${htmlFeeds.length} HTML pages. Estimated time: ${estTime}s...`);
    for (let i = 0; i < htmlFeeds.length; i++) {
      const url = htmlFeeds[i];
      const progress = `[${i + 1}/${htmlFeeds.length}]`;
      console.log(`[rss-rag] ${progress} Scraping ${url}...`);
      try {
        const items = await fetchFeed(url);
        results.push({ url, ok: true, items, mode: "slow" });
        console.log(`[rss-rag] ${progress} Success: Found ${items.length} items.`);
      } catch (err) {
        results.push({ url, ok: false, error: String(err.message || err), mode: "slow" });
        console.log(`[rss-rag] ${progress} Failed: ${err.message}`);
      }
      if (i < htmlFeeds.length - 1) {
        const delay = 1500 + Math.random() * 1500;
        await sleep(delay);
      }
    }
  }
  return results;
}
var UA, sleep, looksLikeRss;
var init_fetcher = __esm({
  "lib/fetcher.js"() {
    init_parser();
    UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    looksLikeRss = (url) => {
      const lower = url.toLowerCase();
      return lower.endsWith(".xml") || lower.endsWith(".rss") || lower.endsWith(".atom") || lower.includes("/rss") || lower.includes("/feed") || lower.includes("feedburner") || lower.includes("/feeds/");
    };
  }
});

// lib/retriever.js
function chunkText(text) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const out = [];
  for (let i = 0; i < clean.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
    out.push(clean.slice(i, i + CHUNK_SIZE));
    if (i + CHUNK_SIZE >= clean.length) break;
  }
  return out;
}
async function indexEntry(entry, settings) {
  const db2 = getDb();
  const ins = db2.prepare(`
    INSERT OR IGNORE INTO entries (guid, feed_url, title, link, author, pub_date, summary, content, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = ins.run(entry.guid, entry.feed_url, entry.title, entry.link, entry.author, entry.pub_date, entry.summary, entry.content, Date.now());
  if (info.changes === 0) return false;
  const entryId = info.lastInsertRowid;
  const combined = `${entry.title}

${entry.summary}

${entry.content}`;
  const chunks = chunkText(combined);
  if (!chunks.length) return true;
  let vectors = [];
  try {
    vectors = await embed(chunks, { baseUrl: settings.lmStudioBaseUrl, model: settings.embeddingModel });
  } catch (e) {
    console.error("[rss-rag] Embedding failed, saving text only:", e.message);
    vectors = chunks.map(() => null);
  }
  const insChunk = db2.prepare(`INSERT INTO chunks (entry_id, chunk_index, text, embedding) VALUES (?, ?, ?, ?)`);
  db2.exec("BEGIN TRANSACTION");
  try {
    for (let idx = 0; idx < chunks.length; idx++) {
      const text = chunks[idx];
      const vec = vectors[idx];
      const vecBuffer = vec ? float32ToBuffer(vec) : null;
      insChunk.run(entryId, idx, text, vecBuffer);
    }
    db2.exec("COMMIT");
  } catch (e) {
    db2.exec("ROLLBACK");
    throw e;
  }
  return true;
}
async function refreshFeeds(settings, feeds) {
  const { fetchAll: fetchAll2 } = await Promise.resolve().then(() => (init_fetcher(), fetcher_exports));
  const startTime = Date.now();
  const results = await fetchAll2(feeds);
  const totalTime = ((Date.now() - startTime) / 1e3).toFixed(1);
  let added = 0;
  const failedFeeds = [];
  const slowSuccessFeeds = [];
  let fastSuccessCount = 0;
  for (const r of results) {
    if (!r.ok) {
      failedFeeds.push({ url: r.url, error: r.error, mode: r.mode });
      continue;
    }
    if (r.mode === "slow") {
      slowSuccessFeeds.push({ url: r.url, itemsFound: r.items.length });
    } else {
      fastSuccessCount++;
    }
    for (const item of r.items) {
      try {
        if (await indexEntry(item, settings)) added++;
      } catch (e) {
        console.error("index error:", e.message);
      }
    }
  }
  return {
    added,
    totalTimeSeconds: totalTime,
    fastMode: { success: fastSuccessCount, failed: failedFeeds.filter((f) => f.mode === "fast").length },
    slowMode: { success: slowSuccessFeeds.length, failed: failedFeeds.filter((f) => f.mode === "slow").length, details: slowSuccessFeeds },
    failedFeeds: failedFeeds.map((f) => ({ url: f.url, error: f.error }))
  };
}
async function retrieve(query, settings) {
  const db2 = getDb();
  let qVec = null;
  try {
    [qVec] = await embed([query], { baseUrl: settings.lmStudioBaseUrl, model: settings.embeddingModel });
  } catch (e) {
    console.error("[rss-rag] Query embedding failed, using keyword search only:", e.message);
  }
  const fts = db2.prepare(`
    SELECT c.id AS cid, c.text, c.entry_id
    FROM chunks_fts f
    JOIN chunks c ON c.id = f.rowid
    WHERE chunks_fts MATCH ?
    ORDER BY rank
    LIMIT 40
  `).all(query.replace(/["'*]/g, " ").trim() || "a");
  const seen = /* @__PURE__ */ new Set();
  const candidates = [];
  for (const row of fts) {
    if (seen.has(row.cid)) continue;
    seen.add(row.cid);
    candidates.push(row);
  }
  const scored = [];
  for (const row of candidates) {
    const r = db2.prepare(`SELECT embedding FROM chunks WHERE id = ?`).get(row.cid);
    if (r?.embedding && qVec) {
      const v = bufferToFloat32(r.embedding);
      scored.push({ cid: row.cid, entryId: row.entry_id, text: row.text, score: cosine(qVec, v) });
    } else {
      scored.push({ cid: row.cid, entryId: row.entry_id, text: row.text, score: 0.5 });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const topEntryIds = [...new Set(scored.map((s) => s.entryId))].slice(0, 3);
  if (!topEntryIds.length) {
    const entriesFts = db2.prepare(`
      SELECT id, title, summary, content, link, pub_date, feed_url
      FROM entries
      WHERE title LIKE ? OR summary LIKE ? OR content LIKE ?
      ORDER BY pub_date DESC
      LIMIT 5
    `).all(`%${query}%`, `%${query}%`, `%${query}%`);
    return entriesFts.map((m) => ({
      title: m.title,
      link: m.link,
      pub_date: m.pub_date,
      // Fixed bug!
      pub_date_iso: new Date(m.pub_date).toISOString(),
      feed: m.feed_url,
      text: (m.content || m.summary || "").slice(0, 4e3)
      // Return up to 4000 chars!
    }));
  }
  const meta = db2.prepare(`SELECT id, title, link, author, pub_date, feed_url, content, summary FROM entries WHERE id = ?`);
  return topEntryIds.map((entryId) => {
    const m = meta.get(entryId);
    return {
      title: m.title,
      link: m.link,
      author: m.author,
      pub_date: m.pub_date,
      // Fixed bug!
      pub_date_iso: new Date(m.pub_date).toISOString(),
      feed: m.feed_url,
      text: (m.content || m.summary || "").slice(0, 4e3)
      // Return up to 4000 chars!
    };
  });
}
var CHUNK_SIZE, CHUNK_OVERLAP;
var init_retriever = __esm({
  "lib/retriever.js"() {
    init_db();
    init_embedder();
    CHUNK_SIZE = 800;
    CHUNK_OVERLAP = 120;
  }
});

// src/toolsProvider.ts
async function toolsProvider(_ctl) {
  return [
    (0, import_sdk2.tool)({
      name: "search_rss_cache",
      description: "Semantic search over the local RSS RAG cache.",
      parameters: {
        query: import_zod.z.string(),
        days: import_zod.z.number().optional()
      },
      implementation: async ({ query, days }) => {
        const s = loadSettings();
        const results = await retrieve(query, s);
        const cutoff = days ? Date.now() - days * 86400 * 1e3 : 0;
        const filtered = results.filter((r) => r.pub_date >= cutoff);
        if (!filtered.length) return { count: 0, results: [], note: "No matches." };
        return {
          count: filtered.length,
          results: filtered.map((r) => ({
            title: r.title,
            link: r.link,
            date: r.pub_date_iso,
            snippet: r.text.slice(0, 600)
          }))
        };
      }
    }),
    (0, import_sdk2.tool)({
      name: "refresh_rss_feeds",
      description: "Force-refresh all RSS feeds listed in feeds.txt.",
      parameters: {},
      implementation: async () => {
        const s = loadSettings();
        const feeds = loadFeeds(s);
        const res = await refreshFeeds(s, feeds);
        const ret = runRetention(s.retentionDays);
        return {
          feeds: feeds.length,
          added: res.added,
          failedCount: res.failed,
          failedFeeds: res.failedFeeds,
          retention: ret
        };
      }
    }),
    (0, import_sdk2.tool)({
      name: "list_rss_feeds",
      description: "List the RSS/Atom feeds currently configured.",
      parameters: {},
      implementation: async () => {
        const s = loadSettings();
        const feeds = loadFeeds(s);
        const db2 = getDb();
        const stats = db2.prepare(`SELECT (SELECT COUNT(*) FROM entries) as entries, (SELECT COUNT(*) FROM chunks) as chunks`).get();
        return { feeds, entries: stats.entries, chunks: stats.chunks };
      }
    }),
    // <-- THIS WAS MISSING!
    (0, import_sdk2.tool)({
      name: "get_recent_cache_articles",
      description: "Get the most recent articles added to the cache. Use this to see what news is available or to summarize recent events without guessing search keywords.",
      parameters: {
        limit: import_zod.z.number().optional()
      },
      implementation: async ({ limit }) => {
        const db2 = getDb();
        const lim = limit || 20;
        const articles = db2.prepare(`SELECT title, link, pub_date, feed_url FROM entries ORDER BY pub_date DESC LIMIT ?`).all(lim);
        return {
          count: articles.length,
          articles: articles.map((a) => ({
            title: a.title,
            link: a.link,
            date: new Date(a.pub_date).toISOString(),
            feed: a.feed_url
          }))
        };
      }
    })
  ];
}
var import_sdk2, import_zod;
var init_toolsProvider = __esm({
  "src/toolsProvider.ts"() {
    import_sdk2 = require("@lmstudio/sdk");
    import_zod = require("zod");
    init_db();
    init_retention();
    init_retriever();
    init_config2();
  }
});

// src/index.ts
var src_exports = {};
__export(src_exports, {
  main: () => main
});
async function main(context) {
  context.withConfigSchematics(configSchematics);
  context.withToolsProvider(toolsProvider);
  getDb();
  async function maybeAutoRefresh() {
    const s = loadSettings();
    const last = getLastRefresh();
    const due = Date.now() - last > s.refreshIntervalHours * 3600 * 1e3;
    if (due) {
      try {
        const feeds = loadFeeds(s);
        const res = await refreshFeeds(s, feeds);
        runRetention(s.retentionDays);
        console.log("[rss-rag] auto-refresh complete:", res);
      } catch (e) {
        console.error("[rss-rag] auto-refresh error:", e.message);
      }
    }
  }
  maybeAutoRefresh();
  setInterval(maybeAutoRefresh, 36e5);
}
var init_src = __esm({
  "src/index.ts"() {
    init_config();
    init_toolsProvider();
    init_config2();
    init_db();
    init_retention();
    init_retriever();
    if (typeof process !== "undefined" && process.removeAllListeners) {
      process.removeAllListeners("warning");
    }
  }
});

// .lmstudio/entry.ts
var import_sdk3 = require("@lmstudio/sdk");
var clientIdentifier = process.env.LMS_PLUGIN_CLIENT_IDENTIFIER;
var clientPasskey = process.env.LMS_PLUGIN_CLIENT_PASSKEY;
var baseUrl = process.env.LMS_PLUGIN_BASE_URL;
var client = new import_sdk3.LMStudioClient({
  clientIdentifier,
  clientPasskey,
  baseUrl
});
globalThis.__LMS_PLUGIN_CONTEXT = true;
var predictionLoopHandlerSet = false;
var promptPreprocessorSet = false;
var configSchematicsSet = false;
var globalConfigSchematicsSet = false;
var toolsProviderSet = false;
var generatorSet = false;
var selfRegistrationHost = client.plugins.getSelfRegistrationHost();
var pluginContext = {
  withPredictionLoopHandler: (generate) => {
    if (predictionLoopHandlerSet) {
      throw new Error("PredictionLoopHandler already registered");
    }
    if (toolsProviderSet) {
      throw new Error("PredictionLoopHandler cannot be used with a tools provider");
    }
    predictionLoopHandlerSet = true;
    selfRegistrationHost.setPredictionLoopHandler(generate);
    return pluginContext;
  },
  withPromptPreprocessor: (preprocess) => {
    if (promptPreprocessorSet) {
      throw new Error("PromptPreprocessor already registered");
    }
    promptPreprocessorSet = true;
    selfRegistrationHost.setPromptPreprocessor(preprocess);
    return pluginContext;
  },
  withConfigSchematics: (configSchematics2) => {
    if (configSchematicsSet) {
      throw new Error("Config schematics already registered");
    }
    configSchematicsSet = true;
    selfRegistrationHost.setConfigSchematics(configSchematics2);
    return pluginContext;
  },
  withGlobalConfigSchematics: (globalConfigSchematics) => {
    if (globalConfigSchematicsSet) {
      throw new Error("Global config schematics already registered");
    }
    globalConfigSchematicsSet = true;
    selfRegistrationHost.setGlobalConfigSchematics(globalConfigSchematics);
    return pluginContext;
  },
  withToolsProvider: (toolsProvider2) => {
    if (toolsProviderSet) {
      throw new Error("Tools provider already registered");
    }
    if (predictionLoopHandlerSet) {
      throw new Error("Tools provider cannot be used with a predictionLoopHandler");
    }
    toolsProviderSet = true;
    selfRegistrationHost.setToolsProvider(toolsProvider2);
    return pluginContext;
  },
  withGenerator: (generator) => {
    if (generatorSet) {
      throw new Error("Generator already registered");
    }
    generatorSet = true;
    selfRegistrationHost.setGenerator(generator);
    return pluginContext;
  }
};
Promise.resolve().then(() => (init_src(), src_exports)).then(async (module2) => {
  return await module2.main(pluginContext);
}).then(() => {
  selfRegistrationHost.initCompleted();
}).catch((error) => {
  console.error("Failed to execute the main function of the plugin.");
  console.error(error);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL2NvbmZpZy50cyIsICIuLi9saWIvY29uZmlnLmpzIiwgIi4uL2xpYi9kYi5qcyIsICIuLi9saWIvcmV0ZW50aW9uLmpzIiwgIi4uL2xpYi9lbWJlZGRlci5qcyIsICIuLi9saWIvcGFyc2VyLmpzIiwgIi4uL2xpYi9mZXRjaGVyLmpzIiwgIi4uL2xpYi9yZXRyaWV2ZXIuanMiLCAiLi4vc3JjL3Rvb2xzUHJvdmlkZXIudHMiLCAiLi4vc3JjL2luZGV4LnRzIiwgImVudHJ5LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBjcmVhdGVDb25maWdTY2hlbWF0aWNzIH0gZnJvbSBcIkBsbXN0dWRpby9zZGtcIjtcclxuXHJcbmV4cG9ydCBjb25zdCBjb25maWdTY2hlbWF0aWNzID0gY3JlYXRlQ29uZmlnU2NoZW1hdGljcygpXHJcbiAgLmZpZWxkKFxyXG4gICAgXCJyZXRlbnRpb25EYXlzXCIsXHJcbiAgICBcInNlbGVjdFwiLFxyXG4gICAge1xyXG4gICAgICBkaXNwbGF5TmFtZTogXCJSZXRlbnRpb24gUGVyaW9kXCIsXHJcbiAgICAgIHN1YnRpdGxlOiBcIkhvdyBsb25nIHRvIGtlZXAgY2FjaGVkIFJTUyBlbnRyaWVzIGluIHRoZSBsb2NhbCBkYXRhYmFzZS5cIixcclxuICAgICAgb3B0aW9uczogW1xyXG4gICAgICAgIHsgdmFsdWU6IFwiMzBcIiwgZGlzcGxheU5hbWU6IFwiMzAgRGF5c1wiIH0sXHJcbiAgICAgICAgeyB2YWx1ZTogXCI2MFwiLCBkaXNwbGF5TmFtZTogXCI2MCBEYXlzXCIgfSxcclxuICAgICAgICB7IHZhbHVlOiBcIjkwXCIsIGRpc3BsYXlOYW1lOiBcIjkwIERheXNcIiB9LFxyXG4gICAgICAgIHsgdmFsdWU6IFwiMzY1XCIsIGRpc3BsYXlOYW1lOiBcIjM2NSBEYXlzXCIgfSxcclxuICAgICAgXSxcclxuICAgIH0sXHJcbiAgICBcIjkwXCIsXHJcbiAgKVxyXG4gIC5maWVsZChcclxuICAgIFwicmVmcmVzaEludGVydmFsSG91cnNcIixcclxuICAgIFwibnVtZXJpY1wiLFxyXG4gICAge1xyXG4gICAgICBkaXNwbGF5TmFtZTogXCJSZWZyZXNoIEludGVydmFsIChIb3VycylcIixcclxuICAgICAgc3VidGl0bGU6IFwiSG93IG9mdGVuIHRvIGF1dG9tYXRpY2FsbHkgZmV0Y2ggbmV3IFJTUyBpdGVtcy5cIixcclxuICAgICAgbWluOiAxLFxyXG4gICAgICBtYXg6IDE2OCxcclxuICAgICAgaW50OiB0cnVlLFxyXG4gICAgICBzbGlkZXI6IHsgc3RlcDogMSwgbWluOiAxLCBtYXg6IDI0IH0sXHJcbiAgICB9LFxyXG4gICAgNixcclxuICApXHJcbiAgLmZpZWxkKFxyXG4gICAgXCJlbWJlZGRpbmdNb2RlbFwiLFxyXG4gICAgXCJzZWxlY3RcIixcclxuICAgIHtcclxuICAgICAgZGlzcGxheU5hbWU6IFwiRW1iZWRkaW5nIE1vZGVsXCIsXHJcbiAgICAgIHN1YnRpdGxlOiBcIlRoZSBlbWJlZGRpbmcgbW9kZWwgbG9hZGVkIGluIExNIFN0dWRpbyBzZXJ2ZXIuXCIsXHJcbiAgICAgIG9wdGlvbnM6IFtcclxuICAgICAgICB7IHZhbHVlOiBcIm5vbWljLWVtYmVkLXRleHQtdjEuNVwiLCBkaXNwbGF5TmFtZTogXCJub21pYy1lbWJlZC10ZXh0LXYxLjVcIiB9LFxyXG4gICAgICAgIHsgdmFsdWU6IFwidGV4dC1lbWJlZGRpbmctbm9taWMtZW1iZWQtdGV4dC12MS4wXCIsIGRpc3BsYXlOYW1lOiBcInRleHQtZW1iZWRkaW5nLW5vbWljLWVtYmVkLXRleHQtdjEuMFwiIH0sXHJcbiAgICAgICAgeyB2YWx1ZTogXCJiZ2UtbGFyZ2UtZW4tdjEuNVwiLCBkaXNwbGF5TmFtZTogXCJiZ2UtbGFyZ2UtZW4tdjEuNVwiIH0sXHJcbiAgICAgICAgeyB2YWx1ZTogXCJhbGwtTWluaUxNLUw2LXYyXCIsIGRpc3BsYXlOYW1lOiBcImFsbC1NaW5pTE0tTDYtdjJcIiB9XHJcbiAgICAgIF0sXHJcbiAgICB9LFxyXG4gICAgXCJub21pYy1lbWJlZC10ZXh0LXYxLjVcIixcclxuICApXHJcbiAgLmJ1aWxkKCk7IiwgImltcG9ydCB7IHJlYWRGaWxlU3luYywgZXhpc3RzU3luYywgbWtkaXJTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcclxuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcclxuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJub2RlOm9zXCI7XHJcblxyXG5jb25zdCBwbHVnaW5EYXRhRGlyID0gam9pbihob21lZGlyKCksIFwiLmxtc3R1ZGlvXCIsIFwicGx1Z2luLWRhdGFcIiwgXCJyc3MtcmFnLWNhY2hlXCIpO1xyXG5ta2RpclN5bmMocGx1Z2luRGF0YURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gbG9hZFNldHRpbmdzKCkge1xyXG4gIGNvbnN0IGZpbGUgPSBqb2luKHBsdWdpbkRhdGFEaXIsIFwic2V0dGluZ3MuanNvblwiKTtcclxuICBjb25zdCBkZWZhdWx0cyA9IHtcclxuICAgIHJldGVudGlvbkRheXM6IDkwLFxyXG4gICAgcmVmcmVzaEludGVydmFsSG91cnM6IDYsXHJcbiAgICBlbWJlZGRpbmdNb2RlbDogXCJub21pYy1lbWJlZC10ZXh0LXYxLjVcIixcclxuICAgIHRvcEs6IDgsXHJcbiAgICBmZWVkc0ZpbGU6IFwiZmVlZHMudHh0XCIsXHJcbiAgICBsbVN0dWRpb0Jhc2VVcmw6IFwiaHR0cDovL2xvY2FsaG9zdDoxMjM0XCIsXHJcbiAgfTtcclxuICBpZiAoIWV4aXN0c1N5bmMoZmlsZSkpIHJldHVybiBkZWZhdWx0cztcclxuICB0cnkge1xyXG4gICAgcmV0dXJuIHsgLi4uZGVmYXVsdHMsIC4uLkpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGZpbGUsIFwidXRmOFwiKSkgfTtcclxuICB9IGNhdGNoIHtcclxuICAgIHJldHVybiBkZWZhdWx0cztcclxuICB9XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBsb2FkRmVlZHMoc2V0dGluZ3MpIHtcclxuICBjb25zdCBmaWxlID0gam9pbihwbHVnaW5EYXRhRGlyLCBzZXR0aW5ncy5mZWVkc0ZpbGUpO1xyXG5cclxuICBpZiAoIWV4aXN0c1N5bmMoZmlsZSkpIHtcclxuICAgIGNvbnN0IGxvY2FsRmlsZSA9IGpvaW4ocHJvY2Vzcy5jd2QoKSwgc2V0dGluZ3MuZmVlZHNGaWxlKTtcclxuICAgIGlmICghZXhpc3RzU3luYyhsb2NhbEZpbGUpKSByZXR1cm4gW107XHJcbiAgICByZXR1cm4gcmVhZEZpbGVTeW5jKGxvY2FsRmlsZSwgXCJ1dGY4XCIpXHJcbiAgICAgIC5zcGxpdCgvXFxyP1xcbi8pXHJcbiAgICAgIC5tYXAoKGwpID0+IGwudHJpbSgpKVxyXG4gICAgICAuZmlsdGVyKChsKSA9PiBsICYmICFsLnN0YXJ0c1dpdGgoXCIjXCIpKTtcclxuICB9XHJcblxyXG4gIHJldHVybiByZWFkRmlsZVN5bmMoZmlsZSwgXCJ1dGY4XCIpXHJcbiAgICAuc3BsaXQoL1xccj9cXG4vKVxyXG4gICAgLm1hcCgobCkgPT4gbC50cmltKCkpXHJcbiAgICAuZmlsdGVyKChsKSA9PiBsICYmICFsLnN0YXJ0c1dpdGgoXCIjXCIpKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGdldERiUGF0aCgpIHtcclxuICByZXR1cm4gam9pbihwbHVnaW5EYXRhRGlyLCBcImNhY2hlLmRiXCIpO1xyXG59IiwgImltcG9ydCB7IERhdGFiYXNlU3luYyB9IGZyb20gXCJub2RlOnNxbGl0ZVwiO1xyXG5pbXBvcnQgeyBta2RpclN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xyXG5pbXBvcnQgeyBkaXJuYW1lIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xyXG5pbXBvcnQgeyBnZXREYlBhdGggfSBmcm9tIFwiLi9jb25maWcuanNcIjtcclxuXHJcbmxldCBkYjtcclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBnZXREYigpIHtcclxuICBpZiAoZGIpIHJldHVybiBkYjtcclxuICBjb25zdCBkYlBhdGggPSBnZXREYlBhdGgoKTtcclxuICBta2RpclN5bmMoZGlybmFtZShkYlBhdGgpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcclxuICBcclxuICAvLyBVc2UgTm9kZSdzIGJ1aWx0LWluIG5hdGl2ZSBTUUxpdGVcclxuICBkYiA9IG5ldyBEYXRhYmFzZVN5bmMoZGJQYXRoKTtcclxuICBkYi5leGVjKGBcclxuICAgIENSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIGVudHJpZXMgKFxyXG4gICAgICBpZCAgICAgICAgICBJTlRFR0VSIFBSSU1BUlkgS0VZIEFVVE9JTkNSRU1FTlQsXHJcbiAgICAgIGd1aWQgICAgICAgIFRFWFQgVU5JUVVFLFxyXG4gICAgICBmZWVkX3VybCAgICBURVhULFxyXG4gICAgICB0aXRsZSAgICAgICBURVhULFxyXG4gICAgICBsaW5rICAgICAgICBURVhULFxyXG4gICAgICBhdXRob3IgICAgICBURVhULFxyXG4gICAgICBwdWJfZGF0ZSAgICBJTlRFR0VSLFxyXG4gICAgICBzdW1tYXJ5ICAgICBURVhULFxyXG4gICAgICBjb250ZW50ICAgICBURVhULFxyXG4gICAgICBjYWNoZWRfYXQgICBJTlRFR0VSIE5PVCBOVUxMXHJcbiAgICApO1xyXG5cclxuICAgIENSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIGNodW5rcyAoXHJcbiAgICAgIGlkICAgICAgICAgICBJTlRFR0VSIFBSSU1BUlkgS0VZIEFVVE9JTkNSRU1FTlQsXHJcbiAgICAgIGVudHJ5X2lkICAgICBJTlRFR0VSIE5PVCBOVUxMLFxyXG4gICAgICBjaHVua19pbmRleCAgSU5URUdFUiBOT1QgTlVMTCxcclxuICAgICAgdGV4dCAgICAgICAgIFRFWFQgTk9UIE5VTEwsXHJcbiAgICAgIGVtYmVkZGluZyAgICBCTE9CLFxyXG4gICAgICBGT1JFSUdOIEtFWShlbnRyeV9pZCkgUkVGRVJFTkNFUyBlbnRyaWVzKGlkKSBPTiBERUxFVEUgQ0FTQ0FERVxyXG4gICAgKTtcclxuXHJcbiAgICBDUkVBVEUgSU5ERVggSUYgTk9UIEVYSVNUUyBpZHhfZW50cmllc19wdWIgICBPTiBlbnRyaWVzKHB1Yl9kYXRlKTtcclxuICAgIENSRUFURSBJTkRFWCBJRiBOT1QgRVhJU1RTIGlkeF9lbnRyaWVzX2NhY2hlIE9OIGVudHJpZXMoY2FjaGVkX2F0KTtcclxuICAgIENSRUFURSBJTkRFWCBJRiBOT1QgRVhJU1RTIGlkeF9jaHVua3NfZW50cnkgIE9OIGNodW5rcyhlbnRyeV9pZCk7XHJcblxyXG4gICAgQ1JFQVRFIFZJUlRVQUwgVEFCTEUgSUYgTk9UIEVYSVNUUyBjaHVua3NfZnRzIFVTSU5HIGZ0czUoXHJcbiAgICAgIHRleHQsIGNvbnRlbnQ9J2NodW5rcycsIGNvbnRlbnRfcm93aWQ9J2lkJ1xyXG4gICAgKTtcclxuXHJcbiAgICBDUkVBVEUgVFJJR0dFUiBJRiBOT1QgRVhJU1RTIGNodW5rc19haSBBRlRFUiBJTlNFUlQgT04gY2h1bmtzIEJFR0lOXHJcbiAgICAgIElOU0VSVCBJTlRPIGNodW5rc19mdHMocm93aWQsIHRleHQpIFZBTFVFUyAobmV3LmlkLCBuZXcudGV4dCk7XHJcbiAgICBFTkQ7XHJcbiAgICBDUkVBVEUgVFJJR0dFUiBJRiBOT1QgRVhJU1RTIGNodW5rc19hZCBBRlRFUiBERUxFVEUgT04gY2h1bmtzIEJFR0lOXHJcbiAgICAgIElOU0VSVCBJTlRPIGNodW5rc19mdHMoY2h1bmtzX2Z0cywgcm93aWQsIHRleHQpIFZBTFVFUygnZGVsZXRlJywgb2xkLmlkLCBvbGQudGV4dCk7XHJcbiAgICBFTkQ7XHJcbiAgYCk7XHJcbiAgcmV0dXJuIGRiO1xyXG59IiwgImltcG9ydCB7IGdldERiIH0gZnJvbSBcIi4vZGIuanNcIjtcclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBydW5SZXRlbnRpb24ocmV0ZW50aW9uRGF5cykge1xyXG4gIGNvbnN0IGRiID0gZ2V0RGIoKTtcclxuICBjb25zdCBjdXRvZmYgPSBEYXRlLm5vdygpIC0gcmV0ZW50aW9uRGF5cyAqIDI0ICogNjAgKiA2MCAqIDEwMDA7XHJcbiAgY29uc3QgaW5mbyA9IGRiLnByZXBhcmUoYERFTEVURSBGUk9NIGVudHJpZXMgV0hFUkUgY2FjaGVkX2F0IDwgP2ApLnJ1bihjdXRvZmYpO1xyXG4gIC8vIEZUUyB0cmlnZ2VycyBoYW5kbGUgY2h1bmsgY2xlYW51cCB2aWEgT04gREVMRVRFIENBU0NBREU/IFRoZXkgZG9uJ3QgXHUyMDE0IGNsZWFuIGV4cGxpY2l0bHk6XHJcbiAgZGIucHJlcGFyZShgREVMRVRFIEZST00gY2h1bmtzIFdIRVJFIGVudHJ5X2lkIE5PVCBJTiAoU0VMRUNUIGlkIEZST00gZW50cmllcylgKS5ydW4oKTtcclxuICByZXR1cm4geyBkZWxldGVkRW50cmllczogaW5mby5jaGFuZ2VzLCBjdXRvZmYgfTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGdldExhc3RSZWZyZXNoKCkge1xyXG4gIGNvbnN0IGRiID0gZ2V0RGIoKTtcclxuICBjb25zdCByb3cgPSBkYi5wcmVwYXJlKGBTRUxFQ1QgTUFYKGNhY2hlZF9hdCkgQVMgbSBGUk9NIGVudHJpZXNgKS5nZXQoKTtcclxuICByZXR1cm4gcm93Py5tID8/IDA7XHJcbn0iLCAiZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGVtYmVkKHRleHRzLCB7IGJhc2VVcmwsIG1vZGVsIH0pIHtcclxuICBpZiAoIXRleHRzLmxlbmd0aCkgcmV0dXJuIFtdO1xyXG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGAke2Jhc2VVcmx9L3YxL2VtYmVkZGluZ3NgLCB7XHJcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxyXG4gICAgaGVhZGVyczogeyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxyXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBtb2RlbCwgaW5wdXQ6IHRleHRzIH0pLFxyXG4gIH0pO1xyXG4gIGlmICghcmVzLm9rKSB0aHJvdyBuZXcgRXJyb3IoYEVtYmVkZGluZyByZXF1ZXN0IGZhaWxlZDogJHtyZXMuc3RhdHVzfSAke2F3YWl0IHJlcy50ZXh0KCl9YCk7XHJcbiAgY29uc3QganNvbiA9IGF3YWl0IHJlcy5qc29uKCk7XHJcbiAgcmV0dXJuIGpzb24uZGF0YS5tYXAoKGQpID0+IG5ldyBGbG9hdDMyQXJyYXkoZC5lbWJlZGRpbmcpKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGNvc2luZShhLCBiKSB7XHJcbiAgbGV0IGRvdCA9IDAsIG5hID0gMCwgbmIgPSAwO1xyXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgYS5sZW5ndGg7IGkrKykgeyBkb3QgKz0gYVtpXSAqIGJbaV07IG5hICs9IGFbaV0gKiBhW2ldOyBuYiArPSBiW2ldICogYltpXTsgfVxyXG4gIGlmICghbmEgfHwgIW5iKSByZXR1cm4gMDtcclxuICByZXR1cm4gZG90IC8gKE1hdGguc3FydChuYSkgKiBNYXRoLnNxcnQobmIpKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGZsb2F0MzJUb0J1ZmZlcihhcnIpIHsgcmV0dXJuIEJ1ZmZlci5mcm9tKGFyci5idWZmZXIsIGFyci5ieXRlT2Zmc2V0LCBhcnIuYnl0ZUxlbmd0aCk7IH1cclxuZXhwb3J0IGZ1bmN0aW9uIGJ1ZmZlclRvRmxvYXQzMihidWYpIHsgcmV0dXJuIG5ldyBGbG9hdDMyQXJyYXkoYnVmLmJ1ZmZlciwgYnVmLmJ5dGVPZmZzZXQsIGJ1Zi5sZW5ndGggLyA0KTsgfSIsICJpbXBvcnQgKiBhcyBjaGVlcmlvIGZyb20gXCJjaGVlcmlvXCI7XHJcblxyXG5mdW5jdGlvbiBnZXRUZXh0KHhtbCwgdGFnKSB7XHJcbiAgY29uc3QgcmVnZXggPSBuZXcgUmVnRXhwKGA8JHt0YWd9KD86XFxcXHNbXj5dKik/PihbXFxcXHNcXFxcU10qPyk8XFxcXC8ke3RhZ30+YCwgXCJpXCIpO1xyXG4gIGNvbnN0IG1hdGNoID0geG1sLm1hdGNoKHJlZ2V4KTtcclxuICByZXR1cm4gbWF0Y2ggPyBtYXRjaFsxXS50cmltKCkgOiBcIlwiO1xyXG59XHJcblxyXG5mdW5jdGlvbiBnZXRBdHRyKHhtbCwgdGFnLCBhdHRyKSB7XHJcbiAgY29uc3QgcmVnZXggPSBuZXcgUmVnRXhwKGA8JHt0YWd9W14+XSoke2F0dHJ9PVtcIiddKFteXCInXSopW1wiJ11bXj5dKj5gLCBcImlcIik7XHJcbiAgY29uc3QgbWF0Y2ggPSB4bWwubWF0Y2gocmVnZXgpO1xyXG4gIHJldHVybiBtYXRjaCA/IG1hdGNoWzFdLnRyaW0oKSA6IFwiXCI7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHN0cmlwVGFncyhodG1sKSB7XHJcbiAgcmV0dXJuIGh0bWxcclxuICAgIC5yZXBsYWNlKC88IVxcW0NEQVRBXFxbKFtcXHNcXFNdKj8pXFxdXFxdPi9nLCBcIiQxXCIpXHJcbiAgICAucmVwbGFjZSgvPFtePl0qPi9nLCBcIlwiKVxyXG4gICAgLnRyaW0oKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUnNzKHhtbCwgZmVlZFVybCkge1xyXG4gIGNvbnN0IGl0ZW1zID0gW107XHJcbiAgY29uc3QgcnNzSXRlbXMgPSB4bWwubWF0Y2goLzxpdGVtW1xcc1xcU10qPzxcXC9pdGVtPi9pZykgfHwgW107XHJcbiAgZm9yIChjb25zdCBpdGVtWG1sIG9mIHJzc0l0ZW1zKSB7XHJcbiAgICBjb25zdCB0aXRsZSA9IHN0cmlwVGFncyhnZXRUZXh0KGl0ZW1YbWwsIFwidGl0bGVcIikpO1xyXG4gICAgbGV0IGxpbmsgPSBnZXRUZXh0KGl0ZW1YbWwsIFwibGlua1wiKTtcclxuICAgIGlmICghbGluaykgbGluayA9IGdldEF0dHIoaXRlbVhtbCwgXCJsaW5rXCIsIFwiaHJlZlwiKTtcclxuICAgIGl0ZW1zLnB1c2goe1xyXG4gICAgICBndWlkOiBTdHJpbmcoZ2V0VGV4dChpdGVtWG1sLCBcImd1aWRcIikgfHwgbGluayB8fCBgJHtmZWVkVXJsfSMke3RpdGxlfWApLFxyXG4gICAgICBmZWVkX3VybDogZmVlZFVybCwgdGl0bGUsIGxpbmssXHJcbiAgICAgIGF1dGhvcjogZ2V0VGV4dChpdGVtWG1sLCBcImRjOmNyZWF0b3JcIikgfHwgZ2V0VGV4dChpdGVtWG1sLCBcImF1dGhvclwiKSxcclxuICAgICAgcHViX2RhdGU6IGdldFRleHQoaXRlbVhtbCwgXCJwdWJEYXRlXCIpID8gRGF0ZS5wYXJzZShnZXRUZXh0KGl0ZW1YbWwsIFwicHViRGF0ZVwiKSkgOiBEYXRlLm5vdygpLFxyXG4gICAgICBzdW1tYXJ5OiBzdHJpcFRhZ3MoZ2V0VGV4dChpdGVtWG1sLCBcImRlc2NyaXB0aW9uXCIpKSxcclxuICAgICAgY29udGVudDogc3RyaXBUYWdzKGdldFRleHQoaXRlbVhtbCwgXCJjb250ZW50OmVuY29kZWRcIikgfHwgZ2V0VGV4dChpdGVtWG1sLCBcImRlc2NyaXB0aW9uXCIpKSxcclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgY29uc3QgYXRvbUVudHJpZXMgPSB4bWwubWF0Y2goLzxlbnRyeVtcXHNcXFNdKj88XFwvZW50cnk+L2lnKSB8fCBbXTtcclxuICBmb3IgKGNvbnN0IGVudHJ5WG1sIG9mIGF0b21FbnRyaWVzKSB7XHJcbiAgICBjb25zdCB0aXRsZSA9IHN0cmlwVGFncyhnZXRUZXh0KGVudHJ5WG1sLCBcInRpdGxlXCIpKTtcclxuICAgIGxldCBsaW5rID0gZ2V0QXR0cihlbnRyeVhtbCwgXCJsaW5rXCIsIFwiaHJlZlwiKTtcclxuICAgIGlmICghbGluaykgbGluayA9IGdldFRleHQoZW50cnlYbWwsIFwibGlua1wiKTtcclxuICAgIGNvbnN0IHVwZGF0ZWQgPSBnZXRUZXh0KGVudHJ5WG1sLCBcInVwZGF0ZWRcIikgfHwgZ2V0VGV4dChlbnRyeVhtbCwgXCJwdWJsaXNoZWRcIik7XHJcbiAgICBpdGVtcy5wdXNoKHtcclxuICAgICAgZ3VpZDogU3RyaW5nKGdldFRleHQoZW50cnlYbWwsIFwiaWRcIikgfHwgbGluayB8fCBgJHtmZWVkVXJsfSMke3RpdGxlfWApLFxyXG4gICAgICBmZWVkX3VybDogZmVlZFVybCwgdGl0bGUsIGxpbmssXHJcbiAgICAgIGF1dGhvcjogZ2V0VGV4dChlbnRyeVhtbCwgXCJuYW1lXCIpLFxyXG4gICAgICBwdWJfZGF0ZTogdXBkYXRlZCA/IERhdGUucGFyc2UodXBkYXRlZCkgOiBEYXRlLm5vdygpLFxyXG4gICAgICBzdW1tYXJ5OiBzdHJpcFRhZ3MoZ2V0VGV4dChlbnRyeVhtbCwgXCJzdW1tYXJ5XCIpKSxcclxuICAgICAgY29udGVudDogc3RyaXBUYWdzKGdldFRleHQoZW50cnlYbWwsIFwiY29udGVudFwiKSB8fCBnZXRUZXh0KGVudHJ5WG1sLCBcInN1bW1hcnlcIikpLFxyXG4gICAgfSk7XHJcbiAgfVxyXG4gIHJldHVybiBpdGVtcztcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlSHRtbChodG1sLCBmZWVkVXJsKSB7XHJcbiAgY29uc3QgJCA9IGNoZWVyaW8ubG9hZChodG1sKTtcclxuICBjb25zdCBpdGVtcyA9IFtdO1xyXG4gIGNvbnN0IHNlZW5MaW5rcyA9IG5ldyBTZXQoKTtcclxuXHJcbiAgLy8gU2NhbiBhbGwgbGlua3Mgb24gdGhlIHBhZ2VcclxuICAkKFwiYVwiKS5lYWNoKChpLCBlbCkgPT4ge1xyXG4gICAgbGV0IGxpbmsgPSAkKGVsKS5hdHRyKFwiaHJlZlwiKTtcclxuICAgIGxldCB0aXRsZSA9ICQoZWwpLnRleHQoKS50cmltKCk7XHJcblxyXG4gICAgaWYgKCFsaW5rIHx8ICF0aXRsZSkgcmV0dXJuO1xyXG5cclxuICAgIC8vIENvbnZlcnQgcmVsYXRpdmUgVVJMcyB0byBhYnNvbHV0ZVxyXG4gICAgdHJ5IHtcclxuICAgICAgbGluayA9IG5ldyBVUkwobGluaywgZmVlZFVybCkuaHJlZjtcclxuICAgIH0gY2F0Y2gge1xyXG4gICAgICByZXR1cm47IC8vIEludmFsaWQgVVJMXHJcbiAgICB9XHJcblxyXG4gICAgLy8gRmlsdGVyIG91dCBuYXZpZ2F0aW9uLCBidXR0b25zLCBhbmQgc29jaWFsIG1lZGlhIGxpbmtzXHJcbiAgICBpZiAodGl0bGUubGVuZ3RoIDwgMTUpIHJldHVybjtcclxuICAgIGlmIChsaW5rLmVuZHNXaXRoKCcvbmV3cy8nKSB8fCBsaW5rLmVuZHNXaXRoKCcvJykpIHJldHVybjtcclxuICAgIGlmIChsaW5rLmluY2x1ZGVzKCd0d2l0dGVyLmNvbScpIHx8IGxpbmsuaW5jbHVkZXMoJ2ZhY2Vib29rLmNvbScpIHx8IGxpbmsuaW5jbHVkZXMoJ2xpbmtlZGluLmNvbScpKSByZXR1cm47XHJcbiAgICBcclxuICAgIC8vIE9ubHkga2VlcCBsaW5rcyB0aGF0IGxvb2sgbGlrZSBhcnRpY2xlcyAoY29udGFpbiAvbmV3cy8gb3IgL2FydGljbGUvIG9yIC9wb3N0LylcclxuICAgIGNvbnN0IGxvd2VyTGluayA9IGxpbmsudG9Mb3dlckNhc2UoKTtcclxuICAgIGlmICghbG93ZXJMaW5rLmluY2x1ZGVzKCcvbmV3cy8nKSAmJiAhbG93ZXJMaW5rLmluY2x1ZGVzKCcvYXJ0aWNsZS8nKSAmJiAhbG93ZXJMaW5rLmluY2x1ZGVzKCcvcG9zdC8nKSAmJiAhbG93ZXJMaW5rLmluY2x1ZGVzKCcvYmxvZy8nKSkge1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKHNlZW5MaW5rcy5oYXMobGluaykpIHJldHVybjtcclxuICAgIHNlZW5MaW5rcy5hZGQobGluayk7XHJcblxyXG4gICAgaXRlbXMucHVzaCh7XHJcbiAgICAgIGd1aWQ6IGxpbmssXHJcbiAgICAgIGZlZWRfdXJsOiBmZWVkVXJsLFxyXG4gICAgICB0aXRsZTogdGl0bGUsXHJcbiAgICAgIGxpbms6IGxpbmssXHJcbiAgICAgIGF1dGhvcjogJ1dlYiBTY3JhcGUnLFxyXG4gICAgICBwdWJfZGF0ZTogRGF0ZS5ub3coKSxcclxuICAgICAgc3VtbWFyeTogdGl0bGUsXHJcbiAgICAgIGNvbnRlbnQ6IHRpdGxlLFxyXG4gICAgfSk7XHJcbiAgfSk7XHJcblxyXG4gIHJldHVybiBpdGVtcztcclxufSIsICJpbXBvcnQgeyBwYXJzZVJzcywgcGFyc2VIdG1sIH0gZnJvbSBcIi4vcGFyc2VyLmpzXCI7XHJcblxyXG5jb25zdCBVQSA9IFwiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEyNC4wLjAuMCBTYWZhcmkvNTM3LjM2XCI7XHJcbmNvbnN0IHNsZWVwID0gKG1zKSA9PiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgbXMpKTtcclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaEZlZWQodXJsLCB7IHRpbWVvdXRNcyA9IDIwMDAwIH0gPSB7fSkge1xyXG4gIGNvbnN0IGN0cmwgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XHJcbiAgY29uc3QgdCA9IHNldFRpbWVvdXQoKCkgPT4gY3RybC5hYm9ydCgpLCB0aW1lb3V0TXMpO1xyXG4gIHRyeSB7XHJcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHtcclxuICAgICAgaGVhZGVyczogeyBcclxuICAgICAgICBcIlVzZXItQWdlbnRcIjogVUEsXHJcbiAgICAgICAgXCJBY2NlcHRcIjogXCJhcHBsaWNhdGlvbi9yc3MreG1sLCBhcHBsaWNhdGlvbi9hdG9tK3htbCwgYXBwbGljYXRpb24veG1sO3E9MC45LCB0ZXh0L3htbDtxPTAuOSwgKi8qO3E9MC44XCIsXHJcbiAgICAgICAgXCJBY2NlcHQtTGFuZ3VhZ2VcIjogXCJlbi1HQixlbjtxPTAuOVwiLFxyXG4gICAgICAgIFwiQ29ubmVjdGlvblwiOiBcImtlZXAtYWxpdmVcIixcclxuICAgICAgICBcIlVwZ3JhZGUtSW5zZWN1cmUtUmVxdWVzdHNcIjogXCIxXCIsXHJcbiAgICAgICAgXCJTZWMtQ2gtVWFcIjogJ1wiQ2hyb21pdW1cIjt2PVwiMTI0XCIsIFwiR29vZ2xlIENocm9tZVwiO3Y9XCIxMjRcIiwgXCJOb3QtQS5CcmFuZFwiO3Y9XCI5OVwiJyxcclxuICAgICAgICBcIlNlYy1DaC1VYS1Nb2JpbGVcIjogXCI/MFwiLFxyXG4gICAgICAgIFwiU2VjLUNoLVVhLVBsYXRmb3JtXCI6ICdcIldpbmRvd3NcIicsXHJcbiAgICAgICAgXCJTZWMtRmV0Y2gtRGVzdFwiOiBcImRvY3VtZW50XCIsXHJcbiAgICAgICAgXCJTZWMtRmV0Y2gtTW9kZVwiOiBcIm5hdmlnYXRlXCIsXHJcbiAgICAgICAgXCJTZWMtRmV0Y2gtU2l0ZVwiOiBcIm5vbmVcIixcclxuICAgICAgICBcIlNlYy1GZXRjaC1Vc2VyXCI6IFwiPzFcIlxyXG4gICAgICB9LFxyXG4gICAgICBzaWduYWw6IGN0cmwuc2lnbmFsLFxyXG4gICAgICByZWRpcmVjdDogXCJmb2xsb3dcIixcclxuICAgIH0pO1xyXG4gICAgaWYgKCFyZXMub2spIHRocm93IG5ldyBFcnJvcihgSFRUUCAke3Jlcy5zdGF0dXN9ICR7cmVzLnN0YXR1c1RleHR9YCk7XHJcbiAgICBcclxuICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xyXG4gICAgaWYgKCF0ZXh0IHx8IHRleHQubGVuZ3RoIDwgNTApIHRocm93IG5ldyBFcnJvcihcIkVtcHR5IG9yIGludmFsaWQgcmVzcG9uc2VcIik7XHJcbiAgICBcclxuICAgIC8vIFNtYXJ0IGRldGVjdGlvbjogQ2hlY2sgdGhlIGFjdHVhbCB0ZXh0IGZpcnN0XHJcbiAgICBjb25zdCBsb3dlclRleHQgPSB0ZXh0LnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xyXG4gICAgaWYgKGxvd2VyVGV4dC5pbmNsdWRlcyhcIjxyc3NcIikgfHwgbG93ZXJUZXh0LmluY2x1ZGVzKFwiPGZlZWRcIikgfHwgbG93ZXJUZXh0LmluY2x1ZGVzKFwiPD94bWxcIikpIHtcclxuICAgICAgcmV0dXJuIHBhcnNlUnNzKHRleHQsIHVybCk7XHJcbiAgICB9XHJcbiAgICBcclxuICAgIC8vIElmIGl0IGRvZXNuJ3QgbG9vayBsaWtlIFJTUywgdHJ5IHNjcmFwaW5nIGl0IGFzIEhUTUxcclxuICAgIGlmIChsb3dlclRleHQuc3RhcnRzV2l0aChcIjwhZG9jdHlwZVwiKSB8fCBsb3dlclRleHQuc3RhcnRzV2l0aChcIjxodG1sXCIpIHx8IHJlcy5oZWFkZXJzLmdldCgnY29udGVudC10eXBlJyk/LmluY2x1ZGVzKCd0ZXh0L2h0bWwnKSkge1xyXG4gICAgICBjb25zb2xlLmxvZyhgW3Jzcy1yYWddIE5vIFJTUyBmb3VuZCBhdCAke3VybH0uIFNjcmFwaW5nIEhUTUwgZm9yIGxpbmtzLi4uYCk7XHJcbiAgICAgIGNvbnN0IHNjcmFwZWRJdGVtcyA9IHBhcnNlSHRtbCh0ZXh0LCB1cmwpO1xyXG4gICAgICBpZiAoc2NyYXBlZEl0ZW1zLmxlbmd0aCA9PT0gMCkgdGhyb3cgbmV3IEVycm9yKFwiTm8gYXJ0aWNsZXMgZm91bmQgb24gSFRNTCBwYWdlXCIpO1xyXG4gICAgICByZXR1cm4gc2NyYXBlZEl0ZW1zO1xyXG4gICAgfVxyXG4gICAgXHJcbiAgICAvLyBGYWxsYmFja1xyXG4gICAgcmV0dXJuIHBhcnNlUnNzKHRleHQsIHVybCk7XHJcbiAgfSBmaW5hbGx5IHtcclxuICAgIGNsZWFyVGltZW91dCh0KTtcclxuICB9XHJcbn1cclxuXHJcbmNvbnN0IGxvb2tzTGlrZVJzcyA9ICh1cmwpID0+IHtcclxuICBjb25zdCBsb3dlciA9IHVybC50b0xvd2VyQ2FzZSgpO1xyXG4gIHJldHVybiBsb3dlci5lbmRzV2l0aCgnLnhtbCcpIHx8IGxvd2VyLmVuZHNXaXRoKCcucnNzJykgfHwgbG93ZXIuZW5kc1dpdGgoJy5hdG9tJykgfHwgXHJcbiAgICAgICAgIGxvd2VyLmluY2x1ZGVzKCcvcnNzJykgfHwgbG93ZXIuaW5jbHVkZXMoJy9mZWVkJykgfHwgbG93ZXIuaW5jbHVkZXMoJ2ZlZWRidXJuZXInKSB8fCBsb3dlci5pbmNsdWRlcygnL2ZlZWRzLycpO1xyXG59O1xyXG5cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoQWxsKGZlZWRzKSB7XHJcbiAgY29uc3QgcnNzRmVlZHMgPSBbXTtcclxuICBjb25zdCBodG1sRmVlZHMgPSBbXTtcclxuICBcclxuICBmb3IgKGNvbnN0IHVybCBvZiBmZWVkcykge1xyXG4gICAgaWYgKGxvb2tzTGlrZVJzcyh1cmwpKSB7XHJcbiAgICAgIHJzc0ZlZWRzLnB1c2godXJsKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIGh0bWxGZWVkcy5wdXNoKHVybCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBjb25zdCByZXN1bHRzID0gW107XHJcblxyXG4gIC8vIDEuIEZldGNoIGFsbCBSU1MgZmVlZHMgY29uY3VycmVudGx5XHJcbiAgY29uc29sZS5sb2coYFtyc3MtcmFnXSBGYXN0LWZldGNoaW5nICR7cnNzRmVlZHMubGVuZ3RofSBSU1MgZmVlZHMuLi5gKTtcclxuICBjb25zdCByc3NQcm9taXNlcyA9IHJzc0ZlZWRzLm1hcCh1cmwgPT4gXHJcbiAgICBmZXRjaEZlZWQodXJsKVxyXG4gICAgICAudGhlbihpdGVtcyA9PiAoeyB1cmwsIG9rOiB0cnVlLCBpdGVtcywgbW9kZTogXCJmYXN0XCIgfSkpXHJcbiAgICAgIC5jYXRjaChlcnIgPT4gKHsgdXJsLCBvazogZmFsc2UsIGVycm9yOiBTdHJpbmcoZXJyLm1lc3NhZ2UgfHwgZXJyKSwgbW9kZTogXCJmYXN0XCIgfSkpXHJcbiAgKTtcclxuICBjb25zdCByc3NSZXN1bHRzID0gYXdhaXQgUHJvbWlzZS5hbGwocnNzUHJvbWlzZXMpO1xyXG4gIHJlc3VsdHMucHVzaCguLi5yc3NSZXN1bHRzKTtcclxuXHJcbiAgLy8gMi4gRmV0Y2ggSFRNTCBwYWdlcyBzZXF1ZW50aWFsbHkgKFNsb3cpXHJcbiAgaWYgKGh0bWxGZWVkcy5sZW5ndGggPiAwKSB7XHJcbiAgICBjb25zdCBlc3RUaW1lID0gKGh0bWxGZWVkcy5sZW5ndGggKiAyLjI1KS50b0ZpeGVkKDApOyAvLyBFc3RpbWF0ZSB+Mi4yNXMgcGVyIGZlZWRcclxuICAgIGNvbnNvbGUubG9nKGBbcnNzLXJhZ10gU2xvdy1mZXRjaGluZyAke2h0bWxGZWVkcy5sZW5ndGh9IEhUTUwgcGFnZXMuIEVzdGltYXRlZCB0aW1lOiAke2VzdFRpbWV9cy4uLmApO1xyXG4gICAgXHJcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGh0bWxGZWVkcy5sZW5ndGg7IGkrKykge1xyXG4gICAgICBjb25zdCB1cmwgPSBodG1sRmVlZHNbaV07XHJcbiAgICAgIGNvbnN0IHByb2dyZXNzID0gYFske2kgKyAxfS8ke2h0bWxGZWVkcy5sZW5ndGh9XWA7XHJcbiAgICAgIGNvbnNvbGUubG9nKGBbcnNzLXJhZ10gJHtwcm9ncmVzc30gU2NyYXBpbmcgJHt1cmx9Li4uYCk7XHJcbiAgICAgIFxyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IGl0ZW1zID0gYXdhaXQgZmV0Y2hGZWVkKHVybCk7XHJcbiAgICAgICAgcmVzdWx0cy5wdXNoKHsgdXJsLCBvazogdHJ1ZSwgaXRlbXMsIG1vZGU6IFwic2xvd1wiIH0pO1xyXG4gICAgICAgIGNvbnNvbGUubG9nKGBbcnNzLXJhZ10gJHtwcm9ncmVzc30gU3VjY2VzczogRm91bmQgJHtpdGVtcy5sZW5ndGh9IGl0ZW1zLmApO1xyXG4gICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICByZXN1bHRzLnB1c2goeyB1cmwsIG9rOiBmYWxzZSwgZXJyb3I6IFN0cmluZyhlcnIubWVzc2FnZSB8fCBlcnIpLCBtb2RlOiBcInNsb3dcIiB9KTtcclxuICAgICAgICBjb25zb2xlLmxvZyhgW3Jzcy1yYWddICR7cHJvZ3Jlc3N9IEZhaWxlZDogJHtlcnIubWVzc2FnZX1gKTtcclxuICAgICAgfVxyXG4gICAgICBcclxuICAgICAgaWYgKGkgPCBodG1sRmVlZHMubGVuZ3RoIC0gMSkge1xyXG4gICAgICAgIGNvbnN0IGRlbGF5ID0gMTUwMCArIE1hdGgucmFuZG9tKCkgKiAxNTAwO1xyXG4gICAgICAgIGF3YWl0IHNsZWVwKGRlbGF5KTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgcmV0dXJuIHJlc3VsdHM7XHJcbn0iLCAiaW1wb3J0IHsgZ2V0RGIgfSBmcm9tIFwiLi9kYi5qc1wiO1xyXG5pbXBvcnQgeyBlbWJlZCwgY29zaW5lLCBidWZmZXJUb0Zsb2F0MzIsIGZsb2F0MzJUb0J1ZmZlciB9IGZyb20gXCIuL2VtYmVkZGVyLmpzXCI7XHJcblxyXG5jb25zdCBDSFVOS19TSVpFID0gODAwO1xyXG5jb25zdCBDSFVOS19PVkVSTEFQID0gMTIwO1xyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGNodW5rVGV4dCh0ZXh0KSB7XHJcbiAgY29uc3QgY2xlYW4gPSAodGV4dCB8fCBcIlwiKS5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS50cmltKCk7XHJcbiAgaWYgKCFjbGVhbikgcmV0dXJuIFtdO1xyXG4gIGNvbnN0IG91dCA9IFtdO1xyXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgY2xlYW4ubGVuZ3RoOyBpICs9IENIVU5LX1NJWkUgLSBDSFVOS19PVkVSTEFQKSB7XHJcbiAgICBvdXQucHVzaChjbGVhbi5zbGljZShpLCBpICsgQ0hVTktfU0laRSkpO1xyXG4gICAgaWYgKGkgKyBDSFVOS19TSVpFID49IGNsZWFuLmxlbmd0aCkgYnJlYWs7XHJcbiAgfVxyXG4gIHJldHVybiBvdXQ7XHJcbn1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBpbmRleEVudHJ5KGVudHJ5LCBzZXR0aW5ncykge1xyXG4gIGNvbnN0IGRiID0gZ2V0RGIoKTtcclxuICBjb25zdCBpbnMgPSBkYi5wcmVwYXJlKGBcclxuICAgIElOU0VSVCBPUiBJR05PUkUgSU5UTyBlbnRyaWVzIChndWlkLCBmZWVkX3VybCwgdGl0bGUsIGxpbmssIGF1dGhvciwgcHViX2RhdGUsIHN1bW1hcnksIGNvbnRlbnQsIGNhY2hlZF9hdClcclxuICAgIFZBTFVFUyAoPywgPywgPywgPywgPywgPywgPywgPywgPylcclxuICBgKTtcclxuICBjb25zdCBpbmZvID0gaW5zLnJ1bihlbnRyeS5ndWlkLCBlbnRyeS5mZWVkX3VybCwgZW50cnkudGl0bGUsIGVudHJ5LmxpbmssIGVudHJ5LmF1dGhvciwgZW50cnkucHViX2RhdGUsIGVudHJ5LnN1bW1hcnksIGVudHJ5LmNvbnRlbnQsIERhdGUubm93KCkpO1xyXG4gIFxyXG4gIGlmIChpbmZvLmNoYW5nZXMgPT09IDApIHJldHVybiBmYWxzZTtcclxuXHJcbiAgY29uc3QgZW50cnlJZCA9IGluZm8ubGFzdEluc2VydFJvd2lkO1xyXG4gIGNvbnN0IGNvbWJpbmVkID0gYCR7ZW50cnkudGl0bGV9XFxuXFxuJHtlbnRyeS5zdW1tYXJ5fVxcblxcbiR7ZW50cnkuY29udGVudH1gO1xyXG4gIGNvbnN0IGNodW5rcyA9IGNodW5rVGV4dChjb21iaW5lZCk7XHJcbiAgaWYgKCFjaHVua3MubGVuZ3RoKSByZXR1cm4gdHJ1ZTtcclxuXHJcbiAgbGV0IHZlY3RvcnMgPSBbXTtcclxuICB0cnkge1xyXG4gICAgdmVjdG9ycyA9IGF3YWl0IGVtYmVkKGNodW5rcywgeyBiYXNlVXJsOiBzZXR0aW5ncy5sbVN0dWRpb0Jhc2VVcmwsIG1vZGVsOiBzZXR0aW5ncy5lbWJlZGRpbmdNb2RlbCB9KTtcclxuICB9IGNhdGNoIChlKSB7XHJcbiAgICBjb25zb2xlLmVycm9yKFwiW3Jzcy1yYWddIEVtYmVkZGluZyBmYWlsZWQsIHNhdmluZyB0ZXh0IG9ubHk6XCIsIGUubWVzc2FnZSk7XHJcbiAgICB2ZWN0b3JzID0gY2h1bmtzLm1hcCgoKSA9PiBudWxsKTsgXHJcbiAgfVxyXG5cclxuICBjb25zdCBpbnNDaHVuayA9IGRiLnByZXBhcmUoYElOU0VSVCBJTlRPIGNodW5rcyAoZW50cnlfaWQsIGNodW5rX2luZGV4LCB0ZXh0LCBlbWJlZGRpbmcpIFZBTFVFUyAoPywgPywgPywgPylgKTtcclxuICBcclxuICAvLyBOYXRpdmUgU1FMaXRlIHRyYW5zYWN0aW9uIGZpeFxyXG4gIGRiLmV4ZWMoXCJCRUdJTiBUUkFOU0FDVElPTlwiKTtcclxuICB0cnkge1xyXG4gICAgZm9yIChsZXQgaWR4ID0gMDsgaWR4IDwgY2h1bmtzLmxlbmd0aDsgaWR4KyspIHtcclxuICAgICAgY29uc3QgdGV4dCA9IGNodW5rc1tpZHhdO1xyXG4gICAgICBjb25zdCB2ZWMgPSB2ZWN0b3JzW2lkeF07XHJcbiAgICAgIGNvbnN0IHZlY0J1ZmZlciA9IHZlYyA/IGZsb2F0MzJUb0J1ZmZlcih2ZWMpIDogbnVsbDtcclxuICAgICAgaW5zQ2h1bmsucnVuKGVudHJ5SWQsIGlkeCwgdGV4dCwgdmVjQnVmZmVyKTtcclxuICAgIH1cclxuICAgIGRiLmV4ZWMoXCJDT01NSVRcIik7XHJcbiAgfSBjYXRjaCAoZSkge1xyXG4gICAgZGIuZXhlYyhcIlJPTExCQUNLXCIpO1xyXG4gICAgdGhyb3cgZTtcclxuICB9XHJcbiAgXHJcbiAgcmV0dXJuIHRydWU7XHJcbn1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWZyZXNoRmVlZHMoc2V0dGluZ3MsIGZlZWRzKSB7XHJcbiAgY29uc3QgeyBmZXRjaEFsbCB9ID0gYXdhaXQgaW1wb3J0KFwiLi9mZXRjaGVyLmpzXCIpO1xyXG4gIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XHJcbiAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IGZldGNoQWxsKGZlZWRzKTtcclxuICBjb25zdCB0b3RhbFRpbWUgPSAoKERhdGUubm93KCkgLSBzdGFydFRpbWUpIC8gMTAwMCkudG9GaXhlZCgxKTtcclxuICBcclxuICBsZXQgYWRkZWQgPSAwO1xyXG4gIGNvbnN0IGZhaWxlZEZlZWRzID0gW107XHJcbiAgY29uc3Qgc2xvd1N1Y2Nlc3NGZWVkcyA9IFtdO1xyXG4gIGxldCBmYXN0U3VjY2Vzc0NvdW50ID0gMDtcclxuXHJcbiAgZm9yIChjb25zdCByIG9mIHJlc3VsdHMpIHtcclxuICAgIGlmICghci5vaykge1xyXG4gICAgICBmYWlsZWRGZWVkcy5wdXNoKHsgdXJsOiByLnVybCwgZXJyb3I6IHIuZXJyb3IsIG1vZGU6IHIubW9kZSB9KTtcclxuICAgICAgY29udGludWU7XHJcbiAgICB9XHJcbiAgICBcclxuICAgIGlmIChyLm1vZGUgPT09ICdzbG93Jykge1xyXG4gICAgICBzbG93U3VjY2Vzc0ZlZWRzLnB1c2goeyB1cmw6IHIudXJsLCBpdGVtc0ZvdW5kOiByLml0ZW1zLmxlbmd0aCB9KTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIGZhc3RTdWNjZXNzQ291bnQrKztcclxuICAgIH1cclxuXHJcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2Ygci5pdGVtcykge1xyXG4gICAgICB0cnkgeyBcclxuICAgICAgICBpZiAoYXdhaXQgaW5kZXhFbnRyeShpdGVtLCBzZXR0aW5ncykpIGFkZGVkKys7IFxyXG4gICAgICB9IGNhdGNoIChlKSB7IFxyXG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXCJpbmRleCBlcnJvcjpcIiwgZS5tZXNzYWdlKTsgXHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcbiAgXHJcbiAgcmV0dXJuIHsgXHJcbiAgICBhZGRlZCwgXHJcbiAgICB0b3RhbFRpbWVTZWNvbmRzOiB0b3RhbFRpbWUsXHJcbiAgICBmYXN0TW9kZTogeyBzdWNjZXNzOiBmYXN0U3VjY2Vzc0NvdW50LCBmYWlsZWQ6IGZhaWxlZEZlZWRzLmZpbHRlcihmID0+IGYubW9kZSA9PT0gJ2Zhc3QnKS5sZW5ndGggfSxcclxuICAgIHNsb3dNb2RlOiB7IHN1Y2Nlc3M6IHNsb3dTdWNjZXNzRmVlZHMubGVuZ3RoLCBmYWlsZWQ6IGZhaWxlZEZlZWRzLmZpbHRlcihmID0+IGYubW9kZSA9PT0gJ3Nsb3cnKS5sZW5ndGgsIGRldGFpbHM6IHNsb3dTdWNjZXNzRmVlZHMgfSxcclxuICAgIGZhaWxlZEZlZWRzOiBmYWlsZWRGZWVkcy5tYXAoZiA9PiAoeyB1cmw6IGYudXJsLCBlcnJvcjogZi5lcnJvciB9KSlcclxuICB9O1xyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmV0cmlldmUocXVlcnksIHNldHRpbmdzKSB7XHJcbiAgY29uc3QgZGIgPSBnZXREYigpO1xyXG4gIFxyXG4gIGxldCBxVmVjID0gbnVsbDtcclxuICB0cnkge1xyXG4gICAgW3FWZWNdID0gYXdhaXQgZW1iZWQoW3F1ZXJ5XSwgeyBiYXNlVXJsOiBzZXR0aW5ncy5sbVN0dWRpb0Jhc2VVcmwsIG1vZGVsOiBzZXR0aW5ncy5lbWJlZGRpbmdNb2RlbCB9KTtcclxuICB9IGNhdGNoIChlKSB7XHJcbiAgICBjb25zb2xlLmVycm9yKFwiW3Jzcy1yYWddIFF1ZXJ5IGVtYmVkZGluZyBmYWlsZWQsIHVzaW5nIGtleXdvcmQgc2VhcmNoIG9ubHk6XCIsIGUubWVzc2FnZSk7XHJcbiAgfVxyXG5cclxuICBjb25zdCBmdHMgPSBkYi5wcmVwYXJlKGBcclxuICAgIFNFTEVDVCBjLmlkIEFTIGNpZCwgYy50ZXh0LCBjLmVudHJ5X2lkXHJcbiAgICBGUk9NIGNodW5rc19mdHMgZlxyXG4gICAgSk9JTiBjaHVua3MgYyBPTiBjLmlkID0gZi5yb3dpZFxyXG4gICAgV0hFUkUgY2h1bmtzX2Z0cyBNQVRDSCA/XHJcbiAgICBPUkRFUiBCWSByYW5rXHJcbiAgICBMSU1JVCA0MFxyXG4gIGApLmFsbChxdWVyeS5yZXBsYWNlKC9bXCInKl0vZywgXCIgXCIpLnRyaW0oKSB8fCBcImFcIik7XHJcblxyXG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0KCk7XHJcbiAgY29uc3QgY2FuZGlkYXRlcyA9IFtdO1xyXG4gIGZvciAoY29uc3Qgcm93IG9mIGZ0cykge1xyXG4gICAgaWYgKHNlZW4uaGFzKHJvdy5jaWQpKSBjb250aW51ZTtcclxuICAgIHNlZW4uYWRkKHJvdy5jaWQpO1xyXG4gICAgY2FuZGlkYXRlcy5wdXNoKHJvdyk7XHJcbiAgfVxyXG5cclxuICBjb25zdCBzY29yZWQgPSBbXTtcclxuICBmb3IgKGNvbnN0IHJvdyBvZiBjYW5kaWRhdGVzKSB7XHJcbiAgICBjb25zdCByID0gZGIucHJlcGFyZShgU0VMRUNUIGVtYmVkZGluZyBGUk9NIGNodW5rcyBXSEVSRSBpZCA9ID9gKS5nZXQocm93LmNpZCk7XHJcbiAgICBpZiAocj8uZW1iZWRkaW5nICYmIHFWZWMpIHtcclxuICAgICAgY29uc3QgdiA9IGJ1ZmZlclRvRmxvYXQzMihyLmVtYmVkZGluZyk7XHJcbiAgICAgIHNjb3JlZC5wdXNoKHsgY2lkOiByb3cuY2lkLCBlbnRyeUlkOiByb3cuZW50cnlfaWQsIHRleHQ6IHJvdy50ZXh0LCBzY29yZTogY29zaW5lKHFWZWMsIHYpIH0pO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgc2NvcmVkLnB1c2goeyBjaWQ6IHJvdy5jaWQsIGVudHJ5SWQ6IHJvdy5lbnRyeV9pZCwgdGV4dDogcm93LnRleHQsIHNjb3JlOiAwLjUgfSk7XHJcbiAgICB9XHJcbiAgfVxyXG4gIHNjb3JlZC5zb3J0KChhLCBiKSA9PiBiLnNjb3JlIC0gYS5zY29yZSk7XHJcblxyXG4gIC8vIEdldCB0b3AgMyB1bmlxdWUgZW50cmllc1xyXG4gIGNvbnN0IHRvcEVudHJ5SWRzID0gWy4uLm5ldyBTZXQoc2NvcmVkLm1hcChzID0+IHMuZW50cnlJZCkpXS5zbGljZSgwLCAzKTtcclxuICBcclxuICBpZiAoIXRvcEVudHJ5SWRzLmxlbmd0aCkge1xyXG4gICAgLy8gRmFsbGJhY2sgdG8gZW50cmllcyBpZiBjaHVua3MgZmFpbFxyXG4gICAgY29uc3QgZW50cmllc0Z0cyA9IGRiLnByZXBhcmUoYFxyXG4gICAgICBTRUxFQ1QgaWQsIHRpdGxlLCBzdW1tYXJ5LCBjb250ZW50LCBsaW5rLCBwdWJfZGF0ZSwgZmVlZF91cmxcclxuICAgICAgRlJPTSBlbnRyaWVzXHJcbiAgICAgIFdIRVJFIHRpdGxlIExJS0UgPyBPUiBzdW1tYXJ5IExJS0UgPyBPUiBjb250ZW50IExJS0UgP1xyXG4gICAgICBPUkRFUiBCWSBwdWJfZGF0ZSBERVNDXHJcbiAgICAgIExJTUlUIDVcclxuICAgIGApLmFsbChgJSR7cXVlcnl9JWAsIGAlJHtxdWVyeX0lYCwgYCUke3F1ZXJ5fSVgKTtcclxuICAgIFxyXG4gICAgcmV0dXJuIGVudHJpZXNGdHMubWFwKChtKSA9PiAoe1xyXG4gICAgICB0aXRsZTogbS50aXRsZSxcclxuICAgICAgbGluazogbS5saW5rLFxyXG4gICAgICBwdWJfZGF0ZTogbS5wdWJfZGF0ZSwgLy8gRml4ZWQgYnVnIVxyXG4gICAgICBwdWJfZGF0ZV9pc286IG5ldyBEYXRlKG0ucHViX2RhdGUpLnRvSVNPU3RyaW5nKCksXHJcbiAgICAgIGZlZWQ6IG0uZmVlZF91cmwsXHJcbiAgICAgIHRleHQ6IChtLmNvbnRlbnQgfHwgbS5zdW1tYXJ5IHx8IFwiXCIpLnNsaWNlKDAsIDQwMDApIC8vIFJldHVybiB1cCB0byA0MDAwIGNoYXJzIVxyXG4gICAgfSkpO1xyXG4gIH1cclxuXHJcbiAgY29uc3QgbWV0YSA9IGRiLnByZXBhcmUoYFNFTEVDVCBpZCwgdGl0bGUsIGxpbmssIGF1dGhvciwgcHViX2RhdGUsIGZlZWRfdXJsLCBjb250ZW50LCBzdW1tYXJ5IEZST00gZW50cmllcyBXSEVSRSBpZCA9ID9gKTtcclxuICByZXR1cm4gdG9wRW50cnlJZHMubWFwKChlbnRyeUlkKSA9PiB7XHJcbiAgICBjb25zdCBtID0gbWV0YS5nZXQoZW50cnlJZCk7XHJcbiAgICByZXR1cm4geyBcclxuICAgICAgdGl0bGU6IG0udGl0bGUsIFxyXG4gICAgICBsaW5rOiBtLmxpbmssIFxyXG4gICAgICBhdXRob3I6IG0uYXV0aG9yLFxyXG4gICAgICBwdWJfZGF0ZTogbS5wdWJfZGF0ZSwgLy8gRml4ZWQgYnVnIVxyXG4gICAgICBwdWJfZGF0ZV9pc286IG5ldyBEYXRlKG0ucHViX2RhdGUpLnRvSVNPU3RyaW5nKCksIFxyXG4gICAgICBmZWVkOiBtLmZlZWRfdXJsLFxyXG4gICAgICB0ZXh0OiAobS5jb250ZW50IHx8IG0uc3VtbWFyeSB8fCBcIlwiKS5zbGljZSgwLCA0MDAwKSAvLyBSZXR1cm4gdXAgdG8gNDAwMCBjaGFycyFcclxuICAgIH07XHJcbiAgfSk7XHJcbn0iLCAiaW1wb3J0IHsgdG9vbCB9IGZyb20gXCJAbG1zdHVkaW8vc2RrXCI7XHJcbmltcG9ydCB7IHogfSBmcm9tIFwiem9kXCI7XHJcbmltcG9ydCB7IGdldERiIH0gZnJvbSBcIi4uL2xpYi9kYi5qc1wiO1xyXG5pbXBvcnQgeyBydW5SZXRlbnRpb24gfSBmcm9tIFwiLi4vbGliL3JldGVudGlvbi5qc1wiO1xyXG5pbXBvcnQgeyByZWZyZXNoRmVlZHMsIHJldHJpZXZlIH0gZnJvbSBcIi4uL2xpYi9yZXRyaWV2ZXIuanNcIjtcclxuaW1wb3J0IHsgbG9hZFNldHRpbmdzLCBsb2FkRmVlZHMgfSBmcm9tIFwiLi4vbGliL2NvbmZpZy5qc1wiO1xyXG5cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHRvb2xzUHJvdmlkZXIoX2N0bDogYW55KSB7XHJcbiAgcmV0dXJuIFtcclxuICAgIHRvb2woe1xyXG4gICAgICBuYW1lOiBcInNlYXJjaF9yc3NfY2FjaGVcIixcclxuICAgICAgZGVzY3JpcHRpb246IFwiU2VtYW50aWMgc2VhcmNoIG92ZXIgdGhlIGxvY2FsIFJTUyBSQUcgY2FjaGUuXCIsXHJcbiAgICAgIHBhcmFtZXRlcnM6IHtcclxuICAgICAgICBxdWVyeTogei5zdHJpbmcoKSxcclxuICAgICAgICBkYXlzOiB6Lm51bWJlcigpLm9wdGlvbmFsKClcclxuICAgICAgfSxcclxuICAgICAgaW1wbGVtZW50YXRpb246IGFzeW5jICh7IHF1ZXJ5LCBkYXlzIH06IHsgcXVlcnk6IHN0cmluZzsgZGF5cz86IG51bWJlciB9KSA9PiB7XHJcbiAgICAgICAgY29uc3QgcyA9IGxvYWRTZXR0aW5ncygpO1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCByZXRyaWV2ZShxdWVyeSwgcyk7XHJcbiAgICAgICAgY29uc3QgY3V0b2ZmID0gZGF5cyA/IERhdGUubm93KCkgLSBkYXlzICogODY0MDAgKiAxMDAwIDogMDtcclxuICAgICAgICBjb25zdCBmaWx0ZXJlZCA9IHJlc3VsdHMuZmlsdGVyKChyOiBhbnkpID0+IHIucHViX2RhdGUgPj0gY3V0b2ZmKTtcclxuICAgICAgICBcclxuICAgICAgICBpZiAoIWZpbHRlcmVkLmxlbmd0aCkgcmV0dXJuIHsgY291bnQ6IDAsIHJlc3VsdHM6IFtdLCBub3RlOiBcIk5vIG1hdGNoZXMuXCIgfTtcclxuICAgICAgICBcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgY291bnQ6IGZpbHRlcmVkLmxlbmd0aCxcclxuICAgICAgICAgIHJlc3VsdHM6IGZpbHRlcmVkLm1hcCgocjogYW55KSA9PiAoe1xyXG4gICAgICAgICAgICB0aXRsZTogci50aXRsZSxcclxuICAgICAgICAgICAgbGluazogci5saW5rLFxyXG4gICAgICAgICAgICBkYXRlOiByLnB1Yl9kYXRlX2lzbyxcclxuICAgICAgICAgICAgc25pcHBldDogci50ZXh0LnNsaWNlKDAsIDYwMCksXHJcbiAgICAgICAgICB9KSksXHJcbiAgICAgICAgfTtcclxuICAgICAgfVxyXG4gICAgfSksXHJcbiAgICAgICAgdG9vbCh7XHJcbiAgICAgIG5hbWU6IFwicmVmcmVzaF9yc3NfZmVlZHNcIixcclxuICAgICAgZGVzY3JpcHRpb246IFwiRm9yY2UtcmVmcmVzaCBhbGwgUlNTIGZlZWRzIGxpc3RlZCBpbiBmZWVkcy50eHQuXCIsXHJcbiAgICAgIHBhcmFtZXRlcnM6IHt9LFxyXG4gICAgICBpbXBsZW1lbnRhdGlvbjogYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHMgPSBsb2FkU2V0dGluZ3MoKTtcclxuICAgICAgICBjb25zdCBmZWVkcyA9IGxvYWRGZWVkcyhzKTtcclxuICAgICAgICBjb25zdCByZXMgPSBhd2FpdCByZWZyZXNoRmVlZHMocywgZmVlZHMpO1xyXG4gICAgICAgIGNvbnN0IHJldCA9IHJ1blJldGVudGlvbihzLnJldGVudGlvbkRheXMpO1xyXG4gICAgICAgIHJldHVybiB7IFxyXG4gICAgICAgICAgZmVlZHM6IGZlZWRzLmxlbmd0aCwgXHJcbiAgICAgICAgICBhZGRlZDogcmVzLmFkZGVkLCBcclxuICAgICAgICAgIGZhaWxlZENvdW50OiByZXMuZmFpbGVkLFxyXG4gICAgICAgICAgZmFpbGVkRmVlZHM6IHJlcy5mYWlsZWRGZWVkcywgXHJcbiAgICAgICAgICByZXRlbnRpb246IHJldCBcclxuICAgICAgICB9O1xyXG4gICAgICB9XHJcbiAgICB9KSxcclxuICAgIHRvb2woe1xyXG4gICAgICBuYW1lOiBcImxpc3RfcnNzX2ZlZWRzXCIsXHJcbiAgICAgIGRlc2NyaXB0aW9uOiBcIkxpc3QgdGhlIFJTUy9BdG9tIGZlZWRzIGN1cnJlbnRseSBjb25maWd1cmVkLlwiLFxyXG4gICAgICBwYXJhbWV0ZXJzOiB7fSxcclxuICAgICAgaW1wbGVtZW50YXRpb246IGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBzID0gbG9hZFNldHRpbmdzKCk7XHJcbiAgICAgICAgY29uc3QgZmVlZHMgPSBsb2FkRmVlZHMocyk7XHJcbiAgICAgICAgY29uc3QgZGIgPSBnZXREYigpO1xyXG4gICAgICAgIGNvbnN0IHN0YXRzID0gZGIucHJlcGFyZShgU0VMRUNUIChTRUxFQ1QgQ09VTlQoKikgRlJPTSBlbnRyaWVzKSBhcyBlbnRyaWVzLCAoU0VMRUNUIENPVU5UKCopIEZST00gY2h1bmtzKSBhcyBjaHVua3NgKS5nZXQoKSBhcyBhbnk7XHJcbiAgICAgICAgcmV0dXJuIHsgZmVlZHMsIGVudHJpZXM6IHN0YXRzLmVudHJpZXMsIGNodW5rczogc3RhdHMuY2h1bmtzIH07XHJcbiAgICAgIH1cclxuICAgIH0pLCAvLyA8LS0gVEhJUyBXQVMgTUlTU0lORyFcclxuICAgIHRvb2woe1xyXG4gICAgICBuYW1lOiBcImdldF9yZWNlbnRfY2FjaGVfYXJ0aWNsZXNcIixcclxuICAgICAgZGVzY3JpcHRpb246IFwiR2V0IHRoZSBtb3N0IHJlY2VudCBhcnRpY2xlcyBhZGRlZCB0byB0aGUgY2FjaGUuIFVzZSB0aGlzIHRvIHNlZSB3aGF0IG5ld3MgaXMgYXZhaWxhYmxlIG9yIHRvIHN1bW1hcml6ZSByZWNlbnQgZXZlbnRzIHdpdGhvdXQgZ3Vlc3Npbmcgc2VhcmNoIGtleXdvcmRzLlwiLFxyXG4gICAgICBwYXJhbWV0ZXJzOiB7XHJcbiAgICAgICAgbGltaXQ6IHoubnVtYmVyKCkub3B0aW9uYWwoKVxyXG4gICAgICB9LFxyXG4gICAgICBpbXBsZW1lbnRhdGlvbjogYXN5bmMgKHsgbGltaXQgfTogeyBsaW1pdD86IG51bWJlciB9KSA9PiB7XHJcbiAgICAgICAgY29uc3QgZGIgPSBnZXREYigpO1xyXG4gICAgICAgIGNvbnN0IGxpbSA9IGxpbWl0IHx8IDIwO1xyXG4gICAgICAgIGNvbnN0IGFydGljbGVzID0gZGIucHJlcGFyZShgU0VMRUNUIHRpdGxlLCBsaW5rLCBwdWJfZGF0ZSwgZmVlZF91cmwgRlJPTSBlbnRyaWVzIE9SREVSIEJZIHB1Yl9kYXRlIERFU0MgTElNSVQgP2ApLmFsbChsaW0pO1xyXG4gICAgICAgIHJldHVybiB7IFxyXG4gICAgICAgICAgY291bnQ6IGFydGljbGVzLmxlbmd0aCwgXHJcbiAgICAgICAgICBhcnRpY2xlczogYXJ0aWNsZXMubWFwKChhOiBhbnkpID0+ICh7IFxyXG4gICAgICAgICAgICB0aXRsZTogYS50aXRsZSwgXHJcbiAgICAgICAgICAgIGxpbms6IGEubGluaywgXHJcbiAgICAgICAgICAgIGRhdGU6IG5ldyBEYXRlKGEucHViX2RhdGUpLnRvSVNPU3RyaW5nKCksIFxyXG4gICAgICAgICAgICBmZWVkOiBhLmZlZWRfdXJsIFxyXG4gICAgICAgICAgfSkpIFxyXG4gICAgICAgIH07XHJcbiAgICAgIH1cclxuICAgIH0pXHJcblx0ICBdOyAvLyA8LS0tIEFERCBUSElTXHJcbn0gICAgIC8vIDwtLS0gQU5EIFRISVMiLCAiLy8gU3VwcHJlc3MgTm9kZS5qcyBleHBlcmltZW50YWwgd2FybmluZ3MgYmVmb3JlIGFueXRoaW5nIGVsc2UgbG9hZHNcclxuaWYgKHR5cGVvZiBwcm9jZXNzICE9PSAndW5kZWZpbmVkJyAmJiBwcm9jZXNzLnJlbW92ZUFsbExpc3RlbmVycykge1xyXG4gIHByb2Nlc3MucmVtb3ZlQWxsTGlzdGVuZXJzKCd3YXJuaW5nJyk7XHJcbn1cclxuXHJcbmltcG9ydCB7IFBsdWdpbkNvbnRleHQgfSBmcm9tIFwiQGxtc3R1ZGlvL3Nka1wiO1xyXG5pbXBvcnQgeyBjb25maWdTY2hlbWF0aWNzIH0gZnJvbSBcIi4vY29uZmlnXCI7XHJcbmltcG9ydCB7IHRvb2xzUHJvdmlkZXIgfSBmcm9tIFwiLi90b29sc1Byb3ZpZGVyXCI7XHJcbmltcG9ydCB7IGxvYWRTZXR0aW5ncywgbG9hZEZlZWRzIH0gZnJvbSBcIi4uL2xpYi9jb25maWcuanNcIjtcclxuaW1wb3J0IHsgZ2V0RGIgfSBmcm9tIFwiLi4vbGliL2RiLmpzXCI7XHJcbmltcG9ydCB7IHJ1blJldGVudGlvbiwgZ2V0TGFzdFJlZnJlc2ggfSBmcm9tIFwiLi4vbGliL3JldGVudGlvbi5qc1wiO1xyXG5pbXBvcnQgeyByZWZyZXNoRmVlZHMgfSBmcm9tIFwiLi4vbGliL3JldHJpZXZlci5qc1wiO1xyXG5cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4oY29udGV4dDogUGx1Z2luQ29udGV4dCk6IFByb21pc2U8dm9pZD4ge1xyXG4gIC8vIFJlZ2lzdGVyIFVJIHNldHRpbmdzIGFuZCB0b29sc1xyXG4gIGNvbnRleHQud2l0aENvbmZpZ1NjaGVtYXRpY3MoY29uZmlnU2NoZW1hdGljcyk7XHJcbiAgY29udGV4dC53aXRoVG9vbHNQcm92aWRlcih0b29sc1Byb3ZpZGVyKTtcclxuXHJcbiAgLy8gSW5pdGlhbGl6ZSBEQlxyXG4gIGdldERiKCk7XHJcblxyXG4gIC8vIEF1dG8tcmVmcmVzaCB0aW1lclxyXG4gIGFzeW5jIGZ1bmN0aW9uIG1heWJlQXV0b1JlZnJlc2goKSB7XHJcbiAgICBjb25zdCBzID0gbG9hZFNldHRpbmdzKCk7XHJcbiAgICBjb25zdCBsYXN0ID0gZ2V0TGFzdFJlZnJlc2goKTtcclxuICAgIGNvbnN0IGR1ZSA9IERhdGUubm93KCkgLSBsYXN0ID4gcy5yZWZyZXNoSW50ZXJ2YWxIb3VycyAqIDM2MDAgKiAxMDAwO1xyXG4gICAgaWYgKGR1ZSkge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IGZlZWRzID0gbG9hZEZlZWRzKHMpO1xyXG4gICAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IHJlZnJlc2hGZWVkcyhzLCBmZWVkcyk7XHJcbiAgICAgICAgcnVuUmV0ZW50aW9uKHMucmV0ZW50aW9uRGF5cyk7XHJcbiAgICAgICAgY29uc29sZS5sb2coXCJbcnNzLXJhZ10gYXV0by1yZWZyZXNoIGNvbXBsZXRlOlwiLCByZXMpO1xyXG4gICAgICB9IGNhdGNoIChlKSB7XHJcbiAgICAgICAgY29uc29sZS5lcnJvcihcIltyc3MtcmFnXSBhdXRvLXJlZnJlc2ggZXJyb3I6XCIsIChlIGFzIEVycm9yKS5tZXNzYWdlKTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLy8gUnVuIG9uY2Ugb24gc3RhcnR1cCwgdGhlbiBjaGVjayBldmVyeSBob3VyXHJcbiAgbWF5YmVBdXRvUmVmcmVzaCgpO1xyXG4gIHNldEludGVydmFsKG1heWJlQXV0b1JlZnJlc2gsIDM2MDAwMDApOyBcclxufSIsICJpbXBvcnQgeyBMTVN0dWRpb0NsaWVudCwgdHlwZSBQbHVnaW5Db250ZXh0IH0gZnJvbSBcIkBsbXN0dWRpby9zZGtcIjtcblxuZGVjbGFyZSB2YXIgcHJvY2VzczogYW55O1xuXG4vLyBXZSByZWNlaXZlIHJ1bnRpbWUgaW5mb3JtYXRpb24gaW4gdGhlIGVudmlyb25tZW50IHZhcmlhYmxlcy5cbmNvbnN0IGNsaWVudElkZW50aWZpZXIgPSBwcm9jZXNzLmVudi5MTVNfUExVR0lOX0NMSUVOVF9JREVOVElGSUVSO1xuY29uc3QgY2xpZW50UGFzc2tleSA9IHByb2Nlc3MuZW52LkxNU19QTFVHSU5fQ0xJRU5UX1BBU1NLRVk7XG5jb25zdCBiYXNlVXJsID0gcHJvY2Vzcy5lbnYuTE1TX1BMVUdJTl9CQVNFX1VSTDtcblxuY29uc3QgY2xpZW50ID0gbmV3IExNU3R1ZGlvQ2xpZW50KHtcbiAgY2xpZW50SWRlbnRpZmllcixcbiAgY2xpZW50UGFzc2tleSxcbiAgYmFzZVVybCxcbn0pO1xuXG4oZ2xvYmFsVGhpcyBhcyBhbnkpLl9fTE1TX1BMVUdJTl9DT05URVhUID0gdHJ1ZTtcblxubGV0IHByZWRpY3Rpb25Mb29wSGFuZGxlclNldCA9IGZhbHNlO1xubGV0IHByb21wdFByZXByb2Nlc3NvclNldCA9IGZhbHNlO1xubGV0IGNvbmZpZ1NjaGVtYXRpY3NTZXQgPSBmYWxzZTtcbmxldCBnbG9iYWxDb25maWdTY2hlbWF0aWNzU2V0ID0gZmFsc2U7XG5sZXQgdG9vbHNQcm92aWRlclNldCA9IGZhbHNlO1xubGV0IGdlbmVyYXRvclNldCA9IGZhbHNlO1xuXG5jb25zdCBzZWxmUmVnaXN0cmF0aW9uSG9zdCA9IGNsaWVudC5wbHVnaW5zLmdldFNlbGZSZWdpc3RyYXRpb25Ib3N0KCk7XG5cbmNvbnN0IHBsdWdpbkNvbnRleHQ6IFBsdWdpbkNvbnRleHQgPSB7XG4gIHdpdGhQcmVkaWN0aW9uTG9vcEhhbmRsZXI6IChnZW5lcmF0ZSkgPT4ge1xuICAgIGlmIChwcmVkaWN0aW9uTG9vcEhhbmRsZXJTZXQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIlByZWRpY3Rpb25Mb29wSGFuZGxlciBhbHJlYWR5IHJlZ2lzdGVyZWRcIik7XG4gICAgfVxuICAgIGlmICh0b29sc1Byb3ZpZGVyU2V0KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJQcmVkaWN0aW9uTG9vcEhhbmRsZXIgY2Fubm90IGJlIHVzZWQgd2l0aCBhIHRvb2xzIHByb3ZpZGVyXCIpO1xuICAgIH1cblxuICAgIHByZWRpY3Rpb25Mb29wSGFuZGxlclNldCA9IHRydWU7XG4gICAgc2VsZlJlZ2lzdHJhdGlvbkhvc3Quc2V0UHJlZGljdGlvbkxvb3BIYW5kbGVyKGdlbmVyYXRlKTtcbiAgICByZXR1cm4gcGx1Z2luQ29udGV4dDtcbiAgfSxcbiAgd2l0aFByb21wdFByZXByb2Nlc3NvcjogKHByZXByb2Nlc3MpID0+IHtcbiAgICBpZiAocHJvbXB0UHJlcHJvY2Vzc29yU2V0KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJQcm9tcHRQcmVwcm9jZXNzb3IgYWxyZWFkeSByZWdpc3RlcmVkXCIpO1xuICAgIH1cbiAgICBwcm9tcHRQcmVwcm9jZXNzb3JTZXQgPSB0cnVlO1xuICAgIHNlbGZSZWdpc3RyYXRpb25Ib3N0LnNldFByb21wdFByZXByb2Nlc3NvcihwcmVwcm9jZXNzKTtcbiAgICByZXR1cm4gcGx1Z2luQ29udGV4dDtcbiAgfSxcbiAgd2l0aENvbmZpZ1NjaGVtYXRpY3M6IChjb25maWdTY2hlbWF0aWNzKSA9PiB7XG4gICAgaWYgKGNvbmZpZ1NjaGVtYXRpY3NTZXQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkNvbmZpZyBzY2hlbWF0aWNzIGFscmVhZHkgcmVnaXN0ZXJlZFwiKTtcbiAgICB9XG4gICAgY29uZmlnU2NoZW1hdGljc1NldCA9IHRydWU7XG4gICAgc2VsZlJlZ2lzdHJhdGlvbkhvc3Quc2V0Q29uZmlnU2NoZW1hdGljcyhjb25maWdTY2hlbWF0aWNzKTtcbiAgICByZXR1cm4gcGx1Z2luQ29udGV4dDtcbiAgfSxcbiAgd2l0aEdsb2JhbENvbmZpZ1NjaGVtYXRpY3M6IChnbG9iYWxDb25maWdTY2hlbWF0aWNzKSA9PiB7XG4gICAgaWYgKGdsb2JhbENvbmZpZ1NjaGVtYXRpY3NTZXQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkdsb2JhbCBjb25maWcgc2NoZW1hdGljcyBhbHJlYWR5IHJlZ2lzdGVyZWRcIik7XG4gICAgfVxuICAgIGdsb2JhbENvbmZpZ1NjaGVtYXRpY3NTZXQgPSB0cnVlO1xuICAgIHNlbGZSZWdpc3RyYXRpb25Ib3N0LnNldEdsb2JhbENvbmZpZ1NjaGVtYXRpY3MoZ2xvYmFsQ29uZmlnU2NoZW1hdGljcyk7XG4gICAgcmV0dXJuIHBsdWdpbkNvbnRleHQ7XG4gIH0sXG4gIHdpdGhUb29sc1Byb3ZpZGVyOiAodG9vbHNQcm92aWRlcikgPT4ge1xuICAgIGlmICh0b29sc1Byb3ZpZGVyU2V0KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJUb29scyBwcm92aWRlciBhbHJlYWR5IHJlZ2lzdGVyZWRcIik7XG4gICAgfVxuICAgIGlmIChwcmVkaWN0aW9uTG9vcEhhbmRsZXJTZXQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIlRvb2xzIHByb3ZpZGVyIGNhbm5vdCBiZSB1c2VkIHdpdGggYSBwcmVkaWN0aW9uTG9vcEhhbmRsZXJcIik7XG4gICAgfVxuXG4gICAgdG9vbHNQcm92aWRlclNldCA9IHRydWU7XG4gICAgc2VsZlJlZ2lzdHJhdGlvbkhvc3Quc2V0VG9vbHNQcm92aWRlcih0b29sc1Byb3ZpZGVyKTtcbiAgICByZXR1cm4gcGx1Z2luQ29udGV4dDtcbiAgfSxcbiAgd2l0aEdlbmVyYXRvcjogKGdlbmVyYXRvcikgPT4ge1xuICAgIGlmIChnZW5lcmF0b3JTZXQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkdlbmVyYXRvciBhbHJlYWR5IHJlZ2lzdGVyZWRcIik7XG4gICAgfVxuXG4gICAgZ2VuZXJhdG9yU2V0ID0gdHJ1ZTtcbiAgICBzZWxmUmVnaXN0cmF0aW9uSG9zdC5zZXRHZW5lcmF0b3IoZ2VuZXJhdG9yKTtcbiAgICByZXR1cm4gcGx1Z2luQ29udGV4dDtcbiAgfSxcbn07XG5cbmltcG9ydChcIi4vLi4vc3JjL2luZGV4LnRzXCIpLnRoZW4oYXN5bmMgbW9kdWxlID0+IHtcbiAgcmV0dXJuIGF3YWl0IG1vZHVsZS5tYWluKHBsdWdpbkNvbnRleHQpO1xufSkudGhlbigoKSA9PiB7XG4gIHNlbGZSZWdpc3RyYXRpb25Ib3N0LmluaXRDb21wbGV0ZWQoKTtcbn0pLmNhdGNoKChlcnJvcikgPT4ge1xuICBjb25zb2xlLmVycm9yKFwiRmFpbGVkIHRvIGV4ZWN1dGUgdGhlIG1haW4gZnVuY3Rpb24gb2YgdGhlIHBsdWdpbi5cIik7XG4gIGNvbnNvbGUuZXJyb3IoZXJyb3IpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsZ0JBRWE7QUFGYjtBQUFBO0FBQUEsaUJBQXVDO0FBRWhDLElBQU0sdUJBQW1CLG1DQUF1QixFQUNwRDtBQUFBLE1BQ0M7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLFFBQ0UsYUFBYTtBQUFBLFFBQ2IsVUFBVTtBQUFBLFFBQ1YsU0FBUztBQUFBLFVBQ1AsRUFBRSxPQUFPLE1BQU0sYUFBYSxV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Q25ELFdBQU87QUFBQSxFQUNUO0FBQUEsRUFDQSxlQUFlLENBQUMsY0FBYztBQUM1QixRQUFJLGNBQWM7QUFDaEIsWUFBTSxJQUFJLE1BQU0sOEJBQThCO0FBQUEsSUFDaEQ7QUFFQSxtQkFBZTtBQUNmLHlCQUFxQixhQUFhLFNBQVM7QUFDM0MsV0FBTztBQUFBLEVBQ1Q7QUFDRjtBQUVBLHdEQUE0QixLQUFLLE9BQU1DLFlBQVU7QUFDL0MsU0FBTyxNQUFNQSxRQUFPLEtBQUssYUFBYTtBQUN4QyxDQUFDLEVBQUUsS0FBSyxNQUFNO0FBQ1osdUJBQXFCLGNBQWM7QUFDckMsQ0FBQyxFQUFFLE1BQU0sQ0FBQyxVQUFVO0FBQ2xCLFVBQVEsTUFBTSxvREFBb0Q7QUFDbEUsVUFBUSxNQUFNLEtBQUs7QUFDckIsQ0FBQzsiLAogICJuYW1lcyI6IFsiaW5pdF9jb25maWciLCAiaW1wb3J0X25vZGVfZnMiLCAiaW1wb3J0X25vZGVfcGF0aCIsICJpbml0X2NvbmZpZyIsICJkYiIsICJiYXNlVXJsIiwgImRiIiwgImZldGNoQWxsIiwgImRiIiwgImltcG9ydF9zZGsiLCAiaW5pdF9jb25maWciLCAiaW5pdF9jb25maWciLCAiaW1wb3J0X3NkayIsICJjb25maWdTY2hlbWF0aWNzIiwgInRvb2xzUHJvdmlkZXIiLCAibW9kdWxlIl0KfQo=
