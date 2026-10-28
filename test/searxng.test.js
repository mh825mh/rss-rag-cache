import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

// Isolated data directory *before* importing config-touching modules.
const dataDir = mkdtempSync(join(tmpdir(), "rss-rag-searx-test-"));
process.env.RSS_RAG_DATA_DIR = dataDir;

const {
  buildQueryFeedUrl,
  isQueryFeedUrl,
  queryFromFeedUrl,
  searxSearch,
  webSearchDigest,
  backfillFromWeb,
  WEB_FEED_URL,
  clearSearxCache,
} = await import("../lib/searxng.js");
const { normalizeSettings, getDbPath } = await import("../lib/config.js");
const { getDb, closeDb } = await import("../lib/db.js");
const { runRetention, pruneRemovedFeeds } = await import("../lib/retention.js");

// Deterministic 8-dim unit embeddings (same trick as rss-rag.test.js).
function vecFor(text) {
  const v = new Array(8).fill(0);
  for (let i = 0; i < text.length; i++) v[i % 8] += text.charCodeAt(i) + 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

let embedServer;
let embedBase;
let searxServer;
let searxBase;
let articleServer;
let articleBase;
let searxHits = 0;
let jsonEnabled = true;

before(async () => {
  embedServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* ignore */ }
      const input = Array.isArray(payload.input) ? payload.input : [payload.input];
      const data = input.map((text, i) => ({ index: i, embedding: vecFor(String(text)) }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise((r) => embedServer.listen(0, "127.0.0.1", r));
  embedBase = `http://127.0.0.1:${embedServer.address().port}`;

  searxServer = http.createServer((req, res) => {
    searxHits++;
    const url = new URL(req.url, "http://x");
    const fmt = url.searchParams.get("format");
    const q = url.searchParams.get("q") || "";
    if (fmt === "rss") {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end('<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><item><title>r1</title></item></channel></rss>');
      return;
    }
    if (!jsonEnabled) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Format not allowed");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      results: [
        { title: `A about ${q}`, url: `${articleBase}/dup`, content: "dup dup dup" },
        { title: `B about ${q}`, url: `${articleBase}/page`, content: "extractable article" },
        { title: `B again`, url: `${articleBase}/page`, content: "same url dedupe" },
        { title: `C about ${q}`, url: `${articleBase}/np`, content: "news dive" },
        { title: `D about ${q}`, url: `${articleBase}/np`, content: "same-host cap reached" },
      ],
    }));
  });
  await new Promise((r) => searxServer.listen(0, "127.0.0.1", r));
  searxBase = `http://127.0.0.1:${searxServer.address().port}`;

  articleServer = http.createServer((req, res) => {
    if (req.url.startsWith("/page")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<html><body><article><h1>Quantum Leap</h1>` +
        `<p>${"quantum breakthrough ".repeat(60)}</p>` +
        `<p>${"second paragraph reading club ".repeat(60)}</p></article></body></html>`,
      );
      return;
    }
    if (req.url.startsWith("/np")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body><p>too short</p></body></html>`);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>dup page</body></html>");
  });
  await new Promise((r) => articleServer.listen(0, "127.0.0.1", r));
  articleBase = `http://127.0.0.1:${articleServer.address().port}`;
});

after(() => {
  for (const s of [embedServer, searxServer, articleServer]) {
    try { s?.close(); } catch { /* ignore */ }
  }
  closeDb();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows may still hold the WAL file briefly. */
  }
});

const testSettings = (over = {}) =>
  normalizeSettings({
    lmStudioBaseUrl: embedBase,
    embeddingModel: "test-embed",
    embedBatchSize: 4,
    searxngBaseUrl: searxBase,
    ...over,
  });

test("buildQueryFeedUrl renders the RSS representation of a query", () => {
  const u = new URL(buildQueryFeedUrl("http://localhost:8080/", "quantum computing", { categories: "news", language: "en", timeRange: "day" }));
  assert.equal(u.origin + u.pathname, "http://localhost:8080/search");
  assert.equal(u.searchParams.get("format"), "rss");
  assert.equal(u.searchParams.get("q"), "quantum computing");
  assert.equal(u.searchParams.get("categories"), "news");
  assert.equal(u.searchParams.get("language"), "en");
  assert.equal(u.searchParams.get("time_range"), "day");
});

test("isQueryFeedUrl / queryFromFeedUrl recognize searxng feed URLs", () => {
  assert.equal(isQueryFeedUrl("http://localhost:8080/search?q=ai&format=rss"), true);
  assert.equal(isQueryFeedUrl("http://localhost:8080/search?q=ai&format=json"), false);
  assert.equal(isQueryFeedUrl("http://localhost:8080/feed.xml"), false);
  assert.equal(isQueryFeedUrl("not a url"), false);
  assert.equal(queryFromFeedUrl("http://localhost:8080/search?q=quantum+computing&format=rss"), "quantum computing");
});

test("searxSearch parses results and caches identical calls", async () => {
  clearSearxCache();
  const before = searxHits;
  const r1 = await searxSearch(testSettings(), "hello");
  assert.equal(searxHits, before + 1);
  assert.ok(r1.length >= 4);
  assert.ok(r1.every((r) => r.url));

  // Repeat identical calls are served from the 60 s result cache.
  const r2 = await searxSearch(testSettings(), "hello");
  const r3 = await searxSearch(testSettings(), "hello");
  assert.equal(searxHits, before + 1);
  assert.equal(r2.length, r1.length);
  assert.equal(r3.length, r1.length);
});

test("searxSearch explains a 403 (json format disabled in SearXNG settings)", async () => {
  jsonEnabled = false;
  clearSearxCache();
  try {
    await searxSearch(testSettings(), "blocked");
    assert.fail("should throw");
  } catch (e) {
    assert.match(e.message, /search\.formats/);
  } finally {
    jsonEnabled = true;
    clearSearxCache();
  }
});

test("webSearchDigest returns deduped, token-cheap results", async () => {
  clearSearxCache();
  const out = await webSearchDigest(testSettings(), "digest");
  assert.ok(out.length >= 1);
  const urls = out.map((r) => r.url);
  assert.equal(new Set(urls).size, urls.length);
  assert.ok(urls.every((u) => u.startsWith(articleBase)));
});

test("backfillFromWeb indexes searxng results as short-retention web entries", async () => {
  const db = getDb();
  // One of the search results already exists in the cache → must be skipped.
  const ins = db.prepare(`
    INSERT INTO entries (guid, feed_url, title, link, pub_date, summary, content, cached_at)
    VALUES ('pre-existing', ?, 'Existing Article', ?, ?, 'old summary', 'old content', ?)
  `);
  ins.run(WEB_FEED_URL, `${articleBase}/dup`, Date.now(), Date.now());

  clearSearxCache();
  const before = searxHits;
  const res = await backfillFromWeb(testSettings(), { query: "quantum", limit: 3 });

  assert.ok(res.added >= 1, `expected at least one backfilled entry, got ${JSON.stringify(res)}`);
  assert.ok((res.alreadyCached ?? 0) >= 1, "the pre-existing URL should be skipped as already cached");

  const webRows = db.prepare(`SELECT guid, source_type, tags, feed_url, link FROM entries WHERE source_type = 'web'`).all();
  assert.ok(webRows.length >= 1);
  for (const w of webRows) {
    assert.match(w.guid, /^web:/);
    assert.equal(w.feed_url, WEB_FEED_URL);
    assert.ok(String(w.tags).includes("web"));
  }
  const page = webRows.find((w) => w.link === `${articleBase}/page`);
  assert.ok(page, "the extractable page should have been indexed");
  assert.equal(searxHits > before, true);

  // Content search reaches the web entry like any other cached article.
  const { retrieve } = await import("../lib/retriever.js");
  const hits = await retrieve("quantum breakthrough", testSettings(), { limit: 5 });
  assert.ok(hits.some((h) => h.sourceType === "web"));
});

test("prune keeps web entries (no real feed); retention expires them by web TTL", async () => {
  const db = getDb();
  // A feed-list prune with a list that does not include WEB_FEED_URL must not
  // delete web entries.
  const removed = pruneRemovedFeeds(["https://example.com/feed"]);
  const webLeft = db.prepare(`SELECT COUNT(*) AS c FROM entries WHERE source_type = 'web'`).get().c;
  assert.ok(webLeft >= 1, pruneRemovedFeedsResultNote(removed));

  // Web TTL (14 days) is shorter than the global retention: an old web entry
  // with a fresh pub date would survive the global pass if it were 30 days
  // old; here it must be removed by the web cutoff.
  db.prepare(`
    INSERT INTO entries (guid, feed_url, title, link, pub_date, summary, content, cached_at, source_type)
    VALUES ('web:old', ?, 'Old Web Entry', 'https://elsewhere/old', ?, 's', 'web朽 old story', ?, 'web')
  `).run(WEB_FEED_URL, Date.now() - 20 * 86400e3, Date.now());
  db.prepare(`
    INSERT INTO entries (guid, feed_url, title, link, pub_date, summary, content, cached_at, source_type)
    VALUES ('rss-old', 'https://example.com/feed', 'Old Rss Entry', 'https://example.com/old', ?, 's', 'rss old story', ?, 'rss')
  `).run(Date.now() - 20 * 86400e3, Date.now());

  const ret = runRetention(90, "publish_date", [], 14);
  const oldWeb = db.prepare(`SELECT COUNT(*) AS c FROM entries WHERE guid = 'web:old'`).get().c;
  const oldRss = db.prepare(`SELECT COUNT(*) AS c FROM entries WHERE guid = 'rss-old'`).get().c;
  assert.equal(oldWeb, 0, "web entry should expire by the 14-day web TTL");
  assert.equal(oldRss, 1, "rss entry (20 days) must survive 90-day retention");
});

function pruneRemovedFeedsResultNote(removed) {
  return `web entry was removed by prune (removed=${JSON.stringify(removed)})`;
}
