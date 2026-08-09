import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Test 1: via the path secret (like the claude.ai connector - no custom header)
const t1 = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8931/mcp/s3cret"));
const c1 = new Client({ name: "sdk-test-secret", version: "0" });
await c1.connect(t1);
const tools = await c1.listTools();
const names = tools.tools.map((t) => t.name);
console.log("client via path secret: tools =", names.join(", "));
if (names.length !== 5 || !names.includes("memory_search"))
  throw new Error(`expected the 5 memgw tools, got: ${names}`);
const r1 = await c1.callTool({ name: "memory_search", arguments: { query: "SQLite" } });
if (typeof r1.content?.[0]?.text !== "string") throw new Error("memory_search returned no text content");
console.log("memory_search ok:", r1.content[0].text.split("\n")[0]);
await c1.close();

// Test 2: via the Bearer header (like Claude Code --header)
const t2 = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8931/mcp"), {
  requestInit: { headers: { authorization: "Bearer test" } },
});
const c2 = new Client({ name: "sdk-test-bearer", version: "0" });
await c2.connect(t2);
const r2 = await c2.callTool({ name: "memory_bootstrap", arguments: {} });
if (!r2.content?.[0]?.text?.includes("Profile")) throw new Error("bootstrap did not include the profile section");
console.log("bearer + bootstrap ok: true");
await c2.close();
console.log("SDK CLIENT: ALL OK");
