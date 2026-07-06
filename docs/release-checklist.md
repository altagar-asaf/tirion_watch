# Release Checklist

Use this checklist before publishing a public source-preview tag.

## Versioning

- Keep Tirion pre-1.0 until provider support, attribution behavior, and
  packaging are stable.
- Use tags such as `v0.1.6`.
- Keep root and runtime package versions aligned when the agent, CLI, TUI, or
  distribution behavior changes together.
- Webhook schema versions are additive unless a release note explicitly calls
  out a breaking preview change.

## Required Commands

Run from a clean checkout:

```bash
node --version
npm --version
go version
npm ci
npm run check
(cd packages/tirion-tui && go run golang.org/x/vuln/cmd/govulncheck@v1.5.0 ./...)
git diff --exit-code
```

`npm run check` includes TypeScript compile/tests, Go TUI build/tests, and
`npm audit --audit-level=high`.

## Security And Privacy

- Run a full-history secret scan before making a repository public.
- Keep the `secret-scan` GitHub Actions workflow green.
- Review history for private roadmap, GTM, pilot/customer, local configuration,
  credential, or proprietary planning material.
- Confirm prompt/content capture defaults remain off.
- Run a privacy canary task and verify the canary is absent from Tirion state,
  logs, webhook captures, exports, and support output.
- Enable GitHub private vulnerability reporting, secret scanning, push
  protection, dependency graph, Dependabot alerts, and Dependabot security
  updates.

## Clean-Host Smoke

On a machine or user account that has not run Tirion:

1. Clone the public candidate repository.
2. Install with `npm ci`.
3. Run `npm run check`.
4. Start the agent with `tirionctl start`.
5. Launch the terminal UI with `tirionctl app` or `tirion-tui`.
6. Configure one supported provider using synthetic/test data.
7. Activate an explicit test repository.
8. Configure a local webhook sink.
9. Produce a read-only run and verify `run.ended`.
10. Produce a write run, commit it, and verify `commit.attributed`.
11. Run diagnostics and support bundle commands.
12. Clear local agent data.
13. Restore provider configuration.

## Release Notes

For each tag, update `CHANGELOG.md` with:

- Added
- Changed
- Fixed
- Privacy
- Security
- Known limitations

Do not claim production readiness, exact billing reconciliation, hosted backend
sync, GitHub Checks, organization reporting, npm package availability, signed
installers, or Marketplace distribution unless that surface is implemented,
tested, documented, and released.
