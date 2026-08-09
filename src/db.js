// SQLite schema and query helpers. One database file, WAL mode, FTS5 for search.
import Database from "better-sqlite3";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // auto_vacuum only takes effect if set before any table exists (new databases).
  // It lets retention return freed pages to the OS via incremental_vacuum.
  db.pragma("auto_vacuum = INCREMENTAL");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  migrateFtsTokenizer(db);
  // The database holds raw transcripts: keep it (and its WAL/SHM siblings, which
  // appear on first write) out of reach of other local users. Only the FILES are
  // chmodded here -- never the parent directory, which with a custom
  // MEMGW_DB_PATH could be a shared location like /tmp. The default ~/.memgw
  // directory is tightened by config.js instead.
  try {
    for (const suffix of ["", "-shm", "-wal"]) {
      if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600);
    }
  } catch {}
  return db;
}

// Databases created before porter stemming was added ("research" would not match
// "researching") still carry the old tokenizer. FTS tables hold no primary data,
// so rebuild them in place from the base tables.
function migrateFtsTokenizer(db) {
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'facts_fts'`).get()?.sql ?? "";
  if (sql.includes("porter")) return;
  db.exec(`
    DROP TABLE IF EXISTS facts_fts;
    DROP TABLE IF EXISTS events_fts;
    CREATE VIRTUAL TABLE facts_fts USING fts5(
      content, id UNINDEXED, type UNINDEXED, topic UNINDEXED,
      tokenize = 'porter unicode61 remove_diacritics 2'
    );
    CREATE VIRTUAL TABLE events_fts USING fts5(
      content, id UNINDEXED, source UNINDEXED, session_id UNINDEXED,
      tokenize = 'porter unicode61 remove_diacritics 2'
    );
    INSERT INTO facts_fts (content, id, type, topic) SELECT content, id, type, topic FROM facts;
    INSERT INTO events_fts (content, id, source, session_id) SELECT content, id, source, session_id FROM events;
  `);
}

function migrate(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    ts          INTEGER NOT NULL,
    processed   INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_events_cursor  ON events(processed, ts);
  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts);

  CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
    content, id UNINDEXED, source UNINDEXED, session_id UNINDEXED,
    tokenize = 'porter unicode61 remove_diacritics 2'
  );

  CREATE TABLE IF NOT EXISTS facts (
    id          TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    type        TEXT NOT NULL,
    topic       TEXT,
    priority    INTEGER DEFAULT 50,
    source_ids  TEXT,
    version     INTEGER DEFAULT 1,
    status      TEXT DEFAULT 'active',
    created_at  INTEGER,
    updated_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_facts_status ON facts(status, updated_at);

  CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
    content, id UNINDEXED, type UNINDEXED, topic UNINDEXED,
    tokenize = 'porter unicode61 remove_diacritics 2'
  );

  CREATE TABLE IF NOT EXISTS worker_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ran_at      INTEGER,
    sessions    INTEGER,
    events_in   INTEGER,
    facts_new   INTEGER,
    facts_merged INTEGER,
    tokens_in   INTEGER,
    tokens_out  INTEGER,
    error       TEXT
  );
  `);
}

// Deterministic id makes POST /capture idempotent: the same turn always hashes to
// the same id, so clients can retry freely and duplicates collapse. The hash
// covers the SOURCE (two agents may reuse a session id) and the FULL content
// (two long messages sharing a prefix are different turns, not duplicates).
export function eventId(source, sessionId, ts, role, content) {
  return createHash("sha1")
    .update(`${source}|${sessionId}|${ts}|${role}|${content}`)
    .digest("hex")
    .slice(0, 24);
}

// Tokenise, quote each token, OR-join. Combined with the FTS5 tokenizer option
// `remove_diacritics 2`, an unaccented query still matches accented text -- which
// matters for Vietnamese, Spanish, Portuguese and similar languages.
export function buildFtsQuery(raw) {
  const tokens = [...new Set((raw.match(/[\p{L}\p{N}_]+/gu) || []).filter((t) => t.length > 1))];
  if (!tokens.length) return null;
  return tokens.slice(0, 12).map((t) => `"${t}"`).join(" OR ");
}

export function insertEvents(db, source, sessionId, messages) {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO events (id, source, session_id, role, content, ts) VALUES (?,?,?,?,?,?)`
  );
  const insFts = db.prepare(
    `INSERT INTO events_fts (content, id, source, session_id) VALUES (?,?,?,?)`
  );
  let added = 0;
  const tx = db.transaction(() => {
    for (const m of messages) {
      if (!m?.content?.trim()) continue;
      const id = eventId(source, sessionId, m.ts, m.role, m.content);
      const r = ins.run(id, source, sessionId, m.role, m.content, m.ts);
      if (r.changes > 0) {
        insFts.run(m.content, id, source, sessionId);
        added++;
      }
    }
  });
  tx();
  return added;
}

export function searchFacts(db, q, { topic, type, limit = 8 } = {}) {
  const fq = buildFtsQuery(q);
  if (!fq) return [];
  // Filters live in the SQL itself: filtering in JS after a LIMIT would let
  // higher-ranked rows from OTHER topics/types eat the candidate window and
  // hide perfectly valid matches.
  const rows = db
    .prepare(
      `SELECT f.*, bm25(facts_fts) AS rank
       FROM facts_fts JOIN facts f ON f.id = facts_fts.id
       WHERE facts_fts MATCH ? AND f.status = 'active'
         AND (? IS NULL OR f.type = ?) AND (? IS NULL OR f.topic = ?)
       ORDER BY rank ASC LIMIT ?`
    )
    .all(fq, type ?? null, type ?? null, topic ?? null, topic ?? null, limit);
  return rows.map(({ rank, ...r }) => ({ ...r, score: relevance(rank) }));
}

export function searchEvents(db, q, { session, limit = 10 } = {}) {
  const fq = buildFtsQuery(q);
  if (!fq) return [];
  const rows = db
    .prepare(
      `SELECT e.id, e.source, e.session_id, e.role, e.content, e.ts, bm25(events_fts) AS rank
       FROM events_fts JOIN events e ON e.id = events_fts.id
       WHERE events_fts MATCH ? AND (? IS NULL OR e.session_id = ?)
       ORDER BY rank ASC LIMIT ?`
    )
    .all(fq, session ?? null, session ?? null, limit);
  return rows.map(({ rank, ...r }) => ({ ...r, score: relevance(rank) }));
}

// FTS5 bm25() returns a negative rank (more negative = better). Map it to 0..1.
function relevance(rank) {
  if (!Number.isFinite(rank)) return 0;
  const rel = rank < 0 ? -rank : 0;
  return rel / (1 + rel);
}

export function insertFact(db, f) {
  const now = Date.now();
  const id = f.id || createHash("sha1").update(f.content + now + Math.random()).digest("hex").slice(0, 24);
  db.prepare(
    `INSERT INTO facts (id, content, type, topic, priority, source_ids, version, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, f.content, f.type, f.topic ?? null, f.priority ?? 50,
        JSON.stringify(f.source_ids ?? []), f.version ?? 1, "active", now, now);
  db.prepare(`INSERT INTO facts_fts (content, id, type, topic) VALUES (?,?,?,?)`)
    .run(f.content, id, f.type, f.topic ?? null);
  return id;
}

export function supersedeFact(db, id) {
  db.prepare(`UPDATE facts SET status='superseded', updated_at=? WHERE id=?`).run(Date.now(), id);
  db.prepare(`DELETE FROM facts_fts WHERE id=?`).run(id);
}
