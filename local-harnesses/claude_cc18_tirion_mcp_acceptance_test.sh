#!/usr/bin/env bash
set -euo pipefail
umask 077

# Interactive CC-18 normal-Tirion acceptance wrapper. It invokes the fixed
# local MCP fixture, then compares only bounded count summaries from Tirion's
# already privacy-safe runs and diagnostics APIs. Temporary mode-0600 snapshots
# are deleted on exit; the wrapper prints no prompts, raw IDs, paths, tool
# arguments, or tool responses.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
FIXTURE="$SCRIPT_DIR/claude_cc18_local_mcp_test.sh"
ASSERTION="$SCRIPT_DIR/claude_cc18_tirion_mcp_acceptance_assert.mjs"
MODE="${1:-}"
TIRIONCTL="${TIRION_CC18_TIRIONCTL:-tirionctl}"
RUN_LIMIT="${TIRION_CC18_ACCEPTANCE_RUN_LIMIT:-50}"
LOG_LIMIT="${TIRION_CC18_ACCEPTANCE_LOG_LIMIT:-1000}"
TIMEOUT_SECONDS="${TIRION_CC18_ACCEPTANCE_TIMEOUT_SECONDS:-45}"

fail() {
  printf 'CC18 Tirion MCP acceptance failed: %s\n' "$1" >&2
  exit 1
}

case "$MODE" in
  success|failure) ;;
  *) fail "usage: $0 <success|failure>" ;;
esac

[[ -t 0 && -t 1 ]] || fail "interactive_tty_required"
[[ -x "$FIXTURE" && ! -L "$FIXTURE" && -f "$ASSERTION" && ! -L "$ASSERTION" ]] || fail "fixture_or_assertion_missing"
command -v node >/dev/null 2>&1 || fail "node_missing"
if [[ "$TIRIONCTL" == */* ]]; then
  [[ -x "$TIRIONCTL" && ! -L "$TIRIONCTL" ]] || fail "tirionctl_missing"
else
  command -v "$TIRIONCTL" >/dev/null 2>&1 || fail "tirionctl_missing"
fi
for value in "$RUN_LIMIT" "$LOG_LIMIT" "$TIMEOUT_SECONDS"; do
  [[ "$value" =~ ^[0-9]+$ ]] || fail "numeric_setting_invalid"
done
(( RUN_LIMIT >= 1 && RUN_LIMIT <= 200 )) || fail "run_limit_invalid"
(( LOG_LIMIT >= 1 && LOG_LIMIT <= 1000 )) || fail "log_limit_invalid"
(( TIMEOUT_SECONDS >= 10 && TIMEOUT_SECONDS <= 120 )) || fail "timeout_invalid"

TMP_PARENT="${TMPDIR:-/tmp}"
TMP_PARENT="${TMP_PARENT%/}"
ROOT="$(mktemp -d "$TMP_PARENT/tirion-cc18-acceptance.XXXXXX")" || fail "temporary_root_unavailable"
chmod 700 "$ROOT"
BEFORE_RUNS="$ROOT/before-runs.json"
AFTER_RUNS="$ROOT/after-runs.json"
BEFORE_LOGS="$ROOT/before-logs.json"
AFTER_LOGS="$ROOT/after-logs.json"
RESULT="$ROOT/result.safe.txt"

cleanup() {
  rm -rf -- "$ROOT"
}
trap cleanup EXIT HUP INT TERM

snapshot() {
  local kind="$1"
  local target="$2"
  local limit="$3"
  local payload
  if ! payload="$("$TIRIONCTL" "$kind" --limit "$limit" 2>/dev/null)"; then
    fail "tirionctl_${kind}_unavailable"
  fi
  (( ${#payload} >= 1 && ${#payload} <= 4194304 )) || fail "tirionctl_${kind}_snapshot_invalid"
  printf '%s\n' "$payload" >"$target"
  chmod 600 "$target"
}

snapshot runs "$BEFORE_RUNS" "$RUN_LIMIT"
snapshot logs "$BEFORE_LOGS" "$LOG_LIMIT"

"$FIXTURE" "$MODE"

DEADLINE=$((SECONDS + TIMEOUT_SECONDS))
while (( SECONDS <= DEADLINE )); do
  snapshot runs "$AFTER_RUNS" "$RUN_LIMIT"
  snapshot logs "$AFTER_LOGS" "$LOG_LIMIT"
  if node "$ASSERTION" \
    --mode "$MODE" \
    --before-runs "$BEFORE_RUNS" \
    --after-runs "$AFTER_RUNS" \
    --before-logs "$BEFORE_LOGS" \
    --after-logs "$AFTER_LOGS" \
    >"$RESULT" 2>/dev/null; then
    chmod 600 "$RESULT"
    sed -n '1p' "$RESULT"
    exit 0
  fi
  sleep 1
done

node "$ASSERTION" \
  --mode "$MODE" \
  --before-runs "$BEFORE_RUNS" \
  --after-runs "$AFTER_RUNS" \
  --before-logs "$BEFORE_LOGS" \
  --after-logs "$AFTER_LOGS"
exit 1
