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
const GROWTH_FACTOR = 1.15;
const TOMBSTONE_REBUILD_RATIO = 0.20;

let cache = null;
let cachedMaxBytes = MAX_INDEX_BYTES;

export function invalidateVectorIndex() {
  cache = null;
}

function emptyIndex() {
  return {
    dim: 0,
    count: 0,
    liveCount: 0,
    allocCount: 0,
    ids: new Int32Array(0),
    entryIds: new Int32Array(0),
    mat: new Float32Array(0),
    tombstones: new Uint8Array(0),
    entrySlots: new Map(),
    freeList: [],
  };
}

export function vectorIndexStats() {
  if (!cache) return { built: false, count: 0, dim: 0, bytes: 0, tombstones: 0, capacity: 0 };
  return {
    built: true,
    count: cache.liveCount,
    dim: cache.dim,
    bytes: cache.mat.byteLength,
    tombstones: cache.allocCount - cache.liveCount,
    capacity: cache.allocCount,
  };
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
    cache = emptyIndex();
    return cache;
  }

  const dim = bufferToFloat32(rows[0].embedding).length;
  if (!dim) {
    cache = emptyIndex();
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

  // Over-allocate ~15% so refresh_rss_feeds can append new chunks without a
  // full reload, capped by the memory ceiling set by RSS_RAG_INDEX_MAX_MB.
  const perSlot = 8 + dim * 4; // ids + entryIds (4 B each) + vector components
  const desired = Math.max(n, Math.ceil(n * GROWTH_FACTOR));
  const maxSlots = Math.max(n, Math.floor(cachedMaxBytes / perSlot));
  const allocCount = Math.min(desired, maxSlots);

  const allocMat = new Float32Array(allocCount * dim);
  allocMat.set(n === rows.length ? mat : mat.subarray(0, n * dim));
  const allocIds = new Int32Array(allocCount);
  allocIds.set(ids.subarray(0, n));
  const allocEntryIds = new Int32Array(allocCount);
  allocEntryIds.set(entryIds.subarray(0, n));
  const tombstones = new Uint8Array(allocCount);
  const entrySlots = new Map();
  for (let i = 0; i < n; i++) {
    const eid = allocEntryIds[i];
    if (!entrySlots.has(eid)) entrySlots.set(eid, []);
    entrySlots.get(eid).push(i);
  }

  // Spare slots start tombstoned and go on the free list for O(1) reuse.
  const freeList = [];
  for (let i = allocCount - 1; i >= n; i--) {
    tombstones[i] = 1;
    freeList.push(i);
  }

  cache = {
    dim,
    count: n,
    liveCount: n,
    allocCount,
    ids: allocIds,
    entryIds: allocEntryIds,
    mat: allocMat,
    tombstones,
    entrySlots,
    freeList,
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
// index is unavailable (caller should fall back to the streaming scan). When
// `allowedEntryIds` is a Set, only chunks whose entry is in it are considered
// (used to push search filters into candidate generation).
export function searchVectors(qVec, k, allowedEntryIds = null) {
  const idx = getVectorIndex();
  if (!idx) return null; // index unavailable -> caller falls back to streaming
  if (!qVec.length || qVec.length !== idx.dim) return null;
  if (!idx.liveCount) return []; // resident index is authoritative: no matches
  const { dim, mat, ids, entryIds, tombstones } = idx;
  const restrict = allowedEntryIds instanceof Set;
  const limit = idx.allocCount;

  if (restrict && allowedEntryIds.size === 0) return [];

  let qNorm = 0;
  for (let i = 0; i < dim; i++) qNorm += qVec[i] * qVec[i];
  qNorm = Math.sqrt(qNorm) || 1;
  const q = new Float32Array(dim);
  for (let i = 0; i < dim; i++) q[i] = qVec[i] / qNorm;

  const heap = [];
  for (let r = 0; r < limit; r++) {
    if (tombstones && tombstones[r]) continue;
    if (restrict && !allowedEntryIds.has(entryIds[r])) continue;
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

// A rebuild/compaction is cheaper than letting dead slots dominate: trigger one
// once tombstoned slots exceed 20% of the allocated capacity.
function shouldCompact(idx) {
  if (!idx || !idx.allocCount) return false;
  return idx.allocCount - idx.liveCount > idx.allocCount * TOMBSTONE_REBUILD_RATIO;
}

// Incrementally appends already-embedded chunks to the resident index. Used
// after a refresh instead of discarding the whole matrix. Vectors are normalised
// exactly as getVectorIndex() normalises rows loaded from SQLite. Returns the
// number of chunks appended; if the index was unavailable or incompatible the
// caller should fall back to a full reload (invalidateVectorIndex()).
export function appendChunks(chunksWithVectors = []) {
  if (!chunksWithVectors.length) return 0;
  let idx = getVectorIndex();
  if (!idx) return 0;
  if (idx.dim === 0 && idx.allocCount > 0) {
    invalidateVectorIndex();
    idx = getVectorIndex();
    if (!idx) return 0;
  }
  if (!idx.dim) return 0;

  let appended = 0;
  for (const c of chunksWithVectors) {
    if (!c || c.vector == null) continue;
    const vec = c.vector instanceof Float32Array ? c.vector : new Float32Array(c.vector);
    if (vec.length !== idx.dim) {
      // Model/dimension changed: the whole matrix is no longer usable.
      invalidateVectorIndex();
      return appended;
    }
    if (!idx.freeList.length) {
      // No spare slot; a rebuild folds tombstones and picks up the new rows.
      invalidateVectorIndex();
      return appended;
    }
    const slot = idx.freeList.pop();
    const off = slot * idx.dim;
    const nb = vectorNorm(vec);
    if (nb) {
      for (let i = 0; i < idx.dim; i++) idx.mat[off + i] = vec[i] / nb;
    } else {
      idx.mat.set(vec, off);
    }
    idx.ids[slot] = c.id != null ? c.id : 0;
    idx.entryIds[slot] = c.entryId != null ? c.entryId : 0;
    idx.tombstones[slot] = 0;
    if (c.entryId != null) {
      if (!idx.entrySlots.has(c.entryId)) idx.entrySlots.set(c.entryId, []);
      idx.entrySlots.get(c.entryId).push(slot);
    }
    idx.liveCount++;
    appended++;
  }
  idx.count = idx.liveCount;
  if (shouldCompact(idx)) invalidateVectorIndex();
  return appended;
}

// Flips the tombstone bit for every chunk belonging to the given entries. The
// dead slots are reused by a later appendChunks() and reclaimed in bulk by
// compaction; no SQLite rows are touched here. Returns the number tombstoned.
export function removeEntries(entryIds = []) {
  const idx = cache;
  if (!idx || !idx.entrySlots || !entryIds.length) return 0;
  let removed = 0;
  for (const eid of entryIds) {
    const slots = idx.entrySlots.get(eid);
    if (!slots || !slots.length) continue;
    for (const s of slots) {
      if (!idx.tombstones[s]) {
        idx.tombstones[s] = 1;
        idx.freeList.push(s);
        idx.liveCount--;
        removed++;
      }
    }
    idx.entrySlots.delete(eid);
  }
  idx.count = idx.liveCount;
  if (removed && shouldCompact(idx)) invalidateVectorIndex();
  return removed;
}

export function vectorIndex() {
  return cache;
}
