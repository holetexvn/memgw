# memgw - multi-agent adapters

This directory holds everything needed to plug CLI agents other than Claude Code into memgw.

```
agents/
  watcher.mjs           # daemon that reads transcripts, for agents without hooks
  parsers/index.mjs     # one parser per transcript format
  opencode-plugin/      # native plugin for opencode
  configs/              # MCP configuration snippets per agent
```

## Principle: separate the read path from the write path

**The read path (recall) is already solved by MCP.** Every modern agent speaks MCP,
so a single MCP server serves all of them. Nothing extra to write for a new agent.

**The write path (capture) is where they differ.** Three levels, best first:

| Level | Mechanism | Accuracy | Use for |
|---|---|---|---|
| A | native hook/plugin | highest, knows exactly when a session ends | Claude Code, opencode |
| B | watcher reading transcripts | good, at most one scan interval of lag | Codex, any CLI that writes JSONL |
| C | agent calls `memory_save` itself | depends on the agent taking initiative | claude.ai, MCP-only agents |

See `docs/05-MULTI-AGENT.md` for the per-agent details.

## Adding a new agent

If the CLI writes a JSONL transcript, try `generic` first:

```bash
node agents/watcher.mjs --agent generic --dir ~/.some-cli/sessions \
  --source my-cli --once --dry-run
```

If the messages come out right, drop `--dry-run` and you are done, no code needed.

If they come out wrong or empty, write your own parser: add a function to `PARSERS` in
`agents/parsers/index.mjs`. The function takes one JSON record and returns
`{role, content, ts, sessionId}`, or `null` to skip it. About 15 lines.
