#!/usr/bin/env node
// memgw bootstrap hook for Claude Code (the "SessionStart" hook).
// Pulls the profile + topic index + tool guide and prints them to stdout so Claude
// Code injects them at session start. This is the STABLE zone of the two-zone
// strategy: injected once, cache-friendly.
//
// Pure Node -- no jq, no curl needed. Configure through ~/.memgw/env.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const env = {};
try {
  for (const line of readFileSync(join(process.env.MEMGW_HOME || join(homedir(), ".memgw"), "env"), "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !line.startsWith("#")) env[line.slice(0, i)] = line.slice(i + 1);
  }
} catch {}
if (!env.MEMGW_URL || !env.MEMGW_KEY) process.exit(0);

let data = null;
try {
  const res = await fetch(`${env.MEMGW_URL}/bootstrap`, {
    signal: AbortSignal.timeout(4000),
    headers: { authorization: `Bearer ${env.MEMGW_KEY}` },
  });
  if (res.ok) data = await res.json();
} catch {}

// A dead gateway must be VISIBLE: a silent failure looks exactly like "the user
// has no memory", and nobody notices for days.
if (!data) {
  console.log(`<memgw-context>
Long-term memory is UNAVAILABLE: the memgw gateway did not respond, so neither
recall nor capture is working this session. Mention this to the user once, ask
them to run \`memgw doctor\`, and carry on without memory.
</memgw-context>`);
  process.exit(0);
}

const parts = ["<memgw-context>"];
if (data.profile) parts.push(`## Profile (from the memory store)\n${data.profile}`);
if (data.topics?.length) {
  parts.push(
    "## Topic notes available (read them with memory_read_note when needed)\n" +
      data.topics.map((t) => `- ${t.path} : ${t.summary}`).join("\n")
  );
}
parts.push(`## Memory tools\n${data.tools_guide}`, "</memgw-context>");
console.log(parts.join("\n"));
