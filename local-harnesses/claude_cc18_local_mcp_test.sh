#!/usr/bin/env bash
set -euo pipefail
umask 077

# Interactive, opt-in CC-18 local-MCP launcher. It leaves normal Claude
# settings and Tirion hooks in place, but uses --strict-mcp-config so no cloud
# connector is offered to this one test session.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SERVER="$SCRIPT_DIR/claude_cc18_local_mcp_server.mjs"
MODE="${1:-}"
MODEL="${TIRION_CC18_CLAUDE_MODEL:-}"
SETTINGS_FILE="${TIRION_CC18_CLAUDE_SETTINGS:-}"
SETTING_SOURCES="${TIRION_CC18_CLAUDE_SETTING_SOURCES:-}"
WORKDIR="${TIRION_CC18_WORKDIR:-$PWD}"

fail() {
  printf 'CC18 fixture failed: %s\n' "$1" >&2
  exit 1
}

case "$MODE" in
  success)
    TOOL="mcp__tirion_cc18_local__tirion_cc18_readonly_success"
    ;;
  failure)
    TOOL="mcp__tirion_cc18_local__tirion_cc18_controlled_failure"
    ;;
  *)
    fail "usage: $0 <success|failure>"
    ;;
esac

[[ -t 0 && -t 1 ]] || fail "interactive_tty_required"
[[ -f "$SERVER" ]] || fail "local_server_missing"
command -v claude >/dev/null 2>&1 || fail "claude_missing"
command -v node >/dev/null 2>&1 || fail "node_missing"
if [[ -n "$MODEL" && ! "$MODEL" =~ ^[A-Za-z0-9._-]{1,120}$ ]]; then
  fail "invalid_model_token"
fi
[[ -d "$WORKDIR" && ! -L "$WORKDIR" ]] || fail "workdir_invalid"
WORKDIR="$(cd -- "$WORKDIR" && pwd -P)"
if [[ -n "$SETTINGS_FILE" ]]; then
  [[ -f "$SETTINGS_FILE" && ! -L "$SETTINGS_FILE" ]] || fail "settings_file_invalid"
  SETTINGS_FILE="$(cd -- "$(dirname -- "$SETTINGS_FILE")" && pwd -P)/$(basename -- "$SETTINGS_FILE")"
fi
if [[ -n "$SETTING_SOURCES" && ! "$SETTING_SOURCES" =~ ^(user|project|local)(,(user|project|local))*$ ]]; then
  fail "setting_sources_invalid"
fi

TMP_PARENT="${TMPDIR:-/tmp}"
TMP_PARENT="${TMP_PARENT%/}"
ROOT="$(mktemp -d "$TMP_PARENT/tirion-cc18.XXXXXX")" || fail "temporary_root_unavailable"
chmod 700 "$ROOT"
MCP_CONFIG="$ROOT/mcp.json"
AUDIT_FILE="$ROOT/audit.json"

cleanup() {
  rm -rf -- "$ROOT"
}
trap cleanup EXIT HUP INT TERM

CAPABILITY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
[[ "$CAPABILITY" =~ ^[A-Za-z0-9_-]{32,128}$ ]] || fail "capability_generation_failed"

node - "$MCP_CONFIG" "$SERVER" "$AUDIT_FILE" "$CAPABILITY" "$MODE" <<'NODE'
const { chmodSync, writeFileSync } = require("node:fs");
const [configPath, serverPath, auditPath, capability, mode] = process.argv.slice(2);
const config = {
  mcpServers: {
    tirion_cc18_local: {
      command: process.execPath,
      args: [serverPath],
      env: {
        TIRION_CC18_AUDIT_PATH: auditPath,
        TIRION_CC18_CAPABILITY: capability,
        TIRION_CC18_MODE: mode,
      },
    },
  },
};
writeFileSync(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
chmodSync(configPath, 0o600);
NODE

CLAUDE_ARGS=(
  --strict-mcp-config
  --mcp-config "$MCP_CONFIG"
  --tools ""
  --allowedTools "$TOOL"
)
if [[ -n "$MODEL" ]]; then
  CLAUDE_ARGS=(--model "$MODEL" "${CLAUDE_ARGS[@]}")
fi
if [[ -n "$SETTINGS_FILE" ]]; then
  CLAUDE_ARGS+=(--settings "$SETTINGS_FILE")
fi
if [[ -n "$SETTING_SOURCES" ]]; then
  CLAUDE_ARGS+=(--setting-sources "$SETTING_SOURCES")
fi

printf '%s\n' "CC18 local MCP $MODE fixture is ready. Submit the supplied one-tool prompt, then type /exit. This session exposes no cloud MCP server and no built-in tool." >&2
set +e
(
  cd -- "$WORKDIR"
  claude "${CLAUDE_ARGS[@]}"
)
CLAUDE_EXIT="$?"
set -e
[[ "$CLAUDE_EXIT" -eq 0 ]] || fail "claude_exit_nonzero"

node - "$AUDIT_FILE" "$MODE" <<'NODE'
const { readFileSync } = require("node:fs");
const [auditPath, mode] = process.argv.slice(2);
const expectedTool = mode === "success"
  ? "tirion_cc18_readonly_success"
  : "tirion_cc18_controlled_failure";
const fail = (reason) => {
  process.stderr.write(`CC18 fixture failed: ${reason}\n`);
  process.exit(1);
};
let audit;
try {
  audit = JSON.parse(readFileSync(auditPath, "utf8"));
} catch {
  fail("audit_missing_or_invalid");
}
if (audit?.schemaVersion !== 1) fail("audit_schema_invalid");
if (audit.server !== "tirion_cc18_local") fail("audit_server_invalid");
if (audit.mode !== mode || audit.tool !== expectedTool) fail("audit_mode_or_tool_invalid");
if (audit.capabilityReady !== true || audit.auditReady !== true) fail("fixture_capability_not_ready");
if (audit.initializeCount !== 1 || audit.initializedNotificationCount !== 1) fail("mcp_initialization_count");
if (!Number.isInteger(audit.toolsListCount) || audit.toolsListCount < 1) fail("mcp_tools_list_missing");
if (audit.expectedToolCallCount !== 1 || audit.unexpectedToolCallCount !== 0) fail("mcp_tool_call_count");
if (audit.malformedMessageCount !== 0) fail("mcp_malformed_message");
if (typeof audit.protocolVersion !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(audit.protocolVersion)) fail("mcp_protocol_version_missing");
NODE

printf 'CC18 local MCP %s fixture complete\n' "$MODE"
