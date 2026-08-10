# memgw - multi-agent support

Connect Claude Code, Codex CLI, opencode, Hermes and any other CLI to the same memory
store.

URLs below use the local defaults: API `http://127.0.0.1:8930`, MCP
`http://127.0.0.1:8931/mcp`. On a deployed instance behind a domain, use
`https://memgw.example.com` and `https://memgw.example.com/mcp` instead.

---

## 1. Why this works

memgw knows nothing about agents. It has exactly two surfaces:

- **HTTP API** - anything that can make an HTTP call can read and write
- **MCP server** - any agent that speaks MCP can query it

The `source` field on an event is a free-form string, not an enum. Adding a fifth agent
needs no schema change and no migration.

The only thing that differs between agents is **how you get the conversation out of them**.

## 2. Support matrix

| Agent | Read (recall) | Write (capture) | What to install |
|---|---|---|---|
| **Claude Code** | MCP + bootstrap hook | `Stop` hook | `npx @holetex/memgw hooks` |
| **Codex CLI** | MCP | watcher reads the rollout files | 1 config block + watcher |
| **opencode** | MCP | `session.idle` plugin | 1 plugin file + config |
| **Hermes** | `prefetch()` | `sync_turn()` | 1 Python file |
| **claude.ai / Cowork** | MCP connector | agent calls `memory_save` | add a connector |
| **any other CLI** | MCP if it has it | `generic` watcher | try `--dry-run` first |

## 3. Three levels of capture

Recall is already solved by MCP for everyone. Capture has three levels, in order of
preference:

**Level A - native hook or plugin.** The most accurate, because the agent tells you
exactly when the session ends, so you can push immediately and ask for distillation in
the same breath. Use it whenever the agent has a real extension mechanism.

**Level B - watcher reading transcripts.** Every CLI writes a transcript to disk. The
watcher scans the directory, parses the JSONL and pushes what is new. Worst-case delay
is one scan interval (60 seconds by default). This is the universal path: any CLI that
is not supported yet can be tried immediately.

**Level C - the agent calls `memory_save` itself.** For cases where there is neither a
hook nor a readable transcript (claude.ai). It depends on the agent taking initiative,
so compensate with a line in the project instructions.

## 4. Codex CLI

### Read - MCP

Use the path-secret URL — one command, no header, no environment variable
(read `MEMGW_MCP_SECRET` from `~/.memgw/env`; `memgw start` also prints the
ready-made command):

```bash
codex mcp add memgw --url http://127.0.0.1:8931/mcp/<MEMGW_MCP_SECRET>
```

Prefer header auth instead? Add it by hand to `~/.codex/config.toml` and export
`MEMGW_KEY` in your shell profile:

```toml
[mcp_servers.memgw]
url = "http://127.0.0.1:8931/mcp"
bearer_token_env_var = "MEMGW_KEY"
```

Both are equivalent on loopback. The path secret is the low-friction default;
the header keeps the credential out of URLs, which matters more once the
gateway sits behind a domain with proxies that log request paths.

### Write - watcher

Codex stores transcripts in `~/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl`.

Check what the parser produces before turning it on:

```bash
npx @holetex/memgw watch --agent codex --once --dry-run
```

If it looks right, run it in the background:

```bash
npx @holetex/memgw watch --agent codex --interval 60
```

`npx @holetex/memgw watch` is a wrapper around `agents/watcher.mjs` and passes every flag
straight through, so `node agents/watcher.mjs --agent codex --interval 60` is
equivalent and is what you want when running from a checkout or a service unit. With no
`--agent` flag, `npx @holetex/memgw watch` defaults to `--agent claude-code`.

The parser skips `tool_call`, `tool_result`, `reasoning`, `token_count`, `event_msg` and
`state` records, plus anything without a `user` or `assistant` role, keeping only real
messages.

### Bootstrapping context

Codex has no `SessionStart` hook. Two options:

1. Add this to the project's `AGENTS.md`:

   > At the start of a session, call the memgw `memory_bootstrap` tool to load the user
   > profile and the topic list. Before trying a new approach, call `memory_search` with
   > `type=deadend` to check whether it has already failed.

2. Or let the agent call it when it sees fit; the tool descriptions are explicit enough
   about when that is.

## 5. opencode

### Read - MCP

`~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "memgw": {
      "type": "remote",
      "url": "http://127.0.0.1:8931/mcp",
      "enabled": true,
      "headers": { "Authorization": "Bearer <MEMGW_KEY>" }
    }
  }
}
```

### Write - native plugin

opencode has a full plugin system with `session.idle`, `message.updated` and
`tool.execute.after` events. Prefer it over the watcher.

```bash
mkdir -p ~/.config/opencode/plugins
cp agents/opencode-plugin/memgw.js ~/.config/opencode/plugins/
```

The plugin reads `~/.memgw/env` itself and needs no further configuration.

How it works: it buffers messages per session id (keyed by message id in a Map, so
repeated streaming updates do not duplicate anything), and on `session.idle` it pushes
to `/capture` and then calls `/flush` to ask for distillation right away. It has a
circuit breaker: 5 failures, then 60 seconds off.

## 6. Unsupported CLIs

Try the `generic` parser first, it is usually enough:

```bash
npx @holetex/memgw watch --agent generic --dir ~/.some-cli/sessions \
  --source my-cli --once --dry-run
```

`generic` accepts any JSONL that has a `role` plus one of `content` / `text` /
`message.content` / `parts`.

If the output is empty or wrong, write your own parser in `agents/parsers/index.mjs`:

```javascript
function myCli(rec, fallbackTs) {
  if (rec.kind !== "chat") return null;              // skip non-conversation records
  const text = textOf(rec.body);                      // helper already provided
  if (isNoise(text)) return null;                     // skip noise
  return {
    role: rec.who === "human" ? "user" : "assistant",
    content: text,
    ts: tsOf(rec.at, fallbackTs),
    sessionId: rec.convo_id ?? null,
  };
}

export const PARSERS = { ..., "my-cli": myCli };
```

Add a fixture at `test/fixtures/my-cli.jsonl` and a few lines of test in
`test/parsers-test.mjs` and you are done.

## 7. Running the watcher in the background

One process can follow several agents:

```bash
npx @holetex/memgw watch --agent codex --agent claude-code --interval 60
```

| Flag | Meaning |
|---|---|
| `--agent <name>` | repeatable |
| `--dir <path>` | override the default directory |
| `--source <name>` | override the source name (default `<agent>-<hostname>`) |
| `--dry-run` | print only, send nothing, **never touches the cursor** |
| `--once` | one pass then exit, for cron |
| `--interval <seconds>` | scan interval, default 60 |
| `--max-age-days <n>` | ignore files older than n days, default 7 |

For a service, use `agents/configs/memgw-watch.service` (Linux) or
`com.memgw.watcher.plist` (macOS). Both call the watcher script with `node` directly
rather than through npx, since a service unit should not depend on package resolution at
boot; edit the paths in them to match your install.

Cursors live in `~/.memgw/watch-state/cursors.json`, one entry per file, so a restart
does not resend. The server is idempotent as well, which makes two independent layers of
protection.

## 8. Naming sources

The default is `<agent>-<hostname>`: `codex-macbook`, `claude-code-pc`, `opencode-vps`.

`GET /stats` then tells you where each fact came from:

```json
"by_source": [
  { "source": "claude-code-macbook", "n": 890 },
  { "source": "codex-macbook", "n": 210 },
  { "source": "opencode-vps", "n": 156 },
  { "source": "hermes", "n": 412 }
]
```

`npx @holetex/memgw status` prints the same breakdown. Facts distilled from any source land in
the same store, so something said in Codex is still there when you ask again in
Claude Code.

## 9. A warning about schema stability

The transcript formats of these CLIs are **internal, with no stability guarantee**.
Codex and opencode changing their structure between minor releases is normal.

Three layers of defence:

1. **Tolerant parsers** - several fallbacks for role and content; a record that does not
   match is skipped rather than throwing and killing the watcher.
2. **Fixture-backed tests** - `test/parsers-test.mjs` runs against fixtures for all four
   formats, including junk input. When a CLI changes its schema, update the fixture and
   fix the parser, roughly 15 minutes of work.
3. **`--dry-run` never touches the cursor** - re-check any time without losing data.

The signal that a parser needs attention: `by_source` for that agent stops growing even
though you are still using it.

## 10. Verifying an integration

```bash
# 1. does it parse correctly
npx @holetex/memgw watch --agent codex --once --dry-run

# 2. send for real
npx @holetex/memgw watch --agent codex --once

# 3. is the new source visible
npx @holetex/memgw status
curl -s $MEMGW_URL/stats -H "Authorization: Bearer $MEMGW_KEY" | jq '.by_source'

# 4. is MCP working (use the command of the agent in question)
codex mcp list
```
