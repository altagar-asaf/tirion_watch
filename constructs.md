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

`RunLedger + RepositoryObservation + WorkspaceChangeTracker + AgenticWorkEpisode -> GitAttribution -> verified commit attribution + publication snapshots`

`RunLedger completed runs + verified commit attribution + RepositoryObservation repo identity + PrivacyGuard outbound validation -> ExternalWebhookDispatch -> durable local outbox -> HTTP webhook sink`

Important active runtime rules:

- Only explicitly approved repositories are observed.
- Completed-run assembly is authoritative before terminal run delivery; start
  and update lifecycle events may be projected from earlier safe run identity
  when provider hooks expose it.
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
| Claude Code | Tirion can configure, status-check, and restore managed local OTLP logs and traces. Prompt capture defaults off; tool details may be enabled; tool content and response content default off. | `TelemetrySourceConfiguration` owns managed config; `TelemetryIngress` accepts approved loopback telemetry. | `otlp_claude_code_logs`, `otlp_claude_code_traces` | Direct Anthropic estimates only when billing context evidence supports it; otherwise usage may remain unpriced. |
| Codex | Tirion can configure, status-check, and restore managed local OTLP logs and traces, plus safe local hook relay surfaces needed for lifecycle/activity metadata. Prompt capture defaults off. | `TelemetrySourceConfiguration` owns managed config; `TelemetryIngress` accepts approved loopback telemetry. | `otlp_codex_logs`, `otlp_codex_traces` | Direct OpenAI estimates only when verified auth-mode evidence proves direct API billing; subscription usage stays usage-valued but not billed-cost estimated. |
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
- Prompt capture defaults off.
- Tool content, response content, raw API bodies, diffs, and file-content
  capture default off for the local-only slice.
- Provider hook setup belongs here only when it is needed for run completion,
  stable run identity, run lifecycle timing, or activity metadata.

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
  `otlp_claude_code_logs`, `otlp_claude_code_traces`, `otlp_codex_logs`,
  `otlp_codex_traces`, `hook_cursor_lifecycle`, `hook_cursor_tools`,
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

#### SafeObservationJournal

Parent: `TelemetryIngress`

JTBD: Durably retain bounded privacy-safe observations until they are projected
into authoritative local ledgers.

Boundaries:

- Store metadata-only observations, usage atoms, and activity atoms.
- No raw telemetry, prompt text, response text, tool payloads, file content, or
  repository locators.
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

- Persist privacy-safe `queryId`, `sessionId`, and prompt-state metadata only.
- Prompt text defaults to disabled and must not be required for run assembly.
- This construct exists for stable run correlation, not for a user-facing prompt
  archive.

### TelemetryClassification

JTBD: Identify a supported provider/runtime/profile from allowlisted telemetry
metadata and project only safe atoms onward.

Primary code:

- `packages/engine/src/telemetryClassification.ts`
- `packages/agent/src/otlpIngress.ts`

Boundaries:

- Classification is metadata-only.
- Unknown producers fail closed.
- Supported coding harness classification is currently limited to Claude Code,
  Codex, Cursor, and GitHub Copilot. Service-name aliases, span names, event
  names, and source profiles must be fixture-backed before becoming accepted
  evidence.
- Keep provider surfaces distinct when they carry different authorities.
- Do not group runs, price usage, or claim attribution here.

### PrivacyGuard

JTBD: Centralize what may be stored locally and what may leave the machine.

Primary code:

- `src/privacy/privacyGuard.ts`
- `packages/engine/src/telemetryClassification.ts`

Boundaries:

- Never store or dispatch prompt text, response text, tool inputs, tool outputs,
  file contents, diffs, absolute paths, or raw telemetry payloads in the active
  local-only slice.
- Validate webhook events through an explicit allowlist contract.
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
- All cost remains estimated.
- Usage value is separate from expected billed cost and is emitted only when
  selected usage atoms can be fully valued from approved model-pricing evidence.
- Context footprint reports numeric input-token size and growth only; it never
  stores or exposes the actual context contents.
- Only completed runs enter the durable production ledger.
- Inactivity-based completion is a short UsageProjection quiescence boundary,
  not a multi-minute attribution-settling delay; later provider atoms may
  reproject the same run with advanced totals or timing.
- Once a durable run ledger exists, restart and periodic projection must preserve
  ledger history and reproject only a bounded recent usage/activity window by
  default; it must not replay months of safe atoms just to become operational.
- Correlation ledgers may be read broadly when needed to preserve run identity
  and prompt-state joins, but they do not reopen raw content capture.
- Activity breakdown may retain metadata-only rows, never content-heavy payloads.

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
- Keep shadow and production ledgers separate.
- Exports stay content-light and prompt-blind for the local-only slice.

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
- Repository lookup must not filter by telemetry provider; provider-specific
  readiness belongs to `TelemetrySourceConfiguration`, not repo eligibility.
- Agent startup may defer the initial catch-up scan after epoch/snapshot setup;
  explicit refreshes and polling still drain through the observation contract.

### WorkspaceChangeTracker

JTBD: Reconstruct privacy-safe file-state continuity for a run inside a watched
repository.

Primary code:

- `src/attribution/workspaceChangeTracker.ts`
- `packages/agent/src/productionRunAttribution.ts`

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

### AgenticWorkEpisode

JTBD: Group related run activity and repository evidence into conservative
episodes that Git attribution can evaluate.

Primary code:

- `src/attribution/agenticWorkEpisode.ts`
- `packages/agent/src/productionRunAttribution.ts`

Boundaries:

- Own episode grouping and repository binding.
- Do not price usage or publish events.
- Fail closed when repository binding is absent or ambiguous.
- Runs with unavailable prompt-state identity may be measured as usage, but must
  not open workspace-evidence windows or claim repository changes.

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
- Validate every outbound payload through `PrivacyGuard`.
- Emit repo-relative changed file paths only after allowlisting.
- Bind live run lifecycle observations through provider-neutral watched
  repositories, and fail closed when no watched repository or multiple watched
  repositories match.
- Preserve lifecycle order for a run: start before update before ended.
- `run.start` must not require prompt text capture.
- `run.update` may include only metadata-safe activity, token, reported context
  footprint, model, cost estimate, evidence, and coverage updates; never prompt text, response text, tool arguments,
  command text, raw telemetry, file content, diffs, absolute paths, or transcript
  paths.
- `run.ended` must fire for watched repository runs even when no commit occurs.
- Completed-run lifecycle projection must not wait for attribution settling;
  attribution may improve `run.ended` later with write/file evidence.
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
- Commit event versioning must preserve rewrite and supersession semantics.
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
