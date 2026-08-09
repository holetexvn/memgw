// Startup-guarantee regression suite: the auth promises in the README are only
// as good as the code that refuses to start when they do not hold.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (n) => { console.log(`PASS ${n}`); pass++; };
const no = (n, why) => { console.log(`FAIL ${n}: ${why}`); fail++; };

// isolate: fresh MEMGW_HOME, clean process env for the keys under test
const home = mkdtempSync(join(tmpdir(), "memgw-cfg-"));
process.env.MEMGW_HOME = home;
writeFileSync(join(home, "env"), "");
for (const k of ["MEMGW_KEY", "MEMGW_BIND", "MEMGW_MCP_SECRET", "MEMGW_WORKER_INTERVAL_MS", "MEMGW_PORT"])
  delete process.env[k];

const { loadConfig, validateConfig } = await import("../src/config.js");

// 1. no key, no autoKey -> refused
{
  const problems = validateConfig(loadConfig());
  problems.some((p) => p.includes("MEMGW_KEY")) ? ok("startup refused without a key") : no("no-key", problems.join("|"));
}

// 2. weak key on a non-loopback bind -> refused
{
  process.env.MEMGW_KEY = "short";
  process.env.MEMGW_BIND = "0.0.0.0";
  const problems = validateConfig(loadConfig());
  problems.some((p) => p.includes("24 characters")) ? ok("weak exposed key refused") : no("weak-key", problems.join("|"));
}

// 3. weak PATH SECRET on a non-loopback bind -> refused (bearer-equivalent)
{
  process.env.MEMGW_KEY = "a".repeat(48);
  process.env.MEMGW_MCP_SECRET = "guessme";
  const problems = validateConfig(loadConfig());
  problems.some((p) => p.includes("MEMGW_MCP_SECRET")) ? ok("weak exposed path secret refused") : no("weak-secret", problems.join("|"));
}

// 4. strong key + strong secret on loopback -> accepted
{
  process.env.MEMGW_BIND = "127.0.0.1";
  process.env.MEMGW_MCP_SECRET = "b".repeat(48);
  const problems = validateConfig(loadConfig());
  problems.length === 0 ? ok("valid loopback config accepted") : no("valid-config", problems.join("|"));
}

// 5. hostile numeric config falls back to sane values
{
  process.env.MEMGW_WORKER_INTERVAL_MS = "-1";
  process.env.MEMGW_PORT = "not-a-number";
  const cfg = loadConfig();
  cfg.workerIntervalMs >= 60_000 && cfg.port === 8930
    ? ok(`numeric guards hold (interval ${cfg.workerIntervalMs}, port ${cfg.port})`)
    : no("numeric guards", `interval=${cfg.workerIntervalMs} port=${cfg.port}`);
}

// 6. The SHIPPED .env.example must parse to the values it advertises
{
  const { readFileSync } = await import("node:fs");
  writeFileSync(join(home, "env"), readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
  for (const k of ["MEMGW_KEY", "MEMGW_BIND", "MEMGW_MCP_SECRET", "MEMGW_WORKER_INTERVAL_MS", "MEMGW_PORT", "MEMGW_LLM_MODEL"])
    delete process.env[k];
  const cfg = loadConfig();
  cfg.bind === "127.0.0.1" && cfg.isLocalOnly && cfg.key === "" && cfg.llm.model === "gpt-4o-mini"
    ? ok("shipped .env.example parses clean (no comment bleed)")
    : no(".env.example", `bind=${JSON.stringify(cfg.bind)} key=${JSON.stringify(cfg.key)} model=${cfg.llm.model}`);
}

rmSync(home, { recursive: true, force: true });
console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
