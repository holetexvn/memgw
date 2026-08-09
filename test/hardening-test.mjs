// Hardening suite: the attacks the independent review flagged must stay fixed.
// Runs against the mock server that test/run-all.sh starts (KEY=test).
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, symlinkSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PORT = process.env.MEMGW_PORT || "8930";
const KEY = process.env.MEMGW_KEY || "test";
const DATA = process.env.MEMGW_DATA_DIR;
const URL_ = `http://127.0.0.1:${PORT}`;
if (!DATA) throw new Error("MEMGW_DATA_DIR must be set (run via test/run-all.sh)");

let pass = 0, fail = 0;
const ok = (name) => { console.log(`PASS ${name}`); pass++; };
const no = (name, why) => { console.log(`FAIL ${name}: ${why}`); fail++; };
const api = (path, opts = {}) =>
  fetch(`${URL_}${path}`, { ...opts, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...opts.headers } });

// 1. Path traversal on /notes is rejected
{
  const r = await api("/notes/..%2Fenv");
  r.status === 400 || r.status === 404 ? ok("notes: .. traversal rejected") : no("notes traversal", `status ${r.status}`);
}

// 2. Symlink under data/ cannot leak a file outside data/
{
  const secret = join(tmpdir(), `memgw-secret-${process.pid}.md`);
  writeFileSync(secret, "TOP SECRET OUTSIDE DATA DIR");
  const link = join(DATA, "topics", "evil.md");
  rmSync(link, { force: true });
  symlinkSync(secret, link);
  const r = await api("/notes/topics/evil.md");
  const body = await r.text();
  !body.includes("TOP SECRET") ? ok("notes: symlink escape blocked") : no("symlink escape", "leaked outside file");
  rmSync(link, { force: true });
  rmSync(secret, { force: true });
}

// 3. Oversized capture body is refused
{
  const big = { source: "t", session_id: "t", messages: [{ role: "user", content: "x".repeat(6_000_000), ts: 1 }] };
  const r = await api("/capture", { method: "POST", body: JSON.stringify(big) });
  r.status === 413 ? ok("capture: 6MB body -> 413") : no("capture size cap", `status ${r.status}`);
}

// 4. Message count is capped per batch
{
  const msgs = Array.from({ length: 900 }, (_, i) => ({ role: "user", content: `m${i}`, ts: 1000 + i }));
  const r = await api("/capture", {
    method: "POST",
    body: JSON.stringify({ source: "hard", session_id: `cap-${Date.now()}`, messages: msgs }),
  });
  const j = await r.json();
  j.added <= 500 ? ok(`capture: batch capped (added ${j.added})`) : no("capture batch cap", `added ${j.added}`);
}

// 5. Bogus timestamps are normalised, never stored as Infinity/negative
{
  const sid = `ts-${Date.now()}`;
  await api("/capture", {
    method: "POST",
    body: JSON.stringify({
      source: "hard",
      session_id: sid,
      messages: [{ role: "user", content: "ts check one", ts: -5 }, { role: "user", content: "ts check two", ts: "Infinity" }],
    }),
  });
  const r = await (await api(`/search/events?q=ts+check&limit=5`)).json();
  const bad = r.results.some((e) => !Number.isFinite(e.ts) || e.ts <= 0);
  !bad ? ok("capture: timestamps clamped") : no("timestamp clamp", JSON.stringify(r.results.map((e) => e.ts)));
}

// 6. Oversized fact content is refused
{
  const r = await api("/facts", {
    method: "POST",
    body: JSON.stringify({ content: "x".repeat(30000), type: "project" }),
  });
  r.status === 413 ? ok("facts: oversized content -> 413") : no("facts size cap", `status ${r.status}`);
}

// 7. Capture hook sanitises session_id (no cursor file outside cursors/)
{
  const fakeHome = join(tmpdir(), `memgw-hookhome-${process.pid}`);
  mkdirSync(join(fakeHome, ".memgw"), { recursive: true });
  writeFileSync(join(fakeHome, ".memgw", "env"), `MEMGW_URL=${URL_}\nMEMGW_KEY=${KEY}\n`);
  const tr = join(fakeHome, "t.jsonl");
  writeFileSync(tr, JSON.stringify({ type: "user", message: { content: "hook sanitise check" }, timestamp: "2026-01-01T00:00:00.000Z" }) + "\n");
  const evilTarget = join(fakeHome, "evil-escaped");
  execFileSync(process.execPath, [join("hooks", "capture.mjs")], {
    input: JSON.stringify({ transcript_path: tr, session_id: "../evil-escaped", cwd: "/tmp/x" }),
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
  });
  const escaped = existsSync(evilTarget) || existsSync(join(fakeHome, ".memgw", "evil-escaped"));
  const inside = readdirSync(join(fakeHome, ".memgw", "cursors"));
  !escaped && inside.length === 1 && inside[0].startsWith("_")
    ? ok(`hook: session_id sanitised (cursor "${inside[0]}")`)
    : no("hook sanitise", `escaped=${escaped} cursors=${inside}`);
  rmSync(fakeHome, { recursive: true, force: true });
}

// 8. A symlink inside topics/ must not surface in the bootstrap topic index
{
  const secret = join(tmpdir(), `memgw-topic-secret-${process.pid}.md`);
  writeFileSync(secret, "# LEAKED TITLE FROM OUTSIDE\n");
  const link = join(DATA, "topics", "sneaky.md");
  rmSync(link, { force: true });
  symlinkSync(secret, link);
  const b = await (await api("/bootstrap")).json();
  const listed = (b.topics || []).some((t) => t.path.includes("sneaky") || (t.summary || "").includes("LEAKED"));
  !listed ? ok("bootstrap: symlinked topic hidden from the index") : no("topic symlink", JSON.stringify(b.topics));
  rmSync(link, { force: true });
  rmSync(secret, { force: true });
}

// 9. The nested data git repo must never track the database
{
  await api("/flush-notes", { method: "POST" }); // ensures the repo + ignore rules exist
  const tracked = execFileSync("git", ["-C", DATA, "ls-files"]).toString().split("\n").filter(Boolean);
  // allowlist semantics: ONLY .md files (and .gitignore) may ever be tracked,
  // so a database under ANY name can never reach git history
  const offenders = tracked.filter((f) => !f.endsWith(".md") && f !== ".gitignore");
  offenders.length === 0
    ? ok(`data git: allowlist holds (${tracked.length} tracked, all .md)`)
    : no("data git", `non-md tracked: ${offenders.join(", ")}`);
}

// 10. Auth matrix: every data route must refuse a request without the key
{
  const routes = [
    ["GET", "/bootstrap"],
    ["GET", "/search/facts?q=x"],
    ["GET", "/search/events?q=x"],
    ["GET", "/notes/profile.md"],
    ["GET", "/stats"],
    ["POST", "/capture"],
    ["POST", "/facts"],
    ["POST", "/facts/forget"],
    ["POST", "/flush"],
    ["POST", "/flush-notes"],
    ["POST", "/retention"],
  ];
  const leaks = [];
  for (const [method, path] of routes) {
    const r = await fetch(`${URL_}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
    if (r.status !== 401) leaks.push(`${method} ${path} -> ${r.status}`);
  }
  leaks.length === 0
    ? ok(`auth matrix: ${routes.length} data routes all refuse without a key`)
    : no("auth matrix", leaks.join(", "));
}

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
