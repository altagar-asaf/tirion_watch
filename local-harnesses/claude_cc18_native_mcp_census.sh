#!/usr/bin/env bash
set -euo pipefail
umask 077

# Interactive CC-18 source census. This is a disposable, direct loopback
# capture used only to identify bounded native MCP metadata shapes. It never
# reads or retains Claude transcripts and never writes raw telemetry, CLI
# output, credentials, tool arguments, or tool results to disk.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
FIXTURE="$SCRIPT_DIR/claude_cc18_local_mcp_test.sh"
RECEIVER="$SCRIPT_DIR/claude_metadata_census_receiver.mjs"
MODEL="${TIRION_CC18_CLAUDE_MODEL:-}"
QUIET_MS="${TIRION_CC18_CENSUS_QUIET_MS:-2500}"
EXPECTED_SERVER="tirion_cc18_local"
EXPECTED_TOOL_NAME="tirion_cc18_readonly_success"
EXPECTED_NAMESPACED_TOOL="mcp__${EXPECTED_SERVER}__${EXPECTED_TOOL_NAME}"

fail() {
  printf 'CC18 native census failed: %s\n' "$1" >&2
  exit 1
}

[[ -t 0 && -t 1 ]] || fail "interactive_tty_required"
[[ -x "$FIXTURE" && -f "$RECEIVER" ]] || fail "fixture_or_receiver_missing"
command -v claude >/dev/null 2>&1 || fail "claude_missing"
command -v curl >/dev/null 2>&1 || fail "curl_missing"
command -v node >/dev/null 2>&1 || fail "node_missing"
[[ "$MODEL" =~ ^claude-[a-z0-9][a-z0-9.-]*$ && "$MODEL" =~ [0-9] \
  && ! "$MODEL" =~ (^|[.-])(latest|current)([.-]|$) ]] \
  || fail "exact_immutable_model_required"
[[ "$QUIET_MS" =~ ^[0-9]+$ ]] || fail "quiet_ms_invalid"

loopback_curl() {
  command curl -q --noproxy '*' --connect-timeout 2 --max-time 5 "$@"
}

configure_loopback_proxy_bypass() {
  local bypass="127.0.0.1,localhost,::1"
  [[ -z "${NO_PROXY:-}" ]] || bypass+=",${NO_PROXY}"
  [[ -z "${no_proxy:-}" ]] || bypass+=",${no_proxy}"
  export NO_PROXY="$bypass"
  export no_proxy="$bypass"
}

TMP_PARENT="${TMPDIR:-/tmp}"
TMP_PARENT="${TMP_PARENT%/}"
ROOT="$(mktemp -d "$TMP_PARENT/tirion-cc18-native-census.XXXXXX")" || fail "temporary_root_unavailable"
chmod 700 "$ROOT"
REPO="$ROOT/repo"
SAFE_DIR="$ROOT/safe"
SETTINGS_FILE="$ROOT/settings.json"
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
  rm -rf -- "$ROOT"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$REPO" "$SAFE_DIR"
chmod 700 "$REPO" "$SAFE_DIR"

CLAUDE_VERSION="$(claude --version 2>/dev/null | sed -E 's/^([0-9]+\.[0-9]+\.[0-9]+).*/\1/' | head -n 1)"
[[ "$CLAUDE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "claude_version_unavailable"
SCENARIO="cc18_native_mcp_census"
BEARER_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"

TIRION_CENSUS_CLAUDE_VERSION="$CLAUDE_VERSION" \
TIRION_CENSUS_CLI_MODE="interactive-local-mcp-census" \
TIRION_CENSUS_AUTH_CLASS="operator-managed" \
TIRION_CENSUS_API_PROVIDER="firstParty" \
TIRION_CENSUS_MODEL="$MODEL" \
TIRION_CENSUS_BEARER_TOKEN="$BEARER_TOKEN" \
TIRION_CENSUS_TOOL_PERMISSIONS_JSON='[]' \
TIRION_CENSUS_CC18_STATIC_MCP_FIXTURE=readonly-success \
TIRION_CENSUS_REJECT_TOOL_NAME='' \
TIRION_CENSUS_STOP_BLOCK_COUNT=0 \
  node "$RECEIVER" \
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
  kill -0 "$RECEIVER_PID" >/dev/null 2>&1 || fail "receiver_start_failed"
  sleep 0.05
done
[[ -s "$READINESS_FILE" ]] || fail "receiver_readiness_missing"
BASE_URL="$(node - "$READINESS_FILE" <<'NODE'
const { readFileSync } = require("node:fs");
let readiness;
try { readiness = JSON.parse(readFileSync(process.argv[2], "utf8").trim().split("\n")[0]); } catch { process.exit(1); }
if (readiness?.schemaVersion !== 1 || readiness.host !== "127.0.0.1" || !Number.isInteger(readiness.port) || readiness.port < 1 || readiness.port > 65535) process.exit(1);
process.stdout.write(`http://${readiness.host}:${readiness.port}`);
NODE
)" || fail "receiver_readiness_invalid"

node - "$SETTINGS_FILE" "$BASE_URL" "$BEARER_TOKEN" "$SCENARIO" "$EXPECTED_NAMESPACED_TOOL" <<'NODE'
const { chmodSync, writeFileSync } = require("node:fs");
const [path, baseUrl, token, scenario, expectedTool] = process.argv.slice(2);
const events = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop"];
const noMatcher = new Set(["UserPromptSubmit", "Stop"]);
const headers = {
  Authorization: `Bearer ${token}`,
  "X-Tirion-Census-Scenario": scenario,
};
const hooks = Object.fromEntries(events.map((event) => [event, [{
  ...(noMatcher.has(event) ? {} : { matcher: expectedTool }),
  hooks: [{
    type: "http",
    url: `${baseUrl}/v1/provider-hooks/claude-code`,
    headers: { ...headers, "X-Tirion-Hook-Event": event },
    timeout: 10,
  }],
}]]));
writeFileSync(path, `${JSON.stringify({ hooks }, null, 2)}\n`, { mode: 0o600 });
chmodSync(path, 0o600);
NODE

configure_loopback_proxy_bypass
loopback_curl -fsS \
  -H "Authorization: Bearer $BEARER_TOKEN" \
  -H "X-Tirion-Census-Scenario: $SCENARIO" \
  "$BASE_URL/control/status" >/dev/null || fail "receiver_not_ready"

printf '%s\n' "CC18 native metadata census is ready. Submit the supplied one-tool prompt, wait for the response, then type /exit. This uses a disposable local MCP and direct metadata-only loopback receiver." >&2
set +e
(
  # Claude's bundled exporter can apply ambient values before temporary
  # settings take effect. Clear the only high-precedence selectors and set
  # every logs/traces layer in this child process, never in the caller shell.
  unset \
    OTEL_SDK_DISABLED \
    OTEL_SERVICE_NAME \
    OTEL_RESOURCE_ATTRIBUTES \
    OTEL_TRACES_SAMPLER \
    OTEL_TRACES_SAMPLER_ARG
  export \
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
    OTEL_EXPORTER_OTLP_LOGS_HEADERS="Authorization=Bearer $BEARER_TOKEN,X-Tirion-Census-Scenario=$SCENARIO" \
    OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Bearer $BEARER_TOKEN,X-Tirion-Census-Scenario=$SCENARIO" \
    OTEL_EXPORTER_OTLP_COMPRESSION=none \
    OTEL_EXPORTER_OTLP_LOGS_COMPRESSION=none \
    OTEL_EXPORTER_OTLP_TRACES_COMPRESSION=none \
    OTEL_BSP_SCHEDULE_DELAY=250 \
    OTEL_LOGS_EXPORT_INTERVAL=250 \
    OTEL_TRACES_EXPORT_INTERVAL=250 \
    OTEL_LOG_USER_PROMPTS=0 \
    OTEL_LOG_ASSISTANT_RESPONSES=0 \
    OTEL_LOG_TOOL_DETAILS=1 \
    OTEL_LOG_TOOL_CONTENT=0 \
    OTEL_LOG_RAW_API_BODIES=0 \
    OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false \
    OTEL_METRICS_INCLUDE_SESSION_ID=true \
    TIRION_CC18_CLAUDE_MODEL="$MODEL" \
    TIRION_CC18_CLAUDE_SETTINGS="$SETTINGS_FILE" \
    TIRION_CC18_CLAUDE_SETTING_SOURCES="project,local" \
    TIRION_CC18_WORKDIR="$REPO"
  "$FIXTURE" success
)
FIXTURE_EXIT="$?"
set -e
[[ "$FIXTURE_EXIT" -eq 0 ]] || fail "fixture_failed"

QUIET_DEADLINE=$((SECONDS + 20))
QUIET_REACHED=0
while (( SECONDS <= QUIET_DEADLINE )); do
  STATUS="$(loopback_curl -fsS \
    -H "Authorization: Bearer $BEARER_TOKEN" \
    -H "X-Tirion-Census-Scenario: $SCENARIO" \
    "$BASE_URL/control/status" 2>/dev/null || true)"
  if [[ -n "$STATUS" ]] && node -e '
    try { process.exit(JSON.parse(process.argv[1]).quiet === true ? 0 : 1); } catch { process.exit(1); }
  ' "$STATUS"; then
    QUIET_REACHED=1
    break
  fi
  sleep 0.2
done
[[ "$QUIET_REACHED" == "1" ]] || fail "telemetry_quiet_timeout"

loopback_curl -fsS -X POST \
  -H "Authorization: Bearer $BEARER_TOKEN" \
  -H "X-Tirion-Census-Scenario: $SCENARIO" \
  "$BASE_URL/control/shutdown" >/dev/null || fail "receiver_shutdown_failed"
wait "$RECEIVER_PID" >/dev/null 2>&1 || fail "receiver_exit_failed"
RECEIVER_PID=""

node - "$EVENTS_FILE" "$SUMMARY_FILE" "$MANIFEST_FILE" "$ROOT" "$BEARER_TOKEN" "$EXPECTED_SERVER" "$EXPECTED_TOOL_NAME" "$EXPECTED_NAMESPACED_TOOL" <<'NODE'
const { readFileSync, statSync } = require("node:fs");
const [eventsPath, summaryPath, manifestPath, root, token, expectedServer, expectedToolName, expectedNamespacedTool] = process.argv.slice(2);
const fail = (reason) => {
  process.stderr.write(`CC18 native census failed: ${reason}\n`);
  process.exit(1);
};
let events;
let summary;
let manifest;
try {
  events = readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch {
  fail("safe_output_invalid");
}
if (events.length < 1 || summary?.rawCapturePersisted !== false || manifest?.rawCapturePersisted !== false) fail("safe_output_contract");
for (const path of [eventsPath, summaryPath, manifestPath]) {
  if ((statSync(path).mode & 0o777) !== 0o600) fail("safe_output_permissions");
}
const serialized = JSON.stringify({ events, summary, manifest });
if (serialized.includes(root) || serialized.includes(token)) fail("safe_output_private_value");
const attributesFor = (event) => event && typeof event.attributes === "object" && event.attributes !== null ? event.attributes : {};
const toolNameFor = (event) => {
  const attributes = attributesFor(event);
  return attributes.tool_name ?? attributes["gen_ai.tool.name"];
};
const toolUseIdFor = (event) => typeof event?.identities?.toolUseId === "string"
  ? event.identities.toolUseId
  : undefined;
const isExpectedTool = (event) => toolNameFor(event) === expectedNamespacedTool;
const isExplicitPair = (event) => {
  const attributes = attributesFor(event);
  return (attributes["mcp_server.name"] === expectedServer && attributes["mcp_tool.name"] === expectedToolName)
    || (event.mcpServerName === expectedServer && event.mcpToolName === expectedToolName);
};
const hookEvents = events.filter((event) => event.kind === "hook");
const nativeEvents = events.filter((event) => event.kind !== "hook");
const matchingPre = hookEvents.filter((event) => event.name === "PreToolUse" && isExpectedTool(event));
const matchingPost = hookEvents.filter((event) => event.name === "PostToolUse" && isExpectedTool(event));
const matchingFailure = hookEvents.filter((event) => event.name === "PostToolUseFailure" && isExpectedTool(event));
const approvedPreIds = new Set(matchingPre
  .filter((event) => event.guardDecision === "allow" && event.guardReasonCode === "cc18_static_mcp_fixture")
  .map(toolUseIdFor)
  .filter(Boolean));
const successfulPostIds = new Set(matchingPost
  .filter((event) => event.outcome === "success")
  .map(toolUseIdFor)
  .filter(Boolean));
const qualifiedHookPair = matchingPre.length === 1
  && matchingPost.length === 1
  && matchingFailure.length === 0
  && approvedPreIds.size === 1
  && successfulPostIds.size === 1
  && [...approvedPreIds][0] === [...successfulPostIds][0];
const hookMcpEvidence = matchingPre.length === 0 && matchingPost.length === 0 && matchingFailure.length === 0
  ? "none"
  : qualifiedHookPair ? "qualified" : "ambiguous";
const explicitNativeRecords = nativeEvents.filter(isExplicitPair);
const namespacedNativeRecords = nativeEvents.filter(isExpectedTool);
const nativeMcpEvidence = explicitNativeRecords.length > 0
  ? "explicit_server_tool_pair"
  : namespacedNativeRecords.length > 0 ? "namespaced_tool_name" : "none";
const expectedHookIds = new Set([...approvedPreIds, ...successfulPostIds]);
const nativeCorrelatedRecordCount = nativeEvents
  .filter((event) => isExplicitPair(event) || isExpectedTool(event))
  .filter((event) => expectedHookIds.has(toolUseIdFor(event))).length;
const unexpectedHookToolRecordCount = hookEvents.filter((event) => (
  event.name === "PreToolUse" || event.name === "PostToolUse" || event.name === "PostToolUseFailure"
) && typeof toolNameFor(event) === "string" && !isExpectedTool(event)).length;
const mcpConnectionRecordCount = events.filter((event) => event.name === "mcp_server_connection").length;
process.stdout.write(
  `CC18 native MCP census complete: native_mcp_evidence=${nativeMcpEvidence} hook_mcp_evidence=${hookMcpEvidence} native_correlated_records=${nativeCorrelatedRecordCount} explicit_metadata_records=${explicitNativeRecords.length} namespaced_tool_records=${namespacedNativeRecords.length} mcp_connection_records=${mcpConnectionRecordCount} pre_tool_use_records=${matchingPre.length} post_tool_use_records=${matchingPost.length} post_tool_use_failure_records=${matchingFailure.length} unexpected_hook_tool_records=${unexpectedHookToolRecordCount} total_safe_records=${events.length}\n`,
);
NODE
