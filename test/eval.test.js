import { test } from "node:test";
import assert from "node:assert/strict";
import { recallAtK, reciprocalRank, ndcgAtK, percentile, findRegressions, runEval } from "../lib/eval.js";

test("recallAtK counts relevant items in the top k", () => {
  const ranked = ["a", "b", "c", "d"];
  const relevant = new Set(["b", "d"]);
  assert.equal(recallAtK(ranked, relevant, 1), 0);
  assert.equal(recallAtK(ranked, relevant, 2), 0.5);
  assert.equal(recallAtK(ranked, relevant, 4), 1);
  assert.equal(recallAtK(ranked, new Set(), 4), null);
});

test("reciprocalRank returns 1/rank of the first relevant item", () => {
  assert.equal(reciprocalRank(["x", "y", "z"], new Set(["y"])), 0.5);
  assert.equal(reciprocalRank(["z", "y", "x"], new Set(["z"])), 1);
  assert.equal(reciprocalRank(["x"], new Set(["nope"])), 0);
});

test("ndcgAtK is 1 for a perfect ranking and lower otherwise", () => {
  const relevant = new Set(["a", "b"]);
  assert.equal(ndcgAtK(["a", "b", "c"], relevant, 10), 1);
  const worse = ndcgAtK(["c", "a", "b"], relevant, 10);
  assert.ok(worse > 0 && worse < 1);
});

test("percentile uses the nearest rank", () => {
  const vals = [10, 20, 30, 40];
  assert.equal(percentile(vals, 50), 20);
  assert.equal(percentile(vals, 95), 40);
  assert.equal(percentile([], 50), 0);
});

test("findRegressions flags metric drops beyond the threshold", () => {
  const baseline = { "recall@5": 0.9, "recall@10": 0.95, mrr: 0.8, "ndcg@10": 0.85 };
  const ok = findRegressions(baseline, { "recall@5": 0.88, "recall@10": 0.94, mrr: 0.79, "ndcg@10": 0.83 });
  assert.equal(ok.length, 0);
  const bad = findRegressions(baseline, { "recall@5": 0.5, "recall@10": 0.6, mrr: 0.4, "ndcg@10": 0.5 });
  assert.equal(bad.length, 4);
});

test("runEval aggregates per-query metrics and latency", async () => {
  const queries = [
    { query: "q1", relevant: ["a"] },
    { query: "q2", relevant: ["b"] },
  ];
  const answers = { q1: ["a", "x"], q2: ["x", "b"] };
  const { aggregate, perQuery } = await runEval({ queries, search: async (q) => answers[q] });
  assert.equal(aggregate.queries, 2);
  assert.equal(aggregate["recall@1"], 0.5); // only q1 hit at rank 1
  assert.equal(aggregate["recall@5"], 1);
  assert.equal(aggregate.mrr, 0.75); // (1 + 0.5) / 2
  assert.ok(aggregate.latencyP95Ms >= 0);
  assert.equal(perQuery.length, 2);
});
