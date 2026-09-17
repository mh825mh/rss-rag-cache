import { getDb } from "./db.js";
import { embed, cosine, bufferToFloat32, float32ToBuffer } from "./embedder.js";

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 120;

export function chunkText(text) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const out = [];
  for (let i = 0; i < clean.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
    out.push(clean.slice(i, i + CHUNK_SIZE));
    if (i + CHUNK_SIZE >= clean.length) break;
  }
  return out;
}

export async function indexEntry(entry, settings) {
  const db = getDb();
  const ins = db.prepare(`
    INSERT OR IGNORE INTO entries (guid, feed_url, title, link, author, pub_date, summary, content, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = ins.run(entry.guid, entry.feed_url, entry.title, entry.link, entry.author, entry.pub_date, entry.summary, entry.content, Date.now());
  
  if (info.changes === 0) return false;

  const entryId = info.lastInsertRowid;
  const combined = `${entry.title}\n\n${entry.summary}\n\n${entry.content}`;
  const chunks = chunkText(combined);
  if (!chunks.length) return true;

  let vectors = [];
  try {
    vectors = await embed(chunks, { baseUrl: settings.lmStudioBaseUrl, model: settings.embeddingModel });
  } catch (e) {
    console.error("[rss-rag] Embedding failed, saving text only:", e.message);
    vectors = chunks.map(() => null); 
  }

  const insChunk = db.prepare(`INSERT INTO chunks (entry_id, chunk_index, text, embedding) VALUES (?, ?, ?, ?)`);
  
  // Native SQLite transaction fix
  db.exec("BEGIN TRANSACTION");
  try {
    for (let idx = 0; idx < chunks.length; idx++) {
      const text = chunks[idx];
      const vec = vectors[idx];
      const vecBuffer = vec ? float32ToBuffer(vec) : null;
      insChunk.run(entryId, idx, text, vecBuffer);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  
  return true;
}

export async function refreshFeeds(settings, feeds) {
  const { fetchAll } = await import("./fetcher.js");
  const startTime = Date.now();
  const results = await fetchAll(feeds);
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  
  let added = 0;
  const failedFeeds = [];
  const slowSuccessFeeds = [];
  let fastSuccessCount = 0;

  for (const r of results) {
    if (!r.ok) {
      failedFeeds.push({ url: r.url, error: r.error, mode: r.mode });
      continue;
    }
    
    if (r.mode === 'slow') {
      slowSuccessFeeds.push({ url: r.url, itemsFound: r.items.length });
    } else {
      fastSuccessCount++;
    }

    for (const item of r.items) {
      try { 
        if (await indexEntry(item, settings)) added++; 
      } catch (e) { 
        console.error("index error:", e.message); 
      }
    }
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
  
  let qVec = null;
  try {
    [qVec] = await embed([query], { baseUrl: settings.lmStudioBaseUrl, model: settings.embeddingModel });
  } catch (e) {
    console.error("[rss-rag] Query embedding failed, using keyword search only:", e.message);
  }

  const fts = db.prepare(`
    SELECT c.id AS cid, c.text, c.entry_id
    FROM chunks_fts f
    JOIN chunks c ON c.id = f.rowid
    WHERE chunks_fts MATCH ?
    ORDER BY rank
    LIMIT 40
  `).all(query.replace(/["'*]/g, " ").trim() || "a");

  const seen = new Set();
  const candidates = [];
  for (const row of fts) {
    if (seen.has(row.cid)) continue;
    seen.add(row.cid);
    candidates.push(row);
  }

  const scored = [];
  for (const row of candidates) {
    const r = db.prepare(`SELECT embedding FROM chunks WHERE id = ?`).get(row.cid);
    if (r?.embedding && qVec) {
      const v = bufferToFloat32(r.embedding);
      scored.push({ cid: row.cid, entryId: row.entry_id, text: row.text, score: cosine(qVec, v) });
    } else {
      scored.push({ cid: row.cid, entryId: row.entry_id, text: row.text, score: 0.5 });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  // Get top 3 unique entries
  const topEntryIds = [...new Set(scored.map(s => s.entryId))].slice(0, 3);
  
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
      pub_date: m.pub_date, // Fixed bug!
      pub_date_iso: new Date(m.pub_date).toISOString(),
      feed: m.feed_url,
      text: (m.content || m.summary || "").slice(0, 4000) // Return up to 4000 chars!
    }));
  }

  const meta = db.prepare(`SELECT id, title, link, author, pub_date, feed_url, content, summary FROM entries WHERE id = ?`);
  return topEntryIds.map((entryId) => {
    const m = meta.get(entryId);
    return { 
      title: m.title, 
      link: m.link, 
      author: m.author,
      pub_date: m.pub_date, // Fixed bug!
      pub_date_iso: new Date(m.pub_date).toISOString(), 
      feed: m.feed_url,
      text: (m.content || m.summary || "").slice(0, 4000) // Return up to 4000 chars!
    };
  });
}