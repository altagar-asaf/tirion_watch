# Constructs

This project is organized around JTBD-led constructs. A construct is a software
module with one primary Job To Be Done. Constructs may contain sub-constructs
when those smaller jobs are required to complete the parent job. Constructs
collaborate through explicit contracts, events, and data models.

Construct-first editing rules:

1. Edit an existing construct when its JTBD still fits and only needs to work better.
2. Split a construct only when the parent JTBD truly gains a new sub-job.
3. Add a construct only for a genuinely new JTBD.
4. Remove a construct when its JTBD is no longer required by the product.
5. Keep collaboration visible in contracts and composition roots, never hidden coupling.

## Current Product JTBDs

Measure local agentic software-development usage for explicitly watched
repositories, conservatively attribute verified commits, and emit privacy-safe
local webhook events for run lifecycle activity and attributed commits.

The active product is local-only:

- No Tirion-back dependency is required on the happy path.
- No GitHub Check publishing is part of the active architecture.
- No organization accounting sync is part of the active architecture.
- No organization execution sync is part of the active architecture.
- No remote backend-to-agent control line is part of the active architecture.
- No VS Code extension or VS Code-specific adapter is part of this OSS branch.
- No prompt drilldown, execution-content export, or content-heavy audit surface
  is part of the active architecture.

The local boundary ends at:

- accepted local telemetry,
- authoritative completed-run assembly,
- conservative repository-scoped commit attribution,
- durable local webhook delivery state,
- canonical run lifecycle webhook projection,
- privacy-safe diagnostics and local control surfaces.

## Current Runtime Flow

`packages/agent/src/index.ts` composes the active local-only runtime:

`TelemetrySourceConfiguration -> TelemetryIngress -> PrivacyGuard -> TelemetryClassification -> SafeObservationJournal + RunCorrelationLedger -> UsageProjection -> RunLedger`

`MeasurementActivation -> RepositoryScopeManagement + TelemetrySourceConfiguration + RepositoryObservation + Diagnostics`

`TelemetryIngress accepted safe observations + RepositoryObservation trusted repo identity -> ExternalWebhookDispatch live lifecycle lane -> durable local outbox -> HTTP webhook sink`

`RunLedger + RepositoryObservation + WorkspaceChangeTracker + AgenticWorkEpisode -> GitAttribution -> verified commit attribution + publication snapshots`

`RunLedger completed runs + verified commit attribution + RepositoryObservation repo identity + PrivacyGuard outbound validation -> ExternalWebhookDispatch -> durable local outbox -> HTTP webhook sink`

Important active runtime rules:

- Only explicitly approved repositories are observed.
- Completed-run assembly selects authoritative terminal usage and activity. A
  high-confidence explicit completion may emit a repository-bound provisional
  terminal event after its fixed grace period; that event keeps non-final
  coverage and a later authoritative projection publishes a higher version.
  `final` coverage describes the closed authority represented by that published
  snapshot, not an immutability promise: late-delivered evidence that began no
  later than the same completion boundary may still publish a higher terminal
  replacement.
- Start, update, and explicit-terminal live lifecycle events may be projected
  from earlier safe run identity when provider hooks expose it.
- Live lifecycle projection, workspace evidence processing, usage projection,
  and completed-run lifecycle projection use independent scheduler lanes so
  slow enrichment work does not hold accepted start, update, or explicit
  terminal observations. Terminal admission only projects and durably queues;
  it never awaits outbound HTTP, so an in-flight update attempt cannot keep an
  accepted terminal out of the outbox.
- Event-triggered and periodic usage rebuilds wait for a five-second live-ingress
  quiet window. This keeps the shared durable storage worker available through
  the three-second explicit-terminal deadline while live webhook projection
  continues immediately.
- Each explicit terminal also schedules a query-family projection at its own
  fixed deadline. It reads only the root and linked child identities, atoms, and
  activities, atomically upserts that completed run, and enters the fresh
  lifecycle lane without waiting for a global rebuild or attribution replay.
- For Claude, only the exact eligible Stop/closed-root interaction join starts
  terminal work; Stop alone remains nonterminal. Once that join exists, its
  query-family projection is immediate and may durably queue terminal meaning
  while a same-run update HTTP attempt is still in flight.
- Repository-scoped run delivery fails closed when repo binding is missing or ambiguous.
- Commit attribution stays conservative and proof-based; timestamps and filenames
  alone never create a reportable claim.
- Prompt text, response text, tool inputs/outputs, file contents, diffs, raw
  telemetry payloads, and absolute paths never persist or leave the machine.
- Repo-relative changed file paths may leave the machine only through the
  webhook boundary after `PrivacyGuard` allowlisting.

## Current Coding Harness Support

The active measurement-provider contract is:

- `SupportedProvider = "claude-code" | "codex" | "github-copilot" | "cursor"`.
- `ConfigurableProvider = "claude-code" | "codex" | "cursor"`.
- GitHub Copilot is a supported measurement provider, but not a Tirion-managed
  configurable provider in this branch.

| Coding harness | Current local support | Source authority | Primary safe source IDs | Cost posture |
| --- | --- | --- | --- | --- |
| Claude Code | Tirion can configure, status-check, and restore managed local OTLP logs and enhanced traces. Trace readiness requires the native enhanced-telemetry gate and a managed 250 ms `OTEL_TRACES_EXPORT_INTERVAL`; the compatible generic batch delay is retained at the same value. Prompt and assistant-response capture default off; tool details may be enabled; tool content and raw response bodies default off. | `TelemetrySourceConfiguration` owns managed config; `TelemetryIngress` accepts approved loopback telemetry. | `hook_claude_code_lifecycle`, `hook_claude_code_tools`, `otlp_claude_code_logs`, `otlp_claude_code_traces` | Direct Anthropic estimates only when billing context evidence supports it; otherwise usage may remain unpriced. |
| Codex | Tirion can configure, status-check, and restore managed local OTLP logs and traces, plus safe local hook relay surfaces needed for lifecycle/activity metadata. Prompt capture defaults off. | `TelemetrySourceConfiguration` owns managed config; `TelemetryIngress` accepts approved loopback telemetry. | `hook_codex_lifecycle`, `hook_codex_tools`, `hook_codex_internal`, `otlp_codex_logs`, `otlp_codex_traces`, `otlp_codex_metrics` | Direct OpenAI estimates only when verified auth-mode evidence proves direct API billing; subscription usage stays usage-valued but not billed-cost estimated. |
| Cursor | Tirion can configure, status-check, and restore managed user-scope Cursor hooks through a private same-machine command relay. Prompt, command, tool payload, path, and file-content capture stay off; lifecycle hooks define run identity/timing and activity hooks define metadata-only tool/file-edit evidence. | `TelemetrySourceConfiguration` owns managed `hooks.json` entries and relay installation; `TelemetryIngress` accepts approved provider-hook JSON and optional approved Cursor OTLP JSON. | `hook_cursor_lifecycle`, `hook_cursor_tools`, `otlp_cursor_logs`, `otlp_cursor_traces` | Cursor Auto/Composer estimates use the verified Cursor catalog when model and token evidence match; other hook-only Cursor usage remains unpriced unless provider-reported cost evidence is present. |
| GitHub Copilot | Tirion supports operator-configured span DB replay and approved Copilot OTLP JSON source registration. Tirion does not silently mutate VS Code Copilot settings or claim direct protobuf support in the active happy path. | `TelemetrySourceConfiguration` reports readiness from configured span DB or observed approved sources; `TelemetryIngress` owns span DB replay and approved OTLP JSON ingestion. | `span_db_github_copilot_logs`, `span_db_github_copilot_traces`, `otlp_github_copilot_logs`, `otlp_github_copilot_traces` | GitHub Copilot catalog estimates use verified GitHub pricing rows when model and token evidence match; unknown or mixed models keep cost coverage partial or unavailable. |

Cross-harness invariants:

- Repository scopes are provider-neutral. Provider selection during activation
  chooses/checks source readiness; it does not become repository identity.
- `codingHarness` on outbound webhook events is the measured provider/runtime
  that produced the safe run, not the underlying LLM model provider.
- `ModelProviderResolution` may identify OpenAI, Anthropic, Google, GitHub,
  Microsoft, or Cursor model families underneath a coding harness, but that does not
  change the coding harness identity.
- All supported harnesses share the same `run.start`, `run.update`,
  `run.ended`, and `commit.attributed` event shapes.

Primary test anchors for harness support:

- Configuration, activation, and source readiness:
  `packages/agent/src/index.test.ts`, `packages/tirionctl/src/index.test.ts`,
  and `packages/agent/src/sourceConfiguration.test.ts`.
- Ingress, normalization, classification, and privacy:
  `packages/agent/src/copilotSpanDbIngress.test.ts`,
  `src/ingestion/spanDbTelemetryIngestion.test.ts`,
  `src/normalization/telemetryNormalizer.test.ts`,
  `packages/engine/src/telemetryClassification.test.ts`, and
  `src/privacy/privacyGuard.test.ts`.
- Usage projection, authority selection, model-provider separation, and pricing:
  `packages/engine/src/shadowUsage.test.ts`,
  `packages/engine/src/complexChildAgentScenarios.test.ts`,
  `test-fixtures/complexChildAgentScenarios.ts`,
  `src/pricing/costEstimation.test.ts`, and
  `src/architecture/shadowCompatibility.test.ts`.
- Webhook lifecycle and commit attribution:
  `packages/agent/src/externalWebhookDispatch.test.ts`,
  `packages/agent/src/productionRunAttribution.test.ts`, and
  `src/attribution/gitAttribution.test.ts`.
- Local end-to-end lifecycle harnesses:
  `local-harnesses/tirion_local_server_dual_provider_lifecycle_test.sh` and
  `local-harnesses/tirion_local_server_github_copilot_lifecycle_test.sh`, plus
  `local-harnesses/tirion_local_server_cursor_hooks_lifecycle_test.sh` for
  deterministic Cursor hook-relay mimic coverage.

## Active Construct Map

- Measure and export privacy-safe local agentic usage for watched repositories
  - TelemetrySourceConfiguration
  - MeasurementActivation
  - TelemetryIngress
    - SafeObservationJournal
    - RunCorrelationLedger
  - TelemetryClassification
  - PrivacyGuard
  - UsageProjection
    - BillingContextResolver
    - ModelProviderResolution
    - CostEstimation
  - RunLedger
  - RepositoryScopeManagement
  - RepositoryObservation
  - WorkspaceChangeTracker
  - AgenticWorkEpisode
  - GitAttribution
  - ExternalWebhookDispatch
  - BudgetWarnings
  - Diagnostics
  - AgentRuntimeControl
    - RuntimeWorkScheduler
  - AgentClientGateway
  - UserSurface
  - AgentDistribution

Retired from the active architecture:

- GitHubCheckPublishing
- OrganizationAccountingSync
- OrganizationExecutionSync
- CostFactDrilldown
- CopilotTelemetrySource
- VSCodeExtensionConsumer

Retained only as compatibility or retirement code, not as active constructs:

- execution-tree content publication and drilldown paths
- backend publishing contracts and services
- backend accounting contracts and services
- backend execution-sync contracts and services
- VS Code extension package, commands, status views, and source adapters

## Construct Sections

### TelemetrySourceConfiguration

JTBD: Configure supported local runtimes to send approved telemetry surfaces to
the local Tirion agent without taking over a foreign exporter.

Primary code:

- `packages/agent/src/sourceConfiguration.ts`
- `packages/agent/src/index.ts`
- `packages/tirionctl/src/index.ts`
- `packages/agent-contract/src/index.ts`

Boundaries:

- The supported-provider list is a shared contract owned in
  `packages/agent-contract/src/index.ts`; changes to supported harnesses must
  update this construct map and the harness-specific test fixtures in the same
  assignment.
- Tirion-managed configuration currently applies to Claude Code, Codex, and
  Cursor. GitHub Copilot readiness is reported from operator-configured span DB
  replay or approved Copilot OTLP source registration.
- Never silently replace an unrelated exporter.
- Restore only fields Tirion recorded.
- Source status may include supported providers whose setup is operator-owned,
  such as GitHub Copilot span DB replay; readiness reporting does not imply
  Tirion may mutate that provider's local settings.
- Configure traces and logs separately when providers expose different
  authorities for usage and completion.
- Claude Code trace readiness requires both its general telemetry switch and
  `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`; an OTLP trace exporter without the
  enhanced gate is partial source configuration and reports
  `enhanced_traces_disabled`.
- Claude Code's managed trace surface requires its native
  `OTEL_TRACES_EXPORT_INTERVAL=250`; an absent or divergent valid value reports
  `trace_export_interval_unoptimized`. Tirion also keeps the compatible generic
  `OTEL_BSP_SCHEDULE_DELAY=250`; its drift reports
  `trace_batch_delay_unoptimized`. Invalid timing values fail closed. The exact
  prior numeric values or absences are private restore state and are restored
  only after the managed source shape still matches.
- Prompt capture defaults off.
- Claude Code assistant-response logging is explicitly managed rather than
  inheriting the prompt gate. Its prior `0`/`1`/absent state is restored
  exactly with the other owned content gates.
- Tool content, response content, raw API bodies, diffs, and file-content
  capture default off for the local-only slice.
- Provider hook setup belongs here only when it is needed for run completion,
  stable run identity, run lifecycle timing, or activity metadata.
- Managed command relays must forward the configured event identity and the
  harness session working directory only as transient ingress context. Relay
  upgrades must be detected by exact private-script content so an unchanged
  provider config cannot leave an obsolete relay active.
- Managed Codex hooks are active only when both their hook entries and the
  Codex `features.hooks` gate are enabled. Configure, status-check, and restore
  that gate as one owned source surface.
- Codex hook configuration is not measurement readiness until Codex reports the
  managed hooks as trusted. Probe the provider hook registry, return
  `hook_trust_required`/`hooks_disabled`/`hook_trust_status_unavailable`
  explicitly, and keep repository activation in `attention_required` until the
  user approves the exact managed commands.
- Managed lifecycle surfaces use prompt/start, explicit stop/session end, and
  subagent start/stop pairs when the harness exposes them. A partial pair is
  source drift, not authoritative lifecycle coverage. A session-scoped hook
  without an exact turn identity may still be configured for diagnostics, but
  cannot become completion authority merely because it is present.
- Claude Code lifecycle configuration also includes `StopFailure`, because the
  provider emits it instead of `Stop` for terminal API errors, and `SessionEnd`
  for bounded exit diagnostics. Claude `SessionEnd` carries only session scope
  and an allowlisted reason, so it never completes a root, creates a durable
  observation, or emits a lifecycle webhook. Readiness checks the exact managed
  URL, event header, timeout, and current local authorization while preserving
  foreign hook groups and their order.

### MeasurementActivation

JTBD: Take one local repository from not measurable to watched and source-ready
through one explicit user action.

Primary code:

- `packages/agent/src/index.ts`
- `packages/tirionctl/src/index.ts`
- `packages/agent-contract/src/index.ts`

Boundaries:

- `--provider auto|claude-code|codex|cursor|github-copilot` is an activation-time
  source-readiness choice, not a repository identity model.
- Orchestrate repository scope enrollment, source configuration, and repository
  observation through explicit contracts.
- Activation must surface the blocking construct instead of hiding it.
- Activation may select a provider automatically, but the decision must be
  explicit in the returned DTO.
- Repository activation is provider-neutral: one watched repository can receive
  runs from Codex, Claude Code, Cursor, GitHub Copilot, or any supported
  harness.
- Activation may select or accept a provider to configure/check a telemetry
  source, but that provider decision must stay in source readiness DTOs and must
  not become repository identity.
- Non-configurable providers such as GitHub Copilot may still be reported as
  source-ready through configured span DB or OTLP telemetry; the returned source
  status must state whether receipts are complete, pending, or unavailable.
- A source whose managed hooks still require provider trust is configured but
  not measurable. Activation must preserve the watched repository scope while
  returning the trust precondition instead of claiming readiness.

### TelemetryIngress

JTBD: Accept bounded same-machine telemetry, project it through the privacy
boundary, and durably acknowledge only approved observations.

Primary code:

- `packages/agent/src/copilotSpanDbIngress.ts`
- `packages/agent/src/otlpIngress.ts`
- `packages/agent-storage/src/index.ts`
- `packages/agent-storage/src/worker.ts`

Boundaries:

- Accept only approved loopback OTLP/HTTP JSON and approved provider-hook
  surfaces, including configured same-machine GitHub Copilot span DB replay.
- Harness-specific source IDs must stay allowlisted and explicit:
  `hook_claude_code_lifecycle`, `hook_claude_code_tools`,
  `otlp_claude_code_logs`, `otlp_claude_code_traces`,
  `hook_codex_lifecycle`, `hook_codex_tools`, `hook_codex_internal`, `otlp_codex_logs`,
  `otlp_codex_traces`, `otlp_codex_metrics`, `hook_cursor_lifecycle`, `hook_cursor_tools`,
  `otlp_cursor_logs`, `otlp_cursor_traces`, `otlp_github_copilot_logs`,
  `otlp_github_copilot_traces`, `span_db_github_copilot_logs`, and
  `span_db_github_copilot_traces`.
- GitHub Copilot direct OTLP support in the active product is approved JSON
  source registration and ingestion; protobuf decoding or managed VS Code
  mutation must not be implied by this construct.
- Apply auth, rate, size, and fan-out limits before durable append.
- Never store raw request bodies or arbitrary attributes.
- Acknowledge only after the privacy-safe observation is durable.
- Projection, webhook observation, and other downstream processing must not hold
  the telemetry acknowledgement path; they run as coalesced runtime work after
  durable append.
- Provider prompt/tool/subagent hooks may establish lifecycle identity and
  activity metadata, but must still project only privacy-safe observations.
- Normalize only allowlisted snake_case/camelCase hook identity aliases before
  classification. If a hook remains unusable, diagnostics may retain only its
  recognized event category, required-field presence, and an allowlisted
  normalized Claude `SessionEnd` reason, never raw IDs, paths, prompts, or tool
  data. Claude `SessionEnd` is diagnostic-only: it does not read a transcript,
  bind a repository, create a durable observation, or trigger downstream
  lifecycle work.
- On the allowlisted Claude `prompt_input_exit` reason, ingress may read only a
  capped count of unresolved background-paused roots still present in active
  in-memory correlation and record the private
  `claude_background_root_missing_terminal` diagnostic. The count contains no
  query, session, child, transcript, or repository identity; its bounded
  process-local keys are opaque and used only to count and clear live
  correlation. It cannot cause a source upsert, durable safe observation,
  terminal, or lifecycle/webhook work.
- Managed Claude handlers bind their configured event in
  `X-Tirion-Hook-Event`. When that recognized header and the recognized body
  event disagree, reject the request before transcript access or durable work;
  diagnostics retain only the two normalized event categories.
- For Claude `UserPromptSubmit`, read at most a bounded tail of the transcript
  named by the hook and only when both its lexical and real path remain under
  the configured Claude `projects` root. That root is derived from the resolved
  Claude settings path, including `CLAUDE_CONFIG_DIR`. Final symlinks, path
  escapes, non-files, and files that change during the read fail closed. Pass
  the tail transiently to `PrivacyGuard`; never append it or its locator.
- Claude 2.1.207 may append the matching transcript record only after its
  synchronous HTTP hook returns. When the immediate bounded read is unresolved,
  acknowledge the hook, retain only a bounded minimal non-content identity and
  locator in memory, and retry the same race-checked read for a bounded grace
  period. Prompt content and arbitrary hook fields are never retained. An
  unresolved final attempt still fails closed.
- While any Claude submission provenance retry is pending, Claude OTLP
  classification waits only for that same bounded grace period. This prevents a
  prompt log, intermediate closed interaction, or Stop from bypassing the
  delayed hook authority. The OTLP request resumes fail closed when the barrier
  expires; it never extends the transcript retention window.
- A closed Claude root trace waits through one short bounded continuation-settle
  interval before classification, then joins the pending-provenance barrier.
  This permits a task-notification hook that follows the close record by a few
  milliseconds to advance the continuation floor before terminal commitment.
- Minimal same-session hooks that arrive during one unresolved submission may
  be replayed only after that submission resolves. The buffer retains only
  allowlisted event identity, opaque prompt/tool/child aliases, structured work
  presence, and an allowlisted StopFailure category. The resolved transcript
  prompt alias may fill a missing hook alias. Overlapping unresolved
  submissions make the session buffer ambiguous, so buffered hooks are dropped
  instead of assigned by timing. One replay failure is isolated from later safe
  hooks and barrier release, and each safe replay gets one bounded durable retry.
  Retry state, hook buffers, and barriers are
  bounded in memory and discarded on restart.
- A normal non-interrupted Claude `PostToolUse` or `PostToolUseFailure` may use
  that delayed replay only for the exact bounded `mcp__server__tool` grammar
  classified by `TelemetryClassification`. Its buffer retains only the bounded
  MCP identity and existing safe aliases/timing; tool input, tool response, and
  `agentId` are discarded. All other non-Agent post-tool hooks remain
  interrupted-only while provenance is pending.
- Claude submission diagnostics may retain only one allowlisted provenance
  state (`human_typed`, `task_notification_system`, `unavailable`, or
  `ambiguous`) and, only when unresolved, one fixed non-content cause. Those
  causes distinguish transcript locator/trust/read states from bounded
  candidate, origin, and prompt-source matching states, but never retain error text, prompt IDs,
  timestamps, paths, or content. They are local `TelemetryIngress` diagnostics
  only and never enter a `SafeObservation` or webhook.
- Raw workspace paths and structured successful-write targets may be used only
  transiently at ingress. `RepositoryObservation` resolves them to an opaque
  watched `repositoryKey` and HMAC artifact keys before durable append; raw
  paths, patches, tool inputs, and file content are then discarded. Patch
  targets may be extracted from a provider's structured `patch` field or
  Codex's `tool_input.command` field, but the patch text itself never enters a
  safe observation.
- Direct OTLP JSON, provider hooks, and Copilot span DB replay share this
  transient repository/write-evidence contract. Missing or ambiguous evidence
  fails closed instead of becoming timestamp ownership.

#### SafeObservationJournal

Parent: `TelemetryIngress`

JTBD: Durably retain bounded privacy-safe observations until they are projected
into authoritative local ledgers.

Boundaries:

- Store metadata-only observations, usage atoms, and activity atoms.
- No raw telemetry, prompt text, response text, tool payloads, file content, or
  repository locators.
- Usage ownership is monotonic across upserts and restarts. Once an atom records
  conflicting opaque activity owners, later single-owner replay cannot erase
  that conflict; two different single-owner revisions synthesize the same
  bounded conflict witness and remove the resolved owner.
- Journal retention must not erase already-authoritative run history.

#### RunCorrelationLedger

Parent: `TelemetryIngress`

JTBD: Retain the minimal non-content identity needed to associate accepted
provider activity with the correct completed run.

Primary code:

- `packages/engine/src/telemetryClassification.ts`
- `packages/agent/src/otlpIngress.ts`
- `packages/agent-storage/src/index.ts`
- `packages/agent-storage/src/worker.ts`

Boundaries:

- Persist privacy-safe `queryId`, `sessionId`, explicit completion evidence,
  an evidence-backed provider-neutral completion outcome and allowlisted failure
  category when available, opaque repository identity, stable request identity,
  and opaque child-session linkage only.
- A Codex transcript locator may be inspected transiently to recover the actual
  opaque rollout session when a child hook reports its parent session. Persist
  only the hashed child and parent session identities, and reconcile a nearby
  fallback prompt event with its delayed submission hook instead of creating a
  second query. Later evidence may strengthen but never downgrade the retained
  lifecycle authority.
- Prompt text defaults to disabled and must not be required for run assembly.
- A model response is activity within a run, not terminal authority. Accepted
  provider-terminal/session hooks, a closed authoritative root/turn span, or a
  documented inactivity fallback are the only completion authorities.
- An ordinary Claude Code `Stop` is only a completion candidate. It becomes
  terminal only when the same opaque prompt/session also has a matching closed
  root `claude_code.interaction`. A nonempty `background_tasks` or
  `session_crons` collection invalidates the candidate. `stop_hook_active` is
  retained only as safe diagnostic metadata and is not terminal authority.
- Claude `SessionEnd` is session-scoped rather than prompt-scoped and can fire
  for clear, resume, logout, and session-switch flows. It is therefore a
  managed diagnostic surface only, never a Claude completion authority or a
  substitute for the exact Stop/closed-root join.
- Claude accepted-submission state, pending terminal halves, and completion are
  scoped to an opaque logical query, not to the whole session. The active
  session entry is only a routing pointer. A generated same-session
  `UserPromptSubmit` may alias only through the exact background-task target; a
  later human/typed prompt starts a distinct query. After either terminal half
  has arrived, the remaining half can release only the earlier query. Every
  completed prompt alias stays completed and cannot reopen.
- A production Claude submission hook becomes customer authority only when the
  bounded transcript evidence resolves exactly to `origin.kind=human` and
  `promptSource=typed`. A resolved `task-notification` / `system` hook is
  correlation-only and never emits a public query occurrence. Unavailable,
  unsupported, or equally near transcript provenance fails closed. Direct unit
  fixtures without a production provenance annotation retain their explicit
  fixture behavior.
- Piped, SDK, or other headless Claude input is never promoted from transcript
  timing or record shape alone. It must carry that same exact human/typed
  provenance; absent evidence remains a fail-closed negative control.
- An ID-less Claude submission may use content only as a transient digest and
  only against transcript candidates within the tight hook-write freshness
  window. A caller-supplied internal digest cannot override the raw hook prompt
  on the initial request. This prevents an earlier identical prompt such as
  `continue` from authorizing a new hook before its transcript row exists.
- A bounded in-memory reservation/consumed-row ledger prevents the same
  transcript prompt-ID/timestamp record from authorizing overlapping or later
  hooks within that freshness window. Consumption is committed only after the
  safe human observation is durable, or after a resolved task notification
  updates correlation-only state; failed durable append releases the reservation.
- Raw hook and transcript prompt aliases are preflighted as one atomic set.
  Any existing conflict makes the full set conflicted before any alias can
  become authoritative; a partial alias write is forbidden.
- A background- or cron-bearing Stop records the exact query as that session's
  task-notification target. Generated notifications continue to target it
  across its completion and across a newer manual query; only the newer query's
  own background/cron Stop may replace the target. This is bounded in-process
  correlation and is intentionally lost on restart or eviction.
- Each resolved task notification advances a monotonic continuation floor for
  its exact logical query. A Stop or closed interaction at or before that floor
  cannot terminalize the query, including close-first and reordered delivery;
  only a later eligible Stop can arm the final Stop/closed-root join.
- An active submission-hook query outranks a delayed provider prompt or trace
  pointer for the same session. Delayed evidence may still enrich the identity
  it exactly matches, but it cannot replace the active routing pointer or move
  a terminal half to another query.
- A background- or cron-bearing Claude Stop pauses only the exact native prompt
  resolved through its trace-to-native-prompt bridge. The matching physical
  closed interaction is suppressed as a terminal half, leaving the logical
  query eligible for its scheduled continuation. Timing or session proximity
  cannot supply this bridge.
- At Claude `prompt_input_exit`, the ledger may expose only a bounded
  in-memory count of those still-unresolved background-paused roots that remain
  in active correlation for private diagnostics. It is discarded on restart or
  eviction; the exposed count carries no raw root identity and bounded
  process-local keys are opaque. It cannot complete, persist, or dispatch a run;
  `SessionEnd`, child stops, and the suppressed physical close remain
  insufficient terminal authority.
- The ordinary Claude Stop/interaction join is bounded in-memory state, including
  a short reorder window, and is not recovered across an agent restart. Missing
  or conflicting correlation fails closed instead of completing the run.
- Claude Code `StopFailure` is a provider terminal event only when its opaque
  prompt and session identities exactly match an actual remembered
  `UserPromptSubmit` hook. OTLP prompt/request identity may correlate activity,
  but cannot establish submission-hook provenance. The terminal records
  failure and an allowlisted structured category; error details,
  assistant text, paths, and unmatched failures are discarded.
- Corroborating hook, event, and trace activity may revise one logical record
  only on exact safe activity identity. For Claude tool activity, opaque
  invocation identity takes precedence whenever either copy provides it; stable
  request identity is a legacy fallback only when both copies omit invocation
  identity. Child-session identity remains a separate exact join; otherwise
  activity remains distinct rather than being merged.
- This construct exists for stable run correlation, not for a user-facing prompt
  archive.

### TelemetryClassification

JTBD: Identify a supported provider/runtime/profile from allowlisted telemetry
metadata and project only safe atoms onward.

Primary code:

- `packages/engine/src/telemetryClassification.ts`
- `packages/agent/src/otlpIngress.ts`
- `packages/agent-contract/src/index.ts`

Boundaries:

- Classification is metadata-only.
- Unknown producers fail closed.
- Supported coding harness classification is currently limited to Claude Code,
  Codex, Cursor, and GitHub Copilot. Service-name aliases, span names, event
  names, and source profiles must be fixture-backed before becoming accepted
  evidence.
- Keep provider surfaces distinct when they carry different authorities.
- A span ID alone never proves customer-visible work. Require explicit activity
  or usage evidence. A Codex model label alone is insufficient because startup,
  transport, persistence, and response-plumbing records inherit the active
  model; other providers may retain fixture-backed model evidence.
- A cumulative Codex turn span is a usage authority, not another LLM request.
  Retain its token authority while excluding the boundary itself from activity
  counts.
- A call-ID-bearing Codex `codex.tool_result` may corroborate the request identity
  and explicit protocol failure of managed `PostToolUse` activity. For unified
  exec, `success = true` proves only that Codex returned a tool-protocol result;
  it must not be promoted to shell success. An unstructured shell response stays
  `unknown` unless a native structured exit code or status is available. The two
  records count once, records without an exact call ID fail closed, and arguments
  and output are discarded by `PrivacyGuard` before durable append.
- Claude Code shell hook, log-event, and trace-span copies follow the same
  process-outcome boundary. Protocol completion, a closed wrapper, generic
  `completed`, and contradictory success metadata do not prove the child exit;
  only an explicit process exit/status or explicit non-success may strengthen
  `unknown`. Exact same-invocation copies count once; stable request identity
  is a legacy fallback only when both copies omit opaque invocation identity.
- For an Agent tool only, classification may transiently read exact
  `tool_response.agentId` and the allowlisted `tool_input.subagent_type`, hash
  the child identity, and bridge it to the same exact `SubagentStart.agent_id`.
  All other response/input content is discarded. Until exact child lifecycle
  evidence arrives, that Agent launch remains one open subagent activity with
  unknown outcome; a corroborating closed OTLP wrapper cannot finalize it.
- A Claude `claude_code.tool` activity, execution node, and descendant-usage
  owner are keyed by opaque invocation identity derived from exact `tool_use_id`,
  never by the telemetry wrapper span ID. Activity equality requires matching
  provider/query/kind/name plus that invocation-precedence rule. A native
  `claude_code.tool_decision` retains a separate opaque evidence-atom identity;
  it may revise only the matching semantic invocation's outcome, and an
  execution-node conflict additionally requires the same tool name. The
  resulting rejection retains no execution duration/result/audit fields or
  causal artifact keys. Decision evidence never becomes a descendant-usage
  owner, usage/accounting/context evidence, or lifecycle authority.
- Claude trace lineage uses a parent-first in-memory ledger of hashed
  trace/span parent edges and Agent tool activities. A bounded same-request
  owner map may carry an exact activity owner to a later copy that omits
  parentage. Conflicting nonempty owners fail closed and remain conflicted until
  eviction. Each correlation map is capped at 1,024 entries and evicts its
  oldest entry. Child-first split envelopes cannot revise an already emitted
  atom, and eviction or restart loses these joins; timestamp, name, and
  proximity inference are forbidden. Recursive `parent_agent_id` ancestry is
  not yet an accepted production boundary.
- Whole-component child projection retains every exact member activity ID as a
  transient ownership alias, including trace-span and `otel_event` launch
  copies. Descendant usage owned by any non-conflicting member may therefore
  reach the one semantic child row. Conflicting components allocate no child
  usage, and a same-name group reports complete coverage only when every exact
  child is owned; the remainder stays explicitly unallocated. Child-first split
  envelopes, nested ancestry, and restart/eviction joins remain unaccepted.
- Classify a tool as a subagent only from explicit provider subagent evidence.
  Generic agent-control names such as spawn or wait remain tools; a supported
  provider's explicit subagent operation may become a subagent when fixtures
  establish that contract.
- A Claude `SubagentStop` hook is a revisable stop attempt, not terminal success:
  it keeps the matched `SubagentStart` identity open and `unknown` until exact
  native child closure strengthens it. Unmatched stops fail closed, repeated
  attempts retain one semantic activity, and `agent_type` is the canonical
  native child name when present.
- Do not group runs, price usage, or claim attribution here.
- Native provider facts that affect terminal authority remain versioned-fixture
  backed. The accepted Claude Code 2.1.201 failure fixture proves
  `StopFailure`/`authentication_failed`; the accepted 2.1.207 fixtures prove the
  exact ordinary Stop/closed-root and request-purpose joins described here.
  Neither fixture set generalizes to recursive lineage, skill-token ownership,
  MCP, workflow/team behavior, or other versions and modes.
- Claude Code request purpose is classified through an exact transient chain:
  prompt/session identity from `UserPromptSubmit`, prompt-log trace identity,
  and API-log/LLM-span request identity. Exact
  `query_source=generate_session_title` becomes
  `auxiliary_session_title`; exact `query_source=sdk` becomes `customer`. The
  accepted 2.1.201 failure fixture also permits exact
  `operation.name=generate_session_title` to classify the failed title request
  as auxiliary. Missing or unknown purpose remains unclassified, and identity
  or purpose conflicts fail closed.
- Those Claude correlation maps are bounded and in-memory. Safe emitted atoms
  retain opaque query/session/request identity and classified purpose, but the
  join itself does not survive an agent restart; Tirion never guesses the lost
  purpose afterward.
- Closed LLM spans preserve an explicit provider failure or rejection before
  applying a closed-span success fallback; closure alone cannot overwrite a
  native `success = false` result.

### PrivacyGuard

JTBD: Centralize what may be stored locally and what may leave the machine.

Primary code:

- `src/privacy/privacyGuard.ts`
- `packages/engine/src/telemetryClassification.ts`

Boundaries:

- Never store or dispatch prompt text, response text, tool inputs, tool outputs,
  file contents, diffs, absolute paths, or raw telemetry payloads in the active
  local-only slice.
- A transcript locator may be inspected transiently to distinguish a persistent
  harness turn and derive opaque lineage, but the locator itself is never
  retained or dispatched. A Codex prompt hook without that persistent-turn
  evidence records only a durable opaque `internal` lifecycle marker. The marker
  prevents earlier or later hook, log, trace, restart, or attribution evidence
  for that identity from becoming a customer run.
- Claude transcript inspection is limited to the bounded trusted tail supplied
  by `TelemetryIngress`. `PrivacyGuard` alone resolves its allowlisted
  human/typed or task-notification/system provenance and returns only transient
  correlation metadata; absent or ambiguous provenance cannot authorize a
  customer start.
- Validate webhook events through an explicit allowlist contract, including
  token arithmetic and terminal activity-to-run conservation invariants.
- Validate `causalWriteArtifacts` and `nativeRejectedCausalWriteArtifacts` only
  as bounded opaque `{ artifactKey, executionNodeId }` pairs, and
  `matchedCausalWriteArtifacts` only as bounded opaque
  `{ queryId, artifactKey, executionNodeId }` triples. Reject extra or
  non-opaque fields; a native-rejection marker is non-authorizing and carries
  no raw provider decision payload.
- Allow repo-relative changed file paths only at the outbound webhook boundary.
- Keep privacy decisions centralized here, not scattered across constructs.

### UsageProjection

JTBD: Project safe atoms into authoritative current and completed runs with
stable identity, token totals, model set, billing context, estimated cost,
catalog-rate usage value, and reported context footprint.

Primary code:

- `packages/engine/src/shadowUsage.ts`
- `packages/agent/src/shadowUsageService.ts`
- `packages/agent/src/productionUsageService.ts`
- `packages/agent-contract/src/index.ts`

Boundaries:

- Exclude every usage and activity atom whose durable query occurrence is
  explicitly marked as internal harness work. The opaque marker is authoritative
  across rebuilds and restarts; internal usage cannot become a production run.
- Once any Claude lifecycle evidence exists in a projection, retain a Claude
  production root only when its durable root occurrence has
  `evidence=submission_hook`. Native `provider_prompt_id` occurrences remain
  correlation evidence but cannot become production runs, including completed
  task-notification ghosts discovered during rebuild.
- Runs are user-facing; prompt text is not required to expose them.
- Preserve separate run identity, session identity, billing context, and model
  provider.
- Harness identity and model-provider identity must not collapse into one field:
  GitHub Copilot may run OpenAI, Anthropic, Google, GitHub, or Microsoft models;
  Codex may be direct API or subscription usage; Cursor may run Cursor,
  OpenAI, Anthropic, Google, or other models behind Cursor billing; Claude Code
  may carry direct Anthropic pricing or remain unpriced.
- Authority selection is harness-aware but contract-bound: Copilot
  `invoke_agent` run spans outrank corroborating model/chat spans, Claude Code
  request authority outranks lower-level duplicates, Codex turn/event
  authorities must avoid double counting overlapping telemetry, and Cursor
  generation-level hook usage must revise the same turn instead of creating
  duplicate run totals.
- Claude Code usage explicitly classified as `auxiliary_session_title` remains
  available in upstream safe atoms but is excluded from customer usage. Once
  one exact request copy establishes that purpose, every usage copy with the
  same request identity is excluded across log/trace signals. Missing or
  unclassified purpose remains counted, and auxiliary-only evidence cannot
  create a customer run.
- Codex `response.completed` events are per-model-request usage slices and are
  summed once per stable response identity. A cumulative closed Codex turn
  trace supersedes those slices when available; the two surfaces are never
  added together.
- Provider-linked child sessions are recursively folded into one root run
  exactly once only where every edge is an exact supported link. Child usage,
  tools, failures, and breakdown parentage remain visible, while linked child
  runs are not also published as standalone totals. Current Claude support
  covers exact direct hook/tool links; nested `parent_agent_id` ancestry is not
  yet accepted.
- When linked child runs are folded, their reported context footprints are
  folded under the same exact links. Accumulated input and cache dimensions
  must conserve against the merged run totals, request counts are additive,
  peak is the maximum observed footprint, and initial/latest chronology is
  retained only when ordering is defensible. Missing child context downgrades
  coverage instead of leaving a numerically complete-looking parent footprint.
- Claude child activity deduplication is whole-component rather than pairwise:
  exact scoped activity ID, request ID, or child-session ID joins all connected
  copies before projection. Exact child lifecycle is semantic authority when
  present; otherwise the exact linked Agent launch remains the open/unknown
  semantic row, while its trace activity identity may still own exact
  descendant usage. This prevents order-dependent duplicates without turning
  a closed wrapper or successful model request into child completion.
- Grouped activity preserves explicit `failureCount`, exact native
  `rejectedCount` as its subset, and native unknown-outcome counts. A later
  completed projection must not reinterpret "no observed failure" as "all
  succeeded" when the harness omitted outcomes, or generic failure as a
  permission rejection.
- A Claude native permission decision may revise only the matching semantic
  invocation's activity outcome and rejection count under the shared
  invocation-precedence rule. It cannot merge or erase another invocation that
  shares a request identity, own usage, contribute tokens/cost/context, or
  establish, reopen, or complete a lifecycle.
- A grouped same-name subagent row reports `trace_descendant`/`complete` only
  when the number of distinct exact child-session links equals the row's full
  count and every exact child has an owned usage slice. Partial ownership may
  retain proven totals only with `partial` coverage; absent or conflicting
  ownership keeps coverage unavailable rather than generalize one child's proof
  to the group.
- Child usage ownership considers every non-conflicting activity alias in the
  exact merged component rather than only the selected semantic row's canonical
  ID. This includes child Bash/descendant request ownership where the native
  parent chain proves it; names, timestamps, or equal token totals never supply
  the join. Missing one child owner preserves the remainder as unallocated.
- Every signal copy of a request carrying an ownership-conflict witness stays
  unallocated. If an affected tool or subagent group also has separate valid
  owned usage, that proven slice may remain attributed but its coverage is
  `partial`, never `complete`; selected breakdown totals still conserve the run.
- Claude usage revisions sharing one stable request identity reconcile once
  after provider-surface selection. Revision choice is deterministic, request-
  level conflict witnesses are unioned with the resolved owner removed, and a
  single API request cannot be summed twice merely because atom IDs differ.
  Completion evaluates the selected reconciled surface, so a superseded open
  revision cannot keep a newer closed authoritative request open forever.
- All cost remains estimated.
- Usage value is separate from expected billed cost and is emitted only when
  selected usage atoms can be fully valued from approved model-pricing evidence.
- Context footprint reports numeric input-token size and growth only; it never
  stores or exposes the actual context contents.
- Only runs with authoritative completion enter the durable production ledger.
- A customer-visible occurrence with authoritative `completedAt`, explicit
  completion evidence, and an evidence-backed outcome may project a completed
  zero-usage run when no usage atom exists. Such a recovery run preserves safe
  activity rows but keeps model, usage, and cost unavailable. Incomplete,
  internal, inactivity-only, and outcome-less Stop occurrences never create
  this run.
- A submission-hook run remains open while only model responses have completed.
  A matching accepted provider-terminal/session event or a closed explicit
  provider-authoritative turn/run trace boundary may complete it. For Claude
  Code, the ordinary Stop and closed-root interaction must satisfy the exact
  candidate join owned by `TelemetryClassification`.
- Inactivity-based completion is a short UsageProjection quiescence boundary,
  not a multi-minute attribution-settling delay; later provider atoms may
  reproject the same run with advanced totals or timing.
- Explicit provider completion fixes a run's accounting boundary: evidence that
  starts afterward cannot increase tokens, activity, cost, or terminal time,
  while delayed delivery of evidence that started on or before the boundary may
  still enrich the same run. Inactivity evidence never activates this freeze.
- Explicit-terminal reconciliation is query-family scoped across every supported
  harness. Opaque parent-session and explicit child-session links may expand the
  family recursively, but unrelated sessions and historical runs remain outside
  that projection.
- Once a durable run ledger exists, restart and periodic projection must preserve
  ledger history and reproject only a bounded recent usage/activity window by
  default; it must not replay months of safe atoms just to become operational.
- Outcome-only restart recovery remains bounded by both the active production
  epoch and the recent terminal reconciliation window. Applying production-run
  retention atomically replaces retained rows and advances that epoch's durable
  projection floor without changing its identity, so cleared or expired
  occurrence facts cannot be resurrected by a later rebuild.
- Correlation ledgers may be read broadly when needed to preserve run identity
  and prompt-state joins, but they do not reopen raw content capture.
- Activity breakdown may retain metadata-only rows, never content-heavy payloads.
  Its token fields must conserve the selected authoritative run totals; usage
  that cannot be attributed to a reported activity remains explicit in an
  `unallocated` row instead of disappearing or being guessed onto a tool.

### BillingContextResolver

Parent: `UsageProjection`

JTBD: Resolve the pricing context proven for a run without guessing.

### ModelProviderResolution

Parent: `UsageProjection`

JTBD: Resolve the underlying LLM provider for a run while preserving unknown or
mixed evidence explicitly.

### CostEstimation

Parent: `UsageProjection`

JTBD: Deterministically price approved usage atoms into fixed-precision cost
estimates when evidence allows it.

Boundaries:

- Pricing catalogs are billing-context-specific and must not fall through to a
  different harness or direct-provider catalog when the active billing context
  lacks a matching row.
- GitHub Copilot pricing uses the verified Copilot catalog and token-threshold
  rows for long-context models; unknown Copilot models keep explicit partial or
  unavailable cost coverage.
- Cursor Auto/Composer usage may use the verified Cursor catalog when model and
  token evidence match; other Cursor hook-only usage must not fall through to
  direct-provider or Copilot billing catalogs unless provider-reported cost
  evidence explicitly supports it.
- Usage value may use approved model-family rates for normalized comparison,
  but it must remain distinct from estimated billed cost on webhook payloads.

### RunLedger

JTBD: Store, query, total, export, retain, and clear authoritative local run
history.

Primary code:

- `packages/agent/src/productionUsageService.ts`
- `packages/agent/src/shadowUsageService.ts`
- `packages/agent-storage/src/index.ts`
- `packages/agent-storage/src/worker.ts`

Boundaries:

- Group by stable run identity, not prompt text.
- Persist completed production runs only.
- Merge projected completed runs with atomic per-run upserts. A fresh terminal
  projection and a concurrent global reconciliation must not replace each
  other's unrelated or newer durable rows from stale read snapshots.
- Keep shadow and production ledgers separate.
- Exports stay content-light and prompt-blind for the local-only slice.
- Keep execution-node evidence query-addressable and bounded by age and count;
  a single run's evidence lookup must never deserialize unrelated historical
  node documents.
- Persist an identity-deferred completed-run marker when a run lacks usable
  workspace identity. Do not retry it on every usage rebuild; retry only if the
  same completion later gains trusted identity evidence.
- When bounded startup retention leaves material SQLite fragmentation, compact
  it before full-owner projection begins. Routine live delivery never runs a
  database compaction.

### RepositoryScopeManagement

JTBD: Let the user explicitly watch, pause, resume, and remove repository scopes
without exposing raw paths to normal clients.

Primary code:

- `packages/agent/src/repositoryScopeManagement.ts`
- `packages/agent/src/index.ts`
- `packages/tirionctl/src/index.ts`

Boundaries:

- No whole-home scanning.
- Raw paths are accepted only for explicit enrollment.
- Public DTOs expose opaque scope IDs and safe labels only.
- Repository scopes are provider-neutral. Provider pins in legacy persisted
  records are ignored and stripped when scopes are read or rewritten.
- Do not store telemetry provider, runtime, model provider, or harness identity
  as repository identity.
- Scope management does not perform attribution or webhook delivery.

### RepositoryObservation

JTBD: Establish a trusted ordered Git/worktree observation boundary for each
watched repository.

Primary code:

- `src/attribution/repositoryObservation.ts`
- `src/attribution/gitCli.ts`
- `packages/agent/src/repositoryObservationService.ts`

Boundaries:

- Own activation epochs, ordered snapshots, candidate commits, and sanitized
  repository identity.
- Persist privacy-safe fingerprints and repo metadata, not raw paths or file
  content.
- Provide the repo binding and repo-relative path projection needed by webhook
  delivery, but do not own webhook dispatch itself.
- Resolve a workspace against cached watched roots using longest-root matching,
  then expose only the opaque repo key. Turn exact write targets into HMAC
  artifact keys and retain repo-relative projection state only here.
- Repository lookup must not filter by telemetry provider; provider-specific
  readiness belongs to `TelemetrySourceConfiguration`, not repo eligibility.
- Agent startup may defer the initial catch-up scan after epoch/snapshot setup;
  explicit refreshes and polling still drain through the observation contract.
- A bounded worktree artifact sample must carry explicit partial coverage. It
  can provide positive evidence for sampled artifacts, but it cannot establish
  a complete baseline for commit attribution.

### WorkspaceChangeTracker

JTBD: Reconstruct privacy-safe file-state continuity for a run inside a watched
repository.

Primary code:

- `src/attribution/workspaceChangeTracker.ts`
- `packages/agent/src/productionRunAttribution.ts`
- `src/types.ts` (`QueryWorkEvidence.causalWriteArtifacts`,
  `nativeRejectedCausalWriteArtifacts`, and `causalWriteArtifactsComplete`)

Boundaries:

- Provide evidence only; do not decide commit ownership.
- Preserve content-state continuity proof through hashed artifact and state
  identities.
- Do not reduce attribution to filenames plus timestamps.
- Safe query starts are workspace-evidence boundaries: an older completed run
  may settle only until the next known run starts in the same observed runtime
  surface, after which later snapshots belong to the newer run or to no run.
- Live safe observations and retroactive snapshot reconstruction must share the
  same run-boundary contract so late baselines cannot make one prompt inherit
  another prompt's files.
- When ingress provides an opaque repository key, open and settle evidence only
  for that repository; other watched repositories are not candidate baselines.
- Snapshot deltas remain continuity evidence for commit attribution. Run-level
  `filesChanged` requires an explicit per-artifact
  `{ artifactKey, executionNodeId }` proof created by an exact same-repository
  successful semantic-write node with allowlisted artifact evidence; a generic
  causal-key set or grouped activity outcome cannot substitute for that pairing.
  Both retained identifiers are bounded, opaque values: no path, tool payload,
  or raw telemetry may enter evidence. A native-rejection marker is recorded
  only when a native decision exactly contradicts that eligible invocation; it
  never creates a writer claim. Missing, unreadable, or empty source data is not
  a native rejection, and a distinct valid writer remains an independent proof.
  Temporal snapshot overlap, rejected/failed activity, and legacy unpaired
  causal keys cannot authorize a later correction.
- A partial worktree snapshot fails closed as a commit-attribution baseline;
  exact sampled changes remain metadata-only positive evidence and never imply
  that omitted artifacts were unchanged.
- Startup sanitizes legacy workspace or episode evidence whose artifact-state
  arrays exceed the active cap. Sanitized records retain only failed-closed
  metadata and cannot claim changed files or a trusted baseline.

### AgenticWorkEpisode

JTBD: Group related run activity and repository evidence into conservative
episodes that Git attribution can evaluate.

Primary code:

- `src/attribution/agenticWorkEpisode.ts`
- `packages/agent/src/productionRunAttribution.ts`

Boundaries:

- Own episode grouping and repository binding.
- An incoming complete causal-write census replaces, rather than unions, prior
  causal pairs and native-rejection markers. Incremental or legacy evidence may
  merge; an old successful pair must not outlive an exact native contradiction.
- Do not price usage or publish events.
- Fail closed when repository binding is absent or ambiguous.
- Runs with unavailable prompt-state identity may be measured as usage, but must
  not open workspace-evidence windows or claim repository changes.
- Episode lookup must be query, run, or session scoped during live processing;
  broad historical episode reads are reserved for explicit reconciliation.

### GitAttribution

JTBD: Reconcile completed runs, workspace evidence, and observed commits into
verified conservative commit-cost attributions.

Primary code:

- `src/attribution/gitAttribution.ts`
- `src/attribution/commitAttributionPolicy.ts`
- `packages/agent/src/productionRunAttribution.ts`
- `src/storage/commitAttributionLedger.ts`

Boundaries:

- Attribute estimated cost, not line authorship.
- Keep allocation conservative, ambiguity fail-closed, and rewrite handling
  explicit.
- A first-claim proof retains only causal pairs that actually matched the commit
  artifact state: direct allocations retain their own query pair and inherited
  allocations retain their anchor pairs. Legacy or snapshot-only claims retain
  no revocable causal-pair pointer.
- A native causal retraction can supersede only an existing active or
  rewrite-pending first claim when every stored pair is explicitly marked
  rejected in complete evidence for the same query, repository, and epoch, and
  no independent current matching pair remains. Missing, empty, or unreadable
  evidence alone cannot revoke. If no active allocation remains, return the
  candidate to `pending_evidence`; preserve the retraction in its versioned
  publication snapshot without affecting valid siblings.
- Preserve versioned publication snapshots for downstream meaning changes.
- Publish change events only after durable local writes.

### ExternalWebhookDispatch

JTBD: Emit privacy-safe `run.start`, `run.update`, `run.ended`, and
`commit.attributed` events to a user-configured local webhook sink with durable
retry, canonical event shape, and idempotent semantics.

Primary code:

- `packages/agent/src/externalWebhookDispatch.ts`
- `packages/agent/src/index.ts`
- `packages/agent-contract/src/index.ts`
- `packages/agent-storage/src/index.ts`
- `packages/agent-storage/src/worker.ts`

Boundaries:

- Implement the canonical run lifecycle family (`run.start`, `run.update`,
  `run.ended`) plus `commit.attributed`.
- Use one trusted webhook event shape across coding harnesses, with explicit
  `evidence` and `coverage` fields describing what is known and how.
- `final` usage coverage describes the authoritative boundary represented by a
  terminal version. It does not suppress a higher complete replacement when
  later-delivered evidence is eligible because it began on or before that same
  boundary; that correction must never reopen `run.update` delivery.
- `codingHarness` must be one of the supported measurement providers when the
  run comes from a first-class harness: `claude-code`, `codex`, or
  `cursor`, or `github-copilot`.
- Do not add harness-specific webhook event families or Copilot-only payload
  shapes; provider-specific meaning belongs in bounded evidence, coverage,
  model, runtime, and pricing fields.
- Include the static local `installationId` and any user-configured sender
  profile on outbound events so receivers can identify the sending installation
  and workplace owner.
- Use durable local outbox state and bounded retry/backoff.
- Use point reads for one outbox or terminal-subject row and due-row queries for
  delivery. A fresh lifecycle event must not deserialize the historical outbox
  merely to queue, inspect, or deliver its own event.
- Status, trace-to-lifecycle lookup, and delivered-writing checks use durable
  summaries or identity-scoped rows. Historical payloads stay local unless an
  explicit retention or reconciliation operation requires them.
- Release in-memory live source and session mappings immediately when final
  usage is durably delivered unless a Claude tool source remains a native
  permission-correction candidate. Retain that direct source state and its
  artifact-to-public-path map for at most 15 seconds so an exact late native
  decision may publish a higher `run.ended` version that prunes only the prior
  direct activity row and paths it proved. Durable grouped activity is corrected
  by authoritative rebuild, never direct row pruning. Retain a non-final first
  terminal for only a bounded correction horizon so a late authoritative root
  boundary can replace it immediately, then release it even if no correction
  arrives. A separate opaque session/query/completion-boundary marker survives
  that same bounded horizon so eligible late pre-boundary evidence can replace
  even a final terminal without reopening `run.update` delivery.
- Validate every outbound payload through `PrivacyGuard`.
- Emit repo-relative changed file paths only after allowlisting.
- For ordinary run lifecycle delivery, project `filesChanged` only from
  `QueryWorkEvidence.causalWriteArtifacts`: exact bounded opaque artifact/node
  pairs produced by successful semantic writes. A grouped activity outcome
  cannot bless a different artifact, while a mixed grouped outcome cannot erase
  an already-proven successful invocation. Rejected, failed, legacy-unpaired,
  or merely write-shaped activity cannot authorize a late file correction;
  observer output and unrelated concurrent workspace deltas remain absent even
  inside the run time window.
- Re-read every ordinary lifecycle or commit file proof from its exact source
  node before publication: query and repository must match, the node must be a
  successful semantic write with the exact artifact and allowlisted evidence,
  and its query census must remain readable. Missing, malformed, mismatched, or
  unreadable source evidence fails closed; a native-rejection marker is a
  correction pointer, never ordinary write authority.
- Bind live run lifecycle observations through provider-neutral watched
  repositories. When one safe observation contains records from multiple
  repositories, partition it by exact opaque query/session-to-live-run identity;
  recover that identity from durable query occurrences after restart. Records
  with absent or conflicting identity fail closed individually and cannot block
  or contaminate records with an exact binding.
- Lifecycle order describes externally delivered events, not every durable queue
  row: normal completed delivery is `run.start -> delivered run.update(s) ->
  run.ended`, with its settling update selected before terminal. A successful
  terminal suppresses pending stale running snapshots, so queued work is not a
  promise of a later webhook.
- Prioritize accepted lifecycle anchors over queued enrichment in the live
  projection lane. Ordinary outbox delivery re-reads due priority after every
  event so a newly queued start cannot remain behind a stale batch of updates;
  preserve the applicable delivered lifecycle order within every normal run.
- Ordinary live observations are durably admitted without awaiting the webhook
  receiver's HTTP response. Delivery continues asynchronously through the
  bounded outbox loop, so sink latency cannot serialize later observation
  admission; direct callers that explicitly request delivery completion retain
  their awaited contract.
- While one ordinary HTTP delivery is in flight, reserve one bounded bypass for
  a due start, settling update, or terminal from a different run. Exact
  in-memory event and run-subject claims keep the bypass from duplicating an
  attempt or violating per-run order, and forced operator retries never use the
  bypass. This bounds receiver concurrency while preventing one slow
  enrichment response from holding every other run's lifecycle anchors. In both
  ordinary lifecycle selection and this bypass, a fresh due `run.start` ranks
  first; the trusted non-delayed Claude closed-root terminal described below
  then ranks ahead of fresh settling updates from either its own or another run.
- `run.start` must not require prompt text capture.
- Claude Code public starts require a managed `UserPromptSubmit`
  `submission_hook` whose bounded transcript provenance resolves to
  human/typed. Task-notification/system hooks and provider prompt logs remain
  correlation evidence but cannot independently publish shutdown,
  slash-command, generated-task, or other start-only ghost roots.
- A Codex prompt hook may establish a public start only when its transient
  transcript locator proves it belongs to a persistent user or subagent turn.
  Transcriptless desktop-internal hooks persist only an opaque internal marker,
  never acquire repository or public lifecycle identity, and block every later
  evidence surface for the same query from retrospective publication.
- Claude transcript inspection is limited to the bounded trusted tail supplied
  by `TelemetryIngress`. `PrivacyGuard` alone resolves its allowlisted
  human/typed or task-notification/system provenance and returns only transient
  correlation metadata; absent or ambiguous provenance cannot authorize a
  customer start.
- The first accepted prompt anchor fixes public `startedAt`; delayed hook, log,
  trace, or replay evidence may enrich the run but must not rewind its lifecycle
  identity.
- Provider-linked child sessions reuse the active root lifecycle subject. A
  child prompt or closed child turn may enrich that root but cannot publish a
  second root start or end the root lifecycle. This root-only terminal rule
  applies to both live observations and completed-run/episode projection,
  including after dispatcher restart: a durable public start remains open until
  the public subject's own authoritative turn/run boundary completes.
- Once exact child lineage has established `trace_descendant` usage, an
  equivalent later terminal projection with the same semantic child and token
  vector preserves that verified attribution. Reconciliation cannot downgrade
  it merely because the already-normalized child LLM row is now tokenless or an
  alternating live snapshot repeats lower-authority activity. A grouped
  semantic activity row remains authoritative over later direct rows with the
  same kind/name.
- A durable child prompt discovered while projecting earlier OTLP evidence must
  resolve through its opaque parent-session link. Provisional child state stays
  private until a public start exists and is reparented if that link arrives
  later, but only before any child or parent terminal is selected, reserved,
  queued, or delivered. After that boundary, retain the child subject for its
  correction route; an in-memory timestamp alone never authorizes a public
  update.
- Root and child usage retain their original query identity through authority
  selection. A turn/run authority may replace request slices only inside that
  query; independently projected root and child totals are added only at the
  public lifecycle boundary.
- Exact cross-surface request evidence is corroborating rather than additive
  when provider, complete token vector, billing context, model when present,
  completion timing, and distinct source/signal agree unambiguously. Ambiguous
  or merely equal usage remains separate.
- `run.update` may include only metadata-safe activity, token, reported context
  footprint, model, cost estimate, evidence, and coverage updates; never prompt text, response text, tool arguments,
  command text, raw telemetry, file content, diffs, absolute paths, or transcript
  paths.
- Catalog-rate `usageValueNanoUsd` on `run.update` is independent of billed-cost
  estimation. Subscription usage may retain unavailable cost coverage while
  publishing a value only when every usage-bearing component in the current
  snapshot is catalog-valued; a partial value subtotal must remain omitted.
- Exact Claude Code `auxiliary_session_title` request usage is filtered before
  every live lifecycle projection. Every same-request log/trace usage or
  execution-node copy is omitted from activity, tokens, models, context, and
  cost, and it never creates a separate public lifecycle. Missing or
  unclassified purpose remains customer-visible and counted.
- `run.update` is a revisable current snapshot. Stable request/activity identity
  must replace later revisions of the same evidence instead of double counting
  them; receivers must not add successive update totals together.
- Live LLM and unallocated aggregate identities are stable per query/session
  authority scope. Request growth, a later turn authority, or pending terminal
  refresh replaces that aggregate row instead of retaining historical rows.
- Running updates are immediate and content-addressed. Completed-run
  `settling` projections use one replaceable outbox slot until the terminal
  deadline so a provider turn/root authority can supersede provisional request
  slices before the ordered settling update and terminal are published.
- Per-run lifecycle projection requests are coalesced by run ID. Fresh
  completed-run work has a dedicated priority lane and is reselected one run at
  a time ahead of historical replay; concurrent rebuilds cannot accumulate a
  stale FIFO of snapshots ahead of terminal meaning.
- Terminal admission is a dedicated live projection path, not a parallel
  same-run HTTP delivery path. It must not await ordinary outbound delivery;
  once an eligible terminal exists, it durably queues the terminal row even if a
  same-run update attempt is in flight. HTTP attempts remain per-run serialized
  so normal delivered lifecycle order cannot be inverted or overlapped.
- A narrow Claude Code closed-root exception applies only when the terminal's
  webhook `codingHarness` and runtime are `claude-code` and
  `evidence.basis` is `root_span` with `evidence.delayed: false`. At its
  deadline, that fresh terminal ranks after `run.start` and ahead of fresh
  settling updates from the same or another run in ordinary and bypass lifecycle
  selection. Its public sequence is `run.start -> optional delivered
  run.update(s) -> run.ended`. An update already in flight completes first; if
  the terminal attempt fails or retries, the pending settling snapshot remains a
  valid fallback. Successful terminal delivery suppresses still-pending same-run
  updates. All other completed lifecycles retain normal
  settling-update-before-terminal delivery.
- Delivered `run.update` rows form a durable per-run public high-water mark.
  A concurrent or replayed update may strengthen state, totals, activity,
  coverage, and evidence, or apply an explicitly proven source-pruning
  correction, but it cannot otherwise regress already published meaning.
  Reconciliation restores any high-water token residual as explicit
  unallocated usage so arithmetic still conserves.
- Each distinct running-update meaning receives a content-derived `eventId`;
  equivalent meaning reuses the same ID, while changed meaning receives a new
  ID. Undelivered superseded rows are closed as superseded rather than delivered
  as stale updates.
- Distinct delivered update meanings advance `updatedAt` strictly beyond the
  durable per-run high-water even when their provider source timestamp ties.
  `evidence.observedAt` retains the actual source time so logical receiver order
  never rewrites provenance timing.
- `run.ended` must fire for watched repository runs even when no commit occurs.
- An ordinary Claude Code Stop cannot queue `run.ended` by itself. Only its
  exact in-process join with the matching closed root interaction supplies
  terminal evidence; background-bearing or cron-bearing Stops remain
  nonterminal, and `stop_hook_active` does not authorize delivery. A restart
  between those transient surfaces loses the candidate rather than inventing a
  terminal.
- `run.ended.state` describes lifecycle completion. Its optional provider-neutral
  `outcome` is emitted only when native evidence proves `success`, `failure`, or
  `unknown`; an absent outcome must never be interpreted as success. A proven
  failure remains monotonic across higher terminal versions.
- A high-confidence explicit completion (`stop_hook`, `session_hook`,
  `root_span`, or provider terminal event) may publish a first `run.ended` from
  the live lane after the fixed grace period. It includes only accumulated
  privacy-safe live activity and usage; coverage is final only when every
  usage-bearing query has a closed authoritative boundary, and optional context
  is labeled with exactly the same coverage.
- An authoritative completed-run `run.ended` projection must include the final
  metadata-safe activity breakdown. Group counts, failure counts, exact
  rejection counts, and per-row usage attribution basis and coverage remain
  explicit, and unattributed token usage must reconcile in an
  `unknown`/unallocated activity row.
- When a completed-run breakdown supplies an activity kind/name, its grouped
  count replaces provisional or older terminal rows for that same semantic
  activity. Terminal versions never add the direct and grouped views together.
- Provisional LLM rows may be represented by one authoritative same-name
  subagent aggregate only when the complete child count is observed and one
  unique bounded subset of candidate LLM rows sums to the aggregate in every
  token dimension. Exact parent links outrank timing corroboration; equal token
  totals or an ambiguous subset never establish parentage. Reconciled LLM trace
  rows remain nested and tokenless while the aggregate owns usage exactly once.
- When delayed live telemetry first reports one cumulative parent-plus-child
  LLM row and a separate tokenless child trace, Tirion may partition that row
  only when the authoritative child usage plus authoritative unallocated usage
  equals the cumulative vector in every token dimension. The child becomes a
  tokenless nested trace and the cumulative row retains the exact parent
  residual; internal validation flags never cross the privacy boundary.
- When final child reconciliation has exact live lineage and leaves exactly one
  unclaimed root LLM aggregate, the authoritative unallocated residual replaces
  that root aggregate's provisional usage. Without both complete child
  corroboration and a unique root candidate, usage stays unallocated.
- Child activity rows preserve `parentActivityId`; activity token sums across
  every dimension must equal the final top-level run totals when coverage is
  final.
- A terminal correction may omit an older provisional context footprint when
  its coverage is incompatible with the corrected usage coverage. It must not
  relabel provisional context as final or block the otherwise valid terminal
  revision.
- Completed-run lifecycle projection must not wait for attribution settling;
  attribution may improve `run.ended` later with write/file evidence.
- First terminal delivery uses a fixed deadline derived from an explicit trusted
  completion when available, otherwise authoritative completion, not a quiet
  period that delayed telemetry can slide. A late closed root boundary within
  the bounded correction horizon emits a higher `run.ended` version immediately
  rather than delaying the first terminal event for
  attribution completeness.
- When a higher terminal has final usage but still exposes an unresolved
  subagent, keep that correction replaceable for at most 250 ms. A grouped
  completed-run projection releases the same pending version immediately;
  otherwise the partial correction releases when the bound expires.
- Schedule a terminal-specific usage rebuild at a fixed offset from each
  explicit completion. Unrelated telemetry may continue to slide the ordinary
  global usage quiet period, but cannot postpone that run's reconciliation. A
  closed authoritative boundary, or later exact provider/runtime/session/query
  evidence that began no later than the retained completion boundary, triggers
  the rebuild immediately. For Claude this applies after the exact
  Stop/closed-root interaction join and does not weaken the Stop-alone
  failure-closed rule or admit post-boundary evidence.
- Fresh completed-run corrections and evidence enrichment use a projection lane
  independent from historical replay. Each lane processes one run before
  re-selecting durable priority; startup attribution reconciliation does not
  replay every historical lifecycle or reserve work ahead of live terminal
  meaning.
- Commit reconciliation uses its own coalesced scheduler lane. A full commit
  scan may enrich terminal file evidence later, but it cannot occupy either
  fresh or historical run-lifecycle projection lane.
- Queueing latency and empty `filesChanged` do not start another grace clock.
  A terminal projection arriving after the fixed completion deadline, including
  a higher final version, is immediately eligible for delivery.
- HTTP delivery attempts for one terminal subject are serialized. Delivery
  re-reads the current durable outbox row under that lock, and canonical semantic
  hashes exclude `eventId`/`version` and normalize object-key order so equivalent
  payloads cannot churn versions.
- After any deadline timer fires, scheduling must re-read the durable outbox and
  arm the next earliest pending deadline; the periodic retry sweep is only a
  fallback, never the normal terminal wake-up path.
- Any changed authoritative terminal meaning, including corrected usage,
  activity, terminal timing, model, cost, or workspace evidence, may emit a
  higher `run.ended` version. A version is a complete replacement snapshot and
  may correct values downward as well as upward, but it never rewinds the
  published `startedAt` anchor.
- `commit.attributed` is always enabled in the current local product; users do
  not configure it as a separate webhook event family.
- When commit reconciliation proves write evidence before the corresponding
  write `run.ended` has been delivered, dispatch must backfill or improve that
  `run.ended` event from the same attribution-owned evidence instead of relying
  on stale projection state.
- `commit.attributed` must use attributed commit cost, not naive whole-run sums,
  and may include usage value only from verified writing runs on the event.
- `commit.attributed` must publish only runs with write evidence for the commit,
  so read-only or inherited context runs do not inflate run IDs or cost.
- Commit event versioning must preserve rewrite and supersession semantics. A
  native causal retraction may supersede only an existing non-superseded commit
  event after the internal snapshot records `native_causal_write_retracted`,
  every marked pair revalidates as natively rejected, and no current valid
  writer remains. It never creates a standalone supersession; a valid sibling
  proof wins, and a send/reconciliation race resolves through a later higher
  superseding version.
- No backend authorization, org enrollment, or remote configuration belongs here.

### BudgetWarnings

JTBD: Surface deterministic warnings when local estimated usage crosses explicit
thresholds.

Primary code:

- `packages/agent/src/budgetWarningsService.ts`

Boundaries:

- Use authoritative production runs only.
- Keep all thresholds and observed values in estimated units.

### Diagnostics

JTBD: Explain whether the local-only runtime is healthy without leaking
sensitive content.

Primary code:

- `packages/agent/src/diagnosticsService.ts`
- `packages/agent/src/safeStructuredLog.ts`
- `packages/agent/src/index.ts`
- `packages/tirionctl/src/index.ts`

Boundaries:

- Record privacy-safe construct lifecycle facts only.
- Doctor/source status must report Claude Code, Codex, Cursor, and GitHub
  Copilot from the shared provider-source status contract, including `complete`,
  `awaiting_receipts`, or `unavailable` measurement state.
- Include webhook queue, retry, success, and blocked-delivery diagnostics.
- Construct-state refresh is best-effort, coalesced, and bounded for control
  reads; stale safe diagnostics are better than timing out a healthy local agent.
- Latest-event snapshots remain capped, while the authenticated log surface may
  read an inclusive `since`/`until` UTC window with at most 1,000 returned
  events. Window reads scan only the active private structured log and its three
  bounded rotations, so unrelated high-volume telemetry cannot erase an
  immediately audited run window or inflate a control response without bound.
- The private `claude_background_root_missing_terminal` diagnostic is allowed
  only for an allowlisted Claude `prompt_input_exit` with one or more unresolved
  in-memory background roots. It retains a bounded count and normalized reason,
  never identifiers or content, and is not a durable observation, completion,
  repository-binding, or webhook signal.
- Never log secrets, prompt text, tool payloads, file contents, raw telemetry,
  or absolute paths.

### AgentRuntimeControl

JTBD: Keep the standalone local agent single-instance, startable, stoppable,
clearable, and inspectable without VS Code.

Primary code:

- `packages/agent/src/index.ts`
- `packages/agent/src/runtimeWorkScheduler.ts`
- `packages/platform/src/index.ts`
- `packages/tirionctl/src/index.ts`

Boundaries:

- Own lifecycle, ownership state, retention, and reset flows.
- A fresh local installation defaults to agent-owned operation.
- Clearing local agent data must also clear webhook state and other local-only
  runtime artifacts.
- Keep local control and ingest paths responsive while warmup, projection,
  diagnostics refresh, repository scans, and webhook work catch up.
- Runtime warmup must not wait on full attribution readiness; attribution
  enrichment is a background capability and reports its own lifecycle state.

#### RuntimeWorkScheduler

Parent: `AgentRuntimeControl`

JTBD: Coalesce and serialize keyed background runtime work without making local
control and telemetry acknowledgement paths wait on it.

Primary code:

- `packages/agent/src/runtimeWorkScheduler.ts`

Boundaries:

- Own scheduling only; business logic stays in the construct that owns the job.
- Preserve independent lanes so a slow projection, diagnostic refresh, or scan
  does not block unrelated runtime work.
- Keep accepted live webhook observations in a lane independent from workspace
  evidence and full usage rebuild work across every supported harness.
- Within the live webhook lane, process lifecycle anchors before enrichment and
  re-check priority between observations. A query-scoped terminal projection
  keeps its fixed deadline even while unrelated sessions or the global usage
  rebuild lane remain active. Terminal admission/queueing must not await an
  outbound HTTP attempt; delivery claims serialize network attempts separately.
- Keep fresh completed lifecycle projection independent from historical replay,
  and yield after one run in each lane before re-selecting priority.
- Callers may wait with an explicit small freshness budget, but background work
  must remain optional for serving control reads.

### AgentClientGateway

JTBD: Provide bounded authenticated same-machine control and status APIs to
local operator tools such as `tirionctl`.

Primary code:

- `packages/agent/src/index.ts`
- `packages/agent-contract/src/index.ts`
- `packages/tirionctl/src/index.ts`

Boundaries:

- Expose local control, status, repository, run, attribution, and webhook APIs.
- Do not expose raw paths, prompt text, or backend-only controls.
- Do not expose a remote backend-to-agent command channel.
- If a retired backend command name is still accepted, reject it explicitly as a
  local-only unsupported surface rather than probing backend-era endpoints.

### UserSurface

JTBD: Give the operator simple local control and observability, with
`tirion-tui` as the primary terminal product surface and `tirionctl` as the
scriptable control surface.

Primary code:

- `packages/tirionctl/src/index.ts`
- `packages/tirionctl/src/dashboard.ts`
- `packages/tirion-tui/cmd/tirion-tui/main.go`
- `packages/tirion-tui/internal/agent`
- `packages/tirion-tui/internal/tui`

Boundaries:

- `tirion-tui` is the main terminal observability, repository activation,
  harness setup, and webhook control surface over `AgentClientGateway`.
- `tirionctl` remains the scriptable local control surface for automation,
  service lifecycle, diagnostics, install/restore, and command-line escape
  hatches.
- Repository activation from `tirion-tui` must go through
  `MeasurementActivation`; the TUI must not scan the filesystem or reimplement
  source configuration, repository scope management, or provider selection.
- Multi-repository activation from `tirion-tui` must be a batch of explicitly
  entered paths, with one `MeasurementActivation` request per path.
- Repository removal from `tirion-tui` must target an explicitly selected
  repository scope and use the repository management API.
- Supported harness readiness from `tirion-tui` must be rendered from
  `AgentClientGateway` doctor and source-test contracts; the TUI must not
  perform hidden runtime probing or duplicate `TelemetrySourceConfiguration`
  checks.
- Harness issue resolution from `tirion-tui` must call `AgentClientGateway`
  provider configure/restore APIs and keep privacy-closed capture defaults; it
  must not shell out to `tirionctl` or mutate harness config directly.
- Harness restart requirements from `tirion-tui` must be explicit operator
  guidance; the TUI must not imply a fresh child process replaces restarting or
  reopening the user's active harness process.
- `tirionctl app` ensures the local agent is reachable through the existing
  agent lifecycle path, then launches the packaged or locally built
  `tirion-tui` process, but it must not become a second implementation of the
  TUI.
- Show local health, repository scopes, usage, attribution, and webhook status.
- Do not reintroduce backend-only publishing, accounting, or execution sync as
  user-facing happy-path commands.

### AgentDistribution

JTBD: Produce a self-contained local agent package that runs without a
user-managed Node.js install.

Primary code:

- `packages/distribution/src/index.ts`
- `packages/distribution/src/main.ts`
- `packages/tirion-tui`

Boundaries:

- Package runtime artifacts only.
- Do not own measurement, attribution, webhook delivery, or local state.

## Retained Compatibility Code

The repository still contains code for old backend-oriented paths. That code is
not part of the active local-only construct map unless it is explicitly brought
back into this file in the same assignment.

Examples include:

- execution-tree topology and drilldown surfaces kept only for controlled
  retirement
- legacy publication-snapshot internals that no longer correspond to any
  backend or GitHub Check runtime

## Cross-Construct Assignment Rules

- Start every change by locating the smallest active construct that owns the job.
- Keep local-only webhook work inside `ExternalWebhookDispatch` unless the job
  itself changes.
- Keep privacy decisions centralized in `PrivacyGuard`.
- Keep shared DTO ownership in `packages/agent-contract/src/index.ts`.
- If a file move or ownership change alters this architecture, update this file
  in the same assignment.
