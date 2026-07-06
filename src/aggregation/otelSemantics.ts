import { CanonicalOtelRecord, CanonicalEventRecord, CanonicalSpanRecord, inferProviderFromModel, normalizeProvider } from "../types";
import { toNumber } from "../normalization/otelValues";

export function isInvokeAgentName(name: string): boolean {
  return normalizeName(name).startsWith("invoke_agent");
}

export function isChatName(name: string): boolean {
  return normalizeName(name).startsWith("chat");
}

export function isExecuteToolName(name: string): boolean {
  return normalizeName(name).startsWith("execute_tool");
}

export function isUserMessageEvent(record: CanonicalOtelRecord): record is CanonicalEventRecord {
  return record.kind === "event" && record.name === "user_message";
}

export function isTerminalSpan(span: CanonicalSpanRecord): boolean {
  if (span.endTimeUnixNano) {
    return true;
  }
  return span.status === "STATUS_CODE_ERROR" || span.status === "ERROR";
}

export function recordTimestamp(record: CanonicalOtelRecord): string | undefined {
  if (record.kind === "span") {
    return record.startTimeUnixNano ?? record.endTimeUnixNano;
  }
  return record.timeUnixNano;
}

export function extractModel(record: CanonicalOtelRecord): string | undefined {
  const attributes = record.attributes;
  const candidates = [
    attributes["gen_ai.request.model"],
    attributes["gen_ai.response.model"],
    attributes["gen_ai.system"],
    attributes["llm.model_name"],
    attributes["model"],
    attributes["model.name"],
    attributes["copilot.model"]
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }

  return undefined;
}

export function extractProvider(record: CanonicalOtelRecord): string | undefined {
  const modelProvider = inferProviderFromModel(extractModel(record));
  const candidates = [
    firstStringAttribute(record, ["gen_ai.provider.name"]),
    firstStringAttribute(record, ["provider_name"]),
    firstStringAttribute(record, ["provider.name"]),
    firstStringAttribute(record, ["llm.provider"]),
    firstStringAttribute(record, ["gen_ai.system"])
  ];

  for (const value of candidates) {
    if (typeof value !== "string") {
      continue;
    }

    const normalized = normalizeProvider(value);
    if (normalized && isKnownProvider(normalized)) {
      if (normalized === "github" && modelProvider && modelProvider !== "github") {
        return modelProvider;
      }
      return normalized;
    }
  }

  return modelProvider;
}

export function extractConversationId(record: CanonicalOtelRecord): string | undefined {
  return firstStringAttribute(record, [
    "gen_ai.conversation.id",
    "github.copilot.conversation.id",
    "copilot_chat.conversation.id",
    "conversation.id",
    "session.id"
  ]);
}

export function extractTurnId(record: CanonicalOtelRecord): string | undefined {
  return firstStringAttribute(record, [
    "gen_ai.turn.id",
    "github.copilot.turn.id",
    "copilot_chat.turn.id",
    "turn.id",
    "turn.index",
    "request.id",
    "gen_ai.message.id"
  ]);
}

export function extractInitialQueryText(record: CanonicalOtelRecord): string | undefined {
  return firstStringAttribute(record, ["tirion.initial_user_query"]);
}

export function extractCopilotSessionId(record: CanonicalOtelRecord): string | undefined {
  return firstStringAttribute(record, [
    "copilot_chat.session_id",
    "gen_ai.conversation.id",
    "session.id"
  ]);
}

export function extractCopilotChatSessionId(record: CanonicalOtelRecord): string | undefined {
  return firstStringAttribute(record, ["copilot_chat.chat_session_id"]);
}

export function isSpawnedHelperTraceRoot(record: CanonicalOtelRecord): boolean {
  const sessionId = extractCopilotSessionId(record);
  const chatSessionId = extractCopilotChatSessionId(record);
  return sessionId != null && chatSessionId != null && sessionId !== chatSessionId;
}

export function extractSessionId(record: CanonicalOtelRecord): string | undefined {
  return firstStringAttribute(record, ["session.id"]);
}

export function extractServiceName(record: CanonicalOtelRecord): string | undefined {
  const value = record.resourceAttributes["service.name"] ?? record.attributes["service.name"];
  return typeof value === "string" ? value : undefined;
}

export function extractToolName(span: CanonicalSpanRecord): string {
  const attributes = span.attributes;
  const candidates = [
    attributes["gen_ai.tool.name"],
    attributes["tool.name"],
    attributes["copilot.tool.name"],
    attributes["name"]
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return span.name.replace(/^execute_tool\s*/i, "").trim() || "unknown";
}

export function extractToolCallId(record: CanonicalOtelRecord): string | undefined {
  return firstStringAttribute(record, [
    "gen_ai.tool.call.id",
    "tool.call.id",
    "github.copilot.tool.call.id",
    "copilot.tool.call.id"
  ]);
}

export function extractSpanDurationMs(span: CanonicalSpanRecord): number | undefined {
  const start = toNumber(span.startTimeUnixNano);
  const end = toNumber(span.endTimeUnixNano);
  if (start == null || end == null || end < start) {
    return undefined;
  }
  return Math.round((end - start) / 1_000_000);
}

export function extractStatus(span?: CanonicalSpanRecord): "completed" | "error" | "unknown" {
  if (!span) {
    return "unknown";
  }
  if (span.status === "STATUS_CODE_ERROR" || span.status === "ERROR") {
    return "error";
  }
  if (span.endTimeUnixNano) {
    return "completed";
  }
  return "unknown";
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "_");
}

function firstStringAttribute(record: CanonicalOtelRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const attributeValue = record.attributes[key];
    if (typeof attributeValue === "string" && attributeValue.trim() !== "") {
      return attributeValue;
    }
    if (typeof attributeValue === "number" && Number.isFinite(attributeValue)) {
      return String(attributeValue);
    }
    const resourceValue = record.resourceAttributes[key];
    if (typeof resourceValue === "string" && resourceValue.trim() !== "") {
      return resourceValue;
    }
    if (typeof resourceValue === "number" && Number.isFinite(resourceValue)) {
      return String(resourceValue);
    }
  }
  return undefined;
}

function isKnownProvider(provider: string): boolean {
  return ["openai", "anthropic", "google", "microsoft", "github"].includes(provider);
}
