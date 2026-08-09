// Test retention straight against the DB (not over HTTP) so the timestamps stay under
// our control. This is the most dangerous part of the system (it DELETES data), so all
// three safety rails are covered.
import { openDb, insertEvents } from "../src/db.js";
import { runRetention } from "../src/retention.js";
import { rmSync, mkdirSync } from "node:fs";

const DIR = "/tmp/memgw-retention-test";
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
const db = openDb(`${DIR}/test.db`);

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { console.log(`PASS ${name}`); pass++; }
  else { console.log(`FAIL ${name} ${extra}`); fail++; }
};

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const seed = (n, ageDays, tag) => {
  const msgs = Array.from({ length: n }, (_, i) => ({
    role: "user",
    content: `${tag} message ${i} nội dung tiếng Việt có dấu`,
    ts: now - ageDays * DAY - i * 1000,
  }));
  return insertEvents(db, "test", `sess-${tag}`, msgs);
};

// 300 events aged 200 days, 50 events from today
seed(300, 200, "old");
seed(50, 0, "new");
db.prepare(`UPDATE events SET processed = 1`).run();
const total0 = db.prepare(`SELECT COUNT(*) n FROM events`).get().n;
check("seed 350 events", total0 === 350, `got ${total0}`);

// 1. a dry run deletes nothing
const dry = runRetention(db, { days: 90, dryRun: true });
check("dry_run deletes nothing", db.prepare(`SELECT COUNT(*) n FROM events`).get().n === 350 && dry.would_delete > 0,
  JSON.stringify(dry));

// 2. days=0 -> disabled
const off = runRetention(db, { days: 0 });
check("days=0 disables retention", off.skipped === true);

// 3. days below the floor of 7 without allowAggressive -> refused
const tooLow = runRetention(db, { days: 3 });
check("refuses days < 7", tooLow.skipped === true, JSON.stringify(tooLow));

// 4. real run: delete events older than 90 days, BUT always keep the newest 200
const r = runRetention(db, { days: 90 });
const left = db.prepare(`SELECT COUNT(*) n FROM events`).get().n;
check("old events get deleted", r.deleted > 0, JSON.stringify(r));
check("keeps at least 200 events (safety floor)", left >= 200, `${left} left`);
check("the 50 new events are untouched",
  db.prepare(`SELECT COUNT(*) n FROM events WHERE content LIKE 'new%'`).get().n === 50);

// 5. FTS is cleaned along with it, no leftovers (otherwise search returns deleted ids)
const ftsCount = db.prepare(`SELECT COUNT(*) n FROM events_fts`).get().n;
check("FTS stays in sync with the main table", ftsCount === left, `fts=${ftsCount} events=${left}`);

// 6. events that are NOT processed yet are never deleted, however old they are
db.prepare(`DELETE FROM events`).run();
db.prepare(`DELETE FROM events_fts`).run();
seed(10, 500, "unprocessed");   // leave processed=0
seed(250, 0, "fresh");
db.prepare(`UPDATE events SET processed = 1 WHERE content LIKE 'fresh%'`).run();
runRetention(db, { days: 30 });
const unproc = db.prepare(`SELECT COUNT(*) n FROM events WHERE content LIKE 'unprocessed%'`).get().n;
check("unprocessed events are NOT deleted", unproc === 10, `${unproc}/10 left`);

// 7. facts are never touched
db.prepare(`INSERT INTO facts (id, content, type, priority, status, created_at, updated_at)
            VALUES ('f1','fact cũ 500 ngày','preference',50,'active',?,?)`).run(now - 500 * DAY, now - 500 * DAY);
runRetention(db, { days: 30 });
check("facts are not deleted", db.prepare(`SELECT COUNT(*) n FROM facts`).get().n === 1);

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
