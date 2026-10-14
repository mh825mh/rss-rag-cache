import { getDb, setMeta, getMeta, getAllFeedStates, saveFeedState } from "./db.js";
import { embed, bufferToFloat32, float32ToBuffer, vectorNorm } from "./embedder.js";
import { titleKey } from "./parser.js";

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 120;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per-feed failure backoff: 15 min, doubling, capped at 24 h.
const BACKOFF_BASE_MS = 15 * 60 * 1000;
const BACKOFF_MAX_MS = 24 * 3600 * 1000;

// Meta keys recording which embedding model/dim produced the stored vectors, so
// a model swap is detected instead of silently degrading to keyword-only search
// (similarity() returns 0 on a dimension mismatch).
const META_MODEL = "embedding_model";
const META_DIM = "embedding_dim";

// node:sqlite rejects `undefined` bindings; normalise optional fields to null.
const nn = (v) => (v === undefined ? null : v);

export function chunkText(text, chunkSize = CHUNK_SIZE, chunkOverlap = CHUNK_OVERLAP) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const step = Math.max(1, chunkSize - chunkOverlap);
  const out = [];
  for (let i = 0; i < clean.length; i += step) {
    out.push(clean.slice(i, i + chunkSize));
    if (i + chunkSize >= clean.length) break;
  }
  return out;
}

// Escapes a user query into tokens safe for an FTS5 MATCH expression, so a
// query with `(`, `:`, `-`, quotes, or reserved words cannot crash the search.
export function sanitizeFts(query) {
  const tokens = (query || "").match(/[\p{L}\p{N}]{1,24}/gu) || [];
  const cleaned = tokens.slice(0, 8);
  if (!cleaned.length) return "a";
  // Trigram tokenizer ignores <3-char terms; keep short tokens from breaking MATCH.
  return cleaned.map((t) => `"${t}"`).join(" ");
}

function isoDate(ts) {
  return Number.isFinite(ts) ? new Date(ts).toISOString() : new Date(Date.now()).toISOString();
}

function asBool(v) {
  return v === true || v === "true";
}

function combinedText(entry) {
  return `${entry.title ?? ""}\n\n${entry.summary ?? ""}\n\n${entry.content ?? ""}`;
}

// Records the model/dimension that produced stored vectors, so a later model
// swap can be detected instead of silently degrading to keyword-only search.
function recordEmbeddingMeta(vectors, settings) {
  const vec = (vectors || []).find((v) => v && v.length);
  if (!vec) return;
  const dim = String(vec.length);
  const prevDim = getMeta(META_DIM);
  if (prevDim && prevDim !== dim) {
    console.warn(`[rss-rag] Embedding dimension changed (${prevDim} -> ${dim}); run reembed_all to rebuild the index with the new model.`);
  }
  setMeta(META_DIM, dim);
  if (settings?.embeddingModel) setMeta(META_MODEL, settings.embeddingModel);
}

// Compares the configured model/dimension with what the cache was built with.
// Returns a human-readable warning (or null) rather than throwing.
export function embeddingCompatibilityWarning(settings, queryDim = null) {
  const prevDim = getMeta(META_DIM);
  const prevModel = getMeta(META_MODEL);
  if (prevDim && queryDim && String(queryDim) !== String(prevDim)) {
    return `Embedding dimension mismatch: cache holds ${prevDim}-dim vectors (${prevModel ?? "unknown model"}) but the current model returned ${queryDim}. Run reembed_all.`;
  }
  if (prevModel && settings?.embeddingModel && prevModel !== settings.embeddingModel) {
    return `Embedding model changed from "${prevModel}" to "${settings.embeddingModel}"; existing vectors may be incomparable. Run reembed_all to rebuild.`;
  }
  return null;
}

let lastCompatWarn = null;
function warnCompatOnce(msg) {
  if (!msg || msg === lastCompatWarn) return;
  lastCompatWarn = msg;
  console.warn(`[rss-rag] ${msg}`);
}

// Returns a window of `width` chars centred on the first query token found in
// the text, so the snippet shows the matching passage rather than the opening.
function makeSnippet(text, query, width = 600) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= width) return t;
  const tokens = (String(query || "").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).slice(0, 12);
  const lower = t.toLowerCase();
  let idx = -1;
  for (const tok of tokens) {
    idx = lower.indexOf(tok);
    if (idx >= 0) break;
  }
  if (idx < 0) return t.slice(0, width);
  const start = Math.max(0, idx - Math.floor(width / 3));
  return (start > 0 ? "…" : "") + t.slice(start, start + width) + (start + width < t.length ? "…" : "");
}

// Gentle recency boost: 1.0 for brand-new items, ~0.37 at 30 days, ~0.05 at 90.
function recencyFactor(pubDate, now) {
  const ts = Number(pubDate);
  if (!Number.isFinite(ts)) return 0;
  const ageDays = Math.max(0, (now - ts) / 86400e3);
  return Math.exp(-ageDays / 30);
}

function titleTokenSet(title) {
  const s = new Set();
  for (const tok of String(title || "").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []) s.add(tok);
  return s;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Maximal Marginal Relevance over already-ranked candidates. Inter-entry
// similarity is approximated by title-token Jaccard (cheap, and enough to stop
// syndicated/near-identical headlines from crowding out distinct results).
function mmrSelect(items, k, lambda = 0.7) {
  const pool = items.slice().sort((a, b) => b.combined - a.combined);
  const selected = [];
  while (selected.length < Math.max(1, k) && pool.length) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      let maxSim = 0;
      for (const s of selected) {
        const sim = jaccard(pool[i].titleSet, s.titleSet);
        if (sim > maxSim) maxSim = sim;
      }
      const val = lambda * pool[i].combined - (1 - lambda) * maxSim;
      if (val > bestVal) { bestVal = val; bestIdx = i; }
    }
    selected.push(pool.splice(bestIdx, 1)[0]);
  }
  return selected;
}

// Cosine similarity using the query norm (computed once) and the chunk's stored
// L2 norm, so the scan does not re-derive norms for every row. Returns 0 for a
// dimension mismatch (e.g. chunks embedded with a different model).
function similarity(qVec, qNorm, embeddingBlob, storedNorm) {
  const v = bufferToFloat32(embeddingBlob);
  if (v.length !== qVec.length) return 0;
  let d = 0;
  for (let i = 0; i < v.length; i++) d += qVec[i] * v[i];
  const nb = Number.isFinite(storedNorm) ? storedNorm : vectorNorm(v);
  return qNorm && nb ? d / (qNorm * nb) : 0;
}

// --- Bounded min-heap (size k) to keep the top-k similarities without sorting
// the whole candidate set on every insertion.
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
function heapOffer(heap, item, k) {
  if (heap.length < k) {
    heap.push(item);
    siftUp(heap, heap.length - 1);
  } else if (item.score > heap[0].score) {
    heap[0] = item;
    siftDown(heap, 0);
  }
}

export async function indexEntry(entry, settings) {
  const db = getDb();
  const chunkSize = settings.chunkSize || CHUNK_SIZE;
  const ins = db.prepare(`
    INSERT OR IGNORE INTO entries (guid, feed_url, title, link, author, pub_date, summary, content, title_key, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  const info = ins.run(nn(entry.guid), nn(entry.feed_url), nn(entry.title), nn(entry.link), nn(entry.author), nn(entry.pub_date), nn(entry.summary), nn(entry.content), titleKey(entry.title), now);
  if (info.changes === 0) return false;

  const entryId = info.lastInsertRowid;
  const chunks = chunkText(combinedText(entry), chunkSize);
  if (!chunks.length) return true;

  const vectors = await embed(chunks, { baseUrl: settings.lmStudioBaseUrl, model: settings.embeddingModel, batchSize: settings.embedBatchSize || 16 });

  const insChunk = db.prepare(`INSERT INTO chunks (entry_id, chunk_index, text, embedding, norm) VALUES (?, ?, ?, ?, ?)`);
  db.exec("BEGIN");
  try {
    for (let idx = 0; idx < chunks.length; idx++) {
      const vec = vectors[idx];
      insChunk.run(entryId, idx, chunks[idx], vec ? float32ToBuffer(vec) : null, vec ? vectorNorm(vec) : null);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  return true;
}

// Batch indexing across many entries. Embedding happens *before* any write so a
// failed/slow embedding call can never leave a half-indexed entry in the DB
// (previously entries were committed first, then embedded, which is why 1,069
// entries ended up with zero chunks). All writes then happen in one transaction.
export async function indexEntries(items, settings) {
  const db = getDb();
  const chunkSize = settings.chunkSize || CHUNK_SIZE;

  // 1) Cheap pre-filter: dedup by guid/title without writing anything.
  const existsGuid = db.prepare(`SELECT 1 FROM entries WHERE guid = ? LIMIT 1`);
  const existsTitle = db.prepare(`SELECT 1 FROM entries WHERE title_key = ? LIMIT 1`);
  const seenGuid = new Set();
  const seenTitle = new Set();

  const pending = [];
  for (const entry of items) {
    if (!entry?.title && !entry?.content) continue;
    const guid = entry.guid ?? null;
    const tk = titleKey(entry.title);
    if (guid && (seenGuid.has(guid) || existsGuid.get(guid))) continue;
    if (tk && (seenTitle.has(tk) || existsTitle.get(tk))) continue;
    if (guid) seenGuid.add(guid);
    if (tk) seenTitle.add(tk);
    pending.push({ entry, chunks: chunkText(combinedText(entry), chunkSize) });
  }
  if (!pending.length) return { added: 0 };

  // 2) Embed everything up front (no DB writes yet), preserving chunk order.
  const texts = [];
  for (const p of pending) for (const t of p.chunks) texts.push(t);

  let vectors = [];
  if (texts.length) {
    vectors = await embed(texts, {
      baseUrl: settings.lmStudioBaseUrl,
      model: settings.embeddingModel,
      batchSize: settings.embedBatchSize || 16,
    });
    recordEmbeddingMeta(vectors, settings);
  }

  // 3) Single atomic transaction for entries + chunks.
  const ins = db.prepare(`
    INSERT OR IGNORE INTO entries (guid, feed_url, title, link, author, pub_date, summary, content, title_key, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insChunk = db.prepare(`INSERT INTO chunks (entry_id, chunk_index, text, embedding, norm) VALUES (?, ?, ?, ?, ?)`);
  const now = Date.now();

  let added = 0;
  let vi = 0;
  db.exec("BEGIN");
  try {
    for (const p of pending) {
      const entry = p.entry;
      const n = p.chunks.length;
      const info = ins.run(
        nn(entry.guid), nn(entry.feed_url), nn(entry.title), nn(entry.link), nn(entry.author),
        nn(entry.pub_date), nn(entry.summary), nn(entry.content), titleKey(entry.title), now,
      );
      if (info.changes === 0) {
        // Lost a race on guid/title_key; still advance the vector cursor.
        vi += n;
        continue;
      }
      const entryId = Number(info.lastInsertRowid);
      for (let c = 0; c < n; c++) {
        const vec = vectors[vi++];
        insChunk.run(entryId, c, p.chunks[c], vec ? float32ToBuffer(vec) : null, vec ? vectorNorm(vec) : null);
      }
      added++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  return { added };
}

// Re-embeds chunks stored text-only (embedding NULL) and, importantly, re-chunks
// entries that were left with zero chunks by the old non-atomic indexer.
export async function reindexMissing(settings, limit = 2000) {
  const db = getDb();
  const embedOpts = {
    baseUrl: settings.lmStudioBaseUrl,
    model: settings.embeddingModel,
    batchSize: settings.embedBatchSize || 16,
  };

  // A) Fill in missing embeddings.
  const rows = db.prepare(`SELECT id, text FROM chunks WHERE embedding IS NULL ORDER BY id LIMIT ?`).all(limit);
  let updated = 0;
  if (rows.length) {
    const vectors = await embed(rows.map((r) => r.text), embedOpts);
    recordEmbeddingMeta(vectors, settings);
    const upd = db.prepare(`UPDATE chunks SET embedding = ?, norm = ? WHERE id = ?`);
    db.exec("BEGIN");
    try {
      for (let i = 0; i < rows.length; i++) {
        const vec = vectors[i];
        if (!vec) continue;
        upd.run(float32ToBuffer(vec), vectorNorm(vec), rows[i].id);
        updated++;
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  // B) Re-chunk entries that have no chunks at all (the old indexer could leave
  // these behind whenever embedding failed or the process died mid-refresh).
  const orphans = db.prepare(`
    SELECT e.id, e.title, e.summary, e.content
    FROM entries e
    WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.entry_id = e.id)
    ORDER BY e.id
    LIMIT ?
  `).all(limit);

  let entriesRechunked = 0;
  if (orphans.length) {
    const jobs = [];
    for (const e of orphans) {
      chunkText(`${e.title ?? ""}\n\n${e.summary ?? ""}\n\n${e.content ?? ""}`, settings.chunkSize || CHUNK_SIZE)
        .forEach((text, idx) => jobs.push({ entryId: e.id, chunkIndex: idx, text }));
    }
    if (jobs.length) {
      const vectors = await embed(jobs.map((j) => j.text), embedOpts);
      recordEmbeddingMeta(vectors, settings);
      const insChunk = db.prepare(`INSERT INTO chunks (entry_id, chunk_index, text, embedding, norm) VALUES (?, ?, ?, ?, ?)`);
      db.exec("BEGIN");
      try {
        for (let i = 0; i < jobs.length; i++) {
          const vec = vectors[i];
          insChunk.run(jobs[i].entryId, jobs[i].chunkIndex, jobs[i].text, vec ? float32ToBuffer(vec) : null, vec ? vectorNorm(vec) : null);
        }
        db.exec("COMMIT");
        entriesRechunked = orphans.length;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
  }

  const remaining = db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NULL`).get().n;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get().n;
  const orphanRemaining = db.prepare(`SELECT COUNT(*) AS n FROM entries e WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.entry_id = e.id)`).get().n;
  return { updated, remaining, total, entriesRechunked, orphanRemaining };
}

// Rebuilds the whole vector index with the currently configured model. This is
// the repair path after changing embedding model/dimension: existing vectors
// are not comparable to the new model's, so they must all be recomputed.
// Reuses reindexMissing in batches and stops early if embedding is failing
// (otherwise it would spin for maxBatches with zero progress).
export async function reembedAll(settings, { batchSize = 500, maxBatches = 10000, rechunk = false } = {}) {
  const db = getDb();
  if (rechunk) {
    db.prepare(`DELETE FROM chunks`).run(); // force a full re-chunk (new chunkSize)
  } else {
    db.prepare(`UPDATE chunks SET embedding = NULL, norm = NULL`).run();
  }
  try {
    db.prepare(`DELETE FROM meta WHERE key IN (?, ?)`).run(META_MODEL, META_DIM);
  } catch { /* ignore */ }

  let updated = 0;
  let entriesRechunked = 0;
  let batches = 0;
  let remaining = 0;
  let orphanRemaining = 0;
  let prevRemaining = Infinity;
  let prevOrphans = Infinity;

  for (; batches < maxBatches; batches++) {
    const res = await reindexMissing(settings, batchSize);
    updated += res.updated;
    entriesRechunked += res.entriesRechunked;
    remaining = res.remaining;
    orphanRemaining = res.orphanRemaining;

    if (remaining === 0 && orphanRemaining === 0) break;
    const progressed =
      res.updated > 0 || res.entriesRechunked > 0 ||
      res.remaining < prevRemaining || res.orphanRemaining < prevOrphans;
    prevRemaining = res.remaining;
    prevOrphans = res.orphanRemaining;
    if (!progressed) break; // embedding endpoint is failing; avoid a futile loop
  }

  return { updated, entriesRechunked, batches, remaining, orphanRemaining, rechunked: !!rechunk, complete: remaining === 0 && orphanRemaining === 0 };
}

export async function refreshFeeds(settings, feeds, opts = {}) {
  const { fetchAll, fetchArticleContent } = await import("./fetcher.js");
  const force = !!opts.force;
  const startTime = Date.now();
  const feedStates = getAllFeedStates();
  const results = await fetchAll(feeds, settings, { feedStates, force });
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  let added = 0;
  const failedFeeds = [];
  const skippedFeeds = [];
  const notModifiedFeeds = [];
  const slowSuccessFeeds = [];
  let fastSuccessCount = 0;

  const allItems = [];
  const slowItems = [];

  // Persists HTTP validators + health for one feed, merging with any previous
  // state so a 304 (which need not echo validators) doesn't erase them.
  const persist = (url, patch) => {
    const prev = feedStates.get(url) || {};
    saveFeedState({
      url,
      etag: patch.etag !== undefined ? patch.etag : prev.etag,
      last_modified: patch.lastModified !== undefined ? patch.lastModified : prev.last_modified,
      last_fetched: Date.now(),
      last_status: patch.status !== undefined ? patch.status : prev.last_status ?? null,
      fail_count: patch.failCount !== undefined ? patch.failCount : prev.fail_count ?? 0,
      next_retry_at: patch.nextRetryAt !== undefined ? patch.nextRetryAt : prev.next_retry_at ?? null,
      last_error: patch.error !== undefined ? patch.error : prev.last_error ?? null,
    });
  };

  for (const r of results) {
    if (r.skipped) {
      skippedFeeds.push({ url: r.url, error: r.error, mode: r.mode });
      continue;
    }

    if (r.notModified) {
      notModifiedFeeds.push(r.url);
      persist(r.url, { etag: r.etag || undefined, lastModified: r.lastModified || undefined, status: 304, failCount: 0, nextRetryAt: null, error: null });
      if (r.mode === "slow") slowSuccessFeeds.push({ url: r.url, itemsFound: 0, notModified: true });
      else fastSuccessCount++;
      continue;
    }

    if (!r.ok) {
      failedFeeds.push({ url: r.url, error: r.error, status: r.status, mode: r.mode });
      const failCount = (feedStates.get(r.url)?.fail_count || 0) + 1;
      const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (failCount - 1), BACKOFF_MAX_MS);
      persist(r.url, { status: r.status ?? null, failCount, nextRetryAt: Date.now() + backoff, error: r.error });
      continue;
    }

    // Successful (200) fetch: store fresh validators and clear any backoff.
    persist(r.url, { etag: r.etag ?? null, lastModified: r.lastModified ?? null, status: 200, failCount: 0, nextRetryAt: null, error: null });

    if (r.mode === 'slow') {
      slowSuccessFeeds.push({ url: r.url, itemsFound: r.items.length });
      slowItems.push(...r.items);
    } else {
      fastSuccessCount++;
    }
    allItems.push(...r.items);
  }

  // Optional: enrich HTML-scraped items with the full article body (slow/opt-in)
  if (asBool(settings.scrapeFullText) && slowItems.length) {
    console.log(`[rss-rag] Fetching full text for ${slowItems.length} scraped articles (opt-in setting)...`);
    for (let i = 0; i < slowItems.length; i++) {
      const item = slowItems[i];
      try {
        const body = await fetchArticleContent(item.link);
        if (body && body.length > 200) {
          item.content = body;
          item.summary = (item.summary || item.title || "").slice(0, 500);
        }
      } catch (e) {
        console.error(`[rss-rag] Full-text fetch failed for ${item.link}: ${e.message}`);
      }
      if (i < slowItems.length - 1) await sleep(1500 + Math.random() * 1500);
    }
  }

  let indexError = null;
  try {
    const res = await indexEntries(allItems, settings);
    added = res.added;
  } catch (e) {
    indexError = e.message;
    console.error("[rss-rag] Indexing error:", e.message);
  }

  // Baseline completion marker so the auto-refresh interval is honoured even if
  // the caller forgets to write a richer report.
  try {
    setMeta("last_refresh", JSON.stringify({ timestamp: Date.now(), added, totalTimeSeconds: totalTime, indexError }));
  } catch { /* ignore */ }

  return {
    added,
    totalTimeSeconds: totalTime,
    indexError,
    notModified: notModifiedFeeds.length,
    notModifiedFeeds,
    skippedBackoff: skippedFeeds,
    force,
    fastMode: { success: fastSuccessCount, failed: failedFeeds.filter(f => f.mode === 'fast').length },
    slowMode: { success: slowSuccessFeeds.length, failed: failedFeeds.filter(f => f.mode === 'slow').length, details: slowSuccessFeeds },
    failedFeeds: failedFeeds.map(f => ({ url: f.url, error: f.error, status: f.status })),
  };
}

// Single-flight refresh: the startup timer and the manual tool can otherwise
// run concurrently and double-fetch every feed.
let refreshInFlight = null;
export function isRefreshing() {
  return refreshInFlight !== null;
}
export function refreshFeedsShared(settings, feeds, opts = {}) {
  if (!refreshInFlight) {
    refreshInFlight = refreshFeeds(settings, feeds, opts).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export async function retrieve(query, settings, opts = {}) {
  const db = getDb();
  const topK = settings.topK || 8;
  const cutoff = opts.days !== undefined && opts.days !== null ? Date.now() - opts.days * 86400e3 : 0;
  const feedFilter = opts.feed ? String(opts.feed).toLowerCase() : null;
  const authorFilter = opts.author ? String(opts.author).toLowerCase() : null;

  let qVec = null;
  try {
    [qVec] = await embed([query], { baseUrl: settings.lmStudioBaseUrl, model: settings.embeddingModel });
  } catch (e) {
    console.error("[rss-rag] Query embedding failed, using keyword search only:", e.message);
  }
  const qNorm = qVec ? vectorNorm(qVec) : 0;

  // Surface (once) a model/dimension swap that would silently degrade search.
  warnCompatOnce(embeddingCompatibilityWarning(settings, qVec ? qVec.length : null));

  const candidates = [];  // {cid, entryId, score}
  const seen = new Set();

  // 1) Keyword candidates via FTS5 (trigram tokenizer)
  const fts = db.prepare(`
    SELECT c.id AS cid, c.entry_id AS eid, c.embedding, c.norm
    FROM chunks_fts f
    JOIN chunks c ON c.id = f.rowid
    WHERE chunks_fts MATCH ?
    ORDER BY rank
    LIMIT 40
  `).all(sanitizeFts(query));

  for (const row of fts) {
    if (seen.has(row.cid)) continue;
    seen.add(row.cid);
    const v = row.embedding && qVec ? similarity(qVec, qNorm, row.embedding, row.norm) : 0.5;
    candidates.push({ cid: row.cid, entryId: row.eid, score: v });
  }

  // 2) Semantic full-scan over embedded chunks (covers items FTS missed).
  // A bounded heap keeps only the top candidates; scanning in rowid order makes
  // the semanticScanLimit cutoff deterministic instead of arbitrary.
  if (qVec && qNorm) {
    const maxScan = settings.semanticScanLimit || 50000;
    const storeTop = Math.max(candidates.length, topK * 3);
    const heap = [];
    const stmt = db.prepare(`SELECT id, entry_id, embedding, norm FROM chunks WHERE embedding IS NOT NULL ORDER BY id LIMIT ?`);
    for (const row of stmt.iterate(maxScan)) {
      if (seen.has(row.id)) continue;
      const v = similarity(qVec, qNorm, row.embedding, row.norm);
      if (!(v > 0)) continue;
      heapOffer(heap, { cid: row.id, entryId: row.entry_id, score: v }, storeTop);
    }
    heap.sort((a, b) => b.score - a.score);
    for (const c of heap) {
      if (seen.has(c.cid)) continue;
      seen.add(c.cid);
      candidates.push(c);
    }
  }

  // 3) Load metadata once, apply filters, then rank and diversify
  const now = Date.now();
  const byEntry = new Map();
  for (const c of candidates) {
    const prev = byEntry.get(c.entryId);
    if (!prev || c.score > prev.score) byEntry.set(c.entryId, c);
  }

  let listed = [];
  const ids = [...byEntry.keys()];
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    const metas = db.prepare(`SELECT id, title, link, author, pub_date, feed_url, content, summary FROM entries WHERE id IN (${placeholders})`).all(...ids);
    const metaMap = new Map(metas.map((m) => [Number(m.id), m]));
    listed = [...byEntry.values()].map((c) => ({ ...c, meta: metaMap.get(c.entryId) }));
    listed = listed.filter((c) => {
      const m = c.meta;
      if (!m) return false;
      if (cutoff && !(Number(m.pub_date) >= cutoff)) return false;
      if (feedFilter && !((m.feed_url || "").toLowerCase().includes(feedFilter))) return false;
      if (authorFilter && !((m.author || "").toLowerCase().includes(authorFilter))) return false;
      return true;
    });

    // Blend semantic similarity with a gentle recency boost, then apply MMR so
    // near-duplicate headlines (common when feeds syndicate) don't crowd out
    // distinct results.
    for (const c of listed) {
      c.combined = 0.8 * Math.max(0, Number(c.score) || 0) + 0.2 * recencyFactor(c.meta.pub_date, now);
      c.titleSet = titleTokenSet(c.meta.title);
    }
    listed = mmrSelect(listed, topK, 0.7);

    // Fetch the specific matched chunk text so the snippet is the relevant
    // passage rather than the opening of the article.
    const cids = listed.map((c) => c.cid).filter((x) => x != null);
    if (cids.length) {
      const chunkRows = db.prepare(`SELECT id, text FROM chunks WHERE id IN (${cids.map(() => "?").join(",")})`).all(...cids);
      const textMap = new Map(chunkRows.map((c) => [Number(c.id), c.text]));
      for (const c of listed) c.chunkText = textMap.get(c.cid) ?? null;
    }
  }

  if (!listed.length) {
    // Fallback to raw entry matching (e.g. very short queries that trigram ignores)
    let sql = `SELECT id, title, summary, content, link, pub_date, feed_url, author
               FROM entries WHERE (title LIKE ? OR summary LIKE ? OR content LIKE ?)`;
    const params = [`%${query}%`, `%${query}%`, `%${query}%`];
    if (cutoff) { sql += ` AND pub_date >= ?`; params.push(cutoff); }
    if (feedFilter) { sql += ` AND lower(feed_url) LIKE ?`; params.push(`%${feedFilter}%`); }
    if (authorFilter) { sql += ` AND lower(author) LIKE ?`; params.push(`%${authorFilter}%`); }
    sql += ` ORDER BY pub_date DESC LIMIT 5`;
    const rows = db.prepare(sql).all(...params);

    return rows.map((m) => ({
      title: m.title,
      link: m.link,
      author: m.author,
      pub_date: m.pub_date,
      pub_date_iso: isoDate(m.pub_date),
      feed: m.feed_url,
      text: makeSnippet(m.content || m.summary || "", query, 600)
    }));
  }

  return listed.map((c) => {
    const m = c.meta;
    return {
      title: m.title,
      link: m.link,
      author: m.author,
      pub_date: m.pub_date,
      pub_date_iso: isoDate(m.pub_date),
      feed: m.feed_url,
      score: c.combined,
      similarity: Number.isFinite(c.score) ? c.score : undefined,
      text: makeSnippet(c.chunkText || m.content || m.summary || "", query, 600)
    };
  });
}
