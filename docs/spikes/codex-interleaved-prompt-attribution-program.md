# Codex Interleaved Prompt Attribution Program

Status: kickoff prompt prepared; implementation has not started.

Baseline: `8ef0ec1` (`Harden coding-agent observability integrity`), merged to
`main` on 2026-07-17.

Working branch: `codex/codex-interleaved-prompt-attribution`.

## New Task Kickoff Prompt

Your task is to make Tirion attribute every accepted Codex usage slice,
activity, lifecycle event, token, context measurement, estimated cost, catalog
usage value, and causal-write claim to the correct original user prompt. This
must remain correct when a user submits several prompts in one Codex session,
submits prompts concurrently in several Codex sessions, launches children from
interleaved prompts, and telemetry arrives late, duplicated, out of order, or
across a Tirion restart.

Work on this branch:

```text
codex/codex-interleaved-prompt-attribution
```

Use merged revision `8ef0ec1` as the implementation baseline. Confirm the
revision before editing. Record the installed Codex version and relevant source
profile versions in the outcome report; do not assume the provider version from
an older fixture or live run.

Do not discard or rewrite the accepted observability work, reopen CC15, weaken
Claude Code integrity, or infer unsupported Codex behavior merely to make an
acceptance case pass.

### Required reading

Before proposing or editing implementation, read these files completely:

- `AGENTS.md`
- `constructs.md`
- `docs/spikes/codex-interleaved-prompt-attribution-program.md`
- `docs/spikes/claude-code-integrity-observability-program.md`
- `docs/spikes/claude-code-integrity-observability-outcome.md`
- `docs/spikes/webhook-lifecycle-optimization.md`
- `docs/harness-run-monitoring.md`
- `docs/webhooks.md`
- `docs/release-checklist.md`

Then inspect the current contracts, classification, storage, projection,
lifecycle dispatch, attribution, tests, and retained native fixtures, especially:

- `packages/agent-contract/src/index.ts`
- `packages/engine/src/telemetryClassification.ts`
- `packages/engine/src/shadowUsage.ts`
- `packages/agent/src/productionUsageService.ts`
- `packages/agent/src/externalWebhookDispatch.ts`
- `packages/agent-storage/src/index.ts`
- `packages/agent-storage/src/worker.ts`
- `packages/agent/src/productionRunAttribution.ts`
- `src/attribution/agenticWorkEpisode.ts`
- the corresponding test suites and local harnesses

Create and maintain an evidence-backed outcome report at:

```text
docs/spikes/codex-interleaved-prompt-attribution-outcome.md
```

Separate source evidence, design decisions, deterministic results, live results,
and remaining limitations. A provider behavior is accepted only when supported
by an official contract, a retained versioned native fixture, or a disposable
metadata-only native census. Never retain raw telemetry to make the case easier.

## Mission

One public Tirion Codex run represents one original customer prompt plus only
those descendant turns whose exact provider identity proves that they belong to
that prompt.

Consequently, several customer prompts must remain several public roots,
including:

- two or more prompts in the same Codex session;
- concurrent prompts in different Codex sessions;
- prompts using the same repository, model, wording, and similar timestamps;
- prompts whose children start and finish in interleaved order;
- a new prompt submitted while an earlier prompt remains open;
- a new prompt submitted after an earlier prompt terminalizes.

The task is not complete merely because usage-only satellite runs are hidden.
It must establish correct positive attribution to the right original prompt and
correct fail-closed behavior whenever exact attribution is unavailable.

## Construct-first boundary

This is an improvement to existing JTBDs, not a new product JTBD:

- `RunCorrelationLedger` owns durable privacy-safe prompt identity and exact
  parent/child lineage.
- `TelemetryClassification` extracts fixture-backed provider facts and safe
  opaque identities. It must not group, price, or guess attribution.
- `UsageProjection` selects authoritative usage and folds exact descendants
  once.
- `RunLedger` persists authoritative prompt-root runs.
- `ExternalWebhookDispatch` publishes the root lifecycle chosen by the shared
  correlation decision. It must not implement a looser parallel resolver.
- `AgenticWorkEpisode` may group repository work for conservative commit
  attribution, but it must never collapse independent customer prompts merely
  because they share an exec, session, repository, timestamp, or episode.
- `PrivacyGuard` remains the only durable-content and outbound policy boundary.
- `Diagnostics` reports safe unresolved or conflicted states without creating
  attribution authority.

Do not add a construct unless construct-first review proves a genuinely new
JTBD. If construct ownership changes, update `constructs.md` in the same change.

## Exact identity and lineage

Treat a prompt identity as the exact composite tuple:

```text
(provider, opaque native session identity, opaque native turn/query identity)
```

A session is a routing and validation dimension. It is never a run identity and
never a parent selector. Preserve the existing public run-ID contract where it
is compatible. If current `queryId` is derived from the native turn, add and
validate its exact session binding and define an explicit migration policy
before changing stable public identity.

A descendant may fold into a root only through a durable exact chain equivalent
to:

```text
exact parent query/session
  -> exact provider child/agent identity
  -> exact child session
  -> exact child query/session
```

Design the smallest explicit contract that preserves this proof across
projection and restart. Prefer a versioned `QueryLineageEdgeV1`, or a rigorously
equivalent durable lineage record and direct lookup index, containing only
opaque identifiers and bounded safe enums.

At minimum, exact lineage must retain:

- provider;
- parent query and session identity;
- child query and session identity where proven;
- exact provider child/agent identity where it is part of the proof;
- allowlisted evidence basis;
- first/last observation timing needed only for completion-boundary validation;
- `exact`, `unresolved`, or `conflicted` state;
- a monotonic conflict witness.

One child can have at most one exact parent. A second parent claim, incompatible
session binding, provider mismatch, repository conflict, or cycle makes the
lineage conflicted. Later single-parent evidence must not erase that conflict.

Verify rather than assume what `SubagentStart.turn_id` means in the installed
Codex version. Prefer an exact Agent/PostToolUse response bridge, agent ID,
child-session ID, explicit turn ID, or documented trace edge. If Codex does not
expose sufficient evidence, retain the work as unresolved.

## Non-negotiable integrity invariants

1. Every accepted customer `UserPromptSubmit` with exact persistent-turn
   authority creates one and only one candidate public root.

2. Two distinct prompt tuples are distinct roots even when they share a
   session, repository, model, prompt digest, timestamps, episode, or totals.

3. Separate sessions never merge without an exact provider-reported lineage
   edge. Repository equality and overlapping time are not lineage.

4. A descendant with a complete exact chain folds recursively into its original
   root exactly once and never publishes another lifecycle.

5. An unanchored usage fragment, title/auto-review operation, internal desktop
   operation, or incompletely linked child remains internal or unresolved. It
   creates no `ProductionRun`, webhook lifecycle, budget warning, commit
   attribution, or prompt-level cost/value claim.

6. Never select a parent from the current or latest run, latest prompt in a
   session, parent session alone, timestamp proximity, repository, model,
   prompt text/digest, equal token totals, work episode, or an open lifecycle.

7. Resolve explicit turn/query identity first. Session-only evidence may enrich
   a prompt only when a versioned fixture-backed provider contract proves unique
   prompt scope. Otherwise it cannot start, parent, complete, reparent, or
   attribute a public run.

8. Preserve multiple bounded recent/open prompt identities per session. A new
   prompt must not erase identity needed by delayed telemetry for an older one.

9. Missing or ambiguous evidence fails closed. Wrong-root attribution is worse
   than temporary prompt-level under-reporting. Keep bounded safe unresolved
   aggregates for diagnostics so observed usage does not silently disappear.

10. Promote unresolved work only after later exact evidence completes one
    unambiguous chain. Promotion is durable, idempotent, and restart-safe.

11. Once a public terminal route is selected, queued, or delivered, do not move
    it to another root. A late conflict freezes enrichment and emits a safe
    diagnostic; it never silently reparents published history.

12. Exact evidence that began no later than the root completion boundary may
    publish an eligible higher terminal replacement. Post-boundary evidence may
    not increase the root, and no `run.update` may reopen after a terminal.

13. Select every usage slice once. A root plus exact descendants conserves
    input, output, cache-read, cache-creation, reasoning, and total tokens.
    Context request counts, peaks, chronology, and coverage use the same links.

14. `usageValueNanoUsd` and `estimatedNanoUsd` follow the same selected usage
    and ownership boundary. Usage value remains distinct from expected billed
    cost. Partial or unvalued components cannot produce a misleading complete
    subtotal.

15. Activity, failure, rejection, causal-write, and commit evidence remain on
    their exact query. Folding cannot turn `unknown` into success or authorize a
    file from timing or repository overlap.

16. Accepted Claude Code behavior must remain unchanged. Shared code may be
    strengthened, but Codex assumptions must not leak into Claude Code, Cursor,
    or GitHub Copilot semantics.

## Current gaps to prove against the baseline

Begin by verifying each of these against `8ef0ec1`; do not assume this list is
exhaustive:

- `TelemetryClassification` keeps one active Codex query per session and can
  discard an older prompt when a newer prompt starts.
- Some Codex subagent hook routing selects the remembered query for a reported
  session instead of resolving an exact parent turn.
- `QueryOccurrenceV1` retains `parentSessionId` but no durable exact
  parent-query edge or monotonic lineage-conflict state.
- Query occurrence merge can prefer an incoming `parentSessionId` without
  retaining a conflict witness.
- `ProductionUsageService.queryOccurrenceFamily()` chooses the latest earlier
  occurrence in a parent session and expands through session sets.
- The production usage pipeline admits every non-Claude projection, which can
  promote unanchored Codex usage to a public run.
- Completed-run webhook visibility treats a missing Codex occurrence as visible
  unless explicitly internal.
- Live lifecycle routing contains active-session and latest-session fallbacks.
- Completed Codex lifecycle projection may use `AgenticWorkEpisode` as a public
  subject fallback. That is valid only for turns proven to belong to one root;
  it must never merge independently anchored prompts.
- Existing tests do not establish adversarial same-session interleaving.

## Required implementation qualities

- One shared lineage/root-eligibility resolver must be consumed by production
  usage projection, query-family projection, live routing, completed dispatch,
  budget inputs, and attribution boundaries.
- Durable storage must support direct exact lookup by query and child lineage
  identity. Do not replace a time join with an unbounded historical scan.
- Conflict and identity authority are monotonic across upsert, replay, and
  restart.
- Legacy rows lacking exact lineage are not backfilled from timestamps. Preserve
  already published immutable history, but do not create new guessed roots.
- Historical webhooks are not retracted or silently rewritten. Apply stricter
  eligibility prospectively and document the migration boundary.
- Diagnostics use bounded safe reasons such as `codex_root_anchor_missing`,
  `codex_parent_unresolved`, `codex_lineage_conflict`,
  `codex_session_binding_conflict`, `codex_cycle_detected`, and
  `codex_late_edge_outside_boundary`.
- Long-run performance must remain operational: ingestion acknowledgment, live
  projection, terminal admission, and webhook delivery remain independent
  scheduler lanes, with no unbounded lineage scan on a hot path.

## Privacy boundary

Never persist or dispatch prompt/response text, prompt digests as user-facing
identity, tool arguments/results, commands/output, file content, diffs,
transcript paths, absolute paths, raw telemetry, credentials, or connector data.

Native IDs and transcript locators may be used only under the existing bounded
privacy contract. Persist derived opaque identifiers and allowlisted metadata.
Run privacy canaries against the database/WAL, structured logs, diagnostics,
exports, webhook receiver, and acceptance artifacts.

## Deterministic acceptance matrix

Build adversarial tests before enabling public behavior. At minimum cover:

1. Prompts A and B share a session. A launches a child, B starts before it
   finishes, and A's child finishes after B. The child belongs only to A.
2. Two prompts in one session launch children concurrently; completions and
   terminals arrive in opposite orders. Each root remains separate.
3. Three concurrent sessions use the same repository, model, harmless wording,
   and overlapping timestamps. No cross-session fold occurs.
4. Child usage arrives before its parent edge. It remains private, then folds
   once only after the exact edge is proven.
5. Parent-first, child-first, delayed, duplicate, and out-of-order delivery
   converge to the same result.
6. Restart between evidence halves recovers durable exact evidence; incomplete
   evidence remains unresolved without guessing.
7. Two roots claim one child session. The conflict is durable and neither root
   receives the child.
8. One turn appears with conflicting session binding. It cannot merge,
   complete, or revise either root.
9. A session-only Stop, usage event, or subagent event arrives while two prompts
   are eligible. It selects neither current nor latest prompt.
10. A second customer prompt in the same session creates a second root whether
    the first root is open or terminal.
11. One root has exact children plus title, auto-review, startup, and other
    usage-only satellites. One public root exists; children fold; satellites do
    not publish.
12. One `AgenticWorkEpisode` contains two independently anchored prompts. It may
    retain conservative repository evidence but remains two lifecycles.
13. Late exact pre-boundary child evidence may produce a higher terminal;
    post-boundary work does not fold and no update follows terminal.
14. Replay does not duplicate tokens, activity, starts, updates, terminals,
    costs, values, or lineage.
15. Root plus exact descendants conserves every token dimension, context,
    activity ownership, cost estimate, and usage value. Unresolved residuals
    remain explicit and unattributed.
16. Repository conflict blocks only the affected record and cannot contaminate
    a correctly bound concurrent prompt.
17. Existing Codex and Claude lifecycle, child, auxiliary-title, value/cost,
    attribution, queue-ordering, and privacy suites remain green.

## Rollout and live acceptance

Do not request operator live testing until deterministic tests, compile, and
focused integrations pass.

First run the new resolver in observe-only mode. Replay a privacy-safe fixture
representing the accepted `CDVALUE1` shape and require it to preserve the one
anchored root and its exact children while suppressing only the six unanchored
satellite lifecycles. Do not use raw prompt or transcript content.

Then request a controlled live Codex acceptance in the watched
`tirion_local_log_server` repository:

- two lengthy prompts interleaved in one Codex session;
- a third lengthy prompt concurrently in another session;
- distinct non-secret child structures whose identities can be verified without
  capturing prompt text;
- children finishing out of order;
- one planned Tirion restart at a proven deterministic evidence boundary;
- the local webhook receiver online, with the dashboard optional.

Acceptance requires exactly three public run IDs, one ordered
`run.start -> run.update* -> run.ended` lifecycle per prompt, no child/satellite
lifecycle, no cross-root token/activity/context/cost/value/file/terminal
contamination, exact conservation for proven descendants, safe unresolved-only
diagnostics, unique event IDs, no post-terminal update, zero queued/blocked
events after fixed-point drain, healthy restart, and clean privacy scans.

If native evidence cannot prove an intended child edge, retain the fail-closed
unresolved result. Never weaken production matching to make the fixture pass.

Roll out in this order:

1. add exact lineage and eligibility in observe-only mode;
2. compare old and proposed root decisions on deterministic replay;
3. require every preserved root and suppression to have a fixed safe reason;
4. enable the stricter gate prospectively for new production projection;
5. do not delete or reparent already delivered webhooks;
6. run live multi-session acceptance and the full release E2E suite;
7. record accepted scope and remaining limitations in the outcome report.

## Verification and completion

Run focused tests throughout implementation, followed by at least:

```bash
npm run compile
npm test
npm run check
git diff --check
```

Also run the relevant deterministic lifecycle/privacy harnesses and the live
webhook gate described above. Do not commit or push implementation until the
worktree is reviewed and the outcome report distinguishes deterministic proof,
live proof, and unsupported behavior.

The project is complete only when Tirion proves both statements:

1. Every folded Codex child or usage slice belongs to that exact original
   customer prompt.
2. When Tirion cannot prove the correct original prompt, it publishes no
   prompt-level attribution instead of selecting a plausible root.
