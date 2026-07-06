# Tirion TUI

`tirion-tui` is Tirion's main Bubble Tea terminal interface for the local-only
agent. It connects to the same local `AgentClientGateway` endpoints as
`tirionctl` and renders privacy-safe status, repository, run, attribution,
webhook, budget, diagnostic, and supported harness readiness data.

The TUI can also activate explicitly chosen repositories through
`MeasurementActivation` and resolve Codex, Cursor, or Claude Code harness setup
issues through the agent's provider configuration APIs. It can set the local
webhook destination URL through the agent's webhook management API. It does not
scan the filesystem and keeps prompt, tool, and response content capture
disabled when enrolling a repository or repairing a harness setup.

## Build

```sh
cd packages/tirion-tui
go build ./cmd/tirion-tui
```

From the repository root, the equivalent command is:

```sh
npm run tui:build
```

## Run

```sh
./tirion-tui
```

From the repository root, after `npm run tui:build`, `tirionctl app` launches
the locally built TUI.

The TUI honors the same local environment variables as the TypeScript platform
package:

- `TIRION_AGENT_STATE_DIR`
- `TIRION_AGENT_RUNTIME_DIR`
- `TIRION_AGENT_SOCKET`

## Controls

- `1`-`7`: switch tabs
- `left`/`right`: switch tabs
- `up`/`down`: change selected row where a tab supports details
- `a`: enroll the current working directory from any tab
- `p`: enroll typed path(s) from any tab; separate multiple explicit paths with commas
- `d`: remove the selected repository from the Repos tab
- `c`: configure the selected Codex, Cursor, or Claude Code harness from the Harnesses tab
- `u`: restore Tirion-managed configuration for the selected harness from the Harnesses tab
- `w`: set or edit the webhook destination URL
- `enter`: submit enrollment or save the webhook URL while editing
- `y` or `enter`: confirm repository removal or harness configuration
- `esc`: cancel enrollment, removal, harness confirmation, or webhook URL editing
- `r`: refresh now
- `q` or `ctrl+c`: quit
