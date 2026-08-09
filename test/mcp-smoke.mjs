// MCP smoke test: speak JSON-RPC directly to the Streamable HTTP endpoint.
// The server must already be running: MEMGW_KEY=test MEMGW_MCP_SECRET=s3cret MEMGW_LLM_MOCK=1 node src/server.js
const BASE = process.env.MCP_URL || "http://127.0.0.1:8931";
const KEY = process.env.MEMGW_KEY || "test";
const SECRET = process.env.MEMGW_MCP_SECRET || "s3cret";

let pass = 0, fail = 0, rpcId = 0;
const check = (name, ok, extra = "") => {
  if (ok) { console.log(`PASS ${name}`); pass++; }
  else { console.log(`FAIL ${name} ${extra}`); fail++; }
};

async function rpc(path, method, params, { auth = true, expectStatus = 200 } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(auth ? { authorization: `Bearer ${KEY}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (res.status !== expectStatus) return { _status: res.status };
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("json")) return { _status: res.status, _ct: ct };
  return { _status: res.status, ...(await res.json().catch(() => ({}))) };
}

const initParams = {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0" },
};

// 1. No auth -> 401
let r = await rpc("/mcp", "initialize", initParams, { auth: false, expectStatus: 401 });
check("auth: no bearer → 401", r._status === 401);

// 2. Wrong path secret -> 401
r = await rpc("/mcp/wrong-secret", "initialize", initParams, { auth: false, expectStatus: 401 });
check("auth: wrong path secret → 401", r._status === 401);

// 3. initialize with a Bearer token
r = await rpc("/mcp", "initialize", initParams);
check("initialize (bearer)", r.result?.serverInfo?.name === "memgw", JSON.stringify(r).slice(0, 200));

// 4. initialize with the path secret, no header
r = await fetch(`${BASE}/mcp/${SECRET}`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "initialize", params: initParams }),
}).then((x) => x.json());
check("initialize (path secret, no header)", r.result?.serverInfo?.name === "memgw");

// 5. tools/list returns all 5 tools
r = await rpc("/mcp", "tools/list", {});
const names = (r.result?.tools || []).map((t) => t.name).sort();
check(
  "tools/list = 5 tools",
  JSON.stringify(names) ===
    JSON.stringify(["conversation_search", "memory_bootstrap", "memory_read_note", "memory_save", "memory_search"]),
  JSON.stringify(names)
);

const call = (name, args) => rpc("/mcp", "tools/call", { name, arguments: args });
const textOf = (r) => r.result?.content?.[0]?.text || "";

// 6. memory_save
r = await call("memory_save", {
  content: "Đã thử deploy memgw bằng Deno, fail vì better-sqlite3 không build được",
  type: "deadend",
  topic: "memgw",
  priority: 75,
});
check("memory_save", textOf(r).startsWith("Saved fact"), textOf(r));

// 7. memory_search finds the fact just saved (query without diacritics, type filter)
r = await call("memory_search", { query: "deno fail", type: "deadend" });
check("memory_search (no diacritics + type filter)", textOf(r).includes("Deno"), textOf(r).slice(0, 120));

// 8. conversation_search finds the events from the earlier HTTP smoke test
r = await call("conversation_search", { query: "SQLite Postgres" });
check("conversation_search", textOf(r).includes("cc-test"), textOf(r).slice(0, 120));

// 9. memory_bootstrap returns profile + topics
r = await call("memory_bootstrap", {});
check("memory_bootstrap", textOf(r).includes("## Profile") && textOf(r).includes("topics/"), textOf(r).slice(0, 120));

// 10. memory_read_note reads a note and blocks traversal
r = await call("memory_read_note", { path: "topics/billing-service.md" });
check("memory_read_note", textOf(r).includes("Billing"));
r = await call("memory_read_note", { path: "../.env" });
check("memory_read_note blocks ../", textOf(r).includes("Invalid path"), textOf(r));

// 11. GET -> 405 (stateless)
const g = await fetch(`${BASE}/mcp`, { headers: { authorization: `Bearer ${KEY}` } });
check("GET → 405", g.status === 405);

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
