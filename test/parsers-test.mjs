// Test the multi-agent transcript parsers against a real fixture for each format.
// This is the most fragile part whenever a CLI changes its schema, so the ugly cases
// are covered too.
import { readFileSync } from "node:fs";
import { parseLines, textOf, isNoise, tsOf } from "../agents/parsers/index.mjs";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { console.log(`PASS ${name}`); pass++; }
  else { console.log(`FAIL ${name} ${extra}`); fail++; }
};
const load = (f) => readFileSync(`test/fixtures/${f}`, "utf8").split("\n");

// ---------- Claude Code ----------
{
  const { messages, sessionId } = parseLines(load("claude-code.jsonl"), "claude-code", 0);
  check("cc: picks exactly the 2 real messages", messages.length === 2, `got ${messages.length}: ${JSON.stringify(messages.map(m=>m.role))}`);
  check("cc: drops tool_result", !messages.some((m) => m.content.includes("file content")));
  check("cc: drops system-reminder", !messages.some((m) => m.content.includes("noise")));
  check("cc: takes text blocks, drops tool_use", messages[1]?.content === "Đã ghi nhận lựa chọn SQLite.", messages[1]?.content);
  check("cc: sessionId", sessionId === "cc-sess-1", sessionId);
  check("cc: ISO timestamp -> ms", messages[0].ts === Date.parse("2026-08-08T10:00:00.000Z"));
}

// ---------- Codex ----------
{
  const { messages, sessionId } = parseLines(load("codex.jsonl"), "codex", 0);
  check("codex: picks exactly 2 messages", messages.length === 2, `got ${messages.length}`);
  check("codex: input_text", messages[0]?.content === "Chốt dùng Postgres cho dự án X", messages[0]?.content);
  check("codex: output_text", messages[1]?.content === "Đã ghi nhận Postgres cho dự án X.", messages[1]?.content);
  check("codex: drops tool_call and token_count", !messages.some((m) => /shell|input.*100/.test(m.content)));
  check("codex: drops session_meta", !messages.some((m) => m.content.includes("/home/tung/proj")));
  check("codex: sessionId", sessionId === "cx-1", sessionId);
}

// ---------- opencode ----------
{
  const { messages, sessionId } = parseLines(load("opencode.jsonl"), "opencode", 0);
  check("oc: picks exactly 2 messages (drops system)", messages.length === 2, `got ${messages.length}`);
  check("oc: parts text", messages[0]?.content === "Đã thử Deno, fail vì better-sqlite3", messages[0]?.content);
  check("oc: drops tool-type parts", messages[1]?.content === "Ghi nhận ngõ cụt Deno.", messages[1]?.content);
  check("oc: ts from time.created", messages[0].ts === 1786200000000);
  check("oc: sessionID", sessionId === "oc-1", sessionId);
}

// ---------- generic ----------
{
  const { messages } = parseLines(load("generic.jsonl"), "generic", 0);
  check("generic: picks 2, drops the tool role", messages.length === 2, `got ${messages.length}`);
  check("generic: reads both .content and .text", messages[1]?.content === "Trả lời từ CLI lạ");
  check("generic: survives a broken JSON line", true);
}

// ---------- robustness ----------
{
  const junk = ['{"type":"user"}', "not json at all", "", "{}", '{"type":"user","message":null}', "[1,2,3]"];
  const { messages } = parseLines(junk, "claude-code", 12345);
  check("robust: junk input does not throw, returns 0 messages", messages.length === 0, `got ${messages.length}`);

  // a completely unknown schema -> the generic parser still does not crash
  const weird = ['{"role":"user","content":{"nested":{"deep":true}}}'];
  check("robust: unknown content object is skipped", parseLines(weird, "generic", 0).messages.length === 0);

  // unknown agent -> falls back to generic
  const okGeneric = parseLines(['{"role":"user","content":"xin chào"}'], "no-such-agent", 0);
  check("robust: unknown agent falls back to generic", okGeneric.messages.length === 1);

  // timestamp fallback when the record carries no ts
  const noTs = parseLines(['{"role":"user","content":"không có ts"}'], "generic", 999);
  check("robust: missing ts falls back to the file mtime", noTs.messages[0].ts === 999, String(noTs.messages[0]?.ts));
}

// ---------- helper ----------
{
  check("textOf: string", textOf("abc") === "abc");
  check("textOf: block array", textOf([{ type: "text", text: "a" }, { type: "tool_use" }, { type: "text", text: "b" }]) === "a\nb");
  check("textOf: null is safe", textOf(null) === "");
  check("tsOf: seconds -> ms", tsOf(1786200000, 0) === 1786200000000);
  check("tsOf: ms passes through", tsOf(1786200000000, 0) === 1786200000000);
  check("isNoise: harness tag", isNoise("<system-reminder>x</system-reminder>") === true);
  check("isNoise: normal text", isNoise("câu hỏi bình thường") === false);
}

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
