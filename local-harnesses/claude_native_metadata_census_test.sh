#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# Claude Code native metadata-only census
#
# Captures hooks, OTLP logs, and enhanced traces through the in-memory
# allowlisting receiver. Raw provider bodies, headers, CLI stdout, and CLI
# stderr are never written. The private disposable repository is always
# deleted. Set TIRION_CENSUS_OUTPUT_DIR to retain only the safe outputs.
#
# Usage:
#   TIRION_CENSUS_CLAUDE_MODEL=claude-sonnet-5 \
#     ./local-harnesses/claude_native_metadata_census_test.sh read-only
#
# Scenarios:
#   read-only | structured-write | failed-bash | rejected-read |
#   direct-subagent | skill-control | skill-invocation | blocked-stop |
#   background-bash | stop-failure
#
# StopFailure without user authentication:
#   TIRION_CENSUS_CLAUDE_MODEL=claude-sonnet-5 \
#   TIRION_CENSUS_ALLOW_SYNTHETIC_INVALID_API_KEY=1 \
#     ./local-harnesses/claude_native_metadata_census_test.sh stop-failure
###############################################################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCENARIO="${1:-}"
MODEL="${TIRION_CENSUS_CLAUDE_MODEL:-}"
QUIET_MS="${TIRION_CENSUS_QUIET_MS:-2500}"
QUIET_TIMEOUT_SECONDS="${TIRION_CENSUS_QUIET_TIMEOUT_SECONDS:-20}"
MAX_BUDGET_USD="${TIRION_CENSUS_MAX_BUDGET_USD:-0.15}"
OUTPUT_DIR="${TIRION_CENSUS_OUTPUT_DIR:-}"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

usage() {
  sed -n '4,27p' "$0" >&2
  exit 2
}

case "$SCENARIO" in
  read-only|structured-write|failed-bash|rejected-read|direct-subagent|skill-control|skill-invocation|blocked-stop|background-bash|stop-failure) ;;
  *) usage ;;
esac

[[ "$MODEL" =~ ^claude-[a-z0-9][a-z0-9.-]*$ && "$MODEL" =~ [0-9] \
  && ! "$MODEL" =~ (^|[.-])(latest|current)([.-]|$) ]] \
  || fail "TIRION_CENSUS_CLAUDE_MODEL must be an exact immutable Claude model ID, not a moving alias"
[[ "$QUIET_MS" =~ ^[0-9]+$ ]] || fail "TIRION_CENSUS_QUIET_MS must be an integer"
[[ "$QUIET_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || fail "TIRION_CENSUS_QUIET_TIMEOUT_SECONDS must be an integer"

require_command claude
require_command curl
require_command git
require_command jq
require_command node
require_command rg
require_command shasum

umask 077
TMP_PARENT="${TMPDIR:-/tmp}"
TMP_PARENT="${TMP_PARENT%/}"
ROOT="$(mktemp -d "$TMP_PARENT/tirion-claude-metadata-census.XXXXXX")"
chmod 700 "$ROOT"
MARKER="$ROOT/.tirion-claude-metadata-census"
: > "$MARKER"
chmod 600 "$MARKER"
REPO="$ROOT/repo"
SAFE_DIR="$ROOT/safe"
SETTINGS_FILE="$ROOT/flag-settings.json"
MCP_CONFIG="$ROOT/empty-mcp.json"
EMPTY_AUTH_DIR="$ROOT/empty-auth"
EVENTS_FILE="$SAFE_DIR/events.safe.ndjson"
SUMMARY_FILE="$SAFE_DIR/summary.safe.json"
MANIFEST_FILE="$SAFE_DIR/manifest.safe.json"
READINESS_FILE="$ROOT/receiver-readiness.jsonl"
RECEIVER_PID=""

cleanup() {
  set +e
  if [[ -n "$RECEIVER_PID" ]]; then
    kill "$RECEIVER_PID" >/dev/null 2>&1 || true
    wait "$RECEIVER_PID" >/dev/null 2>&1 || true
  fi
  if [[ -f "$MARKER" && "$ROOT" == "$TMP_PARENT"/tirion-claude-metadata-census.* ]]; then
    rm -rf -- "$ROOT"
  fi
}
trap cleanup EXIT

mkdir -p "$REPO" "$SAFE_DIR" "$EMPTY_AUTH_DIR"
chmod 700 "$REPO" "$SAFE_DIR" "$EMPTY_AUTH_DIR"

if [[ -n "$OUTPUT_DIR" ]]; then
  OUTPUT_DIR="$(node - "$OUTPUT_DIR" "$ROOT" <<'NODE'
const { existsSync, lstatSync, mkdirSync, statSync } = require("node:fs");
const { relative, resolve, sep } = require("node:path");
const reject = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
const [requested, privateRoot] = process.argv.slice(2).map((value) => resolve(value));
const fromRoot = relative(privateRoot, requested);
if (!fromRoot || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== "..")) {
  reject("TIRION_CENSUS_OUTPUT_DIR must be outside the disposable root");
}
if (!existsSync(requested)) {
  mkdirSync(requested, { recursive: true, mode: 0o700 });
}
const stat = statSync(requested);
const link = lstatSync(requested);
if (link.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
  reject("TIRION_CENSUS_OUTPUT_DIR must be a private directory owned by the current user");
}
process.stdout.write(requested);
NODE
)" || fail "invalid TIRION_CENSUS_OUTPUT_DIR"
fi

CLAUDE_VERSION_RAW="$(claude --version 2>/dev/null | head -n 1)"
CLAUDE_VERSION="$(sed -E 's/^([0-9]+\.[0-9]+\.[0-9]+).*/\1/' <<<"$CLAUDE_VERSION_RAW")"
[[ "$CLAUDE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "unable to read an exact Claude Code version"

AUTH_CLASS=""
API_PROVIDER=""
if [[ "$SCENARIO" == "stop-failure" ]]; then
  [[ "${TIRION_CENSUS_ALLOW_SYNTHETIC_INVALID_API_KEY:-0}" == "1" ]] \
    || fail "stop-failure requires TIRION_CENSUS_ALLOW_SYNTHETIC_INVALID_API_KEY=1"
  AUTH_CLASS="synthetic-invalid-api-key"
  API_PROVIDER="firstParty"
else
  # Project only the non-identifying fields. The unprojected status JSON is
  # never stored in a shell variable or file.
  AUTH_SAFE="$(claude auth status --json 2>/dev/null \
    | jq -c '{loggedIn, authMethod, apiProvider, subscriptionType}' 2>/dev/null || true)"
  [[ -n "$AUTH_SAFE" ]] || fail "Claude authentication status is unavailable"
  [[ "$(jq -r '.loggedIn == true' <<<"$AUTH_SAFE")" == "true" ]] \
    || fail "Claude is not authenticated; this harness never performs login"
  AUTH_METHOD="$(jq -r '.authMethod // "unknown"' <<<"$AUTH_SAFE")"
  SUBSCRIPTION_TYPE="$(jq -r '.subscriptionType // "unknown"' <<<"$AUTH_SAFE")"
  API_PROVIDER="$(jq -r '.apiProvider // "unknown"' <<<"$AUTH_SAFE")"
  if [[ "$AUTH_METHOD" == "claude.ai" ]]; then
    AUTH_CLASS="subscription:$SUBSCRIPTION_TYPE"
  else
    AUTH_CLASS="$AUTH_METHOD"
  fi
fi
[[ "$AUTH_CLASS" =~ ^[A-Za-z0-9][A-Za-z0-9_.:-]*$ ]] || fail "Claude auth class is not a bounded metadata token"
[[ "$API_PROVIDER" =~ ^[A-Za-z0-9][A-Za-z0-9_.:-]*$ ]] || fail "Claude API provider is not a bounded metadata token"

USER_SETTINGS_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
USER_SETTINGS_FILE="$USER_SETTINGS_ROOT/settings.json"
settings_fingerprint() {
  if [[ -f "$USER_SETTINGS_FILE" ]]; then
    shasum -a 256 "$USER_SETTINGS_FILE" | awk '{print $1}'
  else
    echo "absent"
  fi
}
SETTINGS_BEFORE="$(settings_fingerprint)"

(
  cd "$REPO"
  git init -q
  git config user.name "Tirion Claude Census"
  git config user.email "tirion-claude-census@example.test"
  cat > README.md <<'EOF'
# Claude Metadata Census

This repository contains only synthetic fixtures for a disposable telemetry census.
EOF
  cat > fail-seven.sh <<'EOF'
#!/usr/bin/env bash
exit 7
EOF
  chmod 700 fail-seven.sh
  cat > background-wait.sh <<'EOF'
#!/usr/bin/env bash
sleep 12
EOF
  chmod 700 background-wait.sh
  mkdir -p fixtures
  mkdir -p .claude/skills/tirion-claude-census-skill
  cat > .claude/skills/tirion-claude-census-skill/SKILL.md <<'EOF'
---
name: tirion-claude-census-skill
description: Use only when explicitly asked to invoke the Tirion Claude metadata census skill.
---

Reply exactly: TIRION_CLAUDE_CENSUS_SKILL_USED
EOF
  git add README.md fail-seven.sh background-wait.sh .claude/skills/tirion-claude-census-skill/SKILL.md
  git commit -q -m "initial synthetic census repository"
)

REJECT_TOOL=""
STOP_BLOCK_COUNT=0
TOOLS=""
TOOL_PERMISSIONS_JSON='[]'
CLI_ALLOWED_TOOLS=()
MAX_TURNS=5
case "$SCENARIO" in
  read-only)
    TOOLS="Read,Glob,Grep"
    TOOL_PERMISSIONS_JSON='[{"toolName":"Read","relativePath":"README.md"}]'
    CLI_ALLOWED_TOOLS+=("Read(./README.md)")
    PROMPT='Use the Read tool exactly once to inspect README.md. Do not modify files. Reply exactly: TIRION_CENSUS_READ_DONE. Do not repeat PROMPT_CONTENT_CANARY_CC00.'
    ;;
  structured-write)
    TOOLS="Write,Read"
    TOOL_PERMISSIONS_JSON='[{"toolName":"Write","relativePath":"fixtures/claude-census-write.txt"},{"toolName":"Read","relativePath":"fixtures/claude-census-write.txt"}]'
    CLI_ALLOWED_TOOLS+=("Write(./fixtures/claude-census-write.txt)" "Read(./fixtures/claude-census-write.txt)")
    PROMPT='Use Write exactly once to create fixtures/claude-census-write.txt with exact bytes FILE_CONTENT_CANARY_CC01 and no trailing newline. Read it once, then reply exactly: TIRION_CENSUS_WRITE_DONE.'
    ;;
  failed-bash)
    TOOLS="Bash"
    TOOL_PERMISSIONS_JSON='[{"toolName":"Bash","command":"./fail-seven.sh"}]'
    CLI_ALLOWED_TOOLS+=("Bash(./fail-seven.sh)")
    PROMPT='Run ./fail-seven.sh exactly once. Do not retry it. Then reply exactly: TIRION_CENSUS_BASH_FAILURE_OBSERVED. Do not repeat COMMAND_CONTENT_CANARY_CC04.'
    ;;
  rejected-read)
    TOOLS="Read"
    TOOL_PERMISSIONS_JSON='[{"toolName":"Read","relativePath":"README.md"}]'
    REJECT_TOOL="Read"
    PROMPT='Attempt to use Read on README.md exactly once. If denied, do not retry. Reply exactly: TIRION_CENSUS_REJECTION_OBSERVED. Do not repeat REJECTION_CONTENT_CANARY_CC03.'
    ;;
  direct-subagent)
    TOOLS="Agent,Read,Glob,Grep"
    TOOL_PERMISSIONS_JSON='[{"toolName":"Agent","subagentType":"Explore"},{"toolName":"Read","relativePath":"README.md"}]'
    CLI_ALLOWED_TOOLS+=("Agent(Explore)" "Read(./README.md)")
    MAX_TURNS=8
    PROMPT='Launch exactly one Explore subagent and tell it to use Read exactly once on README.md. Wait for it, then reply exactly: TIRION_CENSUS_SUBAGENT_DONE. Do not repeat SUBAGENT_CONTENT_CANARY_CC05.'
    ;;
  skill-control)
    TOOLS="Read"
    TOOL_PERMISSIONS_JSON='[{"toolName":"Read","relativePath":"README.md"}]'
    CLI_ALLOWED_TOOLS+=("Read(./README.md)")
    PROMPT='The tirion-claude-census-skill exists, but do not invoke any skill. Read README.md once and reply exactly: TIRION_CENSUS_SKILL_CONTROL_DONE. Do not repeat SKILL_CONTROL_CANARY_CC15.'
    ;;
  skill-invocation)
    TOOLS="Skill,Read"
    TOOL_PERMISSIONS_JSON='[{"toolName":"Skill","skillName":"tirion-claude-census-skill"}]'
    CLI_ALLOWED_TOOLS+=("Skill(tirion-claude-census-skill)")
    PROMPT='Invoke tirion-claude-census-skill exactly once with the Skill tool and follow it. Do not repeat SKILL_PROMPT_CANARY_CC16.'
    ;;
  blocked-stop)
    TOOLS=""
    STOP_BLOCK_COUNT=1
    MAX_TURNS=4
    PROMPT='Reply exactly: TIRION_CENSUS_BLOCKED_STOP_DONE. If a Stop hook asks you to continue, reply with that exact text once more. Do not repeat BLOCKED_STOP_PROMPT_CANARY_CC11.'
    ;;
  background-bash)
    TOOLS="Bash"
    TOOL_PERMISSIONS_JSON='[{"toolName":"Bash","command":"./background-wait.sh"}]'
    CLI_ALLOWED_TOOLS+=("Bash(./background-wait.sh)")
    MAX_TURNS=5
    PROMPT='Run ./background-wait.sh exactly once with the Bash tool in background mode. Do not poll it, wait for it, or invoke another tool. Immediately reply exactly: TIRION_CENSUS_BACKGROUND_STARTED. Do not repeat BACKGROUND_PROMPT_CANARY_CC12.'
    ;;
  stop-failure)
    TOOLS=""
    MAX_TURNS=1
    MAX_BUDGET_USD="0.01"
    PROMPT='Reply exactly: TIRION_CENSUS_STOP_FAILURE_SHOULD_NOT_COMPLETE. Do not repeat STOP_FAILURE_PROMPT_CANARY_CC13.'
    ;;
esac

PARITY_ARGS=(
  "$TOOL_PERMISSIONS_JSON"
  "$REJECT_TOOL"
  "$TOOLS"
  "$SCRIPT_DIR/claude_metadata_census_acceptance.mjs"
)
if (( ${#CLI_ALLOWED_TOOLS[@]} > 0 )); then
  PARITY_ARGS+=("${CLI_ALLOWED_TOOLS[@]}")
fi
node --input-type=module - "${PARITY_ARGS[@]}" <<'NODE'
import { pathToFileURL } from "node:url";
const [policyJson, rejectedTool, availableCsv, acceptancePath, ...cliPermissions] = process.argv.slice(2);
const { assertToolPermissionParity } = await import(pathToFileURL(acceptancePath));
const policy = JSON.parse(policyJson);
assertToolPermissionParity(policy, rejectedTool, availableCsv ? availableCsv.split(",") : [], cliPermissions);
NODE

BEARER_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
INVALID_API_KEY="sk-ant-api03-TIRION_SYNTHETIC_INVALID_KEY_DO_NOT_PERSIST_000000000000000000000000000000000000000000000000"

TIRION_CENSUS_CLAUDE_VERSION="$CLAUDE_VERSION" \
TIRION_CENSUS_CLI_MODE="non-interactive-print" \
TIRION_CENSUS_AUTH_CLASS="$AUTH_CLASS" \
TIRION_CENSUS_API_PROVIDER="$API_PROVIDER" \
TIRION_CENSUS_MODEL="$MODEL" \
TIRION_CENSUS_BEARER_TOKEN="$BEARER_TOKEN" \
TIRION_CENSUS_TOOL_PERMISSIONS_JSON="$TOOL_PERMISSIONS_JSON" \
TIRION_CENSUS_REJECT_TOOL_NAME="$REJECT_TOOL" \
TIRION_CENSUS_STOP_BLOCK_COUNT="$STOP_BLOCK_COUNT" \
  node "$SCRIPT_DIR/claude_metadata_census_receiver.mjs" \
    --port 0 \
    --output "$EVENTS_FILE" \
    --summary "$SUMMARY_FILE" \
    --manifest "$MANIFEST_FILE" \
    --repo-root "$REPO" \
    --scenario "$SCENARIO" \
    --quiet-ms "$QUIET_MS" \
    >"$READINESS_FILE" 2>/dev/null &
RECEIVER_PID="$!"
chmod 600 "$READINESS_FILE"

for _ in $(seq 1 100); do
  [[ -s "$READINESS_FILE" ]] && break
  kill -0 "$RECEIVER_PID" >/dev/null 2>&1 || fail "metadata receiver exited during startup"
  sleep 0.05
done
[[ -s "$READINESS_FILE" ]] || fail "metadata receiver did not publish readiness"
READINESS="$(head -n 1 "$READINESS_FILE")"
jq -e '.schemaVersion == 1 and .host == "127.0.0.1" and (.port | type == "number" and . > 0 and . <= 65535)' \
  <<<"$READINESS" >/dev/null || fail "metadata receiver published invalid readiness"
PORT="$(jq -r '.port' <<<"$READINESS")"
BASE_URL="http://127.0.0.1:$PORT"
curl -fsS -H "Authorization: Bearer $BEARER_TOKEN" -H "X-Tirion-Census-Scenario: $SCENARIO" \
  "$BASE_URL/control/status" >/dev/null \
  || fail "metadata receiver did not become ready"

node - "$SETTINGS_FILE" "$BASE_URL" "$BEARER_TOKEN" "$SCENARIO" <<'NODE'
const { chmodSync, writeFileSync } = require("node:fs");
const [path, baseUrl, token, scenario] = process.argv.slice(2);
const headers = {
  Authorization: `Bearer ${token}`,
  "X-Tirion-Census-Scenario": scenario,
};
const noMatcher = new Set(["UserPromptSubmit", "Stop"]);
const events = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure",
];
const hooks = Object.fromEntries(events.map((event) => [event, [{
  ...(noMatcher.has(event) ? {} : { matcher: "*" }),
  hooks: [{
    type: "http",
    url: `${baseUrl}/v1/provider-hooks/claude-code`,
    headers: {
      ...headers,
      "X-Tirion-Hook-Event": event,
    },
    timeout: 10,
  }],
}]]));
writeFileSync(path, `${JSON.stringify({ hooks }, null, 2)}\n`, { mode: 0o600 });
chmodSync(path, 0o600);
NODE

node - "$MCP_CONFIG" <<'NODE'
const { chmodSync, writeFileSync } = require("node:fs");
const path = process.argv[2];
writeFileSync(path, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`, { mode: 0o600 });
chmodSync(path, 0o600);
NODE

CLAUDE_ARGS=(
  -p
  --output-format json
  --model "$MODEL"
  --no-session-persistence
  --settings "$SETTINGS_FILE"
  --setting-sources project,local
  --strict-mcp-config
  --mcp-config "$MCP_CONFIG"
  --permission-mode dontAsk
  --max-turns "$MAX_TURNS"
  --max-budget-usd "$MAX_BUDGET_USD"
  --tools "$TOOLS"
)
if (( ${#CLI_ALLOWED_TOOLS[@]} > 0 )); then
  CLAUDE_ARGS+=(--allowedTools "${CLI_ALLOWED_TOOLS[@]}")
fi

set +e
(
  cd "$REPO"
  if [[ "$SCENARIO" == "stop-failure" ]]; then
    export CLAUDE_CONFIG_DIR="$EMPTY_AUTH_DIR"
    export ANTHROPIC_API_KEY="$INVALID_API_KEY"
    unset \
      ANTHROPIC_AUTH_TOKEN \
      ANTHROPIC_BASE_URL \
      CLAUDE_CODE_OAUTH_TOKEN \
      CLAUDE_CODE_USE_BEDROCK \
      CLAUDE_CODE_USE_FOUNDRY \
      CLAUDE_CODE_USE_VERTEX
  fi
  # Despite its metrics-oriented name, Claude applies this gate to native logs
  # and traces too. The census receiver aliases the fresh session in memory
  # and rejects raw identity persistence or output.
  printf '%s\n' "$PROMPT" | env \
    CLAUDE_CODE_ENABLE_TELEMETRY=1 \
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1 \
    OTEL_METRICS_EXPORTER=none \
    OTEL_LOGS_EXPORTER=otlp \
    OTEL_TRACES_EXPORTER=otlp \
    OTEL_EXPORTER_OTLP_PROTOCOL=http/json \
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json \
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json \
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT="$BASE_URL/v1/logs" \
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="$BASE_URL/v1/traces" \
    OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer $BEARER_TOKEN,X-Tirion-Census-Scenario=$SCENARIO" \
    OTEL_LOG_USER_PROMPTS=0 \
    OTEL_LOG_ASSISTANT_RESPONSES=0 \
    OTEL_LOG_TOOL_DETAILS=1 \
    OTEL_LOG_TOOL_CONTENT=0 \
    OTEL_LOG_RAW_API_BODIES=0 \
    OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false \
    OTEL_METRICS_INCLUDE_SESSION_ID=true \
    OTEL_LOGS_EXPORT_INTERVAL=500 \
    OTEL_TRACES_EXPORT_INTERVAL=500 \
      claude "${CLAUDE_ARGS[@]}" >/dev/null 2>/dev/null
)
CLAUDE_EXIT="$?"
set -e

if [[ "$SCENARIO" == "stop-failure" ]]; then
  [[ "$CLAUDE_EXIT" -ne 0 ]] || fail "synthetic invalid API key unexpectedly produced a successful Claude run"
else
  [[ "$CLAUDE_EXIT" -eq 0 ]] || fail "Claude scenario failed after authentication preflight"
fi

REPOSITORY_STATUS="$(git -C "$REPO" status --porcelain=v1 --untracked-files=all)"
if [[ "$SCENARIO" == "structured-write" ]]; then
  [[ "$REPOSITORY_STATUS" == "?? fixtures/claude-census-write.txt" ]] \
    || fail "structured-write changed anything other than the expected fixture"
  node - "$REPO/fixtures/claude-census-write.txt" <<'NODE'
const assert = require("node:assert/strict");
const { lstatSync, readFileSync } = require("node:fs");
const path = process.argv[2];
const stat = lstatSync(path);
assert.equal(stat.isFile(), true);
assert.equal(stat.isSymbolicLink(), false);
assert.equal(readFileSync(path, "utf8"), "FILE_CONTENT_CANARY_CC01");
NODE
else
  [[ -z "$REPOSITORY_STATUS" ]] || fail "non-write scenario changed the disposable repository"
fi

QUIET_DEADLINE=$((SECONDS + QUIET_TIMEOUT_SECONDS))
QUIET_REACHED=0
while (( SECONDS <= QUIET_DEADLINE )); do
  STATUS="$(curl -fsS -H "Authorization: Bearer $BEARER_TOKEN" -H "X-Tirion-Census-Scenario: $SCENARIO" \
    "$BASE_URL/control/status" 2>/dev/null || true)"
  if [[ -n "$STATUS" && "$(jq -r '.quiet == true' <<<"$STATUS" 2>/dev/null)" == "true" ]]; then
    QUIET_REACHED=1
    break
  fi
  sleep 0.2
done

curl -fsS -X POST -H "Authorization: Bearer $BEARER_TOKEN" -H "X-Tirion-Census-Scenario: $SCENARIO" \
  "$BASE_URL/control/shutdown" >/dev/null 2>&1 || true
wait "$RECEIVER_PID" >/dev/null 2>&1 || true
RECEIVER_PID=""

[[ "$QUIET_REACHED" == "1" ]] || fail "provider telemetry did not reach the bounded quiet condition"
[[ -s "$EVENTS_FILE" ]] || fail "metadata receiver produced no safe events"
[[ -s "$SUMMARY_FILE" && -s "$MANIFEST_FILE" ]] || fail "safe summary or manifest is missing"

SETTINGS_AFTER="$(settings_fingerprint)"
[[ "$SETTINGS_AFTER" == "$SETTINGS_BEFORE" ]] || fail "Claude user settings changed during isolated census"

FORBIDDEN_VALUES=(
  "$ROOT"
  "$BEARER_TOKEN"
  "$INVALID_API_KEY"
  "PROMPT_CONTENT_CANARY_CC00"
  "FILE_CONTENT_CANARY_CC01"
  "COMMAND_CONTENT_CANARY_CC04"
  "REJECTION_CONTENT_CANARY_CC03"
  "SUBAGENT_CONTENT_CANARY_CC05"
  "SKILL_CONTROL_CANARY_CC15"
  "SKILL_PROMPT_CANARY_CC16"
  "BLOCKED_STOP_PROMPT_CANARY_CC11"
  "BACKGROUND_PROMPT_CANARY_CC12"
  "STOP_FAILURE_PROMPT_CANARY_CC13"
)
for forbidden in "${FORBIDDEN_VALUES[@]}"; do
  if [[ -n "$forbidden" ]] && rg -F --quiet -- "$forbidden" "$EVENTS_FILE" "$SUMMARY_FILE" "$MANIFEST_FILE"; then
    fail "forbidden census value reached safe output"
  fi
done

node --input-type=module - "$EVENTS_FILE" "$SUMMARY_FILE" "$MANIFEST_FILE" "$SCENARIO" "$MODEL" \
  "$SCRIPT_DIR/claude_metadata_census_acceptance.mjs" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [eventsPath, summaryPath, manifestPath, scenario, requestedModel, acceptancePath] = process.argv.slice(2);
const {
  assertObservedModelContract,
  assertSuccessfulLlmTopology,
  assertStopFailureLlmTopology,
} = await import(pathToFileURL(acceptancePath));
const events = readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

for (const path of [eventsPath, summaryPath, manifestPath]) {
  assert.equal(statSync(path).mode & 0o777, 0o600, `${path} is not private`);
}
assert.ok(events.length > 0, "scenario emitted no safe records");
assert.equal(events.some((event) => Object.hasOwn(event, "causalRelativePath")), false, "causal path emitted before final contradiction horizon");
assert.equal(summary.rawCapturePersisted, false);
assert.equal(summary.acceptedRecordCount, events.length);
assert.equal(manifest.rawCapturePersisted, false);
assert.equal(manifest.requestedModel, requestedModel);
assert.deepEqual(manifest.requestedTelemetryGates, {
  userPrompts: false,
  assistantResponses: false,
  toolDetails: true,
  toolContent: false,
  rawApiBodies: false,
  enhancedTelemetry: true,
});
assert.equal(manifest.telemetryGateEffectObserved, false);

const exactModel = /^claude-(?=[a-z0-9.-]*[0-9])[a-z0-9][a-z0-9.-]{2,119}$/;
for (const model of [manifest.requestedModel, ...manifest.observedModels]) {
  assert.match(model, exactModel, `moving or invalid model alias retained: ${model}`);
  assert.doesNotMatch(model, /(?:^|[.-])(?:latest|current)(?:[.-]|$)/, `moving model alias retained: ${model}`);
}
for (const event of events) {
  for (const [key, value] of Object.entries(event.attributes ?? {})) {
    if (key === "model" || key === "gen_ai.request.model") assert.match(value, exactModel);
    if (typeof value === "string" && key !== "error") {
      assert.match(value, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/, `free-form attribute retained at ${key}`);
    }
  }
}

const hooks = (name, toolName) => events.filter((event) => event.kind === "hook"
  && event.name === name
  && (toolName == null || event.attributes?.tool_name === toolName));
const preTools = hooks("PreToolUse");
const userPrompts = hooks("UserPromptSubmit");
const stops = hooks("Stop");
const stopFailures = hooks("StopFailure");
assert.equal(userPrompts.length, 1, "expected exactly one UserPromptSubmit hook");

const closedInteractions = events.filter((event) => event.kind === "span"
  && event.name === "claude_code.interaction"
  && event.providerStartedAt
  && event.providerEndedAt);
assert.equal(closedInteractions.length, 1, "expected exactly one closed root interaction span");
const terminal = scenario === "stop-failure" ? stopFailures[0] : stops.at(-1);
if (scenario === "stop-failure") {
  assert.equal(stopFailures.length, 1, "CC-13 requires exactly one StopFailure");
  assert.equal(stops.length, 0, "CC-13 must not produce Stop");
  assert.equal(stopFailures[0].attributes?.error, "authentication_failed");
  assert.equal(preTools.length, 0, "CC-13 must not invoke a tool");
  assert.ok(events.some((event) => (event.name === "api_error" || event.name === "claude_code.api_error" || event.name === "claude_code.llm_request")
    && (event.attributes?.status_code === 401 || event.statusCode === 401)), "CC-13 requires a native 401 request");
} else if (scenario === "blocked-stop") {
  assert.equal(stops.length, 2, "CC-11 requires one blocked Stop and one final Stop");
  assert.equal(stopFailures.length, 0, "CC-11 must not produce StopFailure");
  assert.equal(stops[0].guardDecision, "block", "CC-11 first Stop was not blocked by the census receiver");
  assert.equal(stops[0].guardReasonCode, "scenario_stop_block");
  assert.equal(stops[0].attributes?.stop_hook_active, false);
  assert.equal(stops[0].backgroundTaskCount, 0);
  assert.equal(stops[0].sessionCronCount, 0);
  assert.equal(stops[1].guardDecision, undefined, "CC-11 final Stop must be allowed");
  assert.equal(stops[1].attributes?.stop_hook_active, true, "CC-11 proves stop_hook_active can be true on final Stop");
  assert.equal(stops[1].backgroundTaskCount, 0);
  assert.equal(stops[1].sessionCronCount, 0);
} else if (scenario === "background-bash") {
  assert.equal(stops.length, 1, "CC-12 expected one paused Stop before non-interactive exit");
  assert.equal(stopFailures.length, 0, "CC-12 must not produce StopFailure");
  assert.equal(stops[0].attributes?.stop_hook_active, false);
  assert.equal(stops[0].backgroundTaskCount, 1, "CC-12 did not expose the exact active background task count");
  assert.equal(stops[0].sessionCronCount, 0);
} else {
  assert.equal(stops.length, 1, "successful scenario requires exactly one Stop");
  assert.equal(stopFailures.length, 0, "successful scenario must not produce StopFailure");
}

for (const identity of ["sessionId", "promptId"]) {
  const hookAnchors = [userPrompts[0], terminal];
  assert.ok(hookAnchors.every((event) => typeof event?.identities?.[identity] === "string"), `missing ${identity} hook anchor`);
  assert.equal(new Set(hookAnchors.map((event) => event.identities[identity])).size, 1, `${identity} hook mismatch`);
}
const nativeSessionAlias = userPrompts[0].identities.sessionId;
assert.equal(
  closedInteractions[0].identities?.sessionId,
  nativeSessionAlias,
  "closed root interaction must carry the hook session alias"
);
const promptBridges = events.filter((event) => event.kind === "log"
  && (event.name === "user_prompt" || event.name === "claude_code.user_prompt")
  && event.identities?.promptId === userPrompts[0].identities.promptId
  && event.identities?.sessionId === nativeSessionAlias
  && event.identities?.traceId === closedInteractions[0].identities?.traceId
  && event.identities?.spanId === closedInteractions[0].identities?.spanId);
assert.equal(promptBridges.length, 1, "expected one prompt-log bridge to the closed root interaction");
assertObservedModelContract(manifest.observedModels, requestedModel, {
  allowTitleModel: true,
});
if (scenario === "stop-failure") {
  assertStopFailureLlmTopology(events, requestedModel, closedInteractions[0]);
} else {
  assertSuccessfulLlmTopology(events, requestedModel, closedInteractions[0]);
}

const assertTool = (toolName, outcome, { rejected = false } = {}) => {
  const pre = hooks("PreToolUse", toolName);
  assert.equal(pre.length, 1, `${toolName} requires exactly one PreToolUse`);
  assert.equal(pre[0].guardDecision, rejected ? "deny" : "allow");
  assert.equal(pre[0].outcome, rejected ? "rejected" : undefined);
  const completed = [...hooks("PostToolUse", toolName), ...hooks("PostToolUseFailure", toolName)];
  if (rejected) {
    assert.equal(completed.length, 0, `${toolName} rejection must not look executed`);
    return pre[0];
  }
  assert.equal(completed.length, 1, `${toolName} requires exactly one completion hook`);
  assert.equal(completed[0].outcome, outcome);
  assert.equal(completed[0].identities?.toolUseId, pre[0].identities?.toolUseId, `${toolName} tool identity mismatch`);
  return completed[0];
};

switch (scenario) {
  case "read-only":
    assert.equal(preTools.length, 1);
    assertTool("Read", "success");
    assert.deepEqual(summary.causalWrites, []);
    break;
  case "structured-write": {
    assert.equal(preTools.length, 2);
    assertTool("Write", "success");
    assertTool("Read", "success");
    assert.deepEqual(summary.causalWrites, ["fixtures/claude-census-write.txt"]);
    break;
  }
  case "failed-bash":
    assert.equal(preTools.length, 1);
    assertTool("Bash", "failure");
    assert.deepEqual(summary.causalWrites, []);
    break;
  case "rejected-read":
    assert.equal(preTools.length, 1);
    assertTool("Read", "rejected", { rejected: true });
    assert.deepEqual(summary.causalWrites, []);
    break;
  case "direct-subagent": {
    assert.equal(preTools.length, 2);
    const agentTool = assertTool("Agent", "success");
    assertTool("Read", "success");
    const starts = hooks("SubagentStart");
    const childStops = hooks("SubagentStop");
    assert.equal(starts.length, 1, "expected exactly one subagent start");
    assert.equal(childStops.length, 1, "expected exactly one subagent stop");
    assert.equal(
      agentTool.identities?.toolResponseAgentId,
      starts[0].identities?.agentId,
      "Agent tool response identity did not join the SubagentStart identity",
    );
    assert.equal(starts[0].identities?.agentId, childStops[0].identities?.agentId, "child agent identity mismatch");
    assert.match(starts[0].identities?.agentId ?? "", /^agent_[0-9]{3}$/);
    assert.deepEqual(summary.causalWrites, []);
    break;
  }
  case "skill-control":
    assert.equal(preTools.length, 1);
    assertTool("Read", "success");
    assert.equal(events.filter((event) => event.name.endsWith("skill_activated")).length, 0);
    assert.deepEqual(summary.causalWrites, []);
    break;
  case "skill-invocation":
    assert.equal(preTools.length, 1);
    assertTool("Skill", "success");
    assert.equal(events.filter((event) => event.name.endsWith("skill_activated")).length, 1, "expected one native skill activation");
    assert.deepEqual(summary.causalWrites, []);
    break;
  case "blocked-stop":
    assert.equal(preTools.length, 0);
    assert.deepEqual(summary.causalWrites, []);
    break;
  case "background-bash":
    assert.equal(preTools.length, 1);
    assertTool("Bash", "success");
    assert.deepEqual(summary.causalWrites, []);
    break;
  case "stop-failure":
    assert.deepEqual(summary.causalWrites, []);
    break;
  default:
    assert.fail(`unsupported scenario ${scenario}`);
}
NODE

if [[ -n "$OUTPUT_DIR" ]]; then
  for source in "$EVENTS_FILE" "$SUMMARY_FILE" "$MANIFEST_FILE"; do
    destination="$OUTPUT_DIR/$(basename "$source")"
    [[ ! -e "$destination" && ! -L "$destination" ]] || fail "safe output already exists: $destination"
  done
  for source in "$EVENTS_FILE" "$SUMMARY_FILE" "$MANIFEST_FILE"; do
    destination="$OUTPUT_DIR/$(basename "$source")"
    cp "$source" "$destination"
    chmod 600 "$destination"
  done
  pass "safe metadata retained in $OUTPUT_DIR"
else
  jq -n \
    --slurpfile manifest "$MANIFEST_FILE" \
    --slurpfile summary "$SUMMARY_FILE" \
    '{manifest: $manifest[0], summary: $summary[0]}'
fi

pass "Claude metadata-only census completed: $SCENARIO"
