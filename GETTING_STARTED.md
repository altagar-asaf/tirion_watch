# Getting Started with the Tirion Local Agent

Tirion is a **public source preview** of a standalone local agent that watches
supported AI coding telemetry and emits privacy-safe webhook events:

- `run.start` - a provider-observed run has started in a watched repository.
- `run.update` - privacy-safe activity metadata changed during a run.
- `run.ended` - a completed agentic run inside a repository you explicitly watch.
- `commit.attributed` - conservative, verified estimated cost attribution for a
  real git commit produced by a watched run.

Everything runs locally. No Tirion backend, GitHub App, npm package, VS Code
extension, or cloud account is required for this preview. Prompts, responses,
tool inputs/outputs, file contents, diffs, raw telemetry, and absolute paths
never leave your machine through the active product boundary. Webhooks may send
repo-relative changed-file paths and usage/estimated-cost metadata to the sink
you configure. When model and token evidence is complete enough to price safely,
run events also include `usageValueNanoUsd`, a catalog-rate usage value separate
from the estimated billed cost.

This preview is intended to be verified from the commands below. Maintainer-only
acceptance harnesses are not part of the public source tree.

---

## 1. Prerequisites

- **Node.js 24** (the agent runtime targets Node 24; older majors are not supported).
- **Go 1.24 or newer** (builds the terminal TUI from source).
- **git**
- One supported coding agent, installed and authenticated:
  - **Claude Code** (`claude`), or
  - **Codex** (`codex`), or
  - **Cursor**, or
  - **GitHub Copilot** with an explicitly configured local span DB path.
- For the example webhook sink below: **python3** (zero extra deps) or Node.js.
- Supported OS: **macOS** (runs as a per-user `launchd` service) and **Linux**
  (runs as a background process). Windows is not currently supported.

---

## 2. Install

From the repository root:

```bash
git clone https://github.com/altagar-asaf/tirion.git
cd tirion
npm ci
npm run compile
npm run tui:build
```

Put `tirionctl` and `tirion-tui` on your `PATH`. The CLI resolves the agent
binary relative to its real location inside the repo, so symlink it (do **not**
copy it out of the repo):

```bash
mkdir -p ~/.local/bin
ln -sf "$PWD/packages/tirionctl/dist/main.js" ~/.local/bin/tirionctl
ln -sf "$PWD/packages/tirion-tui/tirion-tui" ~/.local/bin/tirion-tui
# Make sure ~/.local/bin is on your PATH, e.g. add to ~/.zshrc:
#   export PATH="$HOME/.local/bin:$PATH"
```

Verify:

```bash
tirionctl version
test -x packages/tirion-tui/tirion-tui
```

> Alternatively, skip the symlink and run `node packages/tirionctl/dist/main.js <command>`
> from the repo root. Every `tirionctl <command>` below is equivalent.

---

## 3. Start the agent

```bash
tirionctl start      # macOS: installs + starts the launchd service; Linux: spawns the daemon
tirionctl status     # should report "health":"healthy"
```

Launch the main terminal interface:

```bash
tirionctl app        # or: tirion-tui
```

Useful lifecycle commands: `tirionctl stop`, `tirionctl restart`, `tirionctl doctor`.

The TUI is the main interactive surface for local status, repository activation,
runs, attribution, webhook status, budgets, diagnostics, and supported harness
readiness. `tirionctl` remains useful for scripts, service lifecycle, and
copy-pasteable setup commands.

State lives under:
- macOS: `~/Library/Application Support/Tirion/agent`
- Linux: `~/.local/state/tirion/agent`

To wipe all local state and start clean: `tirionctl clear-agent-data --confirm`.

---

## 4. Configure a coding agent as a telemetry source

For Claude Code, Codex, and Cursor, this sets up a **loopback** telemetry
surface so the chosen agent reports usage to Tirion on `127.0.0.1:4318`:

```bash
tirionctl configure claude-code
tirionctl configure codex
tirionctl configure cursor
```

- For Claude Code this edits `~/.claude/settings.json`; for Codex it edits the
  Codex config; for Cursor it edits the user-scope Cursor `hooks.json` and
  installs a private same-machine hook relay. Your existing settings are
  preserved where possible.
- The change is **reversible**: `tirionctl configure restore claude-code`
  (or `codex`, `cursor`).
- **Restart your coding agent** after configuring so it picks up the exporter:
  open a new `claude`/`codex` session, or restart Cursor. Until telemetry
  arrives, the source status shows `awaiting_receipts` - that is expected.

For GitHub Copilot, Tirion does not mutate VS Code Copilot settings. If you
already have a local Copilot span DB path, register it explicitly:

```bash
tirionctl configure github-copilot --span-db /absolute/path/to/agent-traces.db
```

This enables span DB replay from the configured path. Restore disables the
Tirion-managed span DB registration:

```bash
tirionctl configure restore github-copilot
```

---

## 5. Watch a repository

Tirion only observes repositories you explicitly activate:

```bash
tirionctl repo activate /absolute/path/to/your/repo
tirionctl repo list
```

The provider is auto-selected from recent telemetry; pin it if you prefer:

```bash
tirionctl repo activate /path --provider claude-code
tirionctl repo activate /path --provider codex
tirionctl repo activate /path --provider cursor
tirionctl repo activate /path --provider github-copilot
```

---

## 6. Point Tirion at a webhook sink

```bash
tirionctl webhook set-url http://127.0.0.1:8787/webhooks/tirion
tirionctl webhook enable-runs
tirionctl webhook status
```

Optional local authentication on outbound deliveries:

```bash
tirionctl webhook set-token  <bearer-token>   # sends: Authorization: Bearer <token>
tirionctl webhook set-secret <hmac-secret>    # signs with HMAC-SHA256 (see section 8)
```

Delivery uses a durable local outbox with retry. If a sink was down, run
`tirionctl webhook retry` to flush. `tirionctl webhook test` sends a probe.

---

## 7. Spin up a local webhook server (so you can see events)

Pick **one** of the rudimentary, dependency-free sinks below. Each listens on
`127.0.0.1:8787`, prints every event, and saves the raw bodies under
`./tirion-events/`.

### Option A - Python (no dependencies)

Save as `tirion_sink.py` and run `python3 tirion_sink.py`:

```python
#!/usr/bin/env python3
"""Minimal Tirion webhook sink. Listens on 127.0.0.1:8787 and prints events."""
import json, os, time, hmac, hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

PORT = int(os.environ.get("PORT", "8787"))
SECRET = os.environ.get("TIRION_WEBHOOK_SECRET", "")  # set to verify signatures
OUT = Path("tirion-events"); OUT.mkdir(exist_ok=True)

def verify(headers, body):
    if not SECRET:
        return True  # no secret configured -> skip verification
    ts = headers.get("x-tirion-timestamp", "")
    sig = headers.get("x-tirion-signature-256", "")
    expected = "sha256=" + hmac.new(
        SECRET.encode(), f"{ts}.{body.decode()}".encode(), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, sig)

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", "0")))
        ok = verify(self.headers, body)
        event = json.loads(body or b"{}")
        etype = event.get("eventType", "?")
        eid = self.headers.get("x-tirion-event-id", "?")
        print(f"\n[{time.strftime('%H:%M:%S')}] {etype}  id={eid}  signature_ok={ok}")
        print(json.dumps(event, indent=2))
        (OUT / f"{time.time_ns()}.{etype}.json").write_bytes(body)
        self.send_response(200 if ok else 401)
        self.send_header("content-type", "application/json"); self.end_headers()
        self.wfile.write(b'{"ok":true}\n' if ok else b'{"ok":false}\n')

    def log_message(self, *a):  # silence default logging
        return

print(f"Tirion sink listening on http://127.0.0.1:{PORT}/webhooks/tirion")
HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
```

### Option B - Node.js (no dependencies)

Save as `tirion_sink.mjs` and run `node tirion_sink.mjs`:

```js
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 8787);
const SECRET = process.env.TIRION_WEBHOOK_SECRET ?? "";
mkdirSync("tirion-events", { recursive: true });

const verify = (headers, body) => {
  if (!SECRET) return true;
  const ts = headers["x-tirion-timestamp"] ?? "";
  const sig = headers["x-tirion-signature-256"] ?? "";
  const expected = `sha256=${createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex")}`;
  const a = Buffer.from(expected), b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
};

createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const ok = verify(req.headers, body);
    const event = JSON.parse(body || "{}");
    console.log(`\n[${new Date().toISOString()}] ${event.eventType}  ` +
      `id=${req.headers["x-tirion-event-id"]}  signature_ok=${ok}`);
    console.log(JSON.stringify(event, null, 2));
    writeFileSync(`tirion-events/${Date.now()}.${event.eventType}.json`, body);
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok }));
  });
}).listen(PORT, "127.0.0.1",
  () => console.log(`Tirion sink on http://127.0.0.1:${PORT}/webhooks/tirion`));
```

---

## 8. Generate events and watch them arrive

1. Start your sink (section 7).
2. Open a new session of your configured coding agent **inside the watched repo**
   and give it a task, e.g. with Claude Code:
   ```bash
   cd /absolute/path/to/your/repo
   claude -p "Summarize what this repository does."
   ```
   -> expect `run.start`, `run.update`, and `run.ended` events in your sink
   (`filesChanged: []` for a read-only task).
3. Ask it to change a file, then commit:
   ```bash
   claude -p "Add a CHANGELOG.md with a single 'Initial entry.' line."
   git add -A && git commit -m "add changelog"
   ```
   -> expect another run lifecycle sequence and then a `commit.attributed` event
   whose `runIds` links back to that run.

Inspect locally anytime:

```bash
tirionctl runs            # completed runs
tirionctl runs --current  # in-flight (read-only) view
tirionctl totals
tirionctl attribution list
tirionctl webhook status  # queued / blocked / delivered counts
```

---

## 9. Event reference

### Delivery headers

| Header | Notes |
|---|---|
| `content-type` | `application/json` |
| `user-agent` | `tirion-agent/oss-local` |
| `x-tirion-event-id` / `idempotency-key` | Stable per-event id - use it to dedupe. |
| `authorization` | `Bearer <token>` when a bearer token is configured. |
| `x-tirion-timestamp` | Unix seconds; present when an HMAC secret is configured. |
| `x-tirion-signature-256` | `sha256=<hex>` of `HMAC_SHA256(secret, "<timestamp>.<raw-body>")`. |

### `run.start` and `run.update`

`run.start` and `run.update` use the same privacy-safe run identity fields as
`run.ended`, but may be emitted before final token/cost totals are known. Treat
`run.ended` as the authoritative terminal run event.

### `run.ended` (example)

```json
{
  "schemaVersion": 1,
  "eventType": "run.ended",
  "eventId": "evt_example",
  "runId": "run_example",
  "traceIds": ["qry_example", "req_example"],
  "repository": { "repoKey": "repo_example", "owner": "local", "name": "your-repo", "fullName": "local/your-repo" },
  "codingHarness": "claude-code",
  "runtime": "claude-code",
  "startedAt": "2026-06-23T07:36:00.589Z",
  "endedAt": "2026-06-23T07:36:16.382Z",
  "inputTokens": 5,
  "outputTokens": 374,
  "cacheReadInputTokens": 16453,
  "cacheCreationInputTokens": 1922,
  "reasoningOutputTokens": 0,
  "totalTokens": 379,
  "llmModels": ["claude-opus-4-6"],
  "filesChanged": ["README.md", "src/answer.ts"],
  "estimatedNanoUsd": 29614000,
  "usageValueNanoUsd": 29614000,
  "costEstimateBasis": "provider_reported_estimate",
  "costCoverage": "complete",
  "state": "completed"
}
```

`filesChanged` are always **repo-relative**. `estimatedNanoUsd` is fixed-precision
(1e-9 USD) and **always an estimate**; `costEstimateBasis` is one of
`catalog_estimate`, `provider_reported_estimate`, or `unavailable`.
`usageValueNanoUsd` is present only when Tirion can calculate a complete
catalog-rate value for the observed token usage. It is useful for consumption
analysis across subscription and direct-billed runs, but it is not an invoice
reconciliation field.

### `commit.attributed` (example)

```json
{
  "schemaVersion": 1,
  "eventType": "commit.attributed",
  "eventId": "evt_example",
  "repository": { "repoKey": "repo_example", "owner": "local", "name": "your-repo", "fullName": "local/your-repo" },
  "commitSha": "bfeea288fe4bbb57c2a550e6226a5379ae83e346",
  "runIds": ["run_example"],
  "traceIds": ["qry_example", "req_example"],
  "estimatedNanoUsd": 27837000,
  "usageValueNanoUsd": 27837000,
  "costCoverage": "complete",
  "state": "active",
  "version": 1,
  "firstVerifiedAt": "2026-06-23T07:40:44.475Z",
  "updatedAt": "2026-06-23T07:40:44.475Z"
}
```

Commit attribution is conservative and proof-based. `state` may later become
`rewrite_pending` or `superseded` (with an incremented `version`) if history
changes - handle re-delivery idempotently via `x-tirion-event-id`.

---

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| Source shows `awaiting_receipts` / `restartRequired` | Restart your coding agent so it loads the new OTEL exporter. |
| No events reaching the sink | `tirionctl webhook status` - check `lastErrorCode`, `blockedCount`; then `tirionctl webhook retry`. |
| `tirionctl start` failed once | Re-run `tirionctl start` or `tirionctl restart`. |
| Stale events / want a clean slate | `tirionctl clear-agent-data --confirm`. |
| General health check | `tirionctl doctor` and `tirionctl logs`. |

Undo provider changes when you're done:

```bash
tirionctl configure restore claude-code
tirionctl configure restore codex
tirionctl configure restore cursor
tirionctl configure restore github-copilot
tirionctl stop
```
