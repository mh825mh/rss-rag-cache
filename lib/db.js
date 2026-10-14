import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getDbPath } from "./config.js";
import { bufferToFloat32, vectorNorm } from "./embedder.js";

let db;

export function getDb() {
  if (db) return db;
  const dbPath = getDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });

  // Use Node's built-in native SQLite
  db = new DatabaseSync(dbPath);

  // Concurrency + cascade safety
  db.prepare(`PRAGMA journal_mode = WAL`).get();
  db.prepare(`PRAGMA foreign_keys = ON`).get();
  // Keep the write-ahead log bounded (WAL had grown to ~81 MB).
  db.prepare(`PRAGMA synchronous = NORMAL`).get();
  db.prepare(`PRAGMA wal_autocheckpoint = 1000`).get();
  db.prepare(`PRAGMA journal_size_limit = 67108864`).get();

  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      guid        TEXT UNIQUE,
      feed_url    TEXT,
      title       TEXT,
      link        TEXT,
      author      TEXT,
      pub_date    INTEGER,
      summary     TEXT,
      content     TEXT,
      title_key   TEXT,
      cached_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id     INTEGER NOT NULL,
      chunk_index  INTEGER NOT NULL,
      text         TEXT NOT NULL,
      embedding    BLOB,
      FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- Per-feed HTTP validator + health state. Enables conditional GETs
    -- (If-None-Match / If-Modified-Since) and exponential backoff for feeds
    -- that keep failing, so a refresh no longer re-downloads unchanged data
    -- nor hammers temporarily broken feeds.
    CREATE TABLE IF NOT EXISTS feeds_state (
      url           TEXT PRIMARY KEY,
      etag          TEXT,
      last_modified TEXT,
      last_fetched  INTEGER,
      last_status   INTEGER,
      fail_count    INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER,
      last_error    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_entries_pub   ON entries(pub_date);
    CREATE INDEX IF NOT EXISTS idx_entries_cache ON entries(cached_at);
    CREATE INDEX IF NOT EXISTS idx_chunks_entry  ON chunks(entry_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text, content='chunks', content_rowid='id', tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
    END;
  `);

  // Migration: add title_key (cross-feed dedup) to pre-existing databases
  const entryCols = db.prepare(`PRAGMA table_info(entries)`).all();
  if (!entryCols.some((c) => c.name === "title_key")) {
    db.exec(`ALTER TABLE entries ADD COLUMN title_key TEXT`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_title_key ON entries(title_key)`);

  // Migration: rebuild FTS with the trigram tokenizer (CJK / substring search).
  // Detected by checking the stored schema of chunks_fts.
  const ftsRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks_fts'`).get();
  if (ftsRow && !/trigram/i.test(ftsRow.sql)) {
    console.log("[rss-rag] Rebuilding full-text index with trigram tokenizer...");
    db.exec(`
      DROP TRIGGER IF EXISTS chunks_ai;
      DROP TRIGGER IF EXISTS chunks_ad;
      DROP TABLE IF EXISTS chunks_fts;
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        text, content='chunks', content_rowid='id', tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
      END;
    `);
    db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');`);
  }

  // Migration: drop the useless plain index on the embedding BLOB (~90 MB on a
  // 20k-chunk cache with zero query benefit; embeddings are only full-scanned).
  db.exec(`DROP INDEX IF EXISTS idx_chunks_emb`);

  // Migration: store the L2 norm of each embedding so cosine similarity becomes
  // a scaled dot product on the scan hot path.
  const chunkCols = db.prepare(`PRAGMA table_info(chunks)`).all();
  if (!chunkCols.some((c) => c.name === "norm")) {
    db.exec(`ALTER TABLE chunks ADD COLUMN norm REAL`);
    backfillNorms(db);
  }

  return db;
}

// Computes and stores the L2 norm for chunks that predate the norm column.
function backfillNorms(db) {
  let rows;
  try {
    rows = db.prepare(`SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL AND norm IS NULL`).all();
  } catch {
    return;
  }
  if (!rows.length) return;
  const upd = db.prepare(`UPDATE chunks SET norm = ? WHERE id = ?`);
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      try {
        upd.run(vectorNorm(bufferToFloat32(r.embedding)), r.id);
      } catch {
        /* skip malformed blob */
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    console.warn("[rss-rag] norm backfill failed:", e.message);
  }
}

// node:sqlite rejects `undefined` bindings; coerce optional fields to null.
const nn = (v) => (v === undefined ? null : v);

export function getFeedState(url) {
  const db = getDb();
  return db.prepare(`SELECT * FROM feeds_state WHERE url = ?`).get(String(url)) ?? null;
}

// Returns a Map keyed by feed URL for a whole refresh pass.
export function getAllFeedStates() {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM feeds_state`).all();
  return new Map(rows.map((r) => [r.url, r]));
}

export function saveFeedState(state) {
  const db = getDb();
  db.prepare(`
    INSERT INTO feeds_state (url, etag, last_modified, last_fetched, last_status, fail_count, next_retry_at, last_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      etag          = excluded.etag,
      last_modified = excluded.last_modified,
      last_fetched  = excluded.last_fetched,
      last_status   = excluded.last_status,
      fail_count    = excluded.fail_count,
      next_retry_at = excluded.next_retry_at,
      last_error    = excluded.last_error
  `).run(
    String(state.url),
    nn(state.etag),
    nn(state.last_modified),
    nn(state.last_fetched),
    nn(state.last_status),
    Number.isFinite(state.fail_count) ? state.fail_count : 0,
    nn(state.next_retry_at),
    nn(state.last_error),
  );
}

export function clearFeedState(url) {
  const db = getDb();
  db.prepare(`DELETE FROM feeds_state WHERE url = ?`).run(String(url));
}

export function getMeta(key) {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key);
  return row ? row.value : null;
}

export function setMeta(key, value) {
  const db = getDb();
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

// Closes the singleton connection. Mainly useful for tests / clean shutdown.
export function closeDb() {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  db = undefined;
}