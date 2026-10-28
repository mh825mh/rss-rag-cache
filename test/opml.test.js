import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "rss-rag-opml-test-"));
process.env.RSS_RAG_DATA_DIR = dataDir;

const { exportOpml, parseOpml } = await import("../lib/opml.js");

after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* ignore */ }
});

const sampleFeeds = [
  { url: "https://example.com/feed.xml", tags: ["tech"] },
  { url: "http://localhost:8080/search?q=quantum+computing&format=rss", type: "searxng-query", query: "quantum computing" },
  { url: "https://philosophy.example/feed", collection: "longreads", tags: ["essays"] },
];

test("exportOpml renders flat + collection-grouped outlines", () => {
  const xml = exportOpml(sampleFeeds, { title: "My Cache" });
  assert.match(xml, /<opml version="2\.0"/);
  assert.match(xml, /<title>My Cache<\/title>/);
  assert.match(xml, /xmlUrl="https:\/\/example\.com\/feed\.xml"/);
  assert.match(xml, /xmlUrl="http:\/\/localhost:8080\/search\?q=quantum\+computing&amp;format=rss"/);
  // URL escaping must be lossless for the parser (the & becomes &amp;).
  assert.match(xml, /<outline text="longreads">[\s\S]*?xmlUrl="https:\/\/philosophy\.example\/feed"/);
});

test("parseOpml round-trips feeds through folders and categories", () => {
  const xml = exportOpml(sampleFeeds);
  const parsed = parseOpml(xml);
  const urls = parsed.map((p) => p.url);
  assert.equal(urls.length, 3);
  assert.ok(urls.includes("https://example.com/feed.xml"));
  assert.ok(urls.includes("http://localhost:8080/search?q=quantum+computing&format=rss"));
  const phil = parsed.find((p) => p.url === "https://philosophy.example/feed");
  assert.deepEqual(phil.tags, ["essays"]);
});

test("parseOpml reads foreign OPML with folder outlines and category attrs", () => {
  const foreign = `<?xml version="1.0"?>
<opml version="1.1">
  <head><title>Reader</title></head>
  <body>
    <outline text="News" title="News">
      <outline type="rss" text="Herald" title="Herald" xmlUrl="https://herald.example/rss" category="city, breaking"/>
    </outline>
    <outline type="rss" text="Solo" xmlUrl="https://solo.example/atom"/>
  </body>
</opml>`;
  const parsed = parseOpml(foreign);
  assert.equal(parsed.length, 2);
  const herald = parsed.find((p) => p.url === "https://herald.example/rss");
  assert.deepEqual(herald.tags, ["city", "breaking"]);
  assert.equal(herald.title, "Herald");
});

test("parseOpml handles malformed input and folder-only outlines", () => {
  assert.deepEqual(parseOpml("this is not xml"), []);
  assert.deepEqual(parseOpml('<opml version="2.0"><body><outline text="Empty folder"/></body></opml>'), []);
  assert.deepEqual(parseOpml(""), []);
});
