# Tirion Agent Installation And Operations

This guide covers the packaged macOS source-preview agent. Tirion runs locally,
measures explicitly watched repositories, and sends privacy-safe lifecycle and
commit-attribution events only to the webhook URL configured by the operator.

## Install And Verify

Install the release package with the macOS Installer UI, or from a terminal:

```bash
sudo installer -pkg Tirion-0.1.6.pkg -target /
tirionctl version
tirionctl start
tirionctl status
tirionctl doctor
```

The packaged agent, CLI, and terminal UI are installed under
`/Applications/Tirion`; command launchers are installed under `/usr/local/bin`.
The package includes its own Node.js runtime.

## Configure A Coding Harness

Configure only the harnesses used on this machine:

```bash
tirionctl configure claude-code
tirionctl configure codex
tirionctl configure cursor
tirionctl sources list
```

Quit and reopen Claude Code, Codex, or Cursor after changing its managed source
configuration. A running harness does not reload the new telemetry environment.
Tirion refuses to replace unrelated exporters or hooks and reports conflicts
instead.

Provider changes are reversible:

```bash
tirionctl configure restore claude-code
tirionctl configure restore codex
tirionctl configure restore cursor
```

## Watch A Repository

Repository enrollment is explicit and provider-neutral:

```bash
tirionctl repo activate /absolute/path/to/repository --provider codex
tirionctl repo list
```

The provider option checks source readiness during activation. It does not
prevent another supported harness from being observed in the same repository.

## Configure Webhook Delivery

Use a receiver controlled by the operator. A loopback receiver is recommended
for initial validation:

```bash
tirionctl webhook set-url http://127.0.0.1:8787/webhooks/tirion
tirionctl webhook set-token '<receiver-token>'
tirionctl webhook set-secret '<receiver-hmac-secret>'
tirionctl webhook enable-runs
tirionctl webhook test
tirionctl webhook status
```

Do not place credentials in scripts, shell history, support bundles, or issue
reports. Receivers should deduplicate with `x-tirion-event-id` or
`idempotency-key` and treat `run.update` and higher `run.ended` versions as
replacement snapshots.

## Monitor And Operate

```bash
tirionctl app
tirionctl runs --current
tirionctl totals
tirionctl attribution list
tirionctl webhook status
tirionctl doctor
```

For a bounded maintenance drain, first stop new harness work, then run:

```bash
tirionctl runtime quiesce --timeout-ms 60000
tirionctl restart
```

Accept the drain only when it reports `state: "drained"` and all ingress,
runtime-work, and webhook booleans are true. A successful drain deliberately
seals telemetry ingress, so restart the agent immediately and confirm healthy,
full-owner, warmup-ready status before resuming work.

If the webhook receiver was unavailable, keep the agent running, repair the
receiver, and retry the durable queue:

```bash
tirionctl webhook status
tirionctl webhook retry
```

## Privacy Boundary

Prompt text, model responses, tool arguments and results, file contents, diffs,
raw telemetry, credentials, transcript locations, and absolute repository paths
must not be stored or sent by the active local product. Prompt and content
capture remain off by default. Webhooks may contain safe repository labels,
opaque identifiers, usage metadata, estimated cost fields, and verified
repository-relative changed paths.

For support, share only redacted output from `tirionctl doctor` and the bounded
safe log surface. Never attach real prompts, source code, webhook bodies,
provider configuration, credentials, or private repository locations.

## Reset Or Restore

Restore managed provider configuration before removing Tirion. For disposable
local state only, clear the agent after confirming no retained webhook work is
needed:

```bash
tirionctl webhook status
tirionctl configure restore claude-code
tirionctl configure restore codex
tirionctl configure restore cursor
tirionctl clear-agent-data --confirm
tirionctl stop
```

See the packaged README and `docs/troubleshooting.md` in the source repository
for source-specific readiness and recovery guidance.
