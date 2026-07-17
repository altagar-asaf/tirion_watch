#!/usr/bin/env bash
set -euo pipefail

# Opt-in live CC15C acceptance probe. It starts a disposable direct Tirion
# agent, metadata-only receiver, and in-memory relay, then runs one bounded
# authenticated Claude Code prompt. The persisted Claude transcript lives only
# in a user-provisioned, disposable profile; this harness never copies normal
# Claude credentials or modifies normal Claude settings.
#
# Before use, create and authenticate a dedicated private Claude config root:
#   PRIVATE_ROOT="$(mktemp -d /tmp/tw-cc15c-claude.XXXXXX)"
#   chmod 700 "$PRIVATE_ROOT"
#   CLAUDE_CONFIG_DIR="$PRIVATE_ROOT" claude auth login --claudeai
#   find -P "$PRIVATE_ROOT" -type d -exec chmod 700 {} +
#
# Usage:
#   env -u CLAUDE_CONFIG_DIR \
#     TIRION_CC15C_CLAUDE_CONFIG_DIR="$PRIVATE_ROOT" \
#     TIRION_CC15C_CLAUDE_MODEL=<immutable-model-id> \
#     ./local-harnesses/claude_cc15c_late_decision_acceptance_test.sh
#
# For a live human-authority acceptance, set
# `TIRION_CC15C_PROMPT_MODE=interactive`. The harness then opens Claude in the
# terminal without supplying a prompt; submit the separately supplied controlled
# prompt yourself and type `/exit` after its response. This exercises the
# native interactive provenance lane rather than treating a piped `-p` input as
# customer authority; `TelemetryIngress` still requires Claude's exact native
# human/typed evidence and does not infer human identity from the TTY. Interactive
# Claude does not support its `--max-budget-usd` print-mode cap, so keep the turn
# deliberately short and exit after the probe.
#
# The dedicated profile retains Claude's ordinary raw session transcript so
# Tirion can resolve UserPromptSubmit provenance. Review and delete that
# profile manually after the test; it is deliberately outside this harness's
# disposable root and is never scanned or removed automatically.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_PARENT="${TMPDIR:-/tmp}"
TMP_PARENT="${TMP_PARENT%/}"
umask 077
ROOT="$(mktemp -d "$TMP_PARENT/tirion-cc15c.XXXXXX")"
chmod 700 "$ROOT"
ROOT_MARKER="$ROOT/.tirion-cc15c-harness"
: > "$ROOT_MARKER"
chmod 600 "$ROOT_MARKER"
REPOSITORY="$ROOT/repository"
AGENT_STATE_DIR="$ROOT/agent-state"
AGENT_RUNTIME_DIR="$ROOT/agent-runtime"
AGENT_SOCKET="$AGENT_RUNTIME_DIR/agent.sock"
ISOLATED_CODEX_HOME="$ROOT/codex-home"
ISOLATED_CURSOR_HOME="$ROOT/cursor-home"
SETTINGS_FILE="$ROOT/claude-cc15c.settings.json"
MCP_CONFIG="$ROOT/empty-mcp.json"
AGENT_STATUS_FILE="$ROOT/agent-status.json"
AGENT_ENTRY="${TIRION_CC15C_AGENT_ENTRY:-$PROJECT_ROOT/packages/agent/dist/main.js}"
TIRIONCTL_BIN="${TIRION_CC15C_TIRIONCTL:-$PROJECT_ROOT/packages/tirionctl/dist/main.js}"
MODEL="${TIRION_CC15C_CLAUDE_MODEL:-}"
PRIVATE_CLAUDE_CONFIG_DIR="${TIRION_CC15C_CLAUDE_CONFIG_DIR:-}"
CALLER_CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CALLER_CLAUDE_COMPANION_FILE="$HOME/.claude.json"
# Claude supports this cap only in non-interactive --print mode. Keep it
# isolated to that negative-control invocation rather than implying that a
# manually typed acceptance turn has a CLI-enforced spend cap.
MAX_BUDGET_USD="${TIRION_CC15C_MAX_BUDGET_USD:-0.15}"
WAIT_SECONDS="${TIRION_CC15C_WAIT_SECONDS:-60}"
FINAL_QUIET_SECONDS="${TIRION_CC15C_FINAL_QUIET_SECONDS:-2}"
QUIESCE_TIMEOUT_MS="${TIRION_CC15C_QUIESCE_TIMEOUT_MS:-60000}"
RELAY_HOLD_MS="${TIRION_CC15C_RELAY_HOLD_MS:-180000}"
PROMPT_MODE="${TIRION_CC15C_PROMPT_MODE:-noninteractive}"
MARKER="CC15C_TIRION_PRIVACY_CANARY"
ASSERTION_SCRIPT="$SCRIPT_DIR/claude_delayed_decision_acceptance_assert.mjs"
ADMISSION_DIAGNOSTIC_SCRIPT="$SCRIPT_DIR/claude_cc15c_admission_diagnostic.mjs"
RELAY_SCRIPT="$SCRIPT_DIR/claude_delayed_decision_relay.mjs"
RECEIVER_SCRIPT="$SCRIPT_DIR/claude_delayed_decision_receiver.mjs"
AGENT_PID=""
RELAY_PID=""
RECEIVER_PID=""
NORMAL_PROFILE_METADATA_BEFORE=""
REPOSITORY_MANIFEST_BEFORE_CLAUDE=""

# An inherited export attribute would otherwise make a caller-provided marker
# or prompt visible to the Claude child as an ambient environment variable.
export -n MARKER 2>/dev/null || true

fail() {
  printf 'CC15C acceptance failed: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing_$1"
}

tirionctl() {
  if [[ "$TIRIONCTL_BIN" == *.js ]]; then
    node "$TIRIONCTL_BIN" "$@"
  else
    command "$TIRIONCTL_BIN" "$@"
  fi
}

random_secret() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'
}

relay_session_digest() {
  TIRION_CC15C_RAW_SESSION="$1" node -e '
    const value = process.env.TIRION_CC15C_RAW_SESSION;
    if (typeof value !== "string" || value.length < 8) process.exit(1);
    process.stdout.write(require("node:crypto").createHash("sha256").update(value).digest("hex"));
  '
}

webhook_session_id() {
  TIRION_CC15C_RAW_SESSION="$1" node -e '
    const value = process.env.TIRION_CC15C_RAW_SESSION;
    if (typeof value !== "string" || value.length < 8) process.exit(1);
    process.stdout.write(`ses_${require("node:crypto").createHash("sha256").update(`claude-code|${value}`).digest("hex")}`);
  '
}

fingerprint_normal_claude_profile_metadata() {
  TIRION_CC15C_CALLER_ROOT="$CALLER_CLAUDE_CONFIG_DIR" \
  TIRION_CC15C_DEFAULT_ROOT="$HOME/.claude" \
  TIRION_CC15C_COMPANION_FILE="$CALLER_CLAUDE_COMPANION_FILE" \
    node <<'NODE'
const { createHash } = require("node:crypto");
const { lstatSync, readdirSync, readlinkSync, realpathSync } = require("node:fs");
const { join } = require("node:path");
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 32;
const hash = createHash("sha256");
let entries = 0;
const add = (value) => hash.update(`${value}\0`);
const statSummary = (stat) => {
  const kind = stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other";
  return `${kind}|${stat.mode & 0o7777n}|${stat.size}|${stat.mtimeNs}|${stat.ctimeNs}|${stat.nlink}`;
};
const snapshot = (label, configuredPath) => {
  let configured;
  try {
    configured = lstatSync(configuredPath, { bigint: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      add(`${label}|configured|absent`);
      return;
    }
    throw error;
  }
  add(`${label}|configured|${statSummary(configured)}`);
  if (configured.isSymbolicLink()) add(`${label}|configured_link|${readlinkSync(configuredPath)}`);
  const root = realpathSync.native(configuredPath);
  add(`${label}|resolved`);
  const walk = (path, relativePath, depth) => {
    if (depth > MAX_DEPTH || ++entries > MAX_ENTRIES) throw new Error("profile_metadata_too_large");
    let stat;
    try {
      stat = lstatSync(path, { bigint: true });
    } catch (error) {
      if (error && error.code === "ENOENT") {
        add(`${label}|${relativePath}|absent`);
        return;
      }
      throw error;
    }
    add(`${label}|target|${relativePath}|${statSummary(stat)}`);
    if (stat.isSymbolicLink()) {
      add(readlinkSync(path));
      return;
    }
    if (!stat.isDirectory()) return;
    for (const name of readdirSync(path).sort()) {
      walk(join(path, name), relativePath ? `${relativePath}/${name}` : name, depth + 1);
    }
  };
  walk(root, "", 0);
};
try {
  snapshot("caller", process.env.TIRION_CC15C_CALLER_ROOT);
  snapshot("default", process.env.TIRION_CC15C_DEFAULT_ROOT);
  snapshot("companion", process.env.TIRION_CC15C_COMPANION_FILE);
  process.stdout.write(hash.digest("hex"));
} catch {
  process.exit(1);
}
NODE
}

loopback_curl() {
  command curl -q --noproxy '*' --connect-timeout 2 --max-time 5 "$@"
}

# Keep the harness's local telemetry, hooks, and control traffic on loopback
# even when the operator normally routes provider traffic through a proxy.
# Preserve any existing bypass entries and leave the provider proxy itself
# intact so the separately authenticated Claude API connection can still work.
configure_loopback_proxy_bypass() {
  local bypass="127.0.0.1,localhost,::1"
  [[ -z "${NO_PROXY:-}" ]] || bypass+=",${NO_PROXY}"
  [[ -z "${no_proxy:-}" ]] || bypass+=",${no_proxy}"
  export NO_PROXY="$bypass"
  export no_proxy="$bypass"
}

# The probe must use only the explicitly supplied Claude.ai profile.  Ambient
# API-key, OAuth, custom-base-URL, and managed-cloud selectors would otherwise
# let a normal shell configuration silently change its account or provider.
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

validate_budget_usd() {
  TIRION_CC15C_BUDGET="$1" node <<'NODE'
const raw = process.env.TIRION_CC15C_BUDGET;
const amount = typeof raw === "string" ? Number(raw) : Number.NaN;
if (
  typeof raw !== "string"
  || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(raw)
  || !Number.isFinite(amount)
  || amount < 0.05
  || amount > 0.50
) {
  process.exit(1);
}
NODE
}

validate_private_claude_root() {
  TIRION_CC15C_PRIVATE_ROOT="$PRIVATE_CLAUDE_CONFIG_DIR" \
  TIRION_CC15C_CALLER_ROOT="$CALLER_CLAUDE_CONFIG_DIR" \
  TIRION_CC15C_HOME_ROOT="$HOME" \
  TIRION_CC15C_HARNESS_ROOT="$ROOT" \
    node <<'NODE'
const { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, statSync } = require("node:fs");
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require("node:path");
const failureReasons = new Set([
  "root_layout",
  "root_permissions",
  "root_name",
  "root_overlap",
  "normal_profile_alias",
  "normal_profile_scan",
  "private_tree_layout",
  "private_tree_permissions",
  "private_tree_limit"
]);
// Emit only a fixed category. In particular, never put a private-profile
// pathname, symlink target, or filesystem error in diagnostics.
const reject = (reason = "root_layout") => {
  process.stdout.write(failureReasons.has(reason) ? reason : "root_layout");
  process.exit(1);
};
const privateRoot = process.env.TIRION_CC15C_PRIVATE_ROOT;
const callerRoot = process.env.TIRION_CC15C_CALLER_ROOT;
const homeRoot = process.env.TIRION_CC15C_HOME_ROOT;
const harnessRoot = process.env.TIRION_CC15C_HARNESS_ROOT;
if (!privateRoot || !callerRoot || !homeRoot || !harnessRoot || !isAbsolute(privateRoot)) reject("root_layout");
let privateStat;
let privateReal;
try {
  const link = lstatSync(privateRoot);
  privateStat = statSync(privateRoot);
  privateReal = realpathSync.native(privateRoot);
  if (link.isSymbolicLink() || !privateStat.isDirectory()) reject("root_layout");
} catch {
  reject("root_layout");
}
if (privateStat.uid !== process.getuid?.() || (privateStat.mode & 0o077) !== 0) reject("root_permissions");
if (!/^tw-cc15c-claude\.[A-Za-z0-9._-]{6,128}$/.test(basename(privateReal))) reject("root_name");
const canonicalPath = (candidate) => {
  try {
    return statSync(candidate).isDirectory() ? realpathSync.native(candidate) : resolve(candidate);
  } catch {
    return resolve(candidate);
  }
};
const callerReal = canonicalPath(callerRoot);
const homeReal = canonicalPath(homeRoot);
const harnessReal = canonicalPath(harnessRoot);
const containsOrEquals = (parent, candidate) => {
  const fromParent = relative(parent, candidate);
  return fromParent === "" || (fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent));
};
if (
  containsOrEquals(callerReal, privateReal)
  || containsOrEquals(privateReal, callerReal)
  || containsOrEquals(homeReal, privateReal)
  || containsOrEquals(privateReal, homeReal)
  || containsOrEquals(privateReal, harnessReal)
  || containsOrEquals(harnessReal, privateReal)
) reject("root_overlap");
const MAX_NORMAL_ALIAS_ENTRIES = 20_000;
const MAX_NORMAL_ALIAS_DEPTH = 32;
let normalAliasEntries = 0;
const scannedNormalDirectories = new Set();
const resolvedSymlinkTarget = (path) => {
  const lexical = resolve(dirname(path), readlinkSync(path));
  try {
    return realpathSync.native(lexical);
  } catch {
    return lexical;
  }
};
const rejectNormalAliasOfPrivateRoot = (path, depth) => {
  if (depth > MAX_NORMAL_ALIAS_DEPTH || ++normalAliasEntries > MAX_NORMAL_ALIAS_ENTRIES) reject("normal_profile_scan");
  let link;
  try {
    link = lstatSync(path);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    reject("normal_profile_scan");
  }
  if (link.isSymbolicLink()) {
    const target = resolvedSymlinkTarget(path);
    if (containsOrEquals(privateReal, target) || containsOrEquals(target, privateReal)) reject("normal_profile_alias");
    let targetStat;
    try {
      targetStat = statSync(target);
    } catch (error) {
      // A broken non-private link is snapshot-safe: its link metadata is
      // fingerprinted, and both pre/post validations reject it if it later
      // becomes an alias of the private root.
      if (error && error.code === "ENOENT") return;
      reject("normal_profile_scan");
    }
    if (!targetStat.isDirectory()) return;
    // Follow only a bounded metadata walk. This permits ordinary unrelated
    // profile links while still rejecting an indirect directory bridge to the
    // private root; no normal-profile file contents are read or retained.
    rejectNormalAliasOfPrivateRoot(target, depth + 1);
    return;
  }
  if (!link.isDirectory()) return;
  let directoryReal;
  try {
    directoryReal = realpathSync.native(path);
  } catch {
    reject("normal_profile_scan");
  }
  if (scannedNormalDirectories.has(directoryReal)) return;
  scannedNormalDirectories.add(directoryReal);
  let names;
  try {
    names = readdirSync(path);
  } catch {
    reject("normal_profile_scan");
  }
  for (const name of names) rejectNormalAliasOfPrivateRoot(join(path, name), depth + 1);
};
for (const normalSurface of [callerRoot, join(homeRoot, ".claude"), join(homeRoot, ".claude.json")]) {
  rejectNormalAliasOfPrivateRoot(normalSurface, 0);
}
const projects = join(privateReal, "projects");
try {
  try {
    const existing = lstatSync(projects);
    if (existing.isSymbolicLink() || !existing.isDirectory()) reject("private_tree_layout");
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
    mkdirSync(projects, { mode: 0o700 });
  }
} catch {
  reject("private_tree_layout");
}
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 32;
let entries = 0;
const validateEntry = (path, relativePath, depth) => {
  if (depth > MAX_DEPTH || ++entries > MAX_ENTRIES) reject("private_tree_limit");
  let link;
  let stat;
  let resolved;
  try {
    link = lstatSync(path);
    stat = statSync(path);
    resolved = realpathSync.native(path);
  } catch {
    reject("private_tree_layout");
  }
  // A nested symlink can escape the private root; a regular hard link can
  // silently alias a normal-profile credential. Neither is accepted here.
  if (link.isSymbolicLink() || !containsOrEquals(privateReal, resolved)) reject("private_tree_layout");
  if (stat.uid !== process.getuid?.()) reject("private_tree_permissions");
  if (link.isDirectory()) {
    if ((stat.mode & 0o077) !== 0) reject("private_tree_permissions");
    let names;
    try {
      names = readdirSync(path).sort();
    } catch {
      reject("private_tree_layout");
    }
    for (const name of names) validateEntry(join(path, name), relativePath ? `${relativePath}/${name}` : name, depth + 1);
    return;
  }
  if (!link.isFile() || stat.nlink !== 1) reject("private_tree_layout");
};
validateEntry(privateReal, "", 0);
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
  local file="$1" code="$2" attempt port
  for attempt in $(seq 1 120); do
    if port="$(ready_port "$file" 2>/dev/null)"; then
      printf '%s' "$port"
      return 0
    fi
    sleep 0.1
  done
  fail "$code"
}

agent_is_ready() {
  jq -e '
    .health == "healthy"
    and .runtimeWarmupState == "ready"
    and (.otlp.port | type == "number" and . > 0 and . <= 65535)
  ' "$AGENT_STATUS_FILE" >/dev/null
}

wait_for_agent_ready() {
  for _ in $(seq 1 120); do
    if tirionctl status >"$AGENT_STATUS_FILE" 2>/dev/null && agent_is_ready; then
      return 0
    fi
    sleep 0.1
  done
  fail "agent_not_healthy"
}

repository_scope_active() {
  tirionctl repo list 2>/dev/null | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const value = JSON.parse(input);
        const scopes = value?.scopes;
        if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0]?.state !== "active") process.exit(1);
      } catch { process.exit(1); }
    });
  '
}

attribution_reconciled() {
  tirionctl diagnostics 2>/dev/null | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const value = JSON.parse(input);
        const state = Array.isArray(value?.constructStates)
          ? value.constructStates.find((candidate) => candidate?.construct === "GitAttribution")
          : undefined;
        if (state?.state !== "reconciled" || state?.health !== "healthy") process.exit(1);
      } catch { process.exit(1); }
    });
  '
}

wait_for_repository_readiness() {
  for _ in $(seq 1 150); do
    if repository_scope_active && attribution_reconciled; then
      return 0
    fi
    sleep 0.1
  done
  fail "repository_attribution_not_ready"
}

repository_manifest() {
  TIRION_CC15C_REPOSITORY="$REPOSITORY" node <<'NODE'
const { createHash } = require("node:crypto");
const { lstatSync, readdirSync, readlinkSync } = require("node:fs");
const { join } = require("node:path");
const root = process.env.TIRION_CC15C_REPOSITORY;
const hash = createHash("sha256");
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 32;
let entries = 0;
const add = (value) => hash.update(`${value}\0`);
const walk = (path, relativePath, depth) => {
  if (depth > MAX_DEPTH || ++entries > MAX_ENTRIES) throw new Error("repository_manifest_limit");
  const stat = lstatSync(path, { bigint: true });
  const kind = stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other";
  add(`${relativePath}|${kind}|${stat.mode & 0o7777n}|${stat.size}|${stat.mtimeNs}|${stat.ctimeNs}|${stat.nlink}`);
  if (stat.isSymbolicLink()) {
    add(readlinkSync(path));
    return;
  }
  if (!stat.isDirectory()) return;
  for (const name of readdirSync(path).sort()) {
    if (relativePath === "" && name === ".git") continue;
    walk(join(path, name), relativePath ? `${relativePath}/${name}` : name, depth + 1);
  }
};
try {
  walk(root, "", 0);
  process.stdout.write(hash.digest("hex"));
} catch {
  process.exit(1);
}
NODE
}

assert_repository_unchanged() {
  local manifest
  [[ "$(git -C "$REPOSITORY" rev-parse --verify HEAD)" == "$REPOSITORY_HEAD_BEFORE_CLAUDE" ]] \
    || fail "denied_write_changed_repository_head"
  [[ -z "$(git -C "$REPOSITORY" status --porcelain=v1 --untracked-files=all --ignored=matching)" ]] \
    || fail "denied_write_changed_repository"
  [[ ! -e "$REPOSITORY/cc15c-denied.txt" ]] || fail "denied_write_created_target"
  manifest="$(repository_manifest)" || fail "repository_manifest_unavailable"
  [[ "$manifest" == "$REPOSITORY_MANIFEST_BEFORE_CLAUDE" ]] \
    || fail "denied_write_changed_repository_filesystem"
}

assert_privacy_marker_absent() {
  local scan_status
  set +e
  # `grep` is present on the supported macOS base system, unlike optional
  # ripgrep installations. Scan hidden and binary files too, so losing `rg`
  # cannot weaken the persisted-marker gate or block the live probe before
  # Claude is invoked.
  LC_ALL=C grep -R -a -F -- "$MARKER" "$ROOT" >/dev/null 2>&1
  scan_status="$?"
  set -e
  if (( scan_status == 0 )); then
    fail "privacy_marker_persisted_in_tirion_state"
  elif (( scan_status != 1 )); then
    fail "privacy_marker_scan_incomplete"
  fi
  TIRION_CC15C_HARNESS_ROOT="$ROOT" \
  TIRION_CC15C_PRIVACY_MARKER="$MARKER" \
    node <<'NODE' || fail "privacy_marker_decoded_scan_incomplete"
const { lstatSync, readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const root = process.env.TIRION_CC15C_HARNESS_ROOT;
const marker = process.env.TIRION_CC15C_PRIVACY_MARKER;
const MAX_FILES = 10_000;
const MAX_DEPTH = 32;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
let files = 0;
let totalBytes = 0;
const fail = () => process.exit(1);
const decodedEscapes = (text) => {
  let value = text;
  for (let index = 0; index < 4; index += 1) {
    const next = value.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (next === value) break;
    value = next;
  }
  return value;
};
const scan = (path, depth) => {
  if (depth > MAX_DEPTH) fail();
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail();
  }
  if (stat.isSymbolicLink()) fail();
  if (stat.isDirectory()) {
    let names;
    try {
      names = readdirSync(path);
    } catch {
      fail();
    }
    for (const name of names) scan(join(path, name), depth + 1);
    return;
  }
  if (!stat.isFile()) return;
  if (++files > MAX_FILES || stat.size > MAX_FILE_BYTES || (totalBytes += stat.size) > MAX_TOTAL_BYTES) fail();
  let bytes;
  try {
    bytes = readFileSync(path);
    const text = bytes.toString("utf8");
    if (text.includes(marker) || decodedEscapes(text).includes(marker)) fail();
  } finally {
    if (bytes) bytes.fill(0);
  }
};
if (typeof root !== "string" || typeof marker !== "string" || marker.length === 0) fail();
scan(root, 0);
NODE
}

assert_normal_profile_unchanged() {
  local after
  [[ -n "$NORMAL_PROFILE_METADATA_BEFORE" ]] || return 0
  after="$(fingerprint_normal_claude_profile_metadata)" || fail "normal_claude_profile_snapshot_failed"
  [[ "$after" == "$NORMAL_PROFILE_METADATA_BEFORE" ]] || fail "normal_claude_profile_metadata_changed"
}

shutdown_writers() {
  if [[ -n "$RELAY_PID" && -n "${RELAY_BASE:-}" && -n "${RELAY_CONTROL_TOKEN:-}" ]]; then
    loopback_curl -fsS -X POST -H "x-tirion-relay-control: $RELAY_CONTROL_TOKEN" "$RELAY_BASE/control/shutdown" >/dev/null 2>&1 || true
  fi
  if [[ -n "$RECEIVER_PID" && -n "${RECEIVER_BASE:-}" && -n "${RECEIVER_CONTROL_TOKEN:-}" ]]; then
    loopback_curl -fsS -X POST -H "x-tirion-cc15c-control: $RECEIVER_CONTROL_TOKEN" "$RECEIVER_BASE/control/shutdown" >/dev/null 2>&1 || true
  fi
  [[ -z "$RELAY_PID" ]] || kill "$RELAY_PID" >/dev/null 2>&1 || true
  [[ -z "$RECEIVER_PID" ]] || kill "$RECEIVER_PID" >/dev/null 2>&1 || true
  [[ -z "$AGENT_PID" ]] || kill "$AGENT_PID" >/dev/null 2>&1 || true
  [[ -z "$RELAY_PID" ]] || wait "$RELAY_PID" >/dev/null 2>&1 || true
  [[ -z "$RECEIVER_PID" ]] || wait "$RECEIVER_PID" >/dev/null 2>&1 || true
  [[ -z "$AGENT_PID" ]] || wait "$AGENT_PID" >/dev/null 2>&1 || true
  RELAY_PID=""
  RECEIVER_PID=""
  AGENT_PID=""
}

# Request an orderly stop over this disposable agent's Unix socket rather than
# `tirionctl stop`: on macOS that broader command can also boot out the
# operator's normal launchd service. The acceptance path needs stronger local
# evidence anyway: authenticate to this direct child, then prove it exited
# while the sealed relay and receiver still serve their final status endpoints.
stop_agent_orderly() {
  [[ -n "$AGENT_PID" ]] || return 0
  local bootstrap_token
  [[ -f "$AGENT_STATE_DIR/bootstrap.token" && -S "$AGENT_SOCKET" ]] || return 1
  bootstrap_token="$(<"$AGENT_STATE_DIR/bootstrap.token")"
  [[ ${#bootstrap_token} -ge 16 ]] || return 1
  loopback_curl --unix-socket "$AGENT_SOCKET" -fsS -X POST \
    -H "authorization: Bearer $bootstrap_token" \
    http://localhost/v1/stop 2>/dev/null \
    | node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        try {
          const status = JSON.parse(input);
          if (
            typeof status !== "object"
            || status === null
            || Array.isArray(status)
            || Object.keys(status).length !== 2
            || status.schemaVersion !== 1
            || status.stopping !== true
          ) process.exit(1);
        } catch {
          process.exit(1);
        }
      });
    ' || return 1
  local deadline=$((SECONDS + 10))
  while kill -0 "$AGENT_PID" >/dev/null 2>&1; do
    if (( SECONDS > deadline )); then
      return 1
    fi
    sleep 0.1
  done
  wait "$AGENT_PID" >/dev/null 2>&1 || true
  AGENT_PID=""
}

cleanup() {
  local original_status="$?" profile_after
  set +e
  shutdown_writers
  if [[ -n "$NORMAL_PROFILE_METADATA_BEFORE" ]]; then
    if ! profile_after="$(fingerprint_normal_claude_profile_metadata)"; then
      printf 'CC15C acceptance failed: normal_claude_profile_snapshot_failed\n' >&2
      original_status=1
    elif [[ "$profile_after" != "$NORMAL_PROFILE_METADATA_BEFORE" ]]; then
      printf 'CC15C acceptance failed: normal_claude_profile_metadata_changed\n' >&2
      original_status=1
    fi
  fi
  if [[ -f "$ROOT_MARKER" && "$ROOT" == "$TMP_PARENT"/tirion-cc15c.* ]]; then
    rm -rf -- "$ROOT"
  fi
  return "$original_status"
}
trap cleanup EXIT

[[ "$MODEL" =~ ^claude-[a-z0-9][a-z0-9.-]*$ && "$MODEL" =~ [0-9] \
  && ! "$MODEL" =~ (^|[.-])(latest|current)([.-]|$) ]] \
  || fail "model_must_be_exact_immutable_id"
case "$PROMPT_MODE" in
  noninteractive|interactive)
    ;;
  *)
    fail "invalid_prompt_mode"
    ;;
esac
if [[ "$PROMPT_MODE" == "interactive" ]]; then
  [[ -t 0 && -t 1 ]] || fail "interactive_terminal_required"
fi
[[ -n "$PRIVATE_CLAUDE_CONFIG_DIR" ]] || fail "private_claude_config_required"
[[ -f "$AGENT_ENTRY" ]] || fail "agent_entry_missing"
[[ -f "$ASSERTION_SCRIPT" && -f "$ADMISSION_DIAGNOSTIC_SCRIPT" && -f "$RELAY_SCRIPT" && -f "$RECEIVER_SCRIPT" ]] || fail "acceptance_harness_missing"
validate_positive_integer "$WAIT_SECONDS" 15 120 "invalid_wait_seconds"
validate_positive_integer "$FINAL_QUIET_SECONDS" 1 10 "invalid_final_quiet_seconds"
validate_positive_integer "$QUIESCE_TIMEOUT_MS" 100 120000 "invalid_quiesce_timeout_ms"
validate_positive_integer "$RELAY_HOLD_MS" 60000 300000 "invalid_relay_hold_ms"
require_command node
require_command claude
require_command curl
require_command jq
require_command git
require_command grep
validate_private_claude_root_or_fail
if [[ "$PROMPT_MODE" == "noninteractive" ]]; then
  validate_budget_usd "$MAX_BUDGET_USD" || fail "invalid_max_budget_usd"
fi
configure_loopback_proxy_bypass

NORMAL_PROFILE_METADATA_BEFORE="$(fingerprint_normal_claude_profile_metadata)" \
  || fail "normal_claude_profile_snapshot_failed"
export CLAUDE_CONFIG_DIR="$PRIVATE_CLAUDE_CONFIG_DIR"
AUTH_SAFE="$(claude_private_profile auth status --json 2>/dev/null | jq -c '{loggedIn,authMethod,apiProvider,subscriptionType}' 2>/dev/null || true)"
[[ -n "$AUTH_SAFE" ]] \
  && jq -e '.loggedIn == true and .authMethod == "claude.ai" and .apiProvider == "firstParty"' <<<"$AUTH_SAFE" >/dev/null \
  || fail "private_claude_profile_not_authenticated"
CLAUDE_VERSION_RAW="$(claude_private_profile --version 2>/dev/null | head -n 1)"
CLAUDE_VERSION="$(sed -E 's/^([0-9]+\.[0-9]+\.[0-9]+).*/\1/' <<<"$CLAUDE_VERSION_RAW")"
[[ "$CLAUDE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "claude_version_unavailable"
SESSION_ID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
RELAY_SESSION_DIGEST="$(relay_session_digest "$SESSION_ID")" || fail "relay_session_digest_unavailable"
WEBHOOK_SESSION_ID="$(webhook_session_id "$SESSION_ID")" || fail "webhook_session_id_unavailable"
[[ "$RELAY_SESSION_DIGEST" =~ ^[a-f0-9]{64}$ ]] || fail "relay_session_digest_invalid"
[[ "$WEBHOOK_SESSION_ID" =~ ^ses_[a-f0-9]{64}$ ]] || fail "webhook_session_id_invalid"

export TIRION_AGENT_STATE_DIR="$AGENT_STATE_DIR"
export TIRION_AGENT_RUNTIME_DIR="$AGENT_RUNTIME_DIR"
export TIRION_AGENT_SOCKET="$AGENT_SOCKET"
export TIRION_AGENT_OTLP_PORT=0
# Keep the direct agent's other configurable source paths in the disposable
# root too. Claude itself only uses the dedicated CLAUDE_CONFIG_DIR above.
export CODEX_HOME="$ISOLATED_CODEX_HOME"
export CURSOR_HOME="$ISOLATED_CURSOR_HOME"
mkdir -p "$AGENT_STATE_DIR" "$AGENT_RUNTIME_DIR" "$REPOSITORY" "$ISOLATED_CODEX_HOME" "$ISOLATED_CURSOR_HOME"
chmod 700 "$AGENT_STATE_DIR" "$AGENT_RUNTIME_DIR" "$REPOSITORY" "$ISOLATED_CODEX_HOME" "$ISOLATED_CURSOR_HOME"

# The direct agent and Claude child inherit this same dedicated root, so the
# transcript path accepted from UserPromptSubmit is inside the agent's trusted
# provenance boundary. The harness never calls `tirionctl configure`.
node "$AGENT_ENTRY" >"$ROOT/agent.stdout" 2>"$ROOT/agent.stderr" &
AGENT_PID="$!"
wait_for_agent_ready
OTLP_PORT="$(jq -r '.otlp.port' "$AGENT_STATUS_FILE")"
[[ -f "$AGENT_STATE_DIR/otlp.token" ]] || fail "agent_otlp_token_missing"
OTLP_TOKEN="$(<"$AGENT_STATE_DIR/otlp.token")"
[[ ${#OTLP_TOKEN} -ge 16 ]] || fail "agent_otlp_token_missing"

DELIVERY_TOKEN="$(random_secret)"
DELIVERY_HMAC_SECRET="$(random_secret)"
RECEIVER_CONTROL_TOKEN="$(random_secret)"
RELAY_TOKEN="$(random_secret)"
RELAY_CONTROL_TOKEN="$(random_secret)"

TIRION_CC15C_RECEIVER_TOKEN="$DELIVERY_TOKEN" \
TIRION_CC15C_RECEIVER_HMAC_SECRET="$DELIVERY_HMAC_SECRET" \
TIRION_CC15C_RECEIVER_CONTROL_TOKEN="$RECEIVER_CONTROL_TOKEN" \
TIRION_CC15C_EXPECTED_WEBHOOK_SESSION_ID="$WEBHOOK_SESSION_ID" \
TIRION_CC15C_PRIVACY_CANARY="$MARKER" \
  node "$RECEIVER_SCRIPT" >"$ROOT/receiver.ready" 2>"$ROOT/receiver.stderr" &
RECEIVER_PID="$!"
RECEIVER_PORT="$(wait_for_ready_port "$ROOT/receiver.ready" "receiver_not_ready")"
RECEIVER_BASE="http://127.0.0.1:$RECEIVER_PORT"

TIRION_CC_DELAY_RELAY_TARGET="http://127.0.0.1:$OTLP_PORT" \
TIRION_CC_DELAY_RELAY_INGRESS_TOKEN="$OTLP_TOKEN" \
TIRION_CC_DELAY_RELAY_TOKEN="$RELAY_TOKEN" \
TIRION_CC_DELAY_RELAY_CONTROL_TOKEN="$RELAY_CONTROL_TOKEN" \
TIRION_CC_DELAY_RELAY_HOLD_MS="$RELAY_HOLD_MS" \
TIRION_CC_DELAY_RELAY_EXPECTED_SESSION_DIGEST="$RELAY_SESSION_DIGEST" \
  node "$RELAY_SCRIPT" >"$ROOT/relay.ready" 2>"$ROOT/relay.stderr" &
RELAY_PID="$!"
RELAY_PORT="$(wait_for_ready_port "$ROOT/relay.ready" "relay_not_ready")"
RELAY_BASE="http://127.0.0.1:$RELAY_PORT"

tirionctl clear-agent-data --confirm >/dev/null
tirionctl webhook set-url "$RECEIVER_BASE/webhooks/tirion" >/dev/null
tirionctl webhook set-token "$DELIVERY_TOKEN" >/dev/null
tirionctl webhook set-secret "$DELIVERY_HMAC_SECRET" >/dev/null
tirionctl webhook enable-runs >/dev/null

git -C "$REPOSITORY" init -q
git -C "$REPOSITORY" config user.name "Tirion CC15C Acceptance"
git -C "$REPOSITORY" config user.email "tirion-cc15c@example.test"
TIRION_CC15C_REPO_README="$REPOSITORY/README.md" node <<'NODE'
const { chmodSync, writeFileSync } = require("node:fs");
const path = process.env.TIRION_CC15C_REPO_README;
writeFileSync(path, "# Disposable CC15C acceptance repository\n", { mode: 0o600 });
chmodSync(path, 0o600);
NODE
git -C "$REPOSITORY" add README.md
git -C "$REPOSITORY" commit -qm "initial disposable repository"
tirionctl repo add "$REPOSITORY" >/dev/null
wait_for_repository_readiness
REPOSITORY_HEAD_BEFORE_CLAUDE="$(git -C "$REPOSITORY" rev-parse --verify HEAD)" \
  || fail "repository_head_unavailable"
REPOSITORY_MANIFEST_BEFORE_CLAUDE="$(repository_manifest)" \
  || fail "repository_manifest_unavailable"

TIRION_CC15C_SETTINGS_FILE="$SETTINGS_FILE" \
TIRION_CC15C_MCP_CONFIG="$MCP_CONFIG" \
TIRION_CC15C_RELAY_BASE="$RELAY_BASE" \
TIRION_CC15C_INGRESS_TOKEN="$OTLP_TOKEN" \
TIRION_CC15C_RELAY_TOKEN="$RELAY_TOKEN" \
  node <<'NODE'
const { chmodSync, writeFileSync } = require("node:fs");
const {
  TIRION_CC15C_SETTINGS_FILE: settingsFile,
  TIRION_CC15C_MCP_CONFIG: mcpConfig,
  TIRION_CC15C_RELAY_BASE: relayBase,
  TIRION_CC15C_INGRESS_TOKEN: ingressToken,
  TIRION_CC15C_RELAY_TOKEN: relayToken
} = process.env;
const events = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure"];
const noMatcher = new Set(["UserPromptSubmit", "Stop"]);
const hook = (eventName) => ({
  ...(noMatcher.has(eventName) ? {} : { matcher: "*" }),
  hooks: [{
    type: "http",
    url: `${relayBase}/v1/provider-hooks/claude-code`,
    timeout: 10,
    headers: {
      Authorization: `Bearer ${ingressToken}`,
      "X-Tirion-CC15C-Relay": relayToken,
      "X-Tirion-Hook-Surface": "claude-code",
      "X-Tirion-Hook-Event": eventName
    }
  }]
});
const settings = {
  hooks: Object.fromEntries(events.map((eventName) => [eventName, [hook(eventName)]]))
};
writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
chmodSync(settingsFile, 0o600);
writeFileSync(mcpConfig, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`, { mode: 0o600 });
chmodSync(mcpConfig, 0o600);
NODE

set +e
(
  cd "$REPOSITORY"
  # Claude initializes OTLP before settings-file environment values can be
  # applied in all supported CLI paths. Keep the probe's telemetry settings in
  # this Claude child process only, matching the native census harness. Signal
  # specific headers and compression override their generic OTLP equivalents
  # in Claude's bundled exporter, so set every relevant precedence layer here
  # rather than inheriting an operator's ambient telemetry configuration.
  unset \
    OTEL_SDK_DISABLED \
    OTEL_SERVICE_NAME \
    OTEL_RESOURCE_ATTRIBUTES \
    OTEL_TRACES_SAMPLER \
    OTEL_TRACES_SAMPLER_ARG
  # Despite its metrics-oriented name, Claude applies this gate to native logs
  # and traces too. CC15C needs the fresh opaque session only for its exact
  # local relay join; the relay and agent never expose the raw value.
  export \
    CLAUDE_CODE_ENABLE_TELEMETRY=1 \
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1 \
    OTEL_METRICS_EXPORTER=none \
    OTEL_LOGS_EXPORTER=otlp \
    OTEL_TRACES_EXPORTER=otlp \
    OTEL_EXPORTER_OTLP_PROTOCOL=http/json \
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json \
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json \
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT="$RELAY_BASE/v1/logs" \
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="$RELAY_BASE/v1/traces" \
    OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer $OTLP_TOKEN,X-Tirion-CC15C-Relay=$RELAY_TOKEN" \
    OTEL_EXPORTER_OTLP_LOGS_HEADERS="Authorization=Bearer $OTLP_TOKEN,X-Tirion-CC15C-Relay=$RELAY_TOKEN" \
    OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Bearer $OTLP_TOKEN,X-Tirion-CC15C-Relay=$RELAY_TOKEN" \
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
  if [[ "$PROMPT_MODE" == "interactive" ]]; then
    printf '%s\n' "CC15C interactive mode: submit the controlled prompt supplied outside this script, wait for the one Write attempt, then type /exit. No CLI max-budget cap is enforced in interactive mode." >&2
    claude_private_profile \
      --model "$MODEL" \
      --session-id "$SESSION_ID" \
      --settings "$SETTINGS_FILE" \
      --setting-sources project,local \
      --strict-mcp-config \
      --mcp-config "$MCP_CONFIG" \
      --permission-mode dontAsk \
      --tools Write \
      --allowedTools "Write(./cc15c-denied.txt)"
  else
    PROMPT="Use exactly one Write tool call to attempt to create cc15c-denied.txt containing one short non-secret line. Do not use any other tool. Do not repeat this marker: $MARKER. After the Write attempt, stop."
    export -n PROMPT 2>/dev/null || true
    printf '%s\n' "$PROMPT" | claude_private_profile -p \
      --output-format json \
      --model "$MODEL" \
      --session-id "$SESSION_ID" \
      --settings "$SETTINGS_FILE" \
      --setting-sources project,local \
      --strict-mcp-config \
      --mcp-config "$MCP_CONFIG" \
      --permission-mode dontAsk \
      --max-turns 4 \
      --max-budget-usd "$MAX_BUDGET_USD" \
      --tools Write \
      --allowedTools "Write(./cc15c-denied.txt)" >/dev/null 2>/dev/null
  fi
)
CLAUDE_EXIT="$?"
set -e
validate_private_claude_root >/dev/null 2>&1 || fail "private_claude_config_changed_after_claude"
[[ "$CLAUDE_EXIT" -eq 0 ]] || fail "claude_exit_nonzero"
assert_repository_unchanged

relay_status() {
  loopback_curl -fsS -H "x-tirion-relay-control: $RELAY_CONTROL_TOKEN" "$RELAY_BASE/control/status"
}

receiver_status() {
  loopback_curl -fsS -H "x-tirion-cc15c-control: $RECEIVER_CONTROL_TOKEN" "$RECEIVER_BASE/control/status"
}

wait_for_assertion() {
  local mode="$1" source="$2" timeout_seconds="$3"
  shift 3
  local deadline=$((SECONDS + timeout_seconds)) status assertion
  while (( SECONDS <= deadline )); do
    if [[ "$source" == "relay" ]]; then
      status="$(relay_status 2>/dev/null || true)"
    else
      status="$(receiver_status 2>/dev/null || true)"
    fi
    if [[ -n "$status" ]] && assertion="$(printf '%s' "$status" | node "$ASSERTION_SCRIPT" "$mode" "$@" 2>/dev/null)"; then
      printf '%s' "$assertion"
      return 0
    fi
    sleep 0.2
  done
  return 1
}

# Reduce the relay's bounded counters/booleans to a fixed code only when the
# held-decision assertion has already failed. This keeps a live failure useful
# without retaining a hook payload, telemetry record, identity, timestamp, or
# filesystem value in shell output.
relay_held_diagnostic() {
  local status diagnostic
  status="$(relay_status 2>/dev/null || true)"
  [[ -n "$status" ]] || {
    printf '%s' "relay_status_unavailable"
    return 0
  }
  diagnostic="$(printf '%s' "$status" | node "$ASSERTION_SCRIPT" relay-diagnostic 2>/dev/null \
    | jq -r '.diagnostic // empty' 2>/dev/null || true)"
  case "$diagnostic" in
    hook_counters_missing|user_prompt_submit_count|pre_tool_use_count|terminal_hook_count|unexpected_tool_completion_hook|relay_control_auth|relay_ingress_sealed|relay_unsupported_metrics_request|relay_unsupported_path|relay_ingress_auth|relay_custom_header_auth|relay_content_type|relay_empty_log_payload|relay_duplicate_native_rejection|relay_binding_expected_session_missing|relay_binding_native_session_missing|relay_binding_native_source_time_missing|relay_binding_native_expected_session_mismatch|relay_binding_pretool_write_cardinality|relay_binding_denied_tool_identity_missing|relay_binding_submission_session_missing|relay_binding_expected_session_unbound|relay_binding_native_tool_identity_mismatch|relay_binding_native_submission_session_mismatch|relay_native_rejection_binding|relay_target_log_unavailable|relay_target_log_rate_limited|relay_target_log_4xx|relay_target_log_5xx|relay_target_log_unexpected|relay_target_trace_unavailable|relay_target_trace_rate_limited|relay_target_trace_4xx|relay_target_trace_5xx|relay_target_trace_unexpected|relay_hook_event_mismatch|relay_target_hook_unavailable|relay_target_hook_rate_limited|relay_target_hook_4xx|relay_target_hook_5xx|relay_target_hook_unexpected|relay_invalid_request|relay_rejected_request_unclassified|targeted_write_hook_count|controlled_deny_missing|generic_log_absent|closed_root_trace_absent|closed_root_trace_count|expected_session_unbound|native_rejection_binding_ambiguous|native_rejection_expired|native_rejection_pending_control|native_rejection_absent|native_rejection_boundary_unbound|native_rejection_not_held|relay_held_assertion_failed)
      printf '%s' "$diagnostic"
      ;;
    *)
      printf '%s' "relay_status_invalid"
      ;;
  esac
}

# Reduce the receiver's bounded counters/booleans to a fixed code only after
# the baseline-terminal assertion has timed out. The status and output remain
# metadata-only: no webhook body, run/session ID, timestamp, path, or provider
# telemetry is retained or printed by the shell.
receiver_baseline_diagnostic() {
  local status diagnostic
  status="$(receiver_status 2>/dev/null || true)"
  [[ -n "$status" ]] || {
    printf '%s' "receiver_status_unavailable"
    return 0
  }
  diagnostic="$(printf '%s' "$status" | node "$ASSERTION_SCRIPT" baseline-diagnostic 2>/dev/null \
    | jq -r '.diagnostic // empty' 2>/dev/null || true)"
  case "$diagnostic" in
    receiver_privacy_failure|receiver_ingress_not_clean|receiver_session_not_bound|unexpected_commit|runs_missing_or_invalid|no_run_received|unexpected_run_count|invalid_run|missing_or_duplicate_start|terminal_arrived_before_start|pre_start_update|post_terminal_update|unexpected_run_commit|terminal_identity_incomplete_or_changed|not_authoritative_claude_terminal|terminal_missing|invalid_terminal_versions|terminal_not_root_span_authority|terminal_activity_coverage_invalid|unexpected_non_write_tool_activity|terminal_correction_delivery_late|terminal_non_decision_claim_comparison_missing|denied_write_changed_files|native_decision_execution_grant|invalid_write_counts|write_activity_outcome_or_count_invalid|native_rejection_leaked_before_release|pre_release_write_execution_or_outcome)
      printf '%s' "$diagnostic"
      ;;
    baseline_ready)
      # The last poll can race the immediate diagnostic snapshot. State this
      # distinctly instead of treating a now-valid terminal as malformed.
      printf '%s' "baseline_ready_after_timeout"
      ;;
    *)
      printf '%s' "receiver_status_invalid"
      ;;
  esac
}

# When the receiver saw no lifecycle at all, reduce the direct agent's safe
# diagnostic snapshot to one fixed admission outcome. The full snapshot is
# never printed or saved by the harness; in particular no event identity,
# timestamp, path, transcript field, or payload data crosses this boundary.
agent_no_run_admission_diagnostic() {
  local status diagnostic
  status="$(tirionctl diagnostics 2>/dev/null || true)"
  [[ -n "$status" ]] || {
    printf '%s' "agent_diagnostics_unavailable"
    return 0
  }
  diagnostic="$(printf '%s' "$status" | node "$ADMISSION_DIAGNOSTIC_SCRIPT" 2>/dev/null \
    | jq -r '.diagnostic // empty' 2>/dev/null || true)"
  case "$diagnostic" in
    provenance_unavailable|provenance_ambiguous|provenance_retry_processing_failed|provenance_transcript_locator_invalid|provenance_transcript_trust_rejected|provenance_transcript_read_unavailable|provenance_transcript_read_unstable|provenance_transcript_tail_exceeded|provenance_hook_identity_unavailable|provenance_transcript_candidate_missing|provenance_idless_candidate_stale|provenance_prompt_digest_mismatch|provenance_prompt_identity_conflict|provenance_candidate_ambiguous|provenance_transcript_origin_kind_missing|provenance_transcript_origin_kind_unrecognized|provenance_transcript_prompt_source_missing|provenance_transcript_prompt_source_unrecognized|provenance_transcript_origin_prompt_source_incompatible|provenance_origin_not_human_typed|provenance_malformed|submission_hook_ignored|submission_hook_accepted_no_run_start|submission_hook_diagnostic_missing)
      printf '%s' "$diagnostic"
      ;;
    *)
      printf '%s' "agent_diagnostics_invalid"
      ;;
  esac
}

# A successful pre-stop barrier is meaningful only when every bounded drain
# reports completion. Keep the parsed output metadata-only and reject a future
# response-shape change until this probe explicitly understands it.
quiesce_agent() {
  tirionctl runtime quiesce --timeout-ms "$QUIESCE_TIMEOUT_MS" 2>/dev/null \
    | TIRION_CC15C_QUIESCE_TIMEOUT_MS="$QUIESCE_TIMEOUT_MS" node -e '
      let input = "";
      const maxBytes = 16 * 1024;
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        input += chunk;
        if (Buffer.byteLength(input, "utf8") > maxBytes) process.exit(1);
      });
      process.stdin.on("end", () => {
        try {
          const status = JSON.parse(input);
          const timeoutMs = Number(process.env.TIRION_CC15C_QUIESCE_TIMEOUT_MS);
          const expectedKeys = new Set([
            "schemaVersion",
            "state",
            "elapsedMs",
            "telemetryIngressDrained",
            "runtimeWorkDrained",
            "webhookDrained"
          ]);
          if (
            !isRecord(status)
            || Object.keys(status).length !== expectedKeys.size
            || Object.keys(status).some((key) => !expectedKeys.has(key))
            || status.schemaVersion !== 1
            || status.state !== "drained"
            || !Number.isSafeInteger(status.elapsedMs)
            || status.elapsedMs < 0
            || status.elapsedMs > timeoutMs
            || status.telemetryIngressDrained !== true
            || status.runtimeWorkDrained !== true
            || status.webhookDrained !== true
          ) process.exit(1);
          process.stdout.write(`${JSON.stringify({
            schemaVersion: 1,
            state: "drained",
            elapsedMs: status.elapsedMs,
            telemetryIngressDrained: true,
            runtimeWorkDrained: true,
            webhookDrained: true
          })}\n`);
        } catch {
          process.exit(1);
        }
      });
      function isRecord(value) {
        return typeof value === "object" && value !== null && !Array.isArray(value);
      }
    '
}

# Keep both sealed writers alive for the full quiet interval. Every poll checks
# both the terminal correction and the sticky post-seal ingress counters, so a
# late producer cannot be hidden by a prior successful snapshot.
soak_sealed_writers() {
  local baseline_version="$1"
  local deadline=$((SECONDS + FINAL_QUIET_SECONDS))
  while :; do
    wait_for_assertion relay-sealed relay 1 >/dev/null || return 1
    wait_for_assertion receiver-sealed receiver 1 "$baseline_version" >/dev/null || return 1
    if (( SECONDS >= deadline )); then
      return 0
    fi
    sleep 0.2
  done
}

RELAY_HELD_SUMMARY="$(wait_for_assertion relay-held relay "$WAIT_SECONDS")" || {
  RELAY_HELD_DIAGNOSTIC="$(relay_held_diagnostic)"
  fail "native_decision_not_held_$RELAY_HELD_DIAGNOSTIC"
}
BASELINE_SUMMARY="$(wait_for_assertion baseline receiver "$WAIT_SECONDS")" || {
  BASELINE_DIAGNOSTIC="$(receiver_baseline_diagnostic)"
  if [[ "$BASELINE_DIAGNOSTIC" == "no_run_received" ]]; then
    ADMISSION_DIAGNOSTIC="$(agent_no_run_admission_diagnostic)"
    fail "terminal_baseline_missing_or_invalid_${BASELINE_DIAGNOSTIC}_${ADMISSION_DIAGNOSTIC}"
  fi
  fail "terminal_baseline_missing_or_invalid_$BASELINE_DIAGNOSTIC"
}
BASELINE_VERSION="$(jq -er '.baselineTerminalVersion | select(type == "number" and . > 0)' <<<"$BASELINE_SUMMARY")" \
  || fail "terminal_baseline_version_missing"

RELAY_RELEASE_SUMMARY="$(loopback_curl -fsS -X POST -H "x-tirion-relay-control: $RELAY_CONTROL_TOKEN" "$RELAY_BASE/control/release" 2>/dev/null \
  | node "$ASSERTION_SCRIPT" relay-released 2>/dev/null)" || fail "native_decision_release_failed"
RELAY_SEAL_SUMMARY="$(loopback_curl -fsS -X POST -H "x-tirion-relay-control: $RELAY_CONTROL_TOKEN" "$RELAY_BASE/control/seal" 2>/dev/null \
  | node "$ASSERTION_SCRIPT" relay-sealed 2>/dev/null)" || fail "relay_seal_failed"
AGENT_QUIESCE_SUMMARY="$(quiesce_agent)" || fail "agent_runtime_not_quiesced"
RECEIVER_SEAL_SUMMARY="$(loopback_curl -fsS -X POST -H "x-tirion-cc15c-control: $RECEIVER_CONTROL_TOKEN" "$RECEIVER_BASE/control/seal" 2>/dev/null \
  | node "$ASSERTION_SCRIPT" receiver-sealed "$BASELINE_VERSION" 2>/dev/null)" || fail "receiver_seal_failed"

soak_sealed_writers "$BASELINE_VERSION" || fail "sealed_writer_quiet_period_invalid"
FINAL_RELAY_SUMMARY="$(wait_for_assertion relay-sealed relay "$WAIT_SECONDS")" || fail "relay_final_state_invalid"
FINAL_RECEIVER_SUMMARY="$(wait_for_assertion receiver-sealed receiver "$WAIT_SECONDS" "$BASELINE_VERSION")" \
  || fail "terminal_final_state_invalid"

# Stop the direct agent only after the sealed endpoints prove that no late
# telemetry or webhook delivery crossed their boundaries. The relay and
# receiver remain alive through the orderly stop so the final snapshots cannot
# be fabricated by killing their writers first.
stop_agent_orderly || fail "agent_orderly_stop_failed"
POST_STOP_RELAY_SUMMARY="$(wait_for_assertion relay-sealed relay "$WAIT_SECONDS")" || fail "relay_post_stop_state_invalid"
POST_STOP_RECEIVER_SUMMARY="$(wait_for_assertion receiver-sealed receiver "$WAIT_SECONDS" "$BASELINE_VERSION")" \
  || fail "receiver_post_stop_state_invalid"

# The raw synthetic prompt may exist only in the user-owned private Claude
# profile; it must never reach this disposable Tirion root. With the direct
# agent already stopped, this only closes the sealed local control processes.
shutdown_writers
assert_repository_unchanged
validate_private_claude_root >/dev/null 2>&1 || fail "private_claude_config_changed_after_claude"
assert_privacy_marker_absent
assert_normal_profile_unchanged

node - "$MODEL" "$CLAUDE_VERSION" "$RELAY_HELD_SUMMARY" "$RELAY_RELEASE_SUMMARY" "$RELAY_SEAL_SUMMARY" "$AGENT_QUIESCE_SUMMARY" "$RECEIVER_SEAL_SUMMARY" "$FINAL_RELAY_SUMMARY" "$FINAL_RECEIVER_SUMMARY" "$POST_STOP_RELAY_SUMMARY" "$POST_STOP_RECEIVER_SUMMARY" <<'NODE'
const [
  model,
  claudeCodeVersion,
  relayHeld,
  relayReleased,
  relaySealed,
  agentQuiesce,
  receiverSealed,
  finalRelay,
  finalReceiver,
  postStopRelay,
  postStopReceiver
] = process.argv.slice(2);
try {
  const summary = {
    schemaVersion: 1,
    outcome: "passed",
    model,
    claudeCodeVersion,
    relay: {
      held: JSON.parse(relayHeld).relay,
      released: JSON.parse(relayReleased).relay,
      sealed: JSON.parse(relaySealed).relay,
      final: JSON.parse(finalRelay).relay,
      postStop: JSON.parse(postStopRelay).relay
    },
    agent: {
      quiesce: JSON.parse(agentQuiesce)
    },
    receiver: {
      sealed: JSON.parse(receiverSealed),
      final: JSON.parse(finalReceiver),
      postStop: JSON.parse(postStopReceiver)
    }
  };
  process.stdout.write(`CC15C live delayed-native-decision acceptance passed\n${JSON.stringify(summary)}\n`);
} catch {
  process.exit(1);
}
NODE
