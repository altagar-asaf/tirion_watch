# Tirion

Tirion is an **experimental public source preview** of a local cost
observability agent for supported AI coding telemetry.

It runs on your machine, gives you a terminal TUI for local observability and
setup, watches only repositories you explicitly activate, measures reported
token usage from supported local telemetry, estimates cost when pricing evidence
is known, and emits privacy-safe webhook events to a local or user-configured
sink.

This preview is source-install only. Tirion does not publish npm packages, VS
Code extensions, signed installers, backend sync, GitHub Checks, organization
reporting, prompt drilldown, or exact billing reconciliation.

Licensed under Apache-2.0.

## What It Measures

- Reported token usage from supported local telemetry.
- Estimated cost from built-in pricing tables or provider-reported estimates
  when the billing context is known.
- Completed agentic runs inside explicitly watched repositories.
- Conservative commit attribution when Tirion has proof connecting a completed
  run to a real git commit.

Unknown pricing, subscription billing, missing repository context, or ambiguous
attribution evidence remains partial, unavailable, or unattributed instead of
being guessed.

## Supported Preview Surface

- Local agent, `tirion-tui` terminal interface, and `tirionctl` CLI.
- Claude Code, Codex, and Cursor local telemetry/hook configuration.
- GitHub Copilot local span DB replay where configured.
- Explicit repository activation.
- Local webhook delivery with durable retry.
- macOS source-based development.
- Linux source-based development on a best-effort preview basis.

Windows, npm package installation, VS Code extension packaging, Marketplace
distribution, remote backend sync, GitHub Check publishing, and organization
reporting are not supported in this preview.

## Privacy Boundary

Tirion does not durably store or export prompt text, response text, tool
arguments, tool outputs, file contents, diffs, raw telemetry payloads,
credentials, or absolute repository paths in the active local-only product.

Webhook payloads may include usage metadata, estimated cost fields, safe
repository labels, opaque repository/run identifiers, and repo-relative changed
file paths after the repository has been explicitly watched.

Prompt capture defaults off. Content capture defaults off. Keep these defaults
off unless you are doing local-only development with synthetic data.

## Quick Start

Use Node.js 24 and Go 1.24 or newer.

```bash
git clone https://github.com/altagar-asaf/tirion.git
cd tirion
npm ci
npm run compile
npm run tui:build
node packages/tirionctl/dist/main.js version
```

For a complete source-install walkthrough, see
[`GETTING_STARTED.md`](GETTING_STARTED.md).

## Common Commands

```bash
tirionctl start
tirionctl app
tirion-tui
tirionctl configure claude-code
tirionctl configure codex
tirionctl configure cursor
tirionctl configure github-copilot --span-db /absolute/path/to/agent-traces.db
tirionctl repo activate /path/to/repository --provider codex
tirionctl webhook set-url http://127.0.0.1:8787/webhooks/tirion
tirionctl webhook enable-runs
tirionctl webhook status
tirionctl runs
tirionctl runs --current
tirionctl totals
tirionctl attribution list
tirionctl doctor
```

Provider settings changed by Tirion are reversible through
`tirionctl configure restore claude-code|codex|cursor|github-copilot` or
`tirionctl sources restore claude-code|codex|cursor`.

## Webhook Events

The webhook contract currently includes:

- `run.start`
- `run.update`
- `run.ended`
- `commit.attributed`

Run lifecycle events are controlled by `tirionctl webhook enable-runs`.
Commit attribution events are always enabled for enrolled repositories and fire
when Tirion has verified attribution evidence.

Delivery supports optional bearer-token auth, optional HMAC-SHA256 signatures,
stable event IDs, idempotency keys, durable local retry, and privacy allowlist
validation before send.

See [`docs/webhooks.md`](docs/webhooks.md) for schemas and signing details.

## Architecture

Tirion follows construct-first boundaries documented in
[`constructs.md`](constructs.md). The active public product is:

`TelemetrySourceConfiguration -> TelemetryIngress -> PrivacyGuard -> TelemetryClassification -> SafeObservationJournal + RunCorrelationLedger -> UsageProjection -> RunLedger`

`RunLedger + RepositoryObservation + WorkspaceChangeTracker + AgenticWorkEpisode -> GitAttribution -> ExternalWebhookDispatch`

No remote backend-to-agent control line is part of this preview.

## More Docs

- [`docs/privacy.md`](docs/privacy.md)
- [`docs/webhooks.md`](docs/webhooks.md)
- [`docs/harness-run-monitoring.md`](docs/harness-run-monitoring.md)
- [`docs/troubleshooting.md`](docs/troubleshooting.md)
- [`docs/release-checklist.md`](docs/release-checklist.md)
- [`CHANGELOG.md`](CHANGELOG.md)
- [`SUPPORT.md`](SUPPORT.md)
- [`SECURITY.md`](SECURITY.md)
