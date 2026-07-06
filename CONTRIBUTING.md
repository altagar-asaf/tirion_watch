# Contributing

Tirion is a source-preview local agent for supported AI coding telemetry. The
public product boundary is local agent, CLI, explicit repository watching, and
local webhook export.

Before proposing a change, read `constructs.md` and identify the construct your
work touches. Keep changes inside the closest existing construct unless the job
itself has changed.

## Development

Use Node.js 24 and Go 1.24 or newer.

```bash
npm ci
npm run check
```

The preview does not publish npm packages; work from source.

## Pull Requests

- Keep cost values framed as estimates from reported telemetry.
- Do not add prompt, response, tool argument, tool output, file content, diff,
  raw telemetry, or absolute-path storage.
- Add privacy regression tests for ingestion, classification, storage,
  diagnostics, support bundles, exports, and webhooks.
- Webhook payload changes must update contract tests and docs.
- Source architecture changes must update `constructs.md`.

## Certificate Of Origin

This preview uses Developer Certificate of Origin sign-off. Add a sign-off line
to commits:

```text
Signed-off-by: Your Name <you@example.com>
```

By contributing, you agree that your contribution is submitted under the
Apache-2.0 license.
