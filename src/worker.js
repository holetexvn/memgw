// Extraction worker: events (processed=0) -> facts, with dedup.
// Exactly two LLM calls per batch: one extract, one dedup. No agentic loop here,
// which keeps this layer cheap and predictable.
import { chat, parseJsonArray, llmReady } from "./llm.js";
import { EXTRACT_SYSTEM, extractUser, DEDUP_SYSTEM, dedupUser } from "./prompts.js";
import { searchFacts, insertFact, supersedeFact } from "./db.js";

const BATCH = 20;
const IDLE_MS = 10 * 60 * 1000; // a session must be idle this long before we distil it
const VALID_TYPES = new Set(["preference", "decision", "instruction", "project", "deadend", "episode"]);

export async function runWorker(db, { force = false, session = null } = {}) {
  // Extraction off (no key, not mock): return quietly. Firing doomed requests
  // every interval would only fill worker_runs with 401s and hide real errors.
  if (!llmReady())
    return { sessions: 0, events_in: 0, facts_new: 0, facts_merged: 0, tokens_in: 0, tokens_out: 0, error: null, skipped: "llm off" };

  // force must cover clock-skewed events too (capture tolerates ts up to +5 min):
  // "flushed" has to mean flushed, not "flushed except the skewed tail"
  const idleBefore = force ? Date.now() + 600_000 : Date.now() - IDLE_MS;
  // Group by (source, session_id): two agents may reuse a generic session id
  // ("main", "default"), and their conversations must never be distilled as one.
  const sessions = db
    .prepare(
      `SELECT source, session_id, MAX(ts) AS last_ts, COUNT(*) AS n
       FROM events WHERE processed = 0 ${session ? "AND session_id = ?" : ""}
       GROUP BY source, session_id HAVING last_ts < ?`
    )
    .all(...(session ? [session, idleBefore] : [idleBefore]));

  const stats = { sessions: 0, events_in: 0, facts_new: 0, facts_merged: 0, tokens_in: 0, tokens_out: 0 };
  let error = null;

  for (const s of sessions) {
    try {
      let counted = false;
      // Drain the WHOLE session, batch by batch: "flushed" must mean flushed,
      // not "processed the first 20 events and reported success".
      for (;;) {
      const events = db
        .prepare(`SELECT * FROM events WHERE source = ? AND session_id = ? AND processed = 0 ORDER BY ts ASC LIMIT ?`)
        .all(s.source, s.session_id, BATCH);
      if (!events.length) break;
      if (!counted) { stats.sessions++; counted = true; }
      stats.events_in += events.length;

      // 1. Extract facts from the transcript
      const ex = await chat(EXTRACT_SYSTEM(), extractUser(events));
      stats.tokens_in += ex.tokensIn;
      stats.tokens_out += ex.tokensOut;
      let facts = (parseJsonArray(ex.text) || [])
        .filter((f) => typeof f?.content === "string" && f.content.trim() && VALID_TYPES.has(f.type))
        .map((f) => ({ ...f, content: f.content.slice(0, 20_000) })) // malformed/oversized output must not wedge the batch
        .slice(0, 15)
        .map((f) => ({ ...f, priority: clamp(f.priority, 0, 100), source_ids: events.map((e) => e.id) }));

      if (facts.length) {
        // 2. Recall similar existing facts with BM25 (no LLM cost)
        const candidates = facts.map((f) => searchFacts(db, f.content, { limit: 5 }));
        const hasAny = candidates.some((c) => c.length);

        // 3. Dedup -- skipped entirely when nothing similar was recalled
        let decisions = facts.map((_, i) => ({ index: i, action: "store" }));
        if (hasAny) {
          const dd = await chat(DEDUP_SYSTEM(), dedupUser(facts, candidates));
          stats.tokens_in += dd.tokensIn;
          stats.tokens_out += dd.tokensOut;
          const parsed = parseJsonArray(dd.text);
          if (parsed) {
            // A truncated or malformed model reply must never LOSE facts: any
            // fact the reply does not cover with a valid action is stored.
            const byIndex = new Map();
            for (const d of parsed) {
              if (!d || !Number.isInteger(d.index) || !["store", "skip", "update", "merge"].includes(d.action)) continue;
              // "skip" claims a candidate already covers this fact -- with no
              // candidates that claim is impossible, and honouring it would
              // silently discard a valid new fact forever
              if (d.action === "skip" && !(candidates[d.index]?.length > 0)) continue;
              byIndex.set(d.index, d);
            }
            decisions = facts.map((_, i) => byIndex.get(i) ?? { index: i, action: "store" });
          }
        }

        // 4. Apply the decisions AND mark the events processed in ONE
        // transaction: a crash in between must not leave half-applied facts
        // (e.g. a supersede whose replacement was never inserted) or events
        // that get re-extracted into duplicates.
        const applyAll = db.transaction(() => {
        for (const d of decisions) {
          const f = facts[d.index];
          if (!f) continue;
          const targets = (d.target_ids || []).filter((id) => candidates[d.index]?.some((c) => c.id === id));
          if (d.action === "skip") continue;
          if ((d.action === "update" || d.action === "merge") && targets.length) {
            const maxVer = Math.max(...targets.map((id) => candidates[d.index].find((c) => c.id === id)?.version ?? 1));
            for (const id of targets) supersedeFact(db, id);
            insertFact(db, {
              ...f,
              content:
                d.action === "merge" && typeof d.merged_content === "string" && d.merged_content.trim()
                  ? d.merged_content.slice(0, 20_000)
                  : f.content,
              version: maxVer + 1,
              priority: Math.max(f.priority, ...targets.map((id) => candidates[d.index].find((c) => c.id === id)?.priority ?? 0)),
            });
            stats.facts_merged++;
          } else {
            insertFact(db, f);
            stats.facts_new++;
          }
        }
          // 5. Mark processed inside the SAME transaction -- only this batch
          const mark = db.prepare(`UPDATE events SET processed = 1 WHERE id = ?`);
          events.forEach((e) => mark.run(e.id));
        });
        applyAll();
      } else {
        // nothing extracted: still mark the batch so it is not retried forever
        const mark = db.prepare(`UPDATE events SET processed = 1 WHERE id = ?`);
        const tx = db.transaction(() => events.forEach((e) => mark.run(e.id)));
        tx();
      }
      if (events.length < BATCH) break; // session drained
      }
    } catch (err) {
      error = String(err?.message || err);
      console.error(`[worker] session ${s.session_id}:`, error);
      // Leave events unprocessed so the next run retries them. Capture must never
      // depend on the worker succeeding.
    }
  }

  db.prepare(
    `INSERT INTO worker_runs (ran_at, sessions, events_in, facts_new, facts_merged, tokens_in, tokens_out, error)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(Date.now(), stats.sessions, stats.events_in, stats.facts_new, stats.facts_merged,
        stats.tokens_in, stats.tokens_out, error);
  return { ...stats, error };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 50));
