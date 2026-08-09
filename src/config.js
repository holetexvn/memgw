// Centralised configuration.
//
// Design goal: the SAME code runs as a throwaway local process and as a
// hardened server, with no code changes -- only config differs.
//
// Precedence (highest first):
//   1. process.env
//   2. ~/.memgw/env          (created on first run)
//   3. built-in defaults     (local-first: loopback, home directory)
//
// Security rule that makes local-first safe: the auth key is ALWAYS required,
// but when we bind to loopback only we generate it for you so there is nothing
// to configure. Binding to a non-loopback address with a weak/absent key is
// refused outright -- you cannot accidentally expose an open memory store.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

export const HOME_DIR = process.env.MEMGW_HOME || join(homedir(), ".memgw");
export const ENV_FILE = join(HOME_DIR, "env");

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const genKey = () => randomBytes(24).toString("hex");

function readEnvFile() {
  if (!existsSync(ENV_FILE)) return {};
  const out = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    // strip inline comments ("VALUE   # explanation") so a copied .env.example
    // parses to the intended values; no legitimate value here contains " #"
    if (m) out[m[1]] = m[2].replace(/\s+#.*$/, "").trim();
  }
  return out;
}

/**
 * Append missing keys to ~/.memgw/env without touching existing values.
 * Returns the keys that were added.
 */
/**
 * Set (or, with an empty value, remove) keys in the env file, overwriting
 * existing values. `ensureEnvFile` below only ADDS missing keys; this is the
 * explicit-toggle path used by `memgw embed on|off`.
 */
export function upsertEnvFile(pairs) {
  mkdirSync(HOME_DIR, { recursive: true });
  let lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split("\n") : [];
  for (const [k, v] of Object.entries(pairs)) {
    // match "KEY=", " KEY =", "KEY = value" -- the reader tolerates spaces, so the
    // writer must remove those variants too or a stale spaced line keeps winning
    const re = new RegExp(`^\\s*${k}\\s*=`);
    lines = lines.filter((l) => !re.test(l));
    if (v !== "" && v != null) lines.push(`${k}=${v}`);
  }
  writeFileSync(ENV_FILE, lines.filter((l, i, a) => l !== "" || i < a.length - 1).join("\n") + "\n");
  try {
    chmodSync(ENV_FILE, 0o600);
  } catch {}
}

export function ensureEnvFile(pairs) {
  mkdirSync(HOME_DIR, { recursive: true });
  const existing = readEnvFile();
  const added = [];
  let text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  if (text && !text.endsWith("\n")) text += "\n";
  for (const [k, v] of Object.entries(pairs)) {
    if (existing[k] === undefined || existing[k] === "") {
      text += `${k}=${v}\n`;
      added.push(k);
    }
  }
  if (added.length) {
    writeFileSync(ENV_FILE, text);
    try {
      chmodSync(ENV_FILE, 0o600); // the file holds secrets
    } catch {
      /* best effort on filesystems without POSIX modes */
    }
  }
  return added;
}

/**
 * Resolve the effective configuration.
 * @param {object} opts
 * @param {boolean} opts.autoKey  generate and persist a key when missing (CLI `start` does this)
 */
export function loadConfig({ autoKey = false } = {}) {
  const fileEnv = readEnvFile();

  // An EMPTY environment variable counts as unset, not as a value. Without this,
  // an exported-but-blank MEMGW_LLM_API_KEY in the user's shell silently overrides
  // a perfectly good key in the env file, and every LLM call fails with a 401 that
  // points nowhere useful.
  const get = (k, def) => {
    const fromEnv = process.env[k];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    const fromFile = fileEnv[k];
    if (fromFile !== undefined && fromFile !== "") return fromFile;
    return def;
  };
  // A malformed or hostile numeric value must fall back to the default, and
  // ranged values must stay in range: a negative worker interval would other-
  // wise become a near-continuous LLM loop with a real bill attached.
  const num = (k, def, min = 1, max = Number.MAX_SAFE_INTEGER) => {
    const n = Number(get(k, def));
    if (!Number.isFinite(n)) return def;
    return Math.min(Math.max(Math.trunc(n), min), max);
  };

  const bind = get("MEMGW_BIND", "127.0.0.1");
  const isLocalOnly = LOOPBACK.has(bind);

  let key = get("MEMGW_KEY", "");
  let mcpSecret = get("MEMGW_MCP_SECRET", "");
  const generated = [];

  if (!key && autoKey) {
    key = genKey();
    generated.push("MEMGW_KEY");
  }
  if (!mcpSecret && autoKey) {
    mcpSecret = genKey();
    generated.push("MEMGW_MCP_SECRET");
  }
  if (generated.length) {
    ensureEnvFile({ MEMGW_KEY: key, MEMGW_MCP_SECRET: mcpSecret });
  }

  // Paths default under $HOME so `npx memgw start` works from any directory.
  // dbPath derives from dataDir, so moving the data directory moves the database
  // with it; MEMGW_DB_PATH is only for putting the database somewhere else entirely.
  const dataDir = get("MEMGW_DATA_DIR", join(HOME_DIR, "data"));

  const cfg = {
    homeDir: HOME_DIR,
    dataDir,
    dbPath: get("MEMGW_DB_PATH", join(dataDir, "memgw.db")),

    // network
    bind,
    isLocalOnly,
    port: num("MEMGW_PORT", 8930, 1, 65535),
    mcpPort: num("MEMGW_MCP_PORT", 8931, 1, 65535),

    // auth
    key,
    mcpSecret,
    generated,

    // llm
    llm: {
      baseUrl: get("MEMGW_LLM_BASE_URL", "https://api.openai.com/v1"),
      apiKey: get("MEMGW_LLM_API_KEY", ""),
      model: get("MEMGW_LLM_MODEL", "gpt-4o-mini"),
      mock: get("MEMGW_LLM_MOCK", "") === "1",
      promptLang: get("MEMGW_PROMPT_LANG", "en"),
    },

    // embeddings (optional semantic layer; empty model = BM25 only)
    embed: {
      model: get("MEMGW_EMBED_MODEL", ""),
      dim: num("MEMGW_EMBED_DIM", 512, 16, 4096),
    },

    // workers
    workerIntervalMs: num("MEMGW_WORKER_INTERVAL_MS", 15 * 60 * 1000, 60_000),
    notesIntervalMs: num("MEMGW_NOTES_INTERVAL_MS", 6 * 60 * 60 * 1000, 300_000),
    retentionDays: num("MEMGW_RETENTION_DAYS", 90, 0),

    // backup
    gitRemote: get("MEMGW_GIT_REMOTE", ""),
  };

  // ~/.memgw is unambiguously ours: keep the whole tree private. (The database
  // file itself is chmodded by openDb; a custom MEMGW_DB_PATH's parent directory
  // is deliberately left alone -- it may be a shared location.)
  try { chmodSync(HOME_DIR, 0o700); } catch {}

  hydrateProcessEnv(cfg);
  return cfg;
}

/**
 * Push resolved values back into process.env.
 *
 * Several modules (the LLM client, the prompt selector, retention, the git push)
 * read process.env directly, because they are also usable standalone. Without this
 * step a value that lives only in ~/.memgw/env is visible to the server but invisible
 * to the code that actually uses it: the server reports a configured LLM key while
 * every request goes out with an empty bearer token and fails with a 401.
 *
 * Values already present in process.env are never overwritten -- an explicit
 * environment variable still wins over the file.
 */
function hydrateProcessEnv(cfg) {
  const derived = {
    MEMGW_LLM_API_KEY: cfg.llm.apiKey,
    MEMGW_LLM_BASE_URL: cfg.llm.baseUrl,
    MEMGW_LLM_MODEL: cfg.llm.model,
    MEMGW_PROMPT_LANG: cfg.llm.promptLang,
    MEMGW_RETENTION_DAYS: String(cfg.retentionDays),
    MEMGW_GIT_REMOTE: cfg.gitRemote,
    MEMGW_DATA_DIR: cfg.dataDir,
    MEMGW_EMBED_MODEL: cfg.embed.model,
    MEMGW_EMBED_DIM: String(cfg.embed.dim),
  };
  for (const [k, v] of Object.entries(derived)) {
    if (v !== "" && v != null && (process.env[k] === undefined || process.env[k] === "")) {
      process.env[k] = v;
    }
  }
  if (cfg.llm.mock && !process.env.MEMGW_LLM_MOCK) process.env.MEMGW_LLM_MOCK = "1";
}

/**
 * Fail fast on configurations that would be unsafe or broken.
 * Returns a list of human-readable problems (empty means OK).
 */
export function validateConfig(cfg) {
  const problems = [];
  if (!cfg.key) {
    problems.push(
      "MEMGW_KEY is not set. Run `memgw start` (it generates one) or set MEMGW_KEY yourself."
    );
  } else if (!cfg.isLocalOnly && cfg.key.length < 24) {
    problems.push(
      `MEMGW_BIND=${cfg.bind} exposes memgw beyond localhost, so MEMGW_KEY must be at least 24 characters. ` +
        "Generate one with: openssl rand -hex 24"
    );
  }
  if (cfg.port === cfg.mcpPort) problems.push("MEMGW_PORT and MEMGW_MCP_PORT must differ.");
  // the path secret is bearer-equivalent (it rides in URLs), so a weak one on an
  // exposed bind is as bad as a weak key
  if (!cfg.isLocalOnly && cfg.mcpSecret && cfg.mcpSecret.length < 24) {
    problems.push(
      `MEMGW_BIND=${cfg.bind} exposes the MCP endpoint, so MEMGW_MCP_SECRET must be at least 24 characters ` +
        "(or unset, to require the Authorization header). Generate one with: openssl rand -hex 24"
    );
  }
  return problems;
}
