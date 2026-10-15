import { getDb, setMeta, getMeta, getAllFeedStates, saveFeedState } from "./db.js";
import { embed, bufferToFloat32, float32ToBuffer, vectorNorm, formatEmbeddingInput } from "./embedder.js";
import { titleKey } from "./parser.js";
import { contentHash, entrySimhash, hamming, toStoredSimhash } from "./hashes.js";
import { searchVectors, invalidateVectorIndex, appendChunks, removeEntries, vectorIndex } from "./vectorIndex.js";
import { log } from "./log.js";

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

// Marker stored on each chunk recording how its embedding input was composed.
// Chunks written before contextual headers existed have embed_style = NULL and
// are considered stale by reindexMissing(), so the upgrade is gradual/resumable.
export const EMBED_STYLE_CONTEXTUAL = "contextual-v2";
export const EMBED_STYLE_PLAIN = "plain-v2";

// Builds the *contextual* text (title + breadcrumb + chunk) with no model prefix.
export function contextualText(title, text, heading = "") {
  const t = String(title || "").trim();
  const h = String(heading || "").trim();
  const body = String(text ?? "");
  const head = t ? (h ? `${t} | ${h}` : t) : h;
  if (!head) return body;
  return `${head}\n${body}`;
}

// Back-compat signature: (title, text, contextual=true, heading="", model="")
export function contextualEmbedInput(title, text, contextual = true, heading = "", model = "") {
  const raw = contextual ? contextualText(title, text, heading) : String(text ?? "");
  return formatEmbeddingInput(raw, "document", model);
}

function currentEmbedStyle(settings) {
  return settings?.contextualChunks === false ? EMBED_STYLE_PLAIN : EMBED_STYLE_CONTEXTUAL;
}

// node:sqlite rejects `undefined` bindings; normalise optional fields to null.
const nn = (v) => (v === undefined ? null : v);

function parseHeading(line) {
  const m = /^\s*(#{1,3})\s+(.*\S)\s*$/.exec(line);
  return m ? { level: m[1].length, title: m[2] } : null;
}

function headingFromText(text) {
  const lines = String(text).split("\n");
  const crumb = [];
  for (const line of lines) {
    const m = /^\s*(#{1,3})\s+(.*\S)\s*$/.exec(line);
    if (m) {
      crumb.splice(m[1].length - 1);
      crumb[m[1].length - 1] = m[2];
    }
  }
  return crumb.filter(Boolean).join(" > ");
}

// Structure-aware chunking. Splits on paragraph and sentence boundaries and
// packs whole sentences up to `chunkSize`, instead of cutting an arbitrary
// character window mid-word. Over-long sentences (and text with no punctuation,
// e.g. CJK or code) fall back to a hard split. A small overlap is prepended
// from the previous chunk to preserve context across boundaries.
export function chunkSections(text, chunkSize = CHUNK_SIZE, chunkOverlap = CHUNK_OVERLAP) {
  const clean = String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!clean) return [];

  const crumb = [];
  const currentHeading = () => crumb.filter(Boolean).join(" > ");

  // 1) Break into sentence-ish units with current heading
  const units = [];
  for (const para of clean.split(/\n+/)) {
    const p = para.trim();
    if (!p) continue;
    const h = parseHeading(p);
    if (h) {
      crumb.splice(h.level - 1);
      crumb[h.level - 1] = h.title;
    }
    const heading = currentHeading();
    const sentences = p.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [p];
    for (const s of sentences) {
      const t = s.trim();
      if (!t) continue;
      if (t.length <= chunkSize) {
        units.push({ text: t, heading });
      } else {
        for (let i = 0; i < t.length; i += chunkSize) units.push({ text: t.slice(i, i + chunkSize), heading });
      }
    }
  }
  if (!units.length) return [];

  // 2) Greedily pack units. A chunk's breadcrumb is the heading active at its
  // end, so a chunk that spans a section transition is labelled with the later
  // (more specific) section.
  const chunks = [];
  let curText = "";
  let curHeading = units[0].heading;
  for (const u of units) {
    if (!curText) {
      curText = u.text;
      curHeading = u.heading;
    } else if (curText.length + 1 + u.text.length <= chunkSize) {
      curText += " " + u.text;
      curHeading = u.heading;
    } else {
      chunks.push({ text: curText, heading: curHeading });
      curText = u.text;
      curHeading = u.heading;
    }
  }
  if (curText) chunks.push({ text: curText, heading: curHeading });

  // 3) Overlap
  if (chunkOverlap > 0 && chunks.length > 1) {
    const out = [{ text: chunks[0].text, heading: chunks[0].heading }];
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const tail = prev.text.slice(Math.max(0, prev.text.length - chunkOverlap));
      out.push({ text: `${tail} ${chunks[i].text}`.trim(), heading: chunks[i].heading });
    }
    return out;
  }
  return chunks;
}

export function chunkText(text, chunkSize = CHUNK_SIZE, chunkOverlap = CHUNK_OVERLAP) {
  return chunkSections(text, chunkSize, chunkOverlap).map((c) => c.text);
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
    log.warn(`Embedding dimension changed (${prevDim} -> ${dim}); run reembed_all to rebuild the index with the new model.`);
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
  log.warn(msg);
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

// Normalises per-feed tags into a lowercased, comma-joined string for storage.
function normalizeTags(tags) {
  if (!tags) return null;
  const arr = Array.isArray(tags) ? tags : String(tags).split(",");
  const clean = arr.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  return clean.length ? clean.join(",") : null;
}

// Per-feed collection label used to scope searches (a feed belongs to at most
// one collection; unlike tags which are many-per-entry).
function normalizeCollection(collection) {
  if (collection == null) return null;
  const s = String(collection).trim();
  return s ? s : null;
}

export async function indexEntry(entry, settings) {
  const db = getDb();
  const chunkSize = settings.chunkSize || CHUNK_SIZE;
  const style = currentEmbedStyle(settings);
  const contextual = style === EMBED_STYLE_CONTEXTUAL;
  const hash = contentHash(entry.title, entry.summary, entry.content);
  const simhash = entrySimhash(entry.summary, entry.content);
  const ins = db.prepare(`
    INSERT OR IGNORE INTO entries (guid, feed_url, title, link, author, pub_date, summary, content, title_key, content_hash, simhash, tags, collection, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  const info = ins.run(nn(entry.guid), nn(entry.feed_url), nn(entry.title), nn(entry.link), nn(entry.author), nn(entry.pub_date), nn(entry.summary), nn(entry.content), titleKey(entry.title), hash, toStoredSimhash(simhash), normalizeTags(entry.tags), normalizeCollection(entry.collection), now);
  if (info.changes === 0) return false;

  const entryId = info.lastInsertRowid;
  const chunks = chunkSections(combinedText(entry), chunkSize);
  if (!chunks.length) return true;

  const embedTexts = chunks.map((c) => contextualEmbedInput(entry.title, c.text, contextual, c.heading, settings.embeddingModel));
  const vectors = await embed(embedTexts, { baseUrl: settings.lmStudioBaseUrl, model: settings.embeddingModel, batchSize: settings.embedBatchSize || 16, concurrency: settings.embedConcurrency || 3 });
  recordEmbeddingMeta(vectors, settings);

  const insChunk = db.prepare(`INSERT INTO chunks (entry_id, chunk_index, text, embedding, norm, embed_style) VALUES (?, ?, ?, ?, ?, ?)`);
  db.exec("BEGIN");
  try {
    for (let idx = 0; idx < chunks.length; idx++) {
      const vec = vectors[idx];
      insChunk.run(entryId, idx, chunks[idx].text, vec ? float32ToBuffer(vec) : null, vec ? vectorNorm(vec) : null, vec ? style : null);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  invalidateVectorIndex();

  return true;
}

// Batch indexing across many entries. Embedding happens *before* any write so a
// failed/slow embedding call can never leave a half-indexed entry in the DB
// (previously entries were committed first, then embedded, which is why 1,069
// entries ended up with zero chunks). All writes then happen in one transaction.
//
// Entries whose text changed since they were cached (same guid, different
// content hash) are re-chunked and re-embedded rather than ignored forever.
export async function indexEntries(items, settings) {
  const db = getDb();
  const chunkSize = settings.chunkSize || CHUNK_SIZE;
  const style = currentEmbedStyle(settings);
  const contextual = style === EMBED_STYLE_CONTEXTUAL;

  // 1) Classify each item without writing anything.
  const getByGuid = db.prepare(`SELECT id, content_hash, title, summary, content FROM entries WHERE guid = ? LIMIT 1`);
  const getByTitle = db.prepare(`SELECT id, content_hash, title, summary, content FROM entries WHERE title_key = ? LIMIT 1`);
  const seenGuid = new Set();
  const seenTitle = new Set();

  const inserts = [];
  const updates = [];
  for (const entry of items) {
    if (!entry?.title && !entry?.content) continue;
    const guid = entry.guid ?? null;
    const tk = titleKey(entry.title);
    const hash = contentHash(entry.title, entry.summary, entry.content);
    const simhash = entrySimhash(entry.summary, entry.content);
    const tags = normalizeTags(entry.tags);
    const collection = normalizeCollection(entry.collection);

    if (guid) {
      if (seenGuid.has(guid)) continue; // duplicate within this batch
      seenGuid.add(guid);
      const existing = getByGuid.get(guid);
      if (existing) {
        const oldHash = existing.content_hash || contentHash(existing.title, existing.summary, existing.content);
        if (oldHash === hash) continue; // unchanged
        updates.push({ id: Number(existing.id), entry, hash, simhash, tags, collection, chunks: chunkSections(combinedText(entry), chunkSize) });
        if (tk) seenTitle.add(tk);
        continue;
      }
    }

    if (tk && (seenTitle.has(tk) || getByTitle.get(tk))) continue;
    if (tk) seenTitle.add(tk);
    inserts.push({ entry, hash, simhash, tags, collection, chunks: chunkSections(combinedText(entry), chunkSize) });
  }

  const changed = [...inserts, ...updates];
  if (!changed.length) return { added: 0, updated: 0 };

  // 2) Embed everything up front (no DB writes yet), preserving chunk order.
  // Each chunk is embedded as "headline\nchunk" so summary-only feeds still
  // produce self-contained vectors; the stored chunk text stays unprefixed.
  const texts = [];
  for (const p of changed) for (const t of p.chunks) texts.push(contextualEmbedInput(p.entry.title, t.text, contextual, t.heading, settings.embeddingModel));

  let vectors = [];
  if (texts.length) {
    vectors = await embed(texts, {
      baseUrl: settings.lmStudioBaseUrl,
      model: settings.embeddingModel,
      batchSize: settings.embedBatchSize || 16,
      concurrency: settings.embedConcurrency || 3,
    });
    recordEmbeddingMeta(vectors, settings);
  }

  // 3) Single atomic transaction for entries + chunks.
  const ins = db.prepare(`
    INSERT OR IGNORE INTO entries (guid, feed_url, title, link, author, pub_date, summary, content, title_key, content_hash, simhash, tags, collection, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upd = db.prepare(`
    UPDATE entries SET feed_url = ?, title = ?, link = ?, author = ?, pub_date = ?, summary = ?, content = ?,
      title_key = ?, content_hash = ?, simhash = ?, tags = ?, collection = ?, cached_at = ?
    WHERE id = ?
  `);
  const delChunks = db.prepare(`DELETE FROM chunks WHERE entry_id = ?`);
  const insChunk = db.prepare(`INSERT INTO chunks (entry_id, chunk_index, text, embedding, norm, embed_style) VALUES (?, ?, ?, ?, ?, ?)`);
  const now = Date.now();

  let added = 0;
  let updated = 0;
  // Incremental vector-index bookkeeping (WP-4): if a resident index already
  // exists we patch it in place instead of reloading the whole matrix. The ids
  // and vectors collected below are applied only after a successful COMMIT.
  const liveBefore = vectorIndex();
  const appendedChunks = [];
  const replacedEntryIds = [];

  let vi = 0;
  db.exec("BEGIN");
  try {
    for (const p of inserts) {
      const entry = p.entry;
      const n = p.chunks.length;
      const info = ins.run(
        nn(entry.guid), nn(entry.feed_url), nn(entry.title), nn(entry.link), nn(entry.author),
        nn(entry.pub_date), nn(entry.summary), nn(entry.content), titleKey(entry.title), p.hash, toStoredSimhash(p.simhash), p.tags, p.collection, now,
      );
      if (info.changes === 0) {
        // Lost a race on guid/title_key; still advance the vector cursor.
        vi += n;
        continue;
      }
      const entryId = Number(info.lastInsertRowid);
      for (let c = 0; c < n; c++) {
        const vec = vectors[vi++];
        const cinfo = insChunk.run(entryId, c, p.chunks[c].text, vec ? float32ToBuffer(vec) : null, vec ? vectorNorm(vec) : null, vec ? style : null);
        if (vec) appendedChunks.push({ id: Number(cinfo.lastInsertRowid), entryId, vector: vec });
      }
      added++;
    }

    for (const p of updates) {
      const entry = p.entry;
      const n = p.chunks.length;
      try {
        upd.run(
          nn(entry.feed_url), nn(entry.title), nn(entry.link), nn(entry.author), nn(entry.pub_date),
          nn(entry.summary), nn(entry.content), titleKey(entry.title), p.hash, toStoredSimhash(p.simhash), p.tags, p.collection, now, p.id,
        );
      } catch (err) {
        // e.g. a title_key UNIQUE collision after a headline edit; keep the old row.
        log.warn(`Skipping update for entry ${p.id}: ${err.message}`);
        vi += n;
        continue;
      }
      delChunks.run(p.id);
      for (let c = 0; c < n; c++) {
        const vec = vectors[vi++];
        const cinfo = insChunk.run(p.id, c, p.chunks[c].text, vec ? float32ToBuffer(vec) : null, vec ? vectorNorm(vec) : null, vec ? style : null);
        if (vec) appendedChunks.push({ id: Number(cinfo.lastInsertRowid), entryId: p.id, vector: vec });
      }
      replacedEntryIds.push(p.id);
      updated++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  if (liveBefore) {
    // Drop the stale slots for re-embedded entries, then append the new ones.
    if (replacedEntryIds.length) removeEntries(replacedEntryIds);
    const appended = appendChunks(appendedChunks);
    // A short append means compaction/overflow invalidated the index; ensure a
    // clean rebuild (from the committed rows) on the next query.
    if (appended < appendedChunks.length) invalidateVectorIndex();
  } else {
    invalidateVectorIndex();
  }

  return { added, updated };
}

// Re-embeds chunks stored text-only (embedding NULL) and, importantly, re-chunks
// entries that were left with zero chunks by the old non-atomic indexer. Also
// upgrades chunks embedded before contextual headers existed (embed_style stale),
// which is what makes the quality improvement apply to an existing cache.
export async function reindexMissing(settings, limit = 2000) {
  const db = getDb();
  const style = currentEmbedStyle(settings);
  const contextual = style === EMBED_STYLE_CONTEXTUAL;
  const embedOpts = {
    baseUrl: settings.lmStudioBaseUrl,
    model: settings.embeddingModel,
    batchSize: settings.embedBatchSize || 16,
    concurrency: settings.embedConcurrency || 3,
  };

  // A) Fill in missing embeddings and re-embed chunks from an older embedding
  // style. Joining entries gives us the title needed for the contextual prefix.
  const rows = db.prepare(`
    SELECT c.id, c.text, e.title
    FROM chunks c JOIN entries e ON e.id = c.entry_id
    WHERE c.embedding IS NULL OR c.embed_style IS NULL OR c.embed_style != ?
    ORDER BY c.id LIMIT ?
  `).all(style, limit);
  let updated = 0;
  if (rows.length) {
    const vectors = await embed(rows.map((r) => contextualEmbedInput(r.title, r.text, contextual, headingFromText(r.text), settings.embeddingModel)), embedOpts);
    recordEmbeddingMeta(vectors, settings);
    const upd = db.prepare(`UPDATE chunks SET embedding = ?, norm = ?, embed_style = ? WHERE id = ?`);
    db.exec("BEGIN");
    try {
      for (let i = 0; i < rows.length; i++) {
        const vec = vectors[i];
        if (!vec) continue;
        upd.run(float32ToBuffer(vec), vectorNorm(vec), style, rows[i].id);
        updated++;
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    invalidateVectorIndex();
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
      chunkSections(`${e.title ?? ""}\n\n${e.summary ?? ""}\n\n${e.content ?? ""}`, settings.chunkSize || CHUNK_SIZE)
        .forEach((c, idx) => jobs.push({ entryId: e.id, title: e.title, chunkIndex: idx, text: c.text, heading: c.heading }));
    }
    if (jobs.length) {
      const vectors = await embed(jobs.map((j) => contextualEmbedInput(j.title, j.text, contextual, j.heading || "", settings.embeddingModel)), embedOpts);
      recordEmbeddingMeta(vectors, settings);
      const insChunk = db.prepare(`INSERT INTO chunks (entry_id, chunk_index, text, embedding, norm, embed_style) VALUES (?, ?, ?, ?, ?, ?)`);
      db.exec("BEGIN");
      try {
        for (let i = 0; i < jobs.length; i++) {
          const vec = vectors[i];
          insChunk.run(jobs[i].entryId, jobs[i].chunkIndex, jobs[i].text, vec ? float32ToBuffer(vec) : null, vec ? vectorNorm(vec) : null, vec ? style : null);
        }
        db.exec("COMMIT");
        entriesRechunked = orphans.length;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      invalidateVectorIndex();
    }
  }

  const remaining = db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NULL OR embed_style IS NULL OR embed_style != ?`).get(style).n;
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
  invalidateVectorIndex();
  if (rechunk) {
    db.prepare(`DELETE FROM chunks`).run(); // force a full re-chunk (new chunkSize)
  } else {
    db.prepare(`UPDATE chunks SET embedding = NULL, norm = NULL, embed_style = NULL`).run();
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

  const style = currentEmbedStyle(settings);
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
  invalidateVectorIndex();

  return { updated, entriesRechunked, batches, remaining, orphanRemaining, rechunked: !!rechunk, complete: remaining === 0 && orphanRemaining === 0, style };
}

// Bounded, self-healing backfill used after a refresh and once the model is
// detected at startup: repeatedly runs reindexMissing until there are no gaps
// (or no further progress, e.g. the embedding endpoint is offline). Unlike
// reembedAll it never clears existing vectors, so it is cheap when there is
// nothing to do.
export async function backfillEmbeddings(settings, { batchSize = 500, maxBatches = 40 } = {}) {
  let updated = 0;
  let entriesRechunked = 0;
  let batches = 0;
  let remaining = 0;
  let orphanRemaining = 0;
  let prevRemaining = Infinity;
  let prevOrphans = Infinity;

  const style = currentEmbedStyle(settings);
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
    if (!progressed) break; // embedding endpoint failing; don't spin
  }

  return { updated, entriesRechunked, batches, remaining, orphanRemaining, complete: remaining === 0 && orphanRemaining === 0, style };
}

export async function refreshFeeds(settings, feeds, opts = {}) {
  const { fetchAll, fetchArticleContent } = await import("./fetcher.js");
  const force = !!opts.force;
  const startTime = Date.now();
  const feedStates = getAllFeedStates();
  const results = await fetchAll(feeds, settings, { feedStates, force });
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  let added = 0;
  let updated = 0;
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

  // Carry per-feed options onto each item so indexing can store tags and the
  // scraper can honour a per-feed scrapeFullText override.
  for (const r of results) {
    if (!r.ok) continue;
    for (const it of r.items) {
      it.tags = r.tags;
      it._scrapeFullText = r.scrapeFullText;
      it.collection = r.collection || null;
    }
  }

    if (r.mode === 'slow') {
      slowSuccessFeeds.push({ url: r.url, itemsFound: r.items.length });
      slowItems.push(...r.items);
    } else {
      fastSuccessCount++;
    }
    allItems.push(...r.items);
  }

  // Optional: enrich HTML-scraped items with the full article body. The global
  // setting is the default; a per-feed `scrapeFullText` in feeds.json overrides.
  const toScrape = slowItems.filter((it) => it.link && (it._scrapeFullText ?? asBool(settings.scrapeFullText)));
  if (toScrape.length) {
    log.info(`Fetching full text for ${toScrape.length} scraped articles (opt-in)...`);
    for (let i = 0; i < toScrape.length; i++) {
      const item = toScrape[i];
      try {
        const body = await fetchArticleContent(item.link);
        if (body && body.length > 200) {
          item.content = body;
          item.summary = (item.summary || item.title || "").slice(0, 500);
        }
      } catch (e) {
        log.warn(`Full-text fetch failed for ${item.link}: ${e.message}`);
      }
      if (i < toScrape.length - 1) await sleep(1500 + Math.random() * 1500);
    }
  }

  let indexError = null;
  try {
    const res = await indexEntries(allItems, settings);
    added = res.added;
    updated = res.updated || 0;
  } catch (e) {
    indexError = e.message;
    log.error("Indexing error:", e.message);
  }

  // Baseline completion marker so the auto-refresh interval is honoured even if
  // the caller forgets to write a richer report.
  try {
    setMeta("last_refresh", JSON.stringify({ timestamp: Date.now(), added, totalTimeSeconds: totalTime, indexError }));
  } catch { /* ignore */ }

  return {
    added,
    updated,
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

// --- Reciprocal Rank Fusion -------------------------------------------------
// Fuses the trigram FTS list, the English (porter) FTS list, and the vector
// list by rank position (score = sum 1/(k + rank + 1)). This replaces the old
// magic 0.5 constant for keyword-only hits and lets a strong match in any list
// surface even when its cosine similarity is only moderate.
const RRF_K = 60;
const FTS_LIST_SIZE = 60;
const VEC_LIST_SIZE = 200;

// Small LRU-ish cache of query -> embedding so repeated searches within a
// session don't re-hit the embedding server (roughly halves manual-typo cost).
const QUERY_CACHE_MAX = 200;
const queryCache = new Map();
async function queryVector(query, settings) {
  const key = `${settings.embeddingModel}|${query}`;
  if (queryCache.has(key)) {
    const hit = queryCache.get(key);
    queryCache.delete(key);
    queryCache.set(key, hit);
    return hit;
  }
  let vec = null;
  try {
    [vec] = await embed([formatEmbeddingInput(query, "query", settings.embeddingModel)], { baseUrl: settings.lmStudioBaseUrl, model: settings.embeddingModel });
  } catch (e) {
    log.warn("Query embedding failed, using keyword search only:", e.message);
  }
  if (vec) {
    if (queryCache.size >= QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value);
    queryCache.set(key, vec);
  }
  return vec;
}

// Runs one FTS MATCH and returns a rank-ordered list (best first). When an
// `entryFilter` is supplied the query INNER JOINs `entries` (alias `e`) and adds
// the filter predicates, so a selective filter (e.g. a niche tag) constrains
// candidate generation instead of being applied only after ranking.
function ftsList(db, table, match, limit, qVec, qNorm, entryFilter = null) {
  try {
    const join = entryFilter ? "JOIN entries e ON e.id = c.entry_id" : "";
    const where = entryFilter ? ` AND ${entryFilter.clauses.join(" AND ")}` : "";
    const params = entryFilter ? [...entryFilter.params, limit] : [limit];
    const rows = db.prepare(`
      SELECT c.id AS cid, c.entry_id AS eid, c.embedding, c.norm
      FROM ${table} f
      JOIN chunks c ON c.id = f.rowid
      ${join}
      WHERE ${table} MATCH ?
      ${where}
      ORDER BY rank
      LIMIT ?
    `).all(match, ...params);
    return rows.map((r) => ({
      cid: r.cid,
      entryId: r.eid,
      sim: r.embedding && qVec ? similarity(qVec, qNorm, r.embedding, r.norm) : null,
    }));
  } catch {
    return [];
  }
}

// Streaming fallback used when the resident vector index is unavailable (e.g.
// the matrix would exceed the memory ceiling). Bounded heap keeps only the top
// candidates. Scanning in rowid order keeps the semanticScanLimit cutoff
// deterministic rather than arbitrary. When `allowedEntryIds` is a Set, only
// chunks belonging to those entries are considered.
function streamingVectorScan(db, qVec, qNorm, settings, allowedEntryIds = null) {
  const maxScan = settings.semanticScanLimit || 50000;
  const heap = [];
  const restrict = allowedEntryIds instanceof Set;
  const stmt = db.prepare(`SELECT id, entry_id, embedding, norm FROM chunks WHERE embedding IS NOT NULL ORDER BY id LIMIT ?`);
  for (const row of stmt.iterate(maxScan)) {
    if (restrict && !allowedEntryIds.has(Number(row.entry_id))) continue;
    const v = similarity(qVec, qNorm, row.embedding, row.norm);
    if (!(v > 0)) continue;
    heapOffer(heap, { cid: row.id, entryId: row.entry_id, score: v }, VEC_LIST_SIZE);
  }
  heap.sort((a, b) => b.score - a.score);
  return heap;
}

// Drops near-duplicate articles (Hamming distance <= threshold on the 64-bit
// SimHash) that syndication produces. Higher-ranked items win. 64 bits with a
// 4-bit threshold keeps syndicated copies together without collapsing distinct
// short posts that happen to share a few words.
function dedupeSimhash(items, threshold = 4) {
  const kept = [];
  const hashes = [];
  for (const it of items) {
    const h = it.meta?.simhash;
    if (h == null) { kept.push(it); continue; }
    if (hashes.some((k) => hamming(k, h) <= threshold)) continue;
    hashes.push(h);
    kept.push(it);
  }
  return kept;
}

function toTimestamp(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
}

// Escapes LIKE metacharacters so a user-supplied substring is matched literally
// (the JS-side filter uses String.includes, which has no wildcard semantics).
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => `\\${m}`);
}

// Translates the active retrieve() filters into SQL predicates over the
// `entries` table (aliased `e`). Returns null when no filter is active so the
// unfiltered fast path is unchanged. Tag matching mirrors the JS filter: the
// comma-joined, lowercased tag list is compared token-by-token (exact match),
// and a NULL tag column simply never matches.
function buildEntryFilter(f) {
  // Accept either the derived timestamps retrieve() computes (cutoff/afterTs/
  // beforeTs) or the raw opts (days/after/before) for direct callers.
  const cutoff = f.cutoff != null ? f.cutoff
    : (f.days != null && Number.isFinite(Number(f.days)) ? Date.now() - Number(f.days) * 86400e3 : null);
  const afterTs = f.afterTs != null ? f.afterTs : toTimestamp(f.after);
  const beforeTs = f.beforeTs != null ? f.beforeTs : toTimestamp(f.before);

  const clauses = [];
  const params = [];
  if (cutoff != null) { clauses.push(`COALESCE(e.pub_date, 0) >= ?`); params.push(cutoff); }
  if (afterTs != null) { clauses.push(`COALESCE(e.pub_date, 0) >= ?`); params.push(afterTs); }
  if (beforeTs != null) { clauses.push(`COALESCE(e.pub_date, 0) <= ?`); params.push(beforeTs); }
  if (f.feedFilter) { clauses.push(`lower(COALESCE(e.feed_url, '')) LIKE ? ESCAPE '\\'`); params.push(`%${escapeLike(f.feedFilter).toLowerCase()}%`); }
  if (f.authorFilter) { clauses.push(`lower(COALESCE(e.author, '')) LIKE ? ESCAPE '\\'`); params.push(`%${escapeLike(f.authorFilter).toLowerCase()}%`); }
  if (f.tagFilter) { clauses.push(`(',' || lower(COALESCE(e.tags, '')) || ',') LIKE ? ESCAPE '\\'`); params.push(`%,${escapeLike(f.tagFilter).toLowerCase()},%`); }
  if (f.collectionFilter) { clauses.push(`lower(COALESCE(e.collection, '')) = ?`); params.push(String(f.collectionFilter).toLowerCase()); }
  if (!clauses.length) return null;
  return { clauses, params };
}

// Pre-resolves the entries.id integers allowed by the active filters (or null
// when no filter is active). Pushing the filters into candidate generation
// matters for selective filters (e.g. a niche tag): otherwise the FTS/vector
// lists fill with unfiltered hits, which are discarded afterwards, and retrieval
// can silently degrade to the LIKE-based fallback (which matches tags as a loose
// substring rather than an exact token).
export function resolveFilteredEntryIds(db, filters) {
  const filter = buildEntryFilter(filters);
  if (!filter) return null;
  const rows = db.prepare(`SELECT e.id FROM entries e WHERE ${filter.clauses.join(" AND ")}`).all(...filter.params);
  return new Set(rows.map((r) => Number(r.id)));
}

export async function retrieve(query, settings, opts = {}) {
  const db = getDb();
  const topK = settings.topK || 8;
  const limit = Math.max(1, Math.min(Number(opts.limit) || topK, 100));
  const offset = Math.max(0, Math.trunc(Number(opts.offset) || 0));
  const sort = opts.sort === "date" ? "date" : "relevance";

  const days = opts.days !== undefined && opts.days !== null && Number.isFinite(Number(opts.days)) ? Number(opts.days) : null;
  const afterTs = toTimestamp(opts.after);
  const beforeTs = toTimestamp(opts.before);
  const cutoff = days !== null ? Date.now() - days * 86400e3 : null;

  const feedFilter = opts.feed ? String(opts.feed).toLowerCase() : null;
  const authorFilter = opts.author ? String(opts.author).toLowerCase() : null;
  const tagFilter = opts.tag ? String(opts.tag).toLowerCase() : null;
  const collectionFilter = opts.collection ? String(opts.collection).toLowerCase() : null;

  const qVec = await queryVector(query, settings);
  const qNorm = qVec ? vectorNorm(qVec) : 0;

  // Surface (once) a model/dimension swap that would silently degrade search.
  warnCompatOnce(embeddingCompatibilityWarning(settings, qVec ? qVec.length : null));

  // --- Build rank-ordered lists and fuse them with RRF ---
  // Push the active filters into candidate generation. Without this a selective
  // filter (e.g. a niche tag with only a handful of matches) can find zero
  // candidates in the top FTS/vector lists, discard everything, and fall back to
  // a loose LIKE search instead of the intended exact-filtered ranking.
  const filters = { cutoff, afterTs, beforeTs, feedFilter, authorFilter, tagFilter, collectionFilter };
  const entryFilter = buildEntryFilter(filters);
  const allowedEntryIds = entryFilter ? resolveFilteredEntryIds(db, filters) : null;
  if (allowedEntryIds && allowedEntryIds.size === 0) return [];

  const match = sanitizeFts(query);
  const lists = [
    { name: "trigram", rows: ftsList(db, "chunks_fts", match, FTS_LIST_SIZE, qVec, qNorm, entryFilter) },
    { name: "english", rows: ftsList(db, "chunks_fts_en", match, FTS_LIST_SIZE, qVec, qNorm, entryFilter) },
  ];

  if (qVec && qNorm) {
    // Prefer the resident in-memory vector index: it scans one contiguous,
    // pre-normalised Float32Array with no per-row allocation. Fall back to the
    // streaming SQL scan only when the matrix exceeds the memory ceiling.
    let vecList = searchVectors(qVec, VEC_LIST_SIZE, allowedEntryIds);
    if (vecList === null) vecList = streamingVectorScan(db, qVec, qNorm, settings, allowedEntryIds);
    lists.push({ name: "vector", rows: vecList.map((h) => ({ cid: h.cid, entryId: h.entryId, sim: h.score })) });
  }

  const fused = new Map();
  for (const list of lists) {
    for (let i = 0; i < list.rows.length; i++) {
      const it = list.rows[i];
      const cur = fused.get(it.cid) || { cid: it.cid, entryId: it.entryId, rrf: 0, sim: null, ranks: {} };
      cur.rrf += 1 / (RRF_K + i + 1);
      cur.ranks[list.name] = i + 1;
      if (it.sim != null && (cur.sim == null || it.sim > cur.sim)) cur.sim = it.sim;
      fused.set(it.cid, cur);
    }
  }

  // Normalise RRF so the best candidate maps to 1.0, keeping the recency blend
  // and MMR weights meaningful; keep the best chunk per entry.
  let maxRrf = 0;
  for (const c of fused.values()) if (c.rrf > maxRrf) maxRrf = c.rrf;
  const byEntry = new Map();
  for (const c of fused.values()) {
    c.score = maxRrf ? c.rrf / maxRrf : 0;
    const prev = byEntry.get(c.entryId);
    if (!prev || c.score > prev.score) byEntry.set(c.entryId, c);
  }

  // --- Load metadata once and apply filters ---
  const now = Date.now();
  const ids = [...byEntry.keys()];
  let listed = [];
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    const metaStmt = db.prepare(`SELECT id, title, link, author, pub_date, feed_url, content, summary, simhash, tags, collection FROM entries WHERE id IN (${placeholders})`);
    // simhash is a 64-bit value that cannot round-trip through a JS Number, so
    // read it back exactly as a BigInt. id/pub_date are always small enough that
    // callers coerce them with Number() without losing information.
    try { metaStmt.setReadBigInts(true); } catch { /* older Node */ }
    const metas = metaStmt.all(...ids);
    const metaMap = new Map(metas.map((m) => [Number(m.id), m]));
    listed = [...byEntry.values()].map((c) => ({ ...c, meta: metaMap.get(c.entryId) }));
    listed = listed.filter((c) => {
      const m = c.meta;
      if (!m) return false;
      const ts = Number(m.pub_date);
      if (cutoff !== null && !(ts >= cutoff)) return false;
      if (afterTs !== null && !(ts >= afterTs)) return false;
      if (beforeTs !== null && !(ts <= beforeTs)) return false;
      if (feedFilter && !((m.feed_url || "").toLowerCase().includes(feedFilter))) return false;
      if (authorFilter && !((m.author || "").toLowerCase().includes(authorFilter))) return false;
      if (tagFilter && !(m.tags || "").split(",").map((t) => t.trim()).includes(tagFilter)) return false;
      if (collectionFilter) {
        const col = (m.collection || "").toLowerCase();
        if (col !== collectionFilter) return false;
      }
      return true;
    });
  }

  if (!listed.length) {
    return fallbackSearch(db, query, { cutoff, afterTs, beforeTs, feedFilter, authorFilter, tagFilter, collectionFilter, limit, offset });
  }

  // --- Rank, deduplicate, diversify, paginate ---
  for (const c of listed) {
    c.combined = 0.8 * c.score + 0.2 * recencyFactor(c.meta.pub_date, now);
    c.titleSet = titleTokenSet(c.meta.title);
  }

  if (sort === "date") {
    listed.sort((a, b) => Number(b.meta.pub_date) - Number(a.meta.pub_date) || b.combined - a.combined);
    listed = listed.slice(offset, offset + limit);
  } else {
    // Collapse syndicated near-duplicates, then diversify headlines with MMR.
    // Select extra candidates so `offset` pagination still works.
    listed.sort((a, b) => b.combined - a.combined);
    listed = dedupeSimhash(listed);
    listed = mmrSelect(listed, offset + limit, 0.7).slice(offset);
  }

  // Fetch the specific matched chunk text so the snippet is the relevant
  // passage rather than the opening of the article. Optionally expand to
  // neighbouring chunks to provide a little more context around the hit.
  const cids = listed.map((c) => c.cid).filter((x) => x != null);
  if (cids.length) {
    const chunkRows = db.prepare(`SELECT id, text, entry_id, chunk_index FROM chunks WHERE id IN (${cids.map(() => "?").join(",")})`).all(...cids);
    const textMap = new Map(chunkRows.map((c) => [Number(c.id), c]));
    const ctx = Math.max(0, Math.min(Number(settings.contextChunks) ?? 1, 2));
    for (const c of listed) {
      const ch = textMap.get(c.cid);
      if (!ch) { c.chunkText = null; continue; }
      if (ctx > 0) {
        const neighbors = db.prepare(`SELECT text, chunk_index FROM chunks WHERE entry_id = ? AND chunk_index BETWEEN ? AND ? ORDER BY chunk_index`).all(ch.entry_id, Math.max(0, ch.chunk_index - ctx), ch.chunk_index + ctx);
        c.chunkText = neighbors.map((n) => n.text).join(" ");
        continue;
      }
      c.chunkText = ch.text;
    }
  }

  const debug = !!opts.debug;
  return listed.map((c) => {
    const m = c.meta;
    const res = {
      title: m.title,
      link: m.link,
      author: m.author,
      pub_date: m.pub_date,
      pub_date_iso: isoDate(m.pub_date),
      feed: m.feed_url,
      tags: m.tags ? m.tags.split(",") : [],
      score: c.combined,
      similarity: Number.isFinite(c.sim) ? c.sim : undefined,
      text: makeSnippet(c.chunkText || m.content || m.summary || "", query, 600),
    };
    if (debug) res._debug = { cid: c.cid, ranks: c.ranks || {}, rrf: c.rrf, combined: c.combined };
    return res;
  });
}

// Raw entry matching, used when neither FTS nor vectors produce candidates
// (e.g. very short queries the trigram tokenizer ignores).
function fallbackSearch(db, query, f) {
  let sql = `SELECT title, summary, content, link, pub_date, feed_url, author, tags, collection
             FROM entries WHERE (title LIKE ? OR summary LIKE ? OR content LIKE ?)`;
  const params = [`%${query}%`, `%${query}%`, `%${query}%`];
  if (f.cutoff != null) { sql += ` AND COALESCE(pub_date, 0) >= ?`; params.push(f.cutoff); }
  if (f.afterTs != null) { sql += ` AND COALESCE(pub_date, 0) >= ?`; params.push(f.afterTs); }
  if (f.beforeTs != null) { sql += ` AND COALESCE(pub_date, 0) <= ?`; params.push(f.beforeTs); }
  if (f.feedFilter) { sql += ` AND lower(feed_url) LIKE ?`; params.push(`%${f.feedFilter}%`); }
  if (f.authorFilter) { sql += ` AND lower(author) LIKE ?`; params.push(`%${f.authorFilter}%`); }
  if (f.tagFilter) { sql += ` AND lower(COALESCE(tags, '')) LIKE ?`; params.push(`%${f.tagFilter}%`); }
  if (f.collectionFilter) { sql += ` AND lower(COALESCE(collection, '')) = ?`; params.push(f.collectionFilter); }
  sql += ` ORDER BY pub_date DESC LIMIT ? OFFSET ?`;
  params.push(f.limit, f.offset);
  const rows = db.prepare(sql).all(...params);
  return rows.map((m) => ({
    title: m.title,
    link: m.link,
    author: m.author,
    pub_date: m.pub_date,
    pub_date_iso: isoDate(m.pub_date),
    feed: m.feed_url,
    tags: m.tags ? m.tags.split(",") : [],
    text: makeSnippet(m.content || m.summary || "", query, 600),
  }));
}
