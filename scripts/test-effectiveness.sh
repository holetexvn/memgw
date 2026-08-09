#!/usr/bin/env bash
# memgw effectiveness test suite.
#
# Runs every check that can be driven through the API and prints a scorecard. The
# three tests that need a real Claude Code session are printed as instructions at
# the end, because no script can judge whether an agent actually used its memory.
#
# This measures QUALITY, not plumbing: whether the extractor keeps what matters and
# throws away what does not. It needs a real LLM key. With MEMGW_LLM_MOCK=1 it only
# proves the pipes are connected.
#
#   bash scripts/test-effectiveness.sh
set -uo pipefail

ENV_FILE="${MEMGW_HOME:-$HOME/.memgw}/env"
[ -f "$ENV_FILE" ] || { echo "No config at $ENV_FILE. Run scripts/setup-local.sh first."; exit 1; }
PORT=$(grep '^MEMGW_PORT=' "$ENV_FILE" | cut -d= -f2); PORT="${PORT:-8930}"
KEY=$(grep '^MEMGW_KEY=' "$ENV_FILE" | cut -d= -f2)
URL="http://127.0.0.1:$PORT"
AUTH="Authorization: Bearer $KEY"
JSON='Content-Type: application/json'

curl -sf -m 3 "$URL/health" >/dev/null || { echo "memgw is not running on :$PORT"; exit 1; }

pass=0; fail=0; warn=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1)); }
no()   { printf '  \033[31mFAIL\033[0m  %s\n'   "$1"; [ $# -gt 1 ] && printf '        %s\n' "$2"; fail=$((fail+1)); }
meh()  { printf '  \033[33mWARN\033[0m  %s\n'   "$1"; [ $# -gt 1 ] && printf '        %s\n' "$2"; warn=$((warn+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cap() { curl -s -X POST "$URL/capture" -H "$AUTH" -H "$JSON" -d "$1" >/dev/null; }
flush() { curl -s -X POST "$URL/flush" -H "$AUTH" -H "$JSON" -d "{\"session_id\":\"$1\"}"; }
facts() { curl -s "$URL/search/facts?q=$1${2:+&type=$2}" -H "$AUTH"; }

RUN=$$   # unique session ids so repeated runs are not blocked by idempotent capture

MOCK=$(grep '^MEMGW_LLM_MOCK=1' "$ENV_FILE" 2>/dev/null)
HAS_LLM=$(grep '^MEMGW_LLM_API_KEY=..*' "$ENV_FILE" 2>/dev/null)
if [ -n "$MOCK" ]; then
  echo "NOTE: mock mode is on. This checks plumbing only, not extraction quality."
elif [ -z "$HAS_LLM" ]; then
  echo "NOTE: no LLM key configured. Quality tests will fail for that reason alone."
fi

# ---------------------------------------------------------------- T1 pipeline
head_ "T1  Pipeline: capture -> extract -> search"
cap "{\"source\":\"test\",\"session_id\":\"t1-$RUN\",\"messages\":[
  {\"role\":\"user\",\"content\":\"Remember: the billing service uses Postgres, we ruled out MongoDB\",\"ts\":1000},
  {\"role\":\"assistant\",\"content\":\"Noted, Postgres for billing.\",\"ts\":2000}]}"
R1=$(flush "t1-$RUN")
NEW=$(echo "$R1" | jq -r '.facts_new // 0')
ERR=$(echo "$R1" | jq -r '.error // "null"')
if [ "$NEW" -ge 1 ]; then ok "extracted $NEW fact(s)"
elif [ "$ERR" != "null" ]; then no "extraction errored" "$ERR"
else no "extracted nothing" "check: memgw doctor"; fi

sleep 1
N=$(facts postgres | jq '.results | length')
[ "$N" -ge 1 ] && ok "the fact is searchable" || no "search found nothing"

# ---------------------------------------------------------------- T2 signal vs noise
head_ "T2  Signal vs noise (the test that matters most)"
cap "{\"source\":\"test\",\"session_id\":\"t2-$RUN\",\"messages\":[
  {\"role\":\"user\",\"content\":\"show me the formatDate helper in utils.ts again\",\"ts\":1000},
  {\"role\":\"assistant\",\"content\":\"It takes a Date and returns dd/MM/yyyy.\",\"ts\":2000},
  {\"role\":\"user\",\"content\":\"ok. From now on write all commit messages in English, never in another language\",\"ts\":3000},
  {\"role\":\"assistant\",\"content\":\"Understood.\",\"ts\":4000},
  {\"role\":\"user\",\"content\":\"port 3001 is taken, switch to 3002 for now\",\"ts\":5000},
  {\"role\":\"assistant\",\"content\":\"Switched.\",\"ts\":6000},
  {\"role\":\"user\",\"content\":\"By the way we just passed 10k followers on the channel\",\"ts\":7000},
  {\"role\":\"assistant\",\"content\":\"Congratulations.\",\"ts\":8000}]}"
flush "t2-$RUN" >/dev/null
sleep 1

C=$(facts commit | jq '[.results[] | select(.type=="instruction")] | length')
[ "$C" -ge 1 ] && ok "kept the standing instruction (commit messages)" \
  || no "missed the standing instruction" "this is the highest-value fact in the batch"

P=$(facts commit | jq -r '[.results[] | select(.type=="instruction") | .priority] | max // 0')
[ "$P" -ge 70 ] && ok "instruction has high priority ($P)" || meh "instruction priority is low ($P)" "expected 80+"

# search on "followers": models write the number as either "10k" or "10,000"
F=$(facts followers | jq '.results | length')
[ "$F" -ge 1 ] && ok "kept the durable project fact (10k followers)" || meh "dropped the project fact"

NOISE1=$(facts 3002 | jq '.results | length')
[ "$NOISE1" -eq 0 ] && ok "discarded the throwaway detail (port 3002)" \
  || no "stored a throwaway detail (port 3002)" "the extractor is too permissive"

NOISE2=$(facts formatdate | jq '.results | length')
[ "$NOISE2" -eq 0 ] && ok "discarded the code lookup (formatDate)" \
  || no "stored a one-off code question" "the extractor is too permissive"

# ---------------------------------------------------------------- T3 contradiction
head_ "T3  Changing your mind: update, not duplicate"
cap "{\"source\":\"test\",\"session_id\":\"t3a-$RUN\",\"messages\":[
  {\"role\":\"user\",\"content\":\"Project Atlas uses Tailwind for styling\",\"ts\":1000}]}"
flush "t3a-$RUN" >/dev/null
sleep 1
cap "{\"source\":\"test\",\"session_id\":\"t3b-$RUN\",\"messages\":[
  {\"role\":\"user\",\"content\":\"We dropped Tailwind on project Atlas, it is CSS Modules now\",\"ts\":9000}]}"
flush "t3b-$RUN" >/dev/null
sleep 1

ACTIVE=$(facts tailwind%20atlas%20css | jq '[.results[] | select(.content | test("Tailwind|CSS Modules"))] | length')
SUPER=$(curl -s "$URL/stats" -H "$AUTH" | jq '.counts.facts_superseded')
if [ "$ACTIVE" -le 1 ] && [ "$SUPER" -ge 1 ]; then
  ok "old fact superseded, one active fact left"
elif [ "$ACTIVE" -le 1 ]; then
  ok "only one active fact on the topic"
else
  meh "$ACTIVE contradicting facts are both active" "dedup did not merge them; check the worker log"
fi

# ---------------------------------------------------------------- T4 dead ends
head_ "T4  Dead ends are recorded as such"
cap "{\"source\":\"test\",\"session_id\":\"t4-$RUN\",\"messages\":[
  {\"role\":\"user\",\"content\":\"I tried deploying on Deno and it failed, better-sqlite3 has no Deno build. Do not suggest it again.\",\"ts\":1000},
  {\"role\":\"assistant\",\"content\":\"Understood, Deno is out.\",\"ts\":2000}]}"
flush "t4-$RUN" >/dev/null
sleep 1
D=$(facts deno deadend | jq '.results | length')
[ "$D" -ge 1 ] && ok "recorded with type=deadend" \
  || no "not recorded as a dead end" "$(facts deno | jq -c '[.results[] | {type,content}]')"

# ---------------------------------------------------------------- T4b recap immunity
# A session in which the assistant recites stored facts back (and the user just
# confirms) must not change the store: no new facts, no rewritten facts. This is
# the echo-drift regression: without it, every recap slowly erodes fact content.
head_ "T4b Flushing a recap of stored facts is a no-op"
INSTR_BEFORE=$(facts commit | jq -r '[.results[] | select(.type=="instruction") | .content] | sort | join("|")')
DENO_BEFORE=$(facts deno | jq -r '[.results[] | {type,content}] | sort_by(.content) | tojson')
COUNT_BEFORE=$(curl -s "$URL/stats" -H "$AUTH" | jq '.counts.facts_active')
cap "{\"source\":\"test\",\"session_id\":\"t4b-$RUN\",\"messages\":[
  {\"role\":\"user\",\"content\":\"what do you remember about me?\",\"ts\":1000},
  {\"role\":\"assistant\",\"content\":\"Here is a recap of what I have stored: you write commit messages in English; the billing service runs on Postgres; Deno failed due to better-sqlite3; Atlas now uses CSS Modules; the channel passed 10k followers.\",\"ts\":2000},
  {\"role\":\"user\",\"content\":\"yes, that is all correct\",\"ts\":3000}]}"
flush "t4b-$RUN" >/dev/null
sleep 1
INSTR_AFTER=$(facts commit | jq -r '[.results[] | select(.type=="instruction") | .content] | sort | join("|")')
DENO_AFTER=$(facts deno | jq -r '[.results[] | {type,content}] | sort_by(.content) | tojson')
COUNT_AFTER=$(curl -s "$URL/stats" -H "$AUTH" | jq '.counts.facts_active')
[ "$INSTR_AFTER" = "$INSTR_BEFORE" ] && ok "instruction fact survived the recap unchanged" \
  || no "instruction fact was rewritten by a recap" "before: $INSTR_BEFORE
        after:  $INSTR_AFTER"
[ "$DENO_AFTER" = "$DENO_BEFORE" ] && ok "deadend fact survived the recap unchanged" \
  || no "deadend fact was rewritten by a recap" "before: $DENO_BEFORE
        after:  $DENO_AFTER"
[ "$COUNT_AFTER" -eq "$COUNT_BEFORE" ] && ok "no facts added or lost ($COUNT_AFTER)" \
  || no "active fact count changed: $COUNT_BEFORE -> $COUNT_AFTER" "the recap was re-extracted as new facts"

# ---------------------------------------------------------------- T5 notes
head_ "T5  Notes and git history"
curl -s -X POST "$URL/flush-notes" -H "$AUTH" >/dev/null
DATA="${MEMGW_HOME:-$HOME/.memgw}/data"
NOTES=$(ls "$DATA/topics/"*.md 2>/dev/null | wc -l | tr -d ' ')
[ "$NOTES" -ge 1 ] && ok "$NOTES topic note(s) written" || no "no topic notes were produced"

if [ -d "$DATA/.git" ]; then
  COMMITS=$(git -c safe.directory="$DATA" -C "$DATA" rev-list --count HEAD 2>/dev/null || echo 0)
  [ "$COMMITS" -ge 1 ] && ok "git history has $COMMITS commit(s)" || meh "git repo exists but has no commits"
else
  meh "no git repo in $DATA" "is git installed?"
fi

# a note that merely repeats the fact list adds no value
if [ "$NOTES" -ge 1 ]; then
  LINES=$(cat "$DATA/topics/"*.md | grep -c '^- ' 2>/dev/null || echo 0)
  TOTAL=$(cat "$DATA/topics/"*.md | grep -cv '^\s*$' 2>/dev/null || echo 1)
  if [ "$TOTAL" -gt 0 ] && [ "$LINES" -lt "$TOTAL" ]; then
    ok "notes contain prose, not just a copied fact list"
  else
    meh "notes look like a bare list" "the model is copying facts instead of summarising"
  fi
fi

# ---------------------------------------------------------------- T6 resilience
head_ "T6  Bad input does not break anything"
BAD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/capture" -H "$AUTH" -H "$JSON" -d '{"garbage":true}')
[ "$BAD" = "400" ] && ok "malformed capture rejected with 400" || no "expected 400, got $BAD"
UNAUTH=$(curl -s -o /dev/null -w '%{http_code}' "$URL/stats")
[ "$UNAUTH" = "401" ] && ok "unauthenticated request rejected" || no "expected 401, got $UNAUTH"
curl -sf -m 3 "$URL/health" >/dev/null && ok "still healthy after the abuse" || no "gateway fell over"

# ---------------------------------------------------------------- T7 cost
head_ "T7  Cost"
STATS=$(curl -s "$URL/stats" -H "$AUTH")
TIN=$(echo "$STATS" | jq '[.recent_runs[].tokens_in] | add // 0')
TOUT=$(echo "$STATS" | jq '[.recent_runs[].tokens_out] | add // 0')
EVENTS=$(echo "$STATS" | jq '.counts.events')
FACTS=$(echo "$STATS" | jq '.counts.facts_active')
echo "  events: $EVENTS   active facts: $FACTS"
echo "  tokens over the last runs: ${TIN} in / ${TOUT} out"
if [ "$TIN" -gt 0 ]; then
  # gpt-4o-mini list price: $0.15 per 1M in, $0.60 per 1M out
  COST=$(echo "$TIN $TOUT" | awk '{printf "%.5f", ($1/1000000*0.15)+($2/1000000*0.60)}')
  echo "  that is about \$$COST at gpt-4o-mini prices"
  ok "token accounting is being recorded"
else
  meh "no token usage recorded" "mock mode, or no extraction has run yet"
fi

# ---------------------------------------------------------------- scorecard
printf '\n\033[1m%s\033[0m\n' "Scorecard"
echo "  passed: $pass    warnings: $warn    failed: $fail"
if [ "$fail" -eq 0 ] && [ "$warn" -le 2 ]; then
  printf '  \033[32m%s\033[0m\n' "Automated checks look good."
elif [ "$fail" -le 2 ]; then
  printf '  \033[33m%s\033[0m\n' "Mostly working. Before touching the code, try a stronger model."
else
  printf '  \033[31m%s\033[0m\n' "Something is off. Run 'memgw doctor' and check the log."
fi

cat <<MANUAL

Three things a script cannot judge. Do these by hand in Claude Code:

  A. Cross-session recall
     1. In Claude Code: "Remember: for memgw we chose SQLite with FTS5, no Postgres,
        because I did not want another service to run."
     2. Quit Claude Code, then run:
        curl -s -X POST $URL/flush -H "$AUTH" -H "$JSON" -d '{}'
     3. Start a NEW session and ask: "What database does memgw use and why?"
     PASS if it answers correctly by calling memory_search on its own.

  B. Dead-end avoidance
     In a new session ask: "Should we switch the runtime to Deno to make it lighter?"
     PASS if it warns you that you already tried Deno and why it failed.
     (T4 above already put that fact in the store.)

  C. Bootstrap injection
     Edit ~/.memgw/data/profile.md, start a NEW session, and ask as the first message:
     "Based on what you know about me, what am I working on?"
     PASS if it answers from the profile WITHOUT calling any tool.

If A fails but T1 passed, the problem is retrieval, not capture: check /mcp in Claude Code.
If C fails, the SessionStart hook is not firing: run  node ~/.memgw/bootstrap.mjs  by hand.
MANUAL

# a failed quality run must FAIL the shell: this script is the release gate
exit "$fail"
