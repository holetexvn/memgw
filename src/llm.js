// Minimal LLM client: any OpenAI-compatible /chat/completions endpoint.
// Works with OpenAI, DeepSeek, Groq, Together, OpenRouter, or a local Ollama /
// vLLM server -- memgw only ever needs baseUrl + apiKey + model.
//
// MEMGW_LLM_MOCK=1 runs the whole pipeline without an API key. The test suite
// relies on it, and it is the fastest way to try memgw before paying for anything.

const cfg = () => ({
  baseUrl: (process.env.MEMGW_LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
  apiKey: process.env.MEMGW_LLM_API_KEY || "",
  model: process.env.MEMGW_LLM_MODEL || "gpt-4o-mini",
  mock: process.env.MEMGW_LLM_MOCK === "1",
});

// No key and not mock = extraction is OFF on purpose. Callers check this
// instead of firing requests that can only 401: capture keeps working and
// events queue up until a key arrives.
export const llmReady = () => Boolean(cfg().apiKey) || cfg().mock;

// OpenAI reasoning models (gpt-5 family, o-series) reject `max_tokens` and any
// non-default temperature. Older models and other OpenAI-compatible providers
// still expect `max_tokens`, so the request shape depends on the model name.
export function tokenParams(model, maxTokens, temperature) {
  return /^(gpt-5|o\d)/.test(model)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens, temperature };
}

export async function chat(system, user, { maxTokens = 4000, timeoutMs = 120_000 } = {}) {
  const c = cfg();
  if (c.mock) return mockChat(system, user);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${c.baseUrl}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify({
        model: c.model,
        ...tokenParams(c.model, maxTokens, 0.1),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      tokensIn: data.usage?.prompt_tokens ?? 0,
      tokensOut: data.usage?.completion_tokens ?? 0,
    };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Agentic tool-calling loop, used by the notes updater.
 * tools: [{name, description, parameters(JSONSchema), handler(args) -> string}]
 */
export async function chatWithTools(
  system,
  user,
  tools,
  { maxSteps = 12, maxTokens = 4000, timeoutMs = 180_000 } = {}
) {
  const c = cfg();
  if (c.mock) return mockAgent(system, user, tools);

  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const toolDefs = tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  let tokensIn = 0,
    tokensOut = 0,
    steps = 0;

  for (let i = 0; i < maxSteps; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let data;
    try {
      const res = await fetch(`${c.baseUrl}/chat/completions`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${c.apiKey}` },
        body: JSON.stringify({
          model: c.model,
          ...tokenParams(c.model, maxTokens, 0.2),
          messages,
          tools: toolDefs,
        }),
      });
      if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
      data = await res.json();
    } finally {
      clearTimeout(t);
    }
    tokensIn += data.usage?.prompt_tokens ?? 0;
    tokensOut += data.usage?.completion_tokens ?? 0;
    const msg = data.choices?.[0]?.message;
    if (!msg) break;
    messages.push(msg);
    const calls = msg.tool_calls || [];
    if (!calls.length) break; // model stopped calling tools -- it is done
    for (const call of calls) {
      steps++;
      const fn = byName[call.function?.name];
      let result;
      try {
        const args = JSON.parse(call.function?.arguments || "{}");
        result = fn ? String(await fn.handler(args)) : `unknown tool ${call.function?.name}`;
      } catch (e) {
        result = `error: ${e.message}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result.slice(0, 4000) });
    }
  }
  return { steps, tokensIn, tokensOut };
}

/**
 * Parse a JSON array out of model output, with two layers of tolerance:
 * strip markdown fences, then take the outermost [...] span.
 */
export function parseJsonArray(text) {
  const s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mock mode. Detection is language-agnostic so it keeps working for every
// MEMGW_PROMPT_LANG: we look at the shape of the request, not its wording.
// ---------------------------------------------------------------------------

function mockChat(system, user) {
  // dedup request: the user block always lists "FACT <n>:" entries
  if (/^FACT \d+:/m.test(user)) {
    const n = (user.match(/^FACT \d+:/gm) || []).length;
    return {
      text: JSON.stringify(Array.from({ length: n }, (_, i) => ({ index: i, action: "store" }))),
      tokensIn: 0,
      tokensOut: 0,
    };
  }
  // profile rewrite: the system prompt names the file it must produce
  if (system.includes("profile.md")) {
    return {
      text: "# Profile (mock)\n\nMock profile generated without an LLM.\n",
      tokensIn: 0,
      tokensOut: 0,
    };
  }
  // otherwise: fact extraction from a transcript
  const facts = [];
  for (const m of user.matchAll(/<<past-user>>\n([\s\S]*?)(?=\n\n<<|$)/g)) {
    const line = m[1].trim();
    // keyword list spans the shipped prompt languages so mock mode works for both
    if (/remember|decide|prefer|nh\u1edb|ch\u1ed1t|quy\u1ebft \u0111\u1ecbnh|th\u00edch|\u0111\u1eebng/i.test(line)) {
      facts.push({ content: line.slice(0, 200), type: "preference", topic: "mock", priority: 50 });
    }
  }
  return { text: JSON.stringify(facts), tokensIn: 0, tokensOut: 0 };
}

// Simulates one agentic edit so the notes pipeline (tool call -> file -> git commit)
// can be exercised end to end without an API key.
function mockAgent(_system, user, tools) {
  const write = tools.find((t) => t.name === "write_note");
  let steps = 0;
  if (write) {
    const facts = [...user.matchAll(/^- \[[^\]]+\]\s*(.+)$/gm)].map((m) => m[1]);
    if (facts.length) {
      const body = `# Auto note (mock)\n\n${facts.map((f) => `- ${f}`).join("\n")}\n`;
      write.handler({ path: "topics/auto-mock.md", content: body });
      steps++;
    }
  }
  return { steps, tokensIn: 0, tokensOut: 0 };
}
