# Security

## Reporting a vulnerability

Please report privately through GitHub's ["Report a vulnerability"][advisory] flow rather
than a public issue. Include what you found, how to reproduce it, and what an attacker
could reach with it. You will get an initial response within a few days.

[advisory]: https://github.com/holetexvn/memgw/security/advisories/new

## What memgw stores

Your memory store contains your conversations with AI agents. In practice that means it
may hold project details, credentials you pasted into a session, customer names, and
anything else you typed. **Treat `~/.memgw` (or `/opt/memgw/data`) as sensitive**, at the
same level as your shell history or your `.env` files.

## Security model

**Authentication is mandatory.** The server refuses to start without `MEMGW_KEY`. There
is no configuration in which memgw runs as an open store. Every route except `/health`
requires a bearer token.

**Loopback by default.** The default bind is `127.0.0.1`. Binding anywhere else
additionally requires a key of at least 24 characters, checked at startup.

**Two independent tokens.** `MEMGW_KEY` is the API and MCP bearer token.
`MEMGW_MCP_SECRET` appears in a URL path, for web clients that cannot send custom
headers. They are separate so a leaked connector URL can be rotated on its own.

**Filesystem access is sandboxed.** The tools the model can call are restricted to the
data directory and to `.md` files. Paths are validated by allowlist, `..` is rejected,
and the resolved path is checked against the data directory prefix after normalisation.

**Prompt injection.** Memory content is data, not instructions. It is retrieved and
placed in context, and a malicious note could in principle try to influence an agent
that reads it. Since a single user writes and reads their own store, the practical risk
is low, but do not point memgw at content you do not trust.

## Deployment guidance

- Terminate TLS in front of memgw (the shipped Caddyfile does this).
- Do not expose ports 8930 and 8931 directly to the internet; keep them on loopback and
  reverse-proxy them.
- `~/.memgw/env` and `/opt/memgw/.env` are written with mode 600. Keep it that way.
- Rotate `MEMGW_KEY` by editing the env file and restarting; every client then needs the
  new value.
- Back up with Litestream or the git remote. Both destinations receive your memory
  contents, so use a private bucket and a private repository.

## Known limitations

- No rate limiting. Behind a proxy, add it there if the instance is reachable publicly.
- No encryption at rest. The SQLite file and the Markdown notes are plain. Use full-disk
  encryption if that matters to you.
- Auth is a single shared secret, not per-client credentials. Adequate for one user with
  a handful of machines, not a substitute for real multi-user auth.
