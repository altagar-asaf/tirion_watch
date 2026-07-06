# Troubleshooting

## Agent Not Running

```bash
tirionctl status
tirionctl doctor
tirionctl start
```

If the agent was already installed, use `tirionctl restart`.

## Bootstrap Credential Missing

Run:

```bash
tirionctl doctor
tirionctl start
```

If the local state is disposable, clear it:

```bash
tirionctl clear-agent-data --confirm
tirionctl start
```

## Provider Configuration Conflict

Tirion refuses to overwrite unrelated provider telemetry settings.

```bash
tirionctl sources list
tirionctl configure restore claude-code
tirionctl configure restore codex
tirionctl configure restore cursor
tirionctl configure restore github-copilot
```

Review the provider config manually if restore reports drift or conflict.

## No Telemetry Receipts

Restart the coding agent after configuration. Then check:

```bash
tirionctl sources list
tirionctl doctor
```

`awaiting_receipts` is expected until the provider emits telemetry.

## Repository Not Enrolled

Activate each repository explicitly:

```bash
tirionctl repo activate /absolute/path/to/repo
tirionctl repo list
```

Tirion does not scan your home directory for repositories.

## Webhook Sink Down

```bash
tirionctl webhook status
tirionctl webhook retry
tirionctl webhook test
```

Check the sink URL, bearer token, HMAC secret, and receiver logs. Receivers
should dedupe by `x-tirion-event-id`.

## Unpriced Or Partial Runs

Estimated cost is shown only when Tirion has supported pricing evidence. Unknown
models, subscription billing, or missing provider evidence may remain
usage-only.

## Unknown Provider Or Model

Keep the run as usage-only and open an issue with synthetic reproduction details.
Do not include real prompts, source code, raw telemetry, or private repo names.

## Safe Support Information

Use:

```bash
tirionctl doctor
tirionctl logs
```

Before sharing anything publicly, remove local paths, repository names, secrets,
webhook URLs, prompt text, source code, telemetry payloads, and webhook payloads
from real workspaces.
