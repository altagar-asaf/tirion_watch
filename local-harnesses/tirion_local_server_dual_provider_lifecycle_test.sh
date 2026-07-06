#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# Tirion local-server multi-provider lifecycle webhook stress test
#
# Exercises Claude Code, Codex, and GitHub Copilot local-agent webhook delivery
# against a local HTTP receiver. Claude Code and Codex use the real provider
# CLIs. GitHub Copilot uses deterministic span DB replay so the test can stress
# Tirion's supported Copilot ingestion/lifecycle path without automating VS Code.
# The default path is self-contained: this script starts the receiver, configures
# Tirion with bearer + HMAC webhook credentials, runs providers in isolated repos,
# and validates actual webhook bodies.
#
# Scenarios covered:
# 1. Durable retry from a down webhook URL, then successful replay.
# 2. Webhook bearer/HMAC/idempotency request metadata.
# 3. Disabled run event family does not deliver a test run webhook.
# 4. Claude Code read-only run emits run.start -> run.update -> run.ended.
# 5. Claude Code writes emit lifecycle events, relative changed paths, commit
#    links, and bucketable commit messages.
# 6. Removed Claude repository scope does not remain active during Codex phase.
# 7. Codex read-only run emits run.start -> run.update -> run.ended.
# 8. Codex writes emit lifecycle events, relative changed paths, commit links,
#    and bucketable commit messages.
# 9. Removed Codex repository scope does not remain active during Copilot phase.
# 10. GitHub Copilot span DB read-only replay emits run.start -> run.update -> run.ended.
# 11. GitHub Copilot span DB writes emit lifecycle events, relative changed
#     paths, catalog pricing, commit links, and bucketable commit messages.
# 12. Commit webhooks exclude read-only run IDs and include write trace IDs.
# 13. Payload privacy: no forbidden fields, prompts, local roots, absolute paths.
#
# Usage:
#   ./tirion_local_server_dual_provider_lifecycle_test.sh
#
# Useful knobs:
#   TIRION_TEST_ROOT=/tmp/tirion-local-server-test ./tirion_local_server_dual_provider_lifecycle_test.sh
#   TIRION_TEST_EVENT_TIMEOUT=420 ./tirion_local_server_dual_provider_lifecycle_test.sh
#   TIRION_TEST_WEBHOOK_URL=http://127.0.0.1:9999/custom/path ./tirion_local_server_dual_provider_lifecycle_test.sh
#   TIRION_TEST_CODEX_READ_ONLY_PROMPT="look online, ..." ./tirion_local_server_dual_provider_lifecycle_test.sh
#   TIRION_TEST_PROVIDERS=github-copilot ./tirion_local_server_dual_provider_lifecycle_test.sh
#   TIRION_TEST_TIRIONCTL="$PWD/packages/tirionctl/dist/main.js" ./tirion_local_server_dual_provider_lifecycle_test.sh
###############################################################################

ROOT="${TIRION_TEST_ROOT:-/tmp/tirion-local-server-test}"
EVENT_DIR="$ROOT/events"
CC_REPO="$ROOT/claude-code-repo"
CX_REPO="$ROOT/codex-repo"
CP_REPO="$ROOT/github-copilot-repo"
CP_SPAN_DB="${TIRION_TEST_COPILOT_SPAN_DB:-$ROOT/github-copilot/agent-traces.db}"
EVENT_TIMEOUT="${TIRION_TEST_EVENT_TIMEOUT:-360}"
START_RECEIVER="${TIRION_TEST_START_RECEIVER:-1}"
EVENT_API_URL="${TIRION_TEST_EVENT_API_URL:-}"
WEBHOOK_TOKEN="${TIRION_TEST_WEBHOOK_TOKEN:-tirion-local-server-token}"
WEBHOOK_SECRET="${TIRION_TEST_WEBHOOK_SECRET:-tirion-local-server-secret}"
PROVIDERS="${TIRION_TEST_PROVIDERS:-claude-code,codex,github-copilot}"
TIRIONCTL_BIN="${TIRION_TEST_TIRIONCTL:-tirionctl}"
CLAUDE_PERMISSION_MODE="${TIRION_TEST_CLAUDE_PERMISSION_MODE:-acceptEdits}"
CLAUDE_TOOLS="${TIRION_TEST_CLAUDE_TOOLS:-Read,Edit,Write,Glob,Grep}"
CLAUDE_MAX_TURNS="${TIRION_TEST_CLAUDE_MAX_TURNS:-12}"
CLAUDE_MODEL="${TIRION_TEST_CLAUDE_MODEL:-}"
CODEX_READ_ONLY_PROMPT="${TIRION_TEST_CODEX_READ_ONLY_PROMPT:-Inspect this repository and summarize what it does. Do not modify any files. Do not repeat this exact sentinel: DO_NOT_LEAK_CODEX_SECRET.}"
COPILOT_MODEL="${TIRION_TEST_COPILOT_MODEL:-gpt-5.4-mini}"
COPILOT_BASELINE_SLEEP_SECONDS="${TIRION_TEST_COPILOT_BASELINE_SLEEP_SECONDS:-2}"

if [[ -z "${TIRION_TEST_WEBHOOK_URL:-}" ]]; then
  TIRION_TEST_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
  WEBHOOK_URL="http://127.0.0.1:${TIRION_TEST_PORT}/webhooks/tirion"
else
  WEBHOOK_URL="$TIRION_TEST_WEBHOOK_URL"
  TIRION_TEST_PORT="${TIRION_TEST_PORT:-$(python3 - <<PY
from urllib.parse import urlparse
parsed = urlparse("$WEBHOOK_URL")
if parsed.hostname not in ("127.0.0.1", "localhost"):
    raise SystemExit("managed receiver requires a localhost webhook URL")
print(parsed.port or (80 if parsed.scheme == "http" else 443))
PY
)}"
fi

if [[ "$START_RECEIVER" != "1" && -z "$EVENT_API_URL" ]]; then
  EVENT_API_URL="$(python3 - <<PY
from urllib.parse import urlparse, urlunparse
parsed = urlparse("$WEBHOOK_URL")
if parsed.hostname not in ("127.0.0.1", "localhost"):
    raise SystemExit("external receiver event API must be provided with TIRION_TEST_EVENT_API_URL")
port = parsed.port or (80 if parsed.scheme == "http" else 443)
dashboard_port = port + 1
netloc = f"{parsed.hostname}:{dashboard_port}"
print(urlunparse((parsed.scheme, netloc, "/api/events", "", "", "")))
PY
)"
fi

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

require_tirionctl() {
  if [[ "$TIRIONCTL_BIN" == *.js ]]; then
    require_command node
    [[ -f "$TIRIONCTL_BIN" ]] || fail "TIRION_TEST_TIRIONCTL points to a missing file: $TIRIONCTL_BIN"
  else
    require_command "$TIRIONCTL_BIN"
  fi
}

tirionctl() {
  if [[ "$TIRIONCTL_BIN" == *.js ]]; then
    node "$TIRIONCTL_BIN" "$@"
  else
    command "$TIRIONCTL_BIN" "$@"
  fi
}

provider_enabled() {
  local provider="$1"
  [[ ",$PROVIDERS," == *",$provider,"* ]]
}

validate_provider_selection() {
  local normalized=",${PROVIDERS},"
  [[ "$normalized" == *",claude-code,"* || "$normalized" == *",codex,"* || "$normalized" == *",github-copilot,"* ]] \
    || fail "TIRION_TEST_PROVIDERS must include at least one of claude-code,codex,github-copilot"
  local item
  IFS=',' read -ra items <<< "$PROVIDERS"
  for item in "${items[@]}"; do
    case "$item" in
      claude-code|codex|github-copilot) ;;
      *) fail "unsupported TIRION_TEST_PROVIDERS entry: $item" ;;
    esac
  done
}

cleanup() {
  set +e
  if [[ -n "${WEBHOOK_PID:-}" ]]; then
    kill "$WEBHOOK_PID" >/dev/null 2>&1 || true
    wait "$WEBHOOK_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${CC_SCOPE_ID:-}" ]]; then
    tirionctl repo remove "$CC_SCOPE_ID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${CX_SCOPE_ID:-}" ]]; then
    tirionctl repo remove "$CX_SCOPE_ID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${CP_SCOPE_ID:-}" ]]; then
    tirionctl repo remove "$CP_SCOPE_ID" >/dev/null 2>&1 || true
  fi
  tirionctl configure restore claude-code >/dev/null 2>&1 || true
  tirionctl configure restore codex >/dev/null 2>&1 || true
  tirionctl configure restore github-copilot >/dev/null 2>&1 || true
}
trap cleanup EXIT

count_events() {
  sync_external_events
  find "$EVENT_DIR" -type f -name '*.body.json' 2>/dev/null | wc -l | tr -d ' '
}

webhook_delivered_count() {
  tirionctl webhook status | jq -r '.deliveredCount // 0'
}

try_wait_for_delivered_count() {
  local expected="$1" timeout="${2:-$EVENT_TIMEOUT}" start current
  start="$(date +%s)"
  while true; do
    current="$(webhook_delivered_count)"
    if [[ "$current" =~ ^[0-9]+$ ]] && (( current >= expected )); then
      return 0
    fi
    (( "$(date +%s)" - start >= timeout )) && return 1
    sleep 2
  done
}

wait_for_delivered_count() {
  local expected="$1" timeout="${2:-$EVENT_TIMEOUT}" current
  if try_wait_for_delivered_count "$expected" "$timeout"; then
    return 0
  fi
  current="$(webhook_delivered_count)"
  tirionctl webhook status >&2 || true
  fail "timed out waiting for at least ${expected} delivered webhook events, saw ${current}"
}

find_event() {
  local result=""
  sync_external_events
  while IFS= read -r f; do
    if jq -e "$@" "$f" >/dev/null 2>&1; then
      result="$f"
      break
    fi
  done < <(find "$EVENT_DIR" -type f -name '*.body.json' | sort)
  echo "$result"
}

wait_for_event() {
  local timeout="${EVENT_TIMEOUT}" start result
  start="$(date +%s)"
  while true; do
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
        jq '{eventType, codingHarness, runtime, runId, repository, filesChanged, commitSha, runIds, state, version}' "$event_file" >&2 || true
      done
      fail "timed out waiting for matching event"
    fi
    sleep 1
  done
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
  jq -e '(.traceIds | type) == "array" and (.traceIds | length) >= 1 and (.traceIds | all(.[]; type == "string" and length > 0))' \
    "$file" >/dev/null || {
      echo "Invalid traceIds in payload: $file" >&2
      cat "$file" >&2
      exit 1
    }
}

assert_run_lifecycle_event_common() {
  local file="$1" event_type="$2"
  assert_json "$file" '.schemaVersion == 1'
  assert_json "$file" --arg event_type "$event_type" '.eventType == $event_type'
  assert_json "$file" '(.eventId | type) == "string" and (.eventId | length) > 0'
  assert_json "$file" '(.runId | type) == "string" and (.runId | length) > 0'
  assert_json "$file" '(.repository.repoKey | type) == "string" and (.repository.repoKey | length) > 0'
  assert_json "$file" '(.repository.owner | type) == "string" and (.repository.owner | length) > 0'
  assert_json "$file" '(.repository.name | type) == "string" and (.repository.name | length) > 0'
  assert_json "$file" '(.repository.fullName | type) == "string" and (.repository.fullName | length) > 0'
  assert_json "$file" '(.codingHarness | type) == "string" and (.codingHarness | length) > 0'
  assert_json "$file" '(.runtime | type) == "string" and (.runtime | length) > 0'
  assert_json "$file" '(.startedAt | type) == "string" and (.startedAt | length) > 0'
  assert_json "$file" '(.traceIds | type) == "array" and (.traceIds | length) >= 1'
  assert_json "$file" '(.evidence.basis | type) == "string" and (.evidence.basis | length) > 0'
  assert_json "$file" '(.evidence.sourceId | type) == "string" and (.evidence.sourceId | length) > 0'
  assert_json "$file" '(.coverage.usageCoverage | type) == "string" and (.coverage.usageCoverage | length) > 0'
  assert_json "$file" '(.coverage.activityCoverage | type) == "string" and (.coverage.activityCoverage | length) > 0'
  assert_json "$file" '(.coverage.costCoverage | type) == "string" and (.coverage.costCoverage | length) > 0'
  assert_trace_ids "$file"
  assert_no_forbidden_keys "$file"
}

assert_run_start_event() {
  local file="$1"
  assert_run_lifecycle_event_common "$file" "run.start"
  assert_json "$file" '.state == "running"'
  assert_json "$file" '.sequence == 1'
  assert_json "$file" '(.updatedAt | type) == "string" and (.updatedAt | length) > 0'
  assert_json "$file" '(.llmModels | type) == "array"'
}

assert_run_update_event() {
  local file="$1"
  assert_run_lifecycle_event_common "$file" "run.update"
  assert_json "$file" '.state == "running" or .state == "settling"'
  assert_json "$file" '.sequence == 2'
  assert_json "$file" '(.updatedAt | type) == "string" and (.updatedAt | length) > 0'
  assert_json "$file" '(.inputTokens | type) == "number" and .inputTokens >= 0'
  assert_json "$file" '(.outputTokens | type) == "number" and .outputTokens >= 0'
  assert_json "$file" '(.cacheReadInputTokens | type) == "number" and .cacheReadInputTokens >= 0'
  assert_json "$file" '(.cacheCreationInputTokens | type) == "number" and .cacheCreationInputTokens >= 0'
  assert_json "$file" '(.reasoningOutputTokens | type) == "number" and .reasoningOutputTokens >= 0'
  assert_json "$file" '(.totalTokens | type) == "number" and .totalTokens >= 0'
  assert_json "$file" '(.llmModels | type) == "array"'
  assert_json "$file" '(.activity | type) == "array"'
}

assert_run_event_common() {
  local file="$1"
  assert_json "$file" '.schemaVersion == 1'
  assert_json "$file" '.eventType == "run.ended"'
  assert_json "$file" '.state == "completed"'
  assert_json "$file" '(.eventId | type) == "string" and (.eventId | length) > 0'
  assert_json "$file" '(.runId | type) == "string" and (.runId | length) > 0'
  assert_json "$file" '(.repository.repoKey | type) == "string" and (.repository.repoKey | length) > 0'
  assert_json "$file" '(.repository.owner | type) == "string" and (.repository.owner | length) > 0'
  assert_json "$file" '(.repository.name | type) == "string" and (.repository.name | length) > 0'
  assert_json "$file" '(.repository.fullName | type) == "string" and (.repository.fullName | length) > 0'
  assert_json "$file" '(.codingHarness | type) == "string" and (.codingHarness | length) > 0'
  assert_json "$file" '(.runtime | type) == "string" and (.runtime | length) > 0'
  assert_json "$file" '(.startedAt | type) == "string" and (.startedAt | length) > 0'
  assert_json "$file" '(.endedAt | type) == "string" and (.endedAt | length) > 0'
  assert_json "$file" '(.inputTokens | type) == "number" and .inputTokens >= 0'
  assert_json "$file" '(.outputTokens | type) == "number" and .outputTokens >= 0'
  assert_json "$file" '(.cacheReadInputTokens | type) == "number" and .cacheReadInputTokens >= 0'
  assert_json "$file" '(.cacheCreationInputTokens | type) == "number" and .cacheCreationInputTokens >= 0'
  assert_json "$file" '(.reasoningOutputTokens | type) == "number" and .reasoningOutputTokens >= 0'
  assert_json "$file" '(.totalTokens | type) == "number" and .totalTokens >= 0'
  assert_json "$file" '(.llmModels | type) == "array"'
  assert_json "$file" '(.estimatedNanoUsd | type) == "number" and .estimatedNanoUsd >= 0'
  assert_json "$file" '.costEstimateBasis == "catalog_estimate" or .costEstimateBasis == "provider_reported_estimate" or .costEstimateBasis == "unavailable"'
  assert_json "$file" '.costCoverage == "complete" or .costCoverage == "partial" or .costCoverage == "unavailable"'
  assert_json "$file" '(.filesChanged | type) == "array"'
  assert_json "$file" '(.filesChanged | all(.[]; (startswith("/") or startswith("../") or startswith("~") or test("^[A-Za-z]:")) | not))'
  assert_trace_ids "$file"
  assert_no_forbidden_keys "$file"
}

event_index() {
  local target="$1" index=0
  sync_external_events
  while IFS= read -r f; do
    if [[ "$f" == "$target" ]]; then
      echo "$index"
      return 0
    fi
    index=$((index + 1))
  done < <(find "$EVENT_DIR" -type f -name '*.body.json' | sort)
  fail "event not found in captured set: $target"
}

assert_run_lifecycle_for_ended() {
  local ended_file="$1" harness="$2" repo_name="$3" label="$4"
  local run_id repo_key start_file update_file start_index update_index ended_index
  run_id="$(jq -r '.runId' "$ended_file")"
  repo_key="$(jq -r '.repository.repoKey' "$ended_file")"
  start_file="$(wait_for_event \
    --arg run_id "$run_id" \
    --arg harness "$harness" \
    --arg repo_key "$repo_key" \
    --arg repo_name "$repo_name" \
    '.eventType == "run.start" and .runId == $run_id and .codingHarness == $harness and .repository.repoKey == $repo_key and .repository.name == $repo_name')"
  update_file="$(wait_for_event \
    --arg run_id "$run_id" \
    --arg harness "$harness" \
    --arg repo_key "$repo_key" \
    --arg repo_name "$repo_name" \
    '.eventType == "run.update" and .runId == $run_id and .codingHarness == $harness and .repository.repoKey == $repo_key and .repository.name == $repo_name')"

  assert_run_start_event "$start_file"
  assert_run_update_event "$update_file"
  assert_run_event_common "$ended_file"
  assert_json "$start_file" --arg runtime "$harness" '.runtime == $runtime'
  assert_json "$update_file" --arg runtime "$harness" '.runtime == $runtime'
  assert_json "$ended_file" --arg runtime "$harness" '.runtime == $runtime'

  start_index="$(event_index "$start_file")"
  update_index="$(event_index "$update_file")"
  ended_index="$(event_index "$ended_file")"
  (( start_index < update_index )) || fail "$label run.update arrived before run.start"
  (( update_index < ended_index )) || fail "$label run.ended arrived before run.update"
  pass "$label lifecycle run.start -> run.update -> run.ended validated"
}

assert_commit_event_common() {
  local file="$1"
  assert_json "$file" '.schemaVersion == 1'
  assert_json "$file" '.eventType == "commit.attributed"'
  assert_json "$file" '(.eventId | type) == "string" and (.eventId | length) > 0'
  assert_json "$file" '(.repository.repoKey | type) == "string" and (.repository.repoKey | length) > 0'
  assert_json "$file" '(.repository.owner | type) == "string" and (.repository.owner | length) > 0'
  assert_json "$file" '(.repository.name | type) == "string" and (.repository.name | length) > 0'
  assert_json "$file" '(.repository.fullName | type) == "string" and (.repository.fullName | length) > 0'
  assert_json "$file" '(.commitSha | type) == "string" and (.commitSha | length) >= 7'
  assert_json "$file" '(.runIds | type) == "array" and (.runIds | length) >= 1'
  assert_json "$file" '(.estimatedNanoUsd | type) == "number" and .estimatedNanoUsd >= 0'
  assert_json "$file" '.costCoverage == "complete" or .costCoverage == "partial" or .costCoverage == "unavailable"'
  assert_json "$file" '.state == "active" or .state == "rewrite_pending" or .state == "superseded"'
  assert_json "$file" '(.version | type) == "number" and .version >= 1'
  assert_json "$file" '(.firstVerifiedAt | type) == "string" and (.firstVerifiedAt | length) > 0'
  assert_json "$file" '(.updatedAt | type) == "string" and (.updatedAt | length) > 0'
  assert_trace_ids "$file"
  assert_no_forbidden_keys "$file"
}

assert_commit_message() {
  local file="$1" expected="$2"
  assert_json "$file" --arg expected "$expected" '.commitMessage == $expected'
}

meta_for_event() {
  local body="$1"
  echo "${body%.body.json}.meta.json"
}

assert_request_metadata() {
  local body="$1" meta
  [[ "$START_RECEIVER" == "1" ]] || return 0
  meta="$(meta_for_event "$body")"
  [[ -f "$meta" ]] || fail "missing metadata file for $body"
  local event_id
  event_id="$(jq -r '.eventId' "$body")"
  assert_json "$meta" --arg path "$(python3 - <<PY
from urllib.parse import urlparse
print(urlparse("$WEBHOOK_URL").path or "/")
PY
)" '.path == $path'
  assert_json "$meta" --arg token "$WEBHOOK_TOKEN" '
    (.headers.Authorization // .headers.authorization) == ("Bearer " + $token)
  '
  assert_json "$meta" --arg event_id "$event_id" '
    (.headers["X-Tirion-Event-Id"] // .headers["x-tirion-event-id"]) == $event_id
    and (.headers["Idempotency-Key"] // .headers["idempotency-key"]) == $event_id
  '
  assert_json "$meta" '
    ((.headers["X-Tirion-Timestamp"] // .headers["x-tirion-timestamp"]) | type) == "string"
    and ((.headers["X-Tirion-Signature-256"] // .headers["x-tirion-signature-256"]) | test("^sha256=[a-f0-9]{64}$"))
  '
  python3 - "$body" "$meta" "$WEBHOOK_SECRET" <<'PY'
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
  sync_external_events
  while IFS= read -r event_file; do
    assert_no_forbidden_keys "$event_file"
    assert_no_forbidden_text "$event_file" \
      "$ROOT" "$CC_REPO" "$CX_REPO" "$CP_REPO" "$CP_SPAN_DB" "/Users/" "/private/" \
      "DO_NOT_LEAK_CLAUDE_SECRET" "DO_NOT_LEAK_CODEX_SECRET" "DO_NOT_LEAK_COPILOT_SECRET" \
      "Inspect this repository" "Update src/answer.ts"
    assert_request_metadata "$event_file"
  done < <(find "$EVENT_DIR" -type f -name '*.body.json' | sort)
}

assert_no_orphan_run_lifecycle_subjects() {
  sync_external_events
  local orphan_file="$ROOT/orphan-lifecycle-run-ids.json"
  jq -s '
    ([.[] | select((.eventType == "run.start" or .eventType == "run.update")
      and (.codingHarness == "claude-code" or .codingHarness == "codex" or .codingHarness == "github-copilot")) | .runId] | unique) as $live
    | ([.[] | select(.eventType == "run.ended"
      and (.codingHarness == "claude-code" or .codingHarness == "codex" or .codingHarness == "github-copilot")) | .runId] | unique) as $ended
    | $live - $ended
  ' "$EVENT_DIR"/*.body.json > "$orphan_file"
  if ! jq -e 'length == 0' "$orphan_file" >/dev/null; then
    echo "Orphan run lifecycle subjects detected:" >&2
    jq . "$orphan_file" >&2
    echo "Lifecycle summaries:" >&2
    jq -r '
      select(.eventType == "run.start" or .eventType == "run.update" or .eventType == "run.ended")
      | [.eventType, .codingHarness, .repository.name, .runId, (.coverage.usageCoverage // ""), (.usageValueNanoUsd // ""), (.state // "")] | @tsv
    ' "$EVENT_DIR"/*.body.json | sort >&2
    fail "run.start/run.update lifecycle subjects must reach run.ended by test completion"
  fi
}

query_trace_id_for_run_id() {
  local run_id="$1"
  echo "qry_${run_id#run_}"
}

clear_captured_events() {
  rm -f "$EVENT_DIR"/*.json
  if [[ "$START_RECEIVER" != "1" ]]; then
    curl -fsS -X DELETE "$EVENT_API_URL" >/dev/null \
      || fail "failed to clear external webhook events at $EVENT_API_URL"
  fi
}

sync_external_events() {
  [[ "$START_RECEIVER" != "1" ]] || return 0
  [[ -n "$EVENT_API_URL" ]] || return 0
  mkdir -p "$EVENT_DIR"
  local tmp="$ROOT/external-events.json" event_tmp="$ROOT/external-event.json" filename event_id safe body index=0
  if ! curl -fsS "$EVENT_API_URL" > "$tmp" 2>/dev/null; then
    return 0
  fi
  jq -c '.[]' "$tmp" 2>/dev/null | while IFS= read -r event; do
    printf '%s\n' "$event" > "$event_tmp"
    filename="$(jq -r '._filename // empty' "$event_tmp")"
    if [[ -z "$filename" ]]; then
      event_id="$(jq -r '.eventId // "event"' "$event_tmp")"
      filename="$(printf '%012d.%s.json' "$index" "$event_id")"
    fi
    index=$((index + 1))
    [[ -n "$filename" ]] || continue
    safe="$(printf '%s' "$filename" | tr -c 'A-Za-z0-9._-' '_')"
    body="$EVENT_DIR/${safe%.json}.body.json"
    [[ -f "$body" ]] && continue
    jq 'del(._filename, ._new, ._rx)' "$event_tmp" > "$body"
  done
}

assert_no_new_events_for() {
  local seconds="$1" before after
  before="$(count_events)"
  sleep "$seconds"
  after="$(count_events)"
  [[ "$after" == "$before" ]] || fail "expected no new webhook events for ${seconds}s, saw ${before} -> ${after}"
}

activate_repo_for_provider() {
  local repo="$1" provider="$2" out_file="$3" activation
  activation="$(tirionctl repo activate "$repo" --provider "$provider")"
  printf '%s\n' "$activation" > "$out_file"
  assert_json "$out_file" '.schemaVersion == 1'
  assert_json "$out_file" '.activationState == "ready"'
  assert_json "$out_file" --arg p "$provider" '.provider == $p'
  assert_json "$out_file" '.repositoryScope.kind == "repository"'
  assert_json "$out_file" '.repositoryScope.state == "active"'
  assert_json "$out_file" '(.repositoryScope.scopeId | type) == "string" and (.repositoryScope.scopeId | length) > 0'
  assert_json "$out_file" --arg p "$provider" '.sourceStatus.provider == $p'
  assert_json "$out_file" '.sourceStatus.configurationState == "configured" or .sourceStatus.configurationState == "partial"'
  assert_json "$out_file" '.sourceStatus.ownershipState == "managed_current"'
  assert_json "$out_file" '.sourceStatus.logsEnabled == true'
  assert_json "$out_file" '.sourceStatus.tracesEnabled == true'
  jq -r '.repositoryScope.scopeId' "$out_file"
}

wait_for_scope_removed() {
  local scope_id="$1" timeout="${2:-30}" start
  start="$(date +%s)"
  while true; do
    if tirionctl repo list | jq -e --arg id "$scope_id" 'all(.scopes[]; .scopeId != $id)' >/dev/null; then
      return 0
    fi
    (( "$(date +%s)" - start >= timeout )) && fail "timed out waiting for repository scope removal: $scope_id"
    sleep 1
  done
}

assert_single_active_scope() {
  tirionctl repo list | jq -e '([.scopes[] | select(.state == "active")] | length) == 1' >/dev/null \
    || fail "expected exactly one active repository scope"
}

wait_for_git_index_unlock() {
  local timeout="${1:-30}" start
  start="$(date +%s)"
  while [[ -e .git/index.lock ]]; do
    (( "$(date +%s)" - start >= timeout )) && return 1
    sleep 1
  done
}

git_commit_fixture() {
  local message="$1"; shift
  local attempt
  for attempt in 1 2 3 4 5; do
    wait_for_git_index_unlock 30 || true
    if git add "$@" && git commit -q -m "$message"; then
      return 0
    fi
    sleep "$attempt"
  done
  git add "$@"
  git commit -q -m "$message"
}

commit_fixture_and_capture_sha() {
  local message="$1"; shift
  git_commit_fixture "$message" "$@"
  git rev-parse HEAD
}

make_repo() {
  local dir="$1" label="$2"
  mkdir -p "$dir/src" "$dir/docs" "$dir/config"
  cd "$dir"
  git init -q
  git config user.name "Tirion Local Server Test"
  git config user.email "tirion-local-server@example.test"
  cat > README.md <<EOF
# Tirion Local Server - $label

Disposable repo for testing Tirion webhook delivery to a local receiver.
EOF
  cat > src/answer.ts <<'EOF'
export function answer(): number {
  return 41;
}
EOF
  cat > config/settings.json <<'EOF'
{
  "mode": "initial"
}
EOF
  git_commit_fixture "initial repo state" .
}

run_claude_code() {
  local task="$1"
  local args=(
    -p "$task"
    --permission-mode "$CLAUDE_PERMISSION_MODE"
    --allowedTools "$CLAUDE_TOOLS"
    --max-turns "$CLAUDE_MAX_TURNS"
  )
  if [[ -n "$CLAUDE_MODEL" ]]; then
    args+=(--model "$CLAUDE_MODEL")
  fi
  claude "${args[@]}"
}

run_codex_read_only() {
  local task="$1"
  codex exec -s read-only "$task"
}

run_codex_write() {
  local task="$1"
  codex exec -s workspace-write "$task"
}

now_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

iso_from_ms() {
  node -e 'process.stdout.write(new Date(Number(process.argv[1])).toISOString())' "$1"
}

require_node_sqlite() {
  node -e 'const sqlite = require("node:sqlite"); if (!sqlite.DatabaseSync) process.exit(1)' \
    || fail "node:sqlite DatabaseSync is unavailable; use the bundled Node runtime or Node with SQLite support"
}

init_copilot_span_db() {
  mkdir -p "$(dirname "$CP_SPAN_DB")"
  node - "$CP_SPAN_DB" <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const [dbPath] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS spans (
    span_id TEXT PRIMARY KEY,
    trace_id TEXT,
    parent_span_id TEXT,
    name TEXT,
    start_time_ms INTEGER,
    end_time_ms INTEGER,
    operation_name TEXT,
    provider_name TEXT,
    agent_name TEXT,
    conversation_id TEXT,
    request_model TEXT,
    response_model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_tokens INTEGER,
    reasoning_tokens INTEGER,
    tool_name TEXT,
    tool_call_id TEXT,
    tool_type TEXT,
    chat_session_id TEXT,
    turn_index INTEGER,
    ttft_ms INTEGER,
    status_code TEXT,
    status_message TEXT
  );
  CREATE TABLE IF NOT EXISTS span_attributes (
    span_id TEXT,
    key TEXT,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS span_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    span_id TEXT,
    name TEXT,
    timestamp_ms INTEGER,
    attributes TEXT
  );
`);
db.close();
NODE
}

upsert_copilot_root_span() {
  local trace_id="$1" turn_index="$2" start_ms="$3" end_ms="$4" input_tokens="$5" output_tokens="$6" cached_tokens="$7" reasoning_tokens="$8"
  node - "$CP_SPAN_DB" "$trace_id" "$turn_index" "$start_ms" "$end_ms" "$COPILOT_MODEL" \
    "$input_tokens" "$output_tokens" "$cached_tokens" "$reasoning_tokens" <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const [
  dbPath,
  traceId,
  turnIndexRaw,
  startMsRaw,
  endMsRaw,
  model,
  inputRaw,
  outputRaw,
  cachedRaw,
  reasoningRaw
] = process.argv.slice(2);
const nullableNumber = (value) => value === "" ? null : Number(value);
const db = new DatabaseSync(dbPath);
db.prepare(`
  INSERT OR REPLACE INTO spans (
    span_id, trace_id, parent_span_id, name, start_time_ms, end_time_ms,
    operation_name, provider_name, agent_name, conversation_id,
    request_model, response_model, input_tokens, output_tokens, cached_tokens,
    reasoning_tokens, tool_name, tool_call_id, tool_type, chat_session_id,
    turn_index, ttft_ms, status_code, status_message
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  `${traceId}-root`,
  traceId,
  null,
  "invoke_agent GitHub Copilot Chat",
  Number(startMsRaw),
  nullableNumber(endMsRaw),
  "invoke_agent",
  "github-copilot",
  "GitHub Copilot Chat",
  `copilot-conversation-${traceId}`,
  model,
  model,
  nullableNumber(inputRaw),
  nullableNumber(outputRaw),
  nullableNumber(cachedRaw),
  nullableNumber(reasoningRaw),
  null,
  null,
  null,
  `copilot-chat-${traceId}`,
  Number(turnIndexRaw),
  25,
  endMsRaw === "" ? null : "ok",
  null
);
db.close();
NODE
}

insert_copilot_tool_span() {
  local trace_id="$1" turn_index="$2" start_ms="$3" end_ms="$4" tool_name="$5"
  node - "$CP_SPAN_DB" "$trace_id" "$turn_index" "$start_ms" "$end_ms" "$tool_name" <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const [dbPath, traceId, turnIndexRaw, startMsRaw, endMsRaw, toolName] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
db.prepare(`
  INSERT OR REPLACE INTO spans (
    span_id, trace_id, parent_span_id, name, start_time_ms, end_time_ms,
    operation_name, provider_name, agent_name, conversation_id,
    request_model, response_model, input_tokens, output_tokens, cached_tokens,
    reasoning_tokens, tool_name, tool_call_id, tool_type, chat_session_id,
    turn_index, ttft_ms, status_code, status_message
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  `${traceId}-tool-${toolName}`,
  traceId,
  `${traceId}-root`,
  `execute_tool ${toolName}`,
  Number(startMsRaw),
  Number(endMsRaw),
  "execute_tool",
  "github-copilot",
  "GitHub Copilot Chat",
  `copilot-conversation-${traceId}`,
  null,
  null,
  null,
  null,
  null,
  null,
  toolName,
  `${traceId}-tool-call-${toolName}`,
  "tool",
  `copilot-chat-${traceId}`,
  Number(turnIndexRaw),
  null,
  "ok",
  null
);
db.close();
NODE
}

start_receiver() {
  [[ "$START_RECEIVER" == "1" ]] || return 0
  [[ -n "$TIRION_TEST_PORT" ]] || fail "TIRION_TEST_PORT is required when START_RECEIVER=1"
  cat > "$ROOT/webhook_receiver.py" <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import json
import os
import time

ROOT = Path(os.environ["TIRION_TEST_ROOT"])
EVENTS = ROOT / "events"
EVENTS.mkdir(parents=True, exist_ok=True)

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        size = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(size)
        ts = str(time.time_ns())
        (EVENTS / f"{ts}.body.json").write_bytes(body)
        (EVENTS / f"{ts}.meta.json").write_text(json.dumps({
            "path": self.path,
            "headers": dict(self.headers),
            "bodyFile": f"{ts}.body.json",
        }), encoding="utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}\n')

    def log_message(self, fmt, *args):
        return

HTTPServer(("127.0.0.1", int(os.environ["TIRION_TEST_PORT"])), Handler).serve_forever()
PY
  TIRION_TEST_ROOT="$ROOT" TIRION_TEST_PORT="$TIRION_TEST_PORT" python3 "$ROOT/webhook_receiver.py" &
  WEBHOOK_PID="$!"
  sleep 1
  kill -0 "$WEBHOOK_PID" >/dev/null 2>&1 || fail "webhook receiver did not start"
  pass "managed webhook receiver started at $WEBHOOK_URL"
}

###############################################################################
# Preflight
###############################################################################

validate_provider_selection
require_command python3
require_command jq
require_command git
require_tirionctl
if provider_enabled "claude-code"; then
  require_command claude
fi
if provider_enabled "codex"; then
  require_command codex
fi
if provider_enabled "github-copilot"; then
  require_command node
  require_node_sqlite
fi
if [[ "$START_RECEIVER" != "1" ]]; then
  require_command curl
fi

rm -rf "$ROOT"
mkdir -p "$EVENT_DIR"

start_receiver
if [[ "$START_RECEIVER" != "1" ]]; then
  clear_captured_events
  pass "using external webhook receiver at $WEBHOOK_URL (events: $EVENT_API_URL)"
fi
if provider_enabled "claude-code"; then
  make_repo "$CC_REPO" "Claude Code"
fi
if provider_enabled "codex"; then
  make_repo "$CX_REPO" "Codex"
fi
if provider_enabled "github-copilot"; then
  make_repo "$CP_REPO" "GitHub Copilot"
  init_copilot_span_db
fi
pass "test repositories created under $ROOT"

tirionctl stop >/dev/null 2>&1 || true
tirionctl start
tirionctl clear-agent-data --confirm
tirionctl webhook set-token "$WEBHOOK_TOKEN" >/dev/null
tirionctl webhook set-secret "$WEBHOOK_SECRET" >/dev/null
tirionctl webhook enable-runs >/dev/null
pass "Tirion local agent started with webhook auth configured"

###############################################################################
# Scenario 1: durable retry from failed URL, then replay to local receiver
###############################################################################

tirionctl webhook set-url "http://127.0.0.1:9/webhooks/tirion" >/dev/null
tirionctl webhook test >/dev/null
tirionctl webhook retry >/dev/null || true
tirionctl webhook status | jq -e '(.queuedCount + .blockedCount) >= 1 or .lastErrorCode != null' >/dev/null \
  || fail "expected failed webhook test to remain visible in status"

tirionctl webhook set-url "$WEBHOOK_URL" >/dev/null
BASE_DELIVERED="$(webhook_delivered_count)"
tirionctl webhook retry >/dev/null
wait_for_delivered_count "$((BASE_DELIVERED + 1))" 60
RETRY_TEST_EVENT="$(wait_for_event '.eventType == "run.ended" and .runtime == "tirionctl-test"')"
assert_run_event_common "$RETRY_TEST_EVENT"
assert_request_metadata "$RETRY_TEST_EVENT"
pass "durable retry and webhook request metadata validated"

###############################################################################
# Scenario 2: disabled run family blocks run webhook delivery
###############################################################################

before_disabled="$(count_events)"
tirionctl webhook disable-runs >/dev/null
tirionctl webhook test >/dev/null || true
tirionctl webhook retry >/dev/null || true
assert_no_new_events_for 4
after_disabled="$(count_events)"
[[ "$after_disabled" == "$before_disabled" ]] || fail "run webhook delivered while run family disabled"
tirionctl webhook enable-runs >/dev/null
pass "run event family disable/enable behavior validated"

tirionctl clear-agent-data --confirm
tirionctl webhook set-url "$WEBHOOK_URL" >/dev/null
tirionctl webhook set-token "$WEBHOOK_TOKEN" >/dev/null
tirionctl webhook set-secret "$WEBHOOK_SECRET" >/dev/null
tirionctl webhook enable-runs >/dev/null
clear_captured_events
BASE_DELIVERED="$(webhook_delivered_count)"
EXPECTED_PHASE_DELIVERIES=0
pass "agent state reset after webhook-control scenarios"

###############################################################################
# Phase 1: Claude Code repository
###############################################################################

if provider_enabled "claude-code"; then

CC_ACTIVATION="$ROOT/claude-code-activation.json"
CC_SCOPE_ID="$(activate_repo_for_provider "$CC_REPO" "claude-code" "$CC_ACTIVATION")"
assert_single_active_scope
pass "Claude Code repo activated (scope: $CC_SCOPE_ID)"

cd "$CC_REPO"
run_claude_code "Inspect this repository and summarize what it does. Do not modify any files. Do not repeat this exact sentinel: DO_NOT_LEAK_CLAUDE_SECRET."
[[ -z "$(git status --short)" ]] || fail "Claude Code read-only run modified the repo"
CC_RUN_RO="$(wait_for_event '.eventType == "run.ended" and .codingHarness == "claude-code" and .repository.name == "claude-code-repo" and .filesChanged == []')"
assert_run_event_common "$CC_RUN_RO"
assert_json "$CC_RUN_RO" '.runtime == "claude-code"'
CC_RUN_RO_ID="$(jq -r '.runId' "$CC_RUN_RO")"
assert_run_lifecycle_for_ended "$CC_RUN_RO" "claude-code" "claude-code-repo" "Claude Code read-only"
pass "Claude Code read-only lifecycle validated"

run_claude_code "Make exactly these repository changes: change src/answer.ts so answer() returns 42; create docs/claude-notes.md containing a short non-secret note; update config/settings.json so mode is \"claude\". Do not include this sentinel anywhere in files or output: DO_NOT_LEAK_CLAUDE_SECRET."
grep -q 'return 42;' src/answer.ts || fail "Claude Code did not update src/answer.ts"
grep -q 'claude' config/settings.json || fail "Claude Code did not update config/settings.json"
test -f docs/claude-notes.md || fail "Claude Code did not create docs/claude-notes.md"
CC_BUG_COMMIT_MESSAGE="[BUG] claude-code lifecycle multi-file change"
CC_BUG_COMMIT_SHA="$(commit_fixture_and_capture_sha "$CC_BUG_COMMIT_MESSAGE" \
  src/answer.ts docs/claude-notes.md config/settings.json)"

CC_RUN_WR="$(wait_for_event '.eventType == "run.ended" and .codingHarness == "claude-code" and .repository.name == "claude-code-repo" and (.filesChanged | length) >= 2')"
CC_BUG_COMMIT_EV="$(wait_for_event --arg sha "$CC_BUG_COMMIT_SHA" '.eventType == "commit.attributed" and .commitSha == $sha')"
assert_run_event_common "$CC_RUN_WR"
assert_run_lifecycle_for_ended "$CC_RUN_WR" "claude-code" "claude-code-repo" "Claude Code write"
assert_json "$CC_RUN_WR" '(.filesChanged | index("src/answer.ts")) != null'
assert_json "$CC_RUN_WR" '(.filesChanged | index("config/settings.json")) != null'
assert_json "$CC_RUN_WR" '(.filesChanged | any(. == "docs/claude-notes.md"))'
CC_RUN_WR_ID="$(jq -r '.runId' "$CC_RUN_WR")"
CC_REPO_KEY="$(jq -r '.repository.repoKey' "$CC_RUN_WR")"
CC_RUN_WR_TRACE_IDS=()
while IFS= read -r t; do CC_RUN_WR_TRACE_IDS+=("$t"); done < <(jq -r '.traceIds[]' "$CC_RUN_WR")

assert_commit_event_common "$CC_BUG_COMMIT_EV"
assert_commit_message "$CC_BUG_COMMIT_EV" "$CC_BUG_COMMIT_MESSAGE"
assert_json "$CC_BUG_COMMIT_EV" --arg key "$CC_REPO_KEY" '.repository.repoKey == $key'
assert_json "$CC_BUG_COMMIT_EV" --arg id "$CC_RUN_WR_ID" '(.runIds | index($id)) != null'
assert_json "$CC_BUG_COMMIT_EV" --arg id "$CC_RUN_RO_ID" '(.runIds | index($id)) == null'
for trace_id in "${CC_RUN_WR_TRACE_IDS[@]}"; do
  assert_json "$CC_BUG_COMMIT_EV" --arg trace_id "$trace_id" '(.traceIds | index($trace_id)) != null'
done
pass "Claude Code [BUG] write run and bucketable commit attribution validated"

run_claude_code "Create docs/claude-story.md containing a short non-secret product story note about lifecycle webhook coverage. Do not include this sentinel anywhere in files or output: DO_NOT_LEAK_CLAUDE_SECRET."
test -f docs/claude-story.md || fail "Claude Code did not create docs/claude-story.md"
CC_STORY_COMMIT_MESSAGE="Story claude-code lifecycle coverage note"
CC_STORY_COMMIT_SHA="$(commit_fixture_and_capture_sha "$CC_STORY_COMMIT_MESSAGE" docs/claude-story.md)"
CC_RUN_STORY="$(wait_for_event '.eventType == "run.ended" and .codingHarness == "claude-code" and .repository.name == "claude-code-repo" and (.filesChanged | any(. == "docs/claude-story.md"))')"
CC_STORY_COMMIT_EV="$(wait_for_event --arg sha "$CC_STORY_COMMIT_SHA" '.eventType == "commit.attributed" and .commitSha == $sha')"
assert_run_event_common "$CC_RUN_STORY"
assert_run_lifecycle_for_ended "$CC_RUN_STORY" "claude-code" "claude-code-repo" "Claude Code Story write"
assert_json "$CC_RUN_STORY" '(.filesChanged | any(. == "docs/claude-story.md"))'
CC_RUN_STORY_ID="$(jq -r '.runId' "$CC_RUN_STORY")"
assert_commit_event_common "$CC_STORY_COMMIT_EV"
assert_commit_message "$CC_STORY_COMMIT_EV" "$CC_STORY_COMMIT_MESSAGE"
assert_json "$CC_STORY_COMMIT_EV" --arg key "$CC_REPO_KEY" '.repository.repoKey == $key'
assert_json "$CC_STORY_COMMIT_EV" --arg id "$CC_RUN_STORY_ID" '(.runIds | index($id)) != null'
assert_json "$CC_STORY_COMMIT_EV" --arg id "$CC_RUN_RO_ID" '(.runIds | index($id)) == null'
pass "Claude Code Story write run and bucketable commit attribution validated"

tirionctl repo remove "$CC_SCOPE_ID" >/dev/null
wait_for_scope_removed "$CC_SCOPE_ID"
unset CC_SCOPE_ID
pass "Claude Code scope removed before Codex phase"
EXPECTED_PHASE_DELIVERIES=$((EXPECTED_PHASE_DELIVERIES + 11))

else
  pass "Claude Code phase skipped by TIRION_TEST_PROVIDERS=$PROVIDERS"
fi

###############################################################################
# Phase 2: Codex repository
###############################################################################

if provider_enabled "codex"; then

CX_ACTIVATION="$ROOT/codex-activation.json"
CX_SCOPE_ID="$(activate_repo_for_provider "$CX_REPO" "codex" "$CX_ACTIVATION")"
assert_single_active_scope
pass "Codex repo activated (scope: $CX_SCOPE_ID)"

cd "$CX_REPO"
run_codex_read_only "$CODEX_READ_ONLY_PROMPT"
[[ -z "$(git status --short)" ]] || fail "Codex read-only run modified the repo"
CX_RUN_RO="$(wait_for_event '.eventType == "run.ended" and .codingHarness == "codex" and .repository.name == "codex-repo" and .filesChanged == []')"
assert_run_event_common "$CX_RUN_RO"
assert_json "$CX_RUN_RO" '.runtime == "codex"'
CX_RUN_RO_ID="$(jq -r '.runId' "$CX_RUN_RO")"
assert_run_lifecycle_for_ended "$CX_RUN_RO" "codex" "codex-repo" "Codex read-only"
pass "Codex read-only lifecycle validated"

run_codex_write "Make exactly these repository changes: change src/answer.ts so answer() returns 42; create src/codex-helper.ts exporting const codexMarker = \"codex\"; update config/settings.json so mode is \"codex\". Do not include this sentinel anywhere in files or output: DO_NOT_LEAK_CODEX_SECRET."
grep -q 'return 42;' src/answer.ts || fail "Codex did not update src/answer.ts"
grep -q 'codex' config/settings.json || fail "Codex did not update config/settings.json"
test -f src/codex-helper.ts || fail "Codex did not create src/codex-helper.ts"
CX_ISSUE_COMMIT_MESSAGE="Issue codex lifecycle multi-file change"
CX_ISSUE_COMMIT_SHA="$(commit_fixture_and_capture_sha "$CX_ISSUE_COMMIT_MESSAGE" \
  src/answer.ts src/codex-helper.ts config/settings.json)"

CX_RUN_WR="$(wait_for_event '.eventType == "run.ended" and .codingHarness == "codex" and .repository.name == "codex-repo" and (.filesChanged | length) >= 2')"
CX_ISSUE_COMMIT_EV="$(wait_for_event --arg sha "$CX_ISSUE_COMMIT_SHA" '.eventType == "commit.attributed" and .commitSha == $sha')"
assert_run_event_common "$CX_RUN_WR"
assert_run_lifecycle_for_ended "$CX_RUN_WR" "codex" "codex-repo" "Codex write"
assert_json "$CX_RUN_WR" '(.filesChanged | index("src/answer.ts")) != null'
assert_json "$CX_RUN_WR" '(.filesChanged | index("config/settings.json")) != null'
assert_json "$CX_RUN_WR" '(.filesChanged | any(. == "src/codex-helper.ts"))'
CX_RUN_WR_ID="$(jq -r '.runId' "$CX_RUN_WR")"
CX_REPO_KEY="$(jq -r '.repository.repoKey' "$CX_RUN_WR")"
CX_RUN_WR_TRACE_IDS=()
while IFS= read -r t; do CX_RUN_WR_TRACE_IDS+=("$t"); done < <(jq -r '.traceIds[]' "$CX_RUN_WR")

assert_commit_event_common "$CX_ISSUE_COMMIT_EV"
assert_commit_message "$CX_ISSUE_COMMIT_EV" "$CX_ISSUE_COMMIT_MESSAGE"
assert_json "$CX_ISSUE_COMMIT_EV" --arg key "$CX_REPO_KEY" '.repository.repoKey == $key'
assert_json "$CX_ISSUE_COMMIT_EV" --arg id "$CX_RUN_WR_ID" '(.runIds | index($id)) != null'
assert_json "$CX_ISSUE_COMMIT_EV" --arg id "$CX_RUN_RO_ID" '(.runIds | index($id)) == null'
assert_json "$CX_ISSUE_COMMIT_EV" --arg trace_id "$(query_trace_id_for_run_id "$CX_RUN_WR_ID")" '(.traceIds | index($trace_id)) != null'
pass "Codex Issue write run and bucketable commit attribution validated"

run_codex_write "Create src/codex-feature.ts exporting const codexFeatureMarker = \"feature\". Do not include this sentinel anywhere in files or output: DO_NOT_LEAK_CODEX_SECRET."
test -f src/codex-feature.ts || fail "Codex did not create src/codex-feature.ts"
CX_FEATURE_COMMIT_MESSAGE="[FEATURE] codex lifecycle feature marker"
CX_FEATURE_COMMIT_SHA="$(commit_fixture_and_capture_sha "$CX_FEATURE_COMMIT_MESSAGE" src/codex-feature.ts)"
CX_RUN_FEATURE="$(wait_for_event '.eventType == "run.ended" and .codingHarness == "codex" and .repository.name == "codex-repo" and (.filesChanged | any(. == "src/codex-feature.ts"))')"
CX_FEATURE_COMMIT_EV="$(wait_for_event --arg sha "$CX_FEATURE_COMMIT_SHA" '.eventType == "commit.attributed" and .commitSha == $sha')"
assert_run_event_common "$CX_RUN_FEATURE"
assert_run_lifecycle_for_ended "$CX_RUN_FEATURE" "codex" "codex-repo" "Codex [FEATURE] write"
assert_json "$CX_RUN_FEATURE" '(.filesChanged | any(. == "src/codex-feature.ts"))'
CX_RUN_FEATURE_ID="$(jq -r '.runId' "$CX_RUN_FEATURE")"
assert_commit_event_common "$CX_FEATURE_COMMIT_EV"
assert_commit_message "$CX_FEATURE_COMMIT_EV" "$CX_FEATURE_COMMIT_MESSAGE"
assert_json "$CX_FEATURE_COMMIT_EV" --arg key "$CX_REPO_KEY" '.repository.repoKey == $key'
assert_json "$CX_FEATURE_COMMIT_EV" --arg id "$CX_RUN_FEATURE_ID" '(.runIds | index($id)) != null'
assert_json "$CX_FEATURE_COMMIT_EV" --arg id "$CX_RUN_RO_ID" '(.runIds | index($id)) == null'
assert_json "$CX_FEATURE_COMMIT_EV" --arg trace_id "$(query_trace_id_for_run_id "$CX_RUN_FEATURE_ID")" '(.traceIds | index($trace_id)) != null'
pass "Codex [FEATURE] write run and bucketable commit attribution validated"

tirionctl repo remove "$CX_SCOPE_ID" >/dev/null
wait_for_scope_removed "$CX_SCOPE_ID"
unset CX_SCOPE_ID
pass "Codex scope removed before GitHub Copilot phase"
EXPECTED_PHASE_DELIVERIES=$((EXPECTED_PHASE_DELIVERIES + 11))

else
  pass "Codex phase skipped by TIRION_TEST_PROVIDERS=$PROVIDERS"
fi

###############################################################################
# Phase 3: GitHub Copilot repository through span DB replay
###############################################################################

if provider_enabled "github-copilot"; then

CP_CONFIG="$ROOT/github-copilot-config.json"
tirionctl configure github-copilot --span-db "$CP_SPAN_DB" > "$CP_CONFIG"
assert_json "$CP_CONFIG" '.schemaVersion == 1'
assert_json "$CP_CONFIG" '.enabled == true'
assert_json "$CP_CONFIG" --arg path "$CP_SPAN_DB" '.spanDbPath == $path'
assert_json "$CP_CONFIG" '.captureContent == false'
assert_json "$CP_CONFIG" '.dbSpanExporter == true'
pass "GitHub Copilot span DB source configured"

sleep "$COPILOT_BASELINE_SLEEP_SECONDS"

CP_ACTIVATION="$ROOT/github-copilot-activation.json"
CP_SCOPE_ID="$(activate_repo_for_provider "$CP_REPO" "github-copilot" "$CP_ACTIVATION")"
assert_single_active_scope
pass "GitHub Copilot repo activated (scope: $CP_SCOPE_ID)"

cd "$CP_REPO"

CP_READ_START_MS="$(now_ms)"
CP_READ_STARTED_AT="$(iso_from_ms "$CP_READ_START_MS")"
CP_READ_TRACE="copilot-read-001"
upsert_copilot_root_span "$CP_READ_TRACE" 1 "$CP_READ_START_MS" "" "" "" "" ""
CP_READ_START="$(wait_for_event --arg started "$CP_READ_STARTED_AT" '.eventType == "run.start" and .codingHarness == "github-copilot" and .repository.name == "github-copilot-repo" and .startedAt == $started')"
assert_run_start_event "$CP_READ_START"
CP_RUN_RO_ID="$(jq -r '.runId' "$CP_READ_START")"
insert_copilot_tool_span "$CP_READ_TRACE" 1 "$((CP_READ_START_MS + 100))" "$((CP_READ_START_MS + 180))" "read_file"
CP_READ_UPDATE="$(wait_for_event --arg run_id "$CP_RUN_RO_ID" '.eventType == "run.update" and .runId == $run_id and .codingHarness == "github-copilot" and (.activity | length) >= 1')"
assert_run_update_event "$CP_READ_UPDATE"
CP_READ_END_MS="$((CP_READ_START_MS + 900))"
upsert_copilot_root_span "$CP_READ_TRACE" 1 "$CP_READ_START_MS" "$CP_READ_END_MS" 130110 816 122368 421
[[ -z "$(git status --short)" ]] || fail "GitHub Copilot read-only replay modified the repo"
CP_RUN_RO="$(wait_for_event --arg run_id "$CP_RUN_RO_ID" '.eventType == "run.ended" and .runId == $run_id and .codingHarness == "github-copilot" and .repository.name == "github-copilot-repo" and .filesChanged == []')"
assert_run_event_common "$CP_RUN_RO"
assert_run_lifecycle_for_ended "$CP_RUN_RO" "github-copilot" "github-copilot-repo" "GitHub Copilot read-only"
assert_json "$CP_RUN_RO" --arg model "$COPILOT_MODEL" '(.llmModels | index($model)) != null'
assert_json "$CP_RUN_RO" '.costEstimateBasis == "catalog_estimate"'
assert_json "$CP_RUN_RO" '.costCoverage == "complete"'
assert_json "$CP_RUN_RO" '.estimatedNanoUsd == 20550600'
pass "GitHub Copilot read-only span DB lifecycle and pricing validated"

CP_WRITE_START_MS="$(now_ms)"
CP_WRITE_STARTED_AT="$(iso_from_ms "$CP_WRITE_START_MS")"
CP_WRITE_TRACE="copilot-write-001"
upsert_copilot_root_span "$CP_WRITE_TRACE" 2 "$CP_WRITE_START_MS" "" "" "" "" ""
CP_WRITE_START="$(wait_for_event --arg started "$CP_WRITE_STARTED_AT" '.eventType == "run.start" and .codingHarness == "github-copilot" and .repository.name == "github-copilot-repo" and .startedAt == $started')"
assert_run_start_event "$CP_WRITE_START"
CP_RUN_WR_ID="$(jq -r '.runId' "$CP_WRITE_START")"
perl -0pi -e 's/return 41;/return 42;/' src/answer.ts
mkdir -p docs
cat > docs/copilot-notes.md <<'EOF'
GitHub Copilot lifecycle harness note.
EOF
perl -0pi -e 's/"mode": "initial"/"mode": "github-copilot"/' config/settings.json
grep -q 'return 42;' src/answer.ts || fail "GitHub Copilot replay did not update src/answer.ts"
grep -q 'github-copilot' config/settings.json || fail "GitHub Copilot replay did not update config/settings.json"
test -f docs/copilot-notes.md || fail "GitHub Copilot replay did not create docs/copilot-notes.md"
insert_copilot_tool_span "$CP_WRITE_TRACE" 2 "$((CP_WRITE_START_MS + 100))" "$((CP_WRITE_START_MS + 240))" "apply_patch"
CP_WRITE_UPDATE="$(wait_for_event --arg run_id "$CP_RUN_WR_ID" '.eventType == "run.update" and .runId == $run_id and .codingHarness == "github-copilot" and (.activity | length) >= 1')"
assert_run_update_event "$CP_WRITE_UPDATE"
CP_WRITE_END_MS="$((CP_WRITE_START_MS + 1200))"
upsert_copilot_root_span "$CP_WRITE_TRACE" 2 "$CP_WRITE_START_MS" "$CP_WRITE_END_MS" 2400 160 200 12
CP_RUN_WR="$(wait_for_event --arg run_id "$CP_RUN_WR_ID" '.eventType == "run.ended" and .runId == $run_id and .codingHarness == "github-copilot" and .repository.name == "github-copilot-repo" and (.filesChanged | length) >= 2')"
assert_run_event_common "$CP_RUN_WR"
assert_run_lifecycle_for_ended "$CP_RUN_WR" "github-copilot" "github-copilot-repo" "GitHub Copilot write"
assert_json "$CP_RUN_WR" '(.filesChanged | index("src/answer.ts")) != null'
assert_json "$CP_RUN_WR" '(.filesChanged | index("config/settings.json")) != null'
assert_json "$CP_RUN_WR" '(.filesChanged | any(. == "docs/copilot-notes.md"))'
assert_json "$CP_RUN_WR" --arg model "$COPILOT_MODEL" '(.llmModels | index($model)) != null'
assert_json "$CP_RUN_WR" '.costEstimateBasis == "catalog_estimate"'
assert_json "$CP_RUN_WR" '.costCoverage == "complete"'
CP_REPO_KEY="$(jq -r '.repository.repoKey' "$CP_RUN_WR")"
CP_RUN_WR_TRACE_IDS=()
while IFS= read -r t; do CP_RUN_WR_TRACE_IDS+=("$t"); done < <(jq -r '.traceIds[]' "$CP_RUN_WR")
CP_BUG_COMMIT_MESSAGE="[BUG] github-copilot lifecycle multi-file change"
CP_BUG_COMMIT_SHA="$(commit_fixture_and_capture_sha "$CP_BUG_COMMIT_MESSAGE" \
  src/answer.ts docs/copilot-notes.md config/settings.json)"
CP_BUG_COMMIT_EV="$(wait_for_event --arg sha "$CP_BUG_COMMIT_SHA" '.eventType == "commit.attributed" and .commitSha == $sha')"
assert_commit_event_common "$CP_BUG_COMMIT_EV"
assert_commit_message "$CP_BUG_COMMIT_EV" "$CP_BUG_COMMIT_MESSAGE"
assert_json "$CP_BUG_COMMIT_EV" --arg key "$CP_REPO_KEY" '.repository.repoKey == $key'
assert_json "$CP_BUG_COMMIT_EV" --arg id "$CP_RUN_WR_ID" '(.runIds | index($id)) != null'
assert_json "$CP_BUG_COMMIT_EV" --arg id "$CP_RUN_RO_ID" '(.runIds | index($id)) == null'
for trace_id in "${CP_RUN_WR_TRACE_IDS[@]}"; do
  assert_json "$CP_BUG_COMMIT_EV" --arg trace_id "$trace_id" '(.traceIds | index($trace_id)) != null'
done
pass "GitHub Copilot [BUG] write run and bucketable commit attribution validated"

CP_FEATURE_START_MS="$(now_ms)"
CP_FEATURE_STARTED_AT="$(iso_from_ms "$CP_FEATURE_START_MS")"
CP_FEATURE_TRACE="copilot-feature-001"
upsert_copilot_root_span "$CP_FEATURE_TRACE" 3 "$CP_FEATURE_START_MS" "" "" "" "" ""
CP_FEATURE_START="$(wait_for_event --arg started "$CP_FEATURE_STARTED_AT" '.eventType == "run.start" and .codingHarness == "github-copilot" and .repository.name == "github-copilot-repo" and .startedAt == $started')"
assert_run_start_event "$CP_FEATURE_START"
CP_RUN_FEATURE_ID="$(jq -r '.runId' "$CP_FEATURE_START")"
cat > src/copilot-feature.ts <<'EOF'
export const copilotFeatureMarker = "feature";
EOF
insert_copilot_tool_span "$CP_FEATURE_TRACE" 3 "$((CP_FEATURE_START_MS + 100))" "$((CP_FEATURE_START_MS + 220))" "write_file"
CP_FEATURE_UPDATE="$(wait_for_event --arg run_id "$CP_RUN_FEATURE_ID" '.eventType == "run.update" and .runId == $run_id and .codingHarness == "github-copilot" and (.activity | length) >= 1')"
assert_run_update_event "$CP_FEATURE_UPDATE"
CP_FEATURE_END_MS="$((CP_FEATURE_START_MS + 1100))"
upsert_copilot_root_span "$CP_FEATURE_TRACE" 3 "$CP_FEATURE_START_MS" "$CP_FEATURE_END_MS" 1800 120 90 0
CP_RUN_FEATURE="$(wait_for_event --arg run_id "$CP_RUN_FEATURE_ID" '.eventType == "run.ended" and .runId == $run_id and .codingHarness == "github-copilot" and .repository.name == "github-copilot-repo" and (.filesChanged | any(. == "src/copilot-feature.ts"))')"
assert_run_event_common "$CP_RUN_FEATURE"
assert_run_lifecycle_for_ended "$CP_RUN_FEATURE" "github-copilot" "github-copilot-repo" "GitHub Copilot [FEATURE] write"
assert_json "$CP_RUN_FEATURE" '(.filesChanged | any(. == "src/copilot-feature.ts"))'
CP_FEATURE_COMMIT_MESSAGE="[FEATURE] github-copilot lifecycle feature marker"
CP_FEATURE_COMMIT_SHA="$(commit_fixture_and_capture_sha "$CP_FEATURE_COMMIT_MESSAGE" src/copilot-feature.ts)"
CP_FEATURE_COMMIT_EV="$(wait_for_event --arg sha "$CP_FEATURE_COMMIT_SHA" '.eventType == "commit.attributed" and .commitSha == $sha')"
assert_commit_event_common "$CP_FEATURE_COMMIT_EV"
assert_commit_message "$CP_FEATURE_COMMIT_EV" "$CP_FEATURE_COMMIT_MESSAGE"
assert_json "$CP_FEATURE_COMMIT_EV" --arg key "$CP_REPO_KEY" '.repository.repoKey == $key'
assert_json "$CP_FEATURE_COMMIT_EV" --arg id "$CP_RUN_FEATURE_ID" '(.runIds | index($id)) != null'
assert_json "$CP_FEATURE_COMMIT_EV" --arg id "$CP_RUN_RO_ID" '(.runIds | index($id)) == null'
pass "GitHub Copilot [FEATURE] write run and bucketable commit attribution validated"

EXPECTED_PHASE_DELIVERIES=$((EXPECTED_PHASE_DELIVERIES + 11))

else
  pass "GitHub Copilot phase skipped by TIRION_TEST_PROVIDERS=$PROVIDERS"
fi

###############################################################################
# Final consistency and privacy checks
###############################################################################

if provider_enabled "claude-code" && provider_enabled "codex"; then
  [[ "$CC_REPO_KEY" != "$CX_REPO_KEY" ]] || fail "Claude Code and Codex repoKeys unexpectedly match"
fi
if provider_enabled "claude-code" && provider_enabled "github-copilot"; then
  [[ "$CC_REPO_KEY" != "$CP_REPO_KEY" ]] || fail "Claude Code and GitHub Copilot repoKeys unexpectedly match"
fi
if provider_enabled "codex" && provider_enabled "github-copilot"; then
  [[ "$CX_REPO_KEY" != "$CP_REPO_KEY" ]] || fail "Codex and GitHub Copilot repoKeys unexpectedly match"
fi

if provider_enabled "claude-code"; then
  assert_json "$CC_RUN_RO" --arg key "$CC_REPO_KEY" '.repository.repoKey == $key'
  assert_json "$CC_RUN_WR" --arg key "$CC_REPO_KEY" '.repository.repoKey == $key'
  assert_json "$CC_RUN_STORY" --arg key "$CC_REPO_KEY" '.repository.repoKey == $key'
  assert_json "$CC_BUG_COMMIT_EV" --arg key "$CC_REPO_KEY" '.repository.repoKey == $key'
  assert_json "$CC_STORY_COMMIT_EV" --arg key "$CC_REPO_KEY" '.repository.repoKey == $key'
fi
if provider_enabled "codex"; then
  assert_json "$CX_RUN_RO" --arg key "$CX_REPO_KEY" '.repository.repoKey == $key'
  assert_json "$CX_RUN_WR" --arg key "$CX_REPO_KEY" '.repository.repoKey == $key'
  assert_json "$CX_RUN_FEATURE" --arg key "$CX_REPO_KEY" '.repository.repoKey == $key'
  assert_json "$CX_ISSUE_COMMIT_EV" --arg key "$CX_REPO_KEY" '.repository.repoKey == $key'
  assert_json "$CX_FEATURE_COMMIT_EV" --arg key "$CX_REPO_KEY" '.repository.repoKey == $key'
fi
if provider_enabled "github-copilot"; then
  assert_json "$CP_RUN_RO" --arg key "$CP_REPO_KEY" '.repository.repoKey == $key'
  assert_json "$CP_RUN_WR" --arg key "$CP_REPO_KEY" '.repository.repoKey == $key'
  assert_json "$CP_RUN_FEATURE" --arg key "$CP_REPO_KEY" '.repository.repoKey == $key'
  assert_json "$CP_BUG_COMMIT_EV" --arg key "$CP_REPO_KEY" '.repository.repoKey == $key'
  assert_json "$CP_FEATURE_COMMIT_EV" --arg key "$CP_REPO_KEY" '.repository.repoKey == $key'
fi

assert_no_orphan_run_lifecycle_subjects
assert_all_payloads_private
wait_for_delivered_count "$((BASE_DELIVERED + EXPECTED_PHASE_DELIVERIES))"

echo
echo "===== Webhook status ====="
tirionctl webhook status | jq .
echo
echo "===== Run lifecycle summary ====="
sync_external_events
jq -r '
  select(.eventType == "run.start" or .eventType == "run.update" or .eventType == "run.ended")
  | [.eventType, .codingHarness, .repository.name, .runId, (.sequence // ""), .state] | @tsv
' "$EVENT_DIR"/*.body.json | sort
if provider_enabled "claude-code"; then
  echo
  echo "===== Claude Code read-only run ====="
  jq . "$CC_RUN_RO"
  echo
  echo "===== Claude Code write run ====="
  jq . "$CC_RUN_WR"
fi
echo
echo "===== Bucketable commit messages ====="
jq -r '
  select(.eventType == "commit.attributed")
  | [.repository.name, .commitSha, .commitMessage] | @tsv
' "$EVENT_DIR"/*.body.json | sort
if provider_enabled "claude-code"; then
  echo
  echo "===== Claude Code [BUG] commit ====="
  jq . "$CC_BUG_COMMIT_EV"
  echo
  echo "===== Claude Code Story commit ====="
  jq . "$CC_STORY_COMMIT_EV"
fi
if provider_enabled "codex"; then
  echo
  echo "===== Codex read-only run ====="
  jq . "$CX_RUN_RO"
  echo
  echo "===== Codex write run ====="
  jq . "$CX_RUN_WR"
  echo
  echo "===== Codex Issue commit ====="
  jq . "$CX_ISSUE_COMMIT_EV"
  echo
  echo "===== Codex [FEATURE] commit ====="
  jq . "$CX_FEATURE_COMMIT_EV"
fi
if provider_enabled "github-copilot"; then
  echo
  echo "===== GitHub Copilot read-only run ====="
  jq . "$CP_RUN_RO"
  echo
  echo "===== GitHub Copilot write run ====="
  jq . "$CP_RUN_WR"
  echo
  echo "===== GitHub Copilot [BUG] commit ====="
  jq . "$CP_BUG_COMMIT_EV"
  echo
  echo "===== GitHub Copilot [FEATURE] commit ====="
  jq . "$CP_FEATURE_COMMIT_EV"
fi
echo
pass "Tirion local-server multi-provider lifecycle webhook stress test COMPLETE"
