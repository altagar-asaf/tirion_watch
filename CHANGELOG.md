# Changelog

All notable changes to Tirion are documented here.

Tirion is currently pre-1.0. Public source-preview releases use tags such as
`v0.1.6`; compatibility may change before a stable release, but privacy and
webhook contract changes must be called out explicitly.

## Unreleased

### Added

- Public source-preview governance, security, support, and contribution docs.
- `tirion-tui` as the primary terminal interface for local status,
  repository activation, run and attribution views, webhook status, budgets,
  diagnostics, and harness readiness.
- Cursor local hook support and GitHub Copilot span DB replay documentation.
- CI coverage for TypeScript workspaces and the Go TUI.

### Changed

- Public docs now frame cost as estimated cost from reported local telemetry.
- Internal planning docs are excluded from the public tree.

### Privacy

- Prompt and content capture remain off by default.
- Public docs explicitly state webhook and local storage privacy boundaries.

### Security

- CodeQL covers JavaScript/TypeScript and Go.
- `npm audit --audit-level=high` is part of the standard check gate.

### Known Limitations

- Source-preview install is from a clean checkout; npm packages, signed
  installers, VS Code extension packaging, hosted backend sync, GitHub Checks,
  organization reporting, prompt drilldown, and exact billing reconciliation
  are not supported.
