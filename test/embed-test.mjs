// Embeddings-layer regression suite. Runs WITHOUT any embeddings API:
// what it tests is precisely the behaviour that must hold when the API is
// absent, wrong, or down -- the fallback path that keeps search alive.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, insertFact } from "../src/db.js";
import { hybridSearchFacts, embeddingsEnabled, rrf } from "../src/embed.js";

let pass = 0, fail = 0;
const ok = (n) => { console.log(`PASS ${n}`); pass++; };
const no = (n, why) => { console.log(`FAIL ${n}: ${why}`); fail++; };

const dir = mkdtempSync(join(tmpdir(), "memgw-embed-"));
const db = openDb(join(dir, "t.db"));
insertFact(db, { content: "the billing service uses Postgres", type: "decision", priority: 70 });
insertFact(db, { content: "tried Deno and it failed on better-sqlite3", type: "deadend", priority: 80 });

// 1. rrf: an id ranked well by both lists must beat ids ranked by only one
{
  const fused = rrf(["a", "b", "c"], ["b", "d"]);
  fused[0] === "b" ? ok("rrf: agreement wins") : no("rrf", `order ${fused}`);
}

// 2. embeddings disabled -> plain BM25 results
{
  delete process.env.MEMGW_EMBED_MODEL;
  const r = await hybridSearchFacts(db, "billing postgres", { limit: 5 });
  !embeddingsEnabled() && r.length === 1 && r[0].content.includes("Postgres")
    ? ok("disabled: BM25 path returns the fact")
    : no("disabled path", `enabled=${embeddingsEnabled()} results=${r.length}`);
}

// 3. enabled but API unreachable -> search still answers from BM25 (fallback)
{
  process.env.MEMGW_EMBED_MODEL = "text-embedding-3-small";
  process.env.MEMGW_LLM_API_KEY = process.env.MEMGW_LLM_API_KEY || "k";
  const hadMock = process.env.MEMGW_LLM_MOCK;
  delete process.env.MEMGW_LLM_MOCK; // mock mode would disable embeddings entirely
  process.env.MEMGW_LLM_BASE_URL = "http://127.0.0.1:9/v1"; // nothing listens here
  const t0 = Date.now();
  const r = await hybridSearchFacts(db, "deno better-sqlite3", { limit: 5 });
  const secs = (Date.now() - t0) / 1000;
  r.length === 1 && r[0].type === "deadend" && secs < 10
    ? ok(`api down: BM25 fallback in ${secs.toFixed(1)}s`)
    : no("fallback", `results=${r.length} took=${secs}s`);
  if (hadMock) process.env.MEMGW_LLM_MOCK = hadMock;
  delete process.env.MEMGW_LLM_BASE_URL;
  delete process.env.MEMGW_EMBED_MODEL;
}

// 4. irrelevant query returns EMPTY, not nearest-neighbour noise
{
  const r = await hybridSearchFacts(db, "quantum basket weaving", { limit: 5 });
  r.length === 0 ? ok("irrelevant query: empty result preserved") : no("empty-result", `got ${r.length}`);
}

// 5-7. SUCCESS path against a local fake embeddings API: backfill persists
// vectors, cosine retrieval finds what BM25 cannot, and a model/dim change
// wipes stale vectors. Deterministic vectors: axis 0 = "postgres-ish" text,
// axis 1 = "deno-ish", axis 2 = everything else.
{
  const { createServer } = await import("node:http");
  const DIM = 16;
  const fakeVec = (text) => {
    const v = new Array(DIM).fill(0);
    const t = String(text).toLowerCase();
    if (t.includes("postgres") || t.includes("database-animal")) v[0] = 1;
    else if (t.includes("deno")) v[1] = 1;
    else v[2] = 1;
    return v;
  };
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const input = JSON.parse(body).input;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: (Array.isArray(input) ? input : [input]).map((t, index) => ({ index, embedding: fakeVec(t) })) }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;

  process.env.MEMGW_EMBED_MODEL = "fake-embed";
  process.env.MEMGW_EMBED_DIM = String(DIM);
  process.env.MEMGW_LLM_API_KEY = "k";
  const hadMock = process.env.MEMGW_LLM_MOCK;
  delete process.env.MEMGW_LLM_MOCK;
  process.env.MEMGW_LLM_BASE_URL = `http://127.0.0.1:${port}`;

  const { backfillEmbeddings, ensureEmbedTable } = await import("../src/embed.js");
  const r5 = await backfillEmbeddings(db);
  const stored = db.prepare(`SELECT COUNT(*) n FROM embeddings`).get().n;
  r5.embedded >= 2 && stored >= 2
    ? ok(`backfill persisted ${stored} vectors via the API`)
    : no("backfill", `embedded=${r5.embedded} stored=${stored}`);

  // "database-animal" shares NO keyword with the Postgres fact (BM25 finds
  // nothing) but the fake API maps it onto the same axis -- only the vector
  // path can produce this hit
  const r6 = await hybridSearchFacts(db, "database-animal", { limit: 5 });
  r6.length === 1 && r6[0].content.includes("Postgres")
    ? ok("cosine retrieval found what BM25 could not")
    : no("vector retrieval", `got ${r6.length}: ${r6[0]?.content ?? ""}`);

  process.env.MEMGW_EMBED_DIM = String(DIM * 2); // signature change
  ensureEmbedTable(db);
  const after = db.prepare(`SELECT COUNT(*) n FROM embeddings`).get().n;
  after === 0 ? ok("model/dim change wiped stale vectors") : no("signature reset", `${after} rows left`);

  srv.close();
  if (hadMock) process.env.MEMGW_LLM_MOCK = hadMock;
  delete process.env.MEMGW_LLM_BASE_URL;
  delete process.env.MEMGW_EMBED_MODEL;
  delete process.env.MEMGW_EMBED_DIM;
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
