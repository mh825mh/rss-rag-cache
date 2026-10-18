# RSS RAG Cache - Codebase Snapshot & Eval Baseline

## Current Eval Baseline
```text
npm notice run rss-rag-cache@1.5.0 eval
npm notice run node --no-warnings test/eval/run.js
[rss-rag] Rebuilding full-text index with trigram tokenizer...
[rss-rag] Building English (porter) full-text index...
[eval] indexed 14 entries (0 updated)

=== RSS RAG Cache ΓÇö retrieval eval ===
queries: 12
recall@1  0.750
recall@3  0.750
recall@5  0.792
recall@10 0.917
mrr       0.781
ndcg@10   0.820
latency   p50 3.55ms  p95 10.72ms

missed queries (recall@10 < 1):
  ΓÇó crampons harnesses alpine climbing  ΓåÆ ranked ["wine","startup-funding","telescope","solar","quantum","coral-reef","wildfire","ai-models","battery","deep-sea"] (want ["hiking-gear"])

no regressions vs baseline.
```

## Local Cache DB Status
- Path: `C:\Users\mh825\.lmstudio\plugin-data\rss-rag-cache\cache.db`
- Size: **0 MB**


### File: `C:\Users\mh825\rss-rag v1\src\config.ts`
```typescript

```

### File: `C:\Users\mh825\rss-rag v1\src\index.ts`
```typescript

```

### File: `C:\Users\mh825\rss-rag v1\src\toolsProvider.ts`
```typescript

```
