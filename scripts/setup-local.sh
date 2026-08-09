#!/usr/bin/env bash
# memgw one-shot local setup for macOS and Linux.
#
# Does everything: checks prerequisites, installs, writes config, wires Claude Code
# hooks and MCP, starts the gateway, and verifies it. Safe to re-run: it never
# overwrites an existing key or an existing LLM setting.
#
#   bash scripts/setup-local.sh                 # prompts for the API key
#   OPENAI_API_KEY=sk-... bash scripts/setup-local.sh
#   MEMGW_LLM_MODEL=gpt-5-nano bash scripts/setup-local.sh
#
# Written for bash 3.2 (the version macOS ships), so no bash 4 syntax here.
set -uo pipefail

MEMGW_DIR="${MEMGW_DIR:-$HOME/.memgw}"
MODEL="${MEMGW_LLM_MODEL:-gpt-4o-mini}"
BASE_URL="${MEMGW_LLM_BASE_URL:-https://api.openai.com/v1}"
PROMPT_LANG="${MEMGW_PROMPT_LANG:-en}"
PORT="${MEMGW_PORT:-8930}"
MCP_PORT="${MEMGW_MCP_PORT:-8931}"

g() { printf '\033[32m%s\033[0m\n' "$*"; }
y() { printf '\033[33m%s\033[0m\n' "$*"; }
r() { printf '\033[31m%s\033[0m\n' "$*"; }
b() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

# ---------------------------------------------------------------- 1. prereqs
step "1/7  Checking prerequisites"

if ! command -v node >/dev/null 2>&1; then
  r "node is not installed."
  echo "  macOS:  brew install node"
  echo "  Linux:  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install nodejs"
  exit 1
fi
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 20 ]; then
  r "node $(node --version) is too old, memgw needs >= 20."
  exit 1
fi
g "node $(node --version)"

if ! command -v jq >/dev/null 2>&1; then
  y "jq is missing. The Claude Code hooks need it."
  if command -v brew >/dev/null 2>&1; then
    echo "   Installing with brew..."
    brew install jq >/dev/null 2>&1 && g "jq installed" || { r "brew install jq failed, do it manually"; exit 1; }
  else
    r "Install jq first:  sudo apt install jq   (or your package manager)"
    exit 1
  fi
else
  g "jq $(jq --version)"
fi

command -v git >/dev/null 2>&1 && g "git $(git --version | awk '{print $3}')" \
  || y "git missing: notes history and git backup will be disabled"

# ---------------------------------------------------------------- 2. install
step "2/7  Installing dependencies"
if [ -d node_modules ] && [ -f node_modules/.package-lock.json ]; then
  g "node_modules already present, skipping npm install"
else
  npm install --omit=dev --no-audit --no-fund --loglevel=error || { r "npm install failed"; exit 1; }
  g "dependencies installed"
fi

MEMGW_BIN="$ROOT/bin/memgw.mjs"
if npm link >/dev/null 2>&1 && command -v memgw >/dev/null 2>&1; then
  g "'memgw' command available globally"
  MEMGW="memgw"
else
  y "npm link unavailable, will call the script by path instead"
  MEMGW="node $MEMGW_BIN"
fi

# ---------------------------------------------------------------- 3. config
step "3/7  Writing configuration"
mkdir -p "$MEMGW_DIR"
ENV_FILE="$MEMGW_DIR/env"
touch "$ENV_FILE" && chmod 600 "$ENV_FILE"

has_key() { grep -q "^$1=..*" "$ENV_FILE" 2>/dev/null; }
add_key() { has_key "$1" || printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; }

# API key: from env, else prompt. Never echoed, never stored anywhere else.
if ! has_key MEMGW_LLM_API_KEY; then
  KEY_IN="${OPENAI_API_KEY:-${MEMGW_LLM_API_KEY:-}}"
  if [ -z "$KEY_IN" ]; then
    echo "Paste your OpenAI API key (input hidden, press Enter to skip):"
    printf "  key: "
    read -r -s KEY_IN
    echo
  fi
  if [ -n "$KEY_IN" ]; then
    printf 'MEMGW_LLM_API_KEY=%s\n' "$KEY_IN" >> "$ENV_FILE"
    g "API key saved to $ENV_FILE (mode 600)"
  else
    y "No API key. Capture will work, but no facts get extracted until you add one:"
    echo "   echo 'MEMGW_LLM_API_KEY=sk-...' >> $ENV_FILE"
  fi
else
  g "API key already configured, left untouched"
fi

add_key MEMGW_LLM_BASE_URL "$BASE_URL"
add_key MEMGW_LLM_MODEL    "$MODEL"
add_key MEMGW_PROMPT_LANG  "$PROMPT_LANG"
add_key MEMGW_PORT         "$PORT"
add_key MEMGW_MCP_PORT     "$MCP_PORT"
g "model $MODEL @ $BASE_URL (prompt language: $PROMPT_LANG)"

# ---------------------------------------------------------------- 4. start
step "4/7  Starting the gateway"
if curl -sf -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  y "something is already listening on :$PORT, restarting it"
  pkill -f "memgw.mjs start" 2>/dev/null
  pkill -f "src/server.js" 2>/dev/null
  sleep 1
fi

LOG="$MEMGW_DIR/memgw.log"
nohup $MEMGW start >"$LOG" 2>&1 &
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  curl -sf -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.5
done
if curl -sf -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  g "gateway up on :$PORT (log: $LOG)"
else
  r "gateway did not start. Last lines of $LOG:"
  tail -20 "$LOG"
  exit 1
fi

MEMGW_KEY=$(grep '^MEMGW_KEY=' "$ENV_FILE" | cut -d= -f2)
MCP_SECRET=$(grep '^MEMGW_MCP_SECRET=' "$ENV_FILE" | cut -d= -f2)

# ---------------------------------------------------------------- 5. hooks
step "5/7  Wiring Claude Code hooks"
$MEMGW hooks --write >/dev/null 2>&1 && g "hooks installed into ~/.claude/settings.json" \
  || y "could not write settings.json automatically, run: $MEMGW hooks"

# ---------------------------------------------------------------- 6. mcp
step "6/7  Registering the MCP server with Claude Code"
if command -v claude >/dev/null 2>&1; then
  claude mcp remove memgw >/dev/null 2>&1
  if claude mcp add --transport http memgw "http://127.0.0.1:$MCP_PORT/mcp" \
       --header "Authorization: Bearer $MEMGW_KEY" >/dev/null 2>&1; then
    g "MCP server 'memgw' registered"
  else
    y "automatic registration failed, run this yourself:"
    echo "   claude mcp add --transport http memgw http://127.0.0.1:$MCP_PORT/mcp \\"
    echo "     --header \"Authorization: Bearer $MEMGW_KEY\""
  fi
else
  y "the 'claude' CLI is not on PATH, register MCP manually:"
  echo "   claude mcp add --transport http memgw http://127.0.0.1:$MCP_PORT/mcp \\"
  echo "     --header \"Authorization: Bearer $MEMGW_KEY\""
fi

# ---------------------------------------------------------------- 7. verify
step "7/7  Verifying"
$MEMGW doctor

# seed a starter profile so the first session has something to load
PROFILE="$MEMGW_DIR/data/profile.md"
if [ ! -s "$PROFILE" ] || ! grep -q '[A-Za-z]' "$PROFILE" 2>/dev/null; then
  mkdir -p "$(dirname "$PROFILE")"
  cat > "$PROFILE" <<'EOF'
# Profile

Replace this with a few lines about yourself: what you work on, the stack you use,
and any rules every agent should follow. Under 250 words.
memgw rewrites this automatically once it has collected enough facts.
EOF
  y "starter profile written to $PROFILE -- edit it, it is the first thing agents read"
fi

echo
b "Done."
echo
echo "  Gateway     http://127.0.0.1:$PORT"
echo "  MCP         http://127.0.0.1:$MCP_PORT/mcp"
echo "  Config      $ENV_FILE"
echo "  Data        $MEMGW_DIR/data"
echo "  Log         $LOG"
echo
echo "  Next:"
echo "    1. Edit your profile:   \$EDITOR $PROFILE"
echo "    2. Run the test suite:  bash scripts/test-effectiveness.sh"
echo "    3. Restart Claude Code so it picks up the new hooks and MCP server"
echo
echo "  Stop it later with:  pkill -f 'memgw.mjs start'"
