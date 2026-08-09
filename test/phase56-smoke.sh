#!/usr/bin/env bash
# Phase 5 (Hermes plugin) + phase 6 (notes updater + git) tests.
# Run the server with: MEMGW_KEY=test MEMGW_LLM_MOCK=1 MEMGW_DATA_DIR=/tmp/memgw-test-data node src/server.js
set -uo pipefail
URL="${1:-http://127.0.0.1:8930}"
DATA="${MEMGW_DATA_DIR:-/tmp/memgw-test-data}"
AUTH="Authorization: Bearer test"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 (got: $2 want: $3)"; fail=$((fail+1)); fi; }

# --- seed facts straight through /facts so the notes updater has something to chew on ---
for i in 1 2 3; do
  curl -s -X POST "$URL/facts" -H "$AUTH" -H 'Content-Type: application/json' \
    -d "{\"content\":\"Fact số $i cho notes updater, dự án memgw\",\"type\":\"project\",\"topic\":\"memgw\",\"priority\":60}" >/dev/null
done
curl -s -X POST "$URL/facts" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"content":"Đã thử chạy npm dưới user memgw, treo vì mất proxy env","type":"deadend","topic":"memgw","priority":75}' >/dev/null

# --- phase 6: flush-notes ---
RES=$(curl -s -X POST "$URL/flush-notes" -H "$AUTH")
updated=$(echo "$RES" | jq -r '.updated')
check "flush-notes updated" "$updated" "true"

# was the topic file created?
[ -f "$DATA/topics/auto-mock.md" ] && check "topic file created" "ok" "ok" || check "topic file created" "missing" "ok"

# is there a git commit?
if [ -d "$DATA/.git" ]; then
  commits=$(git -C "$DATA" rev-list --count HEAD 2>/dev/null || echo 0)
  [ "$commits" -ge 1 ] && check "git has a commit" "ok" "ok" || check "git has a commit" "$commits" ">=1"
  git -C "$DATA" log --oneline | head -2 | sed 's/^/    /'
else
  check "git repo init" "no-git" "ok"
fi

# bootstrap sees the new topic
n=$(curl -s "$URL/bootstrap" -H "$AUTH" | jq '.topics | length')
[ "$n" -ge 1 ] && check "bootstrap sees the topic" "ok" "ok" || check "bootstrap sees the topic" "$n" ">=1"

# --- phase 5: Hermes plugin ---
echo "--- Hermes plugin ---"
MEMGW_URL="$URL" MEMGW_KEY="test" python3 test/memgw_plugin_selftest.py
rc=$?
check "hermes plugin selftest" "$rc" "0"

echo; echo "== $pass pass, $fail fail =="
exit $fail
