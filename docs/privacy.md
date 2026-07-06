# Privacy

Tirion is a local source-preview agent. The active public product boundary is
local telemetry ingestion, local storage, explicit repository watching,
conservative commit attribution, and outbound webhooks configured by the user.

## Local State

Default state paths:

- macOS: `~/Library/Application Support/Tirion/agent`
- Linux: `~/.local/state/tirion/agent`

The local state directory stores privacy-projected observations, run ledgers,
repository scope records, attribution evidence, webhook outbox state, bootstrap
credentials, and diagnostics needed to operate the agent.

## Data Never Stored Or Exported

The active product must not durably store or export:

- prompt text,
- response text,
- tool arguments,
- tool outputs,
- file contents,
- diffs,
- raw telemetry payloads,
- credentials,
- absolute repository paths.

Prompt capture defaults off. Content capture defaults off. Optional local
development flags must not be used with real private data unless you have
reviewed the code path and understand the local-only risk.

## Data Sent To Webhooks

Only configured webhook sinks receive outbound event data. Payloads may include:

- event type, event id, timestamps, and schema version,
- provider/runtime labels,
- opaque run and trace identifiers,
- safe repository labels and opaque repository keys,
- reported token counts,
- estimated cost fields and coverage status,
- repo-relative changed file paths for watched repositories,
- commit hashes for attributed commits.

Webhook payloads are allowlist validated before delivery.

## Local Authentication

The control API is intended for same-machine clients. The agent uses a bootstrap
credential and private local state. Webhooks can optionally use bearer-token
authorization and HMAC-SHA256 signatures.

## Retention And Clearing Data

Use:

```bash
tirionctl clear-agent-data --confirm
```

This clears local agent state. Provider configuration can be restored with:

```bash
tirionctl configure restore claude-code
tirionctl configure restore codex
tirionctl configure restore cursor
tirionctl configure restore github-copilot
```

## Support Bundles And Diagnostics

Diagnostics and support bundles must remain content-light. Do not share real
logs, webhook captures, telemetry payloads, prompts, repository names, absolute
paths, or source code in public issues.
