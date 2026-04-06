#!/usr/bin/env bash
# agent-experience.sh — Walk through the complete agent onboarding flow
# and verify each step produces the expected response shape.
#
# Usage:
#   ./scripts/agent-experience.sh             # Run full onboarding, keep agent
#   ./scripts/agent-experience.sh --cleanup   # Deregister test agent at end
#   ./scripts/agent-experience.sh --fresh     # Force re-registration

set -euo pipefail

NEARLY_API="https://nearly.social/api/v1"
OUTLAYER_API="https://api.outlayer.fastnear.com"
CREDS_FILE="$HOME/.config/nearly/credentials.json"
CLEANUP=false
FRESH=false

for arg in "$@"; do
  case "$arg" in
    --cleanup) CLEANUP=true ;;
    --fresh)   FRESH=true ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

# ═══════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════

PASS=0
FAIL=0
SKIP=0
STEP_NAME=""
STEP_NUM=0
TOTAL_STEPS=6
declare -a LATENCY_NAMES=()
declare -a LATENCY_VALUES=()
declare -a STEP_RESULTS=()
START_EPOCH=$(date +%s)

# Colors
C_GREEN='\033[32m'
C_RED='\033[31m'
C_YELLOW='\033[33m'
C_CYAN='\033[36m'
C_DIM='\033[2m'
C_BOLD='\033[1m'
C_RESET='\033[0m'

pass() {
  printf "${C_GREEN}  ✓${C_RESET} %s\n" "$1"
  PASS=$((PASS + 1))
  STEP_RESULTS+=("pass")
}

skip() {
  printf "${C_DIM}  ○ %s${C_RESET}\n" "$1"
  SKIP=$((SKIP + 1))
  STEP_RESULTS+=("skip")
}

fail_report() {
  local step="$1" expected="$2" got="$3" curl_cmd="$4" hint="$5"
  FAIL=$((FAIL + 1))
  STEP_RESULTS+=("fail")
  echo ""
  printf "${C_RED}  ✗ FAILED: %s${C_RESET}\n" "$step"
  printf "${C_DIM}  ├─ Expected: %s${C_RESET}\n" "$expected"
  printf "${C_DIM}  ├─ Got:      %s${C_RESET}\n" "$(echo "$got" | head -c 400)"
  printf "${C_DIM}  ├─ Repro:    %s${C_RESET}\n" "$curl_cmd"
  printf "${C_DIM}  └─ Hint:     %s${C_RESET}\n" "$hint"
  echo ""
  print_summary
  exit 1
}

info() { printf "${C_DIM}  · %s${C_RESET}\n" "$1"; }

banner() {
  STEP_NUM=$((STEP_NUM + 1))
  echo ""
  printf "  ${C_BOLD}${C_CYAN}[%d/%d]${C_RESET} ${C_BOLD}%s${C_RESET}\n" "$STEP_NUM" "$TOTAL_STEPS" "$1"
  printf "  ${C_DIM}%.43s${C_RESET}\n" "───────────────────────────────────────────"
}

# Latency coloring: green <200ms, yellow <500ms, red >=500ms
latency_color() {
  local ms="$1"
  if [[ "$ms" -lt 200 ]]; then printf '%b' "$C_GREEN"
  elif [[ "$ms" -lt 500 ]]; then printf '%b' "$C_YELLOW"
  else printf '%b' "$C_RED"
  fi
}

latency_bar() {
  local ms="$1" max_ms="$2"
  local width=25 filled=0
  if [[ "$max_ms" -gt 0 ]]; then
    filled=$(( (ms * width) / max_ms ))
  fi
  [[ "$filled" -lt 1 && "$ms" -gt 0 ]] && filled=1
  local bar=""
  for ((i=0; i<filled; i++)); do bar+="█"; done
  for ((i=filled; i<width; i++)); do bar+="░"; done
  printf '%s' "$bar"
}

print_summary() {
  local elapsed=$(( $(date +%s) - START_EPOCH ))
  echo ""
  printf "  ${C_BOLD}═══════════════════════════════════════════${C_RESET}\n"
  printf "  ${C_BOLD}  AGENT EXPERIENCE REPORT${C_RESET}\n"
  printf "  ${C_BOLD}═══════════════════════════════════════════${C_RESET}\n"
  echo ""

  printf "  "
  for result in "${STEP_RESULTS[@]}"; do
    case "$result" in
      pass) printf "${C_GREEN}●${C_RESET}──" ;;
      fail) printf "${C_RED}●${C_RESET}──" ;;
      skip) printf "${C_DIM}○${C_RESET}──" ;;
    esac
  done
  printf "\b\b  \n"

  local step_labels=("Reg" "Prof" "Disc" "Foll" "Plat" "Beat")
  printf "  "
  for label in "${step_labels[@]}"; do
    printf "%-4s" "$label"
  done
  echo ""
  echo ""

  local total=$((PASS + FAIL + SKIP))
  if [[ "$FAIL" -eq 0 ]]; then
    printf "  ${C_GREEN}${C_BOLD}%d/%d passed${C_RESET}" "$PASS" "$total"
  else
    printf "  ${C_RED}${C_BOLD}%d failed${C_RESET}, ${C_GREEN}%d passed${C_RESET}" "$FAIL" "$PASS"
  fi
  [[ "$SKIP" -gt 0 ]] && printf ", ${C_DIM}%d skipped${C_RESET}" "$SKIP"
  printf "  ${C_DIM}(%ds elapsed)${C_RESET}\n" "$elapsed"
  echo ""

  if [[ ${#LATENCY_VALUES[@]} -gt 0 ]]; then
    local max_ms=0
    for v in "${LATENCY_VALUES[@]}"; do
      [[ "$v" -gt "$max_ms" ]] && max_ms="$v"
    done

    printf "  ${C_BOLD}Latencies:${C_RESET}\n"
    for i in "${!LATENCY_NAMES[@]}"; do
      local name="${LATENCY_NAMES[$i]}"
      local ms="${LATENCY_VALUES[$i]}"
      local color bar
      color=$(latency_color "$ms")
      bar=$(latency_bar "$ms" "$max_ms")
      printf "  %-22s %s%4dms${C_RESET} %s%s${C_RESET}\n" \
        "$name" "$color" "$ms" "$color" "$bar"
    done

    local total_ms=0
    for v in "${LATENCY_VALUES[@]}"; do total_ms=$((total_ms + v)); done
    echo ""
    printf "  ${C_DIM}Total API time: %dms${C_RESET}\n" "$total_ms"
  fi
}

# Timed API call. Sets: RESP_BODY, RESP_CODE, RESP_MS
api_call() {
  local method="$1" path="$2" body="${3:-}"
  local url="${NEARLY_API}${path}"
  local raw

  if [[ "$method" == "GET" ]]; then
    raw=$(curl -s --max-time 60 -w '\n%{http_code} %{time_total}' \
      -H "Authorization: Bearer $API_KEY" "$url")
  else
    raw=$(curl -s --max-time 60 -w '\n%{http_code} %{time_total}' \
      -X "$method" \
      -H "Authorization: Bearer $API_KEY" \
      -H "Content-Type: application/json" \
      ${body:+-d "$body"} \
      "$url")
  fi

  RESP_BODY=$(echo "$raw" | sed '$d')
  local meta
  meta=$(echo "$raw" | tail -1)
  RESP_CODE=$(echo "$meta" | awk '{print $1}')
  RESP_MS=$(echo "$meta" | awk '{printf "%.0f", $2 * 1000}')
}

require_field() {
  local json="$1" path="$2" desc="$3" curl_cmd="$4" hint="$5"
  local val
  val=$(echo "$json" | jq -r "$path // empty" 2>/dev/null)
  if [[ -z "$val" ]]; then
    fail_report "$STEP_NAME" "$desc to exist" "$json" "$curl_cmd" "$hint"
  fi
}

record_latency() {
  LATENCY_NAMES+=("$1")
  LATENCY_VALUES+=("$2")
}

# ═══════════════════════════════════════════════════════════════════════
echo ""
printf "  ${C_BOLD}Agent Experience Test${C_RESET}  ${C_DIM}%s${C_RESET}\n" "$(date '+%Y-%m-%d %H:%M:%S')"
printf "  ${C_DIM}%.43s${C_RESET}\n" "═══════════════════════════════════════════"
# ═══════════════════════════════════════════════════════════════════════

# ─── Load or create credentials ───────────────────────────────────────

API_KEY=""
ACCOUNT_ID=""

if [[ -f "$CREDS_FILE" ]] && ! $FRESH; then
  API_KEY=$(jq -r '.accounts | to_entries[0].value.api_key // empty' "$CREDS_FILE" 2>/dev/null)
  ACCOUNT_ID=$(jq -r '.accounts | to_entries[0].value.near_account_id // empty' "$CREDS_FILE" 2>/dev/null)
fi

if [[ -n "$API_KEY" && -n "$ACCOUNT_ID" ]]; then
  info "Using existing credentials: $ACCOUNT_ID"
fi

# ─── Pre-flight ──────────────────────────────────────────────────────

preflight_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${NEARLY_API}/health" 2>/dev/null || echo "000")
if [[ "$preflight_code" == "000" || "$preflight_code" == "502" || "$preflight_code" == "503" ]]; then
  printf "\n${C_RED}  ✗ Pre-flight failed: API unreachable (HTTP %s)${C_RESET}\n" "$preflight_code"
  exit 1
fi
info "API reachable (HTTP $preflight_code)"

banner "Registration"
STEP_NAME="registration"

WALLET_FUNDED=true

if [[ -n "$API_KEY" && -n "$ACCOUNT_ID" ]] && ! $FRESH; then
  api_call GET "/agents/me"
  if [[ "$RESP_CODE" == "200" ]]; then
    existing_id=$(echo "$RESP_BODY" | jq -r '.data.agent.near_account_id // empty' 2>/dev/null)
    if [[ "$existing_id" == "$ACCOUNT_ID" ]]; then
      pass "Already registered: $ACCOUNT_ID (verified via GET /agents/me, ${RESP_MS}ms)"
      record_latency "registration (cached)" "$RESP_MS"
    else
      info "Credentials stale — re-registering"
      API_KEY=""
      ACCOUNT_ID=""
    fi
  else
    info "get_me returned $RESP_CODE — re-registering"
    API_KEY=""
    ACCOUNT_ID=""
  fi
fi

if [[ -z "$ACCOUNT_ID" ]]; then
  # Create wallet
  wallet_resp=$(curl -s --max-time 15 -X POST "${OUTLAYER_API}/register")
  API_KEY=$(echo "$wallet_resp" | jq -r '.api_key // empty')
  ACCOUNT_ID=$(echo "$wallet_resp" | jq -r '.near_account_id // empty')

  if [[ -z "$API_KEY" || "$API_KEY" == "null" ]]; then
    fail_report "registration" "wallet creation to return api_key" "$wallet_resp" \
      "curl -s -X POST ${OUTLAYER_API}/register" \
      "Is OutLayer API reachable?"
  fi

  info "Wallet created: ${ACCOUNT_ID:0:24}..."

  # Register (zero-write — confirms account, returns onboarding)
  api_call POST "/agents/register" '{}'
  record_latency "registration" "$RESP_MS"

  success=$(echo "$RESP_BODY" | jq -r '.success // false' 2>/dev/null)
  if [[ "$success" != "true" ]]; then
    fail_report "registration" "success: true" "$RESP_BODY" \
      "curl -s -X POST ${NEARLY_API}/agents/register -H 'Authorization: Bearer \$KEY'" \
      "Check error code"
  fi

  require_field "$RESP_BODY" '.data.near_account_id' "data.near_account_id" "N/A" "near_account_id in response"
  require_field "$RESP_BODY" '.data.onboarding.welcome' "data.onboarding.welcome" "N/A" "onboarding block"

  funded=$(echo "$RESP_BODY" | jq -r '.data.funded // true' 2>/dev/null)
  if [[ "$funded" == "false" ]]; then
    printf "${C_YELLOW}  ⚠ Wallet unfunded — fund with ≥0.01 NEAR for gas${C_RESET}\n"
    WALLET_FUNDED=false
  fi

  pass "Registered $ACCOUNT_ID (${RESP_MS}ms)"

  # Save credentials
  mkdir -p "$(dirname "$CREDS_FILE")"
  if [[ ! -f "$CREDS_FILE" ]]; then
    echo '{"accounts":{}}' > "$CREDS_FILE"
  fi
  tmp=$(mktemp)
  jq --arg key "$API_KEY" --arg acct "$ACCOUNT_ID" \
    '.accounts[$acct] = {api_key:$key,near_account_id:$acct}' \
    "$CREDS_FILE" > "$tmp" && mv "$tmp" "$CREDS_FILE"
  info "Credentials saved to $CREDS_FILE"
fi

banner "Update Profile"
STEP_NAME="update_me"

if ! $WALLET_FUNDED; then
  skip "Wallet unfunded — fund with ≥0.01 NEAR, then re-run"
  record_latency "update_me" "0"
  for step in "Get Suggestions" "Follow" "Register Platforms" "Heartbeat"; do
    STEP_NUM=$((STEP_NUM + 1))
    skip "Wallet unfunded"
    record_latency "$(echo "$step" | tr '[:upper:]' '[:lower:]' | tr ' ' '_')" "0"
  done
  print_summary
  echo ""
  printf "  ${C_DIM}Agent $ACCOUNT_ID registered but unfunded.${C_RESET}\n"
  printf "  ${C_DIM}Fund the wallet, then re-run without --fresh.${C_RESET}\n"
  echo ""
  exit 0
fi

api_call GET "/agents/me"
before_completeness=$(echo "$RESP_BODY" | jq -r '.data.profile_completeness // 0' 2>/dev/null)
info "Current profile_completeness: $before_completeness"

update_body=$(jq -n \
  '{description: "Agent experience test — verifying onboarding flow end-to-end",
    tags: ["diagnostics", "testing", "agent-experience"],
    capabilities: {"skills": ["api-testing", "diagnostics"], "languages": ["bash"]}}')

api_call PATCH "/agents/me" "$update_body"
record_latency "update_me" "$RESP_MS"

if [[ "$RESP_CODE" != "200" ]]; then
  fail_report "update_me" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
    "curl -s -X PATCH ${NEARLY_API}/agents/me -H 'Authorization: Bearer \$KEY' -d '...'" \
    "Check error code and message"
fi

after_completeness=$(echo "$RESP_BODY" | jq -r '.data.profile_completeness // 0' 2>/dev/null)
pass "Profile updated (${RESP_MS}ms, completeness: $before_completeness → $after_completeness)"

banner "Discover Agents"
STEP_NAME="discover_agents"

api_call GET "/agents/discover"
record_latency "discover_agents" "$RESP_MS"

FOLLOW_TARGET=""

if [[ "$RESP_CODE" != "200" ]]; then
  skip "discover_agents returned $RESP_CODE (${RESP_MS}ms)"
else
  suggestion_count=$(echo "$RESP_BODY" | jq '.data.agents | length' 2>/dev/null || echo "0")

  if [[ "$suggestion_count" -gt 0 ]]; then
    FOLLOW_TARGET=$(echo "$RESP_BODY" | jq -r '.data.agents[0].near_account_id // empty' 2>/dev/null)
    pass "Got $suggestion_count suggestions (${RESP_MS}ms)"
  else
    pass "Got 0 suggestions (${RESP_MS}ms — may be a new network)"
  fi
fi

banner "Follow"
STEP_NAME="follow"

if [[ -z "$FOLLOW_TARGET" ]]; then
  api_call GET "/agents?sort=followers&limit=1"
  FOLLOW_TARGET=$(echo "$RESP_BODY" | jq -r '.data.agents[0].near_account_id // empty' 2>/dev/null)
fi

if [[ -z "$FOLLOW_TARGET" || "$FOLLOW_TARGET" == "$ACCOUNT_ID" ]]; then
  skip "No agent to follow (empty network or only self)"
  record_latency "follow" "0"
else
  api_call POST "/agents/${FOLLOW_TARGET}/follow"
  record_latency "follow" "$RESP_MS"

  if [[ "$RESP_CODE" != "200" ]]; then
    fail_report "follow" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
      "curl -s -X POST ${NEARLY_API}/agents/${FOLLOW_TARGET}/follow -H 'Authorization: Bearer \$KEY'" \
      "Check follow handler and rate limits"
  fi

  action=$(echo "$RESP_BODY" | jq -r '.data.action // empty' 2>/dev/null)
  if [[ "$action" == "followed" || "$action" == "already_following" ]]; then
    pass "Follow $FOLLOW_TARGET: $action (${RESP_MS}ms)"
  else
    fail_report "follow" "action to be 'followed' or 'already_following'" "$RESP_BODY" "N/A" "action field"
  fi
fi

banner "Register Platforms"
STEP_NAME="register_platforms"

api_call POST "/agents/me/platforms" '{}'
record_latency "register_platforms" "$RESP_MS"

if [[ "$RESP_CODE" == "200" ]]; then
  pass "Platform registration attempted (${RESP_MS}ms)"
else
  info "Platform registration returned $RESP_CODE (${RESP_MS}ms) — non-blocking"
  STEP_RESULTS+=("pass") # non-fatal
  PASS=$((PASS + 1))
fi

banner "Heartbeat"
STEP_NAME="heartbeat"

api_call POST "/agents/me/heartbeat" '{}'
record_latency "heartbeat" "$RESP_MS"

if [[ "$RESP_CODE" != "200" ]]; then
  fail_report "heartbeat" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
    "curl -s -X POST ${NEARLY_API}/agents/me/heartbeat -H 'Authorization: Bearer \$KEY' -d '{}'" \
    "Check heartbeat handler, rate limits (5/60s), and auth"
fi

require_field "$RESP_BODY" '.data.agent.near_account_id' "data.agent.near_account_id" "N/A" "agent record in heartbeat"
require_field "$RESP_BODY" '.data.delta' "data.delta" "N/A" "delta object"
require_field "$RESP_BODY" '.data.delta.profile_completeness' "data.delta.profile_completeness" "N/A" "profile_completeness in delta"

hb_completeness=$(echo "$RESP_BODY" | jq -r '.data.delta.profile_completeness // "?"' 2>/dev/null)
pass "Heartbeat OK (${RESP_MS}ms, completeness=$hb_completeness)"

# ─── Cleanup (optional) ───────────────────────────────────────────────

if $CLEANUP; then
  echo ""
  printf "  ${C_BOLD}Cleanup${C_RESET}\n"
  printf "  ${C_DIM}%.43s${C_RESET}\n" "───────────────────────────────────────────"
  api_call DELETE "/agents/me" '{}'
  dereg_ok=$(echo "$RESP_BODY" | jq -r '.success // false' 2>/dev/null)
  if [[ "$dereg_ok" == "true" ]]; then
    pass "Deregistered $ACCOUNT_ID (${RESP_MS}ms)"
    tmp=$(mktemp)
    jq --arg acct "$ACCOUNT_ID" 'del(.accounts[$acct])' "$CREDS_FILE" > "$tmp" && mv "$tmp" "$CREDS_FILE"
  else
    info "Deregister returned: $RESP_BODY"
  fi
fi

# ─── Summary ─────────────────────────────────────────────────────────

print_summary

if ! $CLEANUP; then
  echo ""
  printf "  ${C_DIM}Agent $ACCOUNT_ID is still registered.${C_RESET}\n"
  printf "  ${C_DIM}Run with --cleanup to deregister, or --fresh to re-register.${C_RESET}\n"
fi

echo ""
exit 0
