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
(cd packages/tirion-tui && GOTOOLCHAIN=go1.26.5 go run golang.org/x/vuln/cmd/govulncheck@v1.5.0 ./...)
TIRION_RELEASE_VERSION="$(node -p 'require("./package.json").version')" \
  TIRION_NODE_RUNTIME="$(command -v node)" \
  TIRION_UNSIGNED_DEVELOPMENT=1 \
  npm run package:macos
git diff --exit-code
```

`npm run check` includes TypeScript compile/tests, Go TUI build/tests, and
`npm audit --audit-level=high`. The Node runtime supplied to the package command
must be Node 24. The unsigned package is a local payload/manifest smoke only;
do not publish it as a signed or notarized installer.

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

## Live Cross-Harness Webhook Gate

Run this gate with the release-candidate installed CLI and agent, not a mixed
global/workspace binary pair:

1. Activate one disposable or explicitly approved watched repository.
2. Configure a loopback receiver whose ingestion path is isolated from any
   synchronous dashboard indexing or rendering work.
3. Confirm Claude Code and Codex source configuration is current, prompt and
   content capture is off, and the webhook queue and blocked counts are zero.
4. Start one read-only multi-minute Claude Code run and one read-only
   multi-minute Codex run close enough together to overlap.
5. For each prompt-authoritative root, require one `run.start`, one or more
   replacement `run.update` events, and at least one completed `run.ended`.
6. Verify event IDs are unique, update clocks and terminal versions are
   monotonic, no update follows the first terminal, and final activity token
   totals conserve exactly to the run totals.
7. Record source duration, source-start-to-first-delivery,
   completion-to-first-terminal, update-gap p50/p95/max, update count, terminal
   versions, total tokens, coverage, retry count, and queue age using only safe
   metadata.
8. Scan the acceptance window for prompt markers, absolute paths, raw telemetry,
   tool arguments/results, file contents, diffs, and every forbidden webhook
   field. Require zero matches.
9. Run `tirionctl runtime quiesce --timeout-ms 60000`. Require `state: drained`
   and all ingress/runtime/webhook drain booleans true, then immediately run
   `tirionctl restart` because a successful drain deliberately seals ingress.
10. Require healthy/full-owner/warmup-ready status after restart, complete
    Claude/Codex source readiness, the watched scope still active, and webhook
    queued/blocked counts back at zero.

Link the safe acceptance record and the canonical next-release use-case
register from the release notes. A single passing run is functional release
evidence, not a statistically meaningful performance claim.

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
