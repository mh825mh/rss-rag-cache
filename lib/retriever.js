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
  return cleaned.map((t) => `"${t}"`).join(" ");
}

function isoDate(ts) {
  return Number.isFinite(ts) ? new Date(ts).toISOString() : new Date(Date.now()).toISOString();
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

export async function refreshFeeds(settings, feeds) {
  const { fetchAll, fetchArticleContent } = await import("./fetcher.js");
  const startTime = Date.now();
  const results = await fetchAll(feeds);
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
  if (settings.scrapeFullText && slowItems.length) {
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

export async function retrieve(query, settings) {
  const db = getDb();
  const topK = settings.topK || 8;

  let qVec = null;
  try {
    [qVec] = await embed([query], { baseUrl: settings.lmStudioBaseUrl, model: settings.embeddingModel });
  } catch (e) {
    console.error("[rss-rag] Query embedding failed, using keyword search only:", e.message);
  }

  const fts = db.prepare(`
    SELECT c.id AS cid, c.text, c.entry_id, c.embedding
    FROM chunks_fts f
    JOIN chunks c ON c.id = f.rowid
    WHERE chunks_fts MATCH ?
    ORDER BY rank
    LIMIT 40
  `).all(sanitizeFts(query));

  const seen = new Set();
  const candidates = [];
  for (const row of fts) {
    if (seen.has(row.cid)) continue;
    seen.add(row.cid);
    candidates.push(row);
  }

  const scored = candidates.map((row) => {
    if (row.embedding && qVec) {
      const v = bufferToFloat32(row.embedding);
      return { cid: row.cid, entryId: row.entry_id, text: row.text, score: cosine(qVec, v) };
    }
    return { cid: row.cid, entryId: row.entry_id, text: row.text, score: 0.5 };
  });
  scored.sort((a, b) => b.score - a.score);

  // Get top topK unique entries
  const topEntryIds = [...new Set(scored.map(s => s.entryId))].slice(0, topK);

  if (!topEntryIds.length) {
    // Fallback to entries if chunks fail
    const entriesFts = db.prepare(`
      SELECT id, title, summary, content, link, pub_date, feed_url
      FROM entries
      WHERE title LIKE ? OR summary LIKE ? OR content LIKE ?
      ORDER BY pub_date DESC
      LIMIT 5
    `).all(`%${query}%`, `%${query}%`, `%${query}%`);

    return entriesFts.map((m) => ({
      title: m.title,
      link: m.link,
      pub_date: m.pub_date,
      pub_date_iso: isoDate(m.pub_date),
      feed: m.feed_url,
      text: (m.content || m.summary || "").slice(0, 4000)
    }));
  }

  const meta = db.prepare(`SELECT id, title, link, author, pub_date, feed_url, content, summary FROM entries WHERE id = ?`);
  return topEntryIds.map((entryId) => {
    const m = meta.get(entryId);
    return {
      title: m.title,
      link: m.link,
      author: m.author,
      pub_date: m.pub_date,
      pub_date_iso: isoDate(m.pub_date),
      feed: m.feed_url,
      text: (m.content || m.summary || "").slice(0, 4000)
    };
  });
}