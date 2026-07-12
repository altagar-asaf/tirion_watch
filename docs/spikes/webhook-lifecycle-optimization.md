# Webhook Lifecycle Optimization Spike

Date: 2026-07-10

Branch: `codex/webhook-lifecycle-optimization-spike`

Baseline: `6c6c665` (`Fix Codex webhook delivery after late repo evidence`)

## Goal

Make canonical `run.start`, `run.update`, and `run.ended` webhooks faster,
more reliable, and more accurate across Claude Code, Codex, Cursor, and GitHub
Copilot without adding harness-specific webhook formats.

This spike keeps the local-only boundary, watched-repository eligibility,
central `PrivacyGuard` validation, and fail-closed repository binding.

## Outcome

The spike began as dispatch optimization, then a real deep Codex run exposed
source, correlation, completion, and attribution defects upstream of dispatch.
The resulting branch repairs those defects at their owning constructs:

1. Live lifecycle work has an independent scheduler lane, exact terminal
   wake-up, lifecycle-first outbox priority, and a bounded HTTP attempt.
2. Managed Codex setup now enables `features.hooks`; Claude, Codex, and Cursor
   use explicit prompt/Stop and subagent start/stop lifecycle surfaces.
3. A model `response.completed` is no longer terminal. Explicit Stop/session
   hooks or a closed authoritative root/turn span end a hook-anchored run.
4. Workspace context is resolved transiently to an opaque watched-repository
   key before persistence, including direct OTLP and Copilot span DB replay.
5. Stable request and child-session identities reconcile hook/trace evidence,
   recursively fold linked child runs into one root exactly once, and preserve
   activity parentage.
6. Codex per-response usage slices accumulate once, while its closed cumulative
   turn trace supersedes those slices. This matches the Codex rollout ledger.
7. Run-level files require causal successful-write artifact keys. Temporal
   snapshot overlap remains commit evidence but cannot claim run authorship.
8. Codex activation now probes provider hook state and reports untrusted,
   disabled, or unavailable trust status instead of claiming source readiness.
9. The first prompt anchor fixes lifecycle `startedAt`; delayed evidence cannot
   rewind an already-published run identity.
10. Internal Codex persistence, response-plumbing, and dispatch spans are not
    exposed as customer LLM/tool activity without explicit model or usage
    evidence.
11. Completed-run `settling` updates use one replaceable slot until a fixed
    three-second terminal deadline, allowing turn/root authority to supersede
    provisional request slices without delaying live updates.
12. Terminal queue/delivery is serialized per run, semantic hashes canonicalize
    object keys, and every timer wake re-arms the next durable outbox deadline.
13. Execution-node evidence is query-addressable and bounded by age/count;
    startup removes oversized legacy snapshots before runtime projection can
    clone them into memory.
14. Durable outbox reads use exact-row and due-row storage queries. Fresh
    lifecycle queueing no longer deserializes the historical delivery backlog.
15. A bounded dirty-worktree snapshot is marked partial and fails closed as a
    commit-attribution baseline. It may still provide positive evidence for
    captured artifacts, but omitted paths are never treated as unchanged.
16. Codex child hooks that report the parent session are reconciled to the
    actual rollout session from transient transcript identity while retaining
    only an opaque parent-session link. Nearby fallback prompt events and
    delayed hooks become one query, linked child sessions reuse the public root
    lifecycle before SubagentStart arrives, and a closed child turn cannot end
    it. Later OTLP evidence cannot downgrade submission-hook authority.
17. Durable prompt lookup resolves a child through its opaque parent session
    instead of manufacturing a public child subject. A public outbox start, not
    an in-memory timestamp, gates updates and terminals; provisional child state
    can be reparented when linkage arrives late.
18. Exact trace-event and log-request token vectors from different query aliases
    are treated as corroboration only when source, signal, provider, billing
    context, model when present, and completion timing agree unambiguously.
19. A non-final first terminal retains live state for a bounded 15-second
    correction horizon. A late closed root turn/run boundary emits version 2
    immediately, while final usage or horizon expiry releases the state.
20. After one child is reconciled through exact lineage, an authoritative
    residual may replace the one remaining root LLM aggregate. Ambiguous roots
    remain explicitly unallocated.
21. Codex Desktop prompt hooks without a transcript locator fail closed. This
    separates persistent user/subagent turns from ephemeral internal sessions
    such as title generation without retaining the locator or exposing another
    public run.
22. Every explicit terminal schedules a fixed per-run usage rebuild, independent
    from the global telemetry quiet period. A closed authoritative boundary for
    that recently terminal session triggers reconciliation immediately.
23. Codex model labels no longer turn tokenless startup/transport/plumbing spans
    into LLM work. Agent-control tools remain tools unless explicit provider
    child evidence establishes a subagent; exact child lineage reports complete
    trace-descendant usage.
24. Lifecycle anchors preempt enrichment inside the live webhook lane, and
    ordinary outbox delivery re-reads priority after every event. Fresh starts
    therefore do not wait behind a stale snapshot of another run's updates.
25. Transcriptless Codex prompt hooks now persist a privacy-safe opaque internal
    marker instead of merely disappearing. Usage projection and dispatch enforce
    that marker across later Stop hooks, OTLP traces/logs, rebuilds, attribution,
    and restarts, while repository binding remains absent.
26. Fresh completed lifecycle projection now runs independently from historical
    replay. Both lanes yield after one run and re-select priority, so an
    already-running historical projection cannot hold a terminal correction.
27. Cumulative Codex turn spans remain authoritative token boundaries but no
    longer become additional LLM request activity rows.
28. Full attribution bootstrap no longer re-projects every historical lifecycle.
    Durable outbox recovery and the bounded live-recovery window own restart
    delivery, while bootstrap retains commit reconciliation.
29. Commit reconciliation now runs in its own coalesced scheduler lane. A slow
    historical commit scan cannot occupy the fresh completed-run lane or delay
    a query-scoped terminal snapshot from replacing the pending first terminal.
30. A final-usage correction with unresolved child activity now remains
    replaceable for a bounded 250 ms. The grouped projection can collapse into
    that pending version instead of racing it into an immediately following
    terminal version; without grouping, the correction still releases on time.
31. Grouped terminal activity authority is monotonic by semantic kind/name.
    Alternating live and completed projections cannot reintroduce a duplicate
    lower-authority row or overwrite previously verified child attribution when
    the complete token vector is unchanged.
32. Same-name multi-child usage is complete only when every child-session link
    is exact. Terminal reconciliation accepts one bounded unique LLM subset whose
    complete token-vector sum matches the aggregate; partial and ambiguous sets
    fail closed.
33. Call-ID-bearing Codex `codex.tool_result` events now corroborate managed
    `PostToolUse` request identity and protocol failures. Hook naming/timing wins,
    request-level evidence merging keeps one tool count in live and completed
    projections, and unified-exec protocol success remains an `unknown` shell
    outcome unless Codex supplies a native structured exit code or status.
34. Codex `apply_patch` write targets are extracted transiently from the native
    `tool_input.command` shape. Only opaque artifact keys survive ingress, so
    causal `filesChanged` can be exact without retaining patch text or paths.
35. Codex tool-result records without a stable call ID remain internal and
    unusable for activity. Raw arguments and output are discarded even when
    sensitive-audit capture is enabled for other provider surfaces.
36. Grouped run breakdowns now retain an exact `unknownCount` alongside
    `failureCount`. Completed projection can no longer reinterpret zero known
    failures as universal success when a harness omitted native outcomes; the
    provider-neutral webhook row carries the count and remains `unknown`.

The provider-neutral webhook contract remains unchanged. Corrected usage,
activity, timing, model, cost, or proven file evidence can still emit a higher
complete `run.ended` replacement version.

## Real Deep-Run Evidence

The first isolated Codex run started at `2026-07-10T13:30:20.663Z` and ended at
`2026-07-10T13:40:30.452Z` (609.789 seconds).

- `run.start` reached the receiver 139.106 seconds late because Codex hook
  entries existed but `features.hooks` was disabled.
- Tirion emitted its first terminal around nine minutes early because one
  `response.completed` model response was treated as run completion.
- Codex's closed turn trace and rollout ledger both reported 1,514,607 input,
  20,193 output, 1,403,520 cached-input, 2,227 reasoning-output, and 1,534,800
  total tokens. The premature webhook reported only 45,691 total tokens.
- Two child ledgers carried 294,316 and 99,210 tokens but appeared as unlinked
  fragments. Three subagent attempts, including one failed attempt, were not
  represented faithfully.
- The rollout recorded 32 shell calls, 12 patch calls, and two non-zero shell
  exits; the webhook reported 17 shell calls and zero failures.
- Receiver-generated files and concurrent watcher output entered
  `filesChanged` because snapshot timing was being mistaken for causal writes.
- Prompt, response, tool-argument, path, and file-content canaries did not leak.

These observations are now regression fixtures, not merely operational notes.

## Construct Decision

No new construct is needed. The work improves existing JTBDs:

- `AgentRuntimeControl.RuntimeWorkScheduler`: independent scheduling lanes.
- `ExternalWebhookDispatch`: fast projection, durable priority, retry timing,
  bounded delivery, ordering, and diagnostics.
- `RepositoryObservation`: open its active polling window immediately when a
  safe observation is accepted.
- `UsageProjection` and `RunLedger`: remain authoritative for terminal usage.
- `WorkspaceChangeTracker` and `AgenticWorkEpisode`: remain authoritative for
  repository evidence and fail-closed binding.

## Target Flow

```text
durable SafeObservation
  |-- exact record/repository routing -> priority lifecycle anchors -> run.start / run.update -> outbox
  |-- workspace_evidence_projection -> repo/file evidence ----|
  `-- usage_projection -------------> completed RunLedger ----> replaceable settling update
                                                       `------> versioned run.ended

outbox
  |-- start/update/ended priority re-read after each delivery
  |-- fixed terminal deadline + exact next-deadline wake-up
  `-- bounded HTTP attempt -> delivered or durable retry
```

The lanes are provider-neutral. Harness-specific logic ends when approved
telemetry becomes `SafeObservationV1` and authoritative `ProductionRunV1`
records; all four harnesses then share the same dispatch path and payloads.

## Harness Comparison

| Harness | Earliest safe start authority | Completion authority | Pre-receipt delay | Main remaining ambiguity |
| --- | --- | --- | --- | --- |
| Claude Code | `UserPromptSubmit` hook or approved prompt OTLP event | Matching `Stop`; inactivity only as fallback | Hook/OTLP export cadence | Some versions may omit child-session identity, which keeps child usage unlinked rather than guessed. |
| Codex | Transcript-backed `UserPromptSubmit` hook; nearby fallback prompt logs and delayed hooks reconcile to one opaque rollout identity | Matching `Stop`, or the public root query's closed cumulative turn trace when Stop is omitted | Hook relay plus OTLP export cadence | Child hooks report the parent session, so Tirion transiently derives the actual rollout session from the transcript locator and discards the path; transcriptless ephemeral desktop work fails closed. |
| Cursor | `beforeSubmitPrompt` hook | `stop`/`sessionEnd` revision of the remembered turn, with `afterAgentResponse` usage | Same-machine hook relay | Generation IDs may drift between response and stop; the remembered turn remains authoritative. |
| GitHub Copilot | Approved root span from direct OTLP JSON or span DB replay | Closed/revised root span through usage projection | Span DB polling adds up to about one second; direct OTLP does not | Operator-owned source setup and incomplete/revised spans. |

## Latency Contract

Tirion records internal latency from durable safe acceptance. For managed
prompt hooks, the end-to-end product target is under two seconds from harness
submission to receiver: up to one second for source-to-acceptance plus under
one second for acceptance-to-receiver. Direct same-machine hooks should usually
be materially faster. Copilot span DB polling may consume the source-side
second; direct Copilot OTLP does not.

| Event | Target | Eligibility |
| --- | --- | --- |
| `run.start` | under 1 second after safe lifecycle identity is accepted | Agent is full owner, URL is configured, and exactly one trusted watched repository can be bound. |
| `run.update` | under 1 second after safe activity is accepted | Its corresponding start subject exists and repository binding remains unambiguous. |
| `run.ended` | under 5 seconds after safe completion becomes an authoritative completed run | Repository binding exists; commit attribution is not required. |
| File enrichment | under 10 seconds after relevant writes become repository evidence | Evidence satisfies workspace continuity rules; a higher terminal version may be emitted. |

`webhook_delivery_succeeded` diagnostics now include:

- `queueLatencyMs`: durable outbox queue to successful receiver response.
- `observationLatencyMs`: lifecycle evidence observation to successful response.

GitHub Copilot span DB polling time is additive before safe observation
acceptance. Provider export delays are reported separately from Tirion's own
projection and delivery latency.

## Prototype Changes

### Fast lifecycle lane

`packages/agent/src/index.ts` fans each accepted safe observation into separate
live-webhook, workspace-evidence, and usage lanes. The webhook lane is queued
first. Opening the active repository observation window also happens at receipt
rather than after attribution work starts. Within the live-webhook lane,
prompt/terminal lifecycle anchors preempt queued enrichment, and priority is
checked again between observations.

Managed Codex setup treats `features.hooks = true` and the complete
`UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`, and `PostToolUse`
set as one source shape. It probes `codex app-server` hook state;
untrusted commands leave activation in `attention_required` until the user
approves them through Codex `/hooks`. Claude now has both subagent start/stop
hooks as well as explicit Stop completion.

### Terminal deadline

`packages/agent/src/externalWebhookDispatch.ts` replaces the sliding terminal
quiescence rule with a fixed three-second deadline derived from authoritative
completion. Delayed observations cannot push it out. Completed-run `settling`
updates use one replaceable outbox slot until that deadline, so a closed
turn/root authority can replace provisional request slices before publication.
A terminal replacement with proven files does not inherit an obsolete
empty-file grace deadline; a real retry backoff is still preserved.

The ordinary usage projection still coalesces active telemetry behind a quiet
period. Explicit completion now also arms a per-query projection at a fixed
offset from that completion, so activity from another session cannot keep
sliding the terminal run's final usage. A closed authoritative boundary for the
recently terminal session requests the rebuild immediately.

### Reliable delivery

The outbox orders lifecycle entries ahead of commit backlog while retaining
`start -> update -> ended` order for one run subject. Startup immediately drains
due durable work and restores the earliest future wake-up. After any timer pass,
the scheduler re-reads durable state and arms the next earliest deadline instead
of falling back to the 30-second sweep. Terminal queueing and HTTP delivery share
one per-run lock and re-read the current row before send. HTTP attempts time out
after five seconds and become normal retryable outbox failures. Ordinary
delivery processes one due event and then re-reads durable priority, allowing a
new start to preempt updates already present in the prior due-row snapshot.
Fresh completed lifecycle projection is independent from historical replay, and
both lanes project one run before re-selecting priority. A slow historical run
therefore cannot hold a fresh correction. Full attribution bootstrap no longer
re-projects all historical lifecycles; durable outbox recovery and the bounded
live-recovery window own restart delivery. Commit reconciliation is also
coalesced on a separate lane, so repository-history enrichment cannot occupy a
run-lifecycle lane while a fresh terminal is waiting. After a first terminal,
only a final-usage correction with unresolved subagent activity receives a
250 ms replaceable window; complete grouped activity bypasses that window.

### Bounded evidence and repository observation

The deep run showed that generic document storage was carrying more than one
million execution-node records and several multi-megabyte worktree snapshots.
Run attribution now reads node evidence only for the requested query and bounds
the local node journal. Startup removes legacy snapshots whose artifact state
arrays exceed the current cap and sanitizes equivalent legacy workspace or
episode evidence to a failed-closed, zero-artifact form before any full-owner
service loads it. If that one-time cleanup leaves material SQLite free-page
fragmentation, startup checkpoints and compacts the database before the
full-owner runtime begins; normal live delivery never performs a compaction.

`GitCli` bounds filesystem metadata probes as well as persisted artifact rows.
When a dirty worktree exceeds the artifact cap, the resulting snapshot is
explicitly partial. It can prove a listed artifact changed, but cannot serve as
a trusted baseline for commit attribution or imply that unlisted artifacts did
not change.

The durable outbox follows the same principle: a single event or terminal
subject is read directly, a delivery pass selects only due rows, and normal
status or trace/session lifecycle lookups use durable summaries or
identity-scoped rows. Historical delivery payloads remain available for explicit
retention and reconciliation without placing their deserialize cost on a new
`run.start` or `run.update`. Completed runs that lack usable workspace identity
are persistently marked deferred and are reconsidered only when stronger
telemetry supplies that identity.

### Progressive accuracy

The spike does not guess repository ownership or emit a terminal directly from
one model response. `RunLedger` completion remains authoritative, and
hook-anchored runs cannot complete until Stop/session-end or a closed root/turn
span supplies terminal evidence.
Once a terminal event is sent, later corrected usage, activity, timing, model,
cost, or proven file coverage may produce a higher version. Corrections are not
assumed to be monotonic. Read-only-to-writer upgrades still require explicit
write activity and the existing safety checks.

The terminal grace clock is anchored only to the trusted completion timestamp.
Queueing latency and an empty file list cannot restart it; final corrections
projected after that deadline are deliverable immediately.

The first accepted prompt anchor fixes public `startedAt` for every later event
in that lifecycle. Terminal revisions are compared by canonical semantic JSON,
excluding `eventId` and `version`, so object insertion order cannot manufacture
a correction.

Ingress resolves an allowlisted workspace path against cached watched roots and
persists only an opaque repository key. Structured write targets are parsed
transiently and HMACed. Snapshot-only changes no longer populate run-level
`filesChanged`; they remain available for conservative commit continuity.

An OTLP export can contain normalized records from concurrent sessions in
different watched repositories. Dispatch now keeps the explicitly keyed fast
path, then partitions an unkeyed observation by exact opaque query/session
identity already bound to a live run. Durable query occurrences restore that
binding after an agent restart. Unknown or conflicting records fail closed one
record at a time, so they neither contaminate nor suppress an exactly bound
run's live usage and activity.

### Activity and usage integrity

`run.ended.activity` is the final metadata-safe breakdown from
`UsageProjection`. It preserves grouped activity and failure counts, numeric
result metadata, row-level usage attribution basis and coverage, and an
explicit unallocated bucket. Dispatch defensively normalizes legacy or partial
breakdowns so activity token sums reconcile to the authoritative top-level run
totals.

Grouped completed-run rows replace provisional or older rows with the same
normalized kind/name. Their counts remain authoritative, preventing direct
hook rows and the later grouped view of those hooks from being added together.

Retrospective lifecycle events and grouped terminal activity identify their
provenance as `usage_projection`; they no longer imply that a prompt or stop
hook was observed. Live events continue to retain their actual hook, span,
provider metric, OTLP event, or replay evidence.

Codex response events are per-request slices with stable identities. They sum
for partial/live usage, while the closed turn trace supplies cumulative final
usage and wins by authority without double counting. Prompt-log fallback
identity and a nearby delayed submission hook become one query regardless of
which arrives first.

Codex subagent hooks can carry the parent session alongside a child turn. The
privacy boundary transiently extracts the child rollout identity from the
transcript filename, hashes both child and parent identity, and drops the path.
That parent link is present on the child prompt before Codex emits
SubagentStart, so dispatch can map the child immediately to the active public
root subject: child starts are idempotent enrichment, child closed turns are
non-terminal for the root, and only the root subject's closed authoritative
turn can substitute for a missing Stop hook.

Stable request and child-session identities merge corroborating hook and trace
activity. Trace identity is retained when it owns descendant usage, while hook
failure/outcome and child linkage improve the same logical record. Linked child
runs are recursively aggregated into one root exactly once, and child breakdown
rows retain `parentActivityId` in the webhook.

Live authority selection remains query-scoped before linked queries are folded
into the public root lifecycle. A child closed-turn authority replaces only
that child's request slices; root request/turn evidence is projected
independently, and the resulting activity/token vectors are added at the public
run boundary. This prevents a high-authority child turn from erasing live root
usage simply because both belong to one outbound run.

Live LLM and unallocated aggregate IDs are stable per query/session authority
scope. Request growth, trace enrichment, and closed-turn replacement therefore
refresh one logical row while a terminal is pending; older snapshots cannot
survive as tokenless duplicate rows with stale request counts.

Codex can expose one response twice: a trace `event` under an internal fragment
query and a log `request` under the public root or child query. Exact
multi-dimensional usage, billing/model context, distinct source/signal, and a
250 ms completion window now establish corroboration; otherwise both records
remain separate. When every usage atom in a fragment query is corroborated,
its internal LLM nodes are not projected as a second public aggregate.

A provisional child LLM row can overlap the final subagent aggregate. Terminal
reconciliation now removes the duplicate token attribution only when the final
row represents one child and the prior terminal contains a matching live
subagent observation, exact input/output/cache/reasoning usage, and compatible
timing. The trace row remains as tokenless nested evidence. A same-token root
LLM without that lineage remains independently attributed. Final usage can also
replace a provisional terminal whose context footprint is still
`complete_so_far`; the incompatible context is omitted instead of being
mislabelled `final` or causing privacy validation to block the correction.

Delayed telemetry can produce a cumulative parent-plus-child LLM row beside a
tokenless child trace in the provisional terminal. Tirion now decomposes that
row only when the authoritative one-child vector plus the authoritative
unallocated vector exactly reconstructs every cumulative token dimension. The
child is linked and remains tokenless; the cumulative row retains the exact
parent residual. This preserves provider-reported LLM attribution without
double counting or guessing.

The same conservative reconciliation now handles independently projected root
and child aggregates. Once exact child lineage owns the authoritative child
vector, the final unallocated residual replaces the sole remaining root LLM
aggregate. Tirion removes the generic unallocated row only in that unique case.

First terminal delivery still uses the fixed three-second deadline. A non-final
version 1 retains only bounded live state for 15 seconds, allowing a delayed
closed root boundary to publish a due-now version 2 as soon as it is accepted.
When every usage-bearing query has closed authority, usage and optional context
are labeled `final` together and the live state is released immediately.

An implementation span ID alone is not semantic work. Codex copies its active
model onto tokenless startup, transport, persistence, and response-plumbing
records, so model presence alone is not accepted as LLM work. Its
`dispatch_tool_call` internals remain out of public activity. A call-ID-bearing
`codex.tool_result` is request/protocol corroboration only and merges into the
managed hook record instead of becoming another tool count.
Cumulative turn spans remain available to usage authority selection but are not
projected as additional LLM request rows.

Agent-control names such as spawn and wait remain ordinary tools unless an
explicit provider field or fixture-backed native operation proves a child
subagent. A reconciled subagent with exact child lineage owns descendant usage
with `trace_descendant`/`complete` coverage; the nested child LLM remains
tokenless so the vector is counted once.

Codex Desktop also invokes hooks for ephemeral internal sessions. Persistent
user and child turns include a transcript locator, which Tirion inspects only
long enough to establish persistent-turn identity and opaque lineage. A
transcriptless `UserPromptSubmit` persists only an opaque internal marker with
no repository binding. Usage projection and dispatch enforce that marker across
later Stop hooks, logs, traces, attribution, and restarts.

## Regression Coverage

Added focused tests prove:

- managed Codex hooks are feature-gated and prior feature state restores
  exactly; activation diagnoses disabled, untrusted, and unavailable hook state;
  Claude and Codex explicit lifecycle/subagent hooks are complete;
- a hook-anchored long turn cannot end on intermediate model responses and
  closes at the exact Stop timestamp or its closed explicit root boundary when
  the harness omits Stop;
- delayed root/child Codex hooks reconcile with prior prompt events, preserve
  the active root after a child trace reports parent session identity, preserve
  stronger hook evidence across later OTLP revisions, emit one public start even
  when SubagentStart arrives later, and ignore the child turn as root terminal
  evidence;
- root and child usage authorities resolve independently before aggregation, so
  a child turn replaces only child request slices while root request/turn usage
  remains additive at the public-run boundary;
- pending terminal refreshes retain one stable LLM/unallocated aggregate per
  query/session authority scope as request slices become a closed turn;
- Codex request slices sum once, a cumulative turn trace supersedes them, and
  the submission hook remains the canonical identity when a fallback prompt log
  arrives;
- two linked child sessions fold into one root exactly once, including child
  usage, nested activity parentage, and failed subagent attempts;
- duplicate hook/trace activity merges by request identity without losing
  trace-descendant usage or hook-reported failure;
- exact workspace context binds correctly with multiple watched repositories,
  while only opaque keys persist;
- mixed multi-repository exports partition by exact query identity, unknown
  records remain blocked without suppressing known runs, restart recovery uses
  durable opaque query identity, and the same route works for Claude Code,
  Codex, Cursor, and GitHub Copilot;
- structured writes from provider hooks and Copilot OTLP become causal HMAC
  artifact keys, including Codex patch headers, without retaining paths or
  patch content;
- snapshot-only observer output does not enter run-level `filesChanged`;
- Claude Code, Codex, Cursor, and GitHub Copilot observations all reach the live
  webhook lane while workspace evidence is deliberately blocked.
- Claude Code, Codex, Cursor, and GitHub Copilot completed runs share the same
  terminal activity and attribution contract;
- terminal activity counts preserve mixed outcomes and unattributed tokens
  reconcile to top-level totals;
- authoritative one-child subagent usage replaces its corroborated provisional
  LLM usage exactly once; a cumulative parent-plus-child row is partitioned
  into the exact child aggregate and parent residual; an equal-token unlinked
  root LLM remains separately attributed; incompatible provisional context
  cannot block the final terminal revision;
- multi-turn Codex aggregation retains tools, skills, subagents, and usage from
  every fragment;
- a stronger completed-run projection can correct terminal tokens downward in
  a higher version, while same-request live revisions replace instead of add;
- deferred `run.ended` delivery wakes at the configured terminal deadline and
  preserves `run.start -> run.update -> run.ended` order;
- delayed provider evidence cannot rewind the first prompt-anchor `startedAt`;
- provisional completed usage replaces one pending settling snapshot before a
  root/turn authority and terminal are delivered;
- equivalent terminal objects with different key insertion order do not create
  versions, and concurrent terminal projection/delivery cannot lose a newer row;
- after the earliest of two close durable deadlines fires, the scheduler
  immediately arms and delivers the second rather than waiting for a sweep;
- Codex implementation spans do not become LLM/tool activity without explicit
  semantic evidence;
- transcriptless Codex internal prompt hooks persist only a durable opaque
  exclusion marker; later Stop hooks, usage projection, completed dispatch, and
  restart replay cannot promote that query, while transcript-backed root and
  child hooks continue to establish one public lifecycle;
- unrelated session telemetry cannot slide a query-scoped terminal projection,
  and a recent closed authoritative boundary requests immediate reconciliation;
- terminal query-family assembly uses opaque parent/child lineage, atomic
  per-run upsert, and an independent scheduler key across every supported
  harness, so global rebuild or attribution work cannot hold its correction;
- lifecycle anchors preempt queued enrichment, and newly queued starts preempt
  updates from other runs after the current HTTP attempt finishes;
- fresh completed projection proceeds while a historical run is still in flight,
  and each lane re-selects priority after one run;
- spawn/wait agent-control calls remain tools, explicit provider subagent
  evidence remains a subagent, Codex model-only plumbing is omitted, and exact
  child lineage reports complete trace-descendant usage;
- cumulative Codex turn authorities retain token accounting without becoming
  duplicate LLM request rows;
- repeated equivalent terminal projection preserves previously verified
  trace-descendant child attribution and is meaning-idempotent;
- delivery diagnostics expose bounded latency values;
- a hung receiver becomes a retryable `delivery_timeout`;
- lifecycle delivery wins over older commit backlog during forced recovery.

Existing suites continue to cover canonical shapes, centralized privacy
validation, provider-neutral repo lookup, ambiguous multi-repo failure,
versioned file enrichment, idempotency, retry, and all harness fixtures.

Validation completed during the spike:

| Validation | Result |
| --- | --- |
| `npm run check` | Passed every TypeScript build and 555 tests (root 216, contract 8, engine 73, platform 6, storage 12, agent 200, CLI 36, distribution 4), Go TUI build/tests, and the high-severity dependency audit with zero vulnerabilities. |
| Integrity-focused dispatch/classification suites | Passed 72 dispatch tests and 35 telemetry-classification tests, including mixed multi-repository routing, durable restart recovery, all-harness identity routing and query-scoped terminal scheduling, durable/late and same-name multi-child reparenting, public-start gating, exact cross-surface usage and tool-outcome corroboration, terminal conservation, additive root/child residual reconciliation, authoritative grouped-row replacement, bounded unresolved-child correction coalescing and release, repeated verified-child idempotency, native Codex patch-target extraction, completion-anchored deadlines, fixed terminal reconciliation under unrelated telemetry and blocked global rebuilds, lifecycle/start/completed-correction priority, commit-scan isolation, immediate post-deadline corrections, scheduler wake-up, semantic deduplication, immutable start identity, privacy, explicit subagent evidence, durable internal-session exclusion, and model-only/cumulative-turn activity filtering. |
| Live transcriptless Codex failure sequence | Against the rebuilt launchd agent, a transcriptless prompt followed by Stop in a watched workspace persisted one opaque `internal` occurrence with no repository binding, completion timestamp, or completion authority. After the terminal grace window, receiver delivery count remained unchanged at 1,925 with an empty queue. |
| Isolated Cursor hook lifecycle harness | Passed start, update, ended, ordering, terminal activity/token conservation, projection evidence, commit attribution, source receipt, cost, and privacy assertions. |
| GitHub Copilot span DB lifecycle harness | Passed read-only, multi-file write, feature write, pricing, lifecycle integrity, privacy, and both commit-attribution scenarios through direct isolated-agent mode. |
| Real Claude Code CLI phase | Passed read-only, multi-file write, story write, strict lifecycle integrity, privacy, and commit attribution with isolated managed settings and default auth. |
| Real Codex CLI phase | Passed read-only, multi-file write, feature write, strict lifecycle integrity, privacy, and commit attribution. `run.start` reached the receiver in 19-24 ms and first `run.ended` in 3.004-3.022 seconds in the final run. |
| Fresh watched-repository Codex acceptance | A real Codex CLI run reached `run.start` in 136 ms and first `run.ended` in 3.055 seconds from Stop. Its provisional snapshot reported one `apply_patch`, three `Bash` calls, and 74,195 tokens; final version 2 retained the same start/tokens and replaced them with exactly `apply_patch count: 1` and `Bash count: 3`. The final correction delivered 98 ms after queueing. Three live tool updates arrived in 66-161 ms; one 2.721-second outlier is retained below as a separate scan/receiver-contention follow-up. |
| Fresh Codex child-usage acceptance | A real read-only Codex CLI run emitted exactly one root start, seven updates, and terminal versions 1 and 2; the child run ID never appeared in the receiver. Final usage remained 92,584 tokens. `explorer` owned 28,358, the nested child LLM was tokenless with `parentActivityId`, and the provider-reported parent LLM retained the exact 64,226-token residual. Input, output, cache-read, cache-creation, reasoning, and total activity sums each equaled the top-level value. `run.start` arrived 2.286 seconds after the canonical prompt start, provisional terminal version 1 arrived 3.091 seconds after completion, and final version 2 arrived 29.284 seconds after completion. |
| Concurrent multi-repository Codex discovery run | A real complex run emitted one root start, 13 updates, and terminal versions 1 and 2, but every unkeyed root OTLP observation was blocked by the observation-wide two-repository guard even though its exact query was already bound. The provisional terminal therefore exposed only the 31,281-token child; final version 2 conserved all 260,727 tokens but left the 229,446-token root residual unallocated. The captured safe ledger contained 12 exact root requests, proving source evidence was available. This run produced the per-record exact-identity routing fix and the mixed-batch/restart/all-harness regressions above. Start delivery was 2.956 seconds from the prompt anchor, provisional terminal delivery was 3.139 seconds from completion, and final correction delivery was 68.768 seconds from completion. |
| Query-authority scope discovery run | After exact repository routing was enabled, a real root/child Codex run streamed root usage correctly through seven requests to 106,772 tokens. The child's 31,298-token closed turn then replaced that root aggregate because linked atoms had been rewritten to one query before authority selection. The root closed turn restored the correct 270,860-token terminal total, but final version 2 could identify only the child and left the 239,562-token root residual unallocated. Query-scoped authority selection now projects root and child independently before adding them to the public run; the regression proves `35` root request tokens plus a `34` child turn become `69`, then a `110` root turn yields `144`. Start delivery was 2.352 seconds from the prompt anchor, provisional terminal delivery was 3.277 seconds from completion, and final correction delivery was 50.526 seconds from completion. |
| Late-link and cross-surface discovery run | A fresh complex Codex run stored the explorer prompt with the correct parent session, yet an earlier OTLP update resolved the durable anchor directly to a child subject; the child then published its own start and terminal. The root provisional terminal double-counted matching trace-event and log-request slices at 499,317 tokens. Completed projection corrected the run to 270,652 tokens, but left the 239,379-token root residual unallocated beside two tokenless LLM rows while `explorer` owned 31,273. The closed root turn was accepted about 5.008 seconds after Stop, just after version 1, but version 2 did not arrive until 62.777 seconds after completion. Durable parent resolution, public-start gating, strict cross-surface corroboration, unique-root residual reconciliation, and the bounded immediate-correction path were all derived from this trace. |
| Codex Desktop root/child discovery run | One read-only user task produced a correct root lifecycle and kept its explorer child private. Internal hook acceptance to `run.start` receipt was 676 ms; prompt anchor to receipt was 2.487 seconds because the Codex hook itself arrived 1.811 seconds after submission. Terminal version 1 arrived 4.395 seconds after Stop. Final version 2 arrived 43.045 seconds after Stop with exact 138,602-token conservation: explorer 28,945 and root residual 109,657 across every token dimension. The trace also exposed one public 8,931-token title-generation session, two agent-control calls mislabeled as subagents, tokenless model-plumbing LLM rows, and a final rebuild whose global quiet timer was repeatedly reset by unrelated sessions. Transcript-backed lifecycle gating, explicit subagent classification, model-only filtering, fixed terminal reconciliation, and priority re-reads were derived from this run. Fresh post-restart acceptance remains required. |
| Post-restart Codex Desktop acceptance | The real read-only root reached `run.start` 125 ms after hook acceptance and 2.808 seconds after the prompt anchor; first terminal delivery arrived 3.067 seconds after Stop. Exactly one explorer remained private and owned 28,911 tokens with `trace_descendant`/`complete`; the 136,130-token root residual and all top-level dimensions conserved to 165,041. Spawn and wait were tools. The run still exposed one extra cumulative-turn LLM row, while a transcriptless 8,915-token title query was promoted by its later Stop hook into a second public lifecycle. The fixed usage rebuild completed about five seconds after Stop, but completed projection did not queue version 2 until roughly 55 seconds later because an in-flight historical batch had already reserved 25 runs. This acceptance produced the durable internal marker, one-run priority re-selection, and cumulative-turn activity exclusion. Fresh post-rebuild acceptance remains required. |
| Durable-marker Codex Desktop acceptance | Exactly one public root appeared. The simultaneous title query was durably `internal`, unbound, incomplete, and absent from the receiver. `run.start` delivered 468 ms after hook acceptance and about 2.18 seconds after the prompt anchor; terminal version 1 delivered 3.335 seconds after Stop. Final version 2 conserved every dimension at 168,773 tokens: explorer 28,895 with `trace_descendant`/`complete` and root LLM 139,878. Spawn and wait were tools, parent Bash count was three, child Bash count was one, and the only nested tokenless LLM row represented the explorer's three real requests; the cumulative-turn duplicate was gone. The fixed rebuild completed 5.334 seconds after Stop, but version 2 did not deliver until 34.016 seconds after Stop because one historical projection was already in flight. This run produced the independent fresh-completed projection lane and removal of redundant full-history lifecycle bootstrap replay. Fresh latency acceptance remains required. |
| Independent-lane Codex Desktop discovery run | Exactly one public root started 1.991 seconds after the prompt anchor and terminal version 1 delivered 3.144 seconds after Stop. All authoritative root and explorer usage was durable 244 ms after Stop, yet version 2 queued only after 44.922 seconds and an equivalent version 3 followed at 108.111 seconds while degrading explorer attribution from `trace_descendant`/`complete` to unavailable. This proved the remaining delay was global reconciliation rather than harness export. The new query-family projector reproduced the exact 124,545-token root from the accumulated production database in 18.78 ms; atomic per-run upsert, independent terminal scheduling, projection-stage diagnostics, and monotonic child attribution were derived from this run. Fresh rebuilt-agent latency acceptance remains required. |
| Query-scoped Codex Desktop discovery run | Exactly one public root started 2.635 seconds after the prompt anchor; the internal title query remained absent. Its query-family projection completed in 42 ms and 1.674 seconds after Stop, with exact 130,987-token conservation already available before the first terminal deadline. Terminal version 1 delivered 3.843 seconds after Stop with exact totals but only partial live child structure. The authoritative version 2 arrived 65.399 seconds after Stop with explorer 28,900 as `trace_descendant`/`complete`, root LLM 102,087, parent Bash count two, child Bash count one, spawn/wait/close as tools, and no files. Projection diagnostics showed the fresh run waited 49.629 seconds because its priority lane was awaiting a full commit reconciliation scan. This produced the independent coalesced commit lane and its blocked-scan regression. Fresh rebuilt-agent latency acceptance remains required. |
| Post-commit-lane Codex Desktop acceptance | Exactly one public root emitted one start, 19 updates, and three terminals; no internal title lifecycle appeared. Hook acceptance to start receipt was 481 ms, while the Codex hook itself arrived 3.876 seconds after the prompt anchor. The first terminal arrived 3.072 seconds after Stop. Query-family assembly took 28 ms, and completed lifecycle projection entered with zero queue latency instead of the prior 49.629-second stall. Final grouped meaning arrived 4.785 seconds after Stop and conserved 174,767 tokens exactly: explorer 83,461 as `trace_descendant`/`complete`, root LLM 91,306, parent Bash count two, child Bash count two, spawn/wait/close as tools, and no files. A live final correction raced the grouped correction into versions 2 and 3 only 273 ms apart; this produced the bounded unresolved-child correction coalescer. Fresh rebuilt-agent coalescing acceptance remains required. |
| Coalescing Codex Desktop acceptance | Exactly one public root emitted one start, 19 updates, and terminal versions 1 and 2; the internal title query remained durably internal and absent. Hook acceptance to start receipt was 138 ms and prompt-anchor to receipt was 1.995 seconds. Query-family assembly took 33 ms and entered completed projection with zero queue latency. The first terminal already carried final usage and grouped activity 4.095 seconds after Stop; no version 3 appeared, proving the live/grouped correction race collapsed. Top-level usage conserved exactly at 130,782 tokens, including the 28,834-token explorer and 101,948-token root. The explorer's exact child query/session/parent-session lineage was durable, but alternating live and grouped terminal snapshots left its row at `unavailable` and version 2 delivered 6.369 seconds after Stop. This produced monotonic semantic activity authority and the alternating-projection lineage regression. Fresh rebuilt-agent authority acceptance remains required. |
| Authority-fixed Codex Desktop acceptance | Exactly one public root emitted one start, 17 updates, and one terminal at version 1; the simultaneous transcriptless title query remained durably `internal` and absent from the receiver. Start receipt was 141 ms after hook acceptance and 2.651 seconds after the prompt anchor, with the provider hook accounting for the source-side delay. Completed lifecycle projection entered with zero queue latency and finished in 179 ms. The only terminal arrived 3.611 seconds after Stop with exact 113,175-token conservation: explorer 28,824 as `trace_descendant`/`complete`, root LLM 84,351, input 112,784, output 391, cache-read 83,072, cache-creation zero, and reasoning 64. The child LLM was tokenless and parented to the explorer; parent and child Bash calls were distinct, spawn/wait/close remained tools, and `filesChanged` was empty. Repeated projections through more than 16 seconds after Stop produced no correction, duplicate, or attribution downgrade, and the durable queue ended empty. This closed the controlled single-child Codex Desktop latency, coalescing, and semantic-authority acceptance. |
| Final adversarial multi-child discovery run | One public root emitted exactly one start, 31 updates, and one terminal while the simultaneous title query remained durably `internal` and absent. Start reached the receiver about 2.47 seconds after the prompt anchor; the terminal arrived about 3.24 seconds after Stop, and the durable queue returned to zero. Top-level usage matched the Codex ledger exactly at 214,434 tokens, including two child turns whose exact 29,211- and 29,169-token vectors summed to the 58,380-token explorer aggregate. The terminal nevertheless labeled that aggregate unavailable, left both child LLM rows unparented, reported an intentional non-zero Bash exit as success, and omitted the twice-patched file. Prompt/tool/path/content canary matches were zero in every durable collection, the agent log, and receiver payloads. This run produced complete-count multi-child finalization, unique bounded terminal subset reconciliation, and native `tool_input.command` patch-target extraction. It also triggered a contract audit of Codex outcome evidence rather than a text-based patch. Fresh rebuilt-agent acceptance is required. |
| Multi-child and causal-file acceptance with Codex outcome contract audit | The submitted prompt was the older `v1` scenario rather than the intended fresh `v2` scenario. It still emitted exactly one root start, 36 updates, and one terminal. Start reached the receiver 2.696 seconds after the prompt anchor and 380 ms after hook acceptance; the terminal arrived 3.235 seconds after Stop. Top-level usage matched the Codex ledger exactly at 245,065 tokens across every dimension. Two exact child turns reconciled into an explorer aggregate of 78,315 tokens with `trace_descendant`/`complete`; both child LLM rows were tokenless and parented, while the root retained the exact 166,750-token residual. The terminal reported the one patched `v1` file, proving native `tool_input.command` target extraction. The deliberate exit-7 command still appeared successful because Codex 0.142 hard-codes unified-exec `success_for_logging()` to true: its numeric `exit_code` is present on the private app-server `ExecCommandEnd`, but absent from exported `PostToolUse` and OTLP. Tirion now preserves such unstructured shell outcomes as `unknown`, retains explicit dispatch failures, accepts native structured exit fields when available, and never parses response text. The fresh `v2` run below closes the rebuilt acceptance. |
| Fresh `v2` Codex Desktop end-to-end acceptance | One public root emitted exactly one start and 34 updates. Start delivery was 2.159 seconds after the prompt anchor with 69 ms of Tirion queue latency. The fixed three-second terminal delivered 3.079 seconds after Stop; Codex's closed root trace reached completed projection just after that deadline, so final version 2 replaced it at 3.460 seconds. The final source ledger conserved every dimension at 259,706 tokens: root 175,298 plus child turns of 31,515 and 52,893. The two-child explorer aggregate owned 84,408 tokens with `trace_descendant`/`complete`; both nested child LLM rows were tokenless and parented. Exactly two patch calls produced only `tirion-final-stress-20260711-v2.txt`, whose 10-byte final fixture matched transient verification. Live shell outcomes were correctly `unknown`, but the first completed projection exposed a second defect: `RunBreakdownV1` retained only `failureCount` and therefore converted zero failures back to success. After adding provider-neutral `unknownCount`, rebuilding, and replaying the same durable run, terminal version 3 retained exact totals and file evidence while reporting all three Bash groups as `unknown` with exact counts 1, 1, and 4. No `SubagentStop` hook was captured, so the two explorer outcomes also remain honestly unknown while their usage linkage is complete. Five prompt/tool/content canaries were absent from the Tirion database, agent log, and receiver; the durable queue and blocked count returned to zero. |
| Fresh post-fix `v3` Codex Desktop acceptance | The rebuilt agent emitted exactly one public root start, 36 updates, and one final terminal at version 1; no correction appeared after the full horizon. The reconciled prompt anchor preceded Codex's hook arrival by 3.065 seconds, while Tirion accepted and delivered the observed hook in 94 ms. Query-scoped terminal projection completed in 37 ms before the fixed deadline, and the final terminal reached the receiver 3.289 seconds after Stop. The four native ledgers conserved every dimension at 270,891 tokens: root 158,366 plus child turns of 31,715, 49,309, and 31,501. The three-child explorer aggregate owned exactly 112,525 tokens with `trace_descendant`/`complete`; all three nested LLM rows were tokenless and parented. Spawn and close each counted three, the two patch calls produced only `tirion-final-stress-20260711-v3.txt`, and all four Bash calls remained `unknown` with `unknownCount: 1` instead of false success. Codex emitted no `SubagentStop`, so all three explorer outcomes also remained honestly unknown while usage linkage was complete. The expected 10-byte fixture matched transient verification, five prompt/tool/content canaries were absent from the Tirion database, agent log, and receiver, and both durable queue and blocked count returned to zero. This closes the fresh post-fix Codex Desktop acceptance. |
| Four-child, multi-file `v4` Codex Desktop acceptance | A second fresh post-fix run emitted exactly one public root start, 45 updates, and one final terminal at version 1; no later correction appeared. Prompt anchor to receiver was 2.028 seconds, of which 1.479 seconds preceded the Codex lifecycle hook; Tirion queued and delivered the accepted hook in 189 ms. Query-scoped terminal projection completed in 40 ms before the deadline, and the terminal reached the receiver 3.303 seconds after Stop. Five native ledgers conserved every dimension at 325,060 tokens: root 207,303 plus child turns of 29,177, 29,550, 29,361, and 29,669. The four-child explorer aggregate owned exactly 117,757 tokens with `trace_descendant`/`complete`, and all four nested LLM rows were tokenless and parented. Spawn and close each counted four, two multi-file patch calls attributed exactly `tirion-final-stress-20260711-v4-a.txt` and `tirion-final-stress-20260711-v4-b.txt`, and all six Bash calls (two root, four child) remained `unknown` with exact unknown counts. Codex again emitted no `SubagentStop`, so all four explorer outcomes remained unknown while usage linkage was complete. The expected 10- and 9-byte fixtures matched transient verification, seven prompt/tool/content canaries were absent from the Tirion database, agent log, and receiver, and durable queue and blocked count returned to zero. This extends fresh same-name multi-child acceptance from three to four children and validates multi-target patch extraction without a new defect. |

Maintained end-to-end anchors remain:

- `local-harnesses/tirion_local_server_dual_provider_lifecycle_test.sh`
- `local-harnesses/tirion_local_server_cursor_hooks_lifecycle_test.sh`
- `local-harnesses/tirion_local_server_github_copilot_lifecycle_test.sh`

## Risks And Follow-ups

| Risk | Current posture | Recommended next experiment |
| --- | --- | --- |
| Harness omits workspace context | Exact known query/session records still route independently in a mixed multi-repository export, including after restart. Truly unknown or conflicting records fail closed and remain local. | Measure field availability per supported harness/version and add only fixture-backed aliases. |
| One in-flight HTTP request still occupies the serial delivery worker | Bounded to five seconds and durably retried. | Prototype limited concurrency across run subjects while preserving strict order inside each subject. |
| Completed projection can still improve grouped activity after live final usage | The explicit-terminal snapshot remains fixed at three seconds. A query-family projection has its own fixed scheduler key, atomically upserts one run, and enters the fresh lane without waiting for global rebuild, attribution, historical replay, or commit reconciliation. A non-final version retains a 15-second correction horizon. A final-usage correction with unresolved child activity gets a 250 ms replaceable window so grouped activity can collapse into the same version; without grouping it releases at the bound. Grouped semantic rows and verified descendant attribution remain monotonic across alternating live/completed projections. The controlled Codex Desktop acceptance collapsed exact grouped authority into version 1 and remained stable under later projections. | Record p50/p95 completion-to-live-final and completion-to-grouped-final timing separately across the maintained Claude, Codex, Cursor, and Copilot matrix. |
| Codex Desktop emits hooks for ephemeral internal sessions | A transcriptless prompt stores an opaque internal marker without repository binding. Usage and dispatch enforce it across later Stop/trace/log evidence and restarts. Persistent root and child hooks require a transcript locator, which is used transiently and discarded. | Retain desktop title-generation fixtures and re-run them whenever Codex hook schema or trust behavior changes. |
| Active repository scans can contend with the first live delivery | Scheduler lanes are independent, but one observed first-tool update waited about 1.03 seconds before its HTTP attempt while an active repository scan overlapped. Later updates were below 161 ms. | Add storage-operation latency spans, then prototype priority point delivery or smaller snapshot persistence batches without weakening causal file evidence. |
| The local validation receiver shares an event loop with synchronous dashboard scans | A 35k-file dashboard/model scan blocked one loopback response for about 1.63 seconds even though Tirion had already queued the update. This is outside Tirion's acceptance-to-attempt path but inflates end-to-end test latency. | Move receiver ingestion to a separate process/worker or make dashboard indexing incremental before using it for p95 delivery benchmarks. |
| Provider request/child IDs are absent or drift | Corroborating facts remain separate or child runs remain standalone; Tirion does not guess. | Maintain versioned native fixtures and diagnostics for unlinked/ambiguous evidence. |
| Span DB source latency | Up to one poll interval before acceptance. | Include source-to-acceptance timing in the Copilot local harness and report it separately. |
| Codex hook trust is user-controlled | Activation now fails visibly with `hook_trust_required`; Tirion never bypasses trust in product mode. | Add a signed-install trust UX and continue probing provider hook state after upgrades. |
| Codex shell exit status is not exported by current hooks or OTLP | Codex 0.142 exposes numeric `exit_code` only on its private app-server stream. Tirion reports unstructured shell outcomes as `unknown`, preserves explicit protocol failures, and never scrapes response text. | Request a native `exit_code`/`status` field on Codex `PostToolUse` or OTLP keyed by the existing call ID; retain versioned fixtures and promote the outcome only when that structured field appears. |
| Cursor native UI automation is not part of the maintained test | The isolated harness validates real Cursor-shaped hook contracts and relay/source behavior without driving the editor UI. | Add an opt-in native Cursor smoke run when stable editor automation is available. |
| Receivers may ignore replacement semantics | Version, event ID, and replacement rules are documented. | Add a maintained receiver contract test that retains the highest terminal version and never sums snapshots. |

## Recommendation

Keep this direction. The shared implementation has passed real Claude Code and
Codex CLI runs, the controlled Codex Desktop root/child acceptance, and isolated
Cursor and Copilot source-path validation. Before merge, run the live
cross-harness matrix. Compare each webhook to the harness ledger, closed
turn/root trace, hook counts, child evidence, and causal file set. Any
unsupported native field must reduce coverage rather than trigger temporal or
naming heuristics.
