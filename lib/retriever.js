import { getDb } from "./db.js";
import { embed, cosine, bufferToFloat32 } from "./embedder.js";

const CHUNK_SIZE = 800;     // chars
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
    VALUES (@guid, @feed_url, @title, @link, @author, @pub_date, @summary, @content, @cached_at)
  `);
  const info = ins.run({ ...entry, cached_at: Date.now() });
  if (info.changes === 0) return false; // already cached

  const entryId = info.lastInsertRowid;
  const combined = `${entry.title}\n\n${entry.summary}\n\n${entry.content}`;
  const chunks = chunkText(combined);
  if (!chunks.length) return true;

  const vectors = await embed(chunks, { baseUrl: settings.lmStudioBaseUrl, model: settings.embeddingModel });
  const insChunk = db.prepare(`INSERT INTO chunks (entry_id, chunk_index, text, embedding) VALUES (?, ?, ?, ?)`);
  const tx = db.transaction((rows) => { for (const r of rows) insChunk.run(r.entryId, r.idx, r.text, r.vec); });
  tx(chunks.map((text, idx) => ({ entryId, idx, text, vec: float32ToBuffer(vectors[idx]) })));
  return true;
}

import { float32ToBuffer } from "./embedder.js";

export async function refreshFeeds(settings, feeds) {
  const { fetchAll } = await import("./fetcher.js");
  const results = await fetchAll(feeds);
  let added = 0, failed = 0;
  for (const r of results) {
    if (!r.ok) { failed++; continue; }
    for (const item of r.items) {
      try { if (await indexEntry(item, settings)) added++; } catch (e) { console.error("index error:", e.message); }
    }
  }
  return { added, failed, totalFeeds: feeds.length };
}

export async function retrieve(query, settings) {
  const db = getDb();
  const [qVec] = await embed([query], { baseUrl: settings.lmStudioBaseUrl, model: settings.embeddingModel });

  // Hybrid candidate set: top FTS hits + recent entries
  const fts = db.prepare(`
    SELECT c.id AS cid, c.text, c.entry_id
    FROM chunks_fts f
    JOIN chunks c ON c.id = f.rowid
    WHERE chunks_fts MATCH ?
    ORDER BY rank
    LIMIT 40
  `).all(query.replace(/["'*]/g, " ").trim() || "a");

  const recent = db.prepare(`
    SELECT c.id AS cid, c.text, c.entry_id
    FROM chunks c
    JOIN entries e ON e.id = c.entry_id
    ORDER BY e.pub_date DESC
    LIMIT 40
  `).all();

  const seen = new Set();
  const candidates = [];
  for (const row of [...fts, ...recent]) {
    if (seen.has(row.cid)) continue;
    seen.add(row.cid);
    candidates.push(row);
  }

  // Score by cosine
  const scored = [];
  for (const row of candidates) {
    const r = db.prepare(`SELECT embedding FROM chunks WHERE id = ?`).get(row.cid);
    if (!r?.embedding) continue;
    const v = bufferToFloat32(r.embedding);
    scored.push({ cid: row.cid, entryId: row.entry_id, text: row.text, score: cosine(qVec, v) });
  }
  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, settings.topK || 8).map((s) => s.entryId);
  if (!top.length) return [];

  const meta = db.prepare(`SELECT id, title, link, author, pub_date, feed_url FROM entries WHERE id = ?`);
  return top.map((entryId) => {
    const m = meta.get(entryId);
    const text = scored.filter((s) => s.entryId === entryId).map((s) => s.text).join("\n\n");
    return { ...m, pub_date_iso: new Date(m.pub_date).toISOString(), text };
  });
}