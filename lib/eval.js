// Retrieval evaluation metrics + harness orchestration (Phase 0).
//
// The metric helpers below are pure functions so they can be unit-tested
// without a database or an embedding server. `runEval` orchestrates a run given
// an async `search(query, spec) -> ranked GUIDs` function; the CLI in
// `test/eval/run.js` wires that to the real `retrieve()` against a deterministic
// fake embedding server (so semantic metrics are real *and* reproducible without
// LM Studio running).

// Fraction of the relevant items found within the top k.
export function recallAtK(ranked, relevant, k) {
  if (!relevant.size) return null;
  let hit = 0;
  const n = Math.min(k, ranked.length);
  for (let i = 0; i < n; i++) if (relevant.has(ranked[i])) hit++;
  return hit / relevant.size;
}

// Reciprocal rank of the first relevant item (0 when none is found).
export function reciprocalRank(ranked, relevant) {
  for (let i = 0; i < ranked.length; i++) if (relevant.has(ranked[i])) return 1 / (i + 1);
  return 0;
}

// Normalised discounted cumulative gain with binary relevance.
export function ndcgAtK(ranked, relevant, k = 10) {
  if (!relevant.size) return null;
  let dcg = 0;
  const n = Math.min(k, ranked.length);
  for (let i = 0; i < n; i++) if (relevant.has(ranked[i])) dcg += 1 / Math.log2(i + 2);
  let idcg = 0;
  const ideal = Math.min(k, relevant.size);
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg ? dcg / idcg : 0;
}

// Nearest-rank percentile (p in [0, 100]) over an unsorted array.
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

// Runs every query through `search` and aggregates the metrics.
// `queries` items: { query: string, relevant: string[] } (relevant = GUIDs).
export async function runEval({ queries, search, ks = [1, 3, 5, 10] }) {
  const perQuery = [];
  const latencies = [];

  for (const q of queries) {
    const relevant = new Set(q.relevant || []);
    const t0 = performance.now();
    let ranked = [];
    try {
      ranked = (await search(q.query, q)) || [];
    } catch {
      ranked = [];
    }
    latencies.push(performance.now() - t0);

    const recall = {};
    for (const k of ks) recall[k] = recallAtK(ranked, relevant, k);
    perQuery.push({
      query: q.query,
      ranked: ranked.slice(0, 10),
      relevant: [...relevant],
      recall,
      mrr: reciprocalRank(ranked, relevant),
      ndcg10: ndcgAtK(ranked, relevant, 10),
    });
  }

  const aggregate = { queries: queries.length };
  for (const k of ks) {
    aggregate[`recall@${k}`] = mean(perQuery.map((r) => r.recall[k]).filter((v) => v !== null));
  }
  aggregate.mrr = mean(perQuery.map((r) => r.mrr));
  aggregate["ndcg@10"] = mean(perQuery.map((r) => r.ndcg10).filter((v) => v !== null));
  aggregate.latencyP50Ms = percentile(latencies, 50);
  aggregate.latencyP95Ms = percentile(latencies, 95);

  return { aggregate, perQuery };
}

// Compares a fresh aggregate against a stored baseline. Returns the list of
// regressions that exceed `threshold` (absolute), so CI can gate on them.
export function findRegressions(baseline, current, threshold = 0.05) {
  const regressions = [];
  if (!baseline) return regressions;
  for (const key of ["recall@5", "recall@10", "mrr", "ndcg@10"]) {
    if (typeof baseline[key] !== "number" || typeof current[key] !== "number") continue;
    const delta = current[key] - baseline[key];
    if (delta < -threshold) regressions.push({ metric: key, baseline: baseline[key], current: current[key], delta });
  }
  return regressions;
}
