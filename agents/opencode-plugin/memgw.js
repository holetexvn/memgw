// memgw plugin for opencode.
//
// Drop this into ~/.config/opencode/plugins/memgw.js (global) or
// .opencode/plugins/memgw.js (per project). opencode loads it automatically; no entry
// in opencode.json is needed when it lives in a plugins directory.
//
// It uses opencode's native hooks, which is more accurate than tailing files:
//   message.updated  -> buffer the message for its session
//   session.idle     -> session went quiet, push the buffer and ask for distillation
//
// Configuration comes from ~/.memgw/env (MEMGW_URL, MEMGW_KEY) or the environment.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";

function loadConf() {
  const f = join(homedir(), ".memgw", "env");
  const conf = { ...process.env };
  if (existsSync(f)) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)=(.*)$/);
      if (m && !conf[m[1]]) conf[m[1]] = m[2].trim();
    }
  }
  return {
    url: (conf.MEMGW_URL || "http://127.0.0.1:8930").replace(/\/$/, ""),
    key: conf.MEMGW_KEY || "",
    source: conf.MEMGW_SOURCE || `opencode-${hostname().split(".")[0]}`,
  };
}

const NOISE = [/^<[a-z-]+>/i, /^\s*$/];
const textOf = (c) => {
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c.filter((p) => p?.type === "text").map((p) => p.text ?? "").filter(Boolean).join("\n");
  return c?.text ?? "";
};

export const MemgwPlugin = async ({ client, directory }) => {
  const conf = loadConf();
  // Buffer per session. opencode emits message.updated repeatedly for the same message
  // while streaming, so key by message id and let the last write win: no duplicates.
  const buffers = new Map(); // sessionID -> Map(messageID -> {role, content, ts})
  let breaker = { fails: 0, openUntil: 0 };

  const post = async (path, body, timeoutMs = 5000) => {
    if (!conf.key) return null;
    if (Date.now() < breaker.openUntil) return null;
    try {
      const res = await fetch(`${conf.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${conf.key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      breaker.fails = 0;
      return await res.json().catch(() => ({}));
    } catch {
      // a dead memory store must never take opencode down with it
      if (++breaker.fails >= 5) {
        breaker = { fails: 0, openUntil: Date.now() + 60_000 };
      }
      return null;
    }
  };

  const flush = async (sessionID) => {
    const buf = buffers.get(sessionID);
    if (!buf || buf.size === 0) return;
    const sentIds = [...buf.keys()];
    const messages = [...buf.values()]
      .filter((m) => m.content && !NOISE.some((re) => re.test(m.content)))
      .sort((a, b) => a.ts - b.ts)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 20000), ts: m.ts }));
    if (!messages.length) {
      buffers.delete(sessionID);
      return;
    }

    const payload = { source: conf.source, session_id: sessionID, messages };
    const res = await post("/capture", payload);
    if (res) {
      // Only drop what was DELIVERED (by id: messages that arrived during the
      // await are kept for the next flush).
      for (const id of sentIds) buf.delete(id);
      // gateway is reachable: replay anything spooled during earlier outages,
      // so opencode-only setups do not depend on a Claude hook to drain it
      try {
        const fs = await import("node:fs");
        const os = await import("node:os");
        const path = await import("node:path");
        const spool = path.join(os.homedir(), ".memgw", "spool.jsonl");
        // recover temp files stranded by a crashed flusher before draining
        try {
          for (const name of fs.readdirSync(path.dirname(spool))) {
            if (name.startsWith("spool.jsonl.sending.")) {
              const stray = path.join(path.dirname(spool), name);
              try { fs.appendFileSync(spool, fs.readFileSync(stray, "utf8")); fs.rmSync(stray, { force: true }); } catch {}
            }
          }
        } catch {}
        if (fs.existsSync(spool)) {
          const tmp = `${spool}.sending.oc${process.pid}`;
          try { fs.renameSync(spool, tmp); } catch { /* another flusher has it */ }
          if (fs.existsSync(tmp)) {
            for (const line of fs.readFileSync(tmp, "utf8").split("\n")) {
              if (!line.trim()) continue;
              // one corrupt line must not strand the rest: re-queue what fails
              let parsed = null;
              try { parsed = JSON.parse(line); } catch {}
              if (!parsed || !(await post("/capture", parsed))) {
                if (parsed) {
                  fs.appendFileSync(spool, line + "\n");
                  try { fs.chmodSync(spool, 0o600); } catch {}
                } // unparseable lines are dropped -- they can never be delivered
              }
            }
            fs.rmSync(tmp, { force: true });
          }
        }
      } catch { /* replay is best-effort */ }
    } else {
      // Gateway down: persist to the shared spool on disk so the conversation
      // survives a plugin/process exit. The Claude Code capture hook (and any
      // later successful hook run) flushes this spool; the server dedupes.
      try {
        const fs = await import("node:fs");
        const os = await import("node:os");
        const path = await import("node:path");
        const spool = path.join(os.homedir(), ".memgw", "spool.jsonl");
        fs.appendFileSync(spool, JSON.stringify(payload) + "\n");
        try { fs.chmodSync(spool, 0o600); } catch {}
        for (const id of sentIds) buf.delete(id); // spooled = safe to drop from RAM
      } catch {
        /* no spool possible: keep the buffer and retry on the next idle */
      }
    }
    // the session is already idle, so ask for distillation now instead of waiting
    await post("/flush", { session_id: sessionID }, 30_000);
  };

  return {
    // collect messages as they are updated
    "message.updated": async ({ message }) => {
      const role = message?.role ?? message?.info?.role;
      if (role !== "user" && role !== "assistant") return;
      const sid = message.sessionID ?? message.info?.sessionID ?? "opencode";
      const mid = message.id ?? message.info?.id ?? String(Math.random());
      const content = textOf(message.parts ?? message.content ?? message.info?.parts);
      if (!content) return;
      if (!buffers.has(sid)) buffers.set(sid, new Map());
      buffers.get(sid).set(mid, {
        role,
        content,
        ts: message.time?.created ?? message.info?.time?.created ?? Date.now(),
      });
    },

    // session went idle -> push
    "session.idle": async ({ sessionID }) => {
      await flush(sessionID ?? [...buffers.keys()][0]);
    },

    // a deleted session still deserves one delivery attempt (flush spools on
    // failure); only then is the buffer released
    "session.deleted": async ({ sessionID }) => {
      await flush(sessionID);
      buffers.delete(sessionID);
    },
  };
};

export default MemgwPlugin;
