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

    CREATE INDEX IF NOT EXISTS idx_entries_pub   ON entries(pub_date);
    CREATE INDEX IF NOT EXISTS idx_entries_cache ON entries(cached_at);
    CREATE INDEX IF NOT EXISTS idx_chunks_entry  ON chunks(entry_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text, content='chunks', content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
    END;
  `);
  return db;
}