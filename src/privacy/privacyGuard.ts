import * as path from "node:path";
import {
  AgenticQueryRun,
  CanonicalOtelRecord,
  PrivacyGuard,
  PrivacyValidationResult
} from "../types";

export const INITIAL_USER_QUERY_ATTRIBUTE = "tirion.initial_user_query";

const CONTENT_ATTRIBUTE_PATTERNS = [
  /^content$/i,
  /^gen_ai\.input\.messages$/,
  /^gen_ai\.output\.messages$/,
  /prompt/i,
  /completion/i,
  /response\.text/i,
  /tool.*args/i,
  /tool.*arguments/i,
  /tool.*schema/i,
  /tool.*result/i,
  /file.*content/i,
  /file.*path/i,
  /system.*message/i,
  /message\.content/i,
  /code_snippet/i
];

const ATTRIBUTION_FORBIDDEN_KEY_PATTERNS = [
  /path/i,
  /diff/i,
  /content/i,
  /prompt/i,
  /response/i,
  /tool.*args/i,
  /tool.*arguments/i,
  /tool.*result/i,
  /code_snippet/i
];

// Causal-write pairs are retained in workspace evidence so a later terminal
// correction can prove an individual artifact came from an exact successful
// semantic-write node. They are identifiers, never telemetry payloads or
// workspace locators.
const MAX_CAUSAL_WRITE_ARTIFACTS = 100;
const MAX_OPAQUE_CAUSAL_WRITE_IDENTIFIER_LENGTH = 200;
const OPAQUE_CAUSAL_WRITE_IDENTIFIER = /^[A-Za-z0-9_-]+$/;

const PUBLICATION_INTENT_KEYS = new Set([
  "schemaVersion",
  "owner",
  "repository",
  "commitSha",
  "publicationVersion",
  "state",
  "estimatedNanoUsd",
  "coverage",
  "attributedQueryCount",
  "commitMessage",
  "firstVerifiedAt",
  "updatedAt"
]);

const RUN_ENDED_WEBHOOK_KEYS = new Set([
  "schemaVersion",
  "eventType",
  "eventId",
  "runId",
  "sessionId",
  "traceIds",
  "sender",
  "repository",
  "codingHarness",
  "runtime",
  "startedAt",
  "evidence",
  "coverage",
  "version",
  "outcome",
  "endedAt",
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "reasoningOutputTokens",
  "totalTokens",
  "llmModels",
  "filesChanged",
  "estimatedNanoUsd",
  "usageValueNanoUsd",
  "costEstimateBasis",
  "costCoverage",
  "context",
  "activity",
  "state"
]);

const RUN_STARTED_WEBHOOK_KEYS = new Set([
  "schemaVersion",
  "eventType",
  "eventId",
  "runId",
  "sessionId",
  "traceIds",
  "sender",
  "repository",
  "codingHarness",
  "runtime",
  "startedAt",
  "evidence",
  "coverage",
  "sequence",
  "updatedAt",
  "state",
  "llmModels"
]);

const RUN_UPDATED_WEBHOOK_KEYS = new Set([
  "schemaVersion",
  "eventType",
  "eventId",
  "runId",
  "sessionId",
  "traceIds",
  "sender",
  "repository",
  "codingHarness",
  "runtime",
  "startedAt",
  "evidence",
  "coverage",
  "sequence",
  "updatedAt",
  "state",
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "reasoningOutputTokens",
  "totalTokens",
  "llmModels",
  "estimatedNanoUsd",
  "usageValueNanoUsd",
  "costEstimateBasis",
  "costCoverage",
  "context",
  "activity"
]);

const COMMIT_ATTRIBUTED_WEBHOOK_KEYS = new Set([
  "schemaVersion",
  "eventType",
  "eventId",
  "sender",
  "repository",
  "commitSha",
  "commitMessage",
  "traceIds",
  "runIds",
  "estimatedNanoUsd",
  "usageValueNanoUsd",
  "costCoverage",
  "state",
  "version",
  "firstVerifiedAt",
  "updatedAt"
]);

export class DefaultPrivacyGuard implements PrivacyGuard {
  sanitize(record: CanonicalOtelRecord): CanonicalOtelRecord {
    return {
      ...record,
      attributes: sanitizeAttributes(record.attributes, extractUserMessageEventQuery(record)),
      resourceAttributes: sanitizeAttributes(record.resourceAttributes)
    } as CanonicalOtelRecord;
  }

  validateRun(run: AgenticQueryRun): PrivacyValidationResult {
    const violations = collectContentKeyViolations(run);

    return {
      ok: violations.length === 0,
      violations
    };
  }

  validateAttribution(record: unknown): PrivacyValidationResult {
    const violations = [
      ...collectAttributionKeyViolations(record),
      ...collectCausalWriteArtifactViolations(record)
    ];

    return {
      ok: violations.length === 0,
      violations
    };
  }

  validatePublication(record: unknown): PrivacyValidationResult {
    const valid = isStrictPublicationIntent(record) || isStrictWebhookEvent(record);
    return valid
      ? { ok: true, violations: [] }
      : { ok: false, violations: ["Publication intent is outside the outbound allowlist."] };
  }
}

export function sanitizeAttributes(
  attributes: Record<string, unknown>,
  initialQueryOverride?: string
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  if (initialQueryOverride) {
    sanitized[INITIAL_USER_QUERY_ATTRIBUTE] = initialQueryOverride;
  }

  for (const [key, value] of Object.entries(attributes)) {
    if (key === "gen_ai.input.messages") {
      const initialQuery = extractInitialUserQueryText(value);
      if (initialQuery && !sanitized[INITIAL_USER_QUERY_ATTRIBUTE]) {
        sanitized[INITIAL_USER_QUERY_ATTRIBUTE] = initialQuery;
      }
      continue;
    }
    if (isContentAttribute(key)) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function extractUserMessageEventQuery(record: CanonicalOtelRecord): string | undefined {
  if (record.kind !== "event" || record.name !== "user_message") {
    return undefined;
  }

  return extractPromptContentText(record.attributes.content);
}

export function isContentAttribute(key: string): boolean {
  return CONTENT_ATTRIBUTE_PATTERNS.some((pattern) => pattern.test(key));
}

export function extractInitialUserQueryText(value: unknown): string | undefined {
  const messages = normalizeMessages(value);
  if (messages.length === 0) {
    if (typeof value !== "string") {
      return undefined;
    }

    return normalizeCandidateQueryText(value);
  }

  const firstUserMessage = messages.find((message) => message.role.toLowerCase() === "user") ?? messages[0];
  const text = textFromMessageContent(firstUserMessage.content);
  return normalizeCandidateQueryText(text);
}

function normalizeCandidateQueryText(value: string): string | undefined {
  const text = extractPromptEnvelopeUserRequest(value) ?? extractPlainStringQuery(value);
  return text?.trim() ? text.trim() : undefined;
}

function extractPromptContentText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : textFromMessageContent(value);
  return normalizeCandidateQueryText(text);
}

function extractPromptEnvelopeUserRequest(value: string): string | undefined {
  const match = value.match(/<userRequest>([\s\S]*?)<\/userRequest>/i);
  if (!match) {
    return undefined;
  }

  const text = decodeBasicXmlEntities(match[1]).trim();
  return text === "" ? undefined : text;
}

function extractPlainStringQuery(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }

  if (looksLikeStructuredPromptEnvelope(trimmed)) {
    return undefined;
  }

  return trimmed;
}

function looksLikeStructuredPromptEnvelope(value: string): boolean {
  return /<[^>]+>/.test(value) && /<environment_info>|<workspace_info>|<userRequest>|<attachments>|<context>/i.test(value);
}

function decodeBasicXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeMessages(value: unknown): Array<{ role: string; content: unknown }> {
  if (typeof value === "string") {
    try {
      return normalizeMessages(JSON.parse(value));
    } catch {
      return [];
    }
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const role = typeof item.role === "string" ? item.role : "";
    return [{ role, content: item.content ?? item.contents ?? item.text ?? item.parts }];
  });
}

function textFromMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map(textFromMessageContent).filter((item) => item.trim() !== "").join("\n");
  }

  if (!isRecord(content)) {
    return "";
  }

  if (Array.isArray(content.parts)) {
    return content.parts.map(textFromMessageContent).filter((item) => item.trim() !== "").join("\n");
  }

  if (typeof content.text === "string") {
    return content.text;
  }
  if (typeof content.content === "string") {
    return content.content;
  }
  if (typeof content.value === "string") {
    return content.value;
  }

  return "";
}

function collectContentKeyViolations(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectContentKeyViolations(item, `${path}[${index}]`));
  }

  if (!isRecord(value)) {
    return [];
  }

  const violations: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (key === "initialQueryText" || key === INITIAL_USER_QUERY_ATTRIBUTE) {
      continue;
    }
    if (isContentAttribute(key)) {
      violations.push(childPath);
      continue;
    }
    violations.push(...collectContentKeyViolations(child, childPath));
  }

  return violations;
}

function collectAttributionKeyViolations(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectAttributionKeyViolations(item, `${path}[${index}]`));
  }

  if (!isRecord(value)) {
    return [];
  }

  const violations: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (isAttributionForbiddenKey(key)) {
      violations.push(childPath);
      continue;
    }
    violations.push(...collectAttributionKeyViolations(child, childPath));
  }

  return violations;
}

function collectCausalWriteArtifactViolations(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectCausalWriteArtifactViolations(item, `${path}[${index}]`));
  }

  if (!isRecord(value)) {
    return [];
  }

  const violations: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (key === "causalWriteArtifacts" || key === "nativeRejectedCausalWriteArtifacts") {
      violations.push(...validateCausalWriteArtifacts(child, childPath));
      continue;
    }
    if (key === "matchedCausalWriteArtifacts") {
      violations.push(...validateMatchedCausalWriteArtifacts(child, childPath));
      continue;
    }
    violations.push(...collectCausalWriteArtifactViolations(child, childPath));
  }
  return violations;
}

function validateCausalWriteArtifacts(value: unknown, path: string): string[] {
  // Normalizers preserve optional record shape with an explicit `undefined`;
  // treat that exactly like the absent legacy field rather than rejecting an
  // otherwise privacy-safe record.
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return [path];
  }
  if (value.length > MAX_CAUSAL_WRITE_ARTIFACTS) {
    return [`${path}.length`];
  }

  const violations: string[] = [];
  const pairs = new Set<string>();
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      violations.push(itemPath);
      continue;
    }
    const keys = Object.keys(item);
    if (
      keys.length !== 2
      || !keys.includes("artifactKey")
      || !keys.includes("executionNodeId")
    ) {
      violations.push(itemPath);
      continue;
    }
    const artifactKey = item.artifactKey;
    const executionNodeId = item.executionNodeId;
    if (!isOpaqueCausalWriteIdentifier(artifactKey)) {
      violations.push(`${itemPath}.artifactKey`);
    }
    if (!isOpaqueCausalWriteIdentifier(executionNodeId)) {
      violations.push(`${itemPath}.executionNodeId`);
    }
    if (
      isOpaqueCausalWriteIdentifier(artifactKey)
      && isOpaqueCausalWriteIdentifier(executionNodeId)
    ) {
      const pair = `${artifactKey}:${executionNodeId}`;
      if (pairs.has(pair)) {
        violations.push(itemPath);
      }
      pairs.add(pair);
    }
  }
  return violations;
}

function validateMatchedCausalWriteArtifacts(value: unknown, path: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return [path];
  }
  if (value.length > MAX_CAUSAL_WRITE_ARTIFACTS) {
    return [`${path}.length`];
  }

  const violations: string[] = [];
  const pairs = new Set<string>();
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      violations.push(itemPath);
      continue;
    }
    const keys = Object.keys(item);
    if (
      keys.length !== 3
      || !keys.includes("queryId")
      || !keys.includes("artifactKey")
      || !keys.includes("executionNodeId")
    ) {
      violations.push(itemPath);
      continue;
    }
    const queryId = item.queryId;
    const artifactKey = item.artifactKey;
    const executionNodeId = item.executionNodeId;
    if (!isOpaqueCausalWriteIdentifier(queryId)) {
      violations.push(`${itemPath}.queryId`);
    }
    if (!isOpaqueCausalWriteIdentifier(artifactKey)) {
      violations.push(`${itemPath}.artifactKey`);
    }
    if (!isOpaqueCausalWriteIdentifier(executionNodeId)) {
      violations.push(`${itemPath}.executionNodeId`);
    }
    if (
      isOpaqueCausalWriteIdentifier(queryId)
      && isOpaqueCausalWriteIdentifier(artifactKey)
      && isOpaqueCausalWriteIdentifier(executionNodeId)
    ) {
      const pair = `${queryId}:${artifactKey}:${executionNodeId}`;
      if (pairs.has(pair)) {
        violations.push(itemPath);
      }
      pairs.add(pair);
    }
  }
  return violations;
}

function isOpaqueCausalWriteIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_OPAQUE_CAUSAL_WRITE_IDENTIFIER_LENGTH
    && OPAQUE_CAUSAL_WRITE_IDENTIFIER.test(value);
}

function isAttributionForbiddenKey(key: string): boolean {
  return ATTRIBUTION_FORBIDDEN_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrictPublicationIntent(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).every((key) => PUBLICATION_INTENT_KEYS.has(key))
    && value.schemaVersion === 1
    && isPublicationSlug(value.owner)
    && isPublicationSlug(value.repository)
    && typeof value.commitSha === "string"
    && /^[a-f0-9]{40,64}$/i.test(value.commitSha)
    && isPositiveSafeInteger(value.publicationVersion)
    && (value.state === "active" || value.state === "rewrite_pending" || value.state === "superseded")
    && (value.estimatedNanoUsd == null || isNonNegativeSafeInteger(value.estimatedNanoUsd))
    && (value.coverage === "complete" || value.coverage === "partial" || value.coverage === "unavailable")
    && isNonNegativeSafeInteger(value.attributedQueryCount)
    && (value.commitMessage == null || (typeof value.commitMessage === "string" && value.commitMessage.length <= 1000))
    && isTimestamp(value.firstVerifiedAt)
    && isTimestamp(value.updatedAt);
}

function isStrictWebhookEvent(value: unknown): boolean {
  return isStrictRunStartedWebhookEvent(value)
    || isStrictRunUpdatedWebhookEvent(value)
    || isStrictRunEndedWebhookEvent(value)
    || isStrictCommitAttributedWebhookEvent(value);
}

function isStrictRunStartedWebhookEvent(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).every((key) => RUN_STARTED_WEBHOOK_KEYS.has(key))
    && value.schemaVersion === 1
    && value.eventType === "run.start"
    && isWebhookOpaqueId(value.eventId)
    && isWebhookOpaqueId(value.runId)
    && isWebhookOpaqueId(value.sessionId)
    && isWebhookIdArray(value.traceIds)
    && isWebhookSender(value.sender)
    && isWebhookRepository(value.repository)
    && isWebhookHarness(value.codingHarness)
    && isWebhookRuntime(value.runtime)
    && isTimestamp(value.startedAt)
    && isWebhookEvidence(value.evidence)
    && isWebhookCoverage(value.coverage)
    && isPositiveSafeInteger(value.sequence)
    && isTimestamp(value.updatedAt)
    && value.updatedAt >= value.startedAt
    && value.state === "running"
    && isWebhookStringArray(value.llmModels);
}

function isStrictRunUpdatedWebhookEvent(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).every((key) => RUN_UPDATED_WEBHOOK_KEYS.has(key))
    && value.schemaVersion === 1
    && value.eventType === "run.update"
    && isWebhookOpaqueId(value.eventId)
    && isWebhookOpaqueId(value.runId)
    && isWebhookOpaqueId(value.sessionId)
    && isWebhookIdArray(value.traceIds)
    && isWebhookSender(value.sender)
    && isWebhookRepository(value.repository)
    && isWebhookHarness(value.codingHarness)
    && isWebhookRuntime(value.runtime)
    && isTimestamp(value.startedAt)
    && isWebhookEvidence(value.evidence)
    && isWebhookCoverage(value.coverage)
    && isPositiveSafeInteger(value.sequence)
    && isTimestamp(value.updatedAt)
    && value.updatedAt >= value.startedAt
    && (value.state === "running" || value.state === "settling")
    && isNonNegativeSafeInteger(value.inputTokens)
    && isNonNegativeSafeInteger(value.outputTokens)
    && isNonNegativeSafeInteger(value.cacheReadInputTokens)
    && isNonNegativeSafeInteger(value.cacheCreationInputTokens)
    && isNonNegativeSafeInteger(value.reasoningOutputTokens)
    && isNonNegativeSafeInteger(value.totalTokens)
    && value.totalTokens === value.inputTokens + value.outputTokens
    && isWebhookStringArray(value.llmModels)
    && isNonNegativeSafeInteger(value.estimatedNanoUsd)
    && (value.usageValueNanoUsd == null || isNonNegativeSafeInteger(value.usageValueNanoUsd))
    && (value.costEstimateBasis === "catalog_estimate"
      || value.costEstimateBasis === "provider_reported_estimate"
      || value.costEstimateBasis === "unavailable")
    && (value.costCoverage === "complete" || value.costCoverage === "partial" || value.costCoverage === "unavailable")
    && isRecord(value.coverage)
    && value.coverage.costCoverage === value.costCoverage
    && (value.context == null || isWebhookContextFootprint(value.context))
    && isWebhookActivityArray(value.activity)
    && webhookActivityConservesUsage(value.activity, value);
}

function isStrictRunEndedWebhookEvent(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).every((key) => RUN_ENDED_WEBHOOK_KEYS.has(key))
    && value.schemaVersion === 1
    && value.eventType === "run.ended"
    && isWebhookOpaqueId(value.eventId)
    && isWebhookOpaqueId(value.runId)
    && isWebhookOpaqueId(value.sessionId)
    && isWebhookIdArray(value.traceIds)
    && isWebhookSender(value.sender)
    && isWebhookRepository(value.repository)
    && isWebhookHarness(value.codingHarness)
    && isWebhookRuntime(value.runtime)
    && isTimestamp(value.startedAt)
    && isWebhookEvidence(value.evidence)
    && isWebhookCoverage(value.coverage)
    && (value.version == null || isPositiveSafeInteger(value.version))
    && (value.outcome == null
      || value.outcome === "success"
      || value.outcome === "failure"
      || value.outcome === "unknown")
    && isTimestamp(value.endedAt)
    && value.endedAt >= value.startedAt
    && isNonNegativeSafeInteger(value.inputTokens)
    && isNonNegativeSafeInteger(value.outputTokens)
    && isNonNegativeSafeInteger(value.cacheReadInputTokens)
    && isNonNegativeSafeInteger(value.cacheCreationInputTokens)
    && isNonNegativeSafeInteger(value.reasoningOutputTokens)
    && isNonNegativeSafeInteger(value.totalTokens)
    && value.totalTokens === value.inputTokens + value.outputTokens
    && isWebhookStringArray(value.llmModels)
    && isRepoRelativePathArray(value.filesChanged)
    && isNonNegativeSafeInteger(value.estimatedNanoUsd)
    && (value.usageValueNanoUsd == null || isNonNegativeSafeInteger(value.usageValueNanoUsd))
    && (value.costEstimateBasis === "catalog_estimate"
      || value.costEstimateBasis === "provider_reported_estimate"
      || value.costEstimateBasis === "unavailable")
    && (value.costCoverage === "complete" || value.costCoverage === "partial" || value.costCoverage === "unavailable")
    && isRecord(value.coverage)
    && value.coverage.costCoverage === value.costCoverage
    // An explicit harness completion is safe to publish promptly with clearly
    // provisional usage. A later versioned terminal event still supplies final usage.
    && isPermittedTerminalUsageCoverage(value.coverage.usageCoverage, value.evidence, value.outcome, value)
    && (value.context == null || isWebhookContextFootprint(value.context, webhookUsageCoverage(value.coverage)))
    && (value.activity == null || (
      isWebhookActivityArray(value.activity)
      && webhookActivityConservesUsage(value.activity, value)
    ))
    && value.state === "completed";
}

function isStrictCommitAttributedWebhookEvent(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).every((key) => COMMIT_ATTRIBUTED_WEBHOOK_KEYS.has(key))
    && value.schemaVersion === 1
    && value.eventType === "commit.attributed"
    && isWebhookOpaqueId(value.eventId)
    && isWebhookSender(value.sender)
    && isWebhookRepository(value.repository)
    && typeof value.commitSha === "string"
    && /^[a-f0-9]{7,64}$/i.test(value.commitSha)
    && (value.commitMessage == null || (typeof value.commitMessage === "string" && value.commitMessage.length <= 1000))
    && isWebhookIdArray(value.traceIds)
    && isWebhookIdArray(value.runIds)
    && isNonNegativeSafeInteger(value.estimatedNanoUsd)
    && (value.usageValueNanoUsd == null || isNonNegativeSafeInteger(value.usageValueNanoUsd))
    && (value.costCoverage === "complete" || value.costCoverage === "partial" || value.costCoverage === "unavailable")
    && (value.state === "active" || value.state === "rewrite_pending" || value.state === "superseded")
    && isPositiveSafeInteger(value.version)
    && isTimestamp(value.firstVerifiedAt)
    && isTimestamp(value.updatedAt);
}

function isPublicationSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && /^[A-Za-z0-9_.-]+$/.test(value);
}

function isWebhookOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\r\n\t]/.test(value);
}

function isWebhookHarness(value: unknown): boolean {
  return value === "github-copilot" || value === "claude-code" || value === "codex" || value === "cursor";
}

function isWebhookRuntime(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 && !/[\r\n\t]/.test(value);
}

function isWebhookEvidence(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).every((key) => [
      "basis",
      "sourceId",
      "profileVersion",
      "observedAt",
      "delayed",
      "identityConfidence",
      "timingConfidence"
    ].includes(key))
    && isWebhookEvidenceBasis(value.basis)
    && isWebhookOpaqueId(value.sourceId)
    && isWebhookRuntime(value.profileVersion)
    && isTimestamp(value.observedAt)
    && typeof value.delayed === "boolean"
    && (value.identityConfidence === "high" || value.identityConfidence === "medium")
    && (value.timingConfidence === "high" || value.timingConfidence === "medium");
}

function isWebhookEvidenceBasis(value: unknown): boolean {
  return value === "prompt_hook"
    || value === "session_hook"
    || value === "tool_hook"
    || value === "subagent_hook"
    || value === "stop_hook"
    || value === "root_span"
    || value === "trace_span"
    || value === "otel_event"
    || value === "provider_metric"
    || value === "span_db_replay"
    || value === "usage_projection"
    || value === "inactivity";
}

function isPermittedTerminalUsageCoverage(
  usageCoverage: unknown,
  evidence: unknown,
  outcome: unknown,
  terminal: unknown
): boolean {
  if (usageCoverage === "final") {
    return true;
  }
  if (
    (usageCoverage === "none" || usageCoverage === "partial" || usageCoverage === "complete_so_far")
    && isExplicitTerminalWebhookEvidence(evidence)
  ) {
    return true;
  }
  return usageCoverage === "none"
    && isRunCompletionOutcome(outcome)
    && isDelayedOutcomeTerminalWebhookEvidence(evidence)
    && isZeroUsageTerminal(terminal);
}

function isZeroUsageTerminal(value: unknown): boolean {
  return isRecord(value)
    && value.inputTokens === 0
    && value.outputTokens === 0
    && value.cacheReadInputTokens === 0
    && value.cacheCreationInputTokens === 0
    && value.reasoningOutputTokens === 0
    && value.totalTokens === 0
    && Array.isArray(value.llmModels)
    && value.llmModels.length === 0;
}

function isRunCompletionOutcome(value: unknown): boolean {
  return value === "success" || value === "failure" || value === "unknown";
}

function isExplicitTerminalWebhookEvidence(value: unknown): boolean {
  return isRecord(value)
    && value.delayed === false
    && value.identityConfidence === "high"
    && value.timingConfidence === "high"
    && (value.basis === "stop_hook"
      || value.basis === "session_hook"
      || value.basis === "root_span"
      || value.basis === "otel_event");
}

function isDelayedOutcomeTerminalWebhookEvidence(value: unknown): boolean {
  return isRecord(value)
    && value.delayed === true
    && value.identityConfidence === "high"
    && value.timingConfidence === "high"
    && (value.basis === "stop_hook"
      || value.basis === "session_hook"
      || value.basis === "root_span"
      || value.basis === "otel_event");
}

function isWebhookCoverage(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).every((key) => ["usageCoverage", "activityCoverage", "costCoverage"].includes(key))
    && (value.usageCoverage === "none"
      || value.usageCoverage === "partial"
      || value.usageCoverage === "complete_so_far"
      || value.usageCoverage === "final")
    && (value.activityCoverage === "none"
      || value.activityCoverage === "partial"
      || value.activityCoverage === "complete_for_reported_surface")
    && (value.costCoverage === "complete" || value.costCoverage === "partial" || value.costCoverage === "unavailable");
}

function webhookUsageCoverage(value: unknown): string | undefined {
  return isRecord(value) && typeof value.usageCoverage === "string"
    ? value.usageCoverage
    : undefined;
}

function isWebhookContextFootprint(value: unknown, requiredCoverage?: string): boolean {
  return isRecord(value)
    && Object.keys(value).every((key) => [
      "schemaVersion",
      "accumulatedInputTokens",
      "initialInputContextTokens",
      "latestInputContextTokens",
      "peakInputContextTokens",
      "cacheReadInputTokens",
      "cacheCreationInputTokens",
      "observedLlmRequestCount",
      "contextGrowthInputTokens",
      "contextGrowthRatio",
      "basis",
      "coverage"
    ].includes(key))
    && value.schemaVersion === 1
    && isNonNegativeSafeInteger(value.accumulatedInputTokens)
    && (value.initialInputContextTokens == null || isNonNegativeSafeInteger(value.initialInputContextTokens))
    && (value.latestInputContextTokens == null || isNonNegativeSafeInteger(value.latestInputContextTokens))
    && (value.peakInputContextTokens == null || isNonNegativeSafeInteger(value.peakInputContextTokens))
    && isNonNegativeSafeInteger(value.cacheReadInputTokens)
    && isNonNegativeSafeInteger(value.cacheCreationInputTokens)
    && isNonNegativeSafeInteger(value.observedLlmRequestCount)
    && (value.contextGrowthInputTokens == null || isNonNegativeSafeInteger(value.contextGrowthInputTokens))
    && (value.contextGrowthRatio == null || (typeof value.contextGrowthRatio === "number" && Number.isFinite(value.contextGrowthRatio) && value.contextGrowthRatio >= 0))
    && (value.basis === "provider_reported_input_tokens"
      || value.basis === "derived_from_usage_atoms"
      || value.basis === "derived_from_execution_nodes"
      || value.basis === "unavailable")
    && (value.coverage === "none"
      || value.coverage === "partial"
      || value.coverage === "complete_so_far"
      || value.coverage === "final")
    && (requiredCoverage == null || value.coverage === requiredCoverage);
}

function isWebhookActivityArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isWebhookActivity);
}

function isWebhookActivity(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).every((key) => [
      "activityId",
      "parentActivityId",
      "kind",
      "name",
      "outcome",
      "count",
      "failureCount",
      "rejectedCount",
      "unknownCount",
      "startedAt",
      "endedAt",
      "durationMs",
      "resultSizeBytes",
      "providerReportedResultTokens",
      "inputTokens",
      "outputTokens",
      "cacheReadInputTokens",
      "cacheCreationInputTokens",
      "reasoningOutputTokens",
      "totalTokens",
      "usageAttributionBasis",
      "usageCoverage",
      "evidence"
    ].includes(key))
    && isWebhookOpaqueId(value.activityId)
    && (value.parentActivityId == null || isWebhookOpaqueId(value.parentActivityId))
    && isWebhookActivityKind(value.kind)
    && isWebhookRuntime(value.name)
    && (value.outcome === "success" || value.outcome === "failure" || value.outcome === "rejected" || value.outcome === "unknown")
    && (value.count == null || isPositiveSafeInteger(value.count))
    && (value.failureCount == null || (
      isNonNegativeSafeInteger(value.failureCount)
      && isPositiveSafeInteger(value.count)
      && value.failureCount <= value.count
    ))
    && (value.rejectedCount == null || (
      isNonNegativeSafeInteger(value.rejectedCount)
      && isPositiveSafeInteger(value.count)
      && value.rejectedCount <= Number(value.failureCount ?? 0)
    ))
    && (value.unknownCount == null || (
      isNonNegativeSafeInteger(value.unknownCount)
      && isPositiveSafeInteger(value.count)
      && value.unknownCount <= value.count
      && Number(value.failureCount ?? 0) + value.unknownCount <= value.count
    ))
    && isTimestamp(value.startedAt)
    && (value.endedAt == null || (isTimestamp(value.endedAt) && value.endedAt >= value.startedAt))
    && (value.durationMs == null || isNonNegativeSafeInteger(value.durationMs))
    && (value.resultSizeBytes == null || isNonNegativeSafeInteger(value.resultSizeBytes))
    && (value.providerReportedResultTokens == null || isNonNegativeSafeInteger(value.providerReportedResultTokens))
    && (value.inputTokens == null || isNonNegativeSafeInteger(value.inputTokens))
    && (value.outputTokens == null || isNonNegativeSafeInteger(value.outputTokens))
    && (value.cacheReadInputTokens == null || isNonNegativeSafeInteger(value.cacheReadInputTokens))
    && (value.cacheCreationInputTokens == null || isNonNegativeSafeInteger(value.cacheCreationInputTokens))
    && (value.reasoningOutputTokens == null || isNonNegativeSafeInteger(value.reasoningOutputTokens))
    && (value.totalTokens == null || isNonNegativeSafeInteger(value.totalTokens))
    && (value.totalTokens == null
      || (value.inputTokens == null && value.outputTokens == null)
      || value.totalTokens === (value.inputTokens ?? 0) + (value.outputTokens ?? 0))
    && (value.usageAttributionBasis == null
      || value.usageAttributionBasis === "provider_reported"
      || value.usageAttributionBasis === "trace_descendant"
      || value.usageAttributionBasis === "activity_only"
      || value.usageAttributionBasis === "unavailable")
    && (value.usageCoverage == null
      || value.usageCoverage === "complete"
      || value.usageCoverage === "partial"
      || value.usageCoverage === "unavailable")
    && isWebhookEvidence(value.evidence);
}

function webhookActivityConservesUsage(
  activity: unknown,
  run: Record<string, unknown>
): boolean {
  if (!Array.isArray(activity)) {
    return false;
  }
  return [
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "reasoningOutputTokens",
    "totalTokens"
  ].every((field) => activity.reduce<number>((sum, item) => {
    const value = isRecord(item) ? item[field] : undefined;
    return sum + (isNonNegativeSafeInteger(value) ? value : 0);
  }, 0) === run[field]);
}

function isWebhookActivityKind(value: unknown): boolean {
  return value === "llm_request"
    || value === "tool"
    || value === "subagent"
    || value === "skill"
    || value === "mcp"
    || value === "hook"
    || value === "unknown";
}

function isWebhookStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length <= 200 && !/[\r\n\t]/.test(item));
}

function isWebhookIdArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => isWebhookOpaqueId(item));
}

function isWebhookSender(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).every((key) => ["installationId", "name", "team", "imageUrl"].includes(key))
    && isWebhookOpaqueId(value.installationId)
    && (value.name == null || isWebhookSenderText(value.name))
    && (value.team == null || isWebhookSenderText(value.team))
    && (value.imageUrl == null || isWebhookImageUrl(value.imageUrl));
}

function isWebhookSenderText(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= 200
    && !/[\r\n\t]/.test(value);
}

function isWebhookImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_000 || /[\r\n\t]/.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function isWebhookRepository(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).every((key) => ["repoKey", "owner", "name", "fullName"].includes(key))
    && isWebhookOpaqueId(value.repoKey)
    && isRepositoryNamePart(value.owner)
    && isRepositoryNamePart(value.name)
    && isRepositoryFullName(value.fullName);
}

function isRepositoryNamePart(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= 200
    && /^[A-Za-z0-9_. -]+$/.test(value);
}

function isRepositoryFullName(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= 401
    && /^[A-Za-z0-9_. /-]+$/.test(value)
    && value.includes("/");
}

function isRepoRelativePathArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => isRepoRelativePath(item));
}

function isRepoRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 1000 || /[\r\n\t]/.test(value)) {
    return false;
  }
  const normalized = value.replace(/\\/g, "/");
  if (
    normalized.startsWith("/")
    || normalized.startsWith("../")
    || normalized.includes("/../")
    || normalized === ".."
    || /^[A-Za-z]:[\\/]/.test(value)
    || path.isAbsolute(value)
  ) {
    return false;
  }
  return normalized.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
