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

const { chunkText, sanitizeFts, indexEntries, reindexMissing, retrieve, contextualEmbedInput } = await import("../lib/retriever.js");
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
    assert.equal(got.length, 8);
    const norm = Math.sqrt(got.reduce((s,x)=>s+x*x,0));
    assert.ok(Math.abs(norm - 1) < 1e-5);
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

// --- v1.2.0 additions -------------------------------------------------------

test("chunkText respects sentence boundaries and never splits words", () => {
  const text = "First sentence is here. Second sentence follows. Third sentence ends it. Fourth one is longer and carries more words.";
  const chunks = chunkText(text, 60, 0);
  assert.ok(chunks.length >= 1);
  for (const c of chunks) assert.ok(c.length <= 80, `chunk too long: ${c.length}`);
  const joined = chunks.join(" ");
  for (const w of ["First", "sentence", "Second", "Third", "Fourth", "carries"]) {
    assert.ok(joined.includes(w), `missing word ${w}`);
  }
  assert.match(chunks[0], /[.!?]$/, "a chunk should end at a sentence boundary, not mid-word");
});

test("indexEntries re-indexes an entry when its content changes", async () => {
  const db = getDb();
  const s = testSettings();
  const g = "g-change-1";
  const base = { guid: g, title: "Changing Article", link: "https://x/c1", feed_url: "https://f/c", pub_date: Date.now() };

  const r1 = await indexEntries([{ ...base, content: "original body about apples" }], s);
  assert.equal(r1.added, 1);

  // Identical content again → a no-op (no needless re-embedding).
  const r2 = await indexEntries([{ ...base, content: "original body about apples" }], s);
  assert.equal(r2.added, 0);
  assert.equal(r2.updated, 0);

  // Changed content → the entry is updated and its chunks rebuilt.
  const r3 = await indexEntries([{ ...base, content: "completely new body about oranges and pears" }], s);
  assert.equal(r3.added, 0);
  assert.equal(r3.updated, 1);

  const entry = db.prepare(`SELECT id, content FROM entries WHERE guid = ?`).get(g);
  assert.match(entry.content, /oranges/);
  const chunks = db.prepare(`SELECT embedding FROM chunks WHERE entry_id = ?`).all(entry.id);
  assert.ok(chunks.length >= 1);
  for (const c of chunks) assert.notEqual(c.embedding, null);
});

test("feeds.json overrides (tags/enabled) drive filtering and the fetch list", async () => {
  const { setFeedOptions, loadFeedConfig, loadEnabledFeeds, getSettings } = await import("../lib/config.js");
  const s = getSettings();
  const url = "https://example.com/tagged";

  removeFeed(url);
  assert.equal(appendFeed(url).ok, true);
  assert.equal(setFeedOptions(url, { tags: ["Tech", "AI"], enabled: true }, s).ok, true);

  const cfg = loadFeedConfig(s).find((f) => f.url === url);
  assert.ok(cfg);
  assert.deepEqual(cfg.tags, ["Tech", "AI"]);

  // Disabled feeds remain configured but are excluded from the fetch list.
  setFeedOptions(url, { enabled: false }, s);
  assert.equal(loadEnabledFeeds(s).some((f) => f.url === url), false);
  assert.equal(loadFeeds(s).includes(url), true);

  // A tagged entry is retrievable via the tag filter.
  await indexEntries([{
    guid: "g-tagged", title: "Tagged Tech Story", link: "https://example.com/tagged/1",
    feed_url: url, tags: ["tech", "ai"], content: "quantum widgets explained in depth", pub_date: Date.now(),
  }], testSettings());
  const hit = await retrieve("quantum widgets", testSettings(), { tag: "tech" });
  assert.ok(hit.some((r) => /Tagged Tech Story/.test(r.title)), "tag filter should find the tagged entry");
  const miss = await retrieve("quantum widgets", testSettings(), { tag: "sports" });
  assert.equal(miss.length, 0);

  removeFeed(url); // cleanup: drop from feeds.txt and feeds.json
});

test("retrieve supports date sort and pagination", async () => {
  const s = testSettings();
  const feed = "https://f/page";
  const now = Date.now();
  const mk = (n, daysAgo) => ({
    guid: `g-page-${n}`, title: `Pagination Story ${n}`, link: `https://x/p/${n}`,
    feed_url: feed,
    content: n === 1
      ? "pagination uniqueword alpha reporting on deep sea coral reefs and marine biodiversity surveys"
      : n === 2
        ? "pagination uniqueword beta covering quarterly stock market earnings and investor sentiment indexes"
        : "pagination uniqueword gamma reviewing alpine mountain climbing gear ropes and safety harnesses",
    pub_date: now - daysAgo * 86400e3,
  });
  await indexEntries([mk(1, 10), mk(2, 5), mk(3, 1)], s);

  const page1 = await retrieve("pagination uniqueword", s, { feed, limit: 2, offset: 0 });
  assert.equal(page1.length, 2);
  const page2 = await retrieve("pagination uniqueword", s, { feed, limit: 2, offset: 2 });
  assert.ok(page2.length >= 1);
  const links1 = new Set(page1.map((r) => r.link));
  assert.ok(page2.every((r) => !links1.has(r.link)), "pages must not overlap");

  const byDate = await retrieve("pagination uniqueword", s, { feed, sort: "date", limit: 10 });
  assert.ok(byDate.length >= 2);
  for (let i = 1; i < byDate.length; i++) {
    assert.ok(Date.parse(byDate[i - 1].pub_date_iso) >= Date.parse(byDate[i].pub_date_iso));
  }
});

test("retrieve collapses syndicated near-duplicate content (SimHash)", async () => {
  const s = testSettings();
  const body = "the quick brown fox jumps over the lazy dog while the sun sets slowly over the quiet hills and rivers flow onward";
  await indexEntries([
    { guid: "g-dup-a", title: "Sunset Over The Hills", link: "https://a/dup", feed_url: "https://f/dup", content: body, pub_date: Date.now() },
    { guid: "g-dup-b", title: "Another Take On Hills", link: "https://b/dup", feed_url: "https://f/dup", content: body, pub_date: Date.now() },
  ], s);

  const res = await retrieve("quiet hills sunset", s, { feed: "https://f/dup" });
  const hits = res.filter((r) => /Hills/.test(r.title));
  assert.equal(hits.length, 1, "identical bodies should collapse to a single result");
});

test("getDiagnostics reports counts, coverage, schema version and suggestions", async () => {
  const { getDiagnostics } = await import("../lib/diagnostics.js");
  const d = getDiagnostics(testSettings());
  assert.ok(d.entries >= 1);
  assert.ok(d.chunks >= 1);
  assert.equal(typeof d.embeddingCoveragePct, "number");
  assert.ok(Array.isArray(d.suggestions) && d.suggestions.length >= 1);
  assert.equal(d.schemaVersion, 8);
  assert.equal(typeof d.vectorIndex, "object");
  assert.equal(typeof d.unstyledChunks, "number");
  assert.equal(typeof d.contextualChunks, "number");
});

// --- v1.3.0 additions -------------------------------------------------------

test("discoverFeed resolves an alternate feed link from an HTML page", async () => {
  const { discoverFeed } = await import("../lib/fetcher.js");
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith("/feed")) {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end('<?xml version="1.0"?><rss version="2.0"><channel><title>T</title></channel></rss>');
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>blog home</body></html>');
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const found = await discoverFeed(`${base}/`);
    assert.equal(found.found, true);
    assert.equal(found.feedUrl, `${base}/feed.xml`);
    assert.equal(found.type, "rss");

    // A URL that already serves a feed is returned as-is.
    const direct = await discoverFeed(`${base}/feed.xml`);
    assert.equal(direct.found, true);
    assert.equal(direct.feedUrl, `${base}/feed.xml`);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test("runRetention honours a per-feed retentionDays override", async () => {
  const { runRetention } = await import("../lib/retention.js");
  const db = getDb();
  const now = Date.now();
  const mk = (guid, feed, daysAgo) =>
    db.prepare(
      `INSERT INTO entries (guid, feed_url, title, link, author, pub_date, summary, content, title_key, cached_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(guid, feed, guid, `https://ret/${guid}`, null, now - daysAgo * 86400e3, "", "body", `tk-${guid}`, now);

  mk("r-a-old", "https://ret/a", 5);
  mk("r-a-new", "https://ret/a", 0);
  mk("r-b-old", "https://ret/b", 5);
  mk("r-b-ancient", "https://ret/b", 100);

  const res = runRetention(30, "publish_date", [{ url: "https://ret/a", retentionDays: 1 }]);
  assert.ok(res.deletedEntries >= 2);
  assert.equal(res.perFeedOverrides, 1);

  const kept = db.prepare(`SELECT guid FROM entries WHERE guid LIKE 'r-%'`).all().map((r) => r.guid).sort();
  // 5-day-old feed A entry is dropped by its 1-day override; the same age on
  // feed B survives under the 30-day global; feed B's 100-day-old entry is dropped.
  assert.deepEqual(kept, ["r-a-new", "r-b-old"]);
});

test("retrieve filters by collection", async () => {
  const s = testSettings();
  await indexEntries([
    { guid: "col-a", title: "Collection Alpha Story", link: "https://x/ca", feed_url: "https://f/ca", collection: "research", content: "uniquealpha findings about marine acoustics and sonar mapping", pub_date: Date.now() },
    { guid: "col-b", title: "Collection Beta Story", link: "https://x/cb", feed_url: "https://f/cb", collection: "news", content: "uniquebeta findings about marine acoustics and sonar mapping", pub_date: Date.now() },
  ], s);

  const research = await retrieve("marine acoustics sonar mapping", s, { collection: "research" });
  assert.ok(research.length >= 1);
  assert.ok(research.every((r) => /Collection Alpha/.test(r.title)), "only the research collection should match");

  const news = await retrieve("marine acoustics sonar mapping", s, { collection: "news" });
  assert.ok(news.length >= 1);
  assert.ok(news.every((r) => /Collection Beta/.test(r.title)));
});

test("retrieve with debug returns ranking details", async () => {
  const res = await retrieve("Alpha", testSettings(), { debug: true });
  assert.ok(res.length >= 1);
  const r = res[0];
  assert.ok(r._debug, "debug results should carry _debug");
  assert.equal(typeof r._debug.combined, "number");
  assert.equal(typeof r._debug.rrf, "number");
  assert.equal(typeof r._debug.ranks, "object");
});

test("reindexMissing upgrades chunks whose embed_style is stale", async () => {
  const db = getDb();
  const s = testSettings();
  await indexEntries([{
    guid: "style-up", title: "Style Upgrade Story", link: "https://x/style", feed_url: "https://f/style",
    content: "restyle me about contextual embeddings and retrieval quality improvements", pub_date: Date.now(),
  }], s);
  const entry = db.prepare(`SELECT id FROM entries WHERE guid = 'style-up'`).get();
  // Simulate pre-contextual chunks.
  db.prepare(`UPDATE chunks SET embed_style = NULL WHERE entry_id = ?`).run(entry.id);

  const res = await reindexMissing(s, 100);
  assert.ok(res.updated >= 1);
  const stale = db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE entry_id = ? AND embed_style IS NULL`).get(entry.id).n;
  assert.equal(stale, 0);
});

