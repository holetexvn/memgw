# Contributing

Thanks for taking a look. memgw is deliberately small, and the goal is to keep it that
way: one process, one SQLite file, one directory of Markdown.

## Getting set up

```bash
git clone https://github.com/holetexvn/memgw.git
cd memgw && npm install
bash test/run-all.sh
```

The suite needs no API key. It runs in mock mode, boots a real server on a temporary
data directory, and cleans up after itself. Everything must be green before you open a
pull request.

Run a development instance against a scratch store so you never touch your real memory:

```bash
MEMGW_HOME=/tmp/memgw-dev MEMGW_LLM_MOCK=1 node bin/memgw.mjs start
```

## What is likely to be accepted

- **A parser for another agent CLI.** This is the most useful contribution and the
  easiest to review. See below.
- **Prompt translations.** Copy one block in `src/prompts.js` and register the language.
- **Bug fixes with a test that fails before the fix.**
- **Documentation corrections**, especially where the docs and the code disagree.

## What is likely to be declined

- A vector database, an embedding pipeline, or a second storage backend. Full-text
  search is sufficient at personal-store scale, and each of those adds a dependency, a
  cost, and a failure mode.
- Multi-tenancy, teams, roles, ACLs. memgw is single-user by design. If you need those,
  you need a different tool.
- Any change that makes auth optional.
- A web UI. `memgw status` and the notes directory cover the need.

Open an issue before writing something large, so nobody wastes an afternoon.

## Adding an agent parser

Most CLIs write JSONL transcripts, so try the generic parser first:

```bash
node agents/watcher.mjs --agent generic --dir ~/.your-cli/sessions --once --dry-run
```

If that produces the right messages, no code is needed. If not, add a function to
`PARSERS` in `agents/parsers/index.mjs`:

```javascript
function myCli(rec, fallbackTs) {
  if (rec.kind !== "chat") return null;   // skip non-conversation records
  const text = textOf(rec.body);          // helper handles strings and block arrays
  if (isNoise(text)) return null;         // helper drops harness noise
  return {
    role: rec.who === "human" ? "user" : "assistant",
    content: text,
    ts: tsOf(rec.at, fallbackTs),
    sessionId: rec.convo_id ?? null,
  };
}
```

Then add `test/fixtures/my-cli.jsonl` with a realistic sample, including at least one
record your parser must skip, and a few assertions in `test/parsers-test.mjs`.

Parsers must be **tolerant**. These transcript formats are internal to each tool and
change without notice. Never throw on an unexpected record; return `null` and let the
watcher continue.

## Code style

- Plain JavaScript, ES modules, no build step and no transpiler.
- Comments explain **why**, not what. If a line looks odd, the comment should say what
  went wrong that made it necessary.
- No new runtime dependencies without a good reason. There are currently five.
- Write for someone reading the file cold, in a language they may not share with you:
  English only in code and docs.

## Tests

Every suite lives in `test/` and is wired into `test/run-all.sh`. Add yours there too.

`test/verify-docs.mjs` cross-checks the documentation against the code: endpoints, MCP
tool names, and the constants quoted in prose. If you change a default, update the docs
in the same commit or CI will tell you.

## Security

Please do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Commits and releases

Commits on main follow [Conventional Commits](https://www.conventionalcommits.org):
`fix:` (patch), `feat:` (minor), `feat!:` or a `BREAKING CHANGE:` footer (major);
`chore:`/`docs:`/`test:` never trigger a release.

Releasing is fully automated by [release-please](https://github.com/googleapis/release-please):
the bot keeps a running **"release vX.Y.Z" PR** on main with the version bump and
the generated CHANGELOG section. **Merging that PR is the release** — it tags,
creates the GitHub release, runs the full test suite, and publishes to npm via
trusted publishing (OIDC, provenance — no tokens anywhere).

Two quality gates still run by hand when relevant, because CI is keyless by
design: `bash scripts/test-effectiveness.sh` against a scratch `MEMGW_HOME` with
a real LLM key (T2 signal-vs-noise and T4b recap immunity must pass), and — if
the installer changed — `bash scripts/build-installer.sh` smoked on a throwaway VM.

Emergency manual path: `npm publish` from a checkout of the tag still works.

## Known follow-ups (good first issues)

Reviewed and deliberately deferred from v1.0 — accepted trade-offs, not oversights:

- **IPv6 loopback**: `::1` passes the loopback check but generated URLs do not
  bracket the literal, so CLI calls fail under `MEMGW_BIND=::1`. Bracket the host
  in `bin/memgw.mjs` and `src/config.js`.
- **Capture-ignore path matching** is lexical `startsWith`: symlinked or
  `..`-aliased paths can bypass an ignored root. Normalise with `realpath` before
  comparing.
- **Server installer rollback**: the installer now stops the service before
  replacing code, but a failed `npm ci` still requires re-running the installer;
  a keep-last-version rollback would remove that manual step.
- **Docs verifier breadth**: `test/verify-docs.mjs` checks a fixed list of
  constants and does not detect new undocumented HTTP routes.
