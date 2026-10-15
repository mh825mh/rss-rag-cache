// In-memory vector index.
//
// The semantic half of retrieval used to re-read every `chunks.embedding` BLOB
// and allocate a fresh Float32Array per row on every query. This module loads
// all embeddings once into a single, densely-packed, pre-normalised Float32Array
// so a query becomes one tight dot-product loop with zero per-query allocation.
//
// Correctness notes:
//  - Vectors are L2-normalised at build time, so cosine similarity reduces to a
//    plain dot product with the (also normalised) query vector.
//  - The index is invalidated whenever chunks change (indexEntries / reindexMissing
//    / reembedAll / retention). getVectorIndex() rebuilds lazily on next use.
//  - If the working set would exceed MAX_INDEX_BYTES, getVectorIndex() returns
//    null and callers fall back to the streaming SQL scan.
import { getDb } from "./db.js";
import { bufferToFloat32, vectorNorm } from "./embedder.js";

// Default ceiling for the resident matrix (ids + entryIds + float32 matrix).
// ~64 MB holds ~20k chunks at 768 dims. Override with RSS_RAG_INDEX_MAX_MB.
const DEFAULT_MAX_MB = Number(process.env.RSS_RAG_INDEX_MAX_MB) || 256;
const MAX_INDEX_BYTES = DEFAULT_MAX_MB * 1024 * 1024;

let cache = null;
let cachedMaxBytes = MAX_INDEX_BYTES;

export function invalidateVectorIndex() {
  cache = null;
}

export function vectorIndexStats() {
  if (!cache) return { built: false, count: 0, dim: 0, bytes: 0 };
  return { built: true, count: cache.count, dim: cache.dim, bytes: cache.mat.byteLength };
}

// Builds (or returns the cached) index. Returns null when there is nothing to
// index or when the matrix would exceed the memory ceiling.
export function getVectorIndex() {
  if (cache) return cache;
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, entry_id, embedding, norm FROM chunks WHERE embedding IS NOT NULL ORDER BY id`,
  ).all();
  if (!rows.length) {
    cache = { dim: 0, count: 0, ids: new Int32Array(0), entryIds: new Int32Array(0), mat: new Float32Array(0) };
    return cache;
  }

  const dim = bufferToFloat32(rows[0].embedding).length;
  if (!dim) {
    cache = { dim: 0, count: 0, ids: new Int32Array(0), entryIds: new Int32Array(0), mat: new Float32Array(0) };
    return cache;
  }
  // ids + entryIds (4 B each) + matrix (4 B per component).
  const estBytes = rows.length * (8 + dim * 4);
  if (estBytes > cachedMaxBytes) {
    cache = null; // signal: too big to keep resident, use the streaming scan
    return null;
  }

  const ids = new Int32Array(rows.length);
  const entryIds = new Int32Array(rows.length);
  const mat = new Float32Array(rows.length * dim);
  let n = 0;
  for (const r of rows) {
    const v = bufferToFloat32(r.embedding);
    if (v.length !== dim) continue; // skip vectors from a different model/dim
    const nb = Number.isFinite(r.norm) && r.norm ? r.norm : vectorNorm(v);
    const off = n * dim;
    if (nb) {
      for (let i = 0; i < dim; i++) mat[off + i] = v[i] / nb;
    } else {
      mat.set(v, off);
    }
    ids[n] = Number(r.id);
    entryIds[n] = Number(r.entry_id);
    n++;
  }

  cache = {
    dim,
    count: n,
    ids: ids.subarray(0, n),
    entryIds: entryIds.subarray(0, n),
    mat: n === rows.length ? mat : mat.subarray(0, n * dim),
  };
  return cache;
}

function siftUp(heap, i) {
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heap[p].score <= heap[i].score) break;
    [heap[p], heap[i]] = [heap[i], heap[p]];
    i = p;
  }
}

function siftDown(heap, i) {
  const n = heap.length;
  for (;;) {
    const l = 2 * i + 1;
    const r = 2 * i + 2;
    let s = i;
    if (l < n && heap[l].score < heap[s].score) s = l;
    if (r < n && heap[r].score < heap[s].score) s = r;
    if (s === i) break;
    [heap[i], heap[s]] = [heap[s], heap[i]];
    i = s;
  }
}

// Returns the top-k chunks by cosine similarity, best first, or null when the
// index is unavailable (caller should fall back to the streaming scan).
export function searchVectors(qVec, k) {
  const idx = getVectorIndex();
  if (!idx || !idx.count || qVec.length !== idx.dim) return null;
  const { dim, count, mat, ids, entryIds } = idx;

  let qNorm = 0;
  for (let i = 0; i < dim; i++) qNorm += qVec[i] * qVec[i];
  qNorm = Math.sqrt(qNorm) || 1;
  const q = new Float32Array(dim);
  for (let i = 0; i < dim; i++) q[i] = qVec[i] / qNorm;

  const heap = [];
  for (let r = 0; r < count; r++) {
    const off = r * dim;
    let d = 0;
    for (let i = 0; i < dim; i++) d += q[i] * mat[off + i];
    if (!(d > 0)) continue;
    if (heap.length < k) {
      heap.push({ cid: ids[r], entryId: entryIds[r], score: d });
      siftUp(heap, heap.length - 1);
    } else if (d > heap[0].score) {
      heap[0] = { cid: ids[r], entryId: entryIds[r], score: d };
      siftDown(heap, 0);
    }
  }
  heap.sort((a, b) => b.score - a.score);
  return heap;
}
