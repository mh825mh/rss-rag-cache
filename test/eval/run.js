// Phase 0 eval CLI: `npm run eval`.
//
// Indexes the frozen corpus in test/eval/corpus.json into a throwaway database
// (via a deterministic fake embedding server, so semantic metrics are real and
// reproducible without LM Studio), runs every labelled query through the real
// retrieve() pipeline, prints recall@k / MRR / nDCG@10 and latency p50/p95, and
// compares against test/eval/baseline.json.
//
// Exit code is non-zero only when a metric regresses beyond the threshold, so
// it can gate CI once a baseline is committed. Pass `--update-baseline` to
// rewrite the baseline.

import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = join(here, "corpus.json");
const baselinePath = join(here, "baseline.json");
const updateBaseline = process.argv.includes("--update-baseline");

// Must be set before importing config.js (it resolves the dir at import time).
const dataDir = mkdtempSync(join(tmpdir(), "rss-rag-eval-"));
process.env.RSS_RAG_DATA_DIR = dataDir;

// Deterministic 16-dim unit vector from the input text. Stands in for the real
// embedding model so the vector list is exercised without LM Studio.
function vecFor(text) {
  const v = new Array(16).fill(0);
  for (let i = 0; i < text.length; i++) v[i % 16] += text.charCodeAt(i) + 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

let server;
let baseUrl;

async function startServer() {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* ignore */ }
      const input = Array.isArray(payload.input) ? payload.input : [payload.input];
      const data = input.map((text, i) => ({ index: i, embedding: vecFor(String(text)) }));
      data.reverse(); // out of order on purpose
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const guidByLink = new Map(corpus.entries.map((e) => [e.link, e.guid]));

await startServer();

const { normalizeSettings } = await import("../../lib/config.js");
const { indexEntries, retrieve } = await import("../../lib/retriever.js");
const { getDb, closeDb } = await import("../../lib/db.js");
const { runEval, findRegressions } = await import("../../lib/eval.js");

let exitCode = 0;
try {
  getDb();
  const settings = normalizeSettings({
    lmStudioBaseUrl: baseUrl,
    embeddingModel: "eval-embed",
    chunkSize: 400,
    embedBatchSize: 8,
    contextChunks: 1,
  });

  const res = await indexEntries(corpus.entries, settings);
  console.error(`[eval] indexed ${res.added} entries (${res.updated} updated)`);

  const search = async (query) => {
    const results = await retrieve(query, settings, { limit: 10 });
    return results
      .map((r) => guidByLink.get(r.link))
      .filter(Boolean);
  };

  const { aggregate, perQuery } = await runEval({ queries: corpus.queries, search });

  const fmt = (n) => (typeof n === "number" ? n.toFixed(3) : String(n));
  console.log("\n=== RSS RAG Cache — retrieval eval ===");
  console.log(`queries: ${aggregate.queries}`);
  console.log(`recall@1  ${fmt(aggregate["recall@1"])}`);
  console.log(`recall@3  ${fmt(aggregate["recall@3"])}`);
  console.log(`recall@5  ${fmt(aggregate["recall@5"])}`);
  console.log(`recall@10 ${fmt(aggregate["recall@10"])}`);
  console.log(`mrr       ${fmt(aggregate.mrr)}`);
  console.log(`ndcg@10   ${fmt(aggregate["ndcg@10"])}`);
  console.log(`latency   p50 ${aggregate.latencyP50Ms.toFixed(2)}ms  p95 ${aggregate.latencyP95Ms.toFixed(2)}ms`);

  const misses = perQuery.filter((r) => r.recall[10] !== null && r.recall[10] < 1);
  if (misses.length) {
    console.log("\nmissed queries (recall@10 < 1):");
    for (const m of misses) console.log(`  • ${m.query}  → ranked ${JSON.stringify(m.ranked)} (want ${JSON.stringify(m.relevant)})`);
  }

  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : null;
  if (updateBaseline || !baseline) {
    writeFileSync(baselinePath, JSON.stringify(aggregate, null, 2) + "\n");
    console.log(`\nbaseline ${baseline ? "updated" : "written"} → ${baselinePath}`);
  } else {
    const regressions = findRegressions(baseline, aggregate, 0.05);
    if (regressions.length) {
      console.error("\nREGRESSIONS:");
      for (const r of regressions) console.error(`  • ${r.metric}: ${r.baseline.toFixed(3)} → ${r.current.toFixed(3)} (${r.delta.toFixed(3)})`);
      exitCode = 1;
    } else {
      console.log("\nno regressions vs baseline.");
    }
  }
} catch (e) {
  console.error("[eval] failed:", e?.stack || e?.message || e);
  exitCode = 1;
} finally {
  server?.close();
  try { closeDb(); } catch { /* ignore */ }
  try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
}

process.exit(exitCode);
