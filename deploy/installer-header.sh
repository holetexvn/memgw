#!/usr/bin/env bash
# ============================================================
# memgw self-extracting installer
# Usage:  sudo MEMGW_DOMAIN=memgw.example.com MEMGW_LLM_API_KEY=sk-xxx bash memgw-installer.run
# Optional env vars:
#   MEMGW_DOMAIN        domain for Caddy TLS (empty = skip Caddy, listen on localhost only)
#   MEMGW_LLM_API_KEY   LLM key for the worker (empty = capture still runs, extraction waits for the key)
#   MEMGW_LLM_BASE_URL  defaults to https://api.openai.com/v1
#   MEMGW_LLM_MODEL     defaults to gpt-4o-mini
#   MEMGW_NO_SERVICE=1  skip systemd (tests/containers), run detached instead
# Safe to re-run (idempotent): keeps the existing .env and data/, only overwrites code.
# ============================================================
set -euo pipefail
INSTALL_DIR=/opt/memgw
DOMAIN="${MEMGW_DOMAIN:-}"
NO_SERVICE="${MEMGW_NO_SERVICE:-0}"

log() { printf '\033[1;32m[memgw]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[memgw]\033[0m %s\n' "$*" >&2; }

[ "$(id -u)" -eq 0 ] || { err "Root required. Run: sudo bash $0"; exit 1; }
command -v apt-get >/dev/null || { err "This script supports Ubuntu/Debian only (apt-get required)."; exit 1; }

asuser() { runuser -u memgw -- "$@" 2>/dev/null || sudo -u memgw "$@"; }

# ---------- 1. Node >= 22 ----------
need_node=1
if command -v node >/dev/null; then
  major=$(node -e 'console.log(process.versions.node.split(".")[0])')
  [ "$major" -ge 22 ] && need_node=0
fi
if [ "$need_node" = 1 ]; then
  log "Installing Node 22 from NodeSource..."
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
NODE_BIN=$(command -v node)
log "Node $($NODE_BIN --version) at $NODE_BIN"

# ---------- 1b. git (for the phase 6 notes updater) ----------
if ! command -v git >/dev/null; then
  log "Installing git..."
  apt-get install -y -qq git >/dev/null
fi

# ---------- 2. User + extract code ----------
id -u memgw >/dev/null 2>&1 || useradd -r -m -d "$INSTALL_DIR" -s /usr/sbin/nologin memgw
mkdir -p "$INSTALL_DIR"
ARCHIVE_LINE=$(awk '/^__ARCHIVE__$/{print NR+1; exit}' "$0")
# Stop the service BEFORE replacing code and node_modules: upgrading under a
# running process creates a mixed-version window and a failed npm ci would
# leave a live install half-broken. systemd restarts it at the end.
systemctl stop memgw 2>/dev/null || true
log "Extracting code into $INSTALL_DIR (keeping existing .env + data/ if any)..."
tail -n +"$ARCHIVE_LINE" "$0" | base64 -d | tar xz -C /opt
chown -R memgw:memgw "$INSTALL_DIR"

# ---------- 3. npm install ----------
# Run as root then chown back: avoids losing env (proxy, PATH) when switching user,
# and avoids npm cache permission problems. `npm ci` installs EXACTLY what the
# shipped lockfile pins -- no version drift between what was tested and what runs.
log "npm ci (better-sqlite3 uses a prebuilt binary, usually < 1 minute)..."
cd "$INSTALL_DIR"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
chown -R memgw:memgw "$INSTALL_DIR"

# ---------- 4. .env (created on first run only) ----------
if [ ! -f "$INSTALL_DIR/.env" ]; then
  KEY=$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
  SECRET=$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
  cat > "$INSTALL_DIR/.env" <<ENVEOF
MEMGW_KEY=$KEY
MEMGW_MCP_SECRET=$SECRET
MEMGW_LLM_BASE_URL=${MEMGW_LLM_BASE_URL:-https://api.openai.com/v1}
MEMGW_LLM_MODEL=${MEMGW_LLM_MODEL:-gpt-4o-mini}
MEMGW_LLM_API_KEY=${MEMGW_LLM_API_KEY:-}
MEMGW_PORT=8930
MEMGW_MCP_PORT=8931
MEMGW_DATA_DIR=./data
MEMGW_RETENTION_DAYS=${MEMGW_RETENTION_DAYS:-90}
MEMGW_NOTES_INTERVAL_MS=21600000
# Optional backup - fill these in then restart the service:
# MEMGW_GIT_REMOTE=https://<token>@github.com/user/memgw-data.git
${R2_ENDPOINT:+R2_ENDPOINT=$R2_ENDPOINT}
${R2_BUCKET:+R2_BUCKET=$R2_BUCKET}
${R2_ACCESS_KEY_ID:+R2_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID}
${R2_SECRET_ACCESS_KEY:+R2_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY}
ENVEOF
  # drop the blank lines left by unset R2 variables
  sed -i '/^$/d' "$INSTALL_DIR/.env"
  chown memgw:memgw "$INSTALL_DIR/.env" && chmod 600 "$INSTALL_DIR/.env"
  log "Generated .env with fresh keys."
else
  log ".env already exists, left untouched."
fi
# Read values back WITHOUT shell-sourcing: this script runs as root and the env
# file is owned by the unprivileged service account -- executing its contents
# would let a compromised service escalate on the next installer run. grep+cut
# treats every value as data, never as code. (-f2- keeps values containing '='.)
env_val() { grep "^$1=" "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-; }
MEMGW_KEY_VAL=$(env_val MEMGW_KEY)
MEMGW_SECRET_VAL=$(env_val MEMGW_MCP_SECRET)
LLM_KEY_VAL=$(env_val MEMGW_LLM_API_KEY)

# ---------- 5. Run the service ----------
HAS_SYSTEMD=0
[ "$NO_SERVICE" != 1 ] && [ -d /run/systemd/system ] && HAS_SYSTEMD=1
if [ "$HAS_SYSTEMD" = 1 ]; then
  log "Installing systemd service..."
  sed "s|ExecStart=.*|ExecStart=$NODE_BIN src/server.js|" "$INSTALL_DIR/deploy/memgw.service" \
    > /etc/systemd/system/memgw.service
  systemctl daemon-reload
  systemctl enable --now memgw >/dev/null 2>&1
  systemctl restart memgw
else
  log "No systemd (or MEMGW_NO_SERVICE=1), running detached."
  pkill -f "node src/server.js" 2>/dev/null || true
  sleep 1
  touch /var/log/memgw.log && chown memgw /var/log/memgw.log
  # setsid + close every fd so the process does not hold the parent shell's pipe.
  # Values come from env_val (grep, data-only) -- NEVER shell-source the env file
  # here: it is service-owned and this shell is root.
  ( cd "$INSTALL_DIR" && \
    setsid runuser -u memgw -- env MEMGW_KEY="$(env_val MEMGW_KEY)" MEMGW_MCP_SECRET="$(env_val MEMGW_MCP_SECRET)" \
      MEMGW_LLM_BASE_URL="$(env_val MEMGW_LLM_BASE_URL)" MEMGW_LLM_MODEL="$(env_val MEMGW_LLM_MODEL)" \
      MEMGW_LLM_API_KEY="$(env_val MEMGW_LLM_API_KEY)" MEMGW_PORT="$(env_val MEMGW_PORT)" \
      MEMGW_MCP_PORT="$(env_val MEMGW_MCP_PORT)" MEMGW_DATA_DIR="$(env_val MEMGW_DATA_DIR)" \
      "$NODE_BIN" src/server.js </dev/null >>/var/log/memgw.log 2>&1 & ) </dev/null >/dev/null 2>&1 || true
fi

# ---------- 6. Health check ----------
sleep 2
if curl -m 5 -sf http://127.0.0.1:8930/health >/dev/null; then
  log "Gateway :8930 OK"
else
  err "Gateway did not come up. Check the log: journalctl -u memgw -n 50 (or /var/log/memgw.log)"; exit 1
fi
AUTH_CODE=$(curl -m 5 -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $MEMGW_KEY_VAL" http://127.0.0.1:8930/stats)
[ "$AUTH_CODE" = "200" ] && log "Auth OK" || { err "Auth fail ($AUTH_CODE)"; exit 1; }
MCP_CODE=$(curl -m 5 -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8931/mcp \
  -H "Authorization: Bearer $MEMGW_KEY_VAL" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"installer","version":"0"}}}')
[ "$MCP_CODE" = "200" ] && log "MCP :8931 OK" || { err "MCP fail ($MCP_CODE)"; exit 1; }

# ---------- 6b. Litestream (phase 7, only when all 4 R2 variables are set) ----------
LITESTREAM_ON=0
if [ -n "${R2_ENDPOINT:-}" ] && [ -n "${R2_BUCKET:-}" ] && [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -n "${R2_SECRET_ACCESS_KEY:-}" ] && [ "$HAS_SYSTEMD" = 1 ]; then
  if ! command -v litestream >/dev/null; then
    log "Installing Litestream..."
    LS_ARCH=$(dpkg --print-architecture)
    LS_VER=$(curl -fsSL https://api.github.com/repos/benbjohnson/litestream/releases/latest 2>/dev/null \
      | grep -o '"tag_name": *"v[^"]*"' | head -1 | sed 's/.*"v\([^"]*\)".*/\1/')
    LS_VER="${LS_VER:-0.3.13}"
    curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v${LS_VER}/litestream-v${LS_VER}-linux-${LS_ARCH}.deb" \
      -o /tmp/litestream.deb 2>/dev/null && dpkg -i /tmp/litestream.deb >/dev/null 2>&1 || err "Litestream install failed, skipping"
  fi
  if command -v litestream >/dev/null; then
    cat > /etc/litestream.yml <<LSEOF
dbs:
  - path: $INSTALL_DIR/data/memgw.db
    replicas:
      - type: s3
        endpoint: $R2_ENDPOINT
        bucket: $R2_BUCKET
        path: memgw
        region: auto
        access-key-id: $R2_ACCESS_KEY_ID
        secret-access-key: $R2_SECRET_ACCESS_KEY
        retention: 720h
        snapshot-interval: 12h
LSEOF
    chmod 600 /etc/litestream.yml
    systemctl enable --now litestream >/dev/null 2>&1 && systemctl restart litestream
    sleep 2
    systemctl is-active --quiet litestream && { log "Litestream -> R2 OK"; LITESTREAM_ON=1; } || err "Litestream is not running: journalctl -u litestream -n 30"
  fi
elif [ -n "${R2_ENDPOINT:-}" ]; then
  err "Incomplete R2 config (need R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY), skipping Litestream"
fi

# ---------- 7. Caddy (only when a domain is set) ----------
if [ -n "$DOMAIN" ] && [ "$HAS_SYSTEMD" = 1 ]; then
  if ! command -v caddy >/dev/null; then
    log "Installing Caddy..."
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  if ! grep -q "$DOMAIN" /etc/caddy/Caddyfile 2>/dev/null; then
    log "Adding $DOMAIN to the Caddyfile..."
    cat >> /etc/caddy/Caddyfile <<CADDYEOF

$DOMAIN {
    handle /mcp* {
        reverse_proxy 127.0.0.1:8931
    }
    handle {
        reverse_proxy 127.0.0.1:8930
    }
}
CADDYEOF
    systemctl reload caddy
  fi
  command -v ufw >/dev/null && ufw status | grep -q "Status: active" && { ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; log "UFW: opened 80/443"; }
  log "Caddy OK. Remember to point a DNS A record at this box: $DOMAIN -> this machine's IP (if not done yet)."
fi

# ---------- 8. Print the summary ----------
# Without a domain the service binds LOOPBACK ONLY -- printing a <VPS-IP> URL
# would be a lie. Clients reach it through an SSH tunnel instead.
BASE_URL="${DOMAIN:+https://$DOMAIN}"; BASE_URL="${BASE_URL:-http://127.0.0.1:8930 (via SSH tunnel)}"
MCP_URL="${DOMAIN:+https://$DOMAIN/mcp}"; MCP_URL="${MCP_URL:-http://127.0.0.1:8931/mcp (via SSH tunnel)}"
if [ -z "${DOMAIN:-}" ]; then
  echo
  echo " No domain: the gateway is bound to loopback on this VPS. From each client machine:"
  echo "   ssh -N -L 8930:127.0.0.1:8930 -L 8931:127.0.0.1:8931 $(whoami)@<this-vps>"
  echo " then use http://127.0.0.1:8930 and http://127.0.0.1:8931/mcp locally as usual."
fi
echo
echo "============================================================"
echo " memgw IS RUNNING"
echo "============================================================"
echo
echo " MEMGW_KEY        = $MEMGW_KEY_VAL"
echo " MEMGW_MCP_SECRET = $MEMGW_SECRET_VAL"
[ -z "$LLM_KEY_VAL" ] && echo " (!) MEMGW_LLM_API_KEY is empty: capture still runs, extraction will"
[ -z "$LLM_KEY_VAL" ] && echo "     wait until you put a key in $INSTALL_DIR/.env and restart."
echo
echo " Connect Claude Code (run on each machine):"
echo "   claude mcp add --transport http memgw $MCP_URL \\"
echo "     --header \"Authorization: Bearer $MEMGW_KEY_VAL\""
echo
echo " Connect claude.ai / Cowork (Settings -> Connectors -> Add custom connector):"
echo "   $MCP_URL/$MEMGW_SECRET_VAL"
echo
echo " ~/.memgw/env file for the hooks on each machine:"
echo "   MEMGW_URL=$BASE_URL"
echo "   MEMGW_KEY=$MEMGW_KEY_VAL"
echo "   MEMGW_SOURCE=cc-macbook   # change per machine"
echo
echo " Hook scripts live in $INSTALL_DIR/hooks/ (copy them to each client, see the README)."
echo " Write your first profile: nano $INSTALL_DIR/data/profile.md"
echo
if [ "$LITESTREAM_ON" = 1 ]; then
  echo " Backup: Litestream is streaming to R2. Restore when needed:"
  echo "   litestream restore -config /etc/litestream.yml $INSTALL_DIR/data/memgw.db"
else
  echo " Backup: Litestream is NOT enabled. Add the 4 R2_* variables to the install"
  echo "   command and re-run (R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)."
fi
echo " Retention: events older than ${MEMGW_RETENTION_DAYS:-90} days are deleted automatically (facts and notes are kept forever)."
echo "============================================================"
exit 0
__ARCHIVE__
