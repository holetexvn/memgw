#!/usr/bin/env node
// memgw capture hook for Claude Code (the "Stop" hook).
// Reads the hook input from stdin (transcript_path + session_id + cwd), takes the
// NEW slice since the previous cursor, keeps only user/assistant text (drops tool
// calls and noise), then POSTs it to memgw. When offline it spools and retries on
// the next run.
//
// Pure Node on purpose: anyone who can run Claude Code already has Node, so the
// hooks add zero prerequisites. Configure through ~/.memgw/env.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, rmSync, chmodSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.MEMGW_HOME || join(homedir(), ".memgw");
const env = {};
try {
  for (const line of readFileSync(join(HOME, "env"), "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !line.startsWith("#")) env[line.slice(0, i)] = line.slice(i + 1);
  }
} catch {}
const URL_ = env.MEMGW_URL;
const KEY = env.MEMGW_KEY;
if (!URL_ || !KEY) process.exit(0); // not configured -- never break the session
const SOURCE = env.MEMGW_SOURCE || "cc-unknown";

const SPOOL = join(HOME, "spool.jsonl");
const CURSORS = join(HOME, "cursors");
mkdirSync(CURSORS, { recursive: true, mode: 0o700 });

async function post(payload) {
  try {
    const res = await fetch(`${URL_}/capture`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// 1. Recover any `.sending.*` temp files stranded by a crashed flusher (ours or
// the opencode plugin's), then flush the spool. The per-process rename name
// stops two concurrent Stop hooks racing on the same temp file.
try {
  const dir = readdirSync(HOME);
  for (const name of dir) {
    if (name.startsWith("spool.jsonl.sending.")) {
      const stray = join(HOME, name);
      try {
        appendFileSync(SPOOL, readFileSync(stray, "utf8"));
        rmSync(stray, { force: true });
      } catch {}
    }
  }
} catch {}
if (existsSync(SPOOL)) {
  const tmp = `${SPOOL}.sending.${process.pid}`;
  try {
    renameSync(SPOOL, tmp);
  } catch {
    /* another hook instance is flushing it */
  }
  if (existsSync(tmp)) {
    for (const line of readFileSync(tmp, "utf8").split("\n")) {
      if (line.trim() && !(await post(line))) {
        appendFileSync(SPOOL, line + "\n");
        try { chmodSync(SPOOL, 0o600); } catch {}
      }
    }
    rmSync(tmp, { force: true });
  }
}

// 2. Read the hook input
let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const transcript = input.transcript_path;
if (!transcript || !existsSync(transcript)) process.exit(0);
// session_id becomes a filename under cursors/ -- sanitise it so a hostile or
// malformed value can never traverse outside that directory
const session =
  String(input.session_id || transcript.replace(/.*[\\/]/, "").replace(/\.jsonl$/, ""))
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 150) || "unknown";

// 2b. Skip sessions from ignored directories (MEMGW_CAPTURE_IGNORE, a list of
// path prefixes separated by ':' on POSIX and ';' on Windows, where drive
// letters make ':' unusable). Main use: the memgw repo itself, whose transcripts
// quote prompts and stored facts -- feeding them back poisons extraction.
const cwd = input.cwd || "";
const IGNORE_DELIM = process.platform === "win32" ? ";" : ":";
const ignores = (env.MEMGW_CAPTURE_IGNORE || "").split(IGNORE_DELIM).filter(Boolean);
if (cwd && ignores.some((d) => cwd.startsWith(d))) process.exit(0);

// 3. Cursor: "lines:bytes" -- when the file SIZE has not changed, skip without
// re-reading it at all (transcripts get long; rereading megabytes on every Stop
// just to discover nothing is new would be pure waste).
const cursorFile = join(CURSORS, session);
let last = 0, lastSize = -1;
if (existsSync(cursorFile)) {
  const m = readFileSync(cursorFile, "utf8").trim().match(/^(\d+)(?::(\d+))?$/);
  if (m) { last = Number(m[1]) || 0; lastSize = m[2] !== undefined ? Number(m[2]) : -1; }
}
const size = statSync(transcript).size;
if (size === lastSize) process.exit(0);
const lines = readFileSync(transcript, "utf8").split("\n").filter((l) => l.length);
if (lines.length <= last) process.exit(0);

// 4. Filter: keep only real user text (drop tool_result and meta) and assistant text.
// If the FINAL line does not parse it is likely still being written: leave it out
// of the cursor so the next run picks it up once complete, instead of skipping
// that record forever.
let cursorTo = lines.length;
try { JSON.parse(lines[lines.length - 1]); } catch { cursorTo = lines.length - 1; }
if (cursorTo <= last) process.exit(0);
const messages = [];
for (const line of lines.slice(last, cursorTo)) {
  let e;
  try { e = JSON.parse(line); } catch { continue; }
  if (e.type !== "user" && e.type !== "assistant") continue;
  const content = e.message?.content;
  const text =
    typeof content === "string"
      ? content
      : (content || []).filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  if (!text || text.startsWith("<")) continue; // drop system-reminder / command wrappers
  const ts = e.timestamp ? Date.parse(e.timestamp) : Date.now();
  messages.push({ role: e.type, content: text.slice(0, 20000), ts: Number.isFinite(ts) ? ts : Date.now() });
}

// 5. Send, spool on failure. Always advance the cursor so nothing is sent twice
//    (the server is idempotent too).
let preserved = true;
if (messages.length) {
  const payload = { source: SOURCE, session_id: session, messages };
  if (!(await post(payload))) {
    try {
      appendFileSync(SPOOL, JSON.stringify(payload) + "\n");
      chmodSync(SPOOL, 0o600); // spooled transcripts are private data
    } catch {
      preserved = false; // POST failed AND the spool write failed: retry next turn
    }
  }
}
// store the size only when the whole file was consumed -- a held-back partial
// final line must force a re-read next turn
if (preserved) writeFileSync(cursorFile, `${cursorTo}:${cursorTo === lines.length ? size : 0}`);
