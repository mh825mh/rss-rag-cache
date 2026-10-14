import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getDbPath } from "./config.js";
import { bufferToFloat32, vectorNorm } from "./embedder.js";
import { contentHash, entrySimhash } from "./hashes.js";
import { log } from "./log.js";

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

  // Baseline schema for fresh databases. Keep this in sync with the migrations
  // below; migrations are idempotent so they are safe to run against both.
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      guid         TEXT UNIQUE,
      feed_url     TEXT,
      title        TEXT,
      link         TEXT,
      author       TEXT,
      pub_date     INTEGER,
      summary      TEXT,
      content      TEXT,
      title_key    TEXT,
      content_hash TEXT,
      simhash      INTEGER,
      tags         TEXT,
      cached_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id     INTEGER NOT NULL,
      chunk_index  INTEGER NOT NULL,
      text         TEXT NOT NULL,
      embedding    BLOB,
      norm         REAL,
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
  `);

  runMigrations(db);
  return db;
}

// ---------------------------------------------------------------------------
// Migrations (PRAGMA user_version). Each migration must be idempotent; older
// databases start at version 0 and step through every one.
// ---------------------------------------------------------------------------

function columnExists(db, table, name) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name);
  } catch {
    return false;
  }
}

function addColumn(db, table, name, decl) {
  if (!columnExists(db, table, name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
}

function ensureTrigramFts(db) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks_fts'`).get();
  if (row && /trigram/i.test(row.sql)) return;
  log.info("Rebuilding full-text index with trigram tokenizer...");
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

// Second FTS index with the porter+unicode61 tokenizer. Complements trigram:
// porter handles English stemming/word matching (and gives meaningful BM25
// ranking), while trigram remains best for CJK and substring matches.
function ensureEnglishFts(db) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks_fts_en'`).get();
  if (row && /porter/i.test(row.sql)) return;
  log.info("Building English (porter) full-text index...");
  db.exec(`
    DROP TRIGGER IF EXISTS chunks_ai_en;
    DROP TRIGGER IF EXISTS chunks_ad_en;
    DROP TABLE IF EXISTS chunks_fts_en;
    CREATE VIRTUAL TABLE chunks_fts_en USING fts5(
      text, content='chunks', content_rowid='id', tokenize='porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS chunks_ai_en AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts_en(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad_en AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts_en(chunks_fts_en, rowid, text) VALUES('delete', old.id, old.text);
    END;
  `);
  db.exec(`INSERT INTO chunks_fts_en(chunks_fts_en) VALUES('rebuild');`);
}

function backfillEntryHashes(db) {
  let rows;
  try {
    rows = db.prepare(`SELECT id, title, summary, content, content_hash, simhash FROM entries WHERE content_hash IS NULL OR simhash IS NULL`).all();
  } catch {
    return;
  }
  if (!rows.length) return;
  const upd = db.prepare(`UPDATE entries SET content_hash = ?, simhash = ? WHERE id = ?`);
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      upd.run(contentHash(r.title, r.summary, r.content), entrySimhash(r.summary, r.content), r.id);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    log.warn("entry-hash backfill failed:", e.message);
  }
}

const MIGRATIONS = [
  {
    version: 1,
    name: "add title_key + unique index (cross-feed dedup)",
    up(db) {
      addColumn(db, "entries", "title_key", "TEXT");
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_title_key ON entries(title_key)`);
    },
  },
  {
    version: 2,
    name: "rebuild chunks_fts with trigram tokenizer",
    up(db) { ensureTrigramFts(db); },
  },
  {
    version: 3,
    name: "drop useless embedding index",
    up(db) { db.exec(`DROP INDEX IF EXISTS idx_chunks_emb`); },
  },
  {
    version: 4,
    name: "add chunks.norm + backfill",
    up(db) {
      if (!columnExists(db, "chunks", "norm")) {
        db.exec(`ALTER TABLE chunks ADD COLUMN norm REAL`);
        backfillNorms(db);
      }
    },
  },
  {
    version: 5,
    name: "add English (porter) FTS index",
    up(db) { ensureEnglishFts(db); },
  },
  {
    version: 6,
    name: "add entries.content_hash / simhash / tags + backfill",
    up(db) {
      addColumn(db, "entries", "content_hash", "TEXT");
      addColumn(db, "entries", "simhash", "INTEGER");
      addColumn(db, "entries", "tags", "TEXT");
      backfillEntryHashes(db);
    },
  },
];

function runMigrations(db) {
  const current = Number(db.prepare(`PRAGMA user_version`).get()?.user_version) || 0;
  const latest = MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;
  if (current >= latest) return;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
    } catch (e) {
      log.error(`Migration ${m.version} (${m.name}) failed:`, e.message);
      throw e;
    }
  }
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
    log.warn("norm backfill failed:", e.message);
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
