import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the plugin at an isolated data directory *before* importing any module
// that reads the config (config.js resolves the dir at import time).
const dataDir = mkdtempSync(join(tmpdir(), "rss-rag-vec-"));
process.env.RSS_RAG_DATA_DIR = dataDir;

const { getDb, closeDb } = await import("../lib/db.js");
const { float32ToBuffer } = await import("../lib/embedder.js");
const {
  appendChunks,
  removeEntries,
  searchVectors,
  getVectorIndex,
  invalidateVectorIndex,
  vectorIndexStats,
} = await import("../lib/vectorIndex.js");

after(() => {
  closeDb();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const DIM = 8;
const unit = (i) => {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return v;
};

test("appendChunks and removeEntries update search results in under 2ms without querying SQLite", () => {
  const db = getDb();
  db.exec("DELETE FROM chunks; DELETE FROM entries;");

  const now = Date.now();
  const eA = Number(db.prepare(`INSERT INTO entries (title, content, cached_at) VALUES ('alpha', 'alpha body', ?)`).run(now).lastInsertRowid);
  const eB = Number(db.prepare(`INSERT INTO entries (title, content, cached_at) VALUES ('beta', 'beta body', ?)`).run(now).lastInsertRowid);

  const vA = unit(0); // dim 0 — the bulk of the corpus
  const vB = unit(1); // dim 1 — the entry we will append/remove
  const insChunk = db.prepare(`INSERT INTO chunks (entry_id, chunk_index, text, embedding) VALUES (?, ?, ?, ?)`);
  for (let i = 0; i < 40; i++) insChunk.run(eA, i, `alpha ${i}`, float32ToBuffer(vA));
  insChunk.run(eB, 0, "beta 0", float32ToBuffer(vB));

  invalidateVectorIndex();
  const idx = getVectorIndex();
  assert.ok(idx, "index should build from SQLite");
  assert.equal(idx.liveCount, 41);
  assert.ok(idx.allocCount > idx.liveCount, "index over-allocates spare capacity");
  assert.equal(idx.allocCount - idx.liveCount - idx.freeList.length, 0, "headroom is all on the free list");

  const qA = [1, 0, 0, 0, 0, 0, 0, 0];
  const qB = [0, 1, 0, 0, 0, 0, 0, 0];
  // Warm-up so JIT/heap setup is not billed to the timed section.
  assert.equal(searchVectors(qB, 5).length, 1, "beta chunk matches its query");
  assert.equal(searchVectors(qA, 5).length, 5);

  // Anything below would prove the increment path reached into SQLite.
  const originalPrepare = db.prepare;
  db.prepare = () => { throw new Error("SQLite queried during in-memory index update"); };
  let appended = 0;
  let removed = 0;
  let betaAfterAppend = 0;
  let betaAfterRemove = -1;
  let alphaAfterRemove = -1;
  const start = performance.now();
  try {
    appended = appendChunks([{ id: 9001, entryId: eB, vector: vB }]);
    betaAfterAppend = searchVectors(qB, 5).length;
    removed = removeEntries([eB]);
    betaAfterRemove = searchVectors(qB, 5).length;
    alphaAfterRemove = searchVectors(qA, 5).length;
  } finally {
    db.prepare = originalPrepare;
  }
  const elapsed = performance.now() - start;

  assert.equal(appended, 1, "appendChunks added the new chunk");
  assert.equal(betaAfterAppend, 2, "appended chunk is visible to search immediately");
  assert.equal(removed, 2, "removeEntries tombstoned every slot for the entry");
  assert.equal(betaAfterRemove, 0, "removed chunk no longer matches");
  assert.equal(alphaAfterRemove, 5, "unrelated chunks are untouched");

  assert.ok(elapsed < 2, `append + search + remove + search took ${elapsed.toFixed(3)}ms (expected < 2ms)`);

  const stats = vectorIndexStats();
  assert.equal(stats.built, true);
  assert.equal(stats.count, 40, "live count reflects the removal");
  assert.equal(stats.capacity, stats.count + stats.tombstones, "capacity = live + tombstoned");
  assert.ok(stats.tombstones / stats.capacity <= 0.2, "still below the compaction threshold");
});

test("tombstoned slots beyond 20% of capacity trigger a compaction rebuild", () => {
  const db = getDb();
  db.exec("DELETE FROM chunks; DELETE FROM entries;");

  const now = Date.now();
  const insChunk = db.prepare(`INSERT INTO chunks (entry_id, chunk_index, text, embedding) VALUES (?, ?, ?, ?)`);
  const entries = [];
  for (let e = 0; e < 8; e++) {
    const id = Number(db.prepare(`INSERT INTO entries (title, content, cached_at) VALUES (?, 'x', ?)`).run(`e${e}`, now).lastInsertRowid);
    for (let c = 0; c < 10; c++) insChunk.run(id, c, `t${c}`, float32ToBuffer(unit(c % DIM)));
    entries.push(id);
  }

  invalidateVectorIndex();
  const idx = getVectorIndex();
  assert.equal(idx.liveCount, 80);

  // Drop most of the corpus: dead slots exceed 20% of capacity, so the index
  // self-invalidates and the next query compacts it (rebuilds from SQLite).
  const doomed = entries.slice(0, 7);
  db.prepare(`DELETE FROM entries WHERE id IN (${doomed.map(() => "?").join(",")})`).run(...doomed);
  removeEntries(doomed);

  assert.equal(vectorIndexStats().built, false, "index invalidated for compaction");

  const rebuilt = getVectorIndex();
  assert.equal(rebuilt.liveCount, 10, "compacted index only holds the surviving entry");
  const deadSlots = rebuilt.tombstones.reduce((a, b) => a + b, 0);
  assert.equal(deadSlots, rebuilt.allocCount - rebuilt.liveCount, "only spare-capacity slots are dead");
  assert.ok(deadSlots / rebuilt.allocCount <= 0.2, "compaction leaves the index under the 20% threshold");
  assert.ok(rebuilt.freeList.length > 0, "compacted index still has spare capacity");
});
