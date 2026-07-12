# Claude Code Integrity And Observability Optimization Program

Date: 2026-07-12

Status: kickoff strategy for a new engineering task

Proposed branch: `codex/claude-code-integrity-optimization`

Baseline: the reviewed commit that lands the Codex webhook lifecycle optimization
spike. Record its exact SHA before creating the Claude branch.

## New Task Kickoff Prompt

Use this prompt to start the dedicated task in Codex:

```text
Your task is to execute the Claude Code Integrity and Observability Optimization
Program in docs/spikes/claude-code-integrity-observability-program.md.

First read AGENTS.md, constructs.md, the program document, the Codex optimization
report at docs/spikes/webhook-lifecycle-optimization.md, and the current Claude
monitoring documentation at docs/harness-run-monitoring.md. Apply construct-first
thinking before proposing or editing implementation.

Create and work on branch codex/claude-code-integrity-optimization from the
reviewed commit that contains the Codex optimization work. Do not discard or
overwrite unrelated local changes. Record the exact baseline SHA and installed
Claude Code version in the program evidence log.

Carry the work through native-source discovery, root-cause fixes at the owning
constructs, deterministic fixtures, live Claude Code acceptance, full
verification, and an explainable outcome report. Do not copy Codex-specific
heuristics into Claude. Derive authority from Claude's documented and observed
native hooks, OTLP logs, and OTLP traces. Treat unsupported or ambiguous evidence
as unknown and fail closed.

The customer promise is that Tirion is a near-real-time, privacy-safe source of
truth for the complete coding-agent run: root work, tools, skills, MCP calls,
subagents, nested agents, token usage, estimated cost, outcomes, causal files,
and lifecycle timing. Prompt text, response text, tool arguments/output, command
text, file content, diffs, transcript paths, and absolute paths must never persist
or leave the machine.

Begin with Phase 0 and Phase 1. Verify every assumption against a disposable
native Claude run before changing production classification or projection. Keep
the program document's evidence log and decision log current as discoveries are
made.
```

## Mission

Make Tirion's canonical `run.start`, `run.update`, and `run.ended` webhooks as
fast, reliable, complete, and truthful for Claude Code as they are for the
accepted complex Codex runs.

Customers should be able to treat Tirion as a near-real-time source of truth for:

- one complete user-initiated run,
- root model work,
- every tool call,
- skill activation and skill-attributed model work,
- MCP calls,
- direct, parallel, and nested subagents,
- agent teams and workflows when supported by the installed Claude version,
- exact provider-reported token dimensions,
- estimated cost with explicit billing context and coverage,
- native success, failure, rejection, or unknown outcomes,
- causally proven repository-relative file changes,
- lifecycle timing, delivery timing, and correction state.

The program is successful only when complex native Claude Code runs agree with
the provider evidence ledger and remain protected by deterministic regression
tests.

## Product Promise And Non-Negotiables

These rules outrank convenience, apparent completeness, and harness symmetry:

1. Keep one provider-neutral webhook contract across Claude Code, Codex, Cursor,
   and GitHub Copilot.
2. Put Claude-specific meaning at source configuration, ingress, classification,
   and authority selection boundaries. Do not add a Claude-only webhook format.
3. Never persist or dispatch prompt text, assistant responses, last assistant
   messages, tool input/output, command text, file contents, diffs, transcript
   paths, raw telemetry, or absolute paths.
4. A sensitive path may be inspected transiently only to resolve a watched
   repository or derive an opaque artifact key. Discard it immediately after.
5. Do not parse free-form model text, tool output, or shell output to infer an
   outcome, child relationship, token count, or changed file.
6. Do not infer parentage from timing or same-name proximity when Claude exposes
   `agent_id`, `parent_agent_id`, span parentage, or `tool_use_id`.
7. Do not convert missing outcome evidence into success. Preserve `unknown` and
   `unknownCount` exactly.
8. Do not count one request, tool, skill, or child twice when hooks, logs, and
   traces corroborate the same native identity.
9. Do not expose internal Claude processes or auxiliary sessions as customer
   runs. Their usage may be retained as run overhead only when exact native
   lineage proves that it belongs to a customer run.
10. Repository binding and causal file attribution fail closed when evidence is
    absent or conflicting.
11. All cost fields remain estimates. Provider-reported `cost_usd` is evidence
    for an estimate, not proof of final billed cost.
12. Source readiness requires functioning surfaces, not configuration text that
    merely looks correct.

## Why This Is A Separate Program

The Codex program proved that webhook delay and incorrect payloads often begin
upstream of dispatch. Source configuration, identity, completion, usage
authority, child lineage, activity classification, repository binding, and
storage scheduling can each create an apparently similar receiver symptom.

Claude Code should therefore be investigated as its own provider contract. It
has stronger native request, tool, skill, and subagent evidence than current
Codex, but it also has provider-specific behaviors that make direct reuse of
Codex rules unsafe:

- `Stop` and `SubagentStop` are stop attempts that other hooks may block.
- `Stop` may report active background tasks and scheduled continuations.
- `StopFailure` fires instead of `Stop` for terminal API errors.
- one prompt has a native `claude_code.interaction` root span,
- subagent spans nest under the spawning Agent tool span,
- `agent_id` and `parent_agent_id` provide native hierarchical identity,
- `tool_use_id` joins hooks, logs, and traces,
- `claude_code.skill_activated` explicitly reports skill invocation,
- `workflow.run_id` can link workflow agents and nested skill work on supported
  versions.

The strategy is to preserve the shared Tirion constructs while deriving Claude
authority from Claude evidence.

## Codex Learnings To Carry Forward

### 1. Fix the owning construct

The Codex issue was not one dispatch defect. Real runs exposed defects in source
readiness, prompt correlation, internal-session filtering, completion authority,
child folding, token authority, outcome semantics, file evidence, queue priority,
and historical replay. Each fix belongs in the construct that owns the job.

### 2. Native evidence beats naming and timing

Exact native request IDs, call IDs, sessions, child IDs, and trace parentage are
authorities. Names and timestamps are corroboration only. Ambiguity must reduce
coverage rather than trigger a guess.

### 3. A model response is not a run boundary

A complex run contains multiple API responses, tools, and child turns. The run
ends only at a provider-authoritative root boundary. For Claude, the program
must determine the relationship among `Stop`, blocked Stop attempts, active
background tasks, `StopFailure`, and the closed `claude_code.interaction` span.

### 4. Child usage must be folded exactly once

Linked child work remains visible inside the root but must not also appear as a
standalone public run. Same-name child aggregation is complete only when every
represented child has exact lineage.

### 5. Usage authority is selected before aggregation

Choose the strongest usage surface independently for root and child work. Then
fold children into the root. Do not combine overlapping log and trace copies of
the same request.

### 6. Every token dimension must conserve

Input, output, cache read, cache creation, reasoning when present, and total
tokens must reconcile at the run and activity levels. Unallocated usage stays
explicit instead of being assigned to a convenient tool or child.

### 7. Unknown is an integrity result

Codex shell status demonstrated that protocol success is not process success.
Claude exports stronger tool outcomes, but any missing native field must still
remain unknown.

### 8. File attribution must be causal

Successful Edit or Write evidence can prove a changed artifact. A dirty-worktree
snapshot or nearby timestamp cannot. Bash-created files must remain unclaimed
unless a native, structured surface proves the exact path and call relationship.

### 9. Internal work needs durable exclusion

Dropping one internal observation is insufficient. A durable privacy-safe marker
must prevent later logs, traces, hooks, rebuilds, restarts, or attribution from
promoting internal work into a public run.

### 10. Real-time delivery needs independent lanes

Accepted lifecycle work must not wait behind usage rebuilds, workspace scans,
commit reconciliation, historical replay, or a stale outbox snapshot. Fresh
starts and terminals need bounded, priority-aware work paths.

### 11. First terminal and final truth are separate concerns

A fixed first-terminal deadline protects latency. A bounded, versioned
correction can improve usage, activity, models, or files without making the first
terminal wait indefinitely.

### 12. A successful live run is evidence, not regression protection

Every defect discovered by a native run should produce a versioned synthetic
fixture and a deterministic assertion at the lowest responsible boundary.

## Starting Baseline

### Current environment

- Claude Code installed when this document was written: `2.1.201`.
- Official documentation says `workflow.run_id` requires Claude Code `2.1.202`
  or later. Re-check both facts at program kickoff.
- Current worktree branch when this document was written:
  `codex/webhook-lifecycle-optimization-spike`.
- The Codex spike and new complex-run fixtures were not yet committed when this
  document was written. Create the Claude branch only after establishing an
  intentional reviewed baseline.

### Existing Claude support

Tirion currently:

- manages Claude Code settings in `~/.claude/settings.json`,
- configures OTLP logs and traces to the local agent,
- configures `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`,
  `PreToolUse`, `PostToolUse`, and `PostToolUseFailure` hook relays,
- accepts `claude_code.user_prompt`, API request, tool result, and compatible
  trace shapes,
- keeps prompt capture, tool content, and raw API bodies disabled by default,
- treats Claude request evidence as higher usage authority than model/event
  copies,
- runs read-only, multi-file write, commit, privacy, and lifecycle scenarios in
  `local-harnesses/tirion_local_server_dual_provider_lifecycle_test.sh`,
- has provider-native activity and skill probes under `local-harnesses/`.

### Confirmed gaps

These are visible in current code or current official contracts and should be
treated as P0/P1 items:

1. `TelemetrySourceConfiguration` sets `OTEL_TRACES_EXPORTER` but does not manage
   `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`, which the official monitoring
   contract requires for spans.
2. Source status can therefore claim traces are configured without proving that
   Claude will emit enhanced traces.
3. `TelemetryClassification` currently promotes every Claude `Stop` directly to
   `stop_hook` completion without considering a blocked Stop, active
   `background_tasks`, or `session_crons`.
4. Tirion does not currently configure or classify Claude `StopFailure`.
5. Production classification does not yet consume `parent_agent_id` or
   `workflow.run_id` as first-class lineage.
6. The standalone native skill extractor understands
   `claude_code.skill_activated`, but that surface is not yet fully integrated
   into production classification and usage attribution.
7. The maintained Claude lifecycle system scenarios do not yet stress parallel
   same-name children, nested agents, blocked Stop behavior, background work,
   workflow work, or exact skill token attribution.
8. Deterministic complex child-agent fixtures currently model accepted Codex
   shapes. Equivalent Claude fixtures do not yet exist.
9. The local shell system harnesses are not part of the default `npm run check`
   gate.

### Hypotheses that require native evidence

Do not encode these as facts until a pinned native capture proves them:

- whether `UserPromptSubmit` arrives before the OTLP prompt event in every CLI
  and interactive mode,
- whether a blocked Stop is followed by another Stop with the same prompt ID,
- whether the interaction span closes before or after the final allowed Stop,
- whether child `agent_id` appears consistently in non-interactive and
  interactive traces for the tested account,
- whether child API request logs carry enough identity without enhanced traces,
- whether hook `agent_id`, trace `agent_id`, and Agent tool `tool_use_id` form a
  complete one-to-one link,
- whether nested agents always expose `parent_agent_id`,
- whether usage on compaction or other auxiliary requests belongs inside the
  customer run as overhead or must be excluded,
- whether FileChanged can ever provide causal evidence rather than temporal
  observation,
- ordering and export delay among logs, traces, hooks, and CLI result output,
- whether subscription, Anthropic API, Bedrock, and Vertex modes expose the
  same cost and billing-context evidence.

## Official Claude Evidence Map

The official contracts were reviewed on 2026-07-12:

- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Claude Code monitoring and OpenTelemetry](https://code.claude.com/docs/en/monitoring-usage)
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code tools](https://code.claude.com/docs/en/tools-reference)

Re-verify them when the tested Claude version changes.

| Native surface | Strong identity | Candidate Tirion role | Important caveat |
| --- | --- | --- | --- |
| `UserPromptSubmit` hook | `session_id`, hook receipt time | earliest live start anchor and repository context | prompt content and transcript path are sensitive; native prompt ID may arrive later through OTLP |
| `claude_code.user_prompt` event | `prompt.id`, session attributes, event sequence | durable query identity and hook reconciliation | event export can lag the hook |
| `claude_code.interaction` span | trace/span identity, interaction sequence | authoritative root topology and closed turn boundary | validate blocked Stop and background-task ordering before making it sole completion authority |
| `claude_code.api_request` event | `prompt.id`, `request_id`, model | exact request usage and provider-reported estimated cost | retries and trace copies must not duplicate one request |
| `claude_code.llm_request` span | `request_id`, `agent_id`, `parent_agent_id`, span parent | request usage, root/child ownership, outcome | enhanced traces must actually be enabled and emitted |
| `PostToolUse` hook | `tool_use_id`, tool name | successful tool activity and transient write-path evidence | hook includes sensitive input/output; sanitize before append |
| `PostToolUseFailure` hook | `tool_use_id`, tool name | failure or rejection activity | distinguish interrupt/rejection from execution failure |
| `claude_code.tool_result` event | `tool_use_id`, structured `success` | authoritative outcome and hook/log deduplication | rejected calls use a decision event rather than tool result |
| `claude_code.tool` and execution spans | `tool_use_id`, `agent_id`, span parent | duration, child ownership, structured tool topology | detailed attributes may be gated |
| `SubagentStart` hook | `agent_id`, `agent_type`, parent session | early child activity and name | not proof that child usage was exported |
| `SubagentStop` hook | `agent_id`, `agent_type` | child completion candidate and outcome attempt | can be blocked; response and transcript fields are sensitive |
| `agent_id` / `parent_agent_id` trace attributes | opaque agent IDs | exact direct and recursive lineage | availability must be version/account fixture-backed |
| `claude_code.skill_activated` | `skill.name`, trigger, source | exact skill invocation | custom names may be redacted unless tool details are enabled |
| Skill tool result/span | `tool_use_id`, `skill_name` | skill duration/outcome and request parent | merge with skill event, do not count twice |
| request `skill.name` | request identity plus skill name | exact skill-attributed model usage | one skill may span several requests |
| MCP tool names/attributes | `tool_use_id`, server/tool metadata | MCP activity and exact request lineage | custom names may be normalized or redacted |
| `workflow.run_id` | stable workflow run ID | workflow, teammate, nested agent, and skill grouping | official contract requires Claude Code 2.1.202 or later |
| `Stop` hook | prompt/session plus stop state | root completion candidate | may be blocked; active background tasks or crons mean the session is paused, not done |
| `StopFailure` hook | session plus structured error type | failed terminal candidate | fires instead of Stop for terminal API errors |
| Task and teammate hooks | task/team IDs | background and team lifecycle evidence | descriptions and messages are sensitive and must be discarded |
| Edit/Write path metadata | `tool_use_id` plus structured path | causal artifact key after success | raw/absolute path is transient only |
| `FileChanged` hook | watched path and session context | corroborating workspace evidence | file observation alone does not prove agent authorship |

## Proposed Authority Rules

These are the initial rules to validate, not permission to skip native discovery.

### Root identity and start

1. A repository-bound `UserPromptSubmit` hook creates the provisional live root
   immediately.
2. The first trusted prompt anchor fixes `startedAt`; delayed OTLP evidence may
   strengthen identity but must not rewind an already-published run.
3. Reconcile the hook query with `prompt.id` and the interaction trace through
   exact session/trace facts and a bounded fallback window.
4. Never require prompt text for identity.
5. Session processes such as `agents_view`, setup, compaction-only work, or
   other documented auxiliary activity must not create public roots.

### Completion

1. Treat a Claude `Stop` as a high-confidence completion candidate, not
   unconditionally as final authority.
2. A Stop with active `background_tasks` or actionable `session_crons` keeps the
   run open or settling.
3. A Stop or SubagentStop that another hook blocks must not close the root or
   child. Determine this from the subsequent native lifecycle and closed trace,
   not from response text.
4. A closed root `claude_code.interaction` span is authoritative when its native
   ordering proves the turn truly ended.
5. `StopFailure` should end the run as a failed provider termination when exact
   identity is available. Preserve structured error category only if allowed by
   the provider-neutral contract.
6. A user interrupt or missing completion surface must use an explicitly
   documented fallback and non-final coverage. Do not silently label it success.

### Usage and estimated cost

1. Sum each unique Claude API request once by stable request identity.
2. Reconcile log and trace copies of the same request. Prefer the surface with
   the complete token vector and strongest root/child lineage.
3. Track input, output, cache read, cache creation, reasoning if Claude begins
   exporting it, and total tokens independently.
4. Select authority separately for root and each child before folding.
5. Keep retries and terminal API errors from becoming successful duplicate
   usage rows.
6. Treat `cost_usd` as a provider-reported estimate. Keep expected billed cost
   unavailable when auth/billing context is unproven.
7. Auxiliary requests with exact run lineage may become explicit overhead or
   unallocated run usage. They must not become separate customer runs.

### Subagents, teams, and workflows

1. Normalize hook/trace `agent_id` into an opaque child-session identity.
2. Use span parentage, Agent tool `tool_use_id`, and `parent_agent_id` as exact
   lineage. Timing and same-name matching are not authority.
3. Recursively fold linked child and nested-child work into the public root once.
4. Preserve child tools, failures, unknown outcomes, token vectors, and parent
   activity IDs.
5. A same-name group reports complete trace-descendant usage only when all
   represented children are exact.
6. Keep unmatched children separate or unavailable. Never force them onto the
   nearest root.
7. Add workflow/team grouping only after a supported native version and fixture
   prove `workflow.run_id` semantics.

### Tools, skills, and MCP

1. Deduplicate hook, event, and span evidence by `tool_use_id`.
2. `PostToolUse` plus native successful tool result is success.
3. `PostToolUseFailure`, failed tool result, or error span is failure unless a
   structured interrupt/rejection field proves rejection.
4. A rejected permission decision is not a failed execution and must not create
   a successful tool result.
5. Merge `skill_activated`, Skill tool, and skill-attributed requests into one
   semantic skill activity without double counting.
6. Attribute request tokens to a skill, MCP call, or subagent only with exact
   native ownership. Keep the remainder explicit.

### Files and commits

1. Successful structured Edit, Write, or NotebookEdit path evidence may create
   an opaque causal artifact key.
2. Rejected or failed writes create no causal artifact claim.
3. A Bash command, shell output, or nearby workspace delta is not exact path
   evidence. Do not parse command text to invent it.
4. FileChanged and snapshots may corroborate state and commit continuity but do
   not independently prove run authorship.
5. Resolve repo-relative paths only at outbound projection after `PrivacyGuard`.
6. Handle worktrees and multiple watched repositories record by record. Unknown
   or conflicting routes remain local.

## Construct Ownership

Keep the program inside existing constructs unless the JTBD genuinely changes.

| Construct | Claude optimization responsibility | Primary code |
| --- | --- | --- |
| `TelemetrySourceConfiguration` | enhanced-trace gate, explicit content gates, required hooks, version/source readiness, exact restore | `packages/agent/src/sourceConfiguration.ts`, `packages/agent/src/index.ts` |
| `TelemetryIngress` | bounded loopback receipt, per-record repository routing, transient workspace/path resolution | `packages/agent/src/otlpIngress.ts`, `packages/agent/src/index.ts` |
| `RunCorrelationLedger` | prompt ID, session, request, agent, parent-agent, workflow, and completion-candidate identity | `packages/engine/src/telemetryClassification.ts`, storage package |
| `TelemetryClassification` | Claude native schema to metadata-only lifecycle, usage, activity, and execution atoms | `packages/engine/src/telemetryClassification.ts` |
| `PrivacyGuard` | discard hook/OTLP content before durable append; validate outbound arithmetic and allowlist | `src/privacy/privacyGuard.ts` |
| `UsageProjection` | request deduplication, child authority, recursive folding, skill/MCP usage, token conservation | `packages/engine/src/shadowUsage.ts`, `packages/agent/src/productionUsageService.ts` |
| `RepositoryObservation` and attribution | watched repo identity, opaque artifact keys, causal files, worktrees, commits | `packages/agent/src/repositoryObservationService.ts`, `src/attribution/` |
| `ExternalWebhookDispatch` | immediate lifecycle, fixed terminal deadline, per-run ordering, corrections, durable retry | `packages/agent/src/externalWebhookDispatch.ts` |
| `Diagnostics` | source, observation, projection, queue, delivery, and coverage latency without raw content | `packages/agent/src/index.ts`, contract diagnostics |

If construct ownership or a cross-construct contract changes, update
`constructs.md` in the same change.

## Investigation Method: Four Ledgers

Every native acceptance run should be reconciled across four independent
ledgers:

1. **Provider hook ledger**
   - event name,
   - receipt timestamp,
   - opaque session/request/agent IDs,
   - tool/subagent names,
   - structured outcome state,
   - background task counts,
   - no content fields in retained evidence.
2. **Provider OTLP ledger**
   - interaction trace topology,
   - prompt ID,
   - request IDs and token vectors,
   - tool-use IDs and outcomes,
   - agent/parent-agent/workflow IDs,
   - skill and MCP identities,
   - source export timestamps.
3. **Tirion durable safe ledger**
   - query occurrences,
   - usage atoms,
   - activity atoms,
   - execution nodes,
   - repository key and opaque artifacts,
   - production run projection,
   - outbox rows and diagnostics.
4. **Receiver ledger**
   - ordered canonical lifecycle events,
   - versions and event IDs,
   - root and child activity,
   - exact token dimensions,
   - models and estimated cost coverage,
   - files,
   - delivery timestamps.

The live-run report must show where every receiver value came from and where any
provider evidence was intentionally excluded.

### Privacy handling for native capture

- Capture raw provider payloads only in a disposable private temporary directory.
- Never add raw payloads, transcripts, prompts, responses, commands, tool bodies,
  or file contents to git.
- Derive a metadata-only fixture with synthetic IDs and canary values.
- Scan the Tirion database, logs, diagnostics, receiver, and fixture output for
  every canary.
- Delete the raw capture after deriving and reviewing the safe fixture unless an
  explicit local retention policy says otherwise.

## Program Phases

### Phase 0: Establish a reproducible baseline

Tasks:

- land or intentionally baseline the Codex optimization work,
- create the Claude branch from that exact commit,
- record `git rev-parse HEAD`, Claude version, Node version, OS, auth mode, and
  model,
- run `npm run check`,
- run current Claude read-only and write lifecycle scenarios,
- snapshot Tirion-managed Claude source status and existing user settings
  ownership without storing secrets,
- confirm the webhook receiver and agent begin with empty queues.

Exit criteria:

- baseline SHA and environment are recorded,
- current tests pass,
- current behavior and known failures are reproducible,
- no unrelated local changes are discarded.

### Phase 1: Native Claude source census

Start with native capture before production edits.

Scenarios:

- one read-only prompt,
- one successful Read tool,
- one successful Edit or Write,
- one failed Bash or tool operation,
- one rejected/denied tool operation,
- one direct subagent,
- one skill invocation and one control run where the skill exists but is unused.

Use and extend:

- `local-harnesses/provider_native_activity_surface_test.sh`,
- `local-harnesses/provider_native_skill_usage_test.sh`,
- `local-harnesses/provider_skill_activity_stress_test.sh`,
- `local-harnesses/otlp_capture_receiver.mjs`.

Deliverables:

- a versioned Claude native surface inventory,
- ordering and latency table for hooks/logs/traces,
- exact field availability by scenario and CLI mode,
- safe synthetic classification fixtures,
- a list of facts, unsupported fields, and unresolved hypotheses.

Exit criteria:

- every proposed accepted field is fixture-backed,
- no production authority is based only on documentation,
- content-bearing fields and privacy handling are enumerated.

### Phase 2: Source readiness and privacy gates

Tasks:

- manage and restore `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`,
- status-check the gate independently from exporter text,
- explicitly keep prompts, assistant responses, raw API bodies, and tool content
  disabled,
- decide whether `OTEL_LOG_TOOL_DETAILS=1` is required for exact skill, MCP,
  subagent type, and write path metadata,
- add only lifecycle hooks proven necessary, beginning with `StopFailure`,
- preserve foreign exporters and existing hook ordering,
- report partial or unavailable readiness when a required surface is absent,
- verify config drift and restore behavior against pinned versions.

Exit criteria:

- activation never reports trace readiness without a real trace-capable setup,
- configure/status/restore tests cover every owned field,
- a real prompt produces expected loopback receipts,
- no content gate is enabled accidentally.

### Phase 3: Root identity and lifecycle authority

Tasks:

- reconcile UserPromptSubmit, `prompt.id`, and interaction trace identity,
- fix `startedAt` to the first trusted prompt anchor,
- classify blocked Stop and active-background Stop as non-terminal,
- classify closed interaction and final allowed Stop ordering,
- add `StopFailure` and interruption coverage,
- persist an internal marker for non-customer Claude processes,
- keep restart identity stable,
- prove one public root under delayed/out-of-order evidence.

Exit criteria:

- exactly one public run per submitted prompt,
- no response/API call ends the run,
- blocked or paused Stop does not emit a false terminal,
- a final terminal arrives after real completion,
- internal processes never become public later.

### Phase 4: Child, team, and workflow lineage

Tasks:

- map hook and trace `agent_id` to one opaque child identity,
- retain exact `parent_agent_id` recursively,
- join Agent tool `tool_use_id` with child spans and hooks,
- reconcile start/stop revisions without double counting,
- fold direct and nested children exactly once,
- preserve unknown outcomes when stop completion is not proven,
- test same-name groups and ambiguous/missing links,
- upgrade Claude deliberately before testing `workflow.run_id` features,
- add team/workflow support only after native fixtures pass.

Exit criteria:

- one, three, four, and nested child scenarios conserve exactly,
- child public runs are suppressed only with exact lineage,
- partial linkage remains unavailable,
- team/workflow identities do not leak into unrelated roots.

### Phase 5: Usage, models, context, and estimated cost

Tasks:

- deduplicate API request log and LLM trace copies by request identity,
- verify retry behavior and failed requests,
- select root and child authorities independently,
- conserve all available token dimensions,
- retain exact model sets and provider identity,
- classify subscription/direct/Bedrock/Vertex billing context only from evidence,
- preserve provider `cost_usd` as an estimate,
- define explicit handling for auxiliary and compaction usage,
- ensure activity-level usage sums to the top-level run.

Exit criteria:

- Tirion totals equal the native Claude request ledger,
- no retries or corroborating surfaces double count,
- root plus children equals the public run in every dimension,
- incomplete billing evidence never produces confident billed cost.

### Phase 6: Tools, skills, MCP, outcomes, and files

Tasks:

- merge tool hook/log/trace evidence by `tool_use_id`,
- distinguish success, failure, rejection, and unknown,
- integrate `claude_code.skill_activated` into production,
- merge Skill tool and request-level `skill.name` usage,
- classify MCP server/tool metadata provider-neutrally,
- derive opaque artifact keys only from successful structured write evidence,
- test repeated writes, multi-file edits, failed edits, and Bash writes,
- keep FileChanged and snapshots corroborating rather than causal,
- verify commit attribution excludes read-only and failed-write runs.

Exit criteria:

- counts and outcomes match native evidence exactly,
- skill/MCP/subagent usage does not disappear or duplicate,
- files contain only causally proven relative paths,
- privacy canaries are absent everywhere.

### Phase 7: Real-time delivery and recovery

Tasks:

- measure source emission, Tirion acceptance, queue, HTTP attempt, receiver, and
  final correction separately,
- verify lifecycle-first priority under concurrent runs,
- keep the fixed three-second first-terminal deadline,
- trigger query-family completion independently from global quiet/rebuild work,
- verify per-run serialization and strict ordering,
- stress receiver downtime, timeout, retry, restart, backlog, historical replay,
  workspace scans, and commit reconciliation,
- keep semantic terminal authority monotonic across alternating projections.

Exit criteria:

- starts and terminals meet latency targets,
- one run cannot block another behind enrichment,
- retries survive restart without duplicates or ordering loss,
- durable queue and blocked counts return to zero.

### Phase 8: Freeze regression coverage and close the spike

Tasks:

- add redacted native parser fixtures for the minimum and current supported
  Claude versions,
- add Claude scenarios to the complex safe-observation fixture matrix,
- add deterministic usage and webhook tests,
- extend the local Claude lifecycle system harness,
- add pinned native Claude runs to an opt-in nightly/release matrix,
- update `constructs.md`, webhook docs, harness monitoring docs, and the spike
  outcome report,
- run `npm run check` and the full live matrix,
- review the diff for hidden provider coupling and privacy regressions.

Exit criteria:

- every discovered defect has a deterministic regression,
- deterministic tests run in CI,
- native tests record exact provider version and are release-gated,
- no unresolved high-integrity defect is described as complete.

## Scenario Matrix

| ID | Scenario | Primary invariant |
| --- | --- | --- |
| `CC-00` | read-only root | one lifecycle, no files, exact root usage |
| `CC-01` | one successful Edit/Write | one causal relative file and successful tool |
| `CC-02` | failed write | failure count increments, no causal file |
| `CC-03` | rejected tool | rejection is not execution success or failure |
| `CC-04` | deliberate non-zero Bash | structured failure if exported; otherwise honest unknown |
| `CC-05` | one Explore/custom subagent | one exact child folded once |
| `CC-06` | three same-name parallel children | complete group only with three exact links |
| `CC-07` | four same-name children plus two files | exact child aggregate, root residual, and two causal files |
| `CC-08` | nested child spawns child | recursive parentage and one public root |
| `CC-09` | missing SubagentStop | usage lineage may be complete while outcome remains unknown |
| `CC-10` | SubagentStop blocked then allowed | first attempt cannot finalize child |
| `CC-11` | Stop blocked then allowed | first attempt cannot finalize root |
| `CC-12` | Stop with background subagent/shell | run remains open or settling until background work completes |
| `CC-13` | StopFailure/API terminal error | failed terminal, no false completion success |
| `CC-14` | user interrupt | explicit non-success fallback and bounded lifecycle behavior |
| `CC-15` | skill exists but unused | zero skill activity |
| `CC-16` | direct Skill tool invocation | one skill activity and exact attributed requests |
| `CC-17` | slash/nested skill | trigger and usage attribution without duplicate Skill rows |
| `CC-18` | MCP success/failure | exact server/tool, call ID, outcome, and usage |
| `CC-19` | repeated writes to one file | one unique file, multiple tool calls |
| `CC-20` | Bash creates a file | no path claim without structured causal evidence |
| `CC-21` | two watched repositories in one OTLP batch | each record routes exactly or fails closed |
| `CC-22` | worktree child | correct watched repo/worktree identity and relative files |
| `CC-23` | delayed/duplicated/out-of-order OTLP | one semantic run and stable versions |
| `CC-24` | restart before terminal delivery | durable recovery and one ordered terminal |
| `CC-25` | receiver timeout/retry | bounded attempt and idempotent replay |
| `CC-26` | concurrent fresh run plus historical backlog | fresh lifecycle preempts stale work |
| `CC-27` | workflow/team run on supported version | exact workflow grouping and nested usage |
| `CC-28` | auxiliary/compaction request | no separate public run; explicit overhead policy |

## Representative Native Prompts

These are synthetic test prompts. Adjust them only when the native harness cannot
produce the intended shape, and record the exact submitted prompt outside
Tirion's product data.

### Read-only control

```text
Inspect this disposable repository using Read, Glob, and Grep. Do not modify any
files. Return a short summary, then stop.
```

### One child

```text
Launch exactly one Explore subagent to inspect the test layout. Wait for it to
finish, verify one finding yourself with a read-only tool, then stop. Do not edit
files.
```

### Three same-name children

```text
Launch exactly three Explore subagents in parallel. Assign one to source layout,
one to tests, and one to configuration. Wait for all three. Run one read-only
shell command in the root, summarize their findings, then stop. Do not edit
files.
```

### Four children and multi-file writes

```text
Launch exactly four Explore subagents in parallel and wait for all four. Give
each a distinct read-only repository question and ask each to run one read-only
shell command. In the root, create fixtures/claude-four-child-a.txt and
fixtures/claude-four-child-b.txt using structured file-edit tools, then update
both once more with a second structured edit. Run one successful and one
deliberately failing read-only shell command. Verify the two final files and stop.
```

### Skill control and invocation

```text
A disposable skill named tirion-claude-integrity-probe exists. Do not invoke any
skill. Inspect README.md and stop.
```

```text
Invoke the tirion-claude-integrity-probe skill exactly once, follow its
instructions, then stop.
```

The harness must independently verify what actually happened. Prompt intent is
not evidence that the expected children, tools, or files occurred.

## Acceptance Invariants

### Lifecycle and identity

- exactly one `run.start`,
- at least one meaningful `run.update`,
- at least one `run.ended`,
- no update after the first terminal,
- stable `runId`, repository, `startedAt`, harness, and runtime,
- contiguous terminal versions beginning at 1,
- unique event IDs and idempotency keys,
- no duplicate terminal meaning after removing event ID and version,
- no standalone public lifecycle for exactly linked children,
- no public lifecycle for internal or auxiliary processes.

### Usage and activity

- top-level total equals input plus output,
- every exported token dimension equals the selected native ledger,
- root plus exact children equals the public run,
- activity rows conserve each top-level token dimension,
- one native request appears once,
- one native tool call appears once,
- one skill invocation appears once,
- failure plus unknown never exceeds count,
- exact child count is required for complete same-name attribution,
- unallocated usage remains explicit,
- model/provider and billing context stay distinct.

### Files and attribution

- read-only runs have no files,
- successful structured writes expose only proven relative files,
- failed/rejected writes expose no file claim,
- repeated writes do not duplicate the file list,
- snapshot-only changes do not become run files,
- commit attribution links only causally contributing runs,
- multi-repo and worktree routes never cross-contaminate.

### Privacy

- no prompt or response canary in database, log, diagnostic, fixture, or receiver,
- no tool argument/output or command canary,
- no file-content or diff canary,
- no transcript path,
- no absolute repository path,
- no raw OTLP or hook payload,
- no sensitive Stop/background task descriptions,
- only allowlisted relative paths cross the webhook boundary.

### Delivery and durability

- strict start-before-update-before-ended ordering,
- per-run serialization under concurrency,
- lifecycle priority over enrichment and historical work,
- bounded HTTP attempts and durable retry,
- restart recovery without duplicate meaning,
- zero queued and blocked rows after successful completion,
- later correction only when semantic authority improves,
- semantic child/file/outcome authority never downgrades.

## Latency Measurement And Targets

Record these timestamps independently:

- `T_submit`: test harness submits the prompt,
- `T_hook_accept`: Tirion accepts UserPromptSubmit,
- `T_start_attempt`: Tirion begins the start webhook HTTP attempt,
- `T_start_receive`: receiver records `run.start`,
- `T_stop_accept`: Tirion accepts final completion evidence,
- `T_interaction_close`: Tirion observes the closed authoritative interaction,
- `T_terminal_receive`: receiver records the first `run.ended`,
- `T_final_receive`: receiver records the final authoritative terminal version.

Report separate latency components:

- provider source delay: `T_hook_accept - T_submit`,
- Tirion start delay: `T_start_receive - T_hook_accept`,
- first terminal delay: `T_terminal_receive - authoritative completion`,
- final truth delay: `T_final_receive - authoritative completion`,
- queue latency and observation latency from Tirion diagnostics.

Initial program targets:

- Tirion acceptance-to-receiver `run.start` p95 <= 500 ms on loopback,
- live update acceptance-to-attempt p95 <= 750 ms outside receiver contention,
- first terminal <= 5 seconds after authoritative completion,
- target first terminal near the fixed 3-second deadline,
- final grouped terminal <= 5 seconds when all native evidence arrived before
  the deadline,
- otherwise an honest non-final terminal followed by a bounded correction within
  the existing 15-second horizon,
- no latency benchmark may combine provider emission delay, Tirion queue delay,
  and receiver event-loop delay into one unexplained number.

Use a receiver process separate from dashboard indexing for p95 measurements.

## Regression Architecture

Build five layers of protection:

1. **Native schema fixtures**
   - redacted/synthetic Claude hook and OTLP JSON,
   - version-tagged,
   - parser and privacy assertions,
   - minimum-supported and current-supported Claude versions.
2. **Safe-observation scenario fixtures**
   - root, child, nested child, skills, tools, usage, outcomes, artifacts,
   - no raw content,
   - provider-specific evidence mapped into provider-neutral atoms.
3. **Engine contract tests**
   - authority selection,
   - request deduplication,
   - recursive folding,
   - token and outcome conservation,
   - internal exclusion.
4. **Webhook and storage tests**
   - ordering,
   - terminal versions,
   - files,
   - privacy,
   - retry/restart/priority,
   - bounded query-family reads.
5. **Pinned native system matrix**
   - real Claude CLI runs in disposable repos,
   - exact version and model recorded,
   - opt-in nightly and release gate,
   - provider ledger compared to receiver ledger.

Deterministic layers belong in the normal CI gate. Native model-driven runs
belong in a separately reported pinned matrix because model behavior and network
availability are not deterministic.

## Diagnostics Required For The Spike

Add or verify privacy-safe diagnostics for:

- source configuration and enhanced trace gate state,
- first hook receipt per run,
- first OTLP receipt per signal,
- prompt-hook to prompt-ID reconciliation,
- completion candidate and final authority selection,
- active background task count without descriptions/commands,
- child link accepted/rejected reason,
- request deduplication authority,
- unallocated usage reason,
- query-family projection duration and queue latency,
- first terminal deadline and correction horizon,
- webhook queue/attempt/receiver timing,
- repository route missing/conflict,
- causal artifact accepted/dropped reason,
- internal-session exclusion,
- source schema/version mismatch.

Diagnostics must explain reduced coverage without exposing raw provider content.

## Debugging Decision Tree

| Symptom | Inspect first | Owning construct |
| --- | --- | --- |
| no `run.start` | hook config, enhanced gate, hook receipt, repo route | Source Configuration / Ingress |
| two public roots | hook-to-prompt-ID reconciliation, internal marker | Correlation Ledger |
| run ends before child/background work | blocked Stop, background tasks, interaction close | Classification / Usage Projection |
| child published separately | `agent_id`, parent span, Agent tool call linkage | Correlation / Usage Projection |
| missing child tokens | request `agent_id`, authority selection, child fold | Classification / Usage Projection |
| inflated tokens | duplicate log/trace request identity or retries | Usage Projection |
| false tool success | tool result, failure hook, permission decision | Classification |
| skill count/usage missing | skill event, Skill tool, request `skill.name` | Classification / Usage Projection |
| file missing | successful structured write path and artifact key | Ingress / Attribution |
| unrelated file included | snapshot-only or Bash/timing heuristic | Attribution |
| terminal late | query-family lane, storage contention, outbox priority | Runtime / Dispatch / Storage |
| event queued forever | durable deadline, retry timer, HTTP timeout | Dispatch / Storage |
| sensitive canary found | raw ingress retention or outbound allowlist | PrivacyGuard |

## Prioritized Engineering Backlog

### P0

- manage and verify enhanced telemetry trace gate,
- build native Claude surface census and fixtures,
- correct Stop/background/blocked-stop completion semantics,
- add StopFailure handling,
- preserve privacy under content-bearing hook payloads.

### P1

- exact `agent_id` and `parent_agent_id` lineage,
- request log/trace deduplication and full token conservation,
- skill activation plus skill-attributed usage,
- tool outcome and call-ID integrity,
- causal files for structured write tools,
- Claude complex-run safe fixtures and webhook replays,
- live three-child and four-child acceptance.

### P2

- nested agents and ambiguous-link failure modes,
- worktree and multi-repository stress,
- workflow/team support after version upgrade,
- interruption, retry exhaustion, and auxiliary-request policy,
- cross-version native matrix,
- latency histogram and release SLO reporting.

## Explicit Non-Goals

- prompt or response analytics,
- transcript storage or parsing as a product data source,
- command/output scraping,
- heuristically claiming Bash file paths,
- making estimated cost look like billing truth,
- adding Claude-only public webhook fields without a shared contract decision,
- weakening privacy to make a stress scenario easier,
- native UI automation before stable CLI and hook contracts are accepted,
- supporting undocumented private Claude internals when public hooks/OTLP suffice.

## Definition Of Done

The Claude optimization program is complete only when:

1. source setup, status, restore, and version compatibility are accurate,
2. prompt start, blocked/paused completion, final completion, and failure
   completion are fixture-backed,
3. direct, parallel, same-name, and nested children fold exactly once,
4. tools, skills, MCP calls, outcomes, and token usage match native evidence,
5. all token dimensions conserve at root, child, and activity levels,
6. files are causal, relative, deduplicated, and privacy-safe,
7. starts and terminals meet measured latency targets under load and recovery,
8. retries and restarts preserve ordering and idempotency,
9. privacy canaries are absent from every durable and outbound surface,
10. every discovered defect has a deterministic regression,
11. the live pinned Claude matrix passes at the supported versions,
12. `npm run check` passes,
13. `constructs.md` and public monitoring/webhook documentation match reality,
14. the final report distinguishes proven support, unsupported evidence, and
    residual risk.

## Evidence Log Template

Add one row per native discovery or acceptance run.

| Date | Claude version | Scenario | Prompt anchor -> hook | Hook -> start | Final authority -> terminal | Root/children | Tokens | Tools/skills/MCP | Files | Privacy | Outcome / defect |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | | | | |

## Decision Log Template

Record every authority decision that affects customer truth.

| Date | Question | Native evidence | Decision | Owning construct | Tests/fixtures | Revisit trigger |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

## Required Reading For The New Task

Local architecture and evidence:

- `AGENTS.md`
- `constructs.md`
- `docs/spikes/webhook-lifecycle-optimization.md`
- `docs/harness-run-monitoring.md`
- `docs/webhooks.md`
- `test-fixtures/complexChildAgentScenarios.ts`
- `packages/engine/src/complexChildAgentScenarios.test.ts`
- `packages/agent/src/externalWebhookDispatch.test.ts`
- `packages/agent/src/sourceConfiguration.ts`
- `packages/engine/src/telemetryClassification.ts`
- `packages/engine/src/shadowUsage.ts`
- `packages/agent/src/productionUsageService.ts`
- `packages/agent/src/externalWebhookDispatch.ts`
- `local-harnesses/provider_native_activity_surface_test.sh`
- `local-harnesses/provider_native_skill_usage_test.sh`
- `local-harnesses/provider_skill_activity_stress_test.sh`
- `local-harnesses/tirion_local_server_dual_provider_lifecycle_test.sh`

Official provider contracts:

- [Hooks reference](https://code.claude.com/docs/en/hooks)
- [Monitoring and OpenTelemetry](https://code.claude.com/docs/en/monitoring-usage)
- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [Tools reference](https://code.claude.com/docs/en/tools-reference)

## Final Operating Principle

The program should not ask whether Claude can be made to look like Codex. It
should ask what Claude Code natively proves, preserve that proof through the
shared Tirion constructs, and expose no more and no less certainty than the
provider evidence supports.
