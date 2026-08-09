// Optional semantic layer: hybrid BM25 + vector retrieval with RRF fusion.
//
// Design constraints, in order:
// - No new dependencies and no vector database. Vectors are Float32 BLOBs in
//   SQLite, compared brute-force in JS. At personal-store scale (thousands of
//   facts, tens of thousands of retained events) a full scan is well under a
//   millisecond per thousand rows.
// - Fully optional. MEMGW_EMBED_MODEL unset (or mock mode) means everything
//   falls back to the plain BM25 path; nothing else changes behaviour.
// - Capture never waits on the network. Embeddings are backfilled in the
//   background; rows not yet embedded are still found by BM25.
//
// Uses the same OpenAI-compatible credentials as the LLM client
// (MEMGW_LLM_BASE_URL / MEMGW_LLM_API_KEY).

import { searchFacts, searchEvents } from "./db.js";

const cfg = () => ({
  baseUrl: (process.env.MEMGW_LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
  apiKey: process.env.MEMGW_LLM_API_KEY || "",
  model: process.env.MEMGW_EMBED_MODEL || "",
  dim: Number(process.env.MEMGW_EMBED_DIM || 512),
  mock: process.env.MEMGW_LLM_MOCK === "1",
});

export const embeddingsEnabled = () => {
  const c = cfg();
  return Boolean(c.model && c.apiKey && !c.mock);
};

// --- API ----------------------------------------------------------------

export async function embedTexts(texts, { timeoutMs = 20_000 } = {}) {
  const c = cfg();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${c.baseUrl}/embeddings`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify({ model: c.model, input: texts, dimensions: c.dim }),
    });
    if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return data.data.map((d) => Float32Array.from(d.embedding));
  } finally {
    clearTimeout(t);
  }
}

const pack = (vec) => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
const unpack = (blob) => new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// --- storage ------------------------------------------------------------

export function ensureEmbedTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS embeddings (
    kind TEXT NOT NULL, id TEXT NOT NULL, vec BLOB NOT NULL,
    PRIMARY KEY (kind, id)
  );
  CREATE TABLE IF NOT EXISTS embeddings_meta (k TEXT PRIMARY KEY, v TEXT)`);
  // Vectors from different models or dimensions must never be mixed: cosine
  // between them is meaningless. When the configured model/dim changes, wipe and
  // let the backfill rebuild everything under the new signature.
  const c = cfg();
  const sig = `${c.model}@${c.dim}`;
  const stored = db.prepare(`SELECT v FROM embeddings_meta WHERE k = 'signature'`).get()?.v;
  if (stored !== sig) {
    if (stored) db.exec(`DELETE FROM embeddings`);
    db.prepare(`INSERT OR REPLACE INTO embeddings_meta (k, v) VALUES ('signature', ?)`).run(sig);
  }
}

/** Embed rows that do not have a vector yet. Returns how many were embedded. */
export async function backfillEmbeddings(db, { batch = 128 } = {}) {
  if (!embeddingsEnabled()) return { embedded: 0 };
  ensureEmbedTable(db);
  const pending = [
    ...db.prepare(
      `SELECT 'fact' kind, id, content FROM facts WHERE status='active'
       AND id NOT IN (SELECT id FROM embeddings WHERE kind='fact') LIMIT ?`
    ).all(batch),
    ...db.prepare(
      `SELECT 'event' kind, id, content FROM events
       WHERE id NOT IN (SELECT id FROM embeddings WHERE kind='event') LIMIT ?`
    ).all(batch),
  ];
  if (!pending.length) return { embedded: 0 };
  const vecs = await embedTexts(pending.map((p) => String(p.content).slice(0, 4000)));
  const ins = db.prepare(`INSERT OR REPLACE INTO embeddings (kind, id, vec) VALUES (?,?,?)`);
  const tx = db.transaction(() => pending.forEach((p, i) => ins.run(p.kind, p.id, pack(vecs[i]))));
  tx();
  return { embedded: pending.length };
}

// --- hybrid search ------------------------------------------------------

/** Reciprocal-rank fusion of two ranked id lists. Standard k=60. */
export function rrf(listA, listB, k = 60) {
  const score = new Map();
  for (const [rank, id] of listA.entries()) score.set(id, (score.get(id) || 0) + 1 / (k + rank + 1));
  for (const [rank, id] of listB.entries()) score.set(id, (score.get(id) || 0) + 1 / (k + rank + 1));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

// Below this cosine the neighbour is noise, not a match. Without a floor, vector
// search "finds" something for EVERY query -- including queries about things the
// store has never seen -- which breaks the empty-result signal an agent needs in
// order to say "I don't know".
const MIN_SIM = 0.3;

function vectorTop(db, kind, qvec, limit) {
  const rows = db.prepare(`SELECT id, vec FROM embeddings WHERE kind = ?`).all(kind);
  return rows
    .map((r) => ({ id: r.id, sim: cosine(qvec, unpack(r.vec)) }))
    .filter((r) => r.sim >= MIN_SIM)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit)
    .map((r) => r.id);
}

async function queryVec(q) {
  try {
    const [v] = await embedTexts([q], { timeoutMs: 3000 });
    return v;
  } catch {
    return null; // embedding API down -> BM25-only, never fail the search
  }
}

export async function hybridSearchFacts(db, q, opts = {}) {
  const bm25 = searchFacts(db, q, { ...opts, limit: (opts.limit ?? 8) * 2 });
  if (!embeddingsEnabled()) return bm25.slice(0, opts.limit ?? 8);
  const qvec = await queryVec(q);
  if (!qvec) return bm25.slice(0, opts.limit ?? 8);

  ensureEmbedTable(db);
  const vecIds = vectorTop(db, "fact", qvec, (opts.limit ?? 8) * 2);
  const fused = rrf(bm25.map((r) => r.id), vecIds);
  const byId = new Map(bm25.map((r) => [r.id, r]));
  const fetchOne = db.prepare(`SELECT * FROM facts WHERE id = ? AND status = 'active'`);
  const out = [];
  for (const id of fused) {
    const row = byId.get(id) || fetchOne.get(id);
    if (!row) continue;
    if (opts.type && row.type !== opts.type) continue;
    if (opts.topic && row.topic !== opts.topic) continue;
    out.push(row);
    if (out.length >= (opts.limit ?? 8)) break;
  }
  return out;
}

export async function hybridSearchEvents(db, q, opts = {}) {
  const bm25 = searchEvents(db, q, { ...opts, limit: (opts.limit ?? 10) * 2 });
  if (!embeddingsEnabled()) return bm25.slice(0, opts.limit ?? 10);
  const qvec = await queryVec(q);
  if (!qvec) return bm25.slice(0, opts.limit ?? 10);

  ensureEmbedTable(db);
  const vecIds = vectorTop(db, "event", qvec, (opts.limit ?? 10) * 2);
  const fused = rrf(bm25.map((r) => r.id), vecIds);
  const byId = new Map(bm25.map((r) => [r.id, r]));
  const fetchOne = db.prepare(`SELECT * FROM events WHERE id = ?`);
  const out = [];
  for (const id of fused) {
    const row = byId.get(id) || fetchOne.get(id);
    if (!row) continue;
    if (opts.session && row.session_id !== opts.session) continue;
    out.push(row);
    if (out.length >= (opts.limit ?? 10)) break;
  }
  return out;
}
