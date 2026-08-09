#!/usr/bin/env bash
# End-to-end smoke test: capture -> flush (mock LLM) -> search -> bootstrap.
# The server must already be running with MEMGW_KEY=test MEMGW_LLM_MOCK=1.
set -euo pipefail
URL="${1:-http://127.0.0.1:8930}"
AUTH="Authorization: Bearer test"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 (got: $2, want: $3)"; fail=$((fail+1)); fi; }

# 0. auth is rejected when the key is missing
code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/stats")
check "auth required" "$code" "401"

# 1. capture
added=$(curl -s -X POST "$URL/capture" -H "$AUTH" -H 'Content-Type: application/json' -d '{
  "source": "cc-test", "session_id": "smoke-1",
  "messages": [
    {"role": "user",      "content": "Nhớ giùm anh: dự án memgw chốt dùng SQLite với FTS5, không dùng Postgres", "ts": 1000},
    {"role": "assistant", "content": "Ok, đã ghi nhận lựa chọn SQLite + FTS5.", "ts": 2000},
    {"role": "user",      "content": "À anh thích trả lời ngắn gọn thôi nhé", "ts": 3000}
  ]}' | jq '.added')
check "capture added 3" "$added" "3"

# 1b. capture the exact same payload again -> idempotent
added2=$(curl -s -X POST "$URL/capture" -H "$AUTH" -H 'Content-Type: application/json' -d '{
  "source": "cc-test", "session_id": "smoke-1",
  "messages": [{"role": "user", "content": "Nhớ giùm anh: dự án memgw chốt dùng SQLite với FTS5, không dùng Postgres", "ts": 1000}]}' | jq '.added')
check "capture idempotent" "$added2" "0"

# 2. flush -> mock extraction
new=$(curl -s -X POST "$URL/flush" -H "$AUTH" -H 'Content-Type: application/json' -d '{"session_id":"smoke-1"}' | jq '.facts_new')
[ "$new" -ge 1 ] && check "flush extracted >=1 fact" "ok" "ok" || check "flush extracted >=1 fact" "$new" ">=1"

# 3. search facts - with diacritics
n=$(curl -s "$URL/search/facts?q=SQLite" -H "$AUTH" | jq '.results | length')
[ "$n" -ge 1 ] && check "search facts (SQLite)" "ok" "ok" || check "search facts (SQLite)" "$n" ">=1"

# 3b. searching WITHOUT diacritics must still match accented content (remove_diacritics 2)
n2=$(curl -s "$URL/search/events?q=du%20an%20memgw" -H "$AUTH" | jq '.results | length')
[ "$n2" -ge 1 ] && check "search without diacritics" "ok" "ok" || check "search without diacritics" "$n2" ">=1"

# 4. write a fact by hand and search for it again
curl -s -X POST "$URL/facts" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"content":"Đã thử dựng CodeGraph bằng regex, fail vì không xử được import động","type":"deadend","topic":"memgw","priority":75}' > /dev/null
n3=$(curl -s "$URL/search/facts?q=CodeGraph&type=deadend" -H "$AUTH" | jq '.results | length')
check "manual fact + type filter" "$n3" "1"

# 5. bootstrap
has=$(curl -s "$URL/bootstrap" -H "$AUTH" | jq 'has("tools_guide")')
check "bootstrap" "$has" "true"

# 6. stats
pending=$(curl -s "$URL/stats" -H "$AUTH" | jq '.counts.events_pending')
check "events all processed" "$pending" "0"

echo; echo "== $pass pass, $fail fail =="
exit $fail
