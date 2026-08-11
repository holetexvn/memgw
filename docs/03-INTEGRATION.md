# memgw - connecting clients

Four kinds of client, one mechanism each. Read only the section you need.

Two deployment shapes show up throughout this document:

- **local** (what `npx @holetex/memgw start` gives you): API `http://127.0.0.1:8930`,
  MCP `http://127.0.0.1:8931/mcp`
- **deployed behind a domain**: API `https://memgw.example.com`,
  MCP `https://memgw.example.com/mcp` (Caddy routes `/mcp*` to port 8931)

Replace `memgw.example.com` with your own domain. `<KEY>` is `MEMGW_KEY` and
`<SECRET>` is `MEMGW_MCP_SECRET`; read them from `~/.memgw/env` on a local install,
or from the installer output (`sudo cat /opt/memgw/.env`) on a server.

---

## Summary table

| Client | Write (capture) | Read (recall) | What to install |
|---|---|---|---|
| Claude Code | `Stop` hook | `SessionStart` hook + MCP | `npx @holetex/memgw hooks` |
| claude.ai / Cowork | agent calls `memory_save` | MCP connector | add a connector on the web |
| Hermes | `sync_turn()` | `prefetch()` | 1 Python file |
| n8n | HTTP Request node | HTTP Request node | nothing |

---

## 1. Claude Code (every machine)

Two directions: the hooks handle capture and session bootstrap, MCP handles lookups
mid-session.

### Option 1 - `npx @holetex/memgw hooks`

```bash
npx @holetex/memgw hooks
```

That one command:

- copies `capture.mjs` and `bootstrap.mjs` into `~/.memgw/` and makes them executable
- generates `MEMGW_KEY` and `MEMGW_MCP_SECRET` into `~/.memgw/env` if they are missing
- adds `MEMGW_URL=http://127.0.0.1:8930` and `MEMGW_SOURCE=claude-code-$HOSTNAME` to the
  same file (`claude-code-local` when `HOSTNAME` is not exported), without overwriting
  values that are already there
- prints the hooks block to paste into `~/.claude/settings.json`

To skip the paste step:

```bash
npx @holetex/memgw hooks --write
```

`--write` merges the block into `~/.claude/settings.json` in place, but only if that
file already exists. It replaces the `SessionStart` and `Stop` entries and leaves every
other hook type alone. If the file does not exist yet, the command falls back to
printing the block.

**Pointing at a remote server.** Write `MEMGW_URL` and the server's `MEMGW_KEY` into
`~/.memgw/env` *before* running `npx @holetex/memgw hooks`. The command never overwrites an
existing value, so it will keep your settings. Run it first and it generates a local
key instead, which will not match the server.

```bash
mkdir -p ~/.memgw
cat > ~/.memgw/env <<'EOF'
MEMGW_URL=https://memgw.example.com
MEMGW_KEY=<KEY>
MEMGW_SOURCE=cc-macbook
EOF
chmod 600 ~/.memgw/env
npx @holetex/memgw hooks
```

`MEMGW_SOURCE` must be **different on every machine** (`cc-macbook`, `cc-pc`, ...). It
has no effect on search, but it is what makes `/stats` tell you where a fact came from.

**Excluding directories from capture.** Set `MEMGW_CAPTURE_IGNORE` in `~/.memgw/env`
to a list of path prefixes (separated by `:` on macOS/Linux, `;` on Windows -- drive
letters make `:` unusable there); sessions whose working directory starts
with one of them are not captured. The main use is the memgw checkout itself:
transcripts of sessions that work ON the memory system quote its prompts and stored
facts, and feeding those back in poisons extraction.

```bash
MEMGW_CAPTURE_IGNORE=$HOME/code/memgw:$HOME/tmp
```

### Option 2 - manual

Same result, done by hand. Useful when you cannot run npm on the machine, or when you
want the scripts somewhere other than `~/.memgw`.

**Step 1 - copy the scripts**

```bash
mkdir -p ~/.memgw
scp user@vps:/opt/memgw/hooks/{capture.mjs,bootstrap.mjs} ~/.memgw/
```

Or take them from the `hooks/` directory in the source tree.

**Step 2 - config file**

```bash
cat > ~/.memgw/env <<'EOF'
MEMGW_URL=https://memgw.example.com
MEMGW_KEY=<KEY>
MEMGW_SOURCE=cc-macbook
EOF
chmod 600 ~/.memgw/env
```

**Step 3 - register the hooks**

Add this to `~/.claude/settings.json` (keep whatever is already there):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node $HOME/.memgw/bootstrap.mjs" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node $HOME/.memgw/capture.mjs" }] }
    ]
  }
}
```

### Connect MCP

Needed with either option; the hooks do not cover recall mid-session.

```bash
claude mcp add --scope user --transport http memgw http://127.0.0.1:8931/mcp \
  --header "Authorization: Bearer <KEY>"
```

Deployed behind a domain, the URL is `https://memgw.example.com/mcp` instead.

### Verify

```bash
# configuration, gateway and MCP reachability in one shot
npx @holetex/memgw doctor

# does the capture hook run
echo '{"transcript_path":"/dev/null","session_id":"test"}' | node ~/.memgw/capture.mjs && echo OK

# what does bootstrap return
node ~/.memgw/bootstrap.mjs
```

Then open Claude Code and type `/mcp` to check that `memgw` is in the list.

### No extra dependencies

Both hooks are plain Node scripts. If the machine can run Claude Code, it can run
the hooks — there is nothing else to install.

### How it works

**The `Stop` hook** runs every time Claude finishes a reply. It reads the transcript,
takes only what is new since last time (the cursor lives in `~/.memgw/cursors/<session>`),
strips tool calls and system reminders, then POSTs to the server with a 5 second timeout.

If the server is unreachable the payload lands in `~/.memgw/spool.jsonl` and the next
hook run flushes it. Shutting the machine down, losing the network, or restarting the
VPS therefore costs no data.

**The `SessionStart` hook** pulls `profile.md`, the topic list and the tool guidance,
and prints them to stdout so Claude Code loads them at the start of the session. It is
an index, not full content: the agent reads further with the tools when it needs to.
The call has a 4 second timeout and exits silently if the server does not answer, so a
dead gateway never blocks a session from starting.

---

## 2. claude.ai and Cowork

No hooks here, so the connection is an MCP connector.

**Settings -> Connectors -> Add custom connector**, paste the URL:

```
https://memgw.example.com/mcp/<SECRET>
```

The secret is in the URL because claude.ai cannot send custom headers. That is exactly
why it is a **separate token** from `MEMGW_KEY`: if it leaks, rotate only that one.

This path needs a public HTTPS URL. A loopback-only install (`npx @holetex/memgw start` with the
default bind) is not reachable from claude.ai.

### How to use it

Nothing writes automatically on this side, so capture is deliberate:

- "Remember this: we picked Postgres for the billing service" -> Claude calls `memory_save`
- "What did we settle on last week about memgw?" -> Claude calls `memory_search`
- Call `memory_bootstrap` at the start of a session to load who you are and what the
  store holds

For something closer to automatic, add this to the Project instructions:

> Call `memory_bootstrap` at the start of every session. When I settle a decision or
> hit a dead end worth remembering, call `memory_save` without being asked.

---

## 3. Hermes on a VPS

### Install

```bash
sudo cp /opt/memgw/hermes-plugin/memgw_hermes.py /path/to/hermes/plugins/
```

Env (on the same VPS, go straight to loopback and skip Caddy):

```bash
MEMGW_URL=http://127.0.0.1:8930
MEMGW_KEY=<KEY>
MEMGW_SOURCE=hermes
```

### Hook it into the lifecycle

```python
import memgw_hermes as m

# before calling the LLM
context = m.prefetch(user_query)      # returns a string, insert into the system prompt

# after the reply is ready
m.sync_turn(user_text, assistant_text, session_id=sid)   # fire-and-forget

# end of session
m.on_session_end(session_id=sid)      # force distillation now
```

### Self-test

```bash
MEMGW_URL=http://127.0.0.1:8930 MEMGW_KEY=<KEY> \
  python3 /opt/memgw/hermes-plugin/memgw_hermes.py
```

It prints the first 120 characters of the `prefetch` result and then `done`. An empty
prefetch line means the server is down or the key is wrong.

### Keeping Hermes alive

The plugin ships with two layers so that a dead memory store does not take Hermes down
with it:

- **Circuit breaker**: 5 consecutive failures, then 60 seconds of not trying
- **Back-pressure**: at most 4 concurrent writes, anything over that is dropped

A failed `prefetch` returns an empty string instead of raising. Default timeout is
5 seconds.

---

## 4. n8n

Nothing to install, use the HTTP Request node.

**Write:**

```
POST https://memgw.example.com/capture
Header: Authorization: Bearer <KEY>
Body:
{
  "source": "n8n",
  "session_id": "workflow-daily-brief",
  "messages": [
    { "role": "user", "content": "...", "ts": 1786200000000 }
  ]
}
```

**Read:**

```
GET https://memgw.example.com/search/facts?q=billing&limit=5
Header: Authorization: Bearer <KEY>
```

**Write a fact directly** (bypassing extraction):

```
POST https://memgw.example.com/facts
Body: { "content": "...", "type": "decision", "topic": "billing-service", "priority": 70 }
```

---

## 5. SDK / your own code

```javascript
const KEY = process.env.MEMGW_KEY;
const H = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

// write
await fetch("https://memgw.example.com/capture", {
  method: "POST", headers: H,
  body: JSON.stringify({
    source: "my-app", session_id: "s1",
    messages: [{ role: "user", content: "...", ts: Date.now() }],
  }),
});

// read
const r = await fetch(
  "https://memgw.example.com/search/facts?q=" + encodeURIComponent("memgw"),
  { headers: H }
).then((x) => x.json());
```

---

## 6. End-to-end check after wiring up

Run this against the gateway with `$KEY` filled in:

```bash
# 1. write something
curl -s -X POST localhost:8930/capture -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{
    "source":"test","session_id":"e2e-1",
    "messages":[{"role":"user","content":"Remember this: memgw is running on the VPS","ts":'$(date +%s000)'}]
  }'

# 2. force distillation now
curl -s -X POST localhost:8930/flush -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"session_id":"e2e-1"}'

# 3. find it again
curl -s "localhost:8930/search/facts?q=memgw" -H "Authorization: Bearer $KEY"

# 4. fold into notes + git commit
curl -s -X POST localhost:8930/flush-notes -H "Authorization: Bearer $KEY"
git -C ~/.memgw/data log --oneline | head -3
```

Step 3 returning a fact and step 4 returning a commit means the whole path works.

Steps 1 to 3 have CLI equivalents: `npx @holetex/memgw save "..."`, `npx @holetex/memgw search memgw`,
`npx @holetex/memgw status`. On a server install the data directory is `/opt/memgw/data` and git
runs as the service user: `sudo -u memgw git -C /opt/memgw/data log --oneline`.

---

## 7. Multiple machines, one store

Point them all at the same `MEMGW_URL` and the same `MEMGW_KEY`; only `MEMGW_SOURCE`
differs.

There is no conflict because:

- an event `id` is a deterministic hash, so sending the same turn twice inserts once
- each machine keeps its own cursor locally, and they never touch each other
- SQLite in WAL mode handles concurrent writes fine at this scale

Facts distilled on any machine land in the same store, so a question asked on the PC
still sees what was said on the MacBook.
