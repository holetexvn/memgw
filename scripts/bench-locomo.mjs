#!/usr/bin/env node
// LoCoMo benchmark adapter: measures end-to-end recall through the REAL pipeline.
//
// Each conversation is captured session by session and flushed through
// extraction + dedup, then every question is answered from memory search alone
// (facts + raw events) and graded by an LLM judge. That makes the score reflect
// the whole system -- capture, distillation, retrieval -- not just search.
//
// Dataset: data/locomo10.json from https://github.com/snap-research/locomo
// Categories: 1 multi-hop, 2 temporal, 3 open-domain, 4 single-hop,
//             5 adversarial (correct answer = refuse to answer).
//
// Usage (point MEMGW_HOME at a SCRATCH store, never your real one):
//   MEMGW_HOME=/tmp/memgw-bench node scripts/bench-locomo.mjs locomo10.json \
//     [--convs 2] [--questions 40] [--concurrency 6] [--skip-ingest]
//     [--offset 4] [--ingest-only] [--category 1]   # 1 = multi-hop only
//
// Cost driver is ingestion (2 LLM calls per session) and 2 calls per question.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

// --- config: hydrate process.env from the (scratch) env file, like config.js ---
const HOME_DIR = process.env.MEMGW_HOME || join(homedir(), ".memgw");
for (const line of readFileSync(join(HOME_DIR, "env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !(m[1] in process.env) && m[2] !== "") process.env[m[1]] = m[2];
}
const PORT = process.env.MEMGW_PORT || "8930";
const KEY = process.env.MEMGW_KEY;
const URL_ = `http://127.0.0.1:${PORT}`;
const { chat } = await import(join(ROOT, "src/llm.js"));

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
};
const dataFile = argv.find((a) => !a.startsWith("--")) || join(HOME_DIR, "locomo10.json");
const OFFSET = Number(opt("offset", 0));
const N_CONVS = Number(opt("convs", 10));
const N_QUESTIONS = Number(opt("questions", 1e9)); // per conversation
const CONCURRENCY = Number(opt("concurrency", 6));
const SKIP_INGEST = argv.includes("--skip-ingest");
const INGEST_ONLY = argv.includes("--ingest-only");
const ITERATIVE = argv.includes("--iterative"); // allow one follow-up search, like a real agent

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${URL_}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.json();
}

// "1:56 pm on 8 May, 2023" -> epoch ms
function parseSessionDate(s) {
  const m = String(s).match(/(\d{1,2}):(\d{2})\s*(am|pm)\s*on\s*(\d{1,2})\s+(\w+),?\s+(\d{4})/i);
  if (!m) return Date.now();
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === "pm") h += 12;
  return new Date(`${m[5]} ${m[4]}, ${m[6]} ${h}:${m[2]}:00`).getTime();
}

async function ingestConversation(sample) {
  const conv = sample.conversation;
  const sessionKeys = Object.keys(conv)
    .filter((k) => /^session_\d+$/.test(k))
    .sort((a, b) => Number(a.split("_")[1]) - Number(b.split("_")[1]));
  for (const sk of sessionKeys) {
    const date = conv[`${sk}_date_time`] || "";
    const base = parseSessionDate(date);
    const messages = conv[sk].map((t, i) => {
      let text = t.text || "";
      if (t.blip_caption) text += ` [shares a photo: ${t.blip_caption}]`;
      if (i === 0 && date) text = `(This conversation happens at ${date}.) ${text}`;
      return {
        role: t.speaker === conv.speaker_a ? "user" : "assistant",
        content: `${t.speaker}: ${text}`,
        ts: base + i * 1000,
      };
    });
    const sid = `locomo-${sample.sample_id}-${sk}`;
    await api("/capture", { method: "POST", body: { source: "bench", session_id: sid, messages } });
    const r = await api("/flush", { method: "POST", body: { session_id: sid } });
    if (r.error) console.error(`  flush error in ${sid}: ${r.error}`);
    process.stdout.write(".");
  }
  process.stdout.write("\n");
}

const ANSWER_SYSTEM = `You answer questions about two people from memory snippets.
Use ONLY the snippets. Answer in a few words, no explanation. Dates: use the
format "8 May 2023". Resolve relative time against the snippet dates: "yesterday"
said in a conversation dated 8 May 2023 means 7 May 2023. If the snippets do not
contain the answer, reply exactly: NOT ANSWERABLE`;

const JUDGE_SYSTEM = `Grade a memory system. Given a question, the gold answer and
a prediction, reply YES if the prediction conveys the same answer (paraphrase,
different date format, or extra detail is fine), otherwise NO. Reply one word.`;

async function searchBoth(query) {
  const [facts, events] = await Promise.all([
    api(`/search/facts?q=${encodeURIComponent(query)}&limit=8`),
    api(`/search/events?q=${encodeURIComponent(query)}&limit=6`),
  ]);
  return [
    ...facts.results.map((f) => `- [${f.type}] ${f.content}`),
    ...events.results.map(
      (e) => `- [said on ${new Date(e.ts).toDateString()}] ${String(e.content).slice(0, 400)}`
    ),
  ];
}

const ITER_SYSTEM = `You answer questions about two people from memory snippets.
Use ONLY the snippets. If they contain the answer, reply with it in a few words.
If one specific piece is missing, reply exactly: SEARCH: <short keyword query>
You get only ONE extra search, so make the query count. Dates: use the format
"8 May 2023" and resolve relative time against the snippet dates. If nothing in
memory can answer, reply exactly: NOT ANSWERABLE`;

async function answerOne(q) {
  let snippets = await searchBoth(q.question);
  let pred;
  if (ITERATIVE) {
    const r1 = await chat(ITER_SYSTEM, `MEMORY:\n${snippets.join("\n")}\n\nQUESTION: ${q.question}`);
    const t1 = (r1.text || "").trim();
    const m = t1.match(/^SEARCH:\s*(.+)$/im);
    if (m) {
      const extra = await searchBoth(m[1].trim());
      snippets = [...new Set([...snippets, ...extra])];
      const r2 = await chat(ANSWER_SYSTEM, `MEMORY:\n${snippets.join("\n")}\n\nQUESTION: ${q.question}`);
      pred = (r2.text || "").trim();
    } else {
      pred = t1;
    }
  } else {
    const a = await chat(ANSWER_SYSTEM, `MEMORY:\n${snippets.join("\n")}\n\nQUESTION: ${q.question}`);
    pred = (a.text || "").trim();
  }
  const abstained = /NOT ANSWERABLE/i.test(pred);

  let correct;
  if (q.category === 5) {
    correct = abstained; // adversarial: the right move is to refuse
  } else if (abstained) {
    correct = false;
  } else {
    const j = await chat(
      JUDGE_SYSTEM,
      `QUESTION: ${q.question}\nGOLD: ${q.answer}\nPREDICTION: ${pred}`
    );
    correct = /^\s*YES/i.test(j.text || "");
  }
  return { ...q, pred, correct };
}

async function pool(items, worker, size, onDone) {
  const out = [];
  let i = 0;
  const runners = Array.from({ length: size }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx]);
      process.stdout.write(out[idx].correct ? "+" : "-");
      onDone?.(idx, out[idx]);
    }
  });
  await Promise.all(runners);
  process.stdout.write("\n");
  return out;
}

// ------------------------------------------------------------------ main
const data = JSON.parse(readFileSync(dataFile, "utf8")).slice(OFFSET, OFFSET + N_CONVS);
console.log(`LoCoMo: ${data.length} conversation(s) from offset ${OFFSET}, model ${process.env.MEMGW_LLM_MODEL}, store ${HOME_DIR}`);

const t0 = Date.now();
if (!SKIP_INGEST) {
  for (const [i, sample] of data.entries()) {
    console.log(`ingest ${i + 1}/${data.length} (${sample.sample_id})`);
    await ingestConversation(sample);
  }
  console.log(`ingest done in ${Math.round((Date.now() - t0) / 1000)}s`);
}
if (INGEST_ONLY) process.exit(0);

const CATEGORY = Number(opt("category", 0)); // 0 = all
const questions = data
  .flatMap((s) => s.qa.slice(0, N_QUESTIONS))
  .filter((q) => !CATEGORY || q.category === CATEGORY)
  .map((q, i) => ({ ...q, qidx: i }));

// Every answered question is appended to a JSONL log, and a rerun with the same
// --resume file skips what is already answered -- a killed run loses nothing.
const { appendFileSync } = await import("node:fs");
const RESUME = opt("resume", "");
let done = new Map();
if (RESUME && existsSync(RESUME)) {
  for (const line of readFileSync(RESUME, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); done.set(r.qidx, r); } catch {}
  }
  console.log(`resume: ${done.size} answers loaded from ${RESUME}`);
}
const todo = questions.filter((q) => !done.has(q.qidx));
console.log(`answering ${todo.length} questions (${questions.length} total)...`);
const fresh = await pool(todo, answerOne, CONCURRENCY, (idx, r) => {
  if (RESUME) appendFileSync(RESUME, JSON.stringify({ qidx: r.qidx, category: r.category, correct: r.correct, question: r.question, answer: r.answer ?? null, pred: r.pred }) + "\n");
});
const results = [...done.values(), ...fresh];

const CATS = { 1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop", 5: "adversarial" };
const byCat = {};
for (const r of results) (byCat[r.category] ||= []).push(r);
console.log("\ncategory        n    accuracy");
for (const c of Object.keys(byCat).sort()) {
  const rs = byCat[c];
  const acc = rs.filter((r) => r.correct).length / rs.length;
  console.log(`${CATS[c].padEnd(14)} ${String(rs.length).padStart(4)}    ${(acc * 100).toFixed(1)}%`);
}
const overall = results.filter((r) => r.correct).length / results.length;
console.log(`${"OVERALL".padEnd(14)} ${String(results.length).padStart(4)}    ${(overall * 100).toFixed(1)}%`);
console.log(`total time ${Math.round((Date.now() - t0) / 1000)}s`);

// keep the failures around for error analysis
const { writeFileSync } = await import("node:fs");
const failFile = join(HOME_DIR, "locomo-failures.json");
writeFileSync(failFile, JSON.stringify(results.filter((r) => !r.correct), null, 2));
console.log(`failures written to ${failFile}`);
