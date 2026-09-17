import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getDbPath } from "./config.js";

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

    CREATE INDEX IF NOT EXISTS idx_entries_pub   ON entries(pub_date);
    CREATE INDEX IF NOT EXISTS idx_entries_cache ON entries(cached_at);
    CREATE INDEX IF NOT EXISTS idx_chunks_entry  ON chunks(entry_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_emb    ON chunks(embedding);

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

  return db;
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