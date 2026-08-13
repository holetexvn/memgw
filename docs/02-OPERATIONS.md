# memgw - Operations

Running memgw locally, deploying it as a server, configuring it, monitoring it,
troubleshooting it, and backing it up.

---

## 1. Local mode

This is the default and the fastest way in. No domain, no VPS, no config file to write.

### Requirements

- Node >= 20
- git (optional; without it you lose notes history and the git backup path)

### Start it

```bash
npx @holetex/memgw start
```

On the first run this creates `~/.memgw`, generates `MEMGW_KEY` and `MEMGW_MCP_SECRET` into
`~/.memgw/env` (mode 600), creates `~/.memgw/data`, binds `127.0.0.1`, and prints the exact
commands for connecting your agents.

Nothing is exposed to the network: the API listens on `127.0.0.1:8930` and the MCP server on
`127.0.0.1:8931`.

### Add an LLM key

Capture works without one, but events only queue up; no facts are extracted until a key is
present.

```bash
echo 'MEMGW_LLM_API_KEY=sk-...' >> ~/.memgw/env
```

To try the full pipeline with no key at all, start with `--mock`. Extraction is stubbed but
capture, notes, git commits and retention all run for real.

### CLI

```bash
npx @holetex/memgw <command> [options]
```

| Command | What it does |
|---|---|
| `setup` | One-command wizard: config, LLM key, supervision, connect every agent found |
| `start` | Start the gateway; generates config on first run |
| `init` | Create the config and print connection instructions without starting |
| `status` | Show store statistics from a running gateway |
| `doctor` | Diagnose configuration and connectivity |
| `search <query>` | Search facts from the command line |
| `save <text>` | Save a fact from the command line |
| `forget <query>` | Retire matching facts (dry-run; add `--yes` to apply) |
| `key [api-key]` | Set the LLM key later: masked prompt, provider auto-detected from the key prefix (OpenAI / Anthropic / Groq / OpenRouter), gateway restarted to load it |
| `key off` | Turn extraction off: removes the key, stops all LLM calls. Capture keeps running and events queue until a key comes back |
| `embed on\|off\|status` | Toggle the optional semantic search layer (see below) |
| `watch` | Watch agent transcripts and capture them (see `--agent`) |
| `hooks` | Install Claude Code hooks into `~/.claude/settings.json` |
| `help` | Usage summary |

| Option | Default |
|---|---|
| `--port <n>` | 8930, the HTTP API port |
| `--bind <addr>` | 127.0.0.1; use `0.0.0.0` to expose |
| `--data <dir>` | `~/.memgw/data` |
| `--mock` | Run without an LLM key |

Examples:

```bash
npx @holetex/memgw start --bind 0.0.0.0          # server mode, needs a strong key
npx @holetex/memgw watch --agent codex           # capture Codex CLI sessions
npx @holetex/memgw search "database choice"
npx @holetex/memgw save "chose Postgres for billing" --type decision
npx @holetex/memgw doctor                        # run this first whenever something looks wrong
```

### Connect your agents

```bash
# Claude Code: capture + session bootstrap, then the MCP tools
npx @holetex/memgw hooks
claude mcp add --scope user --transport http memgw http://127.0.0.1:8931/mcp \
  --header "Authorization: Bearer <MEMGW_KEY>"

# Codex CLI (no hooks, so use the watcher)
codex mcp add memgw --url http://127.0.0.1:8931/mcp/<MEMGW_MCP_SECRET>
npx @holetex/memgw watch --agent codex
```

`memgw hooks` copies `capture.mjs` and `bootstrap.mjs` into `~/.memgw`, adds `MEMGW_URL` and
`MEMGW_SOURCE` to `~/.memgw/env`, and prints the JSON block to paste into
`~/.claude/settings.json`. Re-run it with `--write` to merge that block automatically into an
existing settings file.

Details for each client are in `03-INTEGRATION.md` and `05-MULTI-AGENT.md`.

### Keep it running (macOS launchd)

A memory gateway that is not running fails in the worst possible way: sessions
silently start with no memory. On macOS, let launchd start the gateway at login
and restart it when it dies:

```bash
# edit the template first: replace NODE_PATH, REPO_DIR and HOME_PATH
cp deploy/com.memgw.plist ~/Library/LaunchAgents/com.memgw.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.memgw.plist
```

After that, `kill` is no longer how you restart it (launchd resurrects it — use
this to your advantage after editing `~/.memgw/env`):

```bash
launchctl kickstart -k gui/$UID/com.memgw   # restart, e.g. to reload config
launchctl bootout gui/$UID/com.memgw        # actually stop it
tail -f ~/.memgw/gateway.log                # watch the log
```

On Linux, use `deploy/memgw.service` with systemd instead. The bootstrap hook
also announces a dead gateway inside the session context, so an agent will tell
you instead of quietly knowing nothing.

### What local mode cannot do

Web clients such as claude.ai need a public HTTPS URL, so they cannot reach a loopback
gateway. If you want claude.ai in the same store, or you want several machines writing to one
gateway, go to server mode.

## 2. Server mode

### Requirements

- Ubuntu or Debian VPS; 1GB RAM is enough
- sudo access
- (Optional) a subdomain pointed at the VPS, for HTTPS

The installer pulls in Node 22 and git if they are missing.

### DNS first

Create an A record pointing at the VPS IP, for example `memgw.example.com`.

> **Important with Cloudflare:** leave it on **DNS only (grey cloud)**, do not enable the
> proxy (orange cloud). Caddy needs to fetch its own Let's Encrypt certificate, and the proxy
> breaks the ACME challenge.

### Run the installer

```bash
bash scripts/build-installer.sh          # builds memgw-installer.run from this checkout
scp memgw-installer.run user@vps:/tmp/

ssh user@vps "sudo \
  MEMGW_DOMAIN=memgw.example.com \
  MEMGW_LLM_API_KEY=sk-xxx \
  bash /tmp/memgw-installer.run"
```

The installer runs in order: Node 22 → git → a `memgw` user → unpack the code → npm install →
generate `.env` with two random keys → systemd → a three-stage health check → Caddy, TLS and
firewall → print the client connection details.

It takes 1 to 3 minutes. If a step fails it names that step and tells you where to look.

### Enable R2 backup from the start (recommended)

```bash
ssh user@vps "sudo \
  MEMGW_DOMAIN=memgw.example.com \
  MEMGW_LLM_API_KEY=sk-xxx \
  R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
  R2_BUCKET=memgw-backup \
  R2_ACCESS_KEY_ID=xxx \
  R2_SECRET_ACCESS_KEY=xxx \
  bash /tmp/memgw-installer.run"
```

### Without a domain

Drop `MEMGW_DOMAIN`. The gateway then stays bound to **loopback on the VPS**; reach it from
each client through an SSH tunnel (the installer prints the exact command):

```bash
ssh -N -L 8930:127.0.0.1:8930 -L 8931:127.0.0.1:8931 user@vps
```

To expose it on a trusted private network instead, set `MEMGW_BIND=0.0.0.0` in
`/opt/memgw/.env` and restart — the strong-key requirement applies. The **claude.ai
connector requires HTTPS**, so a domain is mandatory for that path. Adding the domain later
is the same install command again.

### Without the installer

The installer is one option, not the only one. The CLI is the same server, so on any host with
Node you can run:

```bash
MEMGW_BIND=0.0.0.0 MEMGW_KEY=$(openssl rand -hex 24) npx @holetex/memgw start
```

and terminate TLS with whatever reverse proxy you already run. Binding beyond loopback is
refused unless `MEMGW_KEY` is at least 24 characters, so set it explicitly.

### After installing

```bash
# write the first profile (the worker refreshes it after ~50 facts)
sudo -u memgw nano /opt/memgw/data/profile.md
sudo systemctl restart memgw
```

Useful content for `profile.md`: who you are, what you work on, which projects are active, and
the conventions you want every agent to follow. Keep it short, under 250 words.

## 3. Upgrading

```bash
bash scripts/build-installer.sh          # builds memgw-installer.run from this checkout
scp memgw-installer.run user@vps:/tmp/
ssh user@vps "sudo bash /tmp/memgw-installer.run"
```

Idempotent: it **keeps `.env` and all of `data/`** and only overwrites the code and re-runs
npm install. Environment variables do not need to be passed again, unless you are turning
something new on such as Litestream.

In local mode there is nothing to upgrade: `npx @holetex/memgw@latest start` picks up the new version
and `~/.memgw` is untouched.

## 4. Configuration reference

Precedence, highest first:

1. `process.env`
2. `~/.memgw/env` (created on first run)
3. built-in defaults

In server mode the installer writes `/opt/memgw/.env`, which systemd loads as an
`EnvironmentFile`, so those values arrive as `process.env`. After editing it, run
`sudo systemctl restart memgw`.

### Required

| Variable | Meaning |
|---|---|
| `MEMGW_KEY` | Bearer key for the HTTP API and MCP. Generated automatically by `memgw start` and by the installer. Without one the server refuses to start |
| `MEMGW_LLM_API_KEY` | Key for the extraction worker. Empty means capture still works but no facts are produced |

### Paths

| Variable | Default |
|---|---|
| `MEMGW_HOME` | `~/.memgw`, holds the env file and the hook scripts |
| `MEMGW_DATA_DIR` | `$MEMGW_HOME/data` |
| `MEMGW_DB_PATH` | `$MEMGW_HOME/data/memgw.db` |

### Network

| Variable | Default | Note |
|---|---|---|
| `MEMGW_BIND` | `127.0.0.1` | Anything wider requires a key of at least 24 characters |
| `MEMGW_PORT` | 8930 | HTTP API |
| `MEMGW_MCP_PORT` | 8931 | MCP server |
| `MEMGW_MCP_SECRET` | generated | Token for web MCP clients, carried in the URL |

### LLM for the worker

| Variable | Default |
|---|---|
| `MEMGW_LLM_BASE_URL` | `https://api.openai.com/v1` |
| `MEMGW_LLM_MODEL` | `gpt-4o-mini` |
| `MEMGW_PROMPT_LANG` | `en`; set `vi` for Vietnamese extraction prompts |

Any OpenAI-compatible endpoint works: OpenAI, DeepSeek, Groq, Together, OpenRouter, Gemini
through a compatibility layer, or a local Ollama/vLLM server
(`http://127.0.0.1:11434/v1`).

**Use a cheap model.** The worker runs in the background all day and does not need a frontier
model.

`MEMGW_PROMPT_LANG` decides the language the extractor writes facts in, and those facts are
what gets injected back into your agents later. Set it to the language you actually work in.

> The installer writes explicit `MEMGW_LLM_BASE_URL` and `MEMGW_LLM_MODEL` lines into
> `/opt/memgw/.env`, falling back to the same built-in defaults above
> (`https://api.openai.com/v1` and `gpt-4o-mini`). Pass both variables on the install
> command, or edit `.env` afterwards, to pick your provider.

### Embeddings (optional)

| Variable | Default | Note |
|---|---|---|
| `MEMGW_EMBED_MODEL` | (empty) | e.g. `text-embedding-3-small`; empty keeps search BM25-only |
| `MEMGW_EMBED_DIM` | 512 | vector size; smaller = less storage, slightly less recall |

Uses the same `MEMGW_LLM_BASE_URL` / `MEMGW_LLM_API_KEY`. Vectors are backfilled
in the background and search falls back to BM25 whenever the embeddings API is
unavailable. Measured effect: [06-BENCHMARKS](06-BENCHMARKS.md).

The easy way to toggle it:

```bash
memgw embed on          # writes MEMGW_EMBED_MODEL, then restart the gateway
memgw embed status      # config vs running gateway, and vector coverage
memgw embed off         # back to pure BM25; stored vectors are kept
```

### Worker cadence

| Variable | Default | Note |
|---|---|---|
| `MEMGW_WORKER_INTERVAL_MS` | 900000 (15 min) | extraction |
| `MEMGW_NOTES_INTERVAL_MS` | 21600000 (6 hours) | notes updater, the expensive layer |
| `MEMGW_RETENTION_DAYS` | 90 | 0 disables retention |

### Backup

| Variable | Note |
|---|---|
| `MEMGW_GIT_REMOTE` | `https://<token>@github.com/user/memgw-data.git` |
| `R2_ENDPOINT` / `R2_BUCKET` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Litestream, all four required |

### Testing only

| Variable | Note |
|---|---|
| `MEMGW_LLM_MOCK=1` | Stub the LLM, run the whole pipeline with no key |
| `MEMGW_NO_SERVICE=1` | Tell the installer not to use systemd |

## 5. Day-to-day commands

Local mode:

```bash
npx @holetex/memgw status        # event and fact counters, breakdown by source and type
npx @holetex/memgw doctor        # config, bind, LLM, data dir, gateway and MCP reachability
npx @holetex/memgw search "postgres" --type decision
npx @holetex/memgw save "the staging DB resets every Sunday" --type project --topic infra
```

Server mode:

```bash
# state
sudo systemctl status memgw
curl -s localhost:8930/health

# logs
sudo journalctl -u memgw -f
sudo journalctl -u memgw --since "1 hour ago" | grep -E "worker|notes|retention"

# statistics (event/fact counts, breakdown by source and type, last 20 worker runs)
KEY=$(sudo grep '^MEMGW_KEY=' /opt/memgw/.env | cut -d= -f2)
curl -s localhost:8930/stats -H "Authorization: Bearer $KEY" | python3 -m json.tool

# force a run now instead of waiting for the timer
curl -s -X POST localhost:8930/flush       -H "Authorization: Bearer $KEY"
curl -s -X POST localhost:8930/flush-notes -H "Authorization: Bearer $KEY"

# see what memory changed
sudo -u memgw git -C /opt/memgw/data log --oneline
sudo -u memgw git -C /opt/memgw/data log -p -1
```

## 6. Watching health

Three numbers in `/stats` are worth looking at:

**`events_pending` climbing and never falling** means the worker cannot run. Check the logs;
the usual cause is a wrong `MEMGW_LLM_API_KEY` or an account out of credit.

**`facts_active` flat despite active conversations** means extraction runs but finds nothing.
Either the conversations genuinely hold nothing worth remembering, which is normal, or the
prompt is too strict for the kind of content you work on.

**`facts_superseded` growing faster than `facts_active`** means dedup is too aggressive and is
merging things that should stay separate. Use `git log -p` inside the data directory to see
what it did.

## 7. Troubleshooting

Start with `npx @holetex/memgw doctor`. It checks the Node version, the config file, the key, the bind
address, the LLM settings, the prompt language, the data directory, whether the gateway and
the MCP server answer, and whether git is available.

### The server will not start

```bash
sudo journalctl -u memgw -n 50
```

| Log message | Cause | Fix |
|---|---|---|
| `MEMGW_KEY is not set` | No key in the environment or the env file | Run `memgw start`, which generates one, or set it yourself |
| `MEMGW_BIND=... exposes memgw beyond localhost` | Non-loopback bind with a key under 24 characters | `openssl rand -hex 24` and set `MEMGW_KEY` |
| `EADDRINUSE :8930` | Port already taken | `sudo ss -tlnp \| grep 8930`, then change `MEMGW_PORT` or kill the other process |
| `Cannot find module` | npm install did not complete | `cd /opt/memgw && sudo -u memgw npm install --omit=dev` |

### The hook is not writing

Run it by hand to see the error:

```bash
echo '{"transcript_path":"/dev/null","session_id":"test"}' | node ~/.memgw/capture.mjs
```

| Symptom | Cause |
|---|---|
| `jq: command not found` | Install jq: macOS `brew install jq`, Windows `winget install jqlang.jq` |
| Silent, but the server sees nothing | Check `~/.memgw/spool.jsonl`; content there means the server could not be reached |
| 401 | `MEMGW_KEY` in `~/.memgw/env` does not match the one on the server |

The spool is flushed on the next hook run, so nothing is lost.

### No facts are being produced

In order:

1. Is `events_pending > 0`? If it is 0 the problem is in capture, not the worker.
2. Has the session been idle for ten minutes? To test immediately, call `POST /flush`.
3. Is `MEMGW_LLM_API_KEY` correct? The log will show `LLM 401` or `LLM 402`.
4. Is the model returning valid JSON? A weak model returns markdown fences or prose instead.
   The parser has two layers of tolerance but cannot rescue a model that is too weak. Switch
   to a better one.

### The notes are not updating

```bash
curl -s -X POST localhost:8930/flush-notes -H "Authorization: Bearer $KEY"
```

- `{"updated":false,"reason":"no new facts"}` is correct; there is nothing to fold in yet.
- A git error means a permission problem: `ls -la /opt/memgw/data/.git` must be owned by the
  `memgw` user.
- `refused: at the 20 file limit, merge two notes first` means the model has to merge first.
  It normally does this on its own; if it gets stuck, merge a couple of files by hand and run
  it again.

### git push fails

A failed push is logged and ignored, and **never breaks the local commit**. Check:

```bash
sudo -u memgw git -C /opt/memgw/data remote -v
sudo -u memgw git -C /opt/memgw/data push origin master
```

Usually the token in `MEMGW_GIT_REMOTE` has expired or is missing the `repo` scope.

### The claude.ai connector will not connect

1. Is it HTTPS? claude.ai does not accept plain HTTP.
2. Is the Cloudflare proxy (orange cloud) on? Switch it back to DNS only.
3. Test by hand:

```bash
curl -X POST https://memgw.example.com/mcp/<SECRET> \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

It must return the list of 5 tools. A 401 means the secret in the URL is wrong.

## 8. Backup and restore

Two independent paths; turn both on.

### Litestream → R2 (for SQLite)

Streams the WAL continuously. Losing the VPS costs you the last few seconds rather than the
last few hours, and the database is never locked while running.

```bash
sudo systemctl status litestream
sudo journalctl -u litestream -n 30
```

Restore:

```bash
sudo systemctl stop memgw
sudo -u memgw mv /opt/memgw/data/memgw.db /opt/memgw/data/memgw.db.bak
sudo -u memgw litestream restore -config /etc/litestream.yml /opt/memgw/data/memgw.db
sudo systemctl start memgw
```

### git → private repo (for the notes)

`profile.md` and `topics/` are the densest layer, and losing them hurts more than losing
events. Set `MEMGW_GIT_REMOTE` and the notes updater pushes after every commit.

Restoring is a `git clone` back into place.

### Quick manual backup

Server mode:

```bash
sudo tar czf ~/memgw-backup-$(date +%F).tar.gz -C /opt/memgw data .env
```

Local mode:

```bash
tar czf ~/memgw-backup-$(date +%F).tar.gz -C ~ .memgw
```

Both archives contain keys, so treat them accordingly.

## 9. Retention

By default events older than 90 days are deleted; facts and notes are kept forever.

```bash
# preview, deletes nothing
curl -s -X POST localhost:8930/retention -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"dry_run":true}'

# run now
curl -s -X POST localhost:8930/retention -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{}'

# turn it off
# set MEMGW_RETENTION_DAYS=0 in the env file, then restart
```

Three safety rails that cannot be switched off: only processed events are deleted, the newest
200 events are always kept, and `days < 7` is refused unless you pass
`allow_aggressive: true`.

## 10. Uninstall

Server mode:

```bash
sudo systemctl disable --now memgw litestream
sudo rm -f /etc/systemd/system/memgw.service /etc/litestream.yml
sudo systemctl daemon-reload
sudo tar czf ~/memgw-final-backup.tar.gz -C /opt/memgw data   # keep a copy first
sudo rm -rf /opt/memgw
sudo userdel memgw
# remember to remove the domain block from /etc/caddy/Caddyfile and reload caddy
```

Local mode — the supervision job must go FIRST, or it will resurrect the gateway
and recreate `~/.memgw` behind you:

```bash
# macOS: remove the launchd jobs installed by `memgw setup` (gateway + Codex watcher)
launchctl bootout gui/$UID/com.memgw 2>/dev/null
launchctl bootout gui/$UID/com.memgw.watch-codex 2>/dev/null
rm -f ~/Library/LaunchAgents/com.memgw.plist ~/Library/LaunchAgents/com.memgw.watch-codex.plist

# Windows: remove the Task Scheduler entries if you created them
#   schtasks /Delete /TN memgw /F
#   schtasks /Delete /TN memgw-watch-codex /F

# Linux: remove the systemd --user units installed by `memgw setup`
#   systemctl --user disable --now memgw memgw-watch-codex
#   rm -f ~/.config/systemd/user/memgw.service ~/.config/systemd/user/memgw-watch-codex.service

# then stop anything left and delete the store
kill $(lsof -ti tcp:8930) 2>/dev/null
tar czf ~/memgw-final-backup.tar.gz -C ~ .memgw   # keep a copy first
rm -rf ~/.memgw

# disconnect the agents
claude mcp remove memgw
codex mcp remove memgw 2>/dev/null
# remove the SessionStart/Stop hook block from ~/.claude/settings.json
# and, if you ran the Codex watcher as a service, unload its plist/unit too
```

## 11. Running from a source checkout

For development, or to read the code while it runs. No VPS and no LLM key needed:

```bash
npm install
MEMGW_KEY=test MEMGW_LLM_MOCK=1 node src/server.js
```

In another terminal:

```bash
bash test/run-all.sh     # 11 suites, starts its own server and cleans up after itself
```

`node src/server.js` and `npx @holetex/memgw start` boot the same server. The CLI additionally
generates missing keys, creates `~/.memgw`, and prints the connection instructions.
