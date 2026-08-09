#!/usr/bin/env node
// memgw watcher: multi-agent capture by following transcript files.
//
// Claude Code has hooks and opencode has plugins, but Codex and most other CLIs
// expose no stable extension point. The one thing they all do is write a JSONL
// transcript to disk, so the watcher reads those files, parses them, and pushes
// what is new.
//
// One process can follow several agents. A per-file cursor means a restart never
// resends, and the server is idempotent too, giving two independent guarantees.
//
// Usage:
//   node watcher.mjs --agent claude-code --agent codex
//   node watcher.mjs --agent codex --dir ~/.codex/sessions
//   node watcher.mjs --agent codex --dry-run      # show what would be sent
//   node watcher.mjs --agent generic --dir /path --source my-cli
//
// Env: MEMGW_URL, MEMGW_KEY, MEMGW_SOURCE_PREFIX (defaults to the hostname)

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir, hostname } from "node:os";
import { PARSERS, DEFAULT_DIRS, parseLines } from "./parsers/index.mjs";

// ---------- configuration ----------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const val = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const vals = (name) => argv.reduce((a, v, i) => (v === `--${name}` && argv[i + 1] ? [...a, argv[i + 1]] : a), []);

const expand = (p) => (p?.startsWith("~") ? join(homedir(), p.slice(1)) : p);

const CONF_FILE = join(homedir(), ".memgw", "env");
if (existsSync(CONF_FILE)) {
  for (const line of readFileSync(CONF_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const URL_BASE = (process.env.MEMGW_URL || "http://127.0.0.1:8930").replace(/\/$/, "");
const KEY = process.env.MEMGW_KEY || "";
const PREFIX = process.env.MEMGW_SOURCE_PREFIX || hostname().split(".")[0];
const DRY = flag("dry-run");
const ONCE = flag("once");
const INTERVAL = Number(val("interval", 60)) * 1000;
const STATE_DIR = join(homedir(), ".memgw", "watch-state");
const MAX_AGE_DAYS = Number(val("max-age-days", 7)); // ignore stale files at startup

const agents = vals("agent");
if (!agents.length) {
  console.error(`memgw watcher - follow agent CLI transcripts

Options:
  --agent <name>      claude-code | codex | opencode | generic (repeatable)
  --dir <path>        transcript directory (defaults per agent)
  --source <name>     override the source name sent to memgw
  --dry-run           print what would be sent, send nothing
  --once              single pass then exit (for cron)
  --interval <secs>   scan interval, default 60
  --max-age-days <n>  ignore files older than n days, default 7

Known agents: ${Object.keys(PARSERS).join(", ")}`);
  process.exit(1);
}
if (!KEY && !DRY) {
  console.error("MEMGW_KEY is missing (set it in ~/.memgw/env or the environment).");
  process.exit(1);
}

const dirOverride = val("dir", null);
const sourceOverride = val("source", null);

// ---------- cursors ----------
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 }); // paths + activity times are private
const stateFile = join(STATE_DIR, "cursors.json");
let cursors = {};
try {
  cursors = JSON.parse(readFileSync(stateFile, "utf8"));
} catch {
  cursors = {};
}
const saveCursors = () => {
  // A dry run must NEVER advance the cursor: otherwise inspecting the output once
  // silently skips that data on the next real run.
  if (DRY) return;
  try {
    writeFileSync(stateFile, JSON.stringify(cursors, null, 1));
  } catch (e) {
    console.error("[watcher] could not persist cursor:", e.message);
  }
};

// ---------- locate transcripts ----------
function findJsonl(dir, maxAgeMs) {
  const out = [];
  const cutoff = Date.now() - maxAgeMs;
  const walk = (d, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.endsWith(".jsonl") || e.name.endsWith(".json")) {
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.mtimeMs >= cutoff) out.push({ path: full, mtime: st.mtimeMs, size: st.size });
      }
    }
  };
  walk(dir, 0);
  return out;
}

// ---------- send ----------
async function send(source, sessionId, messages) {
  if (DRY) {
    console.log(`  [dry-run] would send ${messages.length} messages | source=${source} session=${sessionId}`);
    for (const m of messages.slice(0, 3))
      console.log(`     ${m.role}: ${m.content.slice(0, 100).replace(/\n/g, " ")}`);
    if (messages.length > 3) console.log(`     ... and ${messages.length - 3} more`);
    return true;
  }
  try {
    const res = await fetch(`${URL_BASE}/capture`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ source, session_id: sessionId, messages }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json().catch(() => ({}));
    return j.added ?? 0;
  } catch (e) {
    console.error(`  send failed: ${e.message}`);
    return null;
  }
}

// ---------- one scan pass ----------
async function scanOnce() {
  const maxAge = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let totalSent = 0;

  for (const agent of agents) {
    if (!PARSERS[agent]) {
      console.error(`Unknown agent "${agent}". Known: ${Object.keys(PARSERS).join(", ")}`);
      continue;
    }
    const dir = resolve(expand(dirOverride || DEFAULT_DIRS[agent] || ""));
    if (!dir || !existsSync(dir)) {
      console.log(`[${agent}] skipped, no such directory: ${dir || "(pass --dir)"}`);
      continue;
    }
    const source = sourceOverride || `${agent}-${PREFIX}`;
    const files = findJsonl(dir, maxAge);

    for (const f of files) {
      const key = `${agent}:${f.path}`;
      let done = cursors[key]?.lines ?? 0;

      // unchanged size means unchanged content: skip without re-reading, so a
      // minute-cadence scan over long transcripts stays cheap
      let size = -1;
      try {
        size = statSync(f.path).size;
      } catch {
        continue;
      }
      if (size === cursors[key]?.size) continue;

      let all;
      try {
        all = readFileSync(f.path, "utf8").split("\n");
      } catch {
        continue;
      }
      // Last line: a trailing newline means everything before it is complete. No
      // trailing newline is ambiguous (could be mid-write) -- include it only if
      // it already parses as JSON, so one-line files are not skipped forever.
      let complete = all.length - 1;
      if (all[all.length - 1] !== "") {
        try {
          JSON.parse(all[all.length - 1]);
          complete = all.length;
        } catch {}
      }
      // A shorter file at the same path means it was rotated or truncated:
      // start over instead of waiting behind a stale offset (the server's
      // idempotent event ids make re-sending harmless).
      if (complete < done) done = 0;
      if (complete <= done) continue;

      const { messages, sessionId } = parseLines(all.slice(done, complete), agent, f.mtime);
      if (messages.length) {
        const sid = sessionId || basename(f.path).replace(/\.(jsonl|json)$/, "");
        const r = await send(source, sid, messages);
        if (r === null) continue; // send failed: keep the cursor and retry next pass
        totalSent += messages.length;
        console.log(`[${agent}] ${basename(f.path)}: +${messages.length} messages${DRY ? "" : ` (added ${r})`}`);
      }
      cursors[key] = { lines: complete, size, at: Date.now() };
    }
  }

  // forget cursors for files untouched for 30 days
  const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [k, v] of Object.entries(cursors)) if ((v.at ?? 0) < old) delete cursors[k];
  saveCursors();
  return totalSent;
}

// ---------- run ----------
console.log(
  `memgw watcher: agents=[${agents.join(", ")}] -> ${DRY ? "(dry-run)" : URL_BASE} | ` +
    `${ONCE ? "single pass" : `every ${INTERVAL / 1000}s`}`
);
const tick = async () => {
  try {
    const n = await scanOnce();
    if (n) console.log(`-- ${n} messages this pass`);
  } catch (e) {
    console.error("[watcher] error:", e.message);
  }
};
await tick();
if (!ONCE) setInterval(tick, INTERVAL);
