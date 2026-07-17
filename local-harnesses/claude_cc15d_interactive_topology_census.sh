#!/usr/bin/env bash
set -euo pipefail
umask 077

# Opt-in, source-only CC15D interactive topology census. It deliberately does
# not start a Tirion agent, configure a webhook, release a native decision, or
# claim a production correction. Claude's raw transcript stays only in the
# operator-created private profile; this harness keeps no raw hook/OTLP/CLI
# payload and reports fixed metadata categories only.

# Before use, create and authenticate a dedicated private Claude config root:
#   PRIVATE_ROOT="$(mktemp -d /tmp/tw-cc15d-claude.XXXXXX)"
#   chmod 700 "$PRIVATE_ROOT"
#   CLAUDE_CONFIG_DIR="$PRIVATE_ROOT" claude auth login --claudeai
#   find -P "$PRIVATE_ROOT" -type d -exec chmod 700 {} +

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
TMP_PARENT="/tmp"
ROOT="$(mktemp -d "$TMP_PARENT/tirion-cc15d.XXXXXX")"
chmod 700 "$ROOT"
ROOT_MARKER="$ROOT/.tirion-cc15d-harness"
: >"$ROOT_MARKER"
chmod 600 "$ROOT_MARKER"
WORKSPACE="$ROOT/workspace"
SETTINGS_FILE="$ROOT/claude-cc15d.settings.json"
MCP_CONFIG="$ROOT/empty-mcp.json"
RECEIVER_READY="$ROOT/receiver.ready"
RECEIVER_SCRIPT="$SCRIPT_DIR/claude_cc15d_interactive_topology_receiver.mjs"
ASSERTION_SCRIPT="$SCRIPT_DIR/claude_cc15d_interactive_topology_assert.mjs"
MODEL="${TIRION_CC15D_CLAUDE_MODEL:-}"
PRIVATE_CLAUDE_CONFIG_DIR="${TIRION_CC15D_CLAUDE_CONFIG_DIR:-}"
CALLER_CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CALLER_CLAUDE_COMPANION_FILE="$HOME/.claude.json"
SETTLE_SECONDS="${TIRION_CC15D_SETTLE_SECONDS:-8}"
POST_SEAL_SOAK_SECONDS="${TIRION_CC15D_POST_SEAL_SOAK_SECONDS:-2}"
MARKER="CC15D_TIRION_PRIVACY_CANARY"
RECEIVER_PID=""
RECEIVER_BASE=""
RECEIVER_CONTROL_TOKEN=""
NORMAL_PROFILE_METADATA_BEFORE=""
WORKSPACE_MANIFEST_BEFORE=""

fail() {
  printf 'CC15D topology census failed: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing_$1"
}

random_secret() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'
}

session_digest() {
  TIRION_CC15D_SESSION="$1" node -e '
    const value = process.env.TIRION_CC15D_SESSION;
    if (typeof value !== "string" || value.length < 8) process.exit(1);
    process.stdout.write(require("node:crypto").createHash("sha256").update(value).digest("hex"));
  '
}

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

claude_private_profile() (
  unset \
    ANTHROPIC_API_KEY \
    ANTHROPIC_AUTH_TOKEN \
    ANTHROPIC_BASE_URL \
    CLAUDE_CODE_OAUTH_TOKEN \
    CLAUDE_CODE_USE_BEDROCK \
    CLAUDE_CODE_USE_FOUNDRY \
    CLAUDE_CODE_USE_VERTEX
  CLAUDE_CONFIG_DIR="$PRIVATE_CLAUDE_CONFIG_DIR" command claude "$@"
)

validate_positive_integer() {
  local value="$1" minimum="$2" maximum="$3" code="$4"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || fail "$code"
  (( 10#$value >= minimum && 10#$value <= maximum )) || fail "$code"
}

# This metadata-only validator reuses CC15C's private-profile isolation
# contract. It never emits profile names, link targets, or file contents.
validate_private_claude_root() {
  TIRION_CC15D_PRIVATE_ROOT="$PRIVATE_CLAUDE_CONFIG_DIR" \
  TIRION_CC15D_CALLER_ROOT="$CALLER_CLAUDE_CONFIG_DIR" \
  TIRION_CC15D_HOME_ROOT="$HOME" \
  TIRION_CC15D_HARNESS_ROOT="$ROOT" \
    node <<'NODE'
const { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, statSync } = require("node:fs");
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require("node:path");
const reasons = new Set([
  "root_layout", "root_permissions", "root_name", "root_overlap",
  "normal_profile_alias", "normal_profile_scan", "private_tree_layout",
  "private_tree_permissions", "private_tree_limit"
]);
const reject = (reason = "root_layout") => {
  process.stdout.write(reasons.has(reason) ? reason : "root_layout");
  process.exit(1);
};
const privateRoot = process.env.TIRION_CC15D_PRIVATE_ROOT;
const callerRoot = process.env.TIRION_CC15D_CALLER_ROOT;
const homeRoot = process.env.TIRION_CC15D_HOME_ROOT;
const harnessRoot = process.env.TIRION_CC15D_HARNESS_ROOT;
if (!privateRoot || !callerRoot || !homeRoot || !harnessRoot || !isAbsolute(privateRoot)) reject();
let privateStat;
let privateReal;
try {
  const link = lstatSync(privateRoot);
  privateStat = statSync(privateRoot);
  privateReal = realpathSync.native(privateRoot);
  if (link.isSymbolicLink() || !privateStat.isDirectory()) reject();
} catch { reject(); }
if (privateStat.uid !== process.getuid?.() || (privateStat.mode & 0o077) !== 0) reject("root_permissions");
if (!/^tw-cc15(?:c|d)-claude\.[A-Za-z0-9._-]{6,128}$/.test(basename(privateReal))) reject("root_name");
const canonical = (path) => {
  try { return statSync(path).isDirectory() ? realpathSync.native(path) : resolve(path); } catch { return resolve(path); }
};
const contains = (parent, child) => {
  const fromParent = relative(parent, child);
  return fromParent === "" || (fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent));
};
const callerReal = canonical(callerRoot);
const homeReal = canonical(homeRoot);
const harnessReal = canonical(harnessRoot);
if (
  contains(callerReal, privateReal) || contains(privateReal, callerReal)
  || contains(homeReal, privateReal) || contains(privateReal, homeReal)
  || contains(privateReal, harnessReal) || contains(harnessReal, privateReal)
) reject("root_overlap");
let normalEntries = 0;
const normalDirectories = new Set();
const resolveLink = (path) => {
  const lexical = resolve(dirname(path), readlinkSync(path));
  try { return realpathSync.native(lexical); } catch { return lexical; }
};
const scanNormal = (path, depth) => {
  if (depth > 32 || ++normalEntries > 20_000) reject("normal_profile_scan");
  let link;
  try { link = lstatSync(path); } catch (error) {
    if (error?.code === "ENOENT") return;
    reject("normal_profile_scan");
  }
  if (link.isSymbolicLink()) {
    const target = resolveLink(path);
    if (contains(privateReal, target) || contains(target, privateReal)) reject("normal_profile_alias");
    let targetStat;
    try { targetStat = statSync(target); } catch (error) {
      if (error?.code === "ENOENT") return;
      reject("normal_profile_scan");
    }
    if (targetStat.isDirectory()) scanNormal(target, depth + 1);
    return;
  }
  if (!link.isDirectory()) return;
  let directoryReal;
  try { directoryReal = realpathSync.native(path); } catch { reject("normal_profile_scan"); }
  if (normalDirectories.has(directoryReal)) return;
  normalDirectories.add(directoryReal);
  let names;
  try { names = readdirSync(path); } catch { reject("normal_profile_scan"); }
  for (const name of names) scanNormal(join(path, name), depth + 1);
};
for (const path of [callerRoot, join(homeRoot, ".claude"), join(homeRoot, ".claude.json")]) scanNormal(path, 0);
const projects = join(privateReal, "projects");
try {
  try {
    const projectLink = lstatSync(projects);
    if (projectLink.isSymbolicLink() || !projectLink.isDirectory()) reject("private_tree_layout");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    mkdirSync(projects, { mode: 0o700 });
  }
} catch { reject("private_tree_layout"); }
let privateEntries = 0;
const scanPrivate = (path, depth) => {
  if (depth > 32 || ++privateEntries > 20_000) reject("private_tree_limit");
  let link; let stat; let resolved;
  try {
    link = lstatSync(path);
    stat = statSync(path);
    resolved = realpathSync.native(path);
  } catch { reject("private_tree_layout"); }
  if (link.isSymbolicLink() || !contains(privateReal, resolved)) reject("private_tree_layout");
  if (stat.uid !== process.getuid?.()) reject("private_tree_permissions");
  if (link.isDirectory()) {
    if ((stat.mode & 0o077) !== 0) reject("private_tree_permissions");
    let names;
    try { names = readdirSync(path).sort(); } catch { reject("private_tree_layout"); }
    for (const name of names) scanPrivate(join(path, name), depth + 1);
    return;
  }
  if (!link.isFile() || stat.nlink !== 1) reject("private_tree_layout");
};
scanPrivate(privateReal, 0);
NODE
}

validate_private_claude_root_or_fail() {
  local reason
  if ! reason="$(validate_private_claude_root 2>/dev/null)"; then
    case "$reason" in
      root_layout|root_permissions|root_name|root_overlap|normal_profile_alias|normal_profile_scan|private_tree_layout|private_tree_permissions|private_tree_limit) ;;
      *) reason="root_layout" ;;
    esac
    fail "private_claude_config_invalid_$reason"
  fi
}

# Fingerprint only metadata and link topology: never profile file contents.
tree_metadata_fingerprint() {
  TIRION_CC15D_TREE_ROOT="$1" node <<'NODE'
const { createHash } = require("node:crypto");
const { lstatSync, readdirSync, readlinkSync } = require("node:fs");
const { join } = require("node:path");
const root = process.env.TIRION_CC15D_TREE_ROOT;
const hash = createHash("sha256");
let entries = 0;
const add = (value) => hash.update(`${value}\0`);
const walk = (path, relativePath, depth) => {
  if (depth > 32 || ++entries > 20_000) throw new Error("limit");
  const stat = lstatSync(path, { bigint: true });
  const kind = stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other";
  add(`${relativePath}|${kind}|${stat.mode & 0o7777n}|${stat.size}|${stat.mtimeNs}|${stat.ctimeNs}|${stat.nlink}`);
  if (stat.isSymbolicLink()) { add(readlinkSync(path)); return; }
  if (!stat.isDirectory()) return;
  for (const name of readdirSync(path).sort()) walk(join(path, name), relativePath ? `${relativePath}/${name}` : name, depth + 1);
};
try { walk(root, "", 0); process.stdout.write(hash.digest("hex")); } catch { process.exit(1); }
NODE
}

normal_profile_fingerprint() {
  TIRION_CC15D_CALLER_ROOT="$CALLER_CLAUDE_CONFIG_DIR" \
  TIRION_CC15D_DEFAULT_ROOT="$HOME/.claude" \
  TIRION_CC15D_COMPANION_FILE="$CALLER_CLAUDE_COMPANION_FILE" \
    node <<'NODE'
const { createHash } = require("node:crypto");
const { lstatSync, readdirSync, readlinkSync } = require("node:fs");
const { join } = require("node:path");
const hash = createHash("sha256");
let entries = 0;
const add = (value) => hash.update(`${value}\0`);
const walk = (label, path, relativePath, depth) => {
  if (depth > 32 || ++entries > 20_000) throw new Error("limit");
  let stat;
  try { stat = lstatSync(path, { bigint: true }); } catch (error) {
    if (error?.code === "ENOENT") { add(`${label}|${relativePath}|absent`); return; }
    throw error;
  }
  const kind = stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other";
  add(`${label}|${relativePath}|${kind}|${stat.mode & 0o7777n}|${stat.size}|${stat.mtimeNs}|${stat.ctimeNs}|${stat.nlink}`);
  if (stat.isSymbolicLink()) { add(readlinkSync(path)); return; }
  if (!stat.isDirectory()) return;
  for (const name of readdirSync(path).sort()) walk(label, join(path, name), relativePath ? `${relativePath}/${name}` : name, depth + 1);
};
try {
  for (const [label, path] of [["caller", process.env.TIRION_CC15D_CALLER_ROOT], ["default", process.env.TIRION_CC15D_DEFAULT_ROOT], ["companion", process.env.TIRION_CC15D_COMPANION_FILE]]) walk(label, path, "", 0);
  process.stdout.write(hash.digest("hex"));
} catch { process.exit(1); }
NODE
}

assert_normal_profile_unchanged() {
  local after
  [[ -n "$NORMAL_PROFILE_METADATA_BEFORE" ]] || return 0
  after="$(normal_profile_fingerprint)" || fail "normal_claude_profile_snapshot_failed"
  [[ "$after" == "$NORMAL_PROFILE_METADATA_BEFORE" ]] || fail "normal_claude_profile_metadata_changed"
  NORMAL_PROFILE_METADATA_BEFORE=""
}

assert_workspace_unchanged() {
  local after
  [[ ! -e "$WORKSPACE/cc15d-denied.txt" ]] || fail "controlled_denial_created_target"
  after="$(tree_metadata_fingerprint "$WORKSPACE")" || fail "workspace_manifest_unavailable"
  [[ "$after" == "$WORKSPACE_MANIFEST_BEFORE" ]] || fail "controlled_denial_changed_workspace"
}

assert_privacy_marker_absent() {
  local scan_status
  set +e
  LC_ALL=C grep -R -a -F -- "$MARKER" "$ROOT" >/dev/null 2>&1
  scan_status="$?"
  set -e
  if (( scan_status == 0 )); then
    fail "privacy_marker_persisted"
  elif (( scan_status != 1 )); then
    fail "privacy_marker_scan_incomplete"
  fi
  TIRION_CC15D_ROOT="$ROOT" TIRION_CC15D_MARKER="$MARKER" node <<'NODE' || fail "privacy_marker_decoded_scan_incomplete"
const { lstatSync, readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const root = process.env.TIRION_CC15D_ROOT;
const marker = process.env.TIRION_CC15D_MARKER;
let files = 0; let bytesRead = 0;
const scan = (path, depth) => {
  if (depth > 32) throw new Error("limit");
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("symlink");
  if (stat.isDirectory()) { for (const name of readdirSync(path)) scan(join(path, name), depth + 1); return; }
  if (!stat.isFile() || ++files > 10_000 || stat.size > 8 * 1024 * 1024 || (bytesRead += stat.size) > 64 * 1024 * 1024) throw new Error("limit");
  let value;
  try {
    value = readFileSync(path);
    const text = value.toString("utf8");
    const decoded = text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (text.includes(marker) || decoded.includes(marker)) throw new Error("marker");
  } finally { if (value) value.fill(0); }
};
try { scan(root, 0); } catch { process.exit(1); }
NODE
}

ready_port() {
  node -e '
    const fs = require("node:fs");
    try {
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (value?.schemaVersion !== 1 || value?.ready !== true || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) process.exit(1);
      process.stdout.write(String(value.port));
    } catch { process.exit(1); }
  ' "$1"
}

wait_for_ready_port() {
  local attempt port
  for attempt in $(seq 1 120); do
    if port="$(ready_port "$RECEIVER_READY" 2>/dev/null)"; then
      printf '%s' "$port"
      return 0
    fi
    sleep 0.1
  done
  fail "receiver_not_ready"
}

receiver_status() {
  loopback_curl -fsS -H "x-tirion-cc15d-control: $RECEIVER_CONTROL_TOKEN" "$RECEIVER_BASE/control/status"
}

shutdown_receiver() {
  if [[ -n "$RECEIVER_PID" && -n "$RECEIVER_BASE" && -n "$RECEIVER_CONTROL_TOKEN" ]]; then
    loopback_curl -fsS -X POST -H "x-tirion-cc15d-control: $RECEIVER_CONTROL_TOKEN" "$RECEIVER_BASE/control/shutdown" >/dev/null 2>&1 || true
  fi
  [[ -z "$RECEIVER_PID" ]] || kill "$RECEIVER_PID" >/dev/null 2>&1 || true
  [[ -z "$RECEIVER_PID" ]] || wait "$RECEIVER_PID" >/dev/null 2>&1 || true
  RECEIVER_PID=""
}

cleanup() {
  local status="$?" after
  set +e
  shutdown_receiver
  if [[ -n "$NORMAL_PROFILE_METADATA_BEFORE" ]]; then
    after="$(normal_profile_fingerprint 2>/dev/null)"
    if [[ -z "$after" ]]; then
      printf 'CC15D topology census failed: normal_claude_profile_snapshot_failed\n' >&2
      status=1
    elif [[ "$after" != "$NORMAL_PROFILE_METADATA_BEFORE" ]]; then
      printf 'CC15D topology census failed: normal_claude_profile_metadata_changed\n' >&2
      status=1
    fi
  fi
  if [[ -f "$ROOT_MARKER" && "$ROOT" == "$TMP_PARENT"/tirion-cc15d.* ]]; then
    rm -rf -- "$ROOT"
  fi
  return "$status"
}
trap cleanup EXIT

[[ "$MODEL" =~ ^claude-[a-z0-9][a-z0-9.-]*$ && "$MODEL" =~ [0-9] \
  && ! "$MODEL" =~ (^|[.-])(latest|current)([.-]|$) ]] \
  || fail "model_must_be_exact_immutable_id"
[[ -t 0 && -t 1 ]] || fail "interactive_terminal_required"
[[ -n "$PRIVATE_CLAUDE_CONFIG_DIR" ]] || fail "private_claude_config_required"
[[ -f "$RECEIVER_SCRIPT" && -f "$ASSERTION_SCRIPT" ]] || fail "census_harness_missing"
validate_positive_integer "$SETTLE_SECONDS" 2 30 "invalid_settle_seconds"
validate_positive_integer "$POST_SEAL_SOAK_SECONDS" 2 30 "invalid_post_seal_soak_seconds"
require_command node
require_command claude
require_command curl
require_command jq
validate_private_claude_root_or_fail
configure_loopback_proxy_bypass

NORMAL_PROFILE_METADATA_BEFORE="$(normal_profile_fingerprint)" || fail "normal_claude_profile_snapshot_failed"
AUTH_SAFE="$(claude_private_profile auth status --json 2>/dev/null | jq -c '{loggedIn,authMethod,apiProvider,subscriptionType}' 2>/dev/null || true)"
[[ -n "$AUTH_SAFE" ]] \
  && jq -e '.loggedIn == true and .authMethod == "claude.ai" and .apiProvider == "firstParty"' <<<"$AUTH_SAFE" >/dev/null \
  || fail "private_claude_profile_not_authenticated"
CLAUDE_VERSION_RAW="$(claude_private_profile --version 2>/dev/null | head -n 1)"
CLAUDE_VERSION="$(sed -E 's/^([0-9]+\.[0-9]+\.[0-9]+).*/\1/' <<<"$CLAUDE_VERSION_RAW")"
[[ "$CLAUDE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "claude_version_unavailable"

SESSION_ID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
SESSION_DIGEST="$(session_digest "$SESSION_ID")" || fail "session_digest_unavailable"
[[ "$SESSION_DIGEST" =~ ^[a-f0-9]{64}$ ]] || fail "session_digest_invalid"
INGRESS_TOKEN="$(random_secret)"
RECEIVER_CONTROL_TOKEN="$(random_secret)"
[[ "$INGRESS_TOKEN" =~ ^[A-Za-z0-9_-]{32,128}$ && "$RECEIVER_CONTROL_TOKEN" =~ ^[A-Za-z0-9_-]{32,128}$ ]] || fail "secret_generation_failed"

mkdir -p "$WORKSPACE"
chmod 700 "$WORKSPACE"
WORKSPACE_MANIFEST_BEFORE="$(tree_metadata_fingerprint "$WORKSPACE")" || fail "workspace_manifest_unavailable"

TIRION_CC15D_INGRESS_TOKEN="$INGRESS_TOKEN" \
TIRION_CC15D_CONTROL_TOKEN="$RECEIVER_CONTROL_TOKEN" \
TIRION_CC15D_EXPECTED_SESSION_DIGEST="$SESSION_DIGEST" \
  node "$RECEIVER_SCRIPT" >"$RECEIVER_READY" 2>"$ROOT/receiver.stderr" &
RECEIVER_PID="$!"
RECEIVER_PORT="$(wait_for_ready_port)"
RECEIVER_BASE="http://127.0.0.1:$RECEIVER_PORT"

TIRION_CC15D_SETTINGS_FILE="$SETTINGS_FILE" \
TIRION_CC15D_MCP_CONFIG="$MCP_CONFIG" \
TIRION_CC15D_RECEIVER_BASE="$RECEIVER_BASE" \
TIRION_CC15D_INGRESS_TOKEN="$INGRESS_TOKEN" \
  node <<'NODE'
const { chmodSync, writeFileSync } = require("node:fs");
const { TIRION_CC15D_SETTINGS_FILE: settingsFile, TIRION_CC15D_MCP_CONFIG: mcpConfig, TIRION_CC15D_RECEIVER_BASE: receiverBase, TIRION_CC15D_INGRESS_TOKEN: ingressToken } = process.env;
const events = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure"];
const noMatcher = new Set(["UserPromptSubmit", "Stop"]);
const hook = (eventName) => ({
  ...(noMatcher.has(eventName) ? {} : { matcher: "*" }),
  hooks: [{
    type: "http",
    url: `${receiverBase}/v1/provider-hooks/claude-code`,
    timeout: 10,
    headers: {
      Authorization: `Bearer ${ingressToken}`,
      "X-Tirion-CC15D-Receiver": ingressToken,
      "X-Tirion-Hook-Event": eventName,
    },
  }],
});
writeFileSync(settingsFile, `${JSON.stringify({ hooks: Object.fromEntries(events.map((eventName) => [eventName, [hook(eventName)]])) }, null, 2)}\n`, { mode: 0o600 });
chmodSync(settingsFile, 0o600);
writeFileSync(mcpConfig, `${JSON.stringify({ mcpServers: {} })}\n`, { mode: 0o600 });
chmodSync(mcpConfig, 0o600);
NODE

set +e
(
  cd -- "$WORKSPACE"
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
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT="$RECEIVER_BASE/v1/logs" \
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="$RECEIVER_BASE/v1/traces" \
    OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer $INGRESS_TOKEN,X-Tirion-CC15D-Receiver=$INGRESS_TOKEN" \
    OTEL_EXPORTER_OTLP_LOGS_HEADERS="Authorization=Bearer $INGRESS_TOKEN,X-Tirion-CC15D-Receiver=$INGRESS_TOKEN" \
    OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Bearer $INGRESS_TOKEN,X-Tirion-CC15D-Receiver=$INGRESS_TOKEN" \
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
    OTEL_METRICS_INCLUDE_SESSION_ID=true
  printf '%s\n' 'CC15D is ready. Submit the supplied one-Write prompt, wait for the controlled denial, then type /exit. This census has no CLI budget cap and exposes no MCP or built-in tools.' >&2
  claude_private_profile \
    --model "$MODEL" \
    --session-id "$SESSION_ID" \
    --settings "$SETTINGS_FILE" \
    --setting-sources project,local \
    --strict-mcp-config \
    --mcp-config "$MCP_CONFIG" \
    --permission-mode dontAsk \
    --tools Write \
    --allowedTools "Write(./cc15d-denied.txt)"
)
CLAUDE_EXIT="$?"
set -e

validate_private_claude_root >/dev/null 2>&1 || fail "private_claude_config_changed_after_claude"
[[ "$CLAUDE_EXIT" -eq 0 ]] || fail "claude_exit_nonzero"
assert_workspace_unchanged

# Claude's exporters use a 250ms cadence in this child; retain a bounded quiet
# interval after the TTY exits so the census reads a stable source snapshot.
sleep "$SETTLE_SECONDS"
loopback_curl -fsS -X POST -H "x-tirion-cc15d-control: $RECEIVER_CONTROL_TOKEN" "$RECEIVER_BASE/control/seal" >/dev/null 2>&1 \
  || fail "receiver_seal_failed"

# Keep the authenticated loopback receiver live through a bounded sealed soak.
# Any post-seal Claude exporter attempt is rejected and becomes a fixed result
# rather than disappearing into a closed-port connection failure.
sleep "$POST_SEAL_SOAK_SECONDS"
FINAL_STATUS="$(receiver_status 2>/dev/null)" || fail "receiver_final_status_failed"

shutdown_receiver
assert_workspace_unchanged
assert_privacy_marker_absent
assert_normal_profile_unchanged

printf '%s' "$FINAL_STATUS" | node "$ASSERTION_SCRIPT" "$MODEL" "$CLAUDE_VERSION"
