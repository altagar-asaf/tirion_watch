# Changelog

All notable changes to Tirion are documented here.

Tirion is currently pre-1.0. Public source-preview releases use tags such as
`v0.1.6`; compatibility may change before a stable release, but privacy and
webhook contract changes must be called out explicitly.

## 0.1.6 - 2026-07-16

### Added

- Public source-preview governance, security, support, and contribution docs.
- `tirion-tui` as the primary terminal interface for local status,
  repository activation, run and attribution views, webhook status, budgets,
  diagnostics, and harness readiness.
- Cursor local hook support and GitHub Copilot span DB replay documentation.
- CI coverage for TypeScript workspaces and the Go TUI.
- Managed Claude Code enhanced telemetry, optimized trace cadence, lifecycle,
  tool, failure, and diagnostic hooks with exact drift detection and restore.
- Metadata-only local MCP success and controlled-failure coverage for Claude
  Code, plus privacy-scoped native census and acceptance harnesses.
- An authenticated runtime fixed-point drain used by release and shutdown
  acceptance before an orderly restart.
- A packaged installation and operations guide covering source configuration,
  watched repositories, webhook delivery, fixed-point drain/restart, privacy,
  and safe reset/restore.

### Changed

- Public docs now frame cost as estimated cost from reported local telemetry.
- Internal planning docs are excluded from the public tree.
- Claude Code and Codex now share the canonical `run.start`, `run.update`, and
  versioned `run.ended` webhook lifecycle with final activity and usage
  conservation.
- Fresh lifecycle anchors, completed-run projection, attribution, and webhook
  delivery use independent scheduler lanes so lengthy runs and historical work
  do not serialize unrelated starts or terminals.
- Webhook updates are replacement snapshots with strict logical clocks;
  terminal admission is durable and does not wait for outbound HTTP.

### Fixed

- Claude public starts now require exact customer-authoritative provenance;
  generated task/title work cannot create a public root.
- Claude completion now requires its exact Stop/closed-root join, with
  StopFailure, background work, clear/exit diagnostics, and sequential roots
  handled without invented terminals.
- Direct child activity and usage are folded once through exact native identity,
  preserving unknown, failure, and rejected outcomes rather than inferring
  success.
- Auxiliary session-title usage is excluded from customer totals only when the
  native purpose join is exact; unknown purpose remains counted.
- Running and terminal webhook projections preserve per-run order, suppress
  stale post-terminal updates, deduplicate equivalent meaning, and retain
  durable retry/idempotency behavior under concurrent delivery.
- Causal write and commit attribution now require exact semantic-write proof;
  native rejection corrections cannot inherit execution, file, usage, or
  terminal authority.
- Windowed privacy-safe diagnostics survive high-volume concurrent telemetry
  without exposing raw provider content.

### Privacy

- Prompt and content capture remain off by default.
- Public docs explicitly state webhook and local storage privacy boundaries.
- Claude provenance checks inspect only a bounded trusted transcript tail and
  persist no transcript location or content.
- Live Claude/Codex webhook acceptance found no prompt marker, absolute path,
  forbidden content field, raw telemetry, tool argument/result, or malformed
  payload in the release window.

### Security

- CodeQL covers JavaScript/TypeScript and Go.
- `npm audit --audit-level=high` is part of the standard check gate.

### Known Limitations

- Source-preview install is from a clean checkout; npm packages, signed
  installers, VS Code extension packaging, hosted backend sync, GitHub Checks,
  organization reporting, prompt drilldown, and exact billing reconciliation
  are not supported.
- The next release owns repeated long-run p50/p95 benchmarks, isolated receiver
  ingestion, slow-sink/retry/restart stress, layered Codex `Bash`/`exec`
  semantics, broader child/workflow/skill/file cases, multi-repository routing,
  cross-version/auth coverage, auxiliary billing contexts, and authenticated
  third-party MCP behavior.
- CC15 live late-decision/file/commit correction remains explicitly deferred;
  deterministic composition coverage does not make it part of this release.
