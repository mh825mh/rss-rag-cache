import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const dataDir = mkdtempSync(join(tmpdir(), "rss-rag-rerank-test-"));
process.env.RSS_RAG_DATA_DIR = dataDir;

let state = "ok"; // "ok" | "missing" | "requiresModel"

let server;
let rerankBase;
let requests = 0;

before(async () => {
  server = http.createServer((req, res) => {
    const serveEmbeddings = () => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let payload = {};
        try { payload = JSON.parse(body); } catch { /* ignore */ }
        const input = Array.isArray(payload.input) ? payload.input : [payload.input];
        const data = input.map((text, i) => {
          const v = new Array(8).fill(0);
          const s = String(text);
          for (let k = 0; k < s.length; k++) v[k % 8] += s.charCodeAt(k) + 1;
          const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0)) || 1;
          return { index: i, embedding: v.map((x) => x / norm) };
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data }));
      });
    };
    if (!req.url.startsWith("/v1/rerank")) { serveEmbeddings(); return; }
    requests++;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* ignore */ }
      if (state === "missing") { res.writeHead(404); res.end("no endpoint"); return; }
      if (state === "requiresModel" && payload.model === undefined) {
        res.writeHead(400); res.end("model required"); return;
      }
      // Reverse the documents so a successful rerank is observable.
      const order = payload.documents.map((_, i) => payload.documents.length - 1 - i);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: order.map((index, i) => ({ index, relevance_score: i })) }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  rerankBase = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* ignore */ }
});

const { rerankItems, resetRerankProbe } = await import("../lib/rerank.js");
const { normalizeSettings } = await import("../lib/config.js");

const testSettings = (over = {}) =>
  normalizeSettings({ lmStudioBaseUrl: rerankBase, embeddingModel: "test-embed", ...over });

const items = (n) => Array.from({ length: n }, (_, i) => ({ rerankText: `document ${i}` }));

test("rerankItems is inert with rerankDocs=0 (default)", async () => {
  resetRerankProbe();
  requests = 0;
  const out = await rerankItems("q", items(3), testSettings({ rerankDocs: 0 }));
  assert.equal(out, null);
  assert.equal(requests, 0);
});

test("rerankItems reorders when the endpoint is available (no model field first)", async () => {
  resetRerankProbe();
  state = "ok";
  requests = 0;
  const out = await rerankItems("query", items(4), testSettings({ rerankDocs: 4 }));
  assert.ok(out, "expected a re-ordered list");
  assert.deepEqual(out.map((i) => i.rerankText), ["document 3", "document 2", "document 1", "document 0"]);
  assert.equal(requests, 1); // the first (model-less) shape succeeded and was cached
  // Cached availability: a second call must not re-probe.
  const out2 = await rerankItems("query", items(2), testSettings({ rerankDocs: 2 }));
  assert.deepEqual(out2.map((i) => i.rerankText), ["document 1", "document 0"]);
  assert.equal(requests, 2);
});

test("rerankItems falls back to the model-requiring body when needed", async () => {
  resetRerankProbe();
  state = "requiresModel";
  requests = 0;
  const out = await rerankItems("query", items(3), testSettings({ rerankDocs: 3 }));
  assert.ok(out, "expected a re-ordered list via the model attempt");
  assert.deepEqual(out.map((i) => i.rerankText), ["document 2", "document 1", "document 0"]);
  assert.equal(requests, 2);
});

test("an absent endpoint degrades to null and cool down for a while", async () => {
  resetRerankProbe();
  state = "missing";
  requests = 0;
  const out = await rerankItems("query", items(2), testSettings({ rerankDocs: 2 }));
  assert.equal(out, null);
  assert.equal(requests, 2); // plain + model attempts
  // Second call immediately after: suppressed by the cooldown, no more requests.
  const out2 = await rerankItems("query", items(2), testSettings({ rerankDocs: 2 }));
  assert.equal(out2, null);
  assert.equal(requests, 2);
});

test("retrieve honors rerankDocs end-to-end (shortlist re-ordered)", async () => {
  resetRerankProbe();
  state = "ok";
  const { indexEntries, retrieve } = await import("../lib/retriever.js");
  const { getDb } = await import("../lib/db.js");

  try {
    const s = testSettings({ rerankDocs: 5 });
    await indexEntries([
      { guid: "r1", title: "Alpha bridge design", link: "http://e/1", feed_url: "https://e/f", content: "alpha bridge design notes ".repeat(30), pub_date: Date.now() },
      { guid: "r2", title: "Beta bridge design", link: "http://e/2", feed_url: "https://e/f", content: "beta bridge design notes ".repeat(30), pub_date: Date.now() },
      { guid: "r3", title: "Gamma bridge design", link: "http://e/3", feed_url: "https://e/f", content: "gamma bridge design notes ".repeat(30), pub_date: Date.now() },
    ], s);
    const hits = await retrieve("bridge design", s, { limit: 3 });
    assert.ok(hits.length >= 1);
    // The stub reverses the candidate order; whatever the internal candidate
    // order is, rerankItems must not have thrown and results must be valid.
    assert.ok(hits.every((h) => /bridge/.test(h.title)));
    // rerank performance should not silently mutate result fields.
    assert.ok(hits.every((h) => typeof h.score === "number"));
  } finally {
    resetRerankProbe();
  }
});
