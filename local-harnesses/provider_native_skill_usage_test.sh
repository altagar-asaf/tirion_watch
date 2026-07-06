#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# Provider-native skill usage probe
#
# Captures Claude Code and Codex telemetry directly through OTLP/HTTP JSON.
# The probe installs one disposable skill per provider, runs a control prompt
# where the skill exists but is not invoked, then runs an explicit skill prompt.
# It bypasses Tirion and answers what the provider harnesses emit natively.
#
# Usage:
#   ./provider_native_skill_usage_test.sh
#
# Useful knobs:
#   TIRION_SKILL_PROBE_ROOT=/tmp/tirion-skill ./provider_native_skill_usage_test.sh
#   TIRION_SKILL_PROBE_SKIP_CLAUDE=1 ./provider_native_skill_usage_test.sh
#   TIRION_SKILL_PROBE_SKIP_CODEX=1 ./provider_native_skill_usage_test.sh
#   TIRION_SKILL_PROBE_CLAUDE_MODEL=sonnet ./provider_native_skill_usage_test.sh
#   TIRION_SKILL_PROBE_CODEX_MODEL=gpt-5.4-mini ./provider_native_skill_usage_test.sh
###############################################################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${TIRION_SKILL_PROBE_ROOT:-/tmp/tirion-native-skill-usage-test}"
PORT="${TIRION_SKILL_PROBE_PORT:-$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')}"
CLAUDE_MODEL="${TIRION_SKILL_PROBE_CLAUDE_MODEL:-}"
CODEX_MODEL="${TIRION_SKILL_PROBE_CODEX_MODEL:-gpt-5.4-mini}"

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

init_git_repo() {
  local repo="$1"
  mkdir -p "$repo"
  (
    cd "$repo"
    git init -q
    git config user.name "Tirion Skill Probe"
    git config user.email "tirion-skill-probe@example.test"
    printf "# Native Skill Usage Probe\n\nDisposable probe repo.\n" > README.md
    git add README.md
    git commit -q -m "initial skill probe repo"
  )
}

write_claude_skill() {
  local repo="$1"
  mkdir -p "$repo/.claude/skills/tirion-claude-skill-probe"
  cat > "$repo/.claude/skills/tirion-claude-skill-probe/SKILL.md" <<'EOF'
---
name: tirion-claude-skill-probe
description: Telemetry probe skill. Use when explicitly asked to run the Tirion Claude skill probe.
---

When this skill is active, reply exactly:
TIRION_CLAUDE_SKILL_PROBE_USED
EOF
}

write_codex_skill() {
  local repo="$1"
  mkdir -p "$repo/.agents/skills/tirion-codex-skill-probe/agents"
  cat > "$repo/.agents/skills/tirion-codex-skill-probe/SKILL.md" <<'EOF'
---
name: tirion-codex-skill-probe
description: Telemetry probe skill. Use only when explicitly invoked as $tirion-codex-skill-probe.
---

When this skill is active, reply exactly:
TIRION_CODEX_SKILL_PROBE_USED
EOF
  cat > "$repo/.agents/skills/tirion-codex-skill-probe/agents/openai.yaml" <<'EOF'
policy:
  allow_implicit_invocation: false
EOF
}

run_claude() {
  local run_id="$1"
  local prompt="$2"
  local allowed_tools="${3:-}"
  local repo="$ROOT/claude-repo"
  local args=(
    -p "$prompt"
    --output-format stream-json
    --verbose
    --permission-mode acceptEdits
    --max-turns 4
    --max-budget-usd 0.08
    --no-session-persistence
  )
  if [[ -n "$CLAUDE_MODEL" ]]; then
    args+=(--model "$CLAUDE_MODEL")
  fi
  if [[ -n "$allowed_tools" ]]; then
    args+=(--allowedTools "$allowed_tools")
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
    fail "Claude Code run failed: $run_id"
  }
  stop_receiver
  pass "Claude Code run completed: $run_id"
}

run_codex() {
  local run_id="$1"
  local prompt="$2"
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
    fail "Codex run failed: $run_id"
  }
  stop_receiver
  pass "Codex run completed: $run_id"
}

summarize() {
  node "$SCRIPT_DIR/summarize_provider_native_skill_usage.mjs" "$ROOT" > "$ROOT/provider-native-skill-summary.json"
  cat "$ROOT/provider-native-skill-summary.json"
}

require_command python3
require_command node
require_command git

rm -rf "$ROOT"
mkdir -p "$ROOT"

if [[ "${TIRION_SKILL_PROBE_SKIP_CLAUDE:-0}" != "1" ]]; then
  require_command claude
  init_git_repo "$ROOT/claude-repo"
  write_claude_skill "$ROOT/claude-repo"
  run_claude "claude-control" "A skill named tirion-claude-skill-probe exists in this repo, but do not invoke any slash command or skill. Reply exactly: TIRION_CLAUDE_CONTROL_DONE"
  run_claude "claude-slash-skill" "/tirion-claude-skill-probe"
  run_claude "claude-tool-skill" "Use the tirion-claude-skill-probe skill with the Skill tool, then follow it exactly." "Skill"
fi

if [[ "${TIRION_SKILL_PROBE_SKIP_CODEX:-0}" != "1" ]]; then
  require_command codex
  init_git_repo "$ROOT/codex-repo"
  write_codex_skill "$ROOT/codex-repo"
  run_codex "codex-control" "A skill named tirion-codex-skill-probe exists in this repo, but do not invoke or use any skill. Reply exactly: TIRION_CODEX_CONTROL_DONE"
  run_codex "codex-skill" 'Use $tirion-codex-skill-probe and follow it exactly.'
fi

summarize
pass "provider-native skill usage probe COMPLETE (root: $ROOT)"
