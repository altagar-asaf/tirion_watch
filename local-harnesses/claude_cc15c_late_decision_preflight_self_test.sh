#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="$SCRIPT_DIR/claude_cc15c_late_decision_acceptance_test.sh"
ADMISSION_DIAGNOSTIC="$SCRIPT_DIR/claude_cc15c_admission_diagnostic.mjs"
STUB_DIR="$SCRIPT_DIR/test-fixtures/cc15c-preflight-bin"
TMP_PARENT="${TMPDIR:-/tmp}"
TMP_PARENT="${TMP_PARENT%/}"
ROOT="$(mktemp -d "$TMP_PARENT/tirion-cc15c-preflight.XXXXXX")"
MARKER="$ROOT/.tirion-cc15c-preflight"
: > "$MARKER"
chmod 600 "$MARKER"

fail() {
  printf 'cc15c private-profile preflight self-test failed: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  set +e
  if [[ -f "$MARKER" && "$ROOT" == "$TMP_PARENT"/tirion-cc15c-preflight.* ]]; then
    rm -rf -- "$ROOT"
  fi
}
trap cleanup EXIT

[[ -f "$HARNESS" && -f "$ADMISSION_DIAGNOSTIC" && -x "$STUB_DIR/claude" ]] || fail "fixtures_missing"
grep -q -F -- 'const noMatcher = new Set(["UserPromptSubmit", "Stop"]);' "$HARNESS" \
  || fail "hook_matcher_contract_missing"
grep -q -F -- '...(noMatcher.has(eventName) ? {} : { matcher: "*" })' "$HARNESS" \
  || fail "hook_matcher_contract_missing"
grep -q -F -- 'CLAUDE_CODE_ENABLE_TELEMETRY=1' "$HARNESS" \
  || fail "claude_process_telemetry_missing"
grep -q -F -- 'OTEL_METRICS_INCLUDE_SESSION_ID=true' "$HARNESS" \
  || fail "claude_process_session_identity_missing"
grep -q -F -- 'agent_no_run_admission_diagnostic' "$HARNESS" \
  || fail "no_run_admission_diagnostic_missing"
grep -q -F -- 'terminal_baseline_missing_or_invalid_${BASELINE_DIAGNOSTIC}_${ADMISSION_DIAGNOSTIC}' "$HARNESS" \
  || fail "no_run_admission_diagnostic_missing"
grep -q -F -- 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT="$RELAY_BASE/v1/logs"' "$HARNESS" \
  || fail "claude_process_telemetry_missing"
grep -q -F -- 'OTEL_EXPORTER_OTLP_LOGS_HEADERS="Authorization=Bearer $OTLP_TOKEN,X-Tirion-CC15C-Relay=$RELAY_TOKEN"' "$HARNESS" \
  || fail "claude_process_signal_header_isolation_missing"
grep -q -F -- 'OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Bearer $OTLP_TOKEN,X-Tirion-CC15C-Relay=$RELAY_TOKEN"' "$HARNESS" \
  || fail "claude_process_signal_header_isolation_missing"
grep -q -F -- 'OTEL_EXPORTER_OTLP_LOGS_COMPRESSION=none' "$HARNESS" \
  || fail "claude_process_compression_isolation_missing"
grep -q -F -- 'OTEL_EXPORTER_OTLP_TRACES_COMPRESSION=none' "$HARNESS" \
  || fail "claude_process_compression_isolation_missing"
grep -q -F -- 'TIRION_CC15C_PROMPT_MODE=interactive' "$HARNESS" \
  || fail "interactive_prompt_mode_documentation_missing"
grep -q -F -- 'interactive_terminal_required' "$HARNESS" \
  || fail "interactive_terminal_guard_missing"
grep -q -F -- 'submit the controlled prompt supplied outside this script' "$HARNESS" \
  || fail "interactive_prompt_boundary_missing"
grep -q -F -- 'if [[ "$PROMPT_MODE" == "noninteractive" ]]; then' "$HARNESS" \
  || fail "interactive_budget_isolation_missing"
INTERACTIVE_BRANCH="$(sed -n '/CC15C interactive mode:/,/^  else$/p' "$HARNESS")"
[[ "$INTERACTIVE_BRANCH" == *'claude_private_profile'* ]] \
  || fail "interactive_claude_launch_missing"
if grep -Eq -- '(^|[[:space:]])-p([[:space:]]|$)|--output-format|--max-budget-usd|PROMPT=' <<<"$INTERACTIVE_BRANCH"; then
  fail "interactive_print_mode_leak"
fi
HOME_ROOT="$ROOT/fake-home"
HARNESS_TMP="$ROOT/harness-tmp"
EXTERNAL="$ROOT/external/tw-cc15c-claude.abcdef"
mkdir -p "$HOME_ROOT/.claude" "$HARNESS_TMP" "$EXTERNAL"
chmod 700 "$HOME_ROOT" "$HOME_ROOT/.claude" "$HARNESS_TMP" "$EXTERNAL"
ln -s "$EXTERNAL" "$HOME_ROOT/caller-link"
ln -s "$EXTERNAL" "$ROOT/tw-cc15c-claude.ghijkl"

run_case() {
  local name="$1" expected="$2" private_root="$3" caller_root="$4" budget="${5:-0.15}"
  local agent_entry="${6:-$HARNESS}" tirionctl_bin="${7:-}" prompt_mode="${8:-noninteractive}"
  local stdout="$ROOT/$name.stdout" stderr="$ROOT/$name.stderr" status
  set +e
  PATH="$STUB_DIR:$PATH" \
  HOME="$HOME_ROOT" \
  TMPDIR="$HARNESS_TMP" \
  CLAUDE_CONFIG_DIR="$caller_root" \
  TIRION_CC15C_CLAUDE_CONFIG_DIR="$private_root" \
  TIRION_CC15C_CLAUDE_MODEL="claude-fable-5" \
  TIRION_CC15C_MAX_BUDGET_USD="$budget" \
  TIRION_CC15C_PROMPT_MODE="$prompt_mode" \
  TIRION_CC15C_AGENT_ENTRY="$agent_entry" \
  TIRION_CC15C_TIRIONCTL="$tirionctl_bin" \
    bash "$HARNESS" >"$stdout" 2>"$stderr"
  status="$?"
  set -e
  [[ "$status" -ne 0 ]] || fail "$name unexpectedly_succeeded"
  grep -q -F -- "CC15C acceptance failed: $expected" "$stderr" || fail "$name unexpected_failure"
}

run_case "caller_symlink" "private_claude_config_invalid_root_overlap" "$EXTERNAL" "$HOME_ROOT/caller-link"
run_case "private_symlink" "private_claude_config_invalid_root_layout" "$ROOT/tw-cc15c-claude.ghijkl" "$HOME_ROOT/.claude"

ROOT_MODE="$ROOT/external/tw-cc15c-claude.rootmode"
mkdir -p "$ROOT_MODE"
chmod 755 "$ROOT_MODE"
run_case "private_root_mode" "private_claude_config_invalid_root_permissions" "$ROOT_MODE" "$HOME_ROOT/.claude"

ANCESTOR="$HOME_ROOT/tw-cc15c-claude.klmnop"
DESCENDANT="$HOME_ROOT/.claude/tw-cc15c-claude.qrstuv"
mkdir -p "$ANCESTOR" "$DESCENDANT"
chmod 700 "$ANCESTOR" "$DESCENDANT"
run_case "home_ancestor" "private_claude_config_invalid_root_overlap" "$ANCESTOR" "$HOME_ROOT/.claude"
run_case "normal_descendant" "private_claude_config_invalid_root_overlap" "$DESCENDANT" "$HOME_ROOT/.claude"
run_case "invalid_budget" "invalid_max_budget_usd" "$EXTERNAL" "$HOME_ROOT/.claude" "999"
run_case "invalid_prompt_mode" "invalid_prompt_mode" "$EXTERNAL" "$HOME_ROOT/.claude" "0.15" "$HARNESS" "" "unsupported"
run_case "interactive_requires_tty" "interactive_terminal_required" "$EXTERNAL" "$HOME_ROOT/.claude" "0.15" "$HARNESS" "" "interactive"
TIRION_CC15C_QUIESCE_TIMEOUT_MS=99 \
  run_case "invalid_quiesce_timeout" "invalid_quiesce_timeout_ms" "$EXTERNAL" "$HOME_ROOT/.claude"
run_case "fresh_external_profile" "private_claude_profile_not_authenticated" "$EXTERNAL" "$HOME_ROOT/.claude"

NORMAL_UNRELATED_LINK_TARGET="$ROOT/normal-link-unrelated"
mkdir -p "$NORMAL_UNRELATED_LINK_TARGET"
: > "$NORMAL_UNRELATED_LINK_TARGET/safe-metadata-only-file"
ln -s "$NORMAL_UNRELATED_LINK_TARGET" "$HOME_ROOT/.claude/unrelated-directory-link"
run_case "normal_nested_unrelated_symlink" "private_claude_profile_not_authenticated" "$EXTERNAL" "$HOME_ROOT/.claude"
rm "$HOME_ROOT/.claude/unrelated-directory-link"

NORMAL_CYCLE_A="$ROOT/normal-link-cycle-a"
NORMAL_CYCLE_B="$ROOT/normal-link-cycle-b"
mkdir -p "$NORMAL_CYCLE_A" "$NORMAL_CYCLE_B"
ln -s "$NORMAL_CYCLE_B" "$NORMAL_CYCLE_A/to-b"
ln -s "$NORMAL_CYCLE_A" "$NORMAL_CYCLE_B/to-a"
ln -s "$NORMAL_CYCLE_A" "$HOME_ROOT/.claude/cycle-link"
run_case "normal_nested_symlink_cycle" "private_claude_profile_not_authenticated" "$EXTERNAL" "$HOME_ROOT/.claude"
rm "$HOME_ROOT/.claude/cycle-link"

NESTED_LINK_ROOT="$ROOT/external/tw-cc15c-claude.nestedlink"
mkdir -p "$NESTED_LINK_ROOT"
chmod 700 "$NESTED_LINK_ROOT"
ln -s "$HOME_ROOT/.claude" "$NESTED_LINK_ROOT/credentials-link"
run_case "nested_private_symlink" "private_claude_config_invalid_private_tree_layout" "$NESTED_LINK_ROOT" "$HOME_ROOT/.claude"

NESTED_PROJECT_LINK_ROOT="$ROOT/external/tw-cc15c-claude.projectlink"
mkdir -p "$NESTED_PROJECT_LINK_ROOT/projects"
chmod 700 "$NESTED_PROJECT_LINK_ROOT" "$NESTED_PROJECT_LINK_ROOT/projects"
ln -s "$HOME_ROOT/.claude" "$NESTED_PROJECT_LINK_ROOT/projects/escaped-child"
run_case "nested_projects_symlink" "private_claude_config_invalid_private_tree_layout" "$NESTED_PROJECT_LINK_ROOT" "$HOME_ROOT/.claude"

NESTED_MODE_ROOT="$ROOT/external/tw-cc15c-claude.nestedmode"
mkdir -p "$NESTED_MODE_ROOT/created-by-claude"
chmod 700 "$NESTED_MODE_ROOT"
chmod 755 "$NESTED_MODE_ROOT/created-by-claude"
run_case "nested_private_directory_mode" "private_claude_config_invalid_private_tree_permissions" "$NESTED_MODE_ROOT" "$HOME_ROOT/.claude"

NORMAL_PROFILE_FILE="$HOME_ROOT/.claude/normal-profile-file"
: > "$NORMAL_PROFILE_FILE"
chmod 600 "$NORMAL_PROFILE_FILE"
HARD_LINK_ROOT="$ROOT/external/tw-cc15c-claude.hardlink"
mkdir -p "$HARD_LINK_ROOT"
chmod 700 "$HARD_LINK_ROOT"
ln "$NORMAL_PROFILE_FILE" "$HARD_LINK_ROOT/linked-credential"
run_case "private_hard_link" "private_claude_config_invalid_private_tree_layout" "$HARD_LINK_ROOT" "$HOME_ROOT/.claude"

FAILURE_NORMAL_MUTATION="$HOME_ROOT/.claude/failure-path-mutation"
TIRION_CC15C_STUB_AUTHENTICATED=1 \
TIRION_CC15C_STUB_MUTATE_NORMAL="$FAILURE_NORMAL_MUTATION" \
  run_case \
    "failure_path_normal_profile" \
    "agent_otlp_token_missing" \
    "$EXTERNAL" \
    "$HOME_ROOT/.claude" \
    "0.15" \
    "$SCRIPT_DIR/test-fixtures/cc15c-preflight-agent.mjs" \
    "$SCRIPT_DIR/test-fixtures/cc15c-preflight-tirionctl.js"
grep -q -F -- "CC15C acceptance failed: normal_claude_profile_metadata_changed" \
  "$ROOT/failure_path_normal_profile.stderr" || fail "failure_path_profile_check_missing"

ln -s "$EXTERNAL" "$HOME_ROOT/.claude/private-profile-alias"
run_case "normal_nested_private_alias" "private_claude_config_invalid_normal_profile_alias" "$EXTERNAL" "$HOME_ROOT/.claude"
rm "$HOME_ROOT/.claude/private-profile-alias"

NORMAL_SYMLINK_HOP="$ROOT/normal-symlink-hop"
ln -s "$EXTERNAL" "$NORMAL_SYMLINK_HOP"
ln -s "$NORMAL_SYMLINK_HOP" "$HOME_ROOT/.claude/indirect-private-link"
run_case "normal_indirect_private_alias" "private_claude_config_invalid_normal_profile_alias" "$EXTERNAL" "$HOME_ROOT/.claude"
rm "$HOME_ROOT/.claude/indirect-private-link"

NORMAL_LINK_BRIDGE="$ROOT/normal-link-bridge"
mkdir -p "$NORMAL_LINK_BRIDGE"
ln -s "$EXTERNAL" "$NORMAL_LINK_BRIDGE/private-profile-alias"
ln -s "$NORMAL_LINK_BRIDGE" "$HOME_ROOT/.claude/chained-link"
run_case "normal_chained_private_alias" "private_claude_config_invalid_normal_profile_alias" "$EXTERNAL" "$HOME_ROOT/.claude"
rm "$HOME_ROOT/.claude/chained-link"

ln -s "$EXTERNAL" "$HOME_ROOT/.claude.json"
run_case "normal_companion_private_alias" "private_claude_config_invalid_normal_profile_alias" "$EXTERNAL" "$HOME_ROOT/.claude"
rm "$HOME_ROOT/.claude.json"

PROXY_CAPTURE="$ROOT/proxy-capture"
TIRION_CC15C_STUB_CAPTURE="$PROXY_CAPTURE" \
HTTP_PROXY="http://198.51.100.10:8080" \
HTTPS_PROXY="http://198.51.100.11:8080" \
NO_PROXY="existing-upper.invalid" \
no_proxy="existing-lower.invalid" \
ANTHROPIC_API_KEY="synthetic-api-key-must-not-reach-private-profile" \
ANTHROPIC_AUTH_TOKEN="synthetic-auth-token-must-not-reach-private-profile" \
CLAUDE_CODE_OAUTH_TOKEN="synthetic-oauth-token-must-not-reach-private-profile" \
  run_case "proxy_bypass_and_auth_isolation" "private_claude_profile_not_authenticated" "$EXTERNAL" "$HOME_ROOT/.claude"
[[ -f "$PROXY_CAPTURE" ]] || fail "proxy_capture_missing"
for required in 127.0.0.1 localhost ::1 existing-upper.invalid existing-lower.invalid; do
  grep -q -F -- "$required" "$PROXY_CAPTURE" || fail "proxy_bypass_missing_$required"
done
grep -q -F -- "CLAUDE_CONFIG_DIR=$EXTERNAL" "$PROXY_CAPTURE" || fail "private_config_not_applied"
for cleared in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN; do
  grep -q -x -F -- "$cleared=" "$PROXY_CAPTURE" || fail "ambient_auth_not_cleared_$cleared"
done

printf 'cc15c private-profile preflight self-test passed\n'
