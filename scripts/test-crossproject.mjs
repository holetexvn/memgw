#!/usr/bin/env node
// Cross-project retrieval test: with several projects in ONE store, does search
// return the right project's facts, and how much do neighbours contaminate?
//
// Four synthetic projects share vocabulary on purpose (port, database, deploy
// failure, styling) but disagree on every value. Their conversations go through
// the REAL extraction pipeline, then two question sets measure retrieval only
// (string match against expected values -- no judge, deterministic):
//
//   scoped     "what port does shopmate use?"  -> right value must rank top-3
//   ambiguous  "what port do we use?"          -> reported, not scored: shows
//                                                what a context-free query pulls
//
// Run against a SCRATCH store: MEMGW_HOME=<scratch> node scripts/test-crossproject.mjs
// Cost: ~$0.3 for ingestion (extraction); retrieval scoring is free.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME_DIR = process.env.MEMGW_HOME || join(homedir(), ".memgw");
for (const line of readFileSync(join(HOME_DIR, "env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !(m[1] in process.env) && m[2] !== "") process.env[m[1]] = m[2];
}
const PORT = process.env.MEMGW_PORT || "8930";
const KEY = process.env.MEMGW_KEY;

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- dataset
// Same nouns everywhere, different values per project: worst case for BM25.
const PROJECTS = {
  shopmate: {
    port: "3002", db: "Postgres", deploy: "Alpine image lacked glibc", style: "Tailwind",
  },
  pixelio: {
    port: "8080", db: "SQLite", deploy: "Vercel build hit the 45s timeout", style: "CSS Modules",
  },
  quantbot: {
    port: "5000", db: "TimescaleDB", deploy: "Bun runtime could not load the native addon", style: "no UI",
  },
  medlink: {
    port: "9090", db: "MySQL", deploy: "Kubernetes pod was OOM-killed at 512Mi", style: "styled-components",
  },
};

function sessions() {
  const out = [];
  let t = Date.UTC(2025, 2, 1);
  for (const [name, v] of Object.entries(PROJECTS)) {
    out.push({
      id: `xp-${name}`,
      messages: [
        { role: "user", content: `Let's set up the ${name} project. The dev server should run on port ${v.port}, that's now the standard port for ${name}.`, ts: (t += 60000) },
        { role: "assistant", content: `Understood, ${name} runs on port ${v.port}.`, ts: (t += 60000) },
        { role: "user", content: `For the database we compared the options and decided: ${name} uses ${v.db}. That's final.`, ts: (t += 60000) },
        { role: "assistant", content: `Noted, ${v.db} it is for ${name}.`, ts: (t += 60000) },
        { role: "user", content: `Also, we tried deploying ${name} last week and it failed: ${v.deploy}. Don't suggest that path again for ${name}.`, ts: (t += 60000) },
        { role: "assistant", content: `Recorded as a dead end for ${name}.`, ts: (t += 60000) },
        { role: "user", content: `Styling for ${name}: we settled on ${v.style}.`, ts: (t += 60000) },
        { role: "assistant", content: `Got it.`, ts: (t += 60000) },
      ],
    });
  }
  return out;
}

// ---------------------------------------------------------------- run
console.log(`cross-project test against :${PORT} (embed: ${process.env.MEMGW_EMBED_MODEL || "off"})`);

if (!process.argv.includes("--skip-ingest")) {
  for (const s of sessions()) {
    await api("/capture", { method: "POST", body: { source: "test", session_id: s.id + "-" + Date.now(), messages: s.messages } });
    const r = await api("/flush", { method: "POST", body: {} });
    if (r.error) console.error("flush error:", r.error);
    process.stdout.write(".");
  }
  console.log(" ingested 4 projects");
  await new Promise((r) => setTimeout(r, 2000));
}

// expected marker per aspect: one distinctive token, not a rigid phrase --
// extraction rewrites sentences, so "pods were OOM-killed" must still match.
const MARKERS = {
  shopmate: { port: "3002", database: "Postgres", "deploy failure": "glibc", styling: "Tailwind" },
  pixelio: { port: "8080", database: "SQLite", "deploy failure": "Vercel", styling: "CSS Modules" },
  quantbot: { port: "5000", database: "TimescaleDB", "deploy failure": "Bun" },
  medlink: { port: "9090", database: "MySQL", "deploy failure": "OOM", styling: "styled-components" },
};

let pass = 0, fail = 0;
console.log("\nSCOPED queries (right value must appear in top-3 facts):");
for (const [name, aspects] of Object.entries(MARKERS)) {
  for (const [aspect, marker] of Object.entries(aspects)) {
    const q = `${name} ${aspect}`;
    const { results } = await api(`/search/facts?q=${encodeURIComponent(q)}&limit=8`);
    const top3 = results.slice(0, 3).map((r) => r.content).join(" | ");
    const hit = top3.toLowerCase().includes(marker.toLowerCase());
    hit ? pass++ : fail++;
    console.log(`  ${hit ? "PASS" : "FAIL"}  "${q}" -> expect "${marker}"${hit ? "" : `\n        top-3: ${top3.slice(0, 160)}`}`);
  }
}

console.log("\nAMBIGUOUS queries (no project named -- what does the agent see?):");
for (const q of ["which port do we use", "what database did we choose", "why did the deploy fail"]) {
  const { results } = await api(`/search/facts?q=${encodeURIComponent(q)}&limit=4`);
  const owners = results.map((r) => Object.keys(PROJECTS).find((p) => r.content.toLowerCase().includes(p)) || "?");
  console.log(`  "${q}" -> top-4 from: [${owners.join(", ")}]`);
}

console.log(`\nscoped: ${pass} pass / ${fail} fail (${((100 * pass) / (pass + fail)).toFixed(0)}%)`);
process.exit(fail > 2 ? 1 : 0); // tolerate 2 misses out of 15
