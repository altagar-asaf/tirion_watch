import {
  CanonicalEventRecord,
  CanonicalMetricRecord,
  CanonicalOtelRecord,
  CanonicalSpanRecord,
  TelemetryNormalizer
} from "../types";
import { firstString, hrTimeToUnixNano, isRecord, otelAttributesToRecord, toNumber, unwrapOtelValue } from "./otelValues";

export class DefaultTelemetryNormalizer implements TelemetryNormalizer {
  normalize(raw: unknown): CanonicalOtelRecord | null {
    return this.normalizeMany(raw)[0] ?? null;
  }

  normalizeMany(raw: unknown): CanonicalOtelRecord[] {
    if (Array.isArray(raw)) {
      return raw.flatMap((item) => this.normalizeMany(item));
    }

    if (!isRecord(raw)) {
      return [];
    }

    if (isCanonical(raw)) {
      return [raw];
    }

    const spanDbRecords = this.normalizeCopilotSpanDbRecord(raw);
    if (spanDbRecords.length > 0) {
      return spanDbRecords;
    }

    const records: CanonicalOtelRecord[] = [];
    records.push(...this.normalizeResourceSpans(raw.resourceSpans));
    records.push(...this.normalizeResourceMetrics(raw.resourceMetrics));
    records.push(...this.normalizeResourceLogs(raw.resourceLogs ?? raw.resourceEvents));
    records.push(...this.normalizeSdkScopeMetrics(raw));

    if (records.length > 0) {
      return records;
    }

    const directSpan = this.normalizeSpan(raw, {});
    if (directSpan) {
      return [directSpan];
    }

    const directMetric = this.normalizeDirectMetric(raw, {});
    if (directMetric.length > 0) {
      return directMetric;
    }

    const directEvent = this.normalizeEvent(raw, otelAttributesToRecord(readPath(raw, ["resource", "attributes"])));
    return directEvent ? [directEvent] : [];
  }

  private normalizeResourceSpans(resourceSpans: unknown): CanonicalSpanRecord[] {
    if (!Array.isArray(resourceSpans)) {
      return [];
    }

    const records: CanonicalSpanRecord[] = [];
    for (const resourceSpan of resourceSpans) {
      if (!isRecord(resourceSpan)) continue;
      const resourceAttributes = otelAttributesToRecord(readPath(resourceSpan, ["resource", "attributes"]));
      const scopeSpans = readArray(resourceSpan.scopeSpans ?? resourceSpan.instrumentationLibrarySpans);

      for (const scopeSpan of scopeSpans) {
        if (!isRecord(scopeSpan)) continue;
        for (const span of readArray(scopeSpan.spans)) {
          const normalized = this.normalizeSpan(span, resourceAttributes);
          if (normalized) {
            records.push(normalized);
          }
        }
      }
    }
    return records;
  }

  private normalizeResourceMetrics(resourceMetrics: unknown): CanonicalMetricRecord[] {
    if (!Array.isArray(resourceMetrics)) {
      return [];
    }

    const records: CanonicalMetricRecord[] = [];
    for (const resourceMetric of resourceMetrics) {
      if (!isRecord(resourceMetric)) continue;
      const resourceAttributes = otelAttributesToRecord(readPath(resourceMetric, ["resource", "attributes"]));
      const scopeMetrics = readArray(resourceMetric.scopeMetrics ?? resourceMetric.instrumentationLibraryMetrics);

      for (const scopeMetric of scopeMetrics) {
        if (!isRecord(scopeMetric)) continue;
        for (const metric of readArray(scopeMetric.metrics)) {
          records.push(...this.normalizeDirectMetric(metric, resourceAttributes));
        }
      }
    }
    return records;
  }

  private normalizeResourceLogs(resourceLogs: unknown): CanonicalEventRecord[] {
    if (!Array.isArray(resourceLogs)) {
      return [];
    }

    const records: CanonicalEventRecord[] = [];
    for (const resourceLog of resourceLogs) {
      if (!isRecord(resourceLog)) continue;
      const resourceAttributes = otelAttributesToRecord(readPath(resourceLog, ["resource", "attributes"]));
      const scopeLogs = readArray(resourceLog.scopeLogs ?? resourceLog.instrumentationLibraryLogs);

      for (const scopeLog of scopeLogs) {
        if (!isRecord(scopeLog)) continue;
        for (const logRecord of readArray(scopeLog.logRecords ?? scopeLog.events)) {
          const normalized = this.normalizeEvent(logRecord, resourceAttributes);
          if (normalized) {
            records.push(normalized);
          }
        }
      }
    }
    return records;
  }

  private normalizeSpan(rawSpan: unknown, resourceAttributes: Record<string, unknown>): CanonicalSpanRecord | null {
    if (!isRecord(rawSpan)) {
      return null;
    }

    const traceId = firstString(rawSpan.traceId, readPath(rawSpan, ["spanContext", "traceId"]));
    const spanId = firstString(rawSpan.spanId, readPath(rawSpan, ["spanContext", "spanId"]));
    const name = firstString(rawSpan.name, rawSpan.spanName);

    if (!traceId || !spanId || !name) {
      return null;
    }

    return {
      kind: "span",
      traceId,
      spanId,
      parentSpanId: firstString(rawSpan.parentSpanId, readPath(rawSpan, ["parentSpanContext", "spanId"])),
      name,
      startTimeUnixNano: firstString(rawSpan.startTimeUnixNano, rawSpan.startTime, rawSpan.start_time_unix_nano),
      endTimeUnixNano: firstString(rawSpan.endTimeUnixNano, rawSpan.endTime, rawSpan.end_time_unix_nano),
      attributes: otelAttributesToRecord(rawSpan.attributes),
      resourceAttributes,
      status: normalizeStatus(rawSpan.status)
    };
  }

  private normalizeCopilotSpanDbRecord(raw: Record<string, unknown>): CanonicalOtelRecord[] {
    if (raw.tirionSource !== "copilot-span-db" || !isRecord(raw.span)) {
      return [];
    }

    const span = raw.span;
    const traceId = firstString(span.trace_id, span.traceId);
    const spanId = firstString(span.span_id, span.spanId);
    const name = firstString(span.name);
    if (!traceId || !spanId || !name) {
      return [];
    }

    const attributes = {
      ...spanColumnAttributes(span),
      ...spanDbAttributes(raw.attributes)
    };
    const resourceAttributes: Record<string, unknown> = {
      "service.name": "github-copilot"
    };
    const canonicalSpan: CanonicalSpanRecord = {
      kind: "span",
      traceId,
      spanId,
      parentSpanId: firstString(span.parent_span_id, span.parentSpanId),
      name,
      startTimeUnixNano: msToUnixNano(span.start_time_ms ?? span.startTimeMs),
      endTimeUnixNano: msToUnixNano(span.end_time_ms ?? span.endTimeMs),
      attributes,
      resourceAttributes,
      status: statusFromDb(span.status_code, span.status_message)
    };

    const events = readArray(raw.events).flatMap((event): CanonicalEventRecord[] => {
      if (!isRecord(event)) {
        return [];
      }
      const eventName = firstString(event.name);
      if (!eventName) {
        return [];
      }
      return [{
        kind: "event",
        traceId,
        spanId,
        name: eventName,
        timeUnixNano: msToUnixNano(event.timestamp_ms ?? event.timestampMs),
        attributes: parseJsonObject(event.attributes),
        resourceAttributes
      }];
    });

    return [canonicalSpan, ...events];
  }

  private normalizeEvent(rawEvent: unknown, resourceAttributes: Record<string, unknown>): CanonicalEventRecord | null {
    if (!isRecord(rawEvent)) {
      return null;
    }

    const attributes = otelAttributesToRecord(rawEvent.attributes);
    const body = unwrapOtelValue(rawEvent.body ?? rawEvent._body);
    const bodyName = typeof body === "string" ? body : undefined;
    const name = firstString(rawEvent.name, attributes["event.name"], bodyName);

    if (!name) {
      return null;
    }

    return {
      kind: "event",
      traceId: firstString(rawEvent.traceId, attributes.traceId, readPath(rawEvent, ["spanContext", "traceId"])),
      spanId: firstString(rawEvent.spanId, attributes.spanId, readPath(rawEvent, ["spanContext", "spanId"])),
      name,
      timeUnixNano: firstString(rawEvent.timeUnixNano, rawEvent.observedTimeUnixNano, rawEvent.time, hrTimeToUnixNano(rawEvent.hrTime)),
      attributes,
      resourceAttributes
    };
  }

  private normalizeSdkScopeMetrics(raw: Record<string, unknown>): CanonicalMetricRecord[] {
    const scopeMetrics = readArray(raw.scopeMetrics);
    if (scopeMetrics.length === 0) {
      return [];
    }

    const resourceAttributes = otelAttributesToRecord(readPath(raw, ["resource", "attributes"]));
    const records: CanonicalMetricRecord[] = [];
    for (const scopeMetric of scopeMetrics) {
      if (!isRecord(scopeMetric)) continue;
      for (const metric of readArray(scopeMetric.metrics)) {
        records.push(...this.normalizeDirectMetric(metric, resourceAttributes));
      }
    }
    return records;
  }

  private normalizeDirectMetric(rawMetric: unknown, resourceAttributes: Record<string, unknown>): CanonicalMetricRecord[] {
    if (!isRecord(rawMetric)) {
      return [];
    }

    const name = firstString(rawMetric.name, readPath(rawMetric, ["descriptor", "name"]));
    if (!name) {
      return [];
    }

    const dataPoints = collectDataPoints(rawMetric);
    if (dataPoints.length === 0) {
      return [
        {
          kind: "metric",
          name,
          traceId: firstString(rawMetric.traceId),
          spanId: firstString(rawMetric.spanId),
          timeUnixNano: firstString(rawMetric.timeUnixNano, rawMetric.time),
          value: toNumber(rawMetric.value),
          attributes: otelAttributesToRecord(rawMetric.attributes),
          resourceAttributes
        }
      ];
    }

    return dataPoints.map((point) => {
      const attributes = otelAttributesToRecord(point.attributes);
      return {
        kind: "metric",
        name,
        traceId: firstString(point.traceId, attributes.traceId),
        spanId: firstString(point.spanId, attributes.spanId),
        timeUnixNano: firstString(point.timeUnixNano, point.startTimeUnixNano, hrTimeToUnixNano(point.endTime), hrTimeToUnixNano(point.startTime)),
        value: readMetricValue(point),
        attributes,
        resourceAttributes
      };
    });
  }
}

function isCanonical(value: Record<string, unknown>): value is CanonicalOtelRecord {
  return value.kind === "span" || value.kind === "metric" || value.kind === "event";
}

function collectDataPoints(rawMetric: Record<string, unknown>): Record<string, unknown>[] {
  const containers = [rawMetric.sum, rawMetric.gauge, rawMetric.histogram, rawMetric.exponentialHistogram, rawMetric.summary];
  const points: Record<string, unknown>[] = [];

  for (const point of readArray(rawMetric.dataPoints)) {
    if (isRecord(point)) {
      points.push(point);
    }
  }

  for (const container of containers) {
    if (!isRecord(container)) continue;
    for (const point of readArray(container.dataPoints)) {
      if (isRecord(point)) {
        points.push(point);
      }
    }
  }

  return points;
}

function readMetricValue(point: Record<string, unknown>): number | undefined {
  return (
    toNumber(point.asDouble) ??
    toNumber(point.asInt) ??
    toNumber(point.value) ??
    (isRecord(point.value) ? toNumber(point.value.sum) : undefined) ??
    toNumber(point.sum) ??
    toNumber(point.count)
  );
}

function normalizeStatus(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return firstString(value);
  }
  return firstString(value.code, value.message);
}

function statusFromDb(code: unknown, message: unknown): string | undefined {
  const numericCode = toNumber(code);
  if (numericCode === 2) {
    return "STATUS_CODE_ERROR";
  }
  if (numericCode === 1) {
    return "STATUS_CODE_OK";
  }
  return firstString(message);
}

function spanColumnAttributes(span: Record<string, unknown>): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  addAttribute(attributes, "gen_ai.operation.name", span.operation_name);
  addAttribute(attributes, "gen_ai.provider.name", span.provider_name);
  addAttribute(attributes, "gen_ai.agent.name", span.agent_name);
  addAttribute(attributes, "gen_ai.conversation.id", span.conversation_id);
  addAttribute(attributes, "copilot_chat.session_id", span.conversation_id);
  addAttribute(attributes, "gen_ai.request.model", span.request_model);
  addAttribute(attributes, "gen_ai.response.model", span.response_model);
  addAttribute(attributes, "gen_ai.usage.input_tokens", span.input_tokens);
  addAttribute(attributes, "gen_ai.usage.output_tokens", span.output_tokens);
  addAttribute(attributes, "gen_ai.usage.cache_read.input_tokens", span.cached_tokens);
  addAttribute(attributes, "gen_ai.usage.reasoning.output_tokens", span.reasoning_tokens);
  addAttribute(attributes, "gen_ai.tool.name", span.tool_name);
  addAttribute(attributes, "gen_ai.tool.call.id", span.tool_call_id);
  addAttribute(attributes, "gen_ai.tool.type", span.tool_type);
  addAttribute(attributes, "copilot_chat.chat_session_id", span.chat_session_id);
  addAttribute(attributes, "turn.index", span.turn_index);
  addAttribute(attributes, "copilot_chat.time_to_first_token", span.ttft_ms);
  return attributes;
}

function spanDbAttributes(value: unknown): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const row of readArray(value)) {
    if (!isRecord(row)) {
      continue;
    }
    const key = firstString(row.key);
    if (!key) {
      continue;
    }
    attributes[key] = parseSpanDbValue(row.value);
  }
  return attributes;
}

function addAttribute(attributes: Record<string, unknown>, key: string, value: unknown): void {
  if (value == null || value === "") {
    return;
  }
  attributes[key] = parseSpanDbValue(value);
}

function parseSpanDbValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    return "";
  }

  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
    return numeric;
  }

  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }

  return value;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed = parseSpanDbValue(value);
  return isRecord(parsed) ? parsed : {};
}

function msToUnixNano(value: unknown): string | undefined {
  const ms = toNumber(value);
  if (ms == null) {
    return undefined;
  }
  return String(Math.round(ms * 1_000_000));
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readPath(value: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}
