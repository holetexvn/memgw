# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/).

## [1.0.4] - 2026-08-10

### Fixed
- `memgw start` while a gateway is already running printed a raw EADDRINUSE
  stack trace; it now says "memgw is already running -- nothing to start" and
  exits 0 (pre-flight health check before binding). A port taken by something
  that is NOT memgw gets a one-line explanation instead of a crash dump.

### Added
- `setup` now installs the Codex transcript watcher as a supervised process
  (launchd `com.memgw.watch-codex` on macOS, systemd --user
  `memgw-watch-codex` on Linux) whenever Codex CLI is found and memgw runs
  from a permanent install -- Codex capture no longer needs a manual step.
  Windows / npx-cache runs still get the exact command printed.
- `memgw key`: add or replace the LLM key after setup with one command --
  masked prompt, provider auto-detected from the key prefix (OpenAI, Anthropic,
  Groq, OpenRouter -> endpoint and default model configured automatically), and
  the gateway is restarted so the key is live. Queued keyless events are
  distilled on the next worker pass.
- `memgw status` now shows per-agent last-seen times ("agents seen"), so
  "which agents are actually connected" has an answer; /stats by_source gained
  `last_ts`.

### Changed
- setup's key prompt explains that skipping is safe (events queue, nothing is
  lost) and that the key stays on the machine; README quick start now leads
  with the permanent install (`npm install -g`) and keeps npx as the try-it path.

## [1.0.3] - 2026-08-10

### Fixed
- `doctor` could report "gateway not running" while the gateway was healthy
  (stale keep-alive socket or a busy machine timing out the first probe when
  doctor runs inside `setup`). Both gateway checks now retry once before
  concluding anything.

## [1.0.2] - 2026-08-10

### Fixed
- The gateway that `setup` starts directly (when supervision is unavailable) now
  logs to `~/.memgw/gateway.log` instead of discarding output, and `doctor`
  prints the log tail when the gateway is down -- a silently dying gateway was
  undebuggable.

## [1.0.1] - 2026-08-10

### Fixed
- `memgw setup` crashed on Node versions where readline's internal
  `_writeToOutput` is missing (seen on v21.7): masked key input now falls back
  to visible input instead of dying.
- `setup` and `doctor` now warn on odd (non-LTS) Node versions, which have no
  better-sqlite3 prebuilds.

### Added
- `AGENTS.md`: an agent playbook for installing memgw on a user's machine and
  for working on the codebase (shipped in the npm package).

## [1.0.0] - 2026-08-10

First public release.

### Core
- `npx @holetex/memgw start`: local-first, zero-config startup. Creates `~/.memgw`, generates
  keys, binds to loopback. The server refuses to start without an auth key, and
  requires a strong key when bound beyond loopback.
- Three-layer store: raw events (90-day retention), distilled facts (forever),
  Markdown topic notes in a git repo (forever). Configuration is centralised in
  `src/config.js` with a documented precedence chain.
- CLI: `setup` (one-command wizard: config, supervision, wires every agent found
  on the machine), `start`, `init`, `status`, `doctor`, `search`, `save`,
  `forget`, `embed`, `watch`, `hooks`.
- Multi-agent capture. Native paths for Claude Code (hooks) and opencode (plugin),
  transcript watcher for Codex CLI and any other JSONL-writing CLI, plus a `generic`
  parser for unknown formats. `MEMGW_CAPTURE_IGNORE` excludes directories from
  capture (chiefly the memgw checkout itself).
- MCP server (Streamable HTTP, stateless) with five tools, reachable by header auth
  or by path secret for web clients that cannot send headers.

### Retrieval
- SQLite FTS5 with porter stemming and diacritic-insensitive matching.
- Optional semantic layer: hybrid BM25 + vector retrieval with reciprocal-rank
  fusion. Vectors are Float32 BLOBs in the same SQLite file — no vector database,
  no new dependencies. Toggle with `memgw embed on|off|status`; off by default,
  and search falls back to BM25 whenever the embeddings API is unavailable.
- Serve-time budget caps on `/bootstrap` (profile size, topic count).

### Extraction quality
- Prompts in English and Vietnamese (`MEMGW_PROMPT_LANG`). Relative time
  ("yesterday") is resolved to absolute dates; assistant recaps of already-stored
  facts are ignored; dedup defaults to "skip" for paraphrases and forbids lossy
  merges (guarded by effectiveness test T4b — a real-LLM suite run before each release, not part of the keyless CI).
- Reasoning models (gpt-5 family, o-series) supported: they receive
  `max_completion_tokens` and no explicit temperature.

### Benchmarks
- `scripts/bench-locomo.mjs` and `scripts/bench-personamem.mjs`: end-to-end recall
  benchmarks through the real pipeline, with resume logs. Measured results in
  `docs/06-BENCHMARKS.md`: LoCoMo 58.6% (BM25) / 66.4% (hybrid), PersonaMem 32k
  59.6%.

### Operations
- Retention with three safety rails: only processed events are eligible, the newest
  200 are always kept, and windows under 7 days are refused.
- Backups: Litestream to S3-compatible storage, and an optional git push of the
  notes directory.
- `deploy/com.memgw.plist` (macOS launchd) and `deploy/memgw.service` (systemd) keep
  the gateway alive; the bootstrap hook announces a dead gateway in the session
  context instead of failing silently.
- `test/verify-docs.mjs` fails the suite when documentation drifts from code.
