# memgw — instructions for AI agents

memgw is a shared long-term memory gateway for AI coding agents: one local store
(SQLite + git) that Claude Code, Codex CLI, opencode, and any MCP client read from
and write to. This file is for you, the agent, in two situations: installing memgw
on your user's machine, or working on this codebase.

## Installing memgw for your user

The wizard is non-interactive when stdin is not a TTY (or with `--yes`), so you can
run it directly:

```bash
npx @holetex/memgw setup --yes
```

What it does: creates `~/.memgw`, generates auth keys, starts the gateway on
`127.0.0.1:8930` (API) and `:8931` (MCP), installs Claude Code hooks + MCP and Codex
MCP when those clients exist, and installs reboot supervision (launchd on macOS,
systemd --user on Linux; on Windows it prints the Task Scheduler command — run it).

Rules for you:

1. **The LLM key is the user's decision.** Non-interactive setup skips the key, which
   leaves memgw in capture-only mode — a safe default, nothing is lost: events queue
   and get distilled retroactively once a key arrives. Tell the user this explicitly;
   do not pressure them for a key. When they provide one:
   ```bash
   npx @holetex/memgw key "<key>"     # provider auto-detected from the prefix
   ```
   (OpenAI, Anthropic, Groq, OpenRouter are recognised; the command also restarts the
   gateway so the key is live.) Never echo the key back, never commit it, never send
   it anywhere else.
2. **Verify, don't assume.** After setup:
   ```bash
   curl -sf http://127.0.0.1:8930/health     # {"ok":true,...}
   npx @holetex/memgw doctor                 # every line should be ok (llm warns until a key is set)
   ```
3. **Codex capture is a watcher process.** Codex has no hooks. From a permanent
   install on macOS/Linux, `setup` installs the watcher supervised automatically
   (launchd `com.memgw.watch-codex` / systemd `memgw-watch-codex`); on Windows or
   from the npx cache it prints the command — relay it to the user. Verify capture
   is really flowing with `memgw status` ("agents seen" must list a codex source
   after a Codex session).
4. **Do not edit files under `~/.memgw/data/` by hand** — that is the memory store.
   Use the CLI (`memgw save`, `memgw forget`) or the MCP tools.
5. Per-client connection commands (opencode, claude.ai, Hermes, generic CLIs) are in
   [docs/03-INTEGRATION.md](docs/03-INTEGRATION.md); the setup wizard prints the ones
   it could not do automatically — relay those to the user instead of dropping them.

Uninstall: [docs/02-OPERATIONS.md](docs/02-OPERATIONS.md) has the exact per-OS steps
(stop supervision first, then delete `~/.memgw`).

## Working on this codebase

- Run the full test suite before claiming anything works: `bash test/run-all.sh`
  (11 suites, needs no API key; a real gateway on this machine should be stopped
  first if it holds ports 8930/8931).
- `test/verify-docs.mjs` cross-checks docs against code — if you change an endpoint,
  tool name, or documented constant, update the docs in the same change.
- **No new runtime dependencies.** The dependency list (hono, @hono/node-server,
  MCP SDK, better-sqlite3, zod) is a deliberate design constraint; do not add a
  vector DB or an ORM.
- README diagrams are generated: edit `docs/assets/generate.mjs` and re-run
  `node docs/assets/generate.mjs` — never hand-edit the SVGs.
- Node >= 20, ESM only, SQLite via better-sqlite3 (synchronous by design).
- Security invariants that must survive any change: auth is mandatory on every data
  route; note reads/writes stay inside the data dir (`resolveWithin`) and notes are
  written only under `topics/`; the server refuses weak keys off-loopback.
