import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const dataDir = mkdtempSync(join(tmpdir(), "rss-rag-watches-test-"));
process.env.RSS_RAG_DATA_DIR = dataDir;

const { addWatch, listWatches, removeWatch, evaluateWatches, resetWatches } = await import("../lib/watches.js");
const { normalizeSettings } = await import("../lib/config.js");
const { indexEntries } = await import("../lib/retriever.js");
const { getDb, closeDb } = await import("../lib/db.js");

function vecFor(text) {
  const v = new Array(8).fill(0);
  for (let i = 0; i < text.length; i++) v[i % 8] += text.charCodeAt(i) + 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

let server;
let baseUrl;

before(async () => {
  server = http.createServer((req, res) => {
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
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await indexEntries([
    { guid: "news-1", title: "RSS cache gets nicer", link: "https://n/1", feed_url: "https://n/rss", content: "local rss cache news ".repeat(40), pub_date: Date.now() - 3600e3 },
    { guid: "sports-1", title: "Sports update", link: "https://s/1", feed_url: "https://s/rss", content: "sports update minute ".repeat(40), pub_date: Date.now() - 3600e3 },
  ], testSettings());
});

after(() => {
  server?.close();
  closeDb();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* ignore */ }
});

const testSettings = (over = {}) =>
  normalizeSettings({ lmStudioBaseUrl: baseUrl, embeddingModel: "test-embed", embedBatchSize: 4, ...over });

test("watches CRUD: add validates, list returns, remove deletes", () => {
  resetWatches();

  assert.equal(addWatch({ name: "", query: "q" }).ok, false);
  assert.equal(addWatch({ name: "n", query: "" }).ok, false);

  const add = addWatch({ name: "rss news", query: "rss cache", feed: "https://n" });
  assert.equal(add.ok, true);
  const watch = listWatches().find((w) => w.id === add.id);
  assert.equal(watch.name, "rss news");
  assert.equal(watch.savedFilters.feed, "https://n");

  assert.equal(removeWatch(9999).ok, false);
  assert.equal(removeWatch(add.id).ok, true);
  assert.equal(listWatches().length, 0);
});

test("evaluateWatches reports new hits once, then stays quiet until new articles", async () => {
  resetWatches();
  const add = addWatch({ name: "rss watcher", query: "rss cache news" });
  assert.equal(add.ok, true);

  // First evaluation looks back 30 days from now (last_run unset) and should
  // surface the rss article (the sports article does not match the query).
  const hits1 = await evaluateWatches(testSettings());
  assert.equal(hits1.length, 1, JSON.stringify(hits1));
  assert.equal(hits1[0].name, "rss watcher");
  assert.ok(hits1[0].newCount >= 1);
  assert.ok(hits1[0].top[0].title.includes("RSS"));

  const afterRun = listWatches().find((w) => w.id === add.id);
  assert.ok(afterRun.last_run > 0);
  assert.equal(afterRun.last_hits, hits1[0].newCount);

  // Hits should not re-report the same stale articles on the second eval: the
  // after-window moved forward, so only fresh posts can pass the pub filter
  // (semantic candidates are always positive, so an empty list isn't asserted).
  const hits2 = await evaluateWatches(testSettings());
  for (const w of hits2) {
    for (const t of w.top) {
      assert.ok(t.title.includes("round two"), `stale title leaked into watch 2: ${t.title}`);
    }
  }

  // A brand-new matching article (fresh pub_date) wakes the watch up again.
  // Back-date the marker explicitly: millisecond clock equality between the
  // marker write and the article's pub_date would otherwise be a flaky race.
  const db = getDb();
  db.prepare(`UPDATE watches SET last_run = ?`).run(Date.now() - 600000);
  await indexEntries([
    { guid: "news-2", title: "RSS cache news round two", link: "https://n/2", feed_url: "https://n/rss", content: "second rss cache news item ".repeat(40), pub_date: Date.now() },
  ], testSettings());
  const hits3 = await evaluateWatches(testSettings());
  assert.equal(hits3.length, 1, JSON.stringify(hits3));
  assert.ok(hits3[0].newCount >= 1);
  assert.ok(hits3[0].top.some((t) => /round two/.test(t.title)));
});

test("a quiet-looking query still advances the watch marker", async () => {
  resetWatches();
  const add = addWatch({ name: "quiet watcher", query: "qqzzxnothing" });
  // Semantic similarity is always positive, so a hit may legitimately surface;
  // the contract under test is that the after-window advances either way.
  await evaluateWatches(testSettings());
  const w = listWatches().find((x) => x.id === add.id);
  assert.ok(w.last_run > 0);
});
