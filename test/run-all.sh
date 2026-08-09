#!/usr/bin/env bash
# Run the whole memgw test suite (7 phases).
# Starts a mock-LLM server on a temporary data dir, runs every suite, cleans up,
# then prints a summary.
set -uo pipefail
cd "$(dirname "$0")/.."

DATA=/tmp/memgw-runall-$$
PORT=${MEMGW_PORT:-8930}
export MEMGW_KEY=test MEMGW_MCP_SECRET=s3cret MEMGW_LLM_MOCK=1 MEMGW_DATA_DIR="$DATA"

cleanup() { kill "$SRV" 2>/dev/null; rm -rf "$DATA"; }
trap cleanup EXIT

# If another server already holds the port, stop now instead of testing against its DB.
if curl -sf -m2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "Port $PORT is already used by another server. Stop it first (pkill -f 'node src/server.js')"
  echo "or re-run with a different MEMGW_PORT."
  exit 1
fi

rm -rf "$DATA"; mkdir -p "$DATA/topics"
printf '# Billing service notes\n' > "$DATA/topics/billing-service.md"
printf '# Example user profile\n'    > "$DATA/profile.md"

node src/server.js > "$DATA/server.log" 2>&1 &
SRV=$!
for i in $(seq 20); do curl -sf -m1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.3; done
curl -sf -m2 "http://127.0.0.1:$PORT/health" >/dev/null || { echo "SERVER DID NOT START:"; cat "$DATA/server.log"; exit 1; }

total_fail=0
run() {
  echo; echo "──── $1 ────"
  shift
  "$@" 2>&1 | tail -n +1
  local rc=${PIPESTATUS[0]}
  [ "$rc" -ne 0 ] && total_fail=$((total_fail+1))
}

run "PHASE1-3  HTTP API + worker"      bash test/smoke.sh
run "PHASE4     MCP protocol"          node test/mcp-smoke.mjs
run "PHASE4     MCP via SDK client"    node test/mcp-client-test.mjs
run "PHASE5-6   Hermes plugin + notes" bash test/phase56-smoke.sh
run "PHASE7     Retention"             node test/retention-test.mjs
run "MULTI      Multi-agent parsers"   node test/parsers-test.mjs
run "MULTI      Watcher end-to-end"    bash test/watcher-test.sh
run "HARDEN     Security hardening"    node test/hardening-test.mjs
run "EMBED      Embeddings fallback"   node test/embed-test.mjs
run "CONFIG     Startup guarantees"    node test/config-test.mjs
run "DOC        Docs vs code"          node test/verify-docs.mjs

echo
if [ "$total_fail" -eq 0 ]; then echo "════ ALL SUITES PASS ════"; else echo "════ $total_fail SUITE(S) FAILED ════"; fi
exit "$total_fail"
