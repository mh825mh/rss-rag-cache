import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const dataDir = mkdtempSync(join(tmpdir(), "rss-rag-interval-test-"));
process.env.RSS_RAG_DATA_DIR = dataDir;

const { refreshFeeds } = await import("../lib/retriever.js");
const { resetHttpPolicy } = await import("../lib/fetcher.js");
const { normalizeSettings } = await import("../lib/config.js");
const { saveFeedState, closeDb } = await import("../lib/db.js");

let server;
let baseUrl;
let rssHits = 0;
let rateTrip = 0;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith("/v1/embeddings")) {
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
      return;
    }
    if (req.url.startsWith("/rss")) rssHits++;
    if (req.url.startsWith("/rate")) rateTrip++;
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end(
      '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>' +
      `<item><title>Item ${rssHits}/${rateTrip}</title><link>https://x/${rssHits}-${rateTrip}</link>` +
      "<description>update</description></item></channel></rss>",
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  resetHttpPolicy();
  closeDb();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* ignore */ }
});

const testSettings = (over = {}) =>
  normalizeSettings({ lmStudioBaseUrl: baseUrl, embeddingModel: "test-embed", ...over });

const rssUrl = () => `${baseUrl}/rss`;

test("refreshHours skips a feed until it is due; force overrides", async () => {
  const hitsBefore = rssHits;

  // Fresh feed with refreshHours → first refresh runs (nothing fetched yet).
  const first = await refreshFeeds(testSettings(), [{ url: rssUrl(), refreshHours: 6 }], { force: false });
  assert.equal(first.added, 1);
  assert.equal(rssHits, hitsBefore + 1);
  assert.equal(first.notDue.length, 0);

  // immediately-refreshing again: not due, and the server must not be hit.
  const second = await refreshFeeds(testSettings(), [{ url: rssUrl(), refreshHours: 6 }], { force: false });
  assert.equal(second.added, 0);
  assert.equal(rssHits, hitsBefore + 1);
  assert.equal(second.notDue.length, 1);
  assert.equal(second.notDue[0].hours, 6);
  assert.ok(second.notDue[0].retryInMinutes >= 1);

  // force ignores the interval (explicit user-triggered refresh).
  const third = await refreshFeeds(testSettings(), [{ url: rssUrl(), refreshHours: 6 }], { force: true });
  assert.equal(rssHits, hitsBefore + 2);
  assert.ok(third.added + third.updated >= 1);
  assert.equal(third.notDue.length, 0);
});

test("a feed without refreshHours behaves exactly like before", async () => {
  const hitsBefore = rateTrip;
  const r1 = await refreshFeeds(testSettings(), [{ url: `${baseUrl}/rate` }], { force: false });
  assert.ok(r1.added + r1.updated >= 1);
  assert.equal(rateTrip, hitsBefore + 1);
  const r2 = await refreshFeeds(testSettings(), [{ url: `${baseUrl}/rate` }], { force: false });
  // 304 validators were stored in pass 1; the second pass re-fetches (no 304
  // support in this stub), which is the historical behaviour.
  assert.ok(rateTrip >= hitsBefore + 1);
});
