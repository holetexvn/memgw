#!/usr/bin/env bash
# Watcher end-to-end test: read fake transcripts from 2 agents -> send them to a real
# server -> verify the events landed in the DB, that the cursor works (a second run sends
# nothing twice) and that appended lines are still picked up.
set -uo pipefail
URL="${1:-http://127.0.0.1:8930}"
AUTH="Authorization: Bearer test"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 (got: $2 want: $3)"; fail=$((fail+1)); fi; }

WORK=$(mktemp -d)
export HOME_BAK="$HOME"
export HOME="$WORK/home"           # cursors go into a fake HOME, never the real machine
mkdir -p "$HOME/.memgw" "$WORK/cc" "$WORK/cx"
# Each run uses its own session id, otherwise idempotent capture would block it
# (correct server behaviour, but it would make the test non-isolated).
RUN=$$
sed "s/cc-sess-1/cc-$RUN/g" test/fixtures/claude-code.jsonl > "$WORK/cc/session-a.jsonl"
sed "s/cx-1/cx-$RUN/g"      test/fixtures/codex.jsonl       > "$WORK/cx/rollout-b.jsonl"

export MEMGW_URL="$URL" MEMGW_KEY="test"

# 1. dry-run must send nothing
before=$(curl -s "$URL/stats" -H "$AUTH" | jq '.counts.events')
node agents/watcher.mjs --agent claude-code --dir "$WORK/cc" --once --dry-run >/dev/null 2>&1
after_dry=$(curl -s "$URL/stats" -H "$AUTH" | jq '.counts.events')
check "dry-run writes nothing" "$after_dry" "$before"

# 2. real run with claude-code -> +2 events
node agents/watcher.mjs --agent claude-code --dir "$WORK/cc" --once >/dev/null 2>&1
n1=$(curl -s "$URL/stats" -H "$AUTH" | jq '.counts.events')
check "watcher sent 2 claude-code messages" "$((n1 - before))" "2"

# 3. run again -> the cursor blocks it, nothing is sent twice
node agents/watcher.mjs --agent claude-code --dir "$WORK/cc" --once >/dev/null 2>&1
n2=$(curl -s "$URL/stats" -H "$AUTH" | jq '.counts.events')
check "second run sends no duplicates" "$n2" "$n1"

# 4. append a new line -> only the new part is sent
cat >> "$WORK/cc/session-a.jsonl" <<EOF
{"type":"user","message":{"role":"user","content":"Dòng mới thêm sau lần $RUN"},"timestamp":"2026-08-08T10:05:00.000Z","sessionId":"cc-$RUN"}
EOF
node agents/watcher.mjs --agent claude-code --dir "$WORK/cc" --once >/dev/null 2>&1
n3=$(curl -s "$URL/stats" -H "$AUTH" | jq '.counts.events')
check "append sends only the new part" "$((n3 - n2))" "1"

# 5. a second agent (codex) -> its own source
node agents/watcher.mjs --agent codex --dir "$WORK/cx" --once >/dev/null 2>&1
n4=$(curl -s "$URL/stats" -H "$AUTH" | jq '.counts.events')
check "watcher sent 2 codex messages" "$((n4 - n3))" "2"

# 6. the two sources are distinguishable in stats
sources=$(curl -s "$URL/stats" -H "$AUTH" | jq -r '[.by_source[].source] | sort | join(",")')
echo "$sources" | grep -q "claude-code-" && echo "$sources" | grep -q "codex-"
check "the 2 sources are distinguishable" "$?" "0"

# 7. Vietnamese content lands intact and is searchable again (without diacritics)
found=$(curl -s "$URL/search/events?q=postgres%20du%20an" -H "$AUTH" | jq '.results | length')
[ "$found" -ge 1 ] && check "codex content is searchable again" "ok" "ok" || check "codex content is searchable again" "$found" ">=1"

export HOME="$HOME_BAK"
rm -rf "$WORK"
echo; echo "== $pass pass, $fail fail =="
exit $fail
