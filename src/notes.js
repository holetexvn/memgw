// Notes updater: an agentic loop that folds new facts into Markdown topic notes.
//
// The model gets read/write tools, but they are hard-sandboxed to the data
// directory and to .md files -- it never sees the database, the env file, or the
// rest of the filesystem.
//
// Every run ends in a git commit inside data/, so `git log -p` shows exactly what
// the model changed and a bad edit can be reverted.
import { chatWithTools, llmReady } from "./llm.js";
import { NOTES_SYSTEM, PROFILE_SYSTEM } from "./prompts.js";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, lstatSync, realpathSync, chmodSync } from "node:fs";
import { join, normalize, dirname, sep } from "node:path";

const MAX_TOPIC_FILES = 20;
const MAX_TOPIC_CHARS = 2500;

/**
 * Resolve a relative path strictly inside baseDir, or return null.
 * A lexical prefix check is not enough: a symlink placed under baseDir can point
 * anywhere, so the deepest EXISTING part of the path is resolved with realpath
 * and must still land inside baseDir. (A not-yet-existing suffix cannot contain
 * a symlink, so checking the existing ancestor covers writes to new files too.)
 */
export function resolveWithin(baseDir, rel) {
  if (typeof rel !== "string" || rel.includes("..") || !/^[a-zA-Z0-9_\-/.]+$/.test(rel)) return null;
  let base;
  try {
    base = realpathSync(baseDir);
  } catch {
    return null;
  }
  const full = normalize(join(base, rel));
  if (full !== base && !full.startsWith(base + sep)) return null;
  let probe = full;
  while (!existsSync(probe)) probe = dirname(probe);
  try {
    const real = realpathSync(probe);
    if (real !== base && !real.startsWith(base + sep)) return null;
  } catch {
    return null;
  }
  return full;
}

// --- sandbox: every path must resolve inside dataDir, and be a .md file ---
function safePath(dataDir, rel) {
  if (typeof rel !== "string" || !rel.endsWith(".md")) throw new Error("only .md files are allowed");
  const full = resolveWithin(dataDir, rel);
  if (!full) throw new Error(`path escapes the sandbox: ${rel}`);
  return full;
}

function listTopicFiles(dataDir) {
  const dir = join(dataDir, "topics");
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d, prefix) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue; // never follow symlinks out of data/
      if (st.isDirectory()) walk(full, `${prefix}${name}/`);
      else if (name.endsWith(".md")) out.push(`topics/${prefix}${name}`);
    }
  };
  walk(dir, "");
  return out;
}

// All git commands pass identity and safe.directory inline with -c, so we never
// depend on persistent git config and never hit "dubious ownership" when the
// directory belongs to a different uid than the process.
function git(dataDir, args) {
  return execFileSync(
    "git",
    ["-c", `safe.directory=${dataDir}`, "-c", "user.email=memgw@localhost", "-c", "user.name=memgw", ...args],
    { cwd: dataDir, timeout: 30_000 } // a wedged git must not stall the notes worker forever
  );
}

// The data directory also holds the SQLite database with RAW transcripts. This
// nested repo is ALLOWLIST-only: track Markdown and nothing else, so a database
// under any name (custom MEMGW_DB_PATH, logs, metadata) can never be committed
// -- committing it would silently defeat retention and, with MEMGW_GIT_REMOTE
// set, push private conversations to a remote. Only notes belong in git.
const GIT_IGNORE_RULES = "*\n!*/\n!*.md\n!.gitignore\n";

// Marker proving the nested repo was created BY memgw. Without it we refuse to
// touch git at all: a MEMGW_DATA_DIR mistakenly pointed at someone's existing
// repository must never get mass-untracked, committed over, or pushed.
const MANAGED_MARKER = ".memgw-managed";
function gitManaged(dataDir) {
  return existsSync(join(dataDir, ".git", MANAGED_MARKER));
}

function gitEnsure(dataDir) {
  const fresh = !existsSync(join(dataDir, ".git"));
  if (fresh) {
    git(dataDir, ["init", "-q"]);
    writeFileSync(join(dataDir, ".git", MANAGED_MARKER), "created by memgw\n");
  } else if (!gitManaged(dataDir)) {
    console.error(`[notes] ${dataDir} contains a git repo memgw did not create -- leaving git alone (notes are still written)`);
    return;
  }
  const gi = join(dataDir, ".gitignore");
  if (!existsSync(gi) || readFileSync(gi, "utf8") !== GIT_IGNORE_RULES) {
    writeFileSync(gi, GIT_IGNORE_RULES);
    if (!fresh) {
      // rules changed under an existing repo: untrack EVERYTHING once; the next
      // `git add -A` re-adds only what the allowlist permits (past history is
      // the user's to rewrite; `git log` in data/ shows whether that matters)
      try {
        git(dataDir, ["rm", "-r", "--cached", "-q", "--ignore-unmatch", "."]);
      } catch {}
    }
  }
}

function gitCommit(dataDir, msg) {
  if (!gitManaged(dataDir)) return false; // never operate on a repo that is not ours
  try {
    git(dataDir, ["add", "-A"]);
    const status = git(dataDir, ["status", "--porcelain"]).toString().trim();
    if (!status) return false;
    git(dataDir, ["commit", "-q", "-m", msg]);
    gitPush(dataDir);
    return true;
  } catch (e) {
    console.error("[notes] git commit failed:", redactUrlToken(e.message));
    return false;
  }
}

// error messages from git can echo the remote URL, which may embed a token
const redactUrlToken = (s) => String(s).replace(/\/\/[^@/\s]+@/g, "//***@");

// Optional second backup path, independent of Litestream: push data/ to a private
// repo. MEMGW_GIT_REMOTE looks like https://<token>@github.com/you/memgw-data.git
// A failed push is logged and ignored -- it must never break the local commit.
function gitPush(dataDir) {
  const remote = process.env.MEMGW_GIT_REMOTE;
  if (!remote) return;
  try {
    const remotes = git(dataDir, ["remote"]).toString();
    if (!remotes.includes("origin")) git(dataDir, ["remote", "add", "origin", remote]);
    else git(dataDir, ["remote", "set-url", "origin", remote]);
    // the remote URL may carry a token; keep .git/config as private as the env file
    try { chmodSync(join(dataDir, ".git", "config"), 0o600); } catch {}
    const branch = git(dataDir, ["rev-parse", "--abbrev-ref", "HEAD"]).toString().trim() || "master";
    execFileSync("git", ["-c", `safe.directory=${dataDir}`, "push", "-q", "origin", branch], {
      cwd: dataDir,
      timeout: 30_000,
    });
  } catch (e) {
    console.error("[notes] git push failed (ignored):", redactUrlToken(e.message).slice(0, 200));
  }
}


export async function runNotesUpdate(db, dataDir, { force = false } = {}) {
  if (!llmReady()) return { facts: 0, writes: 0, skipped: "llm off" }; // extraction off on purpose
  mkdirSync(join(dataDir, "topics"), { recursive: true });
  gitEnsure(dataDir);

  // Only load facts NEW since the previous notes run. The cursor is a stable
  // (updated_at, id) pair: a plain timestamp cursor with LIMIT would skip any
  // facts beyond the limit that share the boundary timestamp forever.
  const cursorFile = join(dataDir, ".metadata", "notes_cursor");
  let cTs = 0, cId = "";
  if (existsSync(cursorFile)) {
    const raw = readFileSync(cursorFile, "utf8").trim();
    const m = raw.match(/^(\d+)(?::(.*))?$/); // old format was a bare timestamp
    if (m) { cTs = Number(m[1]) || 0; cId = m[2] || ""; }
  }
  const facts = db
    .prepare(
      `SELECT * FROM facts WHERE status='active' AND (updated_at > ? OR (updated_at = ? AND id > ?))
       ORDER BY updated_at ASC, id ASC LIMIT 60`
    )
    .all(cTs, cTs, cId);
  if (!facts.length && !force) return { updated: false, reason: "no new facts" };

  const factList = facts.map((f) => `- [${f.type}${f.topic ? "/" + f.topic : ""}] ${f.content}`).join("\n");
  const existing = listTopicFiles(dataDir);
  const user =
    `NEW FACTS (${facts.length}):\n${factList}\n\n` +
    `EXISTING TOPIC FILES (${existing.length}/${MAX_TOPIC_FILES}):\n${existing.join("\n") || "(none yet)"}\n\n` +
    `Fold these facts into the appropriate topic notes.`;

  let writes = 0; // real disk writes only -- reads and refused calls do not count
  const tools = [
    {
      name: "list_notes",
      description: "List existing topic notes",
      parameters: { type: "object", properties: {} },
      handler: () => listTopicFiles(dataDir).join("\n") || "(no files yet)",
    },
    {
      name: "read_note",
      description: "Read the contents of a note",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      handler: ({ path }) => {
        const f = safePath(dataDir, path);
        return existsSync(f) ? readFileSync(f, "utf8") : "(file does not exist yet)";
      },
    },
    {
      name: "write_note",
      description: "Overwrite a note in full (creates it if missing).",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      handler: ({ path, content }) => {
        // topics/ ONLY: profile.md is injected into every future session, so it
        // is written exclusively by the profile refresh -- a hostile instruction
        // smuggled through captured content must not be able to persist itself
        // into the most privileged injection point.
        if (!path.startsWith("topics/")) return "refused: notes may only write under topics/";
        const f = safePath(dataDir, path);
        if (!existsSync(f) && listTopicFiles(dataDir).length >= MAX_TOPIC_FILES)
          return `refused: at the ${MAX_TOPIC_FILES} file limit, merge two notes first`;
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, String(content).slice(0, MAX_TOPIC_CHARS + 500));
        writes++; // counted only AFTER a write actually landed on disk
        return `wrote ${path} (${content.length} chars)`;
      },
    },
    // No delete tool on purpose: captured conversations can contain hostile text
    // that ends up inside fact content, and an injected "delete everything" must
    // have nothing destructive to reach for. Merging at the file cap is done by
    // overwriting (an emptied file is equivalent and reversible via git).
  ];

  const res = await chatWithTools(NOTES_SYSTEM(MAX_TOPIC_FILES, MAX_TOPIC_CHARS), user, tools, { maxSteps: 12 });

  // Advance the cursor only when the model actually wrote something (or there was
  // nothing to fold). A run that returned without a single edit must be retried,
  // not silently marked done -- otherwise those facts never reach the notes.
  const last = facts[facts.length - 1];
  if ((writes > 0 || facts.length === 0) && last) {
    mkdirSync(join(dataDir, ".metadata"), { recursive: true });
    writeFileSync(cursorFile, `${last.updated_at}:${last.id}`);
  }

  const committed = gitCommit(dataDir, `notes: +${facts.length} facts (${res.steps} edits)`);

  // Refresh the profile roughly every 50 facts since the last refresh.
  const profileCursorFile = join(dataDir, ".metadata", "profile_cursor");
  const pCursor = existsSync(profileCursorFile) ? Number(readFileSync(profileCursorFile, "utf8")) || 0 : 0;
  const sinceProfile = db.prepare(`SELECT COUNT(*) n FROM facts WHERE status='active' AND updated_at > ?`).get(pCursor).n;
  if (force || sinceProfile >= 50) {
    await runProfileRefresh(db, dataDir);
    writeFileSync(profileCursorFile, String(last ? last.updated_at : Date.now()));
  }

  return { updated: true, facts: facts.length, steps: res.steps, committed, tokensIn: res.tokensIn, tokensOut: res.tokensOut };
}

// Rewrite profile.md from the highest-priority durable facts.

async function runProfileRefresh(db, dataDir) {
  const top = db
    .prepare(
      `SELECT content, type FROM facts WHERE status='active' AND type IN ('preference','instruction','decision','project')
       ORDER BY priority DESC, updated_at DESC LIMIT 40`
    )
    .all();
  if (!top.length) return;
  const { chat } = await import("./llm.js");
  const user = `Highest-priority facts:\n${top.map((f) => `- [${f.type}] ${f.content}`).join("\n")}\n\nWrite profile.md.`;
  // Reasoning models spend completion budget on hidden reasoning first; 1000
  // tokens can come back as empty content. Size is capped by the slice below anyway.
  const r = await chat(PROFILE_SYSTEM(), user, { maxTokens: 4000 });
  let text = (r.text || "").trim();
  // Models wrap output in a code fence despite the prompt; profile.md must be plain markdown.
  text = text.replace(/^```[a-z]*\s*\n/i, "").replace(/\n```\s*$/, "").trim();
  if (!text) return;
  writeFileSync(join(dataDir, "profile.md"), text.slice(0, 3000));
  gitCommit(dataDir, "profile: refresh");
}
