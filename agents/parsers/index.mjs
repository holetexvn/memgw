// Transcript parsers, one per agent CLI.
//
// These parsers are deliberately TOLERANT. The transcript formats are internal to
// each CLI, carry no stability guarantee, and change between minor releases. So
// instead of binding to one schema, each parser tries several paths to the role
// and the text, and takes whatever yields content. A record it cannot understand
// is skipped, never thrown -- one odd line must not kill the watcher.
//
// Adding an agent means adding one entry to PARSERS. The watcher stays untouched.

// --- shared helpers ---

// Extract text from content that may be a string or an array of Anthropic/OpenAI blocks.
export function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && (b.type === "text" || b.type === "output_text" || b.type === "input_text"))
      .map((b) => b.text ?? b.content ?? "")
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (Array.isArray(content.parts)) return textOf(content.parts);
  }
  return "";
}

// Normalise a timestamp to epoch milliseconds from an ISO string, seconds, or ms.
export function tsOf(v, fallback) {
  if (typeof v === "number") return v > 1e12 ? v : Math.round(v * 1000);
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return fallback;
}

// Drop anything that is not real conversation: harness noise, tool results, wrappers.
// This filter matters more than it looks -- without it the store fills with plumbing.
const NOISE = [
  /^<[a-z-]+>/i,                    // <system-reminder>, <command-name>...
  /^\s*\[Request interrupted/i,
  /^Caveat: The messages below/i,
  /^\s*$/,
];
export function isNoise(text) {
  return !text || NOISE.some((re) => re.test(text));
}

// --- Claude Code ---
// ~/.claude/projects/<slug>/<session>.jsonl
// { type: "user"|"assistant", message: {role, content}, timestamp: ISO, sessionId }
function claudeCode(rec, fallbackTs) {
  if (rec.type !== "user" && rec.type !== "assistant") return null;
  const text = textOf(rec.message?.content);
  if (isNoise(text)) return null;
  return {
    role: rec.type,
    content: text,
    ts: tsOf(rec.timestamp, fallbackTs),
    sessionId: rec.sessionId || rec.session_id || null,
  };
}

// --- Codex CLI ---
// ~/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl
// Records come in several shapes; keep only user/assistant messages.
function codex(rec, fallbackTs) {
  const t = rec.type || rec.record_type || rec.payload?.type;
  if (t && /tool_call|tool_result|reasoning|token_count|event_msg|state/i.test(t)) return null;

  const payload = rec.payload ?? rec;
  const role = payload.role ?? rec.role;
  if (role !== "user" && role !== "assistant") return null;

  const text = textOf(payload.content ?? payload.text ?? rec.content);
  if (isNoise(text)) return null;
  return {
    role,
    content: text,
    ts: tsOf(rec.timestamp ?? rec.ts ?? payload.timestamp, fallbackTs),
    sessionId: rec.session_id ?? rec.sessionId ?? payload.session_id ?? null,
  };
}

// --- opencode ---
// Used when the plugin is not installed. Accepts both {role, parts:[{type:"text"}]}
// and {role, content} shapes.
function opencode(rec, fallbackTs) {
  const role = rec.role ?? rec.message?.role;
  if (role !== "user" && role !== "assistant") return null;
  const text = textOf(rec.parts ?? rec.content ?? rec.message?.parts ?? rec.message?.content);
  if (isNoise(text)) return null;
  return {
    role,
    content: text,
    ts: tsOf(rec.time?.created ?? rec.timestamp ?? rec.created, fallbackTs),
    sessionId: rec.sessionID ?? rec.sessionId ?? rec.session_id ?? null,
  };
}

// --- generic ---
// Fallback for any CLI without a dedicated parser: any JSONL with a role plus text.
function generic(rec, fallbackTs) {
  const role = rec.role ?? rec.type ?? rec.message?.role;
  if (role !== "user" && role !== "assistant") return null;
  const text = textOf(rec.content ?? rec.text ?? rec.message?.content ?? rec.parts);
  if (isNoise(text)) return null;
  return {
    role,
    content: text,
    ts: tsOf(rec.timestamp ?? rec.ts ?? rec.time, fallbackTs),
    sessionId: rec.session_id ?? rec.sessionId ?? null,
  };
}

export const PARSERS = {
  "claude-code": claudeCode,
  codex,
  opencode,
  generic,
};

// Default transcript directory per agent (used when --dir is not given).
export const DEFAULT_DIRS = {
  "claude-code": "~/.claude/projects",
  codex: "~/.codex/sessions",
  opencode: "~/.local/share/opencode/storage",
  generic: null,
};

// Parse JSONL lines into normalised messages.
export function parseLines(lines, agent, fileMtime) {
  const parse = PARSERS[agent] || PARSERS.generic;
  const out = [];
  let sessionId = null;
  for (const line of lines) {
    const s = line.trim();
    if (!s || s[0] !== "{") continue;
    let rec;
    try {
      rec = JSON.parse(s);
    } catch {
      continue; // corrupt or half-written line
    }
    let msg;
    try {
      msg = parse(rec, fileMtime);
    } catch {
      continue; // unknown schema: skip the record, keep the watcher alive
    }
    if (!msg) continue;
    if (msg.sessionId) sessionId = msg.sessionId;
    out.push(msg);
  }
  return { messages: out, sessionId };
}
