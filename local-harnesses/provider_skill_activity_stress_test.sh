#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# Provider skill activity stress test
#
# Runs real Claude Code and Codex prompts against disposable repo-scoped skills,
# captures provider-native OTLP, extracts Tirion-shaped skill activity, and
# verifies positive/negative expectations. This bypasses Tirion backend/webhooks.
#
# Usage:
#   ./provider_skill_activity_stress_test.sh
###############################################################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${TIRION_SKILL_STRESS_ROOT:-/tmp/tirion-skill-activity-stress-test}"
PORT="${TIRION_SKILL_STRESS_PORT:-$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')}"
CLAUDE_MODEL="${TIRION_SKILL_STRESS_CLAUDE_MODEL:-}"
CODEX_MODEL="${TIRION_SKILL_STRESS_CODEX_MODEL:-gpt-5.4-mini}"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

cleanup_receiver() {
  set +e
  if [[ -n "${OTLP_PID:-}" ]]; then
    kill "$OTLP_PID" >/dev/null 2>&1 || true
    wait "$OTLP_PID" >/dev/null 2>&1 || true
    unset OTLP_PID
  fi
}
trap cleanup_receiver EXIT

start_receiver() {
  local run_id="$1"
  local otlp_dir="$ROOT/$run_id/otlp"
  mkdir -p "$otlp_dir"
  cleanup_receiver
  node "$SCRIPT_DIR/otlp_capture_receiver.mjs" "$PORT" "$otlp_dir" >"$ROOT/$run_id/receiver.stdout.txt" 2>"$ROOT/$run_id/receiver.stderr.txt" &
  OTLP_PID="$!"
  sleep 1
  kill -0 "$OTLP_PID" >/dev/null 2>&1 || fail "OTLP receiver did not start for $run_id"
}

stop_receiver() {
  sleep 2
  cleanup_receiver
}

init_repo() {
  local repo="$1"
  mkdir -p "$repo"
  (
    cd "$repo"
    git init -q
    git config user.name "Tirion Skill Stress"
    git config user.email "tirion-skill-stress@example.test"
    cat > README.md <<'EOF'
# Checkout Buddy

This disposable app has a tiny checkout workflow and a README so coding agents
can inspect a realistic repository while a skill is available.
EOF
    mkdir -p src
    cat > src/checkout.ts <<'EOF'
export function checkoutTotal(subtotal: number, taxRate: number): number {
  return Math.round(subtotal * (1 + taxRate) * 100) / 100;
}
EOF
    git add README.md src/checkout.ts
    git commit -q -m "initial stress repo"
  )
}

write_claude_skill() {
  local repo="$1"
  mkdir -p "$repo/.claude/skills/tirion-claude-stress-skill"
  cat > "$repo/.claude/skills/tirion-claude-stress-skill/SKILL.md" <<'EOF'
---
name: tirion-claude-stress-skill
description: Use when asked for the Tirion Claude skill telemetry stress probe, skill telemetry proof, or skill activity verification.
---

When this skill is active, reply exactly:
TIRION_CLAUDE_STRESS_SKILL_USED
EOF
}

write_codex_skill() {
  local repo="$1"
  mkdir -p "$repo/.agents/skills/tirion-codex-stress-skill"
  cat > "$repo/.agents/skills/tirion-codex-stress-skill/SKILL.md" <<'EOF'
---
name: tirion-codex-stress-skill
description: Use when asked for the Tirion Codex skill telemetry stress probe, skill telemetry proof, or skill activity verification.
---

When this skill is active, reply exactly:
TIRION_CODEX_STRESS_SKILL_USED
EOF
}

extract_and_verify() {
  local run_id="$1"
  local expected_count="$2"
  local expected_name="$3"
  node "$SCRIPT_DIR/tirion_activity_extractor.mjs" "$ROOT/$run_id/otlp" > "$ROOT/$run_id/activity.json"
  node - "$ROOT/$run_id/activity.json" "$expected_count" "$expected_name" <<'NODE'
const [path, expectedCountRaw, expectedName] = process.argv.slice(2);
const result = JSON.parse(require("fs").readFileSync(path, "utf8"));
const expectedCount = Number(expectedCountRaw);
const matching = result.activity.filter((item) => item.kind === "skill" && (!expectedName || item.name === expectedName));
if (matching.length !== expectedCount) {
  console.error(JSON.stringify({ path, expectedCount, expectedName, activity: result.activity }, null, 2));
  process.exit(1);
}
if (matching.some((item) => item.outcome !== "success")) {
  console.error(JSON.stringify({ path, error: "expected only successful skill activity", matching }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ path, expectedCount, observed: matching.map((item) => ({
  provider: item.provider,
  kind: item.kind,
  name: item.name,
  outcome: item.outcome,
  basis: item.evidence.basis,
  signal: item.evidence.signal,
  timingConfidence: item.evidence.timingConfidence,
})) }, null, 2));
NODE
}

run_claude_case() {
  local run_id="$1"
  local expected_count="$2"
  local prompt="$3"
  local repo="$ROOT/claude-repo"
  local args=(
    -p "$prompt"
    --output-format stream-json
    --verbose
    --permission-mode acceptEdits
    --allowedTools Skill,Read
    --max-turns 6
    --max-budget-usd 0.12
    --no-session-persistence
  )
  if [[ -n "$CLAUDE_MODEL" ]]; then
    args+=(--model "$CLAUDE_MODEL")
  fi

  start_receiver "$run_id"
  (
    cd "$repo"
    env \
      CLAUDE_CODE_ENABLE_TELEMETRY=1 \
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1 \
      OTEL_METRICS_EXPORTER=otlp \
      OTEL_LOGS_EXPORTER=otlp \
      OTEL_TRACES_EXPORTER=otlp \
      OTEL_EXPORTER_OTLP_PROTOCOL=http/json \
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/json \
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json \
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json \
      OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:${PORT}" \
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT="http://127.0.0.1:${PORT}/v1/metrics" \
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT="http://127.0.0.1:${PORT}/v1/logs" \
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="http://127.0.0.1:${PORT}/v1/traces" \
      OTEL_SERVICE_NAME="$run_id" \
      OTEL_LOG_USER_PROMPTS=0 \
      OTEL_LOG_TOOL_RESULTS=0 \
      OTEL_LOG_TOOL_DETAILS=1 \
      OTEL_METRIC_EXPORT_INTERVAL=1000 \
      OTEL_LOGS_EXPORT_INTERVAL=1000 \
      OTEL_TRACES_EXPORT_INTERVAL=1000 \
      claude "${args[@]}"
  ) >"$ROOT/$run_id/stdout.jsonl" 2>"$ROOT/$run_id/stderr.txt" || {
    cat "$ROOT/$run_id/stderr.txt" >&2 || true
    fail "Claude Code stress case failed: $run_id"
  }
  stop_receiver
  extract_and_verify "$run_id" "$expected_count" "tirion-claude-stress-skill"
  pass "Claude Code stress case verified: $run_id"
}

run_codex_case() {
  local run_id="$1"
  local expected_count="$2"
  local prompt="$3"
  local repo="$ROOT/codex-repo"

  start_receiver "$run_id"
  (
    cd "$repo"
    codex exec \
      --json \
      --ephemeral \
      --ignore-rules \
      --skip-git-repo-check \
      -s read-only \
      -m "$CODEX_MODEL" \
      -c 'model_reasoning_effort="low"' \
      -c "otel.environment=\"$run_id\"" \
      -c 'otel.log_user_prompt=false' \
      -c "otel.exporter={ otlp-http = { endpoint = \"http://127.0.0.1:${PORT}/v1/logs\", protocol = \"json\" } }" \
      -c "otel.trace_exporter={ otlp-http = { endpoint = \"http://127.0.0.1:${PORT}/v1/traces\", protocol = \"json\" } }" \
      -c "otel.metrics_exporter={ otlp-http = { endpoint = \"http://127.0.0.1:${PORT}/v1/metrics\", protocol = \"json\" } }" \
      "$prompt"
  ) >"$ROOT/$run_id/stdout.jsonl" 2>"$ROOT/$run_id/stderr.txt" || {
    cat "$ROOT/$run_id/stderr.txt" >&2 || true
    fail "Codex stress case failed: $run_id"
  }
  stop_receiver
  extract_and_verify "$run_id" "$expected_count" "tirion-codex-stress-skill"
  pass "Codex stress case verified: $run_id"
}

require_command python3
require_command node
require_command git

rm -rf "$ROOT"
mkdir -p "$ROOT"

if [[ "${TIRION_SKILL_STRESS_SKIP_CLAUDE:-0}" != "1" ]]; then
  require_command claude
  init_repo "$ROOT/claude-repo"
  write_claude_skill "$ROOT/claude-repo"
  run_claude_case "claude-control" 0 "There is a Tirion Claude skill telemetry stress probe available, but do not use any skill. Briefly say what checkoutTotal does."
  run_claude_case "claude-natural-skill" 1 "Please run the Tirion Claude skill telemetry stress probe skill and follow its instructions exactly."
  run_claude_case "claude-user-task-skill" 1 "I need skill activity verification for Claude Code. Use the appropriate Tirion skill telemetry proof workflow if it is available, then follow it exactly."
fi

if [[ "${TIRION_SKILL_STRESS_SKIP_CODEX:-0}" != "1" ]]; then
  require_command codex
  init_repo "$ROOT/codex-repo"
  write_codex_skill "$ROOT/codex-repo"
  run_codex_case "codex-control" 0 "There is a Tirion Codex skill telemetry stress probe available, but do not use any skill. Briefly say what checkoutTotal does."
  run_codex_case "codex-natural-skill" 1 "Please run the Tirion Codex skill telemetry stress probe skill and follow its instructions exactly."
  run_codex_case "codex-user-task-skill" 1 "I need skill activity verification for Codex. Use the appropriate Tirion skill telemetry proof workflow if it is available, then follow it exactly."
fi

pass "provider skill activity stress test COMPLETE (root: $ROOT)"
