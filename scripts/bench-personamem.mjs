#!/usr/bin/env node
// PersonaMem benchmark adapter (multiple-choice, no LLM judge).
//
// Each shared context is ONE persona's multi-session history. Questions are
// anchored to a position in that history (end_index_in_shared_context), so the
// context is ingested incrementally: capture + flush up to the cutoff, answer
// the questions that live there, continue. The store is WIPED between contexts
// -- mixing 37 personas in one personal store would only measure contamination.
//
// Data (HuggingFace bowen-upenn/PersonaMem, 32k tier):
//   shared_contexts_32k.jsonl -- used as-is
//   questions_32k.csv -- convert to JSONL first; `all_options` is a Python-repr
//   list in most rows, so parse it with ast.literal_eval, not json:
//     python3 -c "import csv,json,ast; \
//       [print(json.dumps({**r, 'all_options': ast.literal_eval(r['all_options'])})) \
//        for r in csv.DictReader(open('questions_32k.csv'))]" > questions_32k.jsonl
//
// Run one instance per gateway; parallelise with --offset/--stride:
//   MEMGW_HOME=<scratch> node scripts/bench-personamem.mjs \
//     questions.jsonl contexts.jsonl --offset 0 --stride 4 --resume out.jsonl
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const HOME_DIR = process.env.MEMGW_HOME || join(homedir(), ".memgw");
for (const line of readFileSync(join(HOME_DIR, "env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !(m[1] in process.env) && m[2] !== "") process.env[m[1]] = m[2];
}
const PORT = process.env.MEMGW_PORT || "8930";
const KEY = process.env.MEMGW_KEY;
const URL_ = `http://127.0.0.1:${PORT}`;
const DB_PATH = join(HOME_DIR, "data", "memgw.db");
const { chat } = await import(join(ROOT, "src/llm.js"));

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};
const [qFile, cFile] = argv.filter((a) => !a.startsWith("--") && !/^\d+$/.test(a));
const OFFSET = Number(opt("offset", 0));
const STRIDE = Number(opt("stride", 1));
const LIMIT = Number(opt("contexts", 1e9));
const RESUME = opt("resume", "");

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${URL_}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.json();
}

// direct wipe between personas; WAL + busy_timeout make this safe alongside the gateway
function wipeStore() {
  const db = new Database(DB_PATH);
  db.pragma("busy_timeout = 10000");
  db.exec("DELETE FROM facts; DELETE FROM facts_fts; DELETE FROM events; DELETE FROM events_fts;");
  try {
    db.exec("DELETE FROM embeddings;");
  } catch {}
  db.close();
}

// hybrid search needs vectors; wait briefly for the async backfill to catch up
async function waitForVectors() {
  for (let i = 0; i < 20; i++) {
    const s = await api("/stats");
    if (s.counts.vectors >= s.counts.facts_active + s.counts.events) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const CHUNK = 18; // messages per capture session, within the worker's batch size

async function ingestSlice(cid, messages, from, to, baseTs) {
  for (let s = from; s < to; s += CHUNK) {
    const chunk = messages.slice(s, Math.min(s + CHUNK, to));
    const sid = `pmem-${cid.slice(0, 8)}-${s}`;
    await api("/capture", {
      method: "POST",
      body: {
        source: "bench",
        session_id: sid,
        messages: chunk.map((m, i) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.role === "system" ? `User persona: ${m.content}` : m.content,
          ts: baseTs + (s + i) * 60_000,
        })),
      },
    });
    const r = await api("/flush", { method: "POST", body: { session_id: sid } });
    if (r.error) console.error(`  flush error ${sid}: ${r.error}`);
    process.stdout.write(".");
  }
}

const ANSWER_SYSTEM = `You are the user's assistant, choosing the best personalized
reply. MEMORY holds what is known about this user from earlier sessions. Pick the
option that best fits the user's CURRENT preferences and history. Reply with the
single option letter in parentheses, e.g. (b), and nothing else.`;

async function answerOne(q) {
  const query = q.user_question_or_message.slice(0, 300);
  const [facts, events] = await Promise.all([
    api(`/search/facts?q=${encodeURIComponent(query)}&limit=8`),
    api(`/search/events?q=${encodeURIComponent(query)}&limit=6`),
  ]);
  const ctx = [
    ...facts.results.map((f) => `- [${f.type}] ${f.content}`),
    ...events.results.map((e) => `- ${String(e.content).slice(0, 300)}`),
  ].join("\n");
  const options = q.all_options.join("\n"); // parsed to a real array at CSV->JSONL conversion
  const r = await chat(
    ANSWER_SYSTEM,
    `MEMORY:\n${ctx}\n\nUSER MESSAGE: ${q.user_question_or_message}\n\nOPTIONS:\n${options}\n\nBest option letter:`
  );
  const m = (r.text || "").match(/\(([a-h])\)/i);
  const pred = m ? `(${m[1].toLowerCase()})` : "(?)";
  return { qid: q.question_id, type: q.question_type, pred, gold: q.correct_answer, correct: pred === q.correct_answer };
}

// ------------------------------------------------------------------ main
const questions = readFileSync(qFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const contexts = readFileSync(cFile, "utf8").trim().split("\n").map((l) => {
  const o = JSON.parse(l);
  const [id, msgs] = Object.entries(o)[0];
  return { id, msgs };
});

const done = new Set();
if (RESUME && existsSync(RESUME))
  for (const l of readFileSync(RESUME, "utf8").split("\n"))
    if (l.trim()) try { done.add(JSON.parse(l).qid); } catch {}

const mine = contexts.filter((_, i) => i % STRIDE === OFFSET).slice(0, LIMIT);
console.log(`PersonaMem: ${mine.length} contexts (offset ${OFFSET} stride ${STRIDE}), port ${PORT}, model ${process.env.MEMGW_LLM_MODEL}, embed ${process.env.MEMGW_EMBED_MODEL || "off"}`);

for (const ctx of mine) {
  const qs = questions
    .filter((q) => q.shared_context_id === ctx.id && !done.has(q.question_id))
    .sort((a, b) => Number(a.end_index_in_shared_context) - Number(b.end_index_in_shared_context));
  if (!qs.length) continue;
  console.log(`\ncontext ${ctx.id.slice(0, 8)}: ${ctx.msgs.length} msgs, ${qs.length} questions`);
  wipeStore();
  const baseTs = Date.UTC(2025, 0, 1);
  let ingested = 0;
  for (const q of qs) {
    const cut = Math.min(Number(q.end_index_in_shared_context) + 1, ctx.msgs.length);
    if (cut > ingested) {
      await ingestSlice(ctx.id, ctx.msgs, ingested, cut, baseTs);
      ingested = cut;
      await waitForVectors();
    }
    const r = await answerOne(q);
    process.stdout.write(r.correct ? "+" : "-");
    if (RESUME) appendFileSync(RESUME, JSON.stringify(r) + "\n");
  }
}
console.log("\nworker done");
