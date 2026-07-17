# Harness Run Monitoring

This is the onboarding map for how Tirion observes a coding-harness "Run" from
local telemetry. The relevant constructs are:

- `TelemetrySourceConfiguration`: configures supported local runtimes to emit
  safe telemetry to the local Tirion agent.
- `TelemetryIngress`: accepts OTLP JSON, provider hooks, and Copilot span DB
  replay, then writes only privacy-approved observations.
- `TelemetryClassification`: turns provider-specific records into safe
  provider identity, query occurrences, usage atoms, activity atoms, and
  execution nodes.
- `UsageProjection` and `RunLedger`: choose authoritative usage surfaces,
  assemble completed production runs, and avoid double counting.
- `ExternalWebhookDispatch`: projects shared `run.start`, `run.update`,
  `run.ended`, and `commit.attributed` webhook events.

Tirion currently supports these coding harness identities:

- `codex`
- `claude-code`
- `cursor`
- `github-copilot`

`codingHarness` in webhook payloads is always one of those harness identities.
It is not the same thing as the underlying model provider. For example, GitHub
Copilot may run OpenAI, Anthropic, Google, GitHub, or Microsoft models, but the
run still has `codingHarness: "github-copilot"`.

## Runtime Flow

1. A harness emits telemetry to the local Tirion agent.
2. Tirion accepts it only from approved same-machine surfaces:
   - `POST /v1/logs`
   - `POST /v1/traces`
   - `POST /v1/metrics`
   - `POST /v1/provider-hooks/claude-code`
   - `POST /v1/provider-hooks/codex`
   - `POST /v1/provider-hooks/cursor`
   - configured GitHub Copilot SQLite span DB replay
3. `PrivacyGuard` drops raw payloads and content before durable storage.
   Before that discard, an allowlisted workspace path and structured successful
   write target may be resolved to an opaque watched-repository key and HMAC
   artifact key. Managed command relays attach their configured lifecycle event
   and session working directory only for this transient resolution. The raw
   values are never stored.
4. `TelemetryClassification` creates a `SafeObservationV1` with:
   - `queryOccurrences`
   - `usageAtoms`
   - `activityAtoms`
   - `executionNodes`
5. `UsageProjection` groups usage by query/run identity and picks one
   authoritative usage surface per run.
6. Completed production runs are written to the local run ledger.
7. Live and completed run facts are projected as webhook lifecycle events after
   binding to exactly one watched repository.

Terminal admission and durable outbox queueing are separate from outbound HTTP
delivery. A slow update response cannot make an accepted terminal wait to enter
the outbox; per-run HTTP attempts remain serialized after queueing so receiver
order is preserved. Lifecycle order always refers to receiver-visible deliveries,
not every queued snapshot: a successful terminal suppresses pending stale running
updates for that run.

Empty accepted envelopes do not enter live webhook, repository-observation, or
usage-projection work. Execution-node evidence is retained only in a bounded
local journal and read by query identity, so high-volume harness diagnostics
cannot delay an unrelated lifecycle event. Lifecycle reconciliation likewise
reads usage atoms, workspace evidence, work episodes, and delivered webhook
state by the relevant query, run, trace, or session instead of deserializing
other harnesses' historical records.

No prompt text, response text, tool arguments, tool outputs, raw telemetry,
file contents, diffs, credentials, or absolute paths should leave the privacy
boundary. Prompt capture and content capture default off.

For a live-run audit, read diagnostics by the run's UTC window instead of
depending on the latest-event snapshot:

```bash
tirionctl logs --since 2026-07-13T04:45:40Z --until 2026-07-13T04:47:10Z --limit 1000
```

The bounds are inclusive and must use ISO UTC (`Z`). The response stays capped
at 1,000 events, and the agent scans only its active private structured log plus
three bounded rotations. This preserves immediate run-window evidence when
another harness is concurrently producing high-volume safe diagnostics.

## Shared Ingress Rules

Tirion classifies OTLP by `service.name`:

| `service.name` match | Harness |
| --- | --- |
| contains `claude` | `claude-code` |
| contains `codex` | `codex` |
| contains `cursor` | `cursor` |
| contains `copilot` | `github-copilot` |

Unknown producers fail closed with `unsupported_source`.

The OTLP server accepts JSON only. It rate limits, size limits, classifies,
sanitizes, writes source capability state, appends the safe observation, and
then dispatches downstream work asynchronously.

## Safe Observation Concepts

These are the internal safe facts Tirion stores from provider telemetry.

| Safe fact | Meaning |
| --- | --- |
| `QueryOccurrenceV1` | A prompt/run identity was observed. Prompt text is normally `disabled`. |
| `SafeUsageAtomV1` | Token, model, billing-context, timing, authority, and optional bounded usage-purpose metadata. |
| `SafeActivityAtomV1` | Safe tool, subagent, skill, or MCP activity metadata. |
| `ExecutionNodeAtomV1` | Prompt, LLM request, tool, subagent, skill, or MCP node for lifecycle/activity projection, with the same optional bounded usage purpose for LLM requests. |

Usage authority prevents double counting:

| Harness | Authority priority |
| --- | --- |
| GitHub Copilot | `run`, `request`, `turn`, `model`, `event` |
| Claude Code | `request`, `turn`, `model`, `event`, `run` |
| Codex | `turn`, `request`, `model`, `event`, `run` |
| Cursor | `turn`, `request`, `model`, `event`, `run` |

When traces and logs overlap, Tirion prefers the stronger/provider-specific
surface and keeps lower-authority overlap out of run totals.

Activity hooks and traces use a stable safe request identity. Corroborating
ordinary records revise one logical call, preserving failure evidence and
descendant usage without incrementing counts twice. An exact native Claude
`tool_decision: reject` remains separately addressable activity-only evidence:
it owns no descendant usage, accounting, context, or lifecycle authority. A
cross-surface collision uses opaque `invocationId` whenever either source has
one; request identity is a legacy fallback only when both lack it. Provider-
reported child-session identity links subagent runs to one parent; ambiguous
links fail closed.

Claude Code correlation is deliberately transient. Bounded in-memory maps link
the prompt/session established by `UserPromptSubmit` to the prompt log's trace,
then link that trace to exact request IDs and their allowlisted usage purpose.
Conflicting prompt, session, trace, or request evidence fails closed. This
correlation is restart-limited: it is not a durable identity graph and cannot
reconstruct links that were known only before the local agent restarted.

## Claude Code

### Source Configuration

Tirion manages Claude Code through `~/.claude/settings.json`.

Restore ownership is exact. Tirion never stores an adopted authorization secret
merely to make rollback convenient: if a later agent token would rewrite an
adopted header or preserved hook, configuration fails before mutation. Headers
and hooks created by Tirion from an absent baseline can rotate and restore
normally.

Configured OTLP surfaces:

| Setting | Purpose |
| --- | --- |
| `CLAUDE_CODE_ENABLE_TELEMETRY=1` | Enables Claude Code telemetry. |
| `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` | Enables Claude Code spans; trace readiness is unavailable without this gate even when an OTLP trace exporter is present. |
| `OTEL_LOGS_EXPORTER` includes `otlp` | Enables log export. |
| `OTEL_TRACES_EXPORTER` includes `otlp` | Enables trace export. |
| `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json` | Uses OTLP JSON. |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=<agent>/v1/logs` | Sends logs to Tirion. |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json` | Uses OTLP JSON. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=<agent>/v1/traces` | Sends traces to Tirion. |
| `OTEL_TRACES_EXPORT_INTERVAL=250` | Claude Code's native enhanced-trace export cadence. It is the primary control for near-real-time terminal authority; Tirion restores the exact prior valid numeric value or absence. |
| `OTEL_BSP_SCHEDULE_DELAY=250` | Compatible generic batch-processor cadence retained alongside Claude's native interval; Tirion restores the exact prior valid numeric value or absence. |

After a Claude Code configure or cadence repair, quit and reopen Claude Code
before validating telemetry. Restarting Tirion alone cannot reload the active
Claude process's environment.
| `OTEL_LOG_USER_PROMPTS=0` by default | Keeps prompt capture off. |
| `OTEL_LOG_ASSISTANT_RESPONSES=0` by default | Keeps assistant response text redacted explicitly instead of inheriting the prompt gate. |
| `OTEL_LOG_TOOL_DETAILS=1` by default | Allows tool metadata. |
| `OTEL_LOG_TOOL_CONTENT=0` by default | Keeps tool content off. |
| `OTEL_LOG_RAW_API_BODIES=0` by default | Keeps response/raw body capture off. |

Source IDs:

| Source ID | Signal | Profile |
| --- | --- | --- |
| `otlp_claude_code_logs` | logs | `claude-code-otel-logs-v1` |
| `otlp_claude_code_traces` | traces | `claude-code-enhanced-traces-beta-v1` |
| `hook_claude_code_lifecycle` | provider hook | `claude-code-hooks-v1` |
| `hook_claude_code_tools` | provider hook | `claude-code-hooks-v1` |

### Claude Hooks

Tirion configures these Claude hook names:

| Hook | Accepted? | Run-monitoring role |
| --- | --- | --- |
| `UserPromptSubmit` | Yes | Creates a safe query occurrence and prompt execution node with evidence `submission_hook`. |
| `Stop` | Yes, as a completion candidate | An ordinary Stop becomes terminal only after an exactly correlated closed root `claude_code.interaction`. A nonempty `background_tasks` or `session_crons` value makes the Stop nonterminal. `stop_hook_active` is diagnostic shape metadata, not completion authority. Model responses alone do not end the run. |
| `StopFailure` | Yes, for an exactly correlated root failure | Fires instead of `Stop` for terminal API errors. Claude Code 2.1.201 native evidence proves the `authentication_failed` shape. Tirion accepts it only when opaque prompt and session identities match the remembered submission, emits `completionOutcome: "failure"`, and discards error details, assistant text, transcript/workspace paths, and raw IDs. |
| `SessionEnd` | Diagnostic only | Managed so Tirion can observe a bounded `session_end` category and allowlisted normalized exit reason. On `prompt_input_exit`, if active bounded in-memory correlation still has unresolved background-paused roots, Tirion additionally records only the capped count as the private `claude_background_root_missing_terminal` diagnostic. The emitted diagnostic has no root identity; bounded process-local keys are opaque and used only to count and clear live correlation. Because the hook is session-scoped and may fire for clear, resume, logout, or switching flows, neither diagnostic creates a durable run fact, completes a root, binds a repository, or emits a webhook lifecycle event. |
| `SubagentStart` | Yes | Opens one child-linked `subagent` activity. |
| `SubagentStop` | Yes, as a child stop attempt | Revises the same child identity but remains nonterminal `unknown` because another hook may block it. Exact native child closure must prove a terminal outcome; unmatched stops are discarded. |
| `PreToolUse` | Diagnostic only | It is acknowledged as the safe `pre_tool_use` category, but never creates a durable run fact or retains tool content. It does not authorize a permission decision or outcome; absent UI, local side effects, or later hooks are not outcome evidence. |
| `PostToolUse` | Yes | Creates tool/skill/MCP/subagent activity and execution node. |
| `PostToolUseFailure` | Yes | Creates a failure activity and execution node when explicit failure evidence exists. A structured native interruption may be `rejected`; generic failure never becomes a permission rejection. |

If a Claude `UserPromptSubmit` waits for its bounded transcript-provenance
retry, a same-session normal MCP post hook may be replayed only when its tool
name matches the exact bounded `mcp__server__tool` grammar. Tirion retains only
that bounded identity plus the existing safe correlation/timing aliases; it
does not retain MCP arguments, results, or an `agentId`. Other non-Agent
post-tool hooks remain replay-eligible only for an explicit interruption.

Hook payload fields used for identity and metadata:

- `hook_event_name`
- `session_id`
- `prompt_id` or `turn_id` for prompt hooks
- `tool_name`
- `tool_use_id`
- `duration_ms`
- `background_tasks` and `session_crons` for the ordinary-Stop nonterminal check
- `stop_hook_active` for shape diagnostics only; its value never authorizes a
  terminal
- `subagent_type`, `agent_name`, `name`, or `subagent_id`
- `tool_response.success`, `tool_response.interrupted`, `exit_code`, or
  `status` for outcome

Managed Claude handlers also bind their event in `X-Tirion-Hook-Event`. If that
recognized header conflicts with the recognized `hook_event_name` in the body,
Tirion rejects the request before any transcript, repository, or durable work.
The diagnostic contains only the two normalized event categories.

Tool inputs, tool responses, `cwd`, paths, diffs, and file content are treated
as sensitive. They are not included in normal stored observations or webhooks.

### Claude OTLP Events, Spans, And Attributes

Tirion listens for these Claude Code OTLP shapes:

| Shape | Signal | Safe output | Notes |
| --- | --- | --- | --- |
| `event.name = "claude_code.user_prompt"` | logs | `QueryOccurrenceV1`, prompt node | Evidence `provider_prompt_id`. Prompt text is disabled. |
| `event.name = "user_prompt"` | logs | `QueryOccurrenceV1`, prompt node | Same treatment as `claude_code.user_prompt`. |
| names containing `api_request` | logs or traces | request usage atom, optional provider-reported cost | Reads `cost_usd`, `claude_code.cost_usd`, or `gen_ai.usage.cost_usd`. |
| names containing `request` | logs or traces | request usage atom or execution node when token/model data exists | Example fixture: `claude.request`. |
| names containing `tool_result` or `tool_use` | logs or traces | tool/skill/MCP/subagent activity | Tool kind is inferred from bounded metadata. Claude MCP names may use the exact `mcp__server__tool` form; Tirion accepts that form only when it is syntactically bounded and does not conflict with explicit MCP metadata. For Bash/shell, protocol success or wrapper closure remains `unknown` without explicit process exit/status evidence. |
| `event.name = "tool_decision"` or `"claude_code.tool_decision"` | logs | permission-decision activity | Requires exact `tool_use_id`, safe tool category, and decision `accept` or `reject`. The decision is separate opaque evidence. Match it to an ordinary tool only with `invocationId` whenever either source has one; use request identity only when both invocation IDs are absent. `reject` becomes `rejected`, owns no descendant usage/accounting/context/lifecycle authority, and carries no execution duration/end/result/audit/causal-artifact data. During retained live correction it can source-prune only the exact provisional activity/file proof; durable grouping waits for authoritative completed-run rebuild. `accept` remains `unknown` until a result. Parameters, input, path, content, and decision source are discarded. |
| names containing `tool_use` | logs or traces | tool/skill/MCP/subagent activity | Example fixture: `claude_code.tool_use`. |
| span events named `tool.output` or `tool_output` | traces | optional sensitive audit evidence only when explicitly enabled | Normal active product does not persist the content. |

Identity fields:

- Query: `prompt.id`; interaction-style traces may use `traceId` as fallback.
- Session: `session.id` or `gen_ai.conversation.id`.
- Request: `request.id`, then span ID, trace ID, or `session|event.sequence`.

Token fields:

- `gen_ai.usage.input_tokens`, `gen_ai.usage.prompt_tokens`,
  `input_tokens`, `prompt_tokens`
- `gen_ai.usage.output_tokens`, `gen_ai.usage.completion_tokens`,
  `output_tokens`, `completion_tokens`
- `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cached_tokens`,
  `cache_read_input_tokens`, `cache_read_tokens`, `cached_tokens`
- `gen_ai.usage.cache_creation.input_tokens`, `cache_creation_input_tokens`
- `gen_ai.usage.reasoning.output_tokens`, `reasoning_output_tokens`

Claude's exact native allowlist supplies a bounded usage purpose:

- `query_source=generate_session_title` becomes `auxiliary_session_title`.
- `query_source=sdk` becomes `customer`.
- On the accepted 2.1.201 failed-request surface, exact
  `operation.name=generate_session_title` also becomes
  `auxiliary_session_title`.
- Missing or any other value remains unclassified; arbitrary source or
  operation text is discarded rather than persisted.

The privacy-safe title usage atoms and execution nodes remain available to the
upstream correlation path. Customer usage projection and live lifecycle
projection exclude the exact title request, including overlapping safe
log/trace/node copies that share its request ID. That exclusion covers customer
token totals, model lists, context, estimated cost/value, and LLM-request
activity. Unclassified usage remains counted: absence of a trusted purpose is
not evidence that usage was auxiliary.

For ordinary completion, Claude `Stop` is a transient candidate rather than
proof that the attempt was allowed. The classifier emits the terminal only when
the same in-memory root query/session is confirmed by a closed
`claude_code.interaction`; it also supports the bounded close-before-Stop
delivery reorder. A Stop with nonempty `background_tasks` or `session_crons`
clears the candidate path and remains nonterminal because the session is paused
or still has work. `stop_hook_active` does not change either decision. Inactivity
remains a documented fallback only when the harness exposes no stronger
accepted boundary.

`StopFailure` is different: Claude documents it as non-blockable, and the pinned
2.1.201 terminal-error fixture observed exactly one matching failure hook, no
`Stop`, one failed requested-model `401` LLM request, an optional failed Haiku
title request, and one closed interaction. The accepted versioned snapshot had
both requests, while repeated pinned runs sometimes omit the title request. The
hook can end the matching root with failure; it does not make the closed
interaction or either request a general completion authority. Every observed
request span must retain explicit failure evidence; span closure never converts
`success = false` into success. The model/count rule is a native-census evidence
check; runtime terminal authorization uses the exactly matched
`UserPromptSubmit`/`StopFailure` prompt and session plus the structured error
category, not LLM span count.

These rules now have isolated Claude Code 2.1.207 source-shape evidence,
implementation-level fixtures and focused tests, and fixed-binary managed
source-to-webhook acceptance for one read-only and two writing roots. That
acceptance does not extend to restart-spanning correlation, interactive mode,
recursive/nested subagents, workflow/team grouping, authenticated MCP behavior,
or auxiliary categories other than exact session-title generation.

## Codex

### Source Configuration

Tirion manages Codex through the Codex TOML config and a local hook relay script.

Configured OTLP surfaces:

| Config | Purpose |
| --- | --- |
| `otel.exporter."otlp-http".endpoint=<agent>/v1/logs` | Sends logs to Tirion. |
| `otel.trace_exporter."otlp-http".endpoint=<agent>/v1/traces` | Sends traces to Tirion. |
| `otel.metrics_exporter."otlp-http".endpoint=<agent>/v1/metrics` | Sends metrics to Tirion. |
| `protocol = "json"` | Uses OTLP JSON. |
| `otel.log_user_prompt = false` by default | Keeps prompt capture off. |
| `features.hooks = true` | Activates Codex lifecycle and activity hooks. Hook entries without this gate are inactive. |
| `hooks.UserPromptSubmit` | Sends prompt lifecycle hook through `codex-hook-relay.cjs`. |
| `hooks.Stop` | Sends explicit turn completion. |
| `hooks.SubagentStart` / `hooks.SubagentStop` | Sends child-session lifecycle linkage. |
| `hooks.PostToolUse` | Sends metadata-only tool outcome through `codex-hook-relay.cjs`. |

Codex reviews hook commands before it runs them. Tirion probes the Codex hook
registry through `codex app-server` and does not equate written TOML with an
active source. Repository activation returns `attention_required` with
`hook_trust_required` until the user approves the exact managed commands in
Codex `/hooks`. `hooks_disabled` and `hook_trust_status_unavailable` remain
separate diagnostics. Trust bypass is permitted only inside Tirion's isolated,
vetted automation harness, never in normal product configuration. See the
[Codex hook trust documentation](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

Source IDs:

| Source ID | Signal | Profile |
| --- | --- | --- |
| `otlp_codex_logs` | logs | `codex-otel-logs-v1` |
| `otlp_codex_traces` | traces | `codex-otel-traces-v1` |
| `otlp_codex_metrics` | metrics | `codex-otel-metrics-v1` |
| `hook_codex_lifecycle` | provider hook | `codex-hooks-v1` |
| `hook_codex_tools` | provider hook | `codex-hooks-v1` |

### Codex Hooks

| Hook | Accepted? | Run-monitoring role |
| --- | --- | --- |
| `UserPromptSubmit` | Yes | Creates a safe query occurrence and prompt node with evidence `submission_hook`. |
| `PostToolUse` | Yes | Creates safe tool/skill/MCP/subagent activity and execution node. |
| `SubagentStart` / `SubagentStop` | Yes | Creates one child-linked subagent activity with terminal outcome and timing. |
| `Stop` | Yes | Completes the matching turn with explicit `stop_hook` authority. |

Hook payload fields used:

- `hook_event_name`
- `turn_id`
- `session_id`
- `tool_name`
- `tool_use_id`
- `duration_ms`
- `tool_response.success`, `tool_response.interrupted`, `exit_code`, or
  `status` for outcome

Codex 0.142 may return an unstructured `tool_response` string for shell commands,
while `codex.tool_result.success` reports tool-protocol completion rather than
the child process exit status. Tirion merges the hook and call-ID-bearing OTLP
record by opaque request ID and reports one call, but leaves the shell outcome
`unknown` unless a native structured exit code or status is present. Explicit
dispatch failures remain failures. A tool result without `call_id` is ignored,
and Tirion never infers an outcome from response text. Arguments and output are
never retained.

For `apply_patch`, Codex places the transient patch text in
`tool_input.command`. Tirion extracts only repo-relative target paths, resolves
them immediately to opaque artifact keys, and discards the command and patch.

Codex hook relay reads the hook JSON from stdin and posts it to
`/v1/provider-hooks/codex`. Raw hook payload content is not persisted.

### Codex OTLP Events, Spans, Metrics, And Attributes

Tirion listens for these Codex shapes:

| Shape | Signal | Safe output | Notes |
| --- | --- | --- | --- |
| `event.name = "codex.user_prompt"` | logs | `QueryOccurrenceV1`, prompt node, remembered active query | Evidence `provider_user_prompt_event`. |
| `event.name = "codex.sse_event"` plus `event.kind = "response.completed"` | logs | request usage atom | One slice per completed model response; requires a remembered prompt or matching turn/session identity and does not complete the run. |
| names containing `turn` | traces or logs | cumulative turn usage atom / execution node | A closed `codex.turn` is authoritative over corroborating response slices. |
| `name = "codex.tool_result"` | logs or traces | safe request/protocol corroboration | Requires `call_id`; merges with managed `PostToolUse` by request identity, preserves the hook's semantic name/timing, and never becomes a second tool row. Unified-exec protocol success remains `unknown` as a shell outcome; explicit protocol failure remains `failure`. Raw arguments/output are discarded. |
| names containing `dispatch_tool_call` | traces or logs | internal corroboration only | Dispatch plumbing is not customer-visible work and cannot inflate activity counts. |
| metric name matching `(^|[._])skill[._]injected$` | metrics | skill activity | Example: `codex.skill.injected`; requires an active remembered prompt in the last 15 minutes. |

Identity fields:

- Explicit turn: `turn.id` or `gen_ai.turn.id`.
- Session: `thread.id`, `conversation.id`, `gen_ai.conversation.id`,
  `session.id`, then trace ID.
- Request: tool `call_id` when present, then `request.id`, span ID, trace ID, or
  `query|event.sequence`.

Codex completion logs are intentionally fail-closed. A `codex.sse_event`
`response.completed` usage slice is ignored unless Tirion can correlate it
to an earlier `codex.user_prompt` or explicit turn/session identity. This keeps
request usage from being attached to the wrong run. Stable response identity
deduplicates replay; distinct responses are summed exactly once. A closed turn
trace supersedes the sum when available, and explicit `Stop` is terminal.

Token fields:

- `codex.turn.token_usage.input_tokens`, `gen_ai.usage.input_tokens`,
  `gen_ai.usage.prompt_tokens`, `input_tokens`, `prompt_tokens`,
  `input_token_count`
- `codex.turn.token_usage.output_tokens`, `gen_ai.usage.output_tokens`,
  `gen_ai.usage.completion_tokens`, `output_tokens`, `completion_tokens`,
  `output_token_count`
- `codex.turn.token_usage.cached_input_tokens`,
  `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cached_tokens`,
  `cache_read_input_tokens`, `cache_read_tokens`, `cached_tokens`,
  `cached_token_count`
- `gen_ai.usage.cache_creation.input_tokens`, `cache_creation_input_tokens`,
  `cache_creation_tokens`
- `codex.turn.token_usage.reasoning_output_tokens`,
  `gen_ai.usage.reasoning.output_tokens`, `reasoning_output_tokens`,
  `reasoning_token_count`

Billing context:

- `auth_mode = api`, `api_key`, or `apikey` means `openai-direct`.
- `auth_mode = swic`, `chatgpt`, or `chatgpt_plan` means `subscription`.
- Unknown auth mode means cost may remain unavailable, although usage value can
  still be reported when model pricing matches.

Codex run-level webhook subjects may aggregate multiple underlying production
runs only when provider child-session linkage proves they belong to one root.
Linked child usage and activity are folded into the root exactly once; the same
child is not also emitted as a standalone total. A same-name child aggregate is
marked complete only when every represented child instance has an exact link;
partial or ambiguous linkage remains explicitly unavailable.

## Cursor

### Source Configuration

Tirion manages Cursor through the user-scope Cursor `hooks.json` file and a
private same-machine hook relay script. It does not enable prompt, command,
tool payload, path, or file-content capture.

Configured hook surfaces:

| Hook group | Cursor events | Purpose |
| --- | --- | --- |
| Lifecycle | `sessionStart`, `beforeSubmitPrompt`, `afterAgentResponse`, `stop`, `sessionEnd`, `preCompact` | Defines safe run identity, timing, and usage lifecycle. |
| Activity | `preToolUse`, `postToolUse`, `postToolUseFailure`, `subagentStart`, `subagentStop`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `afterAgentThought`, `afterFileEdit` | Adds metadata-only tool, shell, MCP, subagent, thought, and file-edit evidence. |

Source IDs:

| Source ID | Signal/source | Profile |
| --- | --- | --- |
| `hook_cursor_lifecycle` | provider hook | `cursor-hooks-v1` |
| `hook_cursor_tools` | provider hook | `cursor-hooks-v1` |
| `otlp_cursor_logs` | logs | `cursor-otlp-logs-v1` |
| `otlp_cursor_traces` | traces | `cursor-otlp-traces-v1` |

### Cursor Hooks

Cursor hook relay posts provider-hook JSON to `/v1/provider-hooks/cursor`.
Raw hook payload content is not persisted. Tirion stores only privacy-safe
identities and metadata.

Hook payload fields used when present:

- `conversation_id`
- `generation_id`
- `model` or `model_name`
- token usage counts
- `tool_name`
- `shell_execution_id`
- `mcp_server_name`
- `mcp_tool_name`
- `edit_id`
- timing and outcome fields

Cursor Auto/Composer estimates use the verified Cursor catalog when model and
token evidence match. Hook-only Cursor observations without enough model/token
evidence remain usage-only or unpriced rather than falling through to another
provider's billing catalog.

## GitHub Copilot

### Source Configuration

GitHub Copilot is supported but not Tirion-managed in this branch. Tirion does
not silently mutate VS Code Copilot settings.

Accepted sources:

| Source ID | Signal | Source kind | Profile |
| --- | --- | --- | --- |
| `otlp_github_copilot_traces` | traces | `otlp-http-json` | `copilot-otlp-traces-v1` |
| `otlp_github_copilot_logs` | logs | `otlp-http-json` | `copilot-otlp-logs-v1` |
| `span_db_github_copilot_traces` | traces | `sqlite-span-db` | `copilot-span-db-traces-v1` |
| `span_db_github_copilot_logs` | logs | `sqlite-span-db` | `copilot-span-db-logs-v1` |

The active happy path is operator-configured span DB replay or approved OTLP
JSON. Tirion does not claim active protobuf OTLP ingestion.

### Copilot Span DB Replay

When configured, Tirion polls the Copilot span DB every second. It requires
these SQLite tables:

- `spans`
- `span_attributes`
- `span_events`

On first configuration it starts from the current max `start_time_ms` so it
does not silently backfill historical data. It revisits a five-minute window and
re-emits changed span revisions when end time, status, attributes, or events
change.

The authenticated pre-stop drain seals this local poller with the other
telemetry ingress. A durable append already in progress and its downstream
admission finish before the barrier can report drained; not-yet-admitted rows
from a selected batch remain replayable if the barrier times out and reopens.

Span DB columns mapped into safe OTLP attributes include:

- `operation_name` -> `gen_ai.operation.name`
- `provider_name` -> `gen_ai.provider.name`
- `agent_name` -> `gen_ai.agent.name`
- `conversation_id` -> `gen_ai.conversation.id` and
  `copilot_chat.session_id`
- `request_model` -> `gen_ai.request.model`
- `response_model` -> `gen_ai.response.model`
- `input_tokens` -> `gen_ai.usage.input_tokens`
- `output_tokens` -> `gen_ai.usage.output_tokens`
- `cached_tokens` -> `gen_ai.usage.cache_read.input_tokens`
- `reasoning_tokens` -> `gen_ai.usage.reasoning.output_tokens`
- `tool_name` -> `gen_ai.tool.name`
- `tool_call_id` -> `gen_ai.tool.call.id`
- `tool_type` -> `gen_ai.tool.type`
- `chat_session_id` -> `copilot_chat.chat_session_id`
- `turn_index` -> `turn.index`
- `ttft_ms` -> `copilot_chat.time_to_first_token`

Span DB events are replayed as log records. Relevant event names are handled by
the same classifier as direct OTLP logs.

### Copilot OTLP Events, Spans, Metrics, And Attributes

Tirion listens for these Copilot shapes:

| Shape | Signal/source | Safe output | Notes |
| --- | --- | --- | --- |
| root span name starting with `invoke_agent` | traces or span DB | run occurrence, run-authority usage atom, execution node | Evidence `provider_root_span`; root/no-parent spans are the authoritative run root for completed trace assembly. |
| span name starting with `chat` | traces or span DB | model usage candidate | Lower priority than `invoke_agent`; can enrich reasoning/cache/model metadata only when totals reconcile. |
| event name `user_message` | logs or span DB event | query occurrence / possible run start | Evidence `provider_user_message_event`; prompt text is disabled. |
| span name starting with `execute_tool` | traces or span DB | tool/subagent activity | Tool name comes from attributes or suffix after `execute_tool`. |
| event name `copilot_chat.tool.call` | logs or span DB event | tool/subagent activity | Uses `gen_ai.tool.name` when available. |
| event name `copilot_chat.agent.turn` | logs/events | event usage candidate | Deduped with inference-detail events by conversation/turn. |
| event name `gen_ai.client.inference.operation.details` | logs/events | event usage candidate | Used for model/token details when span authority is absent. |
| event name `copilot_chat.session.start` | logs/events | event-only run evidence in compatibility assembler | Does not by itself provide final usage. |
| metric name `gen_ai.client.token.usage` | metrics | metric usage candidate in compatibility assembler | Marked partial when trace correlation is incomplete. |

Identity fields:

- Query/turn: `gen_ai.turn.id`, `turn.id`, `request.id`, then trace ID.
- Session: `copilot_chat.session_id`, `gen_ai.conversation.id`,
  `session.id`, `copilot_chat.chat_session_id`, then query ID.
- Chat session: `copilot_chat.chat_session_id`.
- Tool call: `gen_ai.tool.call.id`, `tool.call.id`,
  `github.copilot.tool.call.id`, `copilot.tool.call.id`.

Token fields:

- `gen_ai.usage.input_tokens`, `gen_ai.usage.prompt_tokens`,
  `llm.usage.prompt_tokens`, `input_tokens`, `prompt_tokens`
- `gen_ai.usage.output_tokens`, `gen_ai.usage.completion_tokens`,
  `llm.usage.completion_tokens`, `output_tokens`, `completion_tokens`
- `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cached_tokens`,
  `cache_read_input_tokens`, `cached_tokens`
- `gen_ai.usage.cache_creation.input_tokens`, `cache_creation_input_tokens`
- `gen_ai.usage.reasoning.output_tokens`, `reasoning_output_tokens`

Copilot billing context is always `github-copilot`. Cost estimation uses the
GitHub Copilot catalog only when model and token evidence are sufficient.

## Benchmarking Lengthy Runs

Lengthy-run benchmarks exercise the normal local agent and canonical webhook
contract; they do not require a provider-specific public event family.

1. Use the same release-candidate CLI and agent build. Version skew can hide a
   control such as `runtime quiesce` even while the running agent supports it.
2. Run an explicitly watched repository through a loopback receiver. Keep
   receiver ingestion independent from dashboard indexing; synchronous scans of
   a large event history invalidate end-to-end p95 measurements.
3. Select benchmark roots from the provider's accepted public start authority,
   such as a non-delayed prompt hook. A delayed historical `usage_projection`
   may arrive in the same window and must remain a separate run.
4. Treat every `run.update` as a replacement snapshot. Measure delivery cadence
   and monotonic `updatedAt`; never add update totals together.
5. Measure at least source duration, source-start-to-first-receiver delivery,
   completion-boundary-to-first-terminal delivery, provider-to-admission and
   admission-to-receiver latency separately, update-gap p50/p95/max, terminal
   versions, total tokens, activity coverage, and queue age.
6. Require one coherent start/update/terminal sequence per benchmark root,
   unique event IDs, increasing terminal versions, no post-terminal update, and
   exact activity-to-run token conservation when coverage is final. For a
   multi-agent Codex root, every child may complete before the root; none may
   publish the public `run.ended`, and later root updates must remain visible.
7. Audit only privacy-safe metadata. Scan for forbidden keys and canaries, but
   never retain or report prompts, responses, tool arguments/results, raw
   telemetry, file contents, diffs, transcript locations, or absolute paths.
8. After every root has terminal evidence, drain to a fixed point with
   `tirionctl runtime quiesce --timeout-ms 60000`, then immediately restart the
   agent and verify healthy source and webhook state. A successful drain seals
   ingress until restart; a timed-out drain is not acceptance.

`REL-E2E-20260716T082716Z` is the first release-scoped concurrent baseline: one
Claude Code root ran for 349 seconds with 20 updates, and one Codex root ran for
520 seconds with 43 updates. Both delivered ordered versioned terminals, final
coverage, exact conservation, zero duplicate/post-terminal delivery, and clean
privacy evidence. It establishes functional monitoring, not throughput or
latency percentiles. Repeated isolated-receiver samples, slow-sink/retry/restart
load, and exact interpretation of layered Codex `Bash`/`exec` rows remain
next-release work.

Keep the receiver dashboard closed during timed ingestion. The current local
reference dashboard can rebuild its full historical model after an SSE event;
that synchronous scan is receiver contention, not agent delivery latency. A
benchmark result must report this state and must split source-to-admission,
outbox/HTTP, and receiver processing time rather than assigning the whole delay
to the webhook sink.

## Activity Classification

For all harnesses, tool-like telemetry is converted into one of:

- `tool`
- `subagent`
- `skill`
- `mcp`

The activity kind is inferred from:

- tool span/event names
- `gen_ai.tool.name`
- `tool.name`
- `tool_name`
- `copilot.tool.name`
- JSON `tool_parameters.skill_name`
- `skill.name` or `skill_name`
- `mcp_server`, `mcp_server.name`, or JSON `tool_parameters.mcp_server_name`
- `subagent_type` or JSON `tool_parameters.subagent_type`

Outcomes are inferred from `success`, status/outcome fields, hook responses, or
span status. Unknown status remains `unknown` rather than guessed. A generic
failure is never upgraded merely from identity overlap: only a validated exact
native permission decision may carry rejection semantics.

## Run Lifecycle Webhooks

Tirion emits the same webhook event family for every harness:

| Webhook event | Meaning |
| --- | --- |
| `run.start` | A privacy-safe run identity started in one watched repository. |
| `run.update` | Activity or partial usage changed before terminal completion. |
| `run.ended` | Terminal snapshot for a completed run; it can be a timely provisional snapshot or a finalized correction. |
| `commit.attributed` | A real git commit was conservatively linked to one or more writing runs. |

Live `run.start` anchors:

| Harness | Start evidence accepted for live webhook starts |
| --- | --- |
| Claude Code | `submission_hook` only; prompt logs remain private correlation evidence until the hook arrives |
| Codex | `submission_hook` only |
| Cursor | `submission_hook` from `beforeSubmitPrompt` |
| GitHub Copilot | `provider_root_span`, `provider_user_message_event`, span DB replay of either |

`run.update` can be projected from activity atoms, execution nodes, or usage
atoms. A high-confidence explicit completion can produce a repository-bound,
provisional `run.ended` from the live lane. It contains only accumulated safe
live activity and usage and is marked with non-final coverage. Completed-run
projection later publishes the authoritative terminal version. `final` coverage
describes the closed authority available to that version, rather than an
immutability promise: late-delivered evidence that began before the same
boundary can issue a higher replacement terminal without reopening updates.
Every `run.ended` includes the safe token totals, model list, estimated
cost/value fields when available, and repo-relative `filesChanged` known at that
version. The sole live provisional exception may include a file only from the
direct retained source execution node that itself supplies the artifact key
and an explicit successful allowlisted semantic-write outcome. It never accepts
a raw artifact key, a generic causal-key set, or a grouped activity result.
A late exact native decision may source-prune only that matching provisional
activity/file proof during the 15-second retention and issue a higher terminal
version; it cannot promise that an unseen decision was present before an active
first send. Later durable correction or commit projection uses the proof below.

The first accepted prompt anchor fixes public `startedAt` for the lifecycle.
Delayed provider logs or traces may enrich identity and usage but cannot rewind
that timestamp after `run.start` has been published.

Repository binding is provider-neutral. A live lifecycle event requires exactly
one exact opaque repository binding, or the legacy unambiguous single-watched-
repository fallback. Completed delivery fails closed when binding is missing or
ambiguous. Snapshot timing alone does not establish run-level file ownership.
Completed and late-correction `filesChanged` requires a retained bounded
`{ artifactKey, executionNodeId }` proof, revalidated against the exact
same-query/repository durable execution node: it must contain that artifact
and be a successful allowlisted semantic-write tool node. Missing, malformed,
or unreadable proof fails external file and commit projection closed. A generic
causal-key set or grouped activity result cannot substitute for the pair.
Historical internal allocation revokes only with a complete census and explicit
`nativeRejectedCausalWriteArtifacts`; missing, empty, or unreadable marker
evidence does not revoke allocation or a valid sibling writer.

## Completion And Settling

Tirion treats completed production runs as authoritative:

- Submission-hook runs require the provider-specific authoritative terminal
  boundary. An individual model response never ends them. A trusted explicit
  completion can trigger a provisional terminal snapshot; completed-run
  projection remains the final usage authority.
- Claude Code ordinary Stop requires the matching closed root interaction for
  the same query/session. Nonempty background-task or session-cron state is
  nonterminal, and `stop_hook_active` is never authority.
- A Claude `prompt_input_exit` with unresolved background-paused roots still in
  active in-memory correlation records only a capped count-only private
  `claude_background_root_missing_terminal` diagnostic. The emitted diagnostic
  retains no root identity; bounded process-local keys are opaque and used only
  to count and clear live correlation. It creates no durable observation,
  terminal, repository binding, or webhook; SessionEnd remains unable to
  substitute for the exact Stop/closed-root join.
- Inactivity-mode sources wait for the inactivity window only when the harness
  lacks stronger terminal evidence.
- Once explicit provider completion is durable, evidence that starts after its
  boundary cannot revise usage, activity, cost, or `endedAt`. Late-delivered
  evidence that began before the boundary remains eligible; inactivity evidence
  does not activate this freeze.
- Codex request slices accumulate for live usage, while the closed cumulative
  turn trace is final usage authority and `Stop` is final lifecycle authority.
- A linked Codex child completion can enrich usage and activity, but it cannot
  close a durable public root from completed-run projection. This remains true
  after dispatcher restart; only completion of the public root permits its
  terminal, and ordinary root updates continue meanwhile.
- Copilot root `invoke_agent` spans become completed when the root span has an
  end time or terminal error status.
- Running updates remain immediate. Completed-run `settling` projections share
  one replaceable outbox slot until the terminal deadline, allowing a root/turn
  authority to supersede provisional request slices before publication.
- Ordinary live observations are durably admitted independently of outbound
  HTTP completion. The bounded outbox still serializes per-run delivery and
  preserves public order, while a slow receiver response no longer holds every
  later observation in the runtime projection queue.
- Background usage reconciliation waits for five seconds of quiet after live
  telemetry. This prevents periodic or event-triggered rebuilds from competing
  with durable lifecycle delivery during the three-second terminal grace period.
- The first terminal deadline is fixed from explicit trusted completion when
  available, otherwise authoritative completion (three seconds by default);
  delayed telemetry cannot slide it. A live terminal snapshot contains the safe
  evidence received by that deadline and normally uses non-final coverage. If
  every usage-bearing query already has a closed authoritative boundary, it may
  state `final`; later eligible pre-boundary evidence still becomes a higher
  replacement `run.ended` version.
- During the bounded 15-second terminal retention, later evidence with the exact
provider/runtime/session/query identity and a start at or before the retained
completion boundary wakes that query-family projection directly. An exact
native decision may source-prune only its matching live provisional activity/
file proof; a durable grouped activity changes only through authoritative
completed-run rebuild. An existing commit event whose exact proof is pruned
may later publish `superseded`, while an independently valid sibling writer
stays active. This is a bounded versioned correction, not a guarantee that the
active version could not have been delivered first. It does not wait behind
unrelated global quiet-window traffic, and post-boundary evidence remains
ineligible.
- Claude's exact eligible Stop/closed-root interaction join immediately triggers
  query-family terminal projection rather than waiting for the ordinary global
  quiet window. Terminal admission never awaits outbound HTTP and durably queues
  terminal meaning even if a same-run update attempt is in flight; only attempts
  remain serialized. The normal delivery order is
  `run.start -> delivered run.update(s) -> run.ended`, with an eligible settling
  update selected before a normal terminal; queued stale running snapshots may be
  suppressed after terminal delivery. A narrow exception applies only to the
  trusted closed-root terminal whose webhook `codingHarness` and runtime are
  `claude-code`, whose `evidence.basis` is `root_span`, and whose
  `evidence.delayed` is `false`: when fresh and due, it ranks after fresh starts
  and ahead of fresh settling updates from the same or another run in ordinary
  and bounded-bypass lifecycle selection. Its own public sequence is
  `run.start -> optional delivered run.update(s) -> run.ended`. It never
  preempts an update HTTP attempt already in flight. A failed/retrying terminal
  leaves that pending settling snapshot as a fallback; successful terminal
  delivery suppresses it. Other Claude terminal evidence retains the normal
  settling-update-before-terminal order. A Stop without the matching closed root
  remains nonterminal.
- Each deadline wake re-reads the durable outbox and schedules the next earliest
  entry, preserving the applicable normal or trusted-Claude closed-root order
  even for deadlines a few milliseconds apart.

`commit.attributed` is separate from run completion. It fires only when git
attribution has proof connecting writing runs to a real commit. If an existing
event later loses its exact causal proof through the bounded native-decision
correction, it publishes a later `superseded` version; Tirion does not create
a new unrelated commit event or remove an independently proven sibling writer.

## Privacy Checklist

A new harness surface must preserve these invariants:

- Do not persist raw telemetry payloads.
- Do not persist or webhook prompt text, response text, tool arguments, tool
  outputs, file content, diffs, credentials, transcript paths, or absolute
  paths.
- Hash raw provider trace, session, prompt, request, and turn IDs before storing
  them as run/query/session/request IDs.
- Use repo-relative changed paths only after repository allowlisting.
- Fail closed when source identity, run identity, repository binding, or
  attribution evidence is missing or ambiguous.
- Prefer stronger provider authority over overlapping lower-authority telemetry
  instead of summing both.

## Code Anchors

- Source configuration:
  - `packages/agent/src/sourceConfiguration.ts`
- HTTP/provider-hook ingress:
  - `packages/agent/src/otlpIngress.ts`
- Copilot span DB replay:
  - `packages/agent/src/copilotSpanDbIngress.ts`
  - `src/ingestion/spanDbTelemetryIngestion.ts`
- Classification and privacy-safe atoms:
  - `packages/engine/src/telemetryClassification.ts`
- Production usage projection:
  - `packages/engine/src/shadowUsage.ts`
  - `packages/agent/src/productionUsageService.ts`
- Webhook lifecycle projection:
  - `packages/agent/src/externalWebhookDispatch.ts`
- Shared contracts:
  - `packages/agent-contract/src/index.ts`
  - `src/types.ts`
- Primary tests:
  - `packages/engine/src/telemetryClassification.test.ts`
  - `packages/agent/src/otlpIngress.test.ts`
  - `packages/agent/src/copilotSpanDbIngress.test.ts`
  - `packages/agent/src/externalWebhookDispatch.test.ts`
  - `packages/agent/src/productionUsageService.test.ts`
  - `src/normalization/telemetryNormalizer.test.ts`
  - `src/aggregation/tokenMeasurement.test.ts`
  - `src/aggregation/agentRunAssembler.test.ts`
