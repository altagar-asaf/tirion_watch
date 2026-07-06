#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# Provider-native activity surface probe
#
# Captures Claude Code and Codex telemetry directly through OTLP/HTTP JSON.
# This bypasses Tirion and answers what the provider CLIs emit natively in logs
# and traces. It is intentionally separate from the Tirion webhook lifecycle test.
#
# Usage:
#   ./provider_native_activity_surface_test.sh
#
# Useful knobs:
#   TIRION_NATIVE_PROBE_ROOT=/tmp/tirion-native-activity ./provider_native_activity_surface_test.sh
#   TIRION_NATIVE_PROBE_SKIP_CLAUDE=1 ./provider_native_activity_surface_test.sh
#   TIRION_NATIVE_PROBE_SKIP_CODEX=1 ./provider_native_activity_surface_test.sh
###############################################################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${TIRION_NATIVE_PROBE_ROOT:-/tmp/tirion-native-activity-surface-test}"
OTLP_DIR="$ROOT/otlp"
REPO="$ROOT/repo"
PORT="${TIRION_NATIVE_PROBE_PORT:-$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')}"
CLAUDE_MODEL="${TIRION_NATIVE_PROBE_CLAUDE_MODEL:-}"
CODEX_MODEL="${TIRION_NATIVE_PROBE_CODEX_MODEL:-gpt-5.4-mini}"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

cleanup() {
  set +e
  if [[ -n "${OTLP_PID:-}" ]]; then
    kill "$OTLP_PID" >/dev/null 2>&1 || true
    wait "$OTLP_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

run_claude_probe() {
  [[ "${TIRION_NATIVE_PROBE_SKIP_CLAUDE:-0}" != "1" ]] || return 0
  require_command claude
  local args=(
    -p "Read README.md with the Read tool, inspect the repository briefly, and answer with exactly: claude-native-probe-complete"
    --permission-mode acceptEdits
    --allowedTools Read,Glob
    --max-turns 4
    --max-budget-usd 0.05
  )
  if [[ -n "$CLAUDE_MODEL" ]]; then
    args+=(--model "$CLAUDE_MODEL")
  fi

  (
    cd "$REPO"
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
      OTEL_SERVICE_NAME=claude-code-native-probe \
      OTEL_LOG_USER_PROMPTS=0 \
      OTEL_LOG_TOOL_RESULTS=0 \
      OTEL_LOG_TOOL_DETAILS=1 \
      OTEL_METRIC_EXPORT_INTERVAL=1000 \
      OTEL_LOGS_EXPORT_INTERVAL=1000 \
      OTEL_TRACES_EXPORT_INTERVAL=1000 \
      claude "${args[@]}"
  ) >"$ROOT/claude.stdout.txt" 2>"$ROOT/claude.stderr.txt" || {
    cat "$ROOT/claude.stderr.txt" >&2 || true
    fail "Claude Code native OTel probe failed"
  }
  pass "Claude Code native OTel probe completed"
}

run_codex_probe() {
  [[ "${TIRION_NATIVE_PROBE_SKIP_CODEX:-0}" != "1" ]] || return 0
  require_command codex
  (
    cd "$REPO"
    codex exec \
      --ignore-rules \
      --skip-git-repo-check \
      -s read-only \
      -m "$CODEX_MODEL" \
      -c 'model_reasoning_effort="low"' \
      -c 'otel.environment="tirion-native-probe"' \
      -c 'otel.metrics_exporter="none"' \
      -c "otel.exporter={ otlp-http = { endpoint = \"http://127.0.0.1:${PORT}/v1/logs\", protocol = \"json\" } }" \
      -c "otel.trace_exporter={ otlp-http = { endpoint = \"http://127.0.0.1:${PORT}/v1/traces\", protocol = \"json\" } }" \
      "Run the shell command 'ls -la', inspect README.md, use the openaiDeveloperDocs MCP server to look up the Codex OpenTelemetry config docs, and answer with exactly: codex-native-probe-complete"
  ) >"$ROOT/codex.stdout.txt" 2>"$ROOT/codex.stderr.txt" || {
    cat "$ROOT/codex.stderr.txt" >&2 || true
    fail "Codex native OTel probe failed"
  }
  pass "Codex native OTel probe completed"
}

summarize() {
  node "$SCRIPT_DIR/summarize_provider_native_activity.mjs" "$OTLP_DIR" > "$ROOT/provider-native-summary.json"
  cat "$ROOT/provider-native-summary.json"
}

require_command python3
require_command node
require_command git

rm -rf "$ROOT"
mkdir -p "$OTLP_DIR" "$REPO"
cd "$REPO"
git init -q
git config user.name "Tirion Native Probe"
git config user.email "tirion-native-probe@example.test"
cat > README.md <<'EOF'
# Native Activity Surface Probe

This disposable repository is used to force simple tool usage while capturing
provider-native OTel logs and traces.
EOF
git add README.md
git commit -q -m "initial native probe repo"

node "$SCRIPT_DIR/otlp_capture_receiver.mjs" "$PORT" "$OTLP_DIR" >"$ROOT/receiver.stdout.txt" 2>"$ROOT/receiver.stderr.txt" &
OTLP_PID="$!"
sleep 1
kill -0 "$OTLP_PID" >/dev/null 2>&1 || fail "OTLP receiver did not start"
pass "OTLP JSON receiver started on http://127.0.0.1:${PORT}"

run_claude_probe
run_codex_probe
sleep 2
summarize
pass "provider-native activity surface probe COMPLETE (root: $ROOT)"
