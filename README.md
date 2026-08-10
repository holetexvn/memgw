<div align="center">

# 🧠 memgw

**Shared long-term memory for AI coding agents.**

One store that Claude Code, Codex CLI, opencode, and anything that speaks MCP
can all read from and write to. Your agents stop forgetting you every session.

[![CI](https://github.com/holetexvn/memgw/actions/workflows/ci.yml/badge.svg)](https://github.com/holetexvn/memgw/actions/workflows/ci.yml)
[![node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-8A2BE2)](#install)
[![LoCoMo](https://img.shields.io/badge/LoCoMo-66.4%25-orange)](docs/06-BENCHMARKS.md)
[![PersonaMem](https://img.shields.io/badge/PersonaMem--32k-59.6%25-orange)](docs/06-BENCHMARKS.md)

English · [Tiếng Việt](README_VI.md)

```bash
npm install -g @holetex/memgw && memgw setup
```

</div>

One command: it creates `~/.memgw`, generates keys, asks for your LLM key, wires up
Claude Code (hooks + MCP) and Codex (MCP) when they are on the machine, starts the
gateway, and ends with a health check. What it does NOT fully automate, it says out
loud: reboot supervision is installed automatically on macOS (launchd) and Linux
(systemd --user) from a permanent checkout (`npm i -g @holetex/memgw` or a clone), while
Windows / npx-cache runs get the exact Task Scheduler / install command printed
instead; opencode gets a one-line copy command. When Codex CLI is found, its
transcript watcher (Codex has no hooks) is installed supervised too on
macOS/Linux — elsewhere the exact `memgw watch --agent codex` command is printed.

Just want to try it without installing anything? `npx @holetex/memgw setup` works
too — same wizard, but running from the npx cache means no reboot supervision
(the wizard says so and prints the permanent-install command). Prefer doing
everything by hand? `memgw start` just starts the gateway and prints the commands.

Prefer delegating? Tell your agent: *"install memgw — follow
https://github.com/holetexvn/memgw/blob/main/AGENTS.md"*. [AGENTS.md](AGENTS.md) is a
playbook written for agents: non-interactive setup, what to ask you (the LLM key),
and how to verify the install.

---

## The problem

Every agent keeps its memory in its own silo. Claude Code on your laptop knows nothing
about the session you ran on your desktop. Codex knows nothing about either. Close the
terminal and the context is gone.

The expensive part of your day is not writing code, it is **re-explaining context**: what
this project is, which conventions apply, what not to touch, and what you already tried
last week that did not work.

memgw keeps that in one place. Every agent writes to it, every agent reads from it.

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-en-dark.svg">
  <img alt="memgw architecture: agents, gateway, store" src="docs/assets/architecture-en-light.svg">
</picture>

Three layers, each more distilled than the last:

| Layer | What | Written by | Lifetime |
|---|---|---|---|
| **events** | raw conversation turns | capture, no LLM involved | 90 days |
| **facts** | one-sentence atoms, deduplicated | worker, 2 LLM calls per batch | forever |
| **notes** | Markdown topic files in a git repo | worker, agentic loop | forever |

Capture is cheap and dumb on purpose: it writes raw turns and returns immediately, so it
never slows an agent down. Everything expensive happens later, in the background.

## A session with memgw

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/session-en-dark.svg">
  <img alt="a session with memgw" src="docs/assets/session-en-light.svg">
</picture>

Retrieval follows one rule that matters: **stable context is injected once at session
start** (profile, topic index) so it stays inside the prompt cache, while **specific
facts are exposed as tools** for the agent to call when it actually needs them. Injecting
search results on every turn breaks caching and floods the context with noise.

One fact type earns its keep more than the rest: `deadend`, meaning something you tried
that failed and why. Agents love repeating the same mistake; this is what stops them.

## Why not just… ?

| | Chat history | RAG over transcripts | **memgw** |
|---|---|---|---|
| Survives closing the terminal | ❌ | ✅ | ✅ |
| Shared across different agents | ❌ | ❌ per-tool | ✅ one store |
| Distilled (facts, not walls of text) | ❌ | ❌ raw chunks | ✅ one-sentence atoms |
| Remembers what **failed** and why | ❌ | ⚠️ buried | ✅ `deadend` type |
| Prompt-cache friendly | ❌ | ❌ injects every turn | ✅ inject once + tools |
| Human-auditable | ❌ | ❌ opaque index | ✅ `git log -p` on notes |
| Infrastructure needed | — | vector DB + pipeline | one SQLite file |

## Features

- 🔌 **Every MCP agent** — Claude Code, Codex CLI, opencode, claude.ai, Hermes, or any
  CLI via the generic transcript watcher. Five MCP tools, one endpoint.
- 🏠 **Local-first** — one process, one SQLite file, binds `127.0.0.1`. Deploy to a VPS
  with one installer when you want several machines sharing memory.
- 🔍 **Hybrid search** — FTS5/BM25 always works (no API, no cost); `memgw embed on` adds
  semantic vectors in the same SQLite file, RRF-fused, falling back to BM25 if the
  embeddings API is down.
- 🪦 **Dead-end memory** — `type=deadend` facts stop agents from retrying what already
  failed. The most valuable fact type, and the easiest for humans to forget to pass on.
- 📓 **Git-audited notes** — everything the model writes to Markdown is one
  `git log -p` away from inspection and one `git revert` away from undo.
- 🛡️ **Auth is never optional** — the server refuses to start without a key, and refuses
  weak keys off-loopback. There is no configuration in which memgw is an open store.
- 💸 **$1–3 / month** — cost tracks how much you talk to agents, not store size; every
  background worker runs off a cursor. Works with any OpenAI-compatible endpoint.
- 🌏 **English + Vietnamese prompts** — facts come out in the language you work in
  (`MEMGW_PROMPT_LANG=vi`). Adding a language is copying one block.

## Install

### Local

```bash
npx @holetex/memgw start              # zero config, binds 127.0.0.1
```

No LLM key yet? That is the default path, not a degraded one: capture keeps working,
events queue locally, and when you add a key later the backlog gets distilled — nothing
is lost. Add it whenever you are ready:

```bash
memgw key            # masked prompt; provider auto-detected from the key
```

OpenAI, Anthropic, Groq, and OpenRouter keys are recognised by their prefix and
configure the endpoint and a sensible cheap model automatically. Any other
OpenAI-compatible endpoint (DeepSeek, local Ollama or vLLM) works too — set
`MEMGW_LLM_BASE_URL` in `~/.memgw/env`. The key lives in that file on your machine
and is sent only to the provider you chose.

No key at all? `npx @holetex/memgw start --mock` exercises the entire pipeline without one.

### Server

For several machines sharing one store, or for web clients that need a public HTTPS URL:

```bash
bash scripts/build-installer.sh          # builds memgw-installer.run from this checkout
scp memgw-installer.run user@vps:/tmp/
ssh user@vps "sudo MEMGW_DOMAIN=memgw.example.com MEMGW_LLM_API_KEY=sk-xxx \
  bash /tmp/memgw-installer.run"
```

The installer handles Node, a dedicated user, systemd, Caddy with TLS, the firewall, and
an optional Litestream backup to S3-compatible storage. See
[docs/02-OPERATIONS.md](docs/02-OPERATIONS.md).

## Connect your agents

| Agent | Read | Write |
|---|---|---|
| **Claude Code** | MCP + `SessionStart` hook | `Stop` hook |
| **Codex CLI** | MCP | transcript watcher |
| **opencode** | MCP | native plugin |
| **claude.ai / web** | MCP connector | the agent calls `memory_save` |
| **Hermes** | `prefetch()` | `sync_turn()` |
| **anything else** | MCP, if it speaks it | `generic` watcher |

```bash
npx @holetex/memgw hooks                        # Claude Code capture + bootstrap
claude mcp add --transport http memgw http://127.0.0.1:8931/mcp \
  --header "Authorization: Bearer $MEMGW_KEY"

codex mcp add memgw --url http://127.0.0.1:8931/mcp/<MEMGW_MCP_SECRET>
npx @holetex/memgw watch --agent codex          # Codex has no hooks, so watch its transcripts
```

Full details for every client: [docs/03-INTEGRATION.md](docs/03-INTEGRATION.md) and
[docs/05-MULTI-AGENT.md](docs/05-MULTI-AGENT.md).

Adding an unsupported CLI usually needs no code at all:

```bash
npx @holetex/memgw watch --agent generic --dir ~/.some-cli/sessions --once --dry-run
```

## MCP tools

Five tools, available to every connected agent:

| Tool | Purpose |
|---|---|
| `memory_search` | search distilled facts, filterable by type and topic |
| `conversation_search` | search raw transcripts across all agents |
| `memory_read_note` | read a topic note or the profile |
| `memory_save` | save a fact |
| `memory_bootstrap` | profile plus the topic index |

## CLI

```
memgw start      Start the gateway
memgw init       Create config without starting
memgw status     Store statistics
memgw doctor     Diagnose configuration and connectivity
memgw search     Search facts from the terminal
memgw save       Save a fact from the terminal
memgw forget     Retire facts (dry-run by default)
memgw key        Set the LLM key later (provider auto-detected, gateway restarted)
memgw embed      Toggle semantic search on or off
memgw watch      Follow agent transcripts
memgw hooks      Install Claude Code hooks
```

## Design choices

**SQLite plus FTS5, no vector database.** Full-text search is the layer that always
works: no API dependency, no cost. Semantic search is one command away (`memgw embed on`)
and lives in the same SQLite file — vectors as BLOBs, fused with BM25, falling back to
BM25 whenever the embeddings API is down. Off by default.

**Notes are Markdown in a git repo.** Memory the model writes is memory you must be able
to inspect and correct. `git log -p` shows every change the worker made, and a bad edit is
one `git revert` away.

**Auth is never optional.** The server refuses to start without a key. Bind to anything
other than loopback and it also demands a strong one. There is no configuration in which
memgw is an open memory store.

**Best-effort by design.** Every call has a timeout, every failure is swallowed and
logged. A dead memory store must never take your agent down with it.

The reasoning behind each of these, including what was rejected and why, is in
[docs/01-ARCHITECTURE.md](docs/01-ARCHITECTURE.md).

## Measured recall

End-to-end on [LoCoMo](https://github.com/snap-research/locomo) (1,986 questions through
the real capture → extraction → dedup → search pipeline, LLM-judged):

| Retrieval | Overall | Refuses correctly when memory has no answer |
|---|---|---|
| BM25 (default) | 58.6% | 84.5% |
| + embeddings (`memgw embed on`) | **66.4%** | 80.3% |

On [PersonaMem](https://github.com/bowen-upenn/PersonaMem) (COLM 2025, 32k-token tier,
589 multiple-choice questions on user personalization): **59.6%** against a 25% random
baseline, end-to-end through the same pipeline.

Methodology, per-category numbers, and how to reproduce it for ~$4:
[docs/06-BENCHMARKS.md](docs/06-BENCHMARKS.md).

## Cost

Roughly 15 sessions a day across all agents, with a cheap model, comes to about
60 LLM calls and 0.5M tokens per day: **$1-3 a month**. Cost tracks how much you talk to
your agents, not how large the store grows, because every worker runs off a cursor.

## Documentation

| Document | Read it when |
|---|---|
| [01-ARCHITECTURE](docs/01-ARCHITECTURE.md) | you want to know how it works and why |
| [02-OPERATIONS](docs/02-OPERATIONS.md) | deploying, configuring, troubleshooting, backups |
| [03-INTEGRATION](docs/03-INTEGRATION.md) | connecting a specific client |
| [04-API](docs/04-API.md) | endpoint and MCP tool reference |
| [05-MULTI-AGENT](docs/05-MULTI-AGENT.md) | adding Codex, opencode, or your own CLI |
| [06-BENCHMARKS](docs/06-BENCHMARKS.md) | measured recall on LoCoMo, and how to rerun it |

## Prompt language

Extraction prompts ship in English and Vietnamese. The facts a model writes come out in
the prompt language, so pick the one you actually work in:

```bash
echo 'MEMGW_PROMPT_LANG=vi' >> ~/.memgw/env
```

Adding a language means copying one block in `src/prompts.js`. Contributions welcome.

## Development

```bash
git clone https://github.com/holetexvn/memgw.git
cd memgw && npm install
bash test/run-all.sh          # 11 suites, no API key needed; the runner prints totals
```

The suite includes `verify-docs.mjs`, which cross-checks this documentation against the
code: endpoints, tool names, and the constants quoted in prose. Change a default without
updating the docs and the suite goes red.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Prior art

The layered-distillation approach and several implementation details were informed by
reading [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
(MIT). memgw is a much smaller, single-user take on the same idea: no team management, no
ACL layer, no external infrastructure. `docs/01-ARCHITECTURE.md` has a section comparing
the two.

## License

MIT

---

<div align="center">

If memgw saves you from re-explaining your project one more time, ⭐ the repo —
it helps other people's agents find their memory too.

</div>
