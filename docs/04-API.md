# memgw - API reference

HTTP API (port 8930) and MCP tools (port 8931). Both bind to `127.0.0.1` by default;
`MEMGW_BIND=0.0.0.0` exposes them, and that requires a `MEMGW_KEY` of at least 24
characters.

Every HTTP route except `/health` requires `Authorization: Bearer $MEMGW_KEY`.
A wrong or missing key gives `401 {"error":"unauthorized"}`.

---

## HTTP API

### `GET /health`

The only route without auth. Use it for monitoring and health checks.

```json
{ "ok": true, "ts": 1786205075106 }
```

---

### `POST /capture`

Write a batch of conversation turns into the events layer. Returns `202` immediately,
processing happens asynchronously.

```json
{
  "source": "cc-macbook",
  "session_id": "abc-123",
  "messages": [
    { "role": "user",      "content": "...", "ts": 1786200000000 },
    { "role": "assistant", "content": "...", "ts": 1786200001000 }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `source` | yes | free-form source identifier |
| `session_id` | yes | groups the turns of one session |
| `messages[].role` | yes | `user` or `assistant`, anything else is dropped |
| `messages[].content` | yes | truncated at 20,000 characters |
| `messages[].ts` | no | epoch ms, defaults to now |

Missing `source`, `session_id` or `messages[]` gives
`400 {"error":"source, session_id and messages[] are required"}`.

**Idempotent.** `id` = `sha1(session_id | ts | role | content[:200])`, so resending the
same payload creates no duplicate rows. Hooks can retry freely.

```json
{ "ok": true, "added": 2 }
```

`added` is the number of rows that were actually NEW.

---

### `GET /bootstrap`

Start-of-session context bundle. Used by the `SessionStart` hook.

```json
{
  "profile": "# Profile\n\nBackend developer, works mostly on...\n",
  "topics": [
    { "path": "topics/billing-service.md", "summary": "Billing service, Postgres, Stripe" }
  ],
  "tools_guide": "You have a long-term memory store (memgw):..."
}
```

`topics` carries only a path and a one-line summary, never full content; the agent
reads further when it needs to. `profile` is `null` when there is no `profile.md` yet.
Each summary is the first non-empty line of the note, stripped of leading `#` and cut
at 120 characters.

---

### `GET /search/facts`

Search the facts layer with BM25.

| Query param | Default | Notes |
|---|---|---|
| `q` | required | accented or unaccented, both work |
| `type` | | `preference` `decision` `instruction` `project` `deadend` `episode` |
| `topic` | | filter by topic slug |
| `limit` | 8 | capped at 30 |

```json
{
  "results": [
    {
      "id": "a1b2c3",
      "content": "Use SQLite + FTS5 for memgw, not Postgres",
      "type": "decision",
      "topic": "memgw",
      "priority": 70,
      "version": 1,
      "status": "active",
      "score": 0.87,
      "created_at": 1786200000000,
      "updated_at": 1786200000000
    }
  ]
}
```

Only facts with `status='active'` are returned. `score` is BM25 normalised into 0-1.
A query with no usable tokens (everything is one character or punctuation) returns an
empty list rather than an error.

---

### `GET /search/events`

Search the raw log. Use it when you need the exact wording and facts are not detailed
enough.

| Query param | Default |
|---|---|
| `q` | required |
| `session` | |
| `limit` | 10, capped at 50 |

```json
{
  "results": [
    { "id": "...", "source": "cc-macbook", "session_id": "abc",
      "role": "user", "content": "...", "ts": 1786200000000, "score": 0.72 }
  ]
}
```

---

### `GET /notes/:path`

Read one file inside `data/`.

```
GET /notes/profile.md
GET /notes/topics/billing-service.md
```

Path traversal is blocked: character whitelist, `..` rejected, prefix re-checked after
normalisation.

```json
{ "path": "topics/billing-service.md", "content": "# Billing service\n..." }
```

`400 {"error":"bad path"}` for a malformed path, `404 {"error":"not found"}` when the
file does not exist.

---

### `POST /facts`

Write a fact directly, bypassing extraction. This is the "just remember this" path.

```json
{
  "content": "Tried deploying with Deno, failed because better-sqlite3 would not build",
  "type": "deadend",
  "topic": "memgw",
  "priority": 75
}
```

`content` and `type` are required; missing either gives
`400 {"error":"content and type are required"}`. `priority` defaults to 50.

```json
{ "ok": true, "id": "d4e5f6" }
```

Note: a hand-written fact **does not go through dedup**. Write the same thing twice and
the store holds two copies.

---

### `POST /facts/forget`

Retire facts matching a query, without touching SQL. Dry-run by default: the
first call returns the matches and changes nothing; repeat with `"confirm": true`
to supersede them. Superseded facts leave search results but stay in the
database for audit.

```json
{ "query": "port 3002", "type": "decision", "limit": 10, "confirm": false }
```

`query` is required; `type` and `limit` (default 10, max 30) are optional.

```json
{ "dry_run": true, "matches": [ { "id": "d4e5f6", "type": "decision", "content": "..." } ] }
```

With `"confirm": true` the response is `{ "forgotten": 2, "matches": [...] }`.
CLI equivalent: `memgw forget "port 3002" --yes`.

---

### `POST /flush`

Force the extraction worker to run now, ignoring the 10 minute idle requirement.

```json
{ "session_id": "abc-123" }
```

Leave `session_id` out to process every session that is waiting.

```json
{
  "sessions": 1, "events_in": 6,
  "facts_new": 2, "facts_merged": 1,
  "tokens_in": 3200, "tokens_out": 420,
  "error": null
}
```

Runs synchronously and can take several seconds because it calls the LLM. A per-session
failure lands in `error` and leaves those events unprocessed for the next run.

---

### `POST /flush-notes`

Force the notes updater to run now. This also refreshes the profile.

```json
{ "updated": true, "facts": 8, "steps": 3, "committed": true,
  "tokensIn": 5100, "tokensOut": 890 }
```

No new facts:

```json
{ "updated": false, "reason": "no new facts" }
```

---

### `POST /retention`

Clean up old events.

| Field | Default | Notes |
|---|---|---|
| `days` | `MEMGW_RETENTION_DAYS` (90) | 0 = disabled |
| `dry_run` | false | count only, delete nothing |
| `allow_aggressive` | false | permits `days < 7` |

```json
{ "deleted": 1240, "cutoff": 1778429075106, "kept_min": 200 }
```

Dry run:

```json
{ "dryRun": true, "would_delete": 1240, "cutoff": 1778429075106 }
```

Refused:

```json
{ "skipped": true, "reason": "days=3 is below the 7 day floor; pass allowAggressive" }
```

Disabled:

```json
{ "skipped": true, "reason": "retention disabled (days=0)" }
```

Three safety rails that cannot be turned off: only events with `processed=1` are
deleted, the newest 200 events are always kept, and `days < 7` is refused without
`allow_aggressive`.

---

### `GET /stats`

```json
{
  "counts": {
    "events": 1523, "events_pending": 12, "events_oldest": 1778429075106,
    "facts_active": 87, "facts_superseded": 14
  },
  "by_source": [
    { "source": "cc-macbook", "n": 890 },
    { "source": "hermes", "n": 412 }
  ],
  "by_type": [
    { "type": "preference", "n": 31 },
    { "type": "deadend", "n": 12 }
  ],
  "recent_runs": [
    { "id": 42, "ran_at": 1786205000000, "sessions": 2, "events_in": 18,
      "facts_new": 3, "facts_merged": 1, "tokens_in": 4100, "tokens_out": 520,
      "error": null }
  ]
}
```

`recent_runs` holds the last 20 worker runs, newest first. `npx memgw status` prints a
condensed version of this response.

---

## MCP Server

Streamable HTTP, **stateless** (every POST is independent, no server-side session).
`GET` returns `405 {"error":"method not allowed"}` per spec. A body that is not valid
JSON gives `400 {"error":"invalid json"}`, and an unhandled error gives
`500 {"error":"internal"}`.

### Two auth paths

| Method | URL | Used by |
|---|---|---|
| Bearer header | `POST /mcp` + `Authorization: Bearer <KEY>` | Claude Code, Codex, opencode |
| Path secret | `POST /mcp/<MEMGW_MCP_SECRET>` | claude.ai (cannot send headers) |

Neither one matching gives `401`.

---

### `memory_search`

Search distilled facts.

```json
{
  "query": "string, required",
  "type": "preference | decision | instruction | project | deadend | episode",
  "topic": "string",
  "limit": "number 1-30, default 8"
}
```

Returns text, one fact per line:

```
[decision/memgw] (p70) Use SQLite + FTS5, not Postgres
[deadend/memgw] (p75) Tried Deno, failed because better-sqlite3 would not build
```

No hits returns `No matching facts.`

---

### `conversation_search`

Search the raw log across every source.

```json
{ "query": "required", "session_id": "string", "limit": "1-50, default 10" }
```

```
[cc-macbook 2026-08-08T14:30 user] Content...
---
[hermes 2026-08-07T09:12 assistant] Content...
```

Each hit is truncated at 400 characters. No hits returns
`No matching conversation found.`

---

### `memory_read_note`

Read a topic note or `profile.md`.

```json
{ "path": "topics/billing-service.md" }
```

Returns the raw Markdown. A malformed path returns `Invalid path.`, and a path that
does not resolve to an existing file returns `No such file: <path>.`

---

### `memory_save`

Write a new fact.

```json
{
  "content": "ONE self-contained sentence",
  "type": "decision",
  "topic": "memgw",
  "priority": 70
}
```

`priority` defaults to 60, higher than the HTTP `/facts` default because here the user
asked for it explicitly.

```
Saved fact d4e5f6: [decision] Use SQLite + FTS5
```

---

### `memory_bootstrap`

Profile plus the topic list. Call once at the start of a session.

```json
{}
```

```
## Profile
# Profile

Backend developer, works mostly on...

## Topic notes
- topics/memgw.md : Central memory system
- topics/billing-service.md : Billing service, Postgres, Stripe
```

With no `profile.md` the profile block reads `(no profile.md yet)`, and with no notes
the topic list reads `(none yet)`.

Claude Code is already bootstrapped through the hook and does not need this tool. It
exists mainly for claude.ai, where there are no hooks.

---

## Status codes

| Code | Meaning |
|---|---|
| 200 | OK |
| 202 | Accepted, processed asynchronously (`/capture`) |
| 400 | Bad body or a required field is missing |
| 401 | Missing or wrong Bearer key / path secret |
| 404 | No such file (`/notes/...`) |
| 405 | Wrong method (GET against `/mcp`) |
| 500 | Internal error, check `journalctl -u memgw` |
