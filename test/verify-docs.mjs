// Cross-check the documentation against the real code. Run: node test/verify-docs.mjs
// Purpose: catch the case where the docs say one thing and the code does another
// after someone changes the code later.
import { readFileSync } from "node:fs";
const read = (p) => readFileSync(p, "utf8");
const server = read("src/server.js"), mcpSrc = read("src/mcp.js"), config = read("src/config.js");
const installer = read("deploy/installer-header.sh");
const docFiles = ["docs/01-ARCHITECTURE.md","docs/02-OPERATIONS.md","docs/03-INTEGRATION.md","docs/04-API.md","docs/05-MULTI-AGENT.md","docs/06-BENCHMARKS.md","README.md","README_VI.md","SECURITY.md","CHANGELOG.md"];
const docs = docFiles.map(read).join("\n");
let bad = 0;
const flag = (m) => { console.log("MISMATCH: " + m); bad++; };

// 1. HTTP endpoints. /mcp is served by mcp.js, /notes/:path takes a sub-path.
const routes = [...server.matchAll(/app\.(get|post)\("([^"]+)"/g)].map((m) => m[2].replace(/\/:.*/, ""));
const epDocs = [...new Set([...docs.matchAll(/`(?:GET|POST) (\/[a-z\-/:.]+)/g)].map((m) => m[1]))];
for (const ep of epDocs) {
  const served =
    ep.startsWith("/mcp") ||                                        // served by mcp.js
    routes.some((r) => ep === r || ep.startsWith(r + "/") || r.startsWith(ep));
  if (!served) flag(`docs list endpoint ${ep}, the code does not serve it`);
}

// 2. MCP tools: check both directions
const toolsCode = [...mcpSrc.matchAll(/registerTool\(\s*"([^"]+)"/g)].map((m) => m[1]).sort();
const toolsDocs = [...new Set([...docs.matchAll(/`(memory_\w+|conversation_search)`/g)].map((m) => m[1]))].sort();
for (const t of toolsDocs) if (!toolsCode.includes(t)) flag(`docs list tool ${t}, the code does not have it`);
for (const t of toolsCode) if (!toolsDocs.includes(t)) flag(`code has tool ${t}, the docs never mention it`);

// 3. Env vars: must appear in the JS code OR in the installer (install-time only vars)
const allJs = ["server","db","worker","llm","mcp","notes","retention","config","prompts","embed"].map((f) => read(`src/${f}.js`)).join("\n")
  + read("bin/memgw.mjs");
const CLIENT_SIDE = ["MEMGW_URL", "MEMGW_SOURCE", "MEMGW_SOURCE_PREFIX", "MEMGW_CAPTURE_IGNORE"]; // used by hooks/plugins, not the server
for (const e of [...new Set([...docs.matchAll(/(MEMGW_[A-Z_]+)/g)].map((m) => m[1]))]) {
  if (!allJs.includes(e) && !installer.includes(e) && !CLIENT_SIDE.includes(e)) flag(`docs mention ${e}, nothing uses it`);
}

// 4. Important constants: code and docs must agree on the number
for (const [name, inCode, inDocs] of [
  ["MIN_KEEP 200",   read("src/retention.js").includes("MIN_KEEP = 200"), /200 events\*{0,2} are always kept/.test(docs)],
  ["MIN_DAYS 7",     read("src/retention.js").includes("MIN_DAYS = 7"),   /days < 7/.test(docs)],
  ["max 20 topics",  read("src/notes.js").includes("MAX_TOPIC_FILES = 20"), /20 topic files/.test(docs)],
  ["2500 chars",     read("src/notes.js").includes("MAX_TOPIC_CHARS = 2500"), /2500 characters/.test(docs)],
  ["idle 10 min",    read("src/worker.js").includes("10 * 60 * 1000"),    /idle for 10 min/.test(docs)],
  ["batch 20 msg",   read("src/worker.js").includes("BATCH = 20"),        /20 messages/.test(docs)],
  ["retention 90d",  config.includes('MEMGW_RETENTION_DAYS", 90'),        /90 days/.test(docs)],
  ["worker 15 min",  config.includes("15 * 60 * 1000"),                   /15 min/.test(docs)],
  ["notes 6 hours",  config.includes("6 * 60 * 60 * 1000"),               /6 hours/.test(docs)],
]) if (!inCode || !inDocs) flag(`${name} (code=${inCode} docs=${inDocs})`);

console.log(`checked: ${epDocs.length} endpoints, ${toolsCode.length} MCP tools, 9 constants`);
console.log(bad === 0 ? "== DOCS MATCH CODE ==" : `== ${bad} mismatch(es) ==`);
process.exit(bad ? 1 : 0);
