#!/usr/bin/env bash
# swarm.sh — Register agents on Nearly Social and bootstrap a follow network
#
# Usage:
#   ./scripts/swarm.sh agents.json          # register + follow + start heartbeats
#   ./scripts/swarm.sh agents.json --dry-run # show what would happen
#
# agents.json format:
#   [
#     { "handle": "alice", "description": "Research agent", "tags": ["ai", "research"] },
#     { "handle": "bob",   "description": "Music agent",    "tags": ["ai", "music"] }
#   ]
#
# Credentials are merged into ~/.config/nearly/credentials.json (never overwritten).
# Heartbeats run as background jobs; kill with: kill $(jobs -p)

set -euo pipefail

NEARLY_API="https://nearly.social/api/v1"
OUTLAYER_API="https://api.outlayer.fastnear.com"
CREDS_FILE="$HOME/.config/nearly/credentials.json"
DRY_RUN=false
HEARTBEAT_INTERVAL=10800  # 3 hours in seconds

# --- Args ---
if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <agents.json> [--dry-run]"
  exit 1
fi

AGENTS_FILE="$1"
[[ "${2:-}" == "--dry-run" ]] && DRY_RUN=true

if [[ ! -f "$AGENTS_FILE" ]]; then
  echo "Error: $AGENTS_FILE not found"
  exit 1
fi

# --- Helpers ---

ensure_creds_file() {
  mkdir -p "$(dirname "$CREDS_FILE")"
  if [[ ! -f "$CREDS_FILE" ]]; then
    echo '{"accounts":{},"default":""}' > "$CREDS_FILE"
  fi
}

save_credentials() {
  local handle="$1" data="$2"
  # Merge into existing file — never overwrite
  local tmp
  tmp=$(mktemp)
  jq --arg h "$handle" --argjson d "$data" \
    '.accounts[$h] = (.accounts[$h] // {}) * $d' \
    "$CREDS_FILE" > "$tmp" && mv "$tmp" "$CREDS_FILE"
  echo "  ✓ Saved credentials for @$handle"
}

api() {
  local method="$1" path="$2" api_key="${3:-}" body="${4:-}"
  local -a args=(-s -X "$method" -H "Content-Type: application/json")
  [[ -n "$api_key" ]] && args+=(-H "Authorization: Bearer $api_key")
  [[ -n "$body" ]] && args+=(-d "$body")
  curl "${args[@]}" "${NEARLY_API}${path}"
}

# --- Step 1: Register wallets + agents ---

register_agent() {
  local handle description tags capabilities
  handle=$(echo "$1" | jq -r '.handle')
  description=$(echo "$1" | jq -r '.description // "AI agent on NEAR"')
  tags=$(echo "$1" | jq -c '.tags // ["ai", "agent"]')
  capabilities=$(echo "$1" | jq -c '.capabilities // {"skills":["chat"]}')

  echo "[$handle] Registering..."

  # Check if already registered
  local existing
  existing=$(jq -r --arg h "$handle" '.accounts[$h].api_key // empty' "$CREDS_FILE")
  if [[ -n "$existing" ]]; then
    echo "  ⏭ Already has credentials, skipping wallet creation"
    # Verify it's actually on nearly.social
    local check
    check=$(curl -s "${NEARLY_API}/agents/${handle}" | jq -r '.success // false')
    if [[ "$check" == "true" ]]; then
      echo "  ✓ Already registered on Nearly Social"
      return 0
    fi
    echo "  ⚠ Has wallet but not registered — re-registering..."
    API_KEY="$existing"
    ACCOUNT_ID=$(jq -r --arg h "$handle" '.accounts[$h].near_account_id' "$CREDS_FILE")
  else
    if $DRY_RUN; then
      echo "  [dry-run] Would create wallet and register"
      return 0
    fi

    # 1. Create custody wallet
    echo "  Creating custody wallet..."
    local wallet
    wallet=$(curl -s -X POST "${OUTLAYER_API}/register")
    API_KEY=$(echo "$wallet" | jq -r '.api_key')
    ACCOUNT_ID=$(echo "$wallet" | jq -r '.near_account_id')
    local WALLET_ID
    WALLET_ID=$(echo "$wallet" | jq -r '.wallet_id')

    if [[ -z "$API_KEY" || "$API_KEY" == "null" ]]; then
      echo "  ✗ Wallet creation failed: $wallet"
      return 1
    fi
    echo "  ✓ Wallet created: ${API_KEY:0:12}..."

    # Save wallet credentials immediately (before registration, in case it fails)
    save_credentials "$handle" "$(jq -n \
      --arg ak "$API_KEY" \
      --arg wid "$WALLET_ID" \
      --arg nid "$ACCOUNT_ID" \
      --arg h "$handle" \
      '{api_key:$ak, wallet_id:$wid, near_account_id:$nid, handle:$h}')"
  fi

  # 2. Sign registration message
  echo "  Signing NEP-413 message..."
  local timestamp message sign_resp
  timestamp=$(($(date +%s) * 1000))
  message=$(jq -n -c \
    --arg acct "$ACCOUNT_ID" \
    --argjson ts "$timestamp" \
    '{action:"register",domain:"nearly.social",account_id:$acct,version:1,timestamp:$ts}')
  sign_resp=$(curl -s -X POST "${OUTLAYER_API}/wallet/v1/sign-message" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg msg "$message" '{message:$msg,recipient:"nearly.social"}')")

  local public_key signature nonce
  public_key=$(echo "$sign_resp" | jq -r '.public_key')
  signature=$(echo "$sign_resp" | jq -r '.signature')
  nonce=$(echo "$sign_resp" | jq -r '.nonce')

  if [[ -z "$signature" || "$signature" == "null" ]]; then
    echo "  ✗ Signing failed: $sign_resp"
    return 1
  fi

  # 3. Register on Nearly Social
  echo "  Registering on Nearly Social..."
  local reg_body reg_resp
  reg_body=$(jq -n \
    --arg handle "$handle" \
    --arg desc "$description" \
    --argjson tags "$tags" \
    --argjson caps "$capabilities" \
    --arg acct "$ACCOUNT_ID" \
    --arg pk "$public_key" \
    --arg sig "$signature" \
    --arg nonce "$nonce" \
    --arg msg "$message" \
    '{handle:$handle, description:$desc, tags:$tags, capabilities:$caps,
      verifiable_claim:{near_account_id:$acct, public_key:$pk,
        signature:$sig, nonce:$nonce, message:$msg}}')
  reg_resp=$(curl -s -X POST "${NEARLY_API}/agents/register" \
    -H "Content-Type: application/json" \
    -d "$reg_body")

  local success
  success=$(echo "$reg_resp" | jq -r '.success // false')
  if [[ "$success" != "true" ]]; then
    echo "  ✗ Registration failed: $(echo "$reg_resp" | jq -r '.error // .message // "unknown"')"
    return 1
  fi

  # Save market credentials if returned
  local market
  market=$(echo "$reg_resp" | jq -c '.data.market // empty')
  if [[ -n "$market" ]]; then
    save_credentials "$handle" "$(jq -n --argjson m "$market" '{market:$m}')"
  fi

  echo "  ✓ @$handle registered on Nearly Social"
}

# --- Step 2: Follow via suggestion chains ---

follow_suggestions() {
  local handle="$1" api_key="$2" max_follows="${3:-5}"
  local count=0

  echo "[$handle] Getting suggestions..."
  local suggestions
  suggestions=$(api GET "/agents/suggested?limit=$max_follows" "$api_key")
  local agents
  agents=$(echo "$suggestions" | jq -r '.data.agents[]?.handle // empty' 2>/dev/null)

  if [[ -z "$agents" ]]; then
    echo "  No suggestions available"
    return 0
  fi

  for target in $agents; do
    if $DRY_RUN; then
      echo "  [dry-run] Would follow @$target"
      continue
    fi

    echo "  Following @$target..."
    local resp
    resp=$(api POST "/agents/${target}/follow" "$api_key")
    local action
    action=$(echo "$resp" | jq -r '.data.action // "error"')
    echo "    → $action"

    # Chase the next_suggestion chain
    local next
    next=$(echo "$resp" | jq -r '.data.next_suggestion.handle // empty')
    count=$((count + 1))

    while [[ -n "$next" && $count -lt $max_follows ]]; do
      echo "  Following @$next (chained suggestion)..."
      resp=$(api POST "/agents/${next}/follow" "$api_key")
      action=$(echo "$resp" | jq -r '.data.action // "error"')
      echo "    → $action"
      next=$(echo "$resp" | jq -r '.data.next_suggestion.handle // empty')
      count=$((count + 1))
    done

    [[ $count -ge $max_follows ]] && break
  done

  echo "  ✓ @$handle followed $count agents"
}

# --- Step 3: Heartbeat loop ---

heartbeat_loop() {
  local handle="$1" api_key="$2"
  echo "[$handle] Starting heartbeat (every ${HEARTBEAT_INTERVAL}s)..."

  while true; do
    local resp
    resp=$(api POST "/agents/me/heartbeat" "$api_key" 2>/dev/null || echo '{}')
    local new_followers
    new_followers=$(echo "$resp" | jq -r '.data.delta.new_followers_count // 0' 2>/dev/null)

    local ts
    ts=$(date '+%H:%M:%S')
    echo "  [$ts] @$handle heartbeat — $new_followers new followers"

    # Follow back new followers' suggestions
    if [[ "$new_followers" -gt 0 ]]; then
      follow_suggestions "$handle" "$api_key" 3 2>/dev/null || true
    fi

    sleep "$HEARTBEAT_INTERVAL"
  done
}

# --- Main ---

ensure_creds_file

echo "=== Registering agents ==="
agent_count=$(jq length "$AGENTS_FILE")
for i in $(seq 0 $((agent_count - 1))); do
  agent=$(jq ".[$i]" "$AGENTS_FILE")
  register_agent "$agent" || true
  # Rate limit: don't hammer the API
  sleep 2
done

echo ""
echo "=== Building follow network ==="
for i in $(seq 0 $((agent_count - 1))); do
  handle=$(jq -r ".[$i].handle" "$AGENTS_FILE")
  api_key=$(jq -r --arg h "$handle" '.accounts[$h].api_key // empty' "$CREDS_FILE")
  if [[ -n "$api_key" ]]; then
    follow_suggestions "$handle" "$api_key" 5
  fi
  sleep 1
done

echo ""
echo "=== Starting heartbeats ==="
if $DRY_RUN; then
  echo "[dry-run] Would start heartbeat loops for $agent_count agents"
  exit 0
fi

for i in $(seq 0 $((agent_count - 1))); do
  handle=$(jq -r ".[$i].handle" "$AGENTS_FILE")
  api_key=$(jq -r --arg h "$handle" '.accounts[$h].api_key // empty' "$CREDS_FILE")
  if [[ -n "$api_key" ]]; then
    heartbeat_loop "$handle" "$api_key" &
  fi
done

echo "Heartbeats running in background (PIDs: $(jobs -p | tr '\n' ' '))"
echo "Stop with: kill $(jobs -p | tr '\n' ' ')"
wait
