// MCP server: Streamable HTTP, stateless, hosted in the same process as the API.
// One endpoint serves every MCP client -- Claude Code, Codex, opencode, claude.ai.
//
// Two auth paths (either works; neither present means 401):
//   1. Header: Authorization: Bearer <MEMGW_KEY>   -- CLI clients that send headers
//   2. Path:   POST /mcp/<MEMGW_MCP_SECRET>        -- web clients that cannot send
//      custom headers. It is a SEPARATE token so it can be rotated on its own.
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgVersion = () => {
  try {
    return JSON.parse(readFileSync(join(fileURLToPath(import.meta.url), "..", "..", "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
};
import { insertFact } from "./db.js";
import { hybridSearchFacts, hybridSearchEvents } from "./embed.js";
import { resolveWithin } from "./notes.js";

const FACT_TYPES = ["preference", "decision", "instruction", "project", "deadend", "episode"];

function buildMcpServer(db, dataDir, listTopics) {
  const server = new McpServer({ name: "memgw", version: pkgVersion() });

  server.registerTool(
    "memory_search",
    {
      description:
        "Search the user's distilled long-term facts: preferences, decisions, standing " +
        "instructions, and dead ends already tried. Use it whenever you need context from " +
        "earlier sessions.",
      inputSchema: {
        query: z.string().describe("search terms"),
        type: z.enum(FACT_TYPES).optional().describe("filter by fact type; 'deadend' = something tried that failed"),
        topic: z.string().optional().describe("filter by topic slug"),
        limit: z.number().int().min(1).max(30).optional(),
      },
    },
    async ({ query, type, topic, limit }) => {
      const results = await hybridSearchFacts(db, query, { type, topic, limit: limit ?? 8 });
      return text(
        results.length
          ? results.map((r) => `[${r.type}${r.topic ? "/" + r.topic : ""}] (p${r.priority}) ${r.content}`).join("\n")
          : "No matching facts."
      );
    }
  );

  server.registerTool(
    "conversation_search",
    {
      description:
        "Search raw transcripts of previous sessions across every connected agent. " +
        "Use it when you need the exact wording and distilled facts are not specific enough.",
      inputSchema: {
        query: z.string(),
        session_id: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, session_id, limit }) => {
      const results = await hybridSearchEvents(db, query, { session: session_id, limit: limit ?? 10 });
      return text(
        results.length
          ? results
              .map((r) => `[${r.source} ${new Date(r.ts).toISOString().slice(0, 16)} ${r.role}] ${r.content.slice(0, 400)}`)
              .join("\n---\n")
          : "No matching conversation found."
      );
    }
  );

  server.registerTool(
    "memory_read_note",
    {
      description: "Read a topic note or profile.md. Get the list of paths from memory_bootstrap.",
      inputSchema: { path: z.string().describe("e.g. profile.md or topics/billing-service.md") },
    },
    async ({ path }) => {
      // .md only: notes and the profile are Markdown; anything else under data/
      // (.git/config, the database) must not be readable through this tool
      const full = path.endsWith(".md") ? resolveWithin(dataDir, path) : null;
      if (!full) return text("Invalid path.");
      if (!existsSync(full)) return text(`No such file: ${path}.`);
      // same context-budget cap as the HTTP side: a runaway file must not flood
      // the agent's context window
      const content = readFileSync(full, "utf8");
      return text(content.length > 20_000 ? content.slice(0, 20_000) + "\n\n[truncated at 20000 chars]" : content);
    }
  );

  server.registerTool(
    "memory_save",
    {
      description:
        "Save a fact to long-term memory. Use it when the user says 'remember this', settles " +
        "a decision worth keeping, or hits a dead end (type=deadend) worth recording so a " +
        "future session does not repeat it.",
      inputSchema: {
        content: z.string().max(20_000).describe("ONE self-contained sentence"),
        type: z.enum(FACT_TYPES),
        topic: z.string().max(100).optional(),
        priority: z.number().int().min(0).max(100).optional(),
      },
    },
    async ({ content, type, topic, priority }) => {
      const id = insertFact(db, { content, type, topic, priority: priority ?? 60 });
      return text(`Saved fact ${id}: [${type}] ${content}`);
    }
  );

  server.registerTool(
    "memory_bootstrap",
    {
      description:
        "Fetch the user profile and the list of topic notes. Call once at the start of a " +
        "session to learn who the user is and what the memory store contains.",
      inputSchema: {},
    },
    async () => {
      // mirror the HTTP /bootstrap budget caps AND its sandbox: session context
      // is expensive, and a symlinked profile.md must not read outside data/
      const profilePath = resolveWithin(dataDir, "profile.md");
      const profile =
        profilePath && existsSync(profilePath)
          ? readFileSync(profilePath, "utf8").slice(0, 6000)
          : "(no profile.md yet)";
      const topics = listTopics().slice(0, 30);
      return text(
        `## Profile\n${profile}\n\n## Topic notes\n` +
          (topics.length ? topics.map((t) => `- ${t.path} : ${t.summary}`).join("\n") : "(none yet)")
      );
    }
  );

  return server;
}

const text = (s) => ({ content: [{ type: "text", text: s }] });

// Stateless: each POST builds a fresh transport and returns plain JSON. No
// server-side session state, so restarts and load balancers are non-issues.
export function startMcpHttp(db, { port, bind = "127.0.0.1", key, pathSecret, dataDir, listTopics }) {
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");

    const bearerOk = req.headers.authorization === `Bearer ${key}`;
    const isBasePath = url.pathname === "/mcp" || url.pathname === "/mcp/";
    const isSecretPath = Boolean(pathSecret) && url.pathname === `/mcp/${pathSecret}`;
    // Valid: /mcp with a correct Bearer, OR /mcp/<secret>. Everything else is 401.
    if (!isSecretPath && !(isBasePath && bearerOk)) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }

    if (req.method !== "POST") {
      // Stateless deployment has no standalone SSE stream; GET is 405 per spec.
      res.writeHead(405, { "content-type": "application/json", allow: "POST" });
      return res.end(JSON.stringify({ error: "method not allowed" }));
    }

    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 2_000_000) req.destroy(); // cap request size even for auth'd clients
    });
    req.on("end", async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid json" }));
      }
      try {
        const server = buildMcpServer(db, dataDir, listTopics);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless
          enableJsonResponse: true,
        });
        res.on("close", () => {
          transport.close();
          server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, parsed);
      } catch (err) {
        console.error("[mcp]", err);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal" }));
        }
      }
    });
  });

  httpServer.on("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      console.error(`MCP port ${port} is taken -- is another memgw running? (set MEMGW_MCP_PORT for a second instance)`);
      process.exit(1);
    }
    console.error("[mcp]", err);
    process.exit(1);
  });
  httpServer.listen(port, bind, () => {});
  return httpServer;
}
