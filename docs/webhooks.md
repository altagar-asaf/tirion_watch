# Webhooks

Tirion emits privacy-safe JSON events to a user-configured webhook sink.

Configure delivery:

```bash
tirionctl webhook set-url http://127.0.0.1:8787/webhooks/tirion
tirionctl webhook enable-runs
```

Run lifecycle events are controlled by `enable-runs`. Commit attribution events
are always enabled for enrolled repositories and fire when Tirion has verified
attribution evidence.

## Delivery

Headers:

| Header | Meaning |
|---|---|
| `content-type` | `application/json` |
| `user-agent` | `tirion-agent/oss-local` |
| `x-tirion-event-id` | Stable event id. |
| `idempotency-key` | Same value as `x-tirion-event-id`. |
| `authorization` | `Bearer <token>` when configured. |
| `x-tirion-timestamp` | Unix seconds when HMAC is configured. |
| `x-tirion-signature-256` | `sha256=<hex>` HMAC signature when configured. |

HMAC signature input:

```text
HMAC_SHA256(secret, "<timestamp>.<raw-body>")
```

Delivery uses a durable local outbox with retry, lifecycle-first scheduling,
exact next-deadline wake-up, and a bounded request timeout. HTTP delivery
attempts for one terminal subject are serialized, and delivery re-reads the
current durable row before sending. Fresh queueing and delivery use point reads
and due-row selection rather than loading historical outbox payloads. Terminal
admission has a dedicated projection path: it never awaits outbound HTTP and
durably queues an eligible terminal even while a same-run update attempt is in
flight. That does not make same-run delivery concurrent. The live projection
lane processes lifecycle anchors before enrichment, and ordinary delivery
re-reads priority after each event so a newly queued start can preempt a stale
batch of updates from other runs. If that ordinary lane is waiting for one HTTP
response, one reserved bounded lane may deliver a due start, settling update, or
terminal for a different run. Exact in-memory event/run claims keep the two lanes
from duplicating an attempt or overlapping one run; forced retries never use the
  reserved lane. Lifecycle order describes receiver-visible HTTP deliveries, not
every durable outbox row. A successful terminal suppresses pending stale running
updates for that run, so queueing a snapshot does not promise it will be sent.
Normal completed lifecycle delivery retains an eligible `settling` update before
the terminal: `run.start -> delivered run.update(s) -> run.ended`.

Among fresh due lifecycle entries in both ordinary and bounded-bypass selection,
`run.start` ranks first. A fresh due trusted Claude Code closed-root terminal
ranks next, ahead of fresh `settling` updates from either the same or a different
run. It is limited to a terminal whose webhook `codingHarness` and runtime are
`claude-code`, `evidence.basis` is `root_span`, and `evidence.delayed` is
`false`; this fresh-entry priority does not change retry or blocked-delivery
policy. Within that terminal's own run, the public sequence is
`run.start -> optional delivered run.update(s) -> run.ended`. It does not
preempt an update HTTP attempt already in flight: it completes before the
terminal attempt. If the terminal attempt fails or retries, the pending settling
update remains a valid fallback; successful terminal delivery suppresses any
still-pending same-run update. All other completed lifecycles retain their
settling-update-before-terminal order. Receivers should dedupe by
`x-tirion-event-id` or `idempotency-key`.

Fresh completed-run corrections and evidence enrichment use a projection lane
independent from historical replay. Both lanes yield after every run and
re-select priority, so a slow historical projection cannot hold fresh terminal
meaning before it enters the outbox. Startup attribution reconciliation relies
on durable outbox recovery and bounded live recovery rather than replaying every
historical lifecycle. Commit reconciliation is coalesced on a separate lane;
even a full repository-history scan cannot occupy fresh or historical run
lifecycle projection.

An explicit terminal first assembles its authoritative correction from only the
root query family and linked child sessions, then atomically upserts that run.
This path is shared by Claude Code, Codex, Cursor, and GitHub Copilot and does not
wait for unrelated global usage or attribution reconciliation.

After a first terminal is delivered, a final-usage correction that still has an
unresolved subagent remains replaceable for at most 250 ms. A grouped activity
projection replaces and releases that same pending version immediately. If no
grouped projection arrives, the partial correction is delivered when the bound
expires.

Routine status and lifecycle-trace lookups are also scoped to the relevant
subject, trace, or session. Tirion keeps delivered history durable for explicit
retention and reconciliation without making a fresh run wait for it to be
deserialized.

## Event Types

Current schema version: `1`.

### Claude Code 2.1.201/2.1.207 correlation boundary

Claude request purpose is derived only through an exact metadata-only chain in
the current agent process: the `UserPromptSubmit` prompt/session anchors the
prompt log's trace, and that trace plus the API log's request identity joins the
matching LLM span. Exact `query_source=generate_session_title` is classified as
`auxiliary_session_title`; exact `query_source=sdk` is classified as customer
work. The accepted 2.1.201 failed-request fixture also classifies exact
`operation.name=generate_session_title` as auxiliary. Unknown or missing
purpose remains unclassified and counted; arbitrary operation names are
discarded. Conflicting prompt, session, trace, request, or purpose evidence
fails closed.

Tirion retains exact title-purpose usage in privacy-safe upstream atoms for
corroboration, then removes it before customer usage and every live lifecycle
snapshot. All log/trace copies of the same proven title request are excluded
from activity, tokens, models, context, and estimated cost. The request never
creates a separate public run. Unclassified usage is not guessed away.

The correlation maps are bounded and in-memory. They do not survive an agent
restart, so a join split across restart remains unclassified rather than being
reconstructed speculatively. The implemented boundary has native metadata-only,
focused deterministic, and fixed-binary Tirion-managed full-stack evidence for
the accepted non-interactive root slice. It does not establish restart-spanning,
interactive, recursive/nested-subagent, workflow/team, authenticated-MCP, or
broader auxiliary behavior.

### `run.start`

Emitted when Tirion has privacy-safe evidence that a run started in a watched
repository context.

Live starts retain the originating hook, span, event, or replay basis. If Tirion
first learns about the lifecycle from an authoritative completed run, the
retrospective start uses `evidence.basis: "usage_projection"` and
`evidence.delayed: true` rather than claiming that a prompt hook was observed.

Important fields:

- `schemaVersion`
- `eventType`
- `eventId`
- `runId`
- `traceIds`
- `repository`
- `codingHarness`
- `runtime`
- `startedAt`
- `state`

The first accepted prompt anchor fixes `startedAt` for the public lifecycle.
Delayed provider evidence may enrich the run but cannot rewind this timestamp.

Codex Desktop can invoke the same hook surface for ephemeral internal work,
including title generation. Tirion accepts a Codex `UserPromptSubmit` as a
public lifecycle anchor only when the hook includes the transient transcript
locator that identifies a persistent user or subagent turn. Transcriptless
internal hooks create only a durable opaque internal marker. That marker blocks
earlier or later hook, log, trace, restart, and attribution evidence for the
same query from becoming a public or production run. It carries no repository
binding. Tirion may use a valid locator transiently to derive opaque lineage,
but never stores or sends the path.

### `run.update`

Emitted when privacy-safe run activity changes before terminal completion.
It is a current, revisable snapshot of the evidence Tirion has accepted so far.
Numeric token fields are always present, but their completeness is described by
`coverage.usageCoverage`.

Important fields include:

- `updatedAt`
- `activity`
- token totals and `llmModels`
- `context` when reported token-footprint evidence is available
- `estimatedNanoUsd`, optional `usageValueNanoUsd`, `costEstimateBasis`, and
  `costCoverage`
- `evidence` and `coverage`

`usageValueNanoUsd` is a catalog-rate value for the observed usage, not a
claim about what the user was billed. It is independent of billed-cost
coverage: a catalog-matched subscription run update can include
`usageValueNanoUsd` while retaining `estimatedNanoUsd: 0`,
`costEstimateBasis: "unavailable"`, and `costCoverage: "unavailable"`. Tirion
omits the value when any usage-bearing component in the snapshot cannot be
valued; it never publishes a partial subtotal as the whole run's usage value.

Successive updates for one `runId` must not be added together. A receiver should
replace its current non-terminal snapshot when a later `updatedAt` arrives.
Stable request and activity identities let stronger revisions replace earlier
evidence without counting both. If one provider envelope yields distinct
meanings at the same source time, Tirion advances `updatedAt` by a logical
millisecond beyond the durable delivered high-water; `evidence.observedAt`
retains the actual source timestamp.

Running updates are content-addressed and delivered immediately. A
completed-run update with `state: "settling"` uses one replaceable outbox slot
until the terminal deadline. This lets a provider root/turn authority replace
provisional request-slice totals before the ordered settling update is sent.
After successful terminal delivery, a pending stale running snapshot is
suppressed rather than sent; lifecycle order therefore constrains delivered
snapshots, not every queued row.
The trusted Claude Code closed-root exception described in [Delivery](#delivery)
is the only case where an unsent settling update is optional before the first
terminal.

When multiple repositories are watched, a trusted observation-level
`repositoryKey` remains the direct routing path. An unkeyed observation may
contain records from several concurrent harness sessions, so Tirion partitions
its normalized records by exact opaque query/session linkage to an existing
live run. The same linkage is recoverable from durable query occurrences after
an agent restart. A record with missing or conflicting repository identity is
blocked individually; Tirion never assigns the whole mixed batch to whichever
repository happens to be active, and an unrelated unknown record cannot
suppress an exactly bound run update.

### `run.ended`

Canonical terminal event for a completed run.

For ordinary Claude Code completion, a `Stop` hook is a candidate rather than a
terminal by itself. The same opaque prompt/session must also produce a matching
closed root `claude_code.interaction`. A nonempty `background_tasks` or
`session_crons` collection makes the Stop nonterminal, and
`stop_hook_active` is diagnostic metadata rather than authority. Either surface
alone, or a pair separated by an agent restart, fails closed without emitting a
Claude terminal. An exactly matched non-blockable `StopFailure` remains the
separate provider-terminal failure path. Claude `SessionEnd` is configured only
as a diagnostic surface: it has session scope rather than a prompt identity and
also fires for clear, resume, logout, and session-switch flows. Tirion retains
at most its safe event category and allowlisted normalized reason in local
diagnostics; it never treats that hook as a terminal or dispatches it.

Important fields include:

- `endedAt`
- final token counts,
- `llmModels`,
- `filesChanged`,
- `activity`,
- `estimatedNanoUsd`,
- optional `usageValueNanoUsd`,
- `costEstimateBasis`,
- `costCoverage`,
- optional `outcome`,
- `state`.

`state: "completed"` means the run lifecycle ended; it does not imply that the
work succeeded. `outcome` is present only when provider evidence proves
`success`, `failure`, or `unknown`. When it is absent, receivers must preserve
the outcome as unavailable rather than infer success. A proven failure is
monotonic across corrected higher terminal versions.

A terminal rebuilt from durable provider evidence uses `evidence.delayed: true`.
Its timing can still be high-confidence when Tirion retained the original
provider terminal timestamp. An outcome-backed delayed terminal with no usage
reports `coverage.usageCoverage: "none"`; this is unavailable usage, not zero
provider-reported consumption.

`filesChanged` values are repo-relative paths only. Ordinary durable or
correction lifecycle and commit projections require retained bounded
`{ artifactKey, executionNodeId }` evidence, revalidated against the exact
same-query/repository durable execution node. That node must contain the exact
artifact and be a successful allowlisted provider semantic-write tool node; a
missing, malformed, or unreadable proof fails external file and commit
projection closed. A grouped activity result or generic causal-key set cannot
bless another artifact, and a file merely changing during the same time window
is not enough. Snapshot continuity can still support later commit attribution.

The sole live provisional exception is direct retained source-node proof: that
same successful allowlisted semantic-write node supplies the artifact key. It
never accepts an unpaired raw key, generic causal-key set, or grouped activity
outcome. A late exact native decision may source-prune only its matching
provisional activity/file proof during the 15-second retention and then issue
a higher terminal version; an active version may already have been sent.
Historical internal allocation revokes only with a complete census containing
`nativeRejectedCausalWriteArtifacts`; missing, empty, or unreadable marker
evidence does not revoke allocation or an independently valid sibling writer.
Codex `apply_patch` targets are parsed transiently from `tool_input.command`;
command, patch, and file content are discarded before persistence.

The first terminal event is delivered at a fixed deadline derived from trusted
explicit completion when available, otherwise authoritative completion (three
seconds by default). Delayed telemetry cannot slide that deadline. An explicit
terminal event is a timely provisional snapshot and has non-final coverage
(`none`, `partial`, or `complete_so_far`) unless every usage-bearing query has
already supplied a closed authoritative turn/run boundary. In that case the
live terminal may state `final`, and any optional context carries the same
coverage. The completed-run projection can still improve grouped activity or
workspace evidence through a higher version.

`final` describes the closed authority represented by that version; it is not
an immutability promise. Late-delivered evidence that began on or before the
same completion boundary can publish a higher complete replacement, including
revised usage, without reopening `run.update` delivery.

For Claude Code, the exact eligible Stop/matching closed-root interaction join
immediately triggers query-family terminal projection; ordinary Stop alone
remains nonterminal. This path does not wait for the global usage quiet window
or an outbound update response. It persists the terminal outbox row while any
same-run update attempt is in flight. Only the trusted closed-root form with
webhook `codingHarness`/runtime `claude-code`, `evidence.basis: "root_span"`,
and `evidence.delayed: false` gets fresh due selection precedence after starts,
ahead of fresh settling rows from the same or another run in ordinary and
bounded-bypass lifecycle selection. An in-flight same-run update completes first;
a failed/retrying terminal retains the settling fallback, while successful
terminal delivery suppresses any remaining same-run update. Other Claude terminal
evidence retains the normal settling-update-before-terminal order.

For linked subagents, Tirion keeps one public root lifecycle. Child prompts,
tools, usage, and closed child turns revise that root's accumulated snapshot,
but they do not emit another `run.start` or end the root. If a harness omits its
Stop hook, only the public root query's closed explicit authoritative turn/run
trace can supply `root_span` terminal evidence; an individual model response
cannot.

Usage authority remains scoped to the provider's original query identity while
that root lifecycle is assembled. A child turn authority can replace the
child's request slices, but never the root's request slices. Tirion projects
each linked query independently, then adds their activity and token vectors at
the public root-run boundary.

LLM and unallocated aggregate activity IDs remain stable within each
query/session authority scope. As requests accumulate or a closed turn replaces
their usage, pending terminal refreshes replace the same aggregate row rather
than retaining historical tokenless copies with stale counts.

When a provider reports a child prompt in parent-session context, Tirion uses
only opaque child and parent session identities to bind it immediately. Raw
transcript locators remain transient and are never included in the webhook. A
durable child anchor found while earlier OTLP evidence is being projected is
resolved through that parent link; provisional child state remains private
until an actual public `run.start` exists and is reparented if the link arrives
later, but only before any child or parent terminal is selected, reserved,
queued, or delivered. After that boundary, Tirion retains the child subject for
its correction route.

The grace period is measured from the terminal evidence timestamp, not from
when projection or queueing finishes. Empty `filesChanged` does not add another
grace period, and a correction produced after the deadline is immediately
eligible for delivery.

After a non-final first terminal is delivered, Tirion retains its live identity
for a bounded 15-second correction horizon. A late closed root turn/run boundary
can therefore emit a corrected terminal immediately without publishing a
post-terminal `run.update`. Final usage releases live webhook mappings
immediately, but a separate opaque session/query/completion-boundary correction
marker remains for that bounded horizon. A late exact native decision matches
by `invocationId` whenever either source has one, with request identity only
when both invocation IDs are absent. It may source-prune only its matching live
provisional activity/file proof; authoritative grouped activity still waits for
the completed-run rebuild. This bounded correction can follow an active first
delivery rather than prevent it. Other eligible late pre-boundary evidence can
also publish a higher terminal replacement without reopening updates; a run
that receives no correction is released when the horizon expires.

Each explicit completion also schedules a query-scoped terminal projection at a
fixed offset from that run's completion. It reads only the root and recursively
linked child query family and atomically updates that completed run. The ordinary
global projection quiet period may move while other harness sessions continue
producing telemetry, but it cannot postpone this terminal reconciliation. If a
closed authoritative boundary arrives for the recently terminal session first,
Tirion projects that family immediately. A Claude closed root that completes its
exact Stop join uses this immediate path rather than waiting for the ordinary
global quiet period.

Later authoritative telemetry may correct usage, activity, terminal timing,
models, estimated cost, or workspace evidence. Tirion emits that changed
meaning as a higher `version` for the same `runId`; corrections may move numeric
values down as well as up. The first published `startedAt` remains immutable
across versions. Each version has its own idempotent `eventId`.

The delivered-update high-water governs successive non-terminal `run.update`
snapshots; a `run.ended` event replaces that running snapshot. In particular,
`costCoverage: "complete"` on a running update describes the usage selected at
that moment. A later preferred provider surface can expose requests whose
matching provider-reported cost has not arrived yet, so a terminal may retain
the same token vector while changing the estimate and honestly reporting
`costCoverage: "partial"`. Receivers should use the terminal's
`costEstimateBasis` and `costCoverage`, never merge its cost with the update.

Terminal meaning is hashed from canonical JSON with `eventId` and `version`
excluded. Object-key insertion order therefore cannot create a false semantic
revision, while a real change remains deliverable.

Receivers must retain the highest terminal version and replace the complete
prior terminal snapshot. They must not merge or sum terminal versions.

### Activity Integrity

`activity` uses one provider-neutral shape for every supported coding harness.
Rows can represent an individual observation or a grouped terminal breakdown.

| Field | Meaning |
|---|---|
| `kind` | `llm_request`, `tool`, `skill`, `subagent`, `mcp`, `hook`, or `unknown`. |
| `parentActivityId` | Parent subagent activity for a nested child row, when provider linkage is unambiguous. |
| `count` | Number of privacy-safe observations represented by the row. |
| `failureCount` | Represented observations that failed or were rejected. |
| `rejectedCount` | Exact native permission rejections represented by the row; when present, it is a subset of `failureCount`. |
| `unknownCount` | Represented observations whose native outcome was unavailable. |
| `outcome` | `success` only when every represented observation is known success; `rejected` only when every one is an exact rejection; `failure` when all are non-success and at least one is a generic failure; otherwise `unknown`. |
| token fields | Usage attributed to this row from captured telemetry. |
| `usageAttributionBasis` | `provider_reported`, `trace_descendant`, `activity_only`, or `unavailable`. |
| `usageCoverage` | `complete`, `partial`, or `unavailable` for this row's token attribution. |
| `evidence` | Safe source, timing, profile, and confidence metadata. |

Final grouped completed-run activity uses `evidence.basis: "usage_projection"`.
`usageAttributionBasis` separately states whether that row's tokens came from
provider-reported or descendant-trace evidence. A provisional terminal instead
uses the direct safe live activity and explicit terminal evidence available at
its deadline. This avoids presenting a derived terminal row as though Tirion
directly observed a hook or span for it.

For an exact Claude permission decision, Tirion keeps separate opaque decision
evidence. It matches ordinary evidence only with the same provider/query/tool
kind/name and exact safe invocation identity: `invocationId` whenever either
source supplies it, otherwise request identity only when both lack one. A
validated native rejection carries decision timing and outcome only; it owns no
usage, accounting, context, execution, or lifecycle authority and cannot
inherit duration, result, audit, or causal-artifact evidence. During the
retained live correction horizon it source-prunes only the matching provisional
activity/file proof. A durable grouped activity changes only through the
authoritative completed-run rebuild, never a direct broad prune.

When the completed-run projection supplies a grouped kind/name already present
in a provisional or older terminal snapshot, the grouped row replaces those
rows. Its `count`, `failureCount`, and (when present) `rejectedCount` cover the
represented calls; Tirion does not add the direct and grouped views together
across terminal versions. A row is `rejected` only when every represented call
is an exact rejection; a group that also contains an execution failure remains
`failure` rather than claiming every failure was a rejection.

When provisional LLM rows and an authoritative same-name subagent aggregate
carry the same usage, Tirion treats them as two views of the children only when
the live terminal contains the complete child count and one unique bounded
subset of LLM rows reproduces input, output, cache-read, cache-creation,
reasoning, and total usage exactly. Exact parent links outrank timing
corroboration. The grouped subagent retains the tokens; nested LLM trace rows
retain safe evidence and `parentActivityId` without token fields. Equal totals,
partial child linkage, or more than one matching subset remain unverified.
Once this exact reconciliation has established `trace_descendant`/`complete`, an
equivalent later projection with the same child identity and token vector keeps
that verified basis. Replaying an already-normalized tokenless child LLM row does
not downgrade the subagent or create another terminal version. Alternating live
and grouped snapshots are also monotonic: once a grouped semantic row exists,
later direct rows with the same kind/name may corroborate it but cannot replace
it or reintroduce a duplicate lower-authority row.

Some providers deliver cumulative parent-plus-child usage after a tokenless
child trace. Tirion partitions that cumulative LLM row only when the final
one-child subagent vector plus the final unallocated vector exactly reproduces
input, output, cache-read, cache-creation, and reasoning usage. The child trace
is nested without tokens, while the cumulative LLM row retains the exact parent
residual. If any dimension or lineage is ambiguous, Tirion leaves the grouped
breakdown and unallocated accounting intact.

When exact child lineage has reconciled the complete child set and exactly one
unclaimed root LLM aggregate remains, the authoritative unallocated residual
replaces that root aggregate's provisional request usage. This removes the
generic unallocated row without inventing attribution. If either lineage or the
root candidate is ambiguous, the usage remains unallocated.

For a new `run.ended` projection, activity token fields reconcile to the
top-level run token fields. Usage that cannot safely be assigned to a reported
tool, skill, subagent, MCP call, or LLM request is emitted as `kind: "unknown"`
with `name: "Unallocated run usage"`. This accounting row prevents silent loss
without inventing attribution.

An optional context footprint is published only at the coverage stated by that
snapshot. If final usage arrives from a surface that cannot finalize an older
provisional context footprint, the corrected terminal omits `context`; it does
not promote the provisional footprint or suppress the correction.

Hook and trace records that share the same safe request or child-session
identity represent one logical activity. Tirion merges the corroborating
records, preserves failure evidence, and does not increment `count` twice.
Provider implementation spans without explicit activity or usage evidence are
not customer-visible work. In particular, a Codex model label alone does not
turn startup, persistence, response-plumbing, or transport records into extra
LLM rows, and tool-dispatch internals do not become extra tool rows. A cumulative
Codex turn span remains a token-usage authority but is not counted as another
LLM request; request rows come from actual request evidence.

Tool names that happen to mention an agent are not sufficient subagent evidence.
Spawn, wait, and similar orchestration controls remain `tool` rows unless the
provider supplies an explicit child/subagent field or a fixture-backed native
subagent operation. When exact child lineage and reconciled descendant usage
are present, the subagent row reports
`usageAttributionBasis: "trace_descendant"` and `usageCoverage: "complete"`;
otherwise its lower coverage remains visible.

Providers may also report the same request as a trace `event` under an internal
fragment query and as a log `request` under the public query. Tirion treats the
event as corroboration only when provider, every token dimension, billing
context, model when present, completion time, and distinct source/signal match
unambiguously. Equal or ambiguous records remain separate and visible to
conservative accounting.

`resultSizeBytes` and `providerReportedResultTokens`, when present, are numeric
metadata only. Tirion never sends the corresponding tool result or content.
For Codex, a stable `codex.tool_result.call_id` corroborates request identity and
explicit tool-protocol failures. Codex unified-exec protocol success does not
prove a zero shell exit, so an unstructured `PostToolUse` shell response is
reported as `unknown`; only a native structured exit code or status can claim
shell success or failure. Request-level merging preserves one tool row and one
count, missing or ambiguous call IDs fail closed, and response text is never
parsed for an outcome.

## Receiver State Rules

1. Dedupe deliveries by `eventId` or `idempotency-key`.
2. Use `runId` as the public lifecycle subject.
3. Treat each `run.update` as a replacement snapshot, ordered by `updatedAt`.
4. Treat each `run.ended` version as a complete replacement snapshot and retain
   the highest `version`.
5. Never sum updates, terminal versions, or an update with its terminal event.
6. Use `coverage`, row-level `usageCoverage`, and `evidence` when presenting how
   authoritative a fact is.

### `commit.attributed`

Emitted when Tirion conservatively verifies that one or more watched runs are
associated with a real git commit.

Important fields:

- `commitSha`
- `runIds`
- `traceIds`
- `estimatedNanoUsd`
- `costCoverage`
- `state`
- `version`
- `firstVerifiedAt`
- `updatedAt`

Commit events may be re-delivered with a later `version` if attribution state
changes, for example `rewrite_pending` or `superseded`. If an existing active
event later loses exactly the proof pruned by a native decision, its later
version is `superseded`; Tirion does not create a new unrelated event or remove
an independently valid sibling writer. The active version can precede that
superseding correction in source-arrival order.

## Privacy Exclusions

Webhook events must not contain prompts, responses, tool arguments, tool
outputs, file contents, diffs, raw telemetry payloads, credentials, absolute
paths, or transcript paths.
