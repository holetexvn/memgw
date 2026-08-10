#!/usr/bin/env node
// memgw CLI.
//
// The whole point of this file is that `npx @holetex/memgw start` works with zero prior
// setup: it creates ~/.memgw, generates keys, starts on loopback, and prints the
// exact commands to connect your agents. Everything else is the same server that
// runs on a VPS -- only configuration differs.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, validateConfig, ensureEnvFile, upsertEnvFile, HOME_DIR, ENV_FILE } from "../src/config.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const argv = process.argv.slice(2);
const cmd = argv[0];
const has = (f) => argv.includes(`--${f}`);
const opt = (f, d) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
};

const HELP = `${c.b("memgw")} v${pkg.version} -- shared long-term memory for AI coding agents

${c.b("Usage")}
  npx @holetex/memgw <command> [options]

${c.b("Commands")}
  setup              One-command wizard: config, supervision, connect every agent found
  start              Start the gateway (generates config on first run)
  init               Create config and print connection instructions, without starting
  status             Show store statistics from a running gateway
  doctor             Diagnose configuration and connectivity
  search <query>     Search facts from the command line
  save <text>        Save a fact from the command line
  forget <query>     Retire matching facts (dry-run; add --yes to apply)
  embed on|off|status  Toggle the optional semantic search layer
  watch              Watch agent transcripts and capture them (see --agent)
  hooks              Install Claude Code hooks into ~/.claude/settings.json
  help               This message

${c.b("Common options")}
  --port <n>         HTTP API port (default 8930)
  --bind <addr>      Bind address (default 127.0.0.1; use 0.0.0.0 to expose)
  --data <dir>       Data directory (default ~/.memgw/data)
  --mock             Run without an LLM key (pipeline works, extraction is stubbed)

${c.b("Examples")}
  npx @holetex/memgw start                       ${c.dim("# local, zero config")}
  npx @holetex/memgw start --bind 0.0.0.0        ${c.dim("# server mode (requires a strong key)")}
  npx @holetex/memgw watch --agent codex         ${c.dim("# capture Codex CLI sessions")}
  npx @holetex/memgw search "database choice"
  npx @holetex/memgw save "chose Postgres for billing" --type decision
`;

// --------------------------------------------------------------------------

function applyFlagsToEnv() {
  if (opt("port", null)) process.env.MEMGW_PORT = opt("port");
  if (opt("bind", null)) process.env.MEMGW_BIND = opt("bind");
  if (opt("data", null)) process.env.MEMGW_DATA_DIR = opt("data");
  if (has("mock")) process.env.MEMGW_LLM_MOCK = "1";
}

async function api(cfg, path, { method = "GET", body } = {}) {
  const res = await fetch(`http://${cfg.bind === "0.0.0.0" ? "127.0.0.1" : cfg.bind}:${cfg.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function connectionInstructions(cfg) {
  const host = cfg.isLocalOnly ? `http://127.0.0.1` : `https://YOUR-DOMAIN`;
  const api = cfg.isLocalOnly ? `${host}:${cfg.port}` : host;
  const mcp = cfg.isLocalOnly ? `${host}:${cfg.mcpPort}/mcp` : `${host}/mcp`;
  return `
${c.b("Connect your agents")}

${c.b("Claude Code")}
  npx @holetex/memgw hooks                       ${c.dim("# capture + session bootstrap")}
  claude mcp add --transport http memgw ${mcp} \\
    --header "Authorization: Bearer ${cfg.key}"

${c.b("Codex CLI")}
  codex mcp add memgw --url ${mcp}/${cfg.mcpSecret}   ${c.dim("# path secret: no header, no env var")}
  npx @holetex/memgw watch --agent codex         ${c.dim("# capture (Codex has no hooks)")}

${c.b("opencode")}
  cp ${join(ROOT, "agents/opencode-plugin/memgw.js")} ~/.config/opencode/plugins/
  ${c.dim(`# and add an "mcp" entry pointing at ${mcp}`)}

${c.b("Web clients (claude.ai and similar)")}
  ${cfg.isLocalOnly ? c.y("needs a public HTTPS URL -- see docs/02-OPERATIONS.md") : `${mcp}/${cfg.mcpSecret}`}

${c.dim(`API ${api}   data ${cfg.dataDir}   config ${ENV_FILE}`)}
`;
}

// --------------------------------------------------------------------------

async function cmdStart() {
  applyFlagsToEnv();
  const cfg = loadConfig({ autoKey: true });
  const problems = validateConfig(cfg);
  if (problems.length) {
    console.error(c.r("Cannot start:"));
    problems.forEach((p) => console.error(`  - ${p}`));
    process.exit(1);
  }
  if (cfg.generated.length) {
    console.log(c.g(`Generated ${cfg.generated.join(" and ")} -> ${ENV_FILE}`));
  }
  if (!cfg.llm.apiKey && !cfg.llm.mock) {
    console.log(
      c.y("No MEMGW_LLM_API_KEY set.") +
        " Capture works and events queue up, but facts are only extracted once you add a key.\n" +
        c.dim(`  echo 'MEMGW_LLM_API_KEY=sk-...' >> ${ENV_FILE}   (or run with --mock to try it)`)
    );
  }

  const { start } = await import("../src/server.js");
  const srv = start(cfg);
  console.log(
    `\n${c.g("memgw running")}  ${c.dim(cfg.isLocalOnly ? "(local only)" : `(bound to ${cfg.bind} -- exposed)`)}`
  );
  console.log(`  API  http://${cfg.bind}:${cfg.port}`);
  console.log(`  MCP  http://${cfg.bind}:${cfg.mcpPort}/mcp`);
  console.log(connectionInstructions(cfg));

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      srv.stop();
      process.exit(0);
    });
  }
}

function cmdInit() {
  applyFlagsToEnv();
  const cfg = loadConfig({ autoKey: true });
  mkdirSync(join(cfg.dataDir, "topics"), { recursive: true });
  const profile = join(cfg.dataDir, "profile.md");
  if (!existsSync(profile)) {
    writeFileSync(
      profile,
      `# Profile\n\nWho you are, what you work on, and any rules you want every agent to follow.\nKeep it under 250 words -- memgw refreshes this automatically once it has enough facts.\n`
    );
  }
  ensureEnvFile({
    MEMGW_LLM_BASE_URL: cfg.llm.baseUrl,
    MEMGW_LLM_MODEL: cfg.llm.model,
    MEMGW_LLM_API_KEY: "",
    MEMGW_RETENTION_DAYS: String(cfg.retentionDays),
  });
  console.log(c.g(`Config ready at ${ENV_FILE}`));
  console.log(c.dim(`Edit it to add MEMGW_LLM_API_KEY, then run: npx @holetex/memgw start`));
  console.log(connectionInstructions(cfg));
}

async function cmdStatus() {
  applyFlagsToEnv();
  const cfg = loadConfig();
  try {
    const s = await api(cfg, "/stats");
    const k = s.counts;
    console.log(`${c.b("events")}  ${k.events} total, ${k.events_pending} pending extraction`);
    console.log(`${c.b("facts")}   ${k.facts_active} active, ${k.facts_superseded} superseded`);
    if (s.by_source.length) {
      console.log(`\n${c.b("by source")}`);
      s.by_source.forEach((r) => console.log(`  ${r.source.padEnd(24)} ${r.n}`));
    }
    if (s.by_type.length) {
      console.log(`\n${c.b("by type")}`);
      s.by_type.forEach((r) => console.log(`  ${r.type.padEnd(24)} ${r.n}`));
    }
    const last = s.recent_runs[0];
    if (last) {
      console.log(
        `\n${c.b("last worker run")} ${new Date(last.ran_at).toISOString().slice(0, 16)} ` +
          `+${last.facts_new} facts${last.error ? c.r(` error: ${last.error}`) : ""}`
      );
    }
  } catch (e) {
    console.error(c.r(`Cannot reach memgw at ${cfg.bind}:${cfg.port} (${e.message})`));
    console.error(c.dim("Is it running? Try: npx @holetex/memgw start"));
    process.exit(1);
  }
}

async function cmdDoctor() {
  applyFlagsToEnv();
  const cfg = loadConfig();
  const rows = [];
  const ok = (n, v) => rows.push([c.g("ok"), n, v]);
  const warn = (n, v) => rows.push([c.y("warn"), n, v]);
  const bad = (n, v) => rows.push([c.r("fail"), n, v]);

  const [maj] = process.versions.node.split(".").map(Number);
  if (maj < 20) bad("node", `${process.versions.node} (need >= 20)`);
  else if (maj % 2 === 1) warn("node", `${process.versions.node} -- odd (non-LTS) versions have no better-sqlite3 prebuilds; use 20/22/24 LTS`);
  else ok("node", process.versions.node);

  existsSync(ENV_FILE) ? ok("config file", ENV_FILE) : warn("config file", `missing (run: npx @holetex/memgw init)`);
  cfg.key ? ok("auth key", `set (${cfg.key.length} chars)`) : bad("auth key", "missing");
  validateConfig(cfg).forEach((p) => bad("config", p));

  cfg.isLocalOnly
    ? ok("bind", `${cfg.bind} (local only)`)
    : warn("bind", `${cfg.bind} -- exposed; make sure TLS and firewall are in place`);

  cfg.llm.mock
    ? warn("llm", "mock mode -- no real extraction")
    : cfg.llm.apiKey
      ? ok("llm", `${cfg.llm.model} @ ${cfg.llm.baseUrl}`)
      : warn("llm", "no API key -- events will queue but no facts are extracted");

  cfg.embed.model
    ? ok("embeddings", `${cfg.embed.model} (dim ${cfg.embed.dim})`)
    : ok("embeddings", "off -- BM25 only (memgw embed on)");

  ok("prompt language", cfg.llm.promptLang);
  existsSync(cfg.dataDir) ? ok("data dir", cfg.dataDir) : warn("data dir", `${cfg.dataDir} (created on start)`);

  // Retry once before declaring the gateway dead. When doctor runs inside setup,
  // the first attempt can fail for reasons that are not "gateway down": a pooled
  // keep-alive socket the server idle-closed after the earlier health probes, or
  // a 3s timeout while npm/hook installers still have the machine busy. Both
  // checks are idempotent reads, so one clean retry is always safe.
  const fetchRetry = async (url, opts) => {
    try {
      return await fetch(url, opts);
    } catch {
      await new Promise((r) => setTimeout(r, 500));
      return fetch(url, opts);
    }
  };
  try {
    const h = await fetchRetry(`http://127.0.0.1:${cfg.port}/health`, { signal: AbortSignal.timeout(3000) });
    if (!h.ok) {
      bad("gateway", `HTTP ${h.status}`);
    } else {
      ok("gateway", `responding on :${cfg.port}`);
      // Compare the file on disk with what the RUNNING process loaded. Config is read
      // once at startup, so editing the env file without restarting is a silent trap:
      // doctor would otherwise report a key that the server is not actually using.
      const live = await h.json().catch(() => null);
      if (live?.llm) {
        const fileHasKey = Boolean(cfg.llm.apiKey);
        if (fileHasKey && !live.llm.configured && !live.llm.mock) {
          bad(
            "running config",
            "the server has NO LLM key but your env file does -- restart it: pkill -f 'memgw.mjs start' && memgw start"
          );
        } else if (live.llm.model !== cfg.llm.model) {
          warn("running config", `server is on ${live.llm.model}, env file says ${cfg.llm.model} -- restart to apply`);
        } else {
          ok("running config", `matches the env file (${live.llm.model})`);
        }
        if (live.embed && (live.embed.model || "") !== (cfg.embed.model || "")) {
          warn(
            "running config",
            `embeddings: server ${live.embed.model || "off"}, env file ${cfg.embed.model || "off"} -- restart to apply`
          );
        }
      }
    }
    const s = await fetchRetry(`http://127.0.0.1:${cfg.mcpPort}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // MCP Streamable HTTP requires the client to accept both content types
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      signal: AbortSignal.timeout(3000),
    });
    s.ok ? ok("mcp", `responding on :${cfg.mcpPort}`) : bad("mcp", `HTTP ${s.status}`);
  } catch {
    warn("gateway", "not running (start it with: npx @holetex/memgw start)");
    // a setup-started gateway logs here; its last words are the diagnosis
    const glog = join(HOME_DIR, "gateway.log");
    if (existsSync(glog)) {
      const tail = readFileSync(glog, "utf8").trim().split("\n").slice(-4);
      if (tail.length) {
        console.log(c.dim(`        last lines of ${glog}:`));
        tail.forEach((l) => console.log(c.dim(`        ${l.slice(0, 200)}`)));
      }
    }
  }

  try {
    const { execFileSync } = await import("node:child_process");
    ok("git", execFileSync("git", ["--version"]).toString().trim());
  } catch {
    warn("git", "not found -- notes history and git backup are disabled");
  }

  const w = Math.max(...rows.map((r) => r[1].length));
  rows.forEach(([s, n, v]) => console.log(`  ${s.padEnd(14)} ${n.padEnd(w)}  ${c.dim(v)}`));
  if (rows.some((r) => r[0].includes("fail"))) process.exit(1);
}

async function cmdSearch() {
  applyFlagsToEnv();
  const cfg = loadConfig();
  const q = argv.slice(1).filter((a) => !a.startsWith("--")).join(" ");
  if (!q) return console.error("Usage: memgw search <query> [--type deadend] [--limit 8]");
  const params = new URLSearchParams({ q, limit: opt("limit", "8") });
  if (opt("type", null)) params.set("type", opt("type"));
  const { results } = await api(cfg, `/search/facts?${params}`);
  if (!results.length) return console.log(c.dim("no matches"));
  for (const r of results) {
    console.log(`${c.b(`[${r.type}${r.topic ? "/" + r.topic : ""}]`)} ${c.dim(`p${r.priority}`)} ${r.content}`);
  }
}

async function cmdSave() {
  applyFlagsToEnv();
  const cfg = loadConfig();
  // Everything before the first flag is the fact text; flag VALUES must not leak into it.
  const rest = argv.slice(1);
  const firstFlag = rest.findIndex((a) => a.startsWith("--"));
  const content = (firstFlag === -1 ? rest : rest.slice(0, firstFlag)).join(" ");
  if (!content) return console.error('Usage: memgw save "fact text" [--type decision] [--topic slug]');
  const r = await api(cfg, "/facts", {
    method: "POST",
    body: {
      content,
      type: opt("type", "preference"),
      topic: opt("topic", null) || undefined,
      priority: Number(opt("priority", 60)),
    },
  });
  console.log(c.g(`saved ${r.id}`));
}

async function cmdForget() {
  applyFlagsToEnv();
  const cfg = loadConfig();
  const q = argv.slice(1).filter((a) => !a.startsWith("--")).join(" ");
  if (!q) return console.error('Usage: memgw forget <query> [--type episode] [--limit 10] [--yes]');
  const confirm = argv.includes("--yes");
  const r = await api(cfg, "/facts/forget", {
    method: "POST",
    body: { query: q, type: opt("type", null) || undefined, limit: Number(opt("limit", 10)), confirm },
  });
  if (!r.matches.length) return console.log(c.dim("no matches"));
  for (const m of r.matches) {
    console.log(`${c.b(`[${m.type}${m.topic ? "/" + m.topic : ""}]`)} ${c.dim(`p${m.priority}`)} ${m.content}`);
  }
  if (r.dry_run) console.log(c.dim(`\n${r.matches.length} match(es). Re-run with --yes to forget them.`));
  else console.log(c.g(`forgot ${r.forgotten} fact(s)`));
}

async function cmdEmbed() {
  applyFlagsToEnv();
  const sub = argv[1] || "status";
  if (sub === "on") {
    const model = argv[2] && !argv[2].startsWith("--") ? argv[2] : "text-embedding-3-small";
    upsertEnvFile({ MEMGW_EMBED_MODEL: model });
    console.log(c.g(`embeddings ON (${model})`));
    console.log(c.dim("config is read at startup -- restart the gateway to apply."));
    console.log(c.dim("existing facts and events are backfilled automatically after the restart."));
  } else if (sub === "off") {
    upsertEnvFile({ MEMGW_EMBED_MODEL: "" });
    console.log(c.g("embeddings OFF (search is BM25 only; stored vectors are kept)"));
    console.log(c.dim("config is read at startup -- restart the gateway to apply."));
  } else {
    const cfg = loadConfig();
    console.log(`config: ${cfg.embed.model ? c.g(`on (${cfg.embed.model}, dim ${cfg.embed.dim})`) : c.dim("off")}`);
    try {
      const h = await (await fetch(`http://127.0.0.1:${cfg.port}/health`, { signal: AbortSignal.timeout(3000) })).json();
      const live = h.embed?.enabled ? `on (${h.embed.model})` : "off";
      console.log(`running gateway: ${live}${(h.embed?.model || "") !== (cfg.embed.model || "") ? c.y("  <- differs from config, restart to apply") : ""}`);
      const s = await api(cfg, "/stats");
      const rows = s.counts.facts_active + s.counts.events;
      console.log(`vectors: ${s.counts.vectors} (store has ${rows} searchable rows)`);
    } catch {
      console.log(c.dim("gateway not running -- start it to see live status and coverage"));
    }
  }
}

// One-time wizard: everything a new machine needs, in one command.
// Idempotent -- rerunning repairs or updates instead of duplicating.
async function cmdSetup() {
  applyFlagsToEnv();
  const { execFileSync } = await import("node:child_process");
  const run = (bin, args) => execFileSync(bin, args, { stdio: "pipe" }).toString();
  const found = (bin) => {
    try {
      run(process.platform === "win32" ? "where" : "which", [bin]);
      return true;
    } catch { return false; }
  };
  const tty = process.stdin.isTTY && !argv.includes("--yes");
  let rl = null;
  const confirm = async (q) => {
    if (!tty) return true;
    if (!rl) rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question(`${q} [Y/n] `)).trim();
    return a === "" || /^y/i.test(a);
  };
  const askLine = async (q) => {
    if (!tty) return "";
    if (!rl) rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
    return (await rl.question(q)).trim();
  };
  // secrets must not land in terminal scrollback: mask every typed character.
  // _writeToOutput is an undocumented readline internal that is missing on some
  // Node versions (v21 crashed here) -- fall back to visible input rather than die.
  const askSecret = async (q) => {
    if (!tty) return "";
    if (!rl) rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
    if (typeof rl._writeToOutput !== "function") {
      console.log(c.dim("  (this Node version cannot mask input -- the key will be visible as you type)"));
      return (await rl.question(q)).trim();
    }
    const orig = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => orig(/[\r\n]/.test(s) || s.includes(q) ? s : "*");
    try {
      return (await rl.question(q)).trim();
    } finally {
      rl._writeToOutput = orig;
    }
  };

  console.log(c.b("memgw setup — one-time wizard for this machine\n"));

  const nodeMajor = +process.versions.node.split(".")[0];
  if (nodeMajor % 2 === 1)
    console.log(`${c.y("warn")}  Node ${process.versions.node} is an odd (non-LTS) release -- better-sqlite3 ships no prebuilds for it. If anything fails below, install Node 20/22/24 LTS and rerun.`);

  // 1. config and keys (created on first load) -- Node is the only prerequisite,
  // and running this command proves it is present.
  const cfg = loadConfig({ autoKey: true });
  console.log(`${c.g("ok")}    config ${ENV_FILE} (keys ${cfg.generated.length ? "generated" : "present"})`);

  // 3. LLM key -- the one thing that cannot be automated
  if (!cfg.llm.apiKey && !cfg.llm.mock) {
    const key = await askSecret("LLM API key (OpenAI-compatible; Enter to skip -- capture works, no facts until set): ");
    if (key) {
      upsertEnvFile({ MEMGW_LLM_API_KEY: key, MEMGW_LLM_MODEL: cfg.llm.model });
      console.log(`${c.g("ok")}    LLM key saved (model ${cfg.llm.model})`);
    } else {
      console.log(`${c.y("warn")}  no LLM key -- add MEMGW_LLM_API_KEY to ${ENV_FILE} later`);
    }
  } else {
    console.log(`${c.g("ok")}    llm ${cfg.llm.mock ? "mock mode" : cfg.llm.model}`);
  }

  // 4. keep the gateway alive, then make sure it is up
  const inNpxCache = ROOT.includes("_npx");
  if (process.platform === "darwin" && !inNpxCache) {
    const plistDst = join(homedir(), "Library", "LaunchAgents", "com.memgw.plist");
    const uid = process.getuid();
    const plist = readFileSync(join(ROOT, "deploy", "com.memgw.plist"), "utf8")
      .replaceAll("NODE_PATH", process.execPath)
      .replaceAll("REPO_DIR", ROOT)
      .replaceAll("HOME_PATH", homedir());
    writeFileSync(plistDst, plist);
    try {
      run("launchctl", ["bootout", `gui/${uid}/com.memgw`]);
      await new Promise((r) => setTimeout(r, 1500)); // bootout is async; racing it makes bootstrap fail
    } catch {}
    let loaded = false;
    for (let i = 0; i < 3 && !loaded; i++) {
      try {
        run("launchctl", ["bootstrap", `gui/${uid}`, plistDst]);
        loaded = true;
      } catch { await new Promise((r) => setTimeout(r, 2000)); }
    }
    loaded
      ? console.log(`${c.g("ok")}    launchd keeps the gateway alive (com.memgw)`)
      : console.log(`${c.y("warn")}  launchctl bootstrap failed -- run by hand: launchctl bootstrap gui/${uid} ${plistDst}`);
  } else if (process.platform === "linux" && !inNpxCache) {
    // parity with macOS: install a user-level systemd unit so the gateway
    // survives crashes and logins, no root required
    try {
      const unitDir = join(homedir(), ".config", "systemd", "user");
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(
        join(unitDir, "memgw.service"),
        `[Unit]\nDescription=memgw memory gateway\n\n[Service]\nExecStart=${process.execPath} ${join(ROOT, "bin", "memgw.mjs")} start\nRestart=always\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n`
      );
      run("systemctl", ["--user", "daemon-reload"]);
      run("systemctl", ["--user", "enable", "--now", "memgw"]);
      console.log(`${c.g("ok")}    systemd --user keeps the gateway alive (memgw.service)`);
    } catch {
      console.log(`${c.y("note")}  could not enable systemd --user; run by hand:`);
      console.log(c.dim(`      systemctl --user enable --now memgw   # unit written to ~/.config/systemd/user/`));
    }
  } else if (process.platform === "win32") {
    console.log(`${c.y("note")}  start at logon with Task Scheduler:`);
    console.log(c.dim(`      schtasks /Create /TN memgw /SC ONLOGON /TR "\\"${process.execPath}\\" \\"${join(ROOT, "bin", "memgw.mjs")}\\" start"`));
  } else if (inNpxCache) {
    console.log(`${c.y("note")}  running from the npx cache -- install permanently for supervision: npm install -g @holetex/memgw`);
  }
  const probe = async (tries) => {
    for (let i = 0; i < tries; i++) {
      try {
        await fetch(`http://127.0.0.1:${cfg.port}/health`, { signal: AbortSignal.timeout(1000) });
        return true;
      } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    return false;
  };
  let up = await probe(12);
  if (!up) {
    // Supervision either is not installed on this platform or has not kicked in.
    // setup must still END with a working gateway, so start one directly.
    // Its output goes to a log file: a detached gateway that dies silently is
    // undebuggable, and "it was up during setup, down at doctor" does happen.
    const { spawn } = await import("node:child_process");
    const { openSync } = await import("node:fs");
    const logFile = join(HOME_DIR, "gateway.log");
    const logFd = openSync(logFile, "a");
    spawn(process.execPath, [join(ROOT, "bin", "memgw.mjs"), "start"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    }).unref();
    console.log(`${c.y("note")}  starting the gateway directly (runs until reboot; log: ${logFile})`);
    up = await probe(16);
  }
  up
    ? console.log(`${c.g("ok")}    gateway responding on :${cfg.port}`)
    : console.log(`${c.y("warn")}  gateway did not come up -- run 'memgw start' in a terminal and read the error`);

  // 5. wire up every agent found on this machine
  const mcpUrl = `http://127.0.0.1:${cfg.mcpPort}/mcp`;
  if (found("claude") && (await confirm("Connect Claude Code (hooks + MCP)?"))) {
    if (!argv.includes("--write")) argv.push("--write"); // reuse the hooks installer below
    cmdHooks();
    try {
      run("claude", ["mcp", "add", "--transport", "http", "memgw", mcpUrl, "--header", `Authorization: Bearer ${cfg.key}`]);
      console.log(`${c.g("ok")}    Claude Code MCP registered`);
    } catch (e) {
      console.log(`${c.y("note")}  claude mcp add: ${String(e.stderr || e.message).split("\n")[0].slice(0, 90)}`);
    }
  }
  if (found("codex") && (await confirm("Connect Codex CLI (MCP, path secret)?"))) {
    try {
      run("codex", ["mcp", "remove", "memgw"]);
    } catch {}
    try {
      run("codex", ["mcp", "add", "memgw", "--url", `${mcpUrl}/${cfg.mcpSecret}`]);
      console.log(`${c.g("ok")}    Codex MCP registered (no header, no env var)`);
      console.log(`${c.dim("      capture for Codex is a separate watcher: npx @holetex/memgw watch --agent codex")}`);
    } catch (e) {
      console.log(`${c.y("note")}  codex mcp add: ${String(e.stderr || e.message).split("\n")[0].slice(0, 90)}`);
    }
  }
  if (found("opencode")) {
    console.log(`${c.y("note")}  opencode found -- copy the plugin: cp ${join(ROOT, "agents/opencode-plugin/memgw.js")} ~/.config/opencode/plugins/`);
  }

  rl?.close();
  console.log("");
  await cmdDoctor();
}

function cmdWatch() {
  const args = argv.slice(1);
  if (!args.includes("--agent")) args.push("--agent", "claude-code");
  const child = spawn(process.execPath, [join(ROOT, "agents/watcher.mjs"), ...args], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

function cmdHooks() {
  const cfg = loadConfig({ autoKey: true });
  mkdirSync(HOME_DIR, { recursive: true });
  for (const f of ["capture.mjs", "bootstrap.mjs"]) {
    const dest = join(HOME_DIR, f);
    copyFileSync(join(ROOT, "hooks", f), dest);
    chmodSync(dest, 0o755);
  }
  ensureEnvFile({
    MEMGW_URL: `http://127.0.0.1:${cfg.port}`,
    MEMGW_SOURCE: `claude-code-${process.env.HOSTNAME || "local"}`,
  });

  const settingsPath = join(homedir(), ".claude", "settings.json");
  const block = {
    SessionStart: [{ hooks: [{ type: "command", command: `node "${HOME_DIR}/bootstrap.mjs"` }] }],
    Stop: [{ hooks: [{ type: "command", command: `node "${HOME_DIR}/capture.mjs"` }] }],
  };

  if (has("write")) {
    // Create settings.json when it does not exist yet; merge into it when it does.
    // Only SessionStart and Stop are replaced -- every other hook type is preserved.
    mkdirSync(dirname(settingsPath), { recursive: true });
    let s = {};
    if (existsSync(settingsPath)) {
      try {
        s = JSON.parse(readFileSync(settingsPath, "utf8"));
      } catch (e) {
        console.error(c.r(`${settingsPath} is not valid JSON, refusing to overwrite it.`));
        console.error(c.dim("Fix or move the file, then run this again."));
        process.exit(1);
      }
      copyFileSync(settingsPath, `${settingsPath}.memgw-backup`);
    }
    s.hooks = { ...(s.hooks || {}), ...block };
    writeFileSync(settingsPath, JSON.stringify(s, null, 2));
    console.log(c.g(`Hooks installed into ${settingsPath}`));
    if (existsSync(`${settingsPath}.memgw-backup`)) {
      console.log(c.dim(`Previous file backed up to ${settingsPath}.memgw-backup`));
    }
  } else {
    console.log(c.g(`Hook scripts copied to ${HOME_DIR}`));
    console.log(`\nAdd this to ${settingsPath}:\n`);
    console.log(JSON.stringify({ hooks: block }, null, 2));
    console.log(c.dim("\nOr re-run with --write to merge it automatically."));
  }
}

// --------------------------------------------------------------------------

const commands = {
  start: cmdStart,
  init: cmdInit,
  status: cmdStatus,
  doctor: cmdDoctor,
  search: cmdSearch,
  save: cmdSave,
  forget: cmdForget,
  embed: cmdEmbed,
  watch: cmdWatch,
  hooks: cmdHooks,
  setup: cmdSetup,
};

if (!cmd || cmd === "help" || has("help")) {
  console.log(HELP);
} else if (cmd === "--version" || cmd === "-v" || cmd === "version") {
  console.log(pkg.version);
} else if (commands[cmd]) {
  try {
    await commands[cmd]();
  } catch (e) {
    console.error(c.r(e.message || String(e)));
    process.exit(1);
  }
} else {
  console.error(`Unknown command: ${cmd}\n`);
  console.log(HELP);
  process.exit(1);
}
