#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# Tirion local-server Cursor hook mimic lifecycle test
#
# Starts an isolated Tirion agent process, activates a disposable repo for
# Cursor, verifies managed Cursor hooks are written under a temp CURSOR_HOME,
# then mimics Cursor hook relay payloads by POSTing Cursor-shaped JSON directly
# to Tirion's local provider-hook endpoint.
#
# Covered:
# 1. Cursor source configuration is safe and local to the temp test home.
# 2. Cursor beforeSubmitPrompt -> afterAgentResponse -> activity -> stop hooks
#    produce run.start, run.update, and run.ended webhook events.
# 3. Token totals are preserved on run.update/run.ended; terminal activity
#    conserves those totals and keeps usage attribution explicit; usage value
#    and Cursor Composer catalog cost estimates are verified on run.ended.
# 4. Sensitive prompt, command, shell output, file path, and file content fields
#    do not leave the machine through webhooks.
# 5. A commit made from the mocked Cursor work is attributed to the Cursor run.
#
# Usage:
#   npm run compile
#   ./local-harnesses/tirion_local_server_cursor_hooks_lifecycle_test.sh
#
# Useful knobs:
#   TIRION_CURSOR_MIMIC_ROOT=/tmp/tirion-cursor-mimic ./local-harnesses/tirion_local_server_cursor_hooks_lifecycle_test.sh
#   TIRION_CURSOR_MIMIC_EVENT_TIMEOUT=180 ./local-harnesses/tirion_local_server_cursor_hooks_lifecycle_test.sh
#   TIRION_CURSOR_MIMIC_MODEL=gpt-5.4 TIRION_CURSOR_MIMIC_EXPECTED_NANO_USD=0 ./local-harnesses/tirion_local_server_cursor_hooks_lifecycle_test.sh
#   TIRION_TEST_TIRIONCTL="$PWD/packages/tirionctl/dist/main.js" ./local-harnesses/tirion_local_server_cursor_hooks_lifecycle_test.sh
#   TIRION_TEST_AGENT_ENTRY="$PWD/packages/agent/dist/main.js" ./local-harnesses/tirion_local_server_cursor_hooks_lifecycle_test.sh
###############################################################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ROOT="${TIRION_CURSOR_MIMIC_ROOT:-/tmp/tirion-cursor-mimic-test}"
EVENT_DIR="$ROOT/events"
CURSOR_REPO="$ROOT/cursor-repo"
CURSOR_HOME_DIR="$ROOT/cursor-home"
AGENT_STATE_DIR="$ROOT/agent-state"
AGENT_RUNTIME_DIR="$ROOT/runtime"
AGENT_SOCKET="$AGENT_RUNTIME_DIR/agent.sock"
EVENT_TIMEOUT="${TIRION_CURSOR_MIMIC_EVENT_TIMEOUT:-180}"
WEBHOOK_TOKEN="${TIRION_CURSOR_MIMIC_WEBHOOK_TOKEN:-tirion-cursor-mimic-token}"
WEBHOOK_SECRET="${TIRION_CURSOR_MIMIC_WEBHOOK_SECRET:-tirion-cursor-mimic-secret}"
CURSOR_MODEL="${TIRION_CURSOR_MIMIC_MODEL:-composer-2.5-fast}"
EXPECTED_CURSOR_NANO_USD="${TIRION_CURSOR_MIMIC_EXPECTED_NANO_USD:-9550000}"
BASELINE_SLEEP_SECONDS="${TIRION_CURSOR_MIMIC_BASELINE_SLEEP_SECONDS:-2}"
TIRIONCTL_BIN="${TIRION_TEST_TIRIONCTL:-$PROJECT_ROOT/packages/tirionctl/dist/main.js}"
AGENT_ENTRY="${TIRION_TEST_AGENT_ENTRY:-$PROJECT_ROOT/packages/agent/dist/main.js}"
NODE_BIN="${TIRION_TEST_NODE:-$(command -v node || true)}"
PYTHON_BIN="${TIRION_TEST_PYTHON:-$(command -v python3 || true)}"
CODEX_RUNTIME_ROOT="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"

if [[ -z "$NODE_BIN" && -x "$CODEX_RUNTIME_ROOT/node/bin/node" ]]; then
  NODE_BIN="$CODEX_RUNTIME_ROOT/node/bin/node"
fi
if [[ -z "$PYTHON_BIN" && -x "$CODEX_RUNTIME_ROOT/python/bin/python3" ]]; then
  PYTHON_BIN="$CODEX_RUNTIME_ROOT/python/bin/python3"
fi

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

protected_root() {
  case "$1" in
    ""|"/"|"/tmp"|"$HOME"|"$HOME/"|"/Users"|"/Users/") return 1 ;;
    *) return 0 ;;
  esac
}

tirionctl() {
  if [[ "$TIRIONCTL_BIN" == *.js ]]; then
    "$NODE_BIN" "$TIRIONCTL_BIN" "$@"
  else
    command "$TIRIONCTL_BIN" "$@"
  fi
}

run_agent_entry() {
  if [[ "$AGENT_ENTRY" == *.js ]]; then
    "$NODE_BIN" "$AGENT_ENTRY"
  else
    command "$AGENT_ENTRY"
  fi
}

assert_json() {
  local file="$1"; shift
  jq -e "$@" "$file" >/dev/null || {
    echo "Assertion failed for file: $file" >&2
    echo "jq args: $*" >&2
    cat "$file" >&2
    exit 1
  }
}

assert_no_forbidden_keys() {
  local file="$1"
  jq -e '
    reduce (.. | objects | keys_unsorted[]) as $k
      (true;
       . and ($k != "promptText") and ($k != "responseText") and
       ($k != "toolArguments") and ($k != "toolResults") and
       ($k != "fileContents") and ($k != "diff") and
       ($k != "absolutePath") and ($k != "rawTelemetry") and
       ($k != "executionTree") and ($k != "arguments") and ($k != "output"))
  ' "$file" >/dev/null || {
    echo "Forbidden keys detected in payload: $file" >&2
    cat "$file" >&2
    exit 1
  }
}

assert_no_forbidden_text() {
  local file="$1"; shift
  local needle
  for needle in "$@"; do
    [[ -n "$needle" ]] || continue
    if grep -F "$needle" "$file" >/dev/null 2>&1; then
      echo "Forbidden text leaked in payload: $needle" >&2
      cat "$file" >&2
      exit 1
    fi
  done
}

assert_trace_ids() {
  local file="$1"
  assert_json "$file" '(.traceIds | type) == "array" and (.traceIds | length) >= 1 and (.traceIds | all(.[]; type == "string" and length > 0))'
}

assert_cursor_run_cost() {
  local file="$1"
  if [[ "$EXPECTED_CURSOR_NANO_USD" -gt 0 ]]; then
    assert_json "$file" --argjson expected "$EXPECTED_CURSOR_NANO_USD" '.usageValueNanoUsd == $expected'
    assert_json "$file" --argjson expected "$EXPECTED_CURSOR_NANO_USD" '.estimatedNanoUsd == $expected'
    assert_json "$file" '.costEstimateBasis == "catalog_estimate"'
    assert_json "$file" '.costCoverage == "complete"'
  else
    assert_json "$file" '(.usageValueNanoUsd == null) or (.usageValueNanoUsd >= 0)'
    assert_json "$file" '(.estimatedNanoUsd == null) or (.estimatedNanoUsd == 0)'
    assert_json "$file" '.costEstimateBasis == "unavailable"'
    assert_json "$file" '.costCoverage == "unavailable"'
  fi
}

assert_cursor_commit_cost() {
  local file="$1"
  if [[ "$EXPECTED_CURSOR_NANO_USD" -gt 0 ]]; then
    assert_json "$file" --argjson expected "$EXPECTED_CURSOR_NANO_USD" '.usageValueNanoUsd == $expected'
    assert_json "$file" --argjson expected "$EXPECTED_CURSOR_NANO_USD" '.estimatedNanoUsd == $expected'
    assert_json "$file" '.costCoverage == "complete"'
  else
    assert_json "$file" '(.usageValueNanoUsd == null) or (.usageValueNanoUsd >= 0)'
    assert_json "$file" '(.estimatedNanoUsd == null) or (.estimatedNanoUsd == 0)'
    assert_json "$file" '.costCoverage == "unavailable"'
  fi
}

meta_for_event() {
  local body="$1"
  echo "${body%.body.json}.meta.json"
}

assert_request_metadata() {
  local body="$1" meta event_id
  meta="$(meta_for_event "$body")"
  [[ -f "$meta" ]] || fail "missing metadata file for $body"
  event_id="$(jq -r '.eventId' "$body")"
  assert_json "$meta" '.path == "/webhooks/tirion"'
  assert_json "$meta" --arg token "$WEBHOOK_TOKEN" '(.headers.Authorization // .headers.authorization) == ("Bearer " + $token)'
  assert_json "$meta" --arg event_id "$event_id" '
    (.headers["X-Tirion-Event-Id"] // .headers["x-tirion-event-id"]) == $event_id
    and (.headers["Idempotency-Key"] // .headers["idempotency-key"]) == $event_id
  '
  assert_json "$meta" '
    ((.headers["X-Tirion-Timestamp"] // .headers["x-tirion-timestamp"]) | type) == "string"
    and ((.headers["X-Tirion-Signature-256"] // .headers["x-tirion-signature-256"]) | test("^sha256=[a-f0-9]{64}$"))
  '
  "$PYTHON_BIN" - "$body" "$meta" "$WEBHOOK_SECRET" <<'PY'
import hashlib, hmac, json, sys
body_path, meta_path, secret = sys.argv[1:]
payload = open(body_path, "rb").read()
headers = json.load(open(meta_path, encoding="utf-8"))["headers"]
lower = {k.lower(): v for k, v in headers.items()}
timestamp = lower["x-tirion-timestamp"]
expected = "sha256=" + hmac.new(secret.encode(), timestamp.encode() + b"." + payload, hashlib.sha256).hexdigest()
if lower.get("x-tirion-signature-256") != expected:
    raise SystemExit("invalid HMAC signature")
PY
}

assert_all_payloads_private() {
  while IFS= read -r event_file; do
    assert_no_forbidden_keys "$event_file"
    assert_no_forbidden_text "$event_file" \
      "$ROOT" "$CURSOR_REPO" "$CURSOR_HOME_DIR" "$AGENT_STATE_DIR" "/Users/asaf/private-cursor-plan.md" \
      "CURSOR_MIMIC_SECRET" "Inspect /Users/asaf/private-cursor-plan.md" \
      "cat /Users/asaf/private-cursor-plan.md" "private cursor shell output" "private cursor file content"
    assert_request_metadata "$event_file"
  done < <(find "$EVENT_DIR" -type f -name '*.body.json' | sort)
}

find_event() {
  local result=""
  while IFS= read -r f; do
    if jq -e "$@" "$f" >/dev/null 2>&1; then
      result="$f"
      break
    fi
  done < <(find "$EVENT_DIR" -type f -name '*.body.json' 2>/dev/null | sort)
  echo "$result"
}

wait_for_event() {
  local timeout="${EVENT_TIMEOUT}" start result
  start="$(date +%s)"
  while true; do
    tirionctl webhook retry >/dev/null 2>&1 || true
    result="$(find_event "$@")"
    if [[ -n "$result" ]]; then
      echo "$result"
      return 0
    fi
    if (( "$(date +%s)" - start >= timeout )); then
      echo "Timed out waiting for matching event: $*" >&2
      echo "Webhook status:" >&2
      tirionctl webhook status | jq . >&2 || true
      echo "Captured event summaries:" >&2
      for event_file in "$EVENT_DIR"/*.body.json; do
        [[ -f "$event_file" ]] || continue
        echo "$event_file" >&2
        jq '{eventType, codingHarness, runtime, runId, repository, inputTokens, outputTokens, totalTokens, llmModels, filesChanged, commitSha, runIds, state, version, usageValueNanoUsd, estimatedNanoUsd, costEstimateBasis, costCoverage}' "$event_file" >&2 || true
      done
      fail "timed out waiting for matching event"
    fi
    sleep 1
  done
}

event_index() {
  local target="$1" index=0
  while IFS= read -r f; do
    if [[ "$f" == "$target" ]]; then
      echo "$index"
      return 0
    fi
    index=$((index + 1))
  done < <(find "$EVENT_DIR" -type f -name '*.body.json' | sort)
  fail "event not found in captured set: $target"
}

assert_run_start_event() {
  local file="$1"
  assert_json "$file" '.schemaVersion == 1'
  assert_json "$file" '.eventType == "run.start"'
  assert_json "$file" '.codingHarness == "cursor"'
  assert_json "$file" '.runtime == "cursor"'
  assert_json "$file" '.state == "running"'
  assert_json "$file" '.sequence == 1'
  assert_json "$file" '.repository.name == "cursor-repo"'
  assert_json "$file" '.coverage.usageCoverage == "none"'
  assert_json "$file" '.coverage.costCoverage == "unavailable"'
  assert_trace_ids "$file"
  assert_no_forbidden_keys "$file"
}

assert_cursor_run_update_event() {
  local file="$1"
  assert_json "$file" '.schemaVersion == 1'
  assert_json "$file" '.eventType == "run.update"'
  assert_json "$file" '.codingHarness == "cursor"'
  assert_json "$file" '.runtime == "cursor"'
  assert_json "$file" '.state == "settling" or .state == "running"'
  assert_json "$file" '.sequence == 2'
  assert_json "$file" '.repository.name == "cursor-repo"'
  assert_json "$file" --arg model "$CURSOR_MODEL" '.llmModels | index($model)'
  assert_json "$file" '.inputTokens == 2400'
  assert_json "$file" '.outputTokens == 160'
  assert_json "$file" '.cacheReadInputTokens == 200'
  assert_json "$file" '.cacheCreationInputTokens == 0'
  assert_json "$file" '.reasoningOutputTokens == 30'
  assert_json "$file" '.totalTokens == 2560'
  assert_cursor_run_cost "$file"
  assert_json "$file" '(.activity | type) == "array" and (.activity | any(.name == "shell_exec")) and (.activity | any(.name == "file_edit"))'
  assert_json "$file" '.coverage.usageCoverage == "none" or .coverage.usageCoverage == "complete_so_far"'
  assert_trace_ids "$file"
  assert_no_forbidden_keys "$file"
}

assert_cursor_run_ended_event() {
  local file="$1"
  assert_json "$file" '.schemaVersion == 1'
  assert_json "$file" '.eventType == "run.ended"'
  assert_json "$file" '.codingHarness == "cursor"'
  assert_json "$file" '.runtime == "cursor"'
  assert_json "$file" '.state == "completed"'
  assert_json "$file" '.repository.name == "cursor-repo"'
  assert_json "$file" --arg model "$CURSOR_MODEL" '.llmModels | index($model)'
  assert_json "$file" '.inputTokens == 2400'
  assert_json "$file" '.outputTokens == 160'
  assert_json "$file" '.cacheReadInputTokens == 200'
  assert_json "$file" '.cacheCreationInputTokens == 0'
  assert_json "$file" '.reasoningOutputTokens == 30'
  assert_json "$file" '.totalTokens == 2560'
  assert_cursor_run_cost "$file"
  assert_json "$file" '.coverage.usageCoverage == "final"'
  assert_json "$file" '(.activity | type) == "array" and (.activity | length) >= 1'
  assert_json "$file" '(.activity | all(.[]; (.count | type) == "number" and .count >= 1 and (.failureCount | type) == "number" and .failureCount >= 0 and .failureCount <= .count))'
  assert_json "$file" '(.activity | any(.name == "shell_exec" and .kind == "tool")) and (.activity | any(.name == "file_edit" and .kind == "tool"))'
  assert_json "$file" '(.activity | any(.name == "Unallocated run usage" and .kind == "unknown" and .usageAttributionBasis == "unavailable"))'
  assert_json "$file" '([.activity[] | (.inputTokens // 0)] | add // 0) == .inputTokens'
  assert_json "$file" '([.activity[] | (.outputTokens // 0)] | add // 0) == .outputTokens'
  assert_json "$file" '([.activity[] | (.cacheReadInputTokens // 0)] | add // 0) == .cacheReadInputTokens'
  assert_json "$file" '([.activity[] | (.cacheCreationInputTokens // 0)] | add // 0) == .cacheCreationInputTokens'
  assert_json "$file" '([.activity[] | (.reasoningOutputTokens // 0)] | add // 0) == .reasoningOutputTokens'
  assert_json "$file" '([.activity[] | (.totalTokens // 0)] | add // 0) == .totalTokens'
  assert_json "$file" '(.activity | all(.[]; .evidence.basis == "usage_projection" and .evidence.delayed == true))'
  assert_json "$file" '(.filesChanged | type) == "array"'
  assert_json "$file" '(.filesChanged | all(.[]; (startswith("/") or startswith("../") or startswith("~") or test("^[A-Za-z]:")) | not))'
  assert_trace_ids "$file"
  assert_no_forbidden_keys "$file"
}

assert_commit_event() {
  local file="$1" run_id="$2"
  assert_json "$file" '.schemaVersion == 1'
  assert_json "$file" '.eventType == "commit.attributed"'
  assert_json "$file" '.repository.name == "cursor-repo"'
  assert_json "$file" '.state == "active" or .state == "rewrite_pending" or .state == "superseded"'
  assert_json "$file" '.commitMessage == "cursor mimic change"'
  assert_json "$file" --arg run_id "$run_id" '.runIds | index($run_id)'
  assert_cursor_commit_cost "$file"
  assert_json "$file" '(.version | type) == "number" and .version >= 1'
  assert_json "$file" '(.commitSha | type) == "string" and (.commitSha | length) >= 7'
  assert_trace_ids "$file"
  assert_no_forbidden_keys "$file"
}

start_receiver() {
  "$PYTHON_BIN" - "$EVENT_DIR" "$TIRION_CURSOR_MIMIC_PORT" <<'PY' &
import json, os, re, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

event_dir, port = sys.argv[1], int(sys.argv[2])
os.makedirs(event_dir, exist_ok=True)
counter = 0

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        global counter
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length)
        try:
            parsed = json.loads(body.decode("utf-8") or "{}")
        except Exception:
            parsed = {"_invalid": body.decode("utf-8", "replace")}
        counter += 1
        event_id = str(parsed.get("eventId") or f"event-{counter}")
        safe_event_id = re.sub(r"[^A-Za-z0-9._-]+", "_", event_id)
        base = os.path.join(event_dir, f"{counter:012d}.{safe_event_id}")
        with open(base + ".body.json", "wb") as f:
            f.write(body)
        with open(base + ".meta.json", "w", encoding="utf-8") as f:
            json.dump({"method": self.command, "path": self.path, "headers": dict(self.headers)}, f, indent=2, sort_keys=True)
            f.write("\n")
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *_):
        return

ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
PY
  WEBHOOK_PID="$!"
  sleep 0.5
  pass "webhook receiver listening on $WEBHOOK_URL"
}

start_agent() {
  export TIRION_AGENT_STATE_DIR="$AGENT_STATE_DIR"
  export TIRION_AGENT_RUNTIME_DIR="$AGENT_RUNTIME_DIR"
  export TIRION_AGENT_SOCKET="$AGENT_SOCKET"
  export TIRION_AGENT_OTLP_PORT="0"
  export CURSOR_HOME="$CURSOR_HOME_DIR"

  mkdir -p "$AGENT_STATE_DIR" "$AGENT_RUNTIME_DIR" "$CURSOR_HOME_DIR"
  run_agent_entry > "$ROOT/agent.stdout.log" 2> "$ROOT/agent.stderr.log" &
  AGENT_PID="$!"

  local attempt status_file="$ROOT/status.json"
  for attempt in $(seq 1 100); do
    if tirionctl status > "$status_file" 2>/dev/null && jq -e '.health == "healthy"' "$status_file" >/dev/null; then
      OTLP_BASE_URL="$(jq -r '"http://\(.otlp.host):\(.otlp.port)"' "$status_file")"
      OTLP_TOKEN="$(cat "$AGENT_STATE_DIR/otlp.token")"
      pass "isolated Tirion agent started at $OTLP_BASE_URL"
      return 0
    fi
    sleep 0.1
  done

  echo "Agent stdout:" >&2
  cat "$ROOT/agent.stdout.log" >&2 || true
  echo "Agent stderr:" >&2
  cat "$ROOT/agent.stderr.log" >&2 || true
  fail "isolated Tirion agent did not become healthy"
}

cleanup() {
  set +e
  if [[ -n "${AGENT_PID:-}" ]]; then
    tirionctl sources restore cursor >/dev/null 2>&1 || true
    tirionctl stop >/dev/null 2>&1 || true
    kill "$AGENT_PID" >/dev/null 2>&1 || true
    wait "$AGENT_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${WEBHOOK_PID:-}" ]]; then
    kill "$WEBHOOK_PID" >/dev/null 2>&1 || true
    wait "$WEBHOOK_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

make_repo() {
  mkdir -p "$CURSOR_REPO/src" "$CURSOR_REPO/docs"
  cd "$CURSOR_REPO"
  git init -q
  git config user.name "Tirion Cursor Mimic Test"
  git config user.email "tirion-cursor-mimic@example.test"
  printf '# Cursor mimic repo\n' > README.md
  cat > src/answer.ts <<'EOF'
export function answer(): number {
  return 41;
}
EOF
  git add .
  git commit -q -m "initial repo state"
}

post_cursor_hook() {
  local observation_id="$1"
  curl -fsS -X POST "$OTLP_BASE_URL/v1/provider-hooks/cursor" \
    -H "content-type: application/json" \
    -H "authorization: Bearer $OTLP_TOKEN" \
    -H "x-tirion-observation-id: $observation_id" \
    --data-binary @- >/dev/null
}

commit_fixture() {
  cd "$CURSOR_REPO"
  git add src/answer.ts docs/cursor-notes.md
  git commit -q -m "cursor mimic change"
}

if ! protected_root "$ROOT"; then
  fail "refusing unsafe TIRION_CURSOR_MIMIC_ROOT: $ROOT"
fi

require_command jq
require_command curl
require_command git
require_command perl
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || fail "required command not found: node; install Node.js or set TIRION_TEST_NODE"
[[ -n "$PYTHON_BIN" && -x "$PYTHON_BIN" ]] || fail "required command not found: python3; install Python 3 or set TIRION_TEST_PYTHON"

if [[ "$TIRIONCTL_BIN" == *.js ]]; then
  [[ -f "$TIRIONCTL_BIN" ]] || fail "tirionctl build output not found at $TIRIONCTL_BIN; run npm run compile or set TIRION_TEST_TIRIONCTL"
else
  require_command "$TIRIONCTL_BIN"
fi
if [[ "$AGENT_ENTRY" == *.js ]]; then
  [[ -f "$AGENT_ENTRY" ]] || fail "agent build output not found at $AGENT_ENTRY; run npm run compile or set TIRION_TEST_AGENT_ENTRY"
else
  require_command "$AGENT_ENTRY"
fi

rm -rf "$ROOT"
mkdir -p "$EVENT_DIR"

TIRION_CURSOR_MIMIC_PORT="$("$PYTHON_BIN" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
WEBHOOK_URL="http://127.0.0.1:${TIRION_CURSOR_MIMIC_PORT}/webhooks/tirion"

make_repo
pass "cursor mimic repository created at $CURSOR_REPO"

start_receiver
start_agent

tirionctl webhook set-url "$WEBHOOK_URL" >/dev/null
tirionctl webhook set-token "$WEBHOOK_TOKEN" >/dev/null
tirionctl webhook set-secret "$WEBHOOK_SECRET" >/dev/null
tirionctl webhook enable-runs >/dev/null
pass "webhook destination and auth configured"

ACTIVATION_FILE="$ROOT/cursor-activation.json"
tirionctl repo activate "$CURSOR_REPO" --provider cursor > "$ACTIVATION_FILE"
assert_json "$ACTIVATION_FILE" '.schemaVersion == 1'
assert_json "$ACTIVATION_FILE" '.activationState == "ready"'
assert_json "$ACTIVATION_FILE" '.provider == "cursor"'
assert_json "$ACTIVATION_FILE" '.repositoryScope.kind == "repository"'
assert_json "$ACTIVATION_FILE" '.repositoryScope.state == "active"'
assert_json "$ACTIVATION_FILE" '.sourceStatus.provider == "cursor"'
assert_json "$ACTIVATION_FILE" '.sourceStatus.configurationState == "configured"'
assert_json "$ACTIVATION_FILE" '.sourceStatus.ownershipState == "managed_current"'
assert_json "$CURSOR_HOME_DIR/hooks.json" --arg url "$OTLP_BASE_URL/v1/provider-hooks/cursor" '
  .hooks.beforeSubmitPrompt[0].command | contains($url)
'
assert_json "$CURSOR_HOME_DIR/hooks.json" '.hooks.afterFileEdit[0].command | contains("cursor-hook-relay.cjs")'
pass "Cursor source configuration written to isolated CURSOR_HOME"

sleep "$BASELINE_SLEEP_SECONDS"

post_cursor_hook "cursor-mimic-before-submit" <<JSON
{
  "hook_event_name": "beforeSubmitPrompt",
  "conversation_id": "cursor-mimic-conversation-1",
  "generation_id": "cursor-mimic-generation-1",
  "model": "$CURSOR_MODEL",
  "prompt": "Inspect /Users/asaf/private-cursor-plan.md and do not leak CURSOR_MIMIC_SECRET"
}
JSON

RUN_START_EVENT="$(wait_for_event '.eventType == "run.start" and .codingHarness == "cursor" and .repository.name == "cursor-repo"')"
assert_run_start_event "$RUN_START_EVENT"
pass "Cursor run.start webhook validated"

post_cursor_hook "cursor-mimic-after-response" <<JSON
{
  "hook_event_name": "afterAgentResponse",
  "conversation_id": "cursor-mimic-conversation-1",
  "generation_id": "cursor-mimic-generation-1",
  "model": "$CURSOR_MODEL",
  "input_tokens": 2400,
  "output_tokens": 160,
  "cache_read_tokens": 200,
  "reasoning_tokens": 30
}
JSON

post_cursor_hook "cursor-mimic-shell" <<'JSON'
{
  "hook_event_name": "afterShellExecution",
  "conversation_id": "cursor-mimic-conversation-1",
  "generation_id": "cursor-mimic-generation-1",
  "shell_execution_id": "cursor-shell-1",
  "command": "cat /Users/asaf/private-cursor-plan.md",
  "output": "CURSOR_MIMIC_SECRET private cursor shell output",
  "exit_code": 0,
  "duration_ms": 120
}
JSON

cd "$CURSOR_REPO"
perl -0pi -e 's/return 41;/return 42;/' src/answer.ts
printf 'Cursor mimic lifecycle note.\n' > docs/cursor-notes.md

post_cursor_hook "cursor-mimic-file-edit" <<'JSON'
{
  "hook_event_name": "afterFileEdit",
  "conversation_id": "cursor-mimic-conversation-1",
  "generation_id": "cursor-mimic-generation-1",
  "edit_id": "cursor-edit-1",
  "file_path": "/Users/asaf/private-cursor-plan.md",
  "content": "CURSOR_MIMIC_SECRET private cursor file content"
}
JSON

RUN_UPDATE_EVENT="$(wait_for_event '.eventType == "run.update" and .codingHarness == "cursor" and .repository.name == "cursor-repo" and .inputTokens == 2400 and .outputTokens == 160 and (.activity | any(.name == "shell_exec")) and (.activity | any(.name == "file_edit"))')"
assert_cursor_run_update_event "$RUN_UPDATE_EVENT"
pass "Cursor run.update webhook validated"

post_cursor_hook "cursor-mimic-stop" <<'JSON'
{
  "hook_event_name": "stop",
  "conversation_id": "cursor-mimic-conversation-1",
  "generation_id": "cursor-mimic-stop-generation-drift"
}
JSON

RUN_ENDED_EVENT="$(wait_for_event '.eventType == "run.ended" and .codingHarness == "cursor" and .repository.name == "cursor-repo" and .inputTokens == 2400 and .outputTokens == 160')"
assert_cursor_run_ended_event "$RUN_ENDED_EVENT"
RUN_ID="$(jq -r '.runId' "$RUN_ENDED_EVENT")"
pass "Cursor run.ended webhook validated"

START_INDEX="$(event_index "$RUN_START_EVENT")"
UPDATE_INDEX="$(event_index "$RUN_UPDATE_EVENT")"
ENDED_INDEX="$(event_index "$RUN_ENDED_EVENT")"
(( START_INDEX < UPDATE_INDEX )) || fail "run.update arrived before run.start"
(( UPDATE_INDEX < ENDED_INDEX )) || fail "run.ended arrived before run.update"
pass "Cursor webhook lifecycle order validated"

commit_fixture
COMMIT_EVENT="$(wait_for_event --arg run_id "$RUN_ID" '.eventType == "commit.attributed" and .repository.name == "cursor-repo" and (.runIds | index($run_id))')"
assert_commit_event "$COMMIT_EVENT" "$RUN_ID"
pass "Cursor commit.attributed webhook validated"

SOURCES_FILE="$ROOT/sources.json"
tirionctl sources list > "$SOURCES_FILE"
assert_json "$SOURCES_FILE" '.sources | any(.sourceId == "hook_cursor_lifecycle" and .provider == "cursor" and .sourceKind == "provider-hook-command-json")'
assert_json "$SOURCES_FILE" '.sources | any(.sourceId == "hook_cursor_tools" and .provider == "cursor" and .sourceKind == "provider-hook-command-json")'
pass "Cursor hook source receipts recorded"

assert_all_payloads_private
pass "Cursor mimic webhook privacy validated"

echo "PASS: Cursor hook mimic lifecycle harness completed"
