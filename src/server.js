// memgw gateway: HTTP API + MCP server + background workers, in one process.
//
// Started either by the CLI (`memgw start`) or directly (`node src/server.js`).
// All configuration comes from src/config.js, so the same binary runs as a local
// loopback process or as a public server behind a reverse proxy.

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { readFileSync, existsSync, readdirSync, lstatSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, validateConfig } from "./config.js";
import { openDb, insertEvents, searchFacts, insertFact, supersedeFact } from "./db.js";
import { hybridSearchFacts, hybridSearchEvents, backfillEmbeddings, embeddingsEnabled } from "./embed.js";
import { runWorker } from "./worker.js";
import { runNotesUpdate, resolveWithin } from "./notes.js";
import { runRetention } from "./retention.js";
import { startMcpHttp } from "./mcp.js";

const STARTED_AT = Date.now();

export function createServer(cfg = loadConfig()) {
  const problems = validateConfig(cfg);
  if (problems.length) {
    for (const p of problems) console.error(`config error: ${p}`);
    throw new Error("invalid configuration");
  }

  // A data directory WE create is tightened to owner-only; a pre-existing custom
  // location keeps whatever modes its owner chose (it may be deliberately shared).
  const dataDirIsNew = !existsSync(cfg.dataDir);
  mkdirSync(join(cfg.dataDir, "topics"), { recursive: true });
  if (dataDirIsNew) {
    try { chmodSync(cfg.dataDir, 0o700); } catch {}
  }
  const db = openDb(cfg.dbPath);

  // Timestamps from clients are advisory; garbage must not corrupt ordering.
  // FUTURE timestamps are clamped to now: the worker only processes sessions
  // idle for 10 minutes, so one event dated tomorrow would wedge its whole
  // session out of extraction until that time arrives.
  const clampTs = (v) => {
    const n = Number(v);
    const now = Date.now();
    if (!Number.isFinite(n) || n <= 0) return now;
    return Math.min(n, now + 300_000); // tolerate small clock skew only
  };

  // The interval timers and the /flush endpoints can otherwise overlap: two
  // worker runs would select the same unprocessed events and store duplicate
  // facts. Serialising through a promise chain makes every run exclusive.
  let workerChain = Promise.resolve();
  const queueWorker = (opts) => {
    const next = workerChain.then(() => runWorker(db, opts));
    workerChain = next.catch(() => {});
    return next;
  };
  let notesChain = Promise.resolve();
  const queueNotes = (opts) => {
    const next = notesChain.then(() => runNotesUpdate(db, cfg.dataDir, opts));
    notesChain = next.catch(() => {});
    return next;
  };
  const app = new Hono();

  // --- auth: every route except /health ---
  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    if (c.req.header("authorization") !== `Bearer ${cfg.key}`)
      return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  // --- body cap on every route: even an authenticated client must not be able
  // to exhaust process memory. /capture gets its own larger cap below.
  const smallLimit = bodyLimit({ maxSize: 1_000_000, onError: (c) => c.json({ error: "body too large" }, 413) });
  app.use("*", (c, next) => (c.req.path === "/capture" ? next() : smallLimit(c, next)));

  // /health reports the config the RUNNING process actually loaded. Config is read
  // once at startup, so a key added to the env file afterwards is not in effect until
  // a restart -- reporting it here is what lets `doctor` catch that mismatch.
  app.get("/health", (c) =>
    c.json({
      ok: true,
      ts: Date.now(),
      started_at: STARTED_AT,
      llm: { configured: Boolean(cfg.llm.apiKey), mock: cfg.llm.mock, model: cfg.llm.model },
      embed: { enabled: embeddingsEnabled(), model: cfg.embed.model || null },
      prompt_lang: cfg.llm.promptLang,
    })
  );

  // --- capture: accept a batch of turns, reply 202 immediately ---
  // bodyLimit counts the ACTUAL bytes read, so a chunked request without a
  // Content-Length header cannot bypass the cap.
  const captureLimit = bodyLimit({ maxSize: 5_000_000, onError: (c) => c.json({ error: "body too large" }, 413) });
  app.post("/capture", captureLimit, async (c) => {
    const body = await c.req.json().catch(() => null);
    const { source, session_id, messages } = body || {};
    if (!source || !session_id || !Array.isArray(messages))
      return c.json({ error: "source, session_id and messages[] are required" }, 400);
    const clean = messages
      .slice(0, 500)
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({
        role: m.role,
        content: m.content.slice(0, 20_000),
        ts: clampTs(m.ts),
      }));
    return c.json(
      { ok: true, added: insertEvents(db, String(source).slice(0, 200), String(session_id).slice(0, 200), clean) },
      202
    );
  });

  // --- bootstrap: profile + topic index + tool guidance, for session start ---
  // Serve-time budget caps: a hand-edited profile or a runaway topic list must
  // never flood the session context, whatever is on disk.
  app.get("/bootstrap", (c) => {
    const profilePath = resolveWithin(cfg.dataDir, "profile.md"); // same sandbox as every other read
    const profile = profilePath ? readIf(profilePath) : null;
    return c.json({
      profile: profile && profile.slice(0, 6000),
      topics: listTopics(cfg.dataDir).slice(0, 30),
      tools_guide: TOOLS_GUIDE,
    });
  });

  app.get("/search/facts", async (c) =>
    c.json({
      results: await hybridSearchFacts(db, c.req.query("q") || "", {
        topic: c.req.query("topic") || undefined,
        type: c.req.query("type") || undefined,
        limit: Math.min(Math.max(Number(c.req.query("limit")) || 8, 1), 30),
      }),
    })
  );

  app.get("/search/events", async (c) =>
    c.json({
      results: await hybridSearchEvents(db, c.req.query("q") || "", {
        session: c.req.query("session") || undefined,
        limit: Math.min(Math.max(Number(c.req.query("limit")) || 10, 1), 50),
      }),
    })
  );

  // --- notes: read one MARKDOWN file; traversal and symlink escapes blocked,
  // and nothing else under data/ (.git/config, the database) is readable here ---
  app.get("/notes/:path{.+}", (c) => {
    const p = c.req.param("path");
    const full = p.endsWith(".md") ? resolveWithin(cfg.dataDir, p) : null;
    if (!full) return c.json({ error: "bad path" }, 400);
    if (!existsSync(full)) return c.json({ error: "not found" }, 404);
    return c.json({ path: p, content: readFileSync(full, "utf8") });
  });

  // --- write a fact directly, bypassing extraction ---
  const FACT_TYPES = ["preference", "decision", "instruction", "project", "deadend", "episode"];
  app.post("/facts", async (c) => {
    const f = await c.req.json().catch(() => null);
    if (!f?.content || !f?.type) return c.json({ error: "content and type are required" }, 400);
    if (!FACT_TYPES.includes(f.type))
      return c.json({ error: `type must be one of: ${FACT_TYPES.join(", ")}` }, 400);
    if (String(f.content).length > 20_000) return c.json({ error: "content too long (max 20000 chars)" }, 413);
    return c.json({
      ok: true,
      id: insertFact(db, {
        content: String(f.content),
        type: f.type,
        topic: f.topic ? String(f.topic).slice(0, 100) : undefined,
        priority: Math.min(Math.max(Number(f.priority) || 50, 0), 100),
      }),
    });
  });

  // --- forget: retire facts that match a query (store hygiene without SQL) ---
  // Dry-run by default: returns the matches and touches nothing until
  // confirm=true, so a broad query cannot silently erase memory.
  app.post("/facts/forget", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.query) return c.json({ error: "query is required" }, 400);
    const matches = searchFacts(db, body.query, {
      type: body.type || undefined,
      limit: Math.min(Math.max(Number(body.limit) || 10, 1), 30),
    });
    if (body.confirm !== true) return c.json({ dry_run: true, matches });
    for (const m of matches) supersedeFact(db, m.id);
    return c.json({ forgotten: matches.length, matches });
  });

  app.post("/flush", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const r = await queueWorker({ force: true, session: body?.session_id || null });
    // embed what the worker just produced; failures only delay the semantic layer
    backfillEmbeddings(db).catch((e) => console.error("[embed]", e.message));
    return c.json(r);
  });

  app.post("/flush-notes", async (c) =>
    c.json(await queueNotes({ force: true }).catch((e) => ({ error: String(e.message || e) })))
  );

  app.post("/retention", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(
      runRetention(db, {
        days: body?.days ?? cfg.retentionDays,
        allowAggressive: body?.allow_aggressive === true,
        dryRun: body?.dry_run === true,
      })
    );
  });

  app.get("/stats", (c) =>
    c.json({
      counts: {
        events: db.prepare(`SELECT COUNT(*) n FROM events`).get().n,
        events_pending: db.prepare(`SELECT COUNT(*) n FROM events WHERE processed=0`).get().n,
        events_oldest: db.prepare(`SELECT MIN(ts) t FROM events`).get().t,
        facts_active: db.prepare(`SELECT COUNT(*) n FROM facts WHERE status='active'`).get().n,
        facts_superseded: db.prepare(`SELECT COUNT(*) n FROM facts WHERE status='superseded'`).get().n,
        vectors: (() => {
          try {
            return db.prepare(`SELECT COUNT(*) n FROM embeddings`).get().n;
          } catch {
            return 0; // table only exists once embeddings have been enabled
          }
        })(),
      },
      by_source: db.prepare(`SELECT source, COUNT(*) n, MAX(ts) last_ts FROM events GROUP BY source ORDER BY n DESC`).all(),
      by_type: db
        .prepare(`SELECT type, COUNT(*) n FROM facts WHERE status='active' GROUP BY type ORDER BY n DESC`)
        .all(),
      recent_runs: db.prepare(`SELECT * FROM worker_runs ORDER BY id DESC LIMIT 20`).all(),
    })
  );

  return { app, db, cfg, queueWorker, queueNotes };
}

const TOOLS_GUIDE = [
  "You have a long-term memory store (memgw):",
  "- memory_search(query): distilled facts (preferences, decisions, instructions, dead ends)",
  "- conversation_search(query): raw transcripts of previous sessions",
  "- memory_read_note(path): read a topic note listed above",
  "Call them when you need earlier context; at most 3 memory calls per turn.",
  "Before trying a new approach, search type=deadend to check it has not already failed.",
].join("\n");

function readIf(p) {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function listTopics(dataDir) {
  const dir = join(dataDir, "topics");
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d, prefix) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue; // a symlink here could read outside data/
      if (st.isDirectory()) walk(full, `${prefix}${name}/`);
      else if (name.endsWith(".md")) {
        const firstLine = readFileSync(full, "utf8").split("\n").find((l) => l.trim()) || "";
        out.push({ path: `topics/${prefix}${name}`, summary: firstLine.replace(/^#+\s*/, "").slice(0, 120) });
      }
    }
  };
  walk(dir, "");
  return out;
}

/** Boot the HTTP API, the MCP server and the background workers. */
export async function start(cfg = loadConfig()) {
  // Pre-flight: if a healthy memgw already owns the port, starting again is a
  // success condition ("it's running"), not a crash worth a stack trace.
  const occupant = await fetch(`http://127.0.0.1:${cfg.port}/health`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.json())
    .catch(() => null);
  if (occupant?.ok) {
    console.log(`memgw is already running on :${cfg.port} -- nothing to start.`);
    console.log(`(restart it: pkill -f 'memgw.mjs start'; second instance: set MEMGW_PORT)`);
    process.exit(0);
  }

  const { app, db, queueWorker, queueNotes } = createServer(cfg);

  const http = serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.bind });
  // A taken port must not dump a raw stack trace: the by-far most common cause
  // is "memgw is already running" (setup started it, user runs start again),
  // which is a success condition, not a crash.
  http.on("error", async (err) => {
    if (err?.code !== "EADDRINUSE") {
      console.error(err);
      process.exit(1);
    }
    try {
      const h = await fetch(`http://127.0.0.1:${cfg.port}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json());
      if (h?.ok) {
        console.log(`memgw is already running on :${cfg.port} -- nothing to start.`);
        console.log(`(restart it: pkill -f 'memgw.mjs start'; second instance: set MEMGW_PORT)`);
        process.exit(0);
      }
    } catch {}
    console.error(`Port ${cfg.port} is taken by another program -- set MEMGW_PORT to a free port.`);
    process.exit(1);
  });
  const mcp = startMcpHttp(db, {
    port: cfg.mcpPort,
    bind: cfg.bind,
    key: cfg.key,
    pathSecret: cfg.mcpSecret || null,
    dataDir: cfg.dataDir,
    listTopics: () => listTopics(cfg.dataDir),
  });

  // catch up on any rows that were written while embeddings were off or failing
  if (embeddingsEnabled()) {
    const catchUp = async () => {
      let r;
      do r = await backfillEmbeddings(db);
      while (r.embedded > 0);
    };
    catchUp().catch((e) => console.error("[embed]", e.message));
  }

  const timers = [
    setInterval(() => {
      queueWorker({})
        .then(() => backfillEmbeddings(db))
        .catch((e) => console.error("[worker]", e));
    }, cfg.workerIntervalMs),
    setInterval(
      () => queueNotes({}).catch((e) => console.error("[notes]", e)),
      cfg.notesIntervalMs
    ),
    setInterval(() => {
      try {
        const r = runRetention(db, { days: cfg.retentionDays });
        if (r.deleted) console.log(`[retention] removed ${r.deleted} old events`);
      } catch (e) {
        console.error("[retention]", e);
      }
    }, 24 * 60 * 60 * 1000),
  ];

  const stop = () => {
    timers.forEach(clearInterval);
    http.close?.();
    mcp.close?.();
    db.close?.();
  };
  return { http, mcp, db, stop, cfg };
}

// Direct execution: `node src/server.js`. pathToFileURL handles Windows drive
// letters and backslashes -- a hand-built `file://${argv[1]}` never matches there.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  await start(cfg); // pre-flight may exit "already running" BEFORE the banner
  console.log(`memgw API   http://${cfg.bind}:${cfg.port}`);
  console.log(`memgw MCP   http://${cfg.bind}:${cfg.mcpPort}/mcp`);
  console.log(`data        ${cfg.dataDir}`);
}
