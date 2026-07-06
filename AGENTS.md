# Agent Instructions

## Construct-First Thinking

This project's engineering philosophy is construct-based JTBD design (see `constructs.md`). Construct-first thinking comes before any other step in solution design or architecture — including proposals, options, trade-off discussions, and exploratory "how should we approach X" questions, not only when starting a coded assignment:

1. Read `constructs.md` and identify the JTBD construct(s) the work touches before reasoning about implementation.
2. Apply the Construct Editing rules to decide the shape of the change before considering files or code:
   - Edit an existing construct if its JTBD just needs to work better.
   - Split into sub-constructs only if the JTBD needs new sub-jobs.
   - Add a new construct only for a genuinely new JTBD.
   - Remove a construct only when its JTBD is no longer needed by its parent or the project.
3. Keep the design inside the closest existing construct boundary unless the job itself has changed.
4. Cross-construct collaboration happens through contracts, events, or data models defined in the relevant `Primary code` — never hidden coupling.
5. If source architecture or construct ownership changes as a result, update `constructs.md` in the same assignment.

This is a TypeScript local agent and CLI for measuring reported AI coding-agent token usage from supported local telemetry and sending privacy-safe event data through outbound webhooks.

Useful commands:

- `npm run compile`
- `npm test`
- `npm run check`

Architecture anchors:

- `packages/agent/src/index.ts` composes the local agent runtime and wires constructs together.
- `src/types.ts` owns shared contracts between constructs.
- `constructs.md` maps the JTBD-led constructs to current source files and boundaries.

Keep cost values framed as estimates, keep privacy checks centralized in `PrivacyGuard`, and avoid storing prompt, response, tool argument, or file-content data.
