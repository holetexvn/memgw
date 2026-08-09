// Retention: delete old raw events; keep facts and notes forever.
//
// Rationale: events are the raw log and their value has already been distilled
// into facts, so they are the only layer safe to expire. Without this the
// database grows without bound.
//
// Three safety rails, none of which can be disabled by accident:
//   1. only events already processed into facts are eligible
//   2. the newest MIN_KEEP events are always kept, whatever their age
//   3. windows below MIN_DAYS are refused unless allowAggressive is set

const MIN_KEEP = 200; // always keep the newest 200 events
const MIN_DAYS = 7;

export function runRetention(db, { days, allowAggressive = false, dryRun = false } = {}) {
  const d = Number(days ?? process.env.MEMGW_RETENTION_DAYS ?? 90);
  if (!d || d <= 0) return { skipped: true, reason: "retention disabled (days=0)" };
  if (d < MIN_DAYS && !allowAggressive)
    return { skipped: true, reason: `days=${d} is below the ${MIN_DAYS} day floor; pass allowAggressive` };

  const cutoff = Date.now() - d * 24 * 60 * 60 * 1000;

  // Rail 2: find the timestamp of the MIN_KEEP-th newest event and never cross it
  const floorRow = db
    .prepare(`SELECT ts FROM events ORDER BY ts DESC LIMIT 1 OFFSET ?`)
    .get(MIN_KEEP - 1);
  const floorTs = floorRow?.ts ?? 0; // fewer than MIN_KEEP rows -> 0 -> nothing is eligible
  const effectiveCutoff = Math.min(cutoff, floorTs);

  const victims = db
    .prepare(`SELECT id FROM events WHERE processed = 1 AND ts < ? LIMIT 50000`)
    .all(effectiveCutoff);

  if (dryRun) return { dryRun: true, would_delete: victims.length, cutoff: effectiveCutoff };
  if (!victims.length) return { deleted: 0, cutoff: effectiveCutoff };

  const delEvent = db.prepare(`DELETE FROM events WHERE id = ?`);
  const delFts = db.prepare(`DELETE FROM events_fts WHERE id = ?`);
  // Expired events must take their embedding vectors with them: the retention
  // promise covers ALL stored derivatives of the raw text. The table only exists
  // once embeddings have been enabled.
  let delVec = null;
  try { delVec = db.prepare(`DELETE FROM embeddings WHERE kind = 'event' AND id = ?`); } catch {}
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      delFts.run(r.id);
      delEvent.run(r.id);
      delVec?.run(r.id);
    }
  });
  tx(victims);

  // Return freed pages to the OS. Cheaper than a full VACUUM and holds no long lock.
  try {
    db.pragma("incremental_vacuum");
  } catch {
    /* auto_vacuum not enabled on this file; a full VACUUM is not worth the lock */
  }

  return { deleted: victims.length, cutoff: effectiveCutoff, kept_min: MIN_KEEP };
}
