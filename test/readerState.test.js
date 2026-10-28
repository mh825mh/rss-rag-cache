import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const dataDir = mkdtempSync(join(tmpdir(), "rss-rag-reader-test-"));
process.env.RSS_RAG_DATA_DIR = dataDir;

const { retrieve } = await import("../lib/retriever.js");
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
    { guid: "a1", title: "Starred paper about ant bridges", link: "https://x/starred", feed_url: "https://f/a", content: "ant bridges architecture paper ".repeat(50), pub_date: Date.now() - 3600e3 },
    { guid: "a2", title: "Regular market notes", link: "https://x/market", feed_url: "https://f/b", content: "market notes about pricing ".repeat(50), pub_date: Date.now() - 3600e3 },
    { guid: "a3", title: "Q00xz special token article", link: "https://x/token", feed_url: "https://f/c", content: "q00xz rare token inside ".repeat(5) + "unusual filler body ".repeat(40), pub_date: Date.now() - 3600e3 },
  ], testSettings());

  const db = getDb();
  db.prepare(`UPDATE entries SET starred = 1 WHERE guid = 'a1'`).run();
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

test("the starred filter constrains retrieval to starred entries", async () => {
  const all = await retrieve("ant bridges", testSettings(), {});
  assert.ok(all.length >= 1);

  const starred = await retrieve("ant bridges market pricing", testSettings(), { starred: true, limit: 10 });
  assert.ok(starred.length >= 1);
  assert.ok(starred.every((r) => r.starred === true));
  assert.ok(starred.every((r) => /ant bridges/.test(r.title)), JSON.stringify(starred.map((r) => r.title)));

  const stringFlag = await retrieve("ant bridges market pricing", testSettings(), { starred: "true", limit: 10 });
  assert.ok(stringFlag.length >= 1 && stringFlag.every((r) => r.starred));
});

test("the starred filter reaches the LIKE-fallback path too", async () => {
  // 'q00xz' exists only in one entry and the trigram tokenizer needs 3+ chars,
  // so the rare token exercises the fallback. Runs must not throw regardless
  // of which articles semantic candidates surface, and any returned entry
  // must be starred when the filter is on.
  const hits = await retrieve("q00xz", testSettings(), { starred: true });
  assert.ok(hits.every((r) => r.starred === true), JSON.stringify(hits.map((r) => r.title)));
  const hits2 = await retrieve("q00xz", testSettings(), {});
  assert.ok(Array.isArray(hits2));
});

test("retrieve exposes entry_id, sourceType and starred on each result", async () => {
  const all = await retrieve("ant bridges", testSettings(), { limit: 5 });
  assert.ok(all.length >= 1);
  assert.ok(typeof all[0].entry_id === "number", "entry_id is what search tool results key off");
  assert.equal(all[0].sourceType, "rss");
  assert.equal(all[0].starred, true);
});
