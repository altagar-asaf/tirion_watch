# Webhooks

Tirion emits privacy-safe JSON events to a user-configured webhook sink.

Configure delivery:

```bash
tirionctl webhook set-url http://127.0.0.1:8787/webhooks/tirion
tirionctl webhook enable-runs
```

Run lifecycle events are controlled by `enable-runs`. Commit attribution events
are always enabled for enrolled repositories and fire when Tirion has verified
attribution evidence.

## Delivery

Headers:

| Header | Meaning |
|---|---|
| `content-type` | `application/json` |
| `user-agent` | `tirion-agent/oss-local` |
| `x-tirion-event-id` | Stable event id. |
| `idempotency-key` | Same value as `x-tirion-event-id`. |
| `authorization` | `Bearer <token>` when configured. |
| `x-tirion-timestamp` | Unix seconds when HMAC is configured. |
| `x-tirion-signature-256` | `sha256=<hex>` HMAC signature when configured. |

HMAC signature input:

```text
HMAC_SHA256(secret, "<timestamp>.<raw-body>")
```

Delivery uses a durable local outbox with retry. Receivers should dedupe by
`x-tirion-event-id` or `idempotency-key`.

## Event Types

Current schema version: `1`.

### `run.start`

Emitted when Tirion has privacy-safe evidence that a run started in a watched
repository context.

Important fields:

- `schemaVersion`
- `eventType`
- `eventId`
- `runId`
- `traceIds`
- `repository`
- `codingHarness`
- `runtime`
- `startedAt`
- `state`

### `run.update`

Emitted when privacy-safe run activity changes before terminal completion.
Totals may be absent or partial.

Additional fields can include:

- `updatedAt`
- `activity`
- partial token or model information when available

### `run.ended`

Authoritative terminal event for a completed run.

Additional fields can include:

- `endedAt`
- reported token counts,
- `llmModels`,
- `filesChanged`,
- `estimatedNanoUsd`,
- `costEstimateBasis`,
- `costCoverage`,
- `state`.

`filesChanged` values are repo-relative paths only.

### `commit.attributed`

Emitted when Tirion conservatively verifies that one or more watched runs are
associated with a real git commit.

Important fields:

- `commitSha`
- `runIds`
- `traceIds`
- `estimatedNanoUsd`
- `costCoverage`
- `state`
- `version`
- `firstVerifiedAt`
- `updatedAt`

Commit events may be re-delivered with a later `version` if attribution state
changes, for example `rewrite_pending` or `superseded`.

## Privacy Exclusions

Webhook events must not contain prompts, responses, tool arguments, tool
outputs, file contents, diffs, raw telemetry payloads, credentials, absolute
paths, or transcript paths.
