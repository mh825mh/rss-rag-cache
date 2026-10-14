import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

// Point the plugin at an isolated data directory *before* importing any module
// that reads the config (config.js resolves the dir at import time).
const dataDir = mkdtempSync(join(tmpdir(), "rss-rag-test-"));
process.env.RSS_RAG_DATA_DIR = dataDir;

const { chunkText, sanitizeFts, indexEntries, reindexMissing, retrieve } = await import("../lib/retriever.js");
const { normalizeSettings, appendFeed, removeFeed, loadFeeds } = await import("../lib/config.js");
const { bufferToFloat32 } = await import("../lib/embedder.js");
const { getDb, closeDb, getMeta, saveFeedState, getAllFeedStates } = await import("../lib/db.js");

// Deterministic 8-dim unit vector derived from the input text. Because the fake
// server returns the vectors *out of order*, a chunk only ends up with the
// right vector if the client sorts by `index`.
function vecFor(text) {
  const v = new Array(8).fill(0);
  for (let i = 0; i < text.length; i++) v[i % 8] += text.charCodeAt(i) + 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

let server;
let baseUrl;
let failMode = false;

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (failMode) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("boom");
        return;
      }
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* ignore */ }
      const input = Array.isArray(payload.input) ? payload.input : [payload.input];
      const data = input.map((text, i) => ({ index: i, embedding: vecFor(String(text)) }));
      data.reverse(); // deliberately out of order
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  closeDb();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows may still hold the WAL file briefly; Temp is cleaned by the OS. */
  }
});

const testSettings = (over = {}) =>
  normalizeSettings({ lmStudioBaseUrl: baseUrl, embeddingModel: "test-embed", embedBatchSize: 4, chunkSize: 200, ...over });

test("normalizeSettings coerces UI strings and clamps values", () => {
  const s = normalizeSettings({ retentionDays: "90", refreshOnStartup: "false", topK: 999, chunkSize: 5 });
  assert.equal(s.retentionDays, 90);
  assert.equal(s.refreshOnStartup, false);
  assert.equal(s.topK, 50); // clamped to max
  assert.equal(s.chunkSize, 200); // clamped to min
});

test("chunkText splits with overlap and handles empty input", () => {
  assert.deepEqual(chunkText(""), []);
  const text = "a".repeat(500);
  const chunks = chunkText(text, 200, 120);
  assert.equal(chunks[0].length, 200);
  assert.ok(chunks.length >= 3);
});

test("sanitizeFts neutralises FTS5 syntax characters", () => {
  const q = sanitizeFts('foo OR "bar" -baz (qux)');
  assert.match(q, /^"/);
  assert.doesNotMatch(q, /[()"]\s*[()]/);
  assert.equal(sanitizeFts(""), "a");
});

test("feeds: append dedups (trailing-slash tolerant) and remove is exact", () => {
  assert.equal(appendFeed("https://example.com/feed").ok, true);
  assert.equal(appendFeed("https://example.com/feed").ok, false); // dup
  assert.equal(appendFeed("https://example.com/feed/").ok, false); // dup modulo slash
  assert.equal(appendFeed("not a url").ok, false); // invalid

  // Removing a *prefix* must not match the full URL (regression: substring bug).
  assert.equal(removeFeed("https://example.com").ok, false);
  assert.equal(loadFeeds().length, 1);

  assert.equal(removeFeed("https://example.com/feed").ok, true);
  assert.equal(loadFeeds().length, 0);
});

test("indexEntries stores chunks with correctly-aligned embeddings", async () => {
  const db = getDb();
  const items = [
    { guid: "g1", title: "Alpha Article", link: "https://x/a", feed_url: "https://f/1", content: "alpha ".repeat(80), pub_date: Date.now() },
    { guid: "g2", title: "Beta Article", link: "https://x/b", feed_url: "https://f/1", content: "beta ".repeat(80), pub_date: Date.now() },
    { guid: "g1", title: "Alpha Duplicate", link: "https://x/a2", feed_url: "https://f/1", content: "dup", pub_date: Date.now() },
  ];
  const res = await indexEntries(items, testSettings());
  assert.equal(res.added, 2); // duplicate guid skipped

  const chunks = db.prepare(`SELECT text, embedding FROM chunks WHERE embedding IS NOT NULL`).all();
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    const got = Array.from(bufferToFloat32(c.embedding));
    const want = vecFor(c.text);
    assert.deepEqual(got.map((x) => Math.round(x * 1e6)), want.map((x) => Math.round(x * 1e6)));
  }
});

test("indexEntries is atomic: a failed embedding writes nothing", async () => {
  const db = getDb();
  const before = db.prepare(`SELECT COUNT(*) AS n FROM entries`).get().n;
  failMode = true;
  try {
    await assert.rejects(
      indexEntries(
        [{ guid: "g-fail", title: "Should Not Persist", link: "https://x/f", feed_url: "https://f/1", content: "small", pub_date: Date.now() }],
        testSettings(),
      ),
    );
  } finally {
    failMode = false;
  }
  const after = db.prepare(`SELECT COUNT(*) AS n FROM entries`).get().n;
  assert.equal(after, before, "no entry should be committed when embedding fails");
});

test("reindexMissing re-chunks entries that have zero chunks", async () => {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO entries (guid, feed_url, title, link, author, pub_date, summary, content, title_key, cached_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run("orphan-1", "https://f/2", "Orphan Entry", "https://x/o", null, now, "", "orphan body text", "orphan entry", now);

  const orphansBefore = db.prepare(`SELECT COUNT(*) AS n FROM entries e WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.entry_id = e.id)`).get().n;
  assert.equal(orphansBefore, 1);

  const res = await reindexMissing(testSettings(), 100);
  assert.equal(res.orphanRemaining, 0);
  const made = db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE entry_id = (SELECT id FROM entries WHERE guid = 'orphan-1')`).get().n;
  assert.ok(made >= 1);
});

test("db schema drops the embedding index, adds the norm column, and has feeds_state", () => {
  const db = getDb();
  const idx = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_chunks_emb'`).get();
  assert.equal(idx, undefined);
  const cols = db.prepare(`PRAGMA table_info(chunks)`).all().map((c) => c.name);
  assert.ok(cols.includes("norm"));
  const state = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='feeds_state'`).get();
  assert.ok(state, "feeds_state table should exist for conditional fetch / backoff");
});

test("retrieve falls back to keyword search when embeddings are unavailable", async () => {
  const settings = testSettings({ lmStudioBaseUrl: "http://127.0.0.1:1" });
  const results = await retrieve("Alpha", settings, {});
  assert.ok(results.length >= 1);
  assert.ok(results.some((r) => /Alpha/i.test(r.title)));
});

test("fetchAll does conditional GET, 304 handling, force bypass, and backoff skips", async () => {
  const { fetchAll } = await import("../lib/fetcher.js");

  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    if (req.headers["if-none-match"] === '"v1"') {
      res.writeHead(304, { etag: '"v1"' });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/rss+xml", etag: '"v1"' });
    res.end('<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>' +
      '<item><title>Hello World</title><link>https://x/1</link><guid>g-1</guid><description>body</description></item>' +
      '</channel></rss>');
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/feed.xml`;

  try {
    const first = await fetchAll([url], testSettings(), { feedStates: new Map() });
    assert.equal(first[0].ok, true);
    assert.equal(first[0].notModified, false);
    assert.equal(first[0].etag, '"v1"');
    assert.ok(first[0].items.length >= 1);
    assert.equal(hits, 1);

    // Persist the validator, then re-fetch: the server should answer 304.
    saveFeedState({ url, etag: first[0].etag, last_modified: first[0].lastModified, last_fetched: Date.now(), last_status: 200, fail_count: 0, next_retry_at: null, last_error: null });
    const second = await fetchAll([url], testSettings(), { feedStates: getAllFeedStates() });
    assert.equal(second[0].ok, true);
    assert.equal(second[0].notModified, true);
    assert.equal(second[0].items.length, 0);
    assert.equal(hits, 2);

    // force ignores validators → full body again.
    const forced = await fetchAll([url], testSettings(), { feedStates: getAllFeedStates(), force: true });
    assert.equal(forced[0].notModified, false);
    assert.ok(forced[0].items.length >= 1);

    // A future next_retry_at means the feed is skipped without any request.
    saveFeedState({ url, etag: '"v1"', last_fetched: Date.now(), last_status: 500, fail_count: 3, next_retry_at: Date.now() + 3600_000, last_error: "HTTP 500" });
    const hitsBefore = hits;
    const skipped = await fetchAll([url], testSettings(), { feedStates: getAllFeedStates() });
    assert.equal(skipped[0].skipped, true);
    assert.equal(hits, hitsBefore);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test("reembedAll rebuilds every vector and records model/dimension", async () => {
  const { reembedAll } = await import("../lib/retriever.js");
  const db = getDb();
  db.prepare(`UPDATE chunks SET embedding = NULL, norm = NULL`).run();

  const res = await reembedAll(testSettings(), { batchSize: 100 });
  assert.equal(res.remaining, 0);
  assert.equal(res.complete, true);
  assert.equal(getMeta("embedding_model"), "test-embed");
  assert.equal(getMeta("embedding_dim"), "8");

  // Every chunk is embedded again with the right vector.
  const chunks = db.prepare(`SELECT text, embedding FROM chunks`).all();
  assert.ok(chunks.length >= 1);
  for (const c of chunks) {
    assert.notEqual(c.embedding, null);
    const got = Array.from(bufferToFloat32(c.embedding));
    assert.equal(got.length, 8);
  }
});

test("retrieve returns a blended score and a bounded snippet", async () => {
  const results = await retrieve("Alpha", testSettings(), {});
  assert.ok(results.length >= 1);
  const r = results[0];
  assert.equal(typeof r.score, "number");
  assert.ok(Number.isFinite(r.score));
  assert.equal(typeof r.text, "string");
  assert.ok(r.text.length <= 620, "snippet should be bounded");
});
