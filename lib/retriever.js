import { getDb } from "./db.js";
import { embed, cosine, bufferToFloat32, float32ToBuffer } from "./embedder.js";
import { titleKey } from "./parser.js";

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 120;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

export async function indexEntry(entry, settings) {
  const db = getDb();
  const chunkSize = settings.chunkSize || CHUNK_SIZE;
  const ins = db.prepare(`
    INSERT OR IGNORE INTO entries (guid, feed_url, title, link, author, pub_date, summary, content, title_key, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  const info = ins.run(entry.guid, entry.feed_url, entry.title, entry.link, entry.author, entry.pub_date, entry.summary, entry.content, titleKey(entry.title), now);
  if (info.changes === 0) return false;

  const entryId = info.lastInsertRowid;
  const combined = `${entry.title}\n\n${entry.summary}\n\n${entry.content}`;
  const chunks = chunkText(combined, chunkSize);
  if (!chunks.length) return true;

  const vectors = await embed(chunks, { baseUrl: settings.lmStudioBaseUrl, model: settings.embeddingModel, batchSize: settings.embedBatchSize || 16 });

  const insChunk = db.prepare(`INSERT INTO chunks (entry_id, chunk_index, text, embedding) VALUES (?, ?, ?, ?)`);
  db.exec("BEGIN TRANSACTION");
  try {
    for (let idx = 0; idx < chunks.length; idx++) {
      const vec = vectors[idx];
      insChunk.run(entryId, idx, chunks[idx], vec ? float32ToBuffer(vec) : null);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  return true;
}

// Batch indexing across many entries: inserts all entries first (dedup by
// guid AND normalized title), then embeds every chunk of every new entry in
// a single batched pass and writes the chunks in one transaction.
export async function indexEntries(items, settings) {
  const db = getDb();
  const chunkSize = settings.chunkSize || CHUNK_SIZE;

  const ins = db.prepare(`
    INSERT OR IGNORE INTO entries (guid, feed_url, title, link, author, pub_date, summary, content, title_key, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = Date.now();
  const pending = [];
  for (const entry of items) {
    if (!entry?.title && !entry?.content) continue;
    const info = ins.run(
      entry.guid, entry.feed_url, entry.title, entry.link, entry.author,
      entry.pub_date, entry.summary, entry.content, titleKey(entry.title), now
    );
    if (info.changes === 0) continue; // duplicate (guid or title_key)
    const entryId = Number(info.lastInsertRowid);
    const combined = `${entry.title ?? ""}\n\n${entry.summary ?? ""}\n\n${entry.content ?? ""}`;
    pending.push({ entryId, combined });
  }

  if (!pending.length) return { added: 0 };

  const jobs = [];
  for (const p of pending) {
    chunkText(p.combined, chunkSize).forEach((text, idx) => jobs.push({ entryId: p.entryId, chunkIndex: idx, text }));
  }

  if (jobs.length) {
    const vectors = await embed(jobs.map((j) => j.text), {
      baseUrl: settings.lmStudioBaseUrl,
      model: settings.embeddingModel,
      batchSize: settings.embedBatchSize || 16,
    });

    const insChunk = db.prepare(`INSERT INTO chunks (entry_id, chunk_index, text, embedding) VALUES (?, ?, ?, ?)`);
    db.exec("BEGIN TRANSACTION");
    try {
      for (let i = 0; i < jobs.length; i++) {
        const vec = vectors[i];
        insChunk.run(jobs[i].entryId, jobs[i].chunkIndex, jobs[i].text, vec ? float32ToBuffer(vec) : null);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  return { added: pending.length };
}

// Re-embeds chunks that were saved text-only (embedding NULL) because the
// model was offline at index time. Call once the embedding model is back.
export async function reindexMissing(settings, limit = 2000) {
  const db = getDb();
  const rows = db.prepare(`SELECT id, text FROM chunks WHERE embedding IS NULL ORDER BY id LIMIT ?`).all(limit);
  if (!rows.length) return { updated: 0, remaining: 0, total: 0 };

  const vectors = await embed(rows.map((r) => r.text), {
    baseUrl: settings.lmStudioBaseUrl,
    model: settings.embeddingModel,
    batchSize: settings.embedBatchSize || 16,
  });

  const upd = db.prepare(`UPDATE chunks SET embedding = ? WHERE id = ?`);
  db.exec("BEGIN TRANSACTION");
  try {
    for (let i = 0; i < rows.length; i++) {
      const vec = vectors[i];
      if (vec) upd.run(float32ToBuffer(vec), rows[i].id);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  const remaining = db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NULL`).get().n;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get().n;
  return { updated: vectors.filter(Boolean).length, remaining, total };
}

export async function refreshFeeds(settings, feeds) {
  const { fetchAll, fetchArticleContent } = await import("./fetcher.js");
  const startTime = Date.now();
  const results = await fetchAll(feeds, settings);
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  let added = 0;
  const failedFeeds = [];
  const slowSuccessFeeds = [];
  let fastSuccessCount = 0;

  const allItems = [];
  const slowItems = [];

  for (const r of results) {
    if (!r.ok) {
      failedFeeds.push({ url: r.url, error: r.error, mode: r.mode });
      continue;
    }

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

  try {
    const res = await indexEntries(allItems, settings);
    added = res.added;
  } catch (e) {
    console.error("[rss-rag] Indexing error:", e.message);
  }

  return {
    added,
    totalTimeSeconds: totalTime,
    fastMode: { success: fastSuccessCount, failed: failedFeeds.filter(f => f.mode === 'fast').length },
    slowMode: { success: slowSuccessFeeds.length, failed: failedFeeds.filter(f => f.mode === 'slow').length, details: slowSuccessFeeds },
    failedFeeds: failedFeeds.map(f => ({ url: f.url, error: f.error }))
  };
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

  const candidates = [];  // {cid, entryId, score}
  const seen = new Set();

  // 1) Keyword candidates via FTS5 (trigram tokenizer)
  const fts = db.prepare(`
    SELECT c.id AS cid, c.entry_id AS eid, c.embedding
    FROM chunks_fts f
    JOIN chunks c ON c.id = f.rowid
    WHERE chunks_fts MATCH ?
    ORDER BY rank
    LIMIT 40
  `).all(sanitizeFts(query));

  for (const row of fts) {
    if (seen.has(row.cid)) continue;
    seen.add(row.cid);
    const v = row.embedding && qVec ? cosine(qVec, bufferToFloat32(row.embedding)) : 0.5;
    candidates.push({ cid: row.cid, entryId: row.eid, score: v });
  }

  // 2) Semantic full-scan over embedded chunks (covers items FTS missed)
  if (qVec) {
    const maxScan = settings.semanticScanLimit || 50000;
    const stmt = db.prepare(`SELECT id, entry_id, embedding FROM chunks WHERE embedding IS NOT NULL LIMIT ?`);
    const semantic = [];
    const storeTop = Math.max(candidates.length, topK * 3);
    let minKept = -Infinity;
    for (const row of stmt.iterate(maxScan)) {
      if (seen.has(row.id)) continue;
      const v = cosine(qVec, bufferToFloat32(row.embedding));
      if (!(v > 0)) continue;
      if (semantic.length < storeTop || v > minKept) {
        semantic.push({ cid: row.id, entryId: row.entry_id, score: v });
        semantic.sort((a, b) => b.score - a.score);
        if (semantic.length > storeTop) semantic.pop();
        minKept = semantic[semantic.length - 1]?.score ?? -Infinity;
      }
    }
    for (const c of semantic) {
      if (seen.has(c.cid)) continue;
      seen.add(c.cid);
      candidates.push(c);
    }
  }

  // 3) Load metadata once, apply filters, then pick top entries
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
    listed.sort((a, b) => b.score - a.score);
    listed = listed.slice(0, topK);
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
      text: (m.content || m.summary || "").slice(0, 4000)
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
      score: c.score,
      text: (m.content || m.summary || "").slice(0, 4000)
    };
  });
}