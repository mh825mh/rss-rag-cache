import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

// Isolated data dir (config.js resolves it at import time).
process.env.RSS_RAG_DATA_DIR = mkdtempSync(join(tmpdir(), "rss-rag-fetcher-"));
process.env.RSS_RAG_LOG_LEVEL = "silent";

const { fetchAll, resetHttpPolicy } = await import("../lib/fetcher.js");
const { normalizeSettings } = await import("../lib/config.js");

const servers = [];
after(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

async function listen(handler) {
  const srv = http.createServer(handler);
  servers.push(srv);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { srv, base: `http://127.0.0.1:${srv.address().port}` };
}

function settings(over = {}) {
  return normalizeSettings({
    respectRobotsTxt: true,
    minRequestGapMs: 200,
    requestGapJitterMs: 0,
    maxConcurrentPerHost: 2,
    maxConcurrentFeeds: 4,
    ...over,
  });
}

test.beforeEach(() => resetHttpPolicy());

test("403 without Retry-After is terminal: the request is not retried", async () => {
  let hits = 0;
  const { base } = await listen((req, res) => {
    hits++;
    res.writeHead(403, { "content-type": "text/html" });
    res.end("<html><body>Go away</body></html>");
  });

  const bans = [];
  const results = await fetchAll([`${base}/feed.xml`], settings({ respectRobotsTxt: false }), {
    feedStates: new Map(),
    hostStates: new Map(),
    onBan: (b) => bans.push(b),
  });

  assert.equal(hits, 1, "a hard 403 must not be retried");
  assert.equal(results[0].ok, false);
  assert.equal(results[0].status, 403);
  assert.equal(results[0].ban?.kind, "blocked");
  assert.equal(bans.length, 1);
  assert.equal(bans[0].terminal, true);
});

test("429 is retried and reported as rate-limited", async () => {
  let hits = 0;
  const { base } = await listen((req, res) => {
    hits++;
    if (hits === 1) {
      res.writeHead(429, { "retry-after": "0", "content-type": "text/plain" });
      res.end("slow down");
      return;
    }
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end('<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>' +
      '<item><title>Hello</title><link>https://x/1</link><guid>g-1</guid><description>b</description></item></channel></rss>');
  });

  const bans = [];
  const results = await fetchAll([`${base}/feed.xml`], settings({ respectRobotsTxt: false }), {
    feedStates: new Map(),
    hostStates: new Map(),
    onBan: (b) => bans.push(b),
  });

  assert.equal(hits, 2, "429 should be retried");
  assert.equal(results[0].ok, true, "the retry succeeded");
  assert.equal(bans.length, 1);
  assert.equal(bans[0].kind, "rate-limited");
  assert.equal(bans[0].terminal, false, "a 429 that later succeeds is not terminal");
});

test("a host in ban backoff is skipped without any request", async () => {
  let hits = 0;
  const { base } = await listen((req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end('<?xml version="1.0"?><rss version="2.0"><channel><title>T</title></channel></rss>');
  });
  const host = new URL(`${base}/feed.xml`).host;

  const hostStates = new Map([[host, { host, ban_count: 1, next_retry_at: Date.now() + 600_000, last_error: "blocked" }]]);
  const results = await fetchAll([`${base}/feed.xml`], settings({ respectRobotsTxt: false }), {
    feedStates: new Map(),
    hostStates,
  });

  assert.equal(hits, 0, "no request should be made while the host is paused");
  assert.equal(results[0].skipped, true);
  assert.equal(results[0].hostBackoff, true);
});

test("robots.txt can veto an HTML page before it is fetched", async () => {
  let pageHits = 0;
  const { base } = await listen((req, res) => {
    if (req.url === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /blog\n");
      return;
    }
    pageHits++;
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><body><a href=\"/news/1\">Story</a></body></html>");
  });

  const results = await fetchAll([`${base}/blog`], settings(), { feedStates: new Map(), hostStates: new Map() });

  assert.equal(pageHits, 0, "a disallowed page must not be fetched");
  assert.equal(results[0].skipped, true);
  assert.equal(results[0].robotsDisallowed, true);
});

test("per-host gap spaces consecutive requests to the same host", async () => {
  const starts = [];
  const { base } = await listen((req, res) => {
    starts.push(Date.now());
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><body><a href=\"/news/1\">Story one</a></body></html>");
  });

  const s = settings({ respectRobotsTxt: false, minRequestGapMs: 400, requestGapJitterMs: 0 });
  await fetchAll([`${base}/news`, `${base}/press`], s, { feedStates: new Map(), hostStates: new Map() });

  assert.equal(starts.length, 2);
  const gap = starts[1] - starts[0];
  assert.ok(gap >= 380, `expected >= ~400ms between same-host requests, got ${gap}ms`);
});

test("pages on different hosts are not forced to wait on each other", async () => {
  const starts = [];
  const mk = async () => (await listen((req, res) => {
    starts.push(Date.now());
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><body><a href=\"/news/1\">Story</a></body></html>");
  })).base;

  const a = await mk();
  const b = await mk();
  const s = settings({ respectRobotsTxt: false, minRequestGapMs: 2000, requestGapJitterMs: 0 });

  const t0 = Date.now();
  await fetchAll([`${a}/news`, `${b}/news`], s, { feedStates: new Map(), hostStates: new Map() });
  const elapsed = Date.now() - t0;

  assert.equal(starts.length, 2);
  assert.ok(elapsed < 1500, `cross-host pages should not wait 2s (took ${elapsed}ms)`);
});
