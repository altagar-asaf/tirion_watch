#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const PROFILE_VERSION = "tirion-provider-native-skill-v1";

function otlpValue(value) {
  if (!value || typeof value !== "object") return value;
  if ("stringValue" in value) return value.stringValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("boolValue" in value) return Boolean(value.boolValue);
  if ("bytesValue" in value) return value.bytesValue;
  if ("arrayValue" in value) return value.arrayValue.values?.map(otlpValue) ?? [];
  if ("kvlistValue" in value) {
    return Object.fromEntries((value.kvlistValue.values ?? []).map((item) => [item.key, otlpValue(item.value)]));
  }
  return value;
}

function attrs(items = []) {
  return Object.fromEntries(items.map((item) => [item.key, otlpValue(item.value)]));
}

function readOtlpBodies(inputDir) {
  const dir = resolve(inputDir);
  const bodies = [];
  for (const file of readdirSync(dir).sort()) {
    const path = join(dir, file);
    if (!statSync(path).isFile() || !file.endsWith(".body")) continue;
    const text = readFileSync(path, "utf8").trim();
    if (!text.startsWith("{")) continue;
    bodies.push({ file, json: JSON.parse(text) });
  }
  return bodies;
}

function nanosToIso(nanos) {
  if (nanos == null || nanos === "") return null;
  const value = typeof nanos === "bigint" ? nanos : BigInt(String(nanos));
  return new Date(Number(value / 1000000n)).toISOString();
}

function subtractMs(iso, ms) {
  if (!iso || !Number.isFinite(ms)) return iso;
  return new Date(new Date(iso).getTime() - ms).toISOString();
}

function parseJsonMaybe(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function boolish(value) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return null;
}

function stableId(parts) {
  const hash = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `act_${hash.slice(0, 64)}`;
}

function providerForResource(resource) {
  const serviceName = String(resource?.["service.name"] ?? "");
  if (/claude/i.test(serviceName)) return "claude-code";
  if (/codex/i.test(serviceName)) return "codex";
  return "unknown";
}

function collectLogs(bodies) {
  const records = [];
  for (const body of bodies) {
    let ordinal = 0;
    for (const resourceLog of body.json?.resourceLogs ?? []) {
      const resource = attrs(resourceLog.resource?.attributes);
      for (const scopeLog of resourceLog.scopeLogs ?? []) {
        const scope = scopeLog.scope?.name ?? "";
        for (const record of scopeLog.logRecords ?? []) {
          const attributes = attrs(record.attributes);
          const time = nanosToIso(record.timeUnixNano);
          const observedAt = nanosToIso(record.observedTimeUnixNano) ?? time;
          records.push({
            sourceId: `log:${body.file}:${ordinal}`,
            file: body.file,
            provider: providerForResource(resource),
            scope,
            resource,
            name: attributes["event.name"] ?? attributes.name ?? "",
            body: otlpValue(record.body),
            attributes,
            time,
            observedAt,
          });
          ordinal += 1;
        }
      }
    }
  }
  return records;
}

function collectSpans(bodies) {
  const spans = [];
  for (const body of bodies) {
    let ordinal = 0;
    for (const resourceSpan of body.json?.resourceSpans ?? []) {
      const resource = attrs(resourceSpan.resource?.attributes);
      for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
        const scope = scopeSpan.scope?.name ?? "";
        for (const span of scopeSpan.spans ?? []) {
          const attributes = attrs(span.attributes);
          spans.push({
            sourceId: `span:${body.file}:${ordinal}`,
            file: body.file,
            provider: providerForResource(resource),
            scope,
            resource,
            name: span.name ?? "",
            attributes,
            startedAt: nanosToIso(span.startTimeUnixNano),
            endedAt: nanosToIso(span.endTimeUnixNano),
            observedAt: nanosToIso(span.endTimeUnixNano),
            statusCode: span.status?.code,
          });
          ordinal += 1;
        }
      }
    }
  }
  return spans;
}

function metricPoints(metric) {
  const containers = [metric.sum, metric.gauge, metric.histogram, metric.exponentialHistogram, metric.summary].filter(Boolean);
  return containers.flatMap((container) => container.dataPoints ?? []);
}

function pointValue(point) {
  if ("asInt" in point) return Number(point.asInt);
  if ("asDouble" in point) return Number(point.asDouble);
  if ("count" in point || "sum" in point) {
    return {
      count: point.count == null ? undefined : Number(point.count),
      sum: point.sum == null ? undefined : Number(point.sum),
    };
  }
  return undefined;
}

function collectMetrics(bodies) {
  const metrics = [];
  for (const body of bodies) {
    let ordinal = 0;
    for (const resourceMetric of body.json?.resourceMetrics ?? []) {
      const resource = attrs(resourceMetric.resource?.attributes);
      for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
        const scope = scopeMetric.scope?.name ?? "";
        for (const metric of scopeMetric.metrics ?? []) {
          for (const point of metricPoints(metric)) {
            const attributes = attrs(point.attributes);
            const time = nanosToIso(point.timeUnixNano);
            metrics.push({
              sourceId: `metric:${body.file}:${ordinal}`,
              file: body.file,
              provider: providerForResource(resource),
              scope,
              resource,
              name: metric.name ?? "",
              description: metric.description ?? "",
              unit: metric.unit ?? "",
              attributes,
              value: pointValue(point),
              startTime: nanosToIso(point.startTimeUnixNano),
              time,
              observedAt: time,
            });
            ordinal += 1;
          }
        }
      }
    }
  }
  return metrics;
}

function outcomeFromStatus(status) {
  const normalized = String(status ?? "").toLowerCase();
  if (["ok", "success", "succeeded", "true"].includes(normalized)) return "success";
  if (["error", "failure", "failed", "false"].includes(normalized)) return "failure";
  return "unknown";
}

function makeActivity({ provider, kind, name, outcome, startedAt, endedAt, durationMs, evidence }) {
  const activity = {
    activityId: stableId({ provider, kind, name, startedAt, endedAt, sourceId: evidence.sourceId }),
    provider,
    kind,
    name,
    outcome,
    startedAt,
    evidence: {
      profileVersion: PROFILE_VERSION,
      delayed: false,
      ...evidence,
    },
  };
  if (endedAt) activity.endedAt = endedAt;
  if (durationMs != null) activity.durationMs = durationMs;
  return activity;
}

function extractClaudeSkillActivities(logs, spans) {
  const activities = [];

  for (const record of logs.filter((item) => item.provider === "claude-code")) {
    const eventName = String(record.name || record.body || "");

    if (/skill_activated/i.test(eventName)) {
      const skillName = record.attributes["skill.name"] ?? record.attributes.skill_name;
      if (!skillName) continue;
      const identityConfidence = skillName === "custom_skill" ? "low" : "high";
      activities.push(makeActivity({
        provider: "claude-code",
        kind: "skill",
        name: String(skillName),
        outcome: "success",
        startedAt: record.time ?? record.observedAt,
        endedAt: record.time ?? record.observedAt,
        durationMs: 0,
        evidence: {
          basis: "otel_log",
          signal: "claude_code.skill_activated",
          sourceId: record.sourceId,
          observedAt: record.observedAt,
          identityConfidence,
          timingConfidence: "medium",
          invocationTrigger: record.attributes.invocation_trigger,
          skillSource: record.attributes["skill.source"],
        },
      }));
      continue;
    }

    if (!/tool_result/i.test(eventName) && record.body !== "claude_code.tool_result") continue;
    if (record.attributes.tool_name !== "Skill") continue;

    const params = parseJsonMaybe(record.attributes.tool_parameters);
    const skillName = params?.skill_name ?? record.attributes.skill_name ?? record.attributes["skill.name"];
    if (!skillName) continue;

    const success = boolish(record.attributes.success);
    const endedAt = record.time ?? record.observedAt;
    const durationMs = Number(record.attributes.duration_ms);
    activities.push(makeActivity({
      provider: "claude-code",
      kind: "skill",
      name: String(skillName),
      outcome: success === false ? "failure" : "success",
      startedAt: subtractMs(endedAt, durationMs),
      endedAt,
      durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
      evidence: {
        basis: "otel_log",
        signal: "claude_code.tool_result",
        sourceId: record.sourceId,
        observedAt: record.observedAt,
        identityConfidence: "high",
        timingConfidence: Number.isFinite(durationMs) ? "high" : "medium",
        toolUseId: record.attributes.tool_use_id,
      },
    }));
  }

  for (const span of spans.filter((item) => item.provider === "claude-code")) {
    if (span.name !== "claude_code.tool") continue;
    if (span.attributes.tool_name !== "Skill") continue;
    const skillName = span.attributes.skill_name ?? span.attributes["skill.name"];
    if (!skillName) continue;

    const durationMs = Number(span.attributes.duration_ms);
    activities.push(makeActivity({
      provider: "claude-code",
      kind: "skill",
      name: String(skillName),
      outcome: span.statusCode === 2 ? "failure" : "success",
      startedAt: span.startedAt,
      endedAt: span.endedAt,
      durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
      evidence: {
        basis: "otel_span",
        signal: "claude_code.tool",
        sourceId: span.sourceId,
        observedAt: span.observedAt,
        identityConfidence: "high",
        timingConfidence: span.startedAt && span.endedAt ? "high" : "medium",
        toolUseId: span.attributes.tool_use_id ?? span.attributes["gen_ai.tool.call.id"],
      },
    }));
  }

  return activities;
}

function extractCodexSkillActivities(metrics) {
  const activities = [];

  for (const metric of metrics.filter((item) => item.provider === "codex")) {
    if (!/(^|\.|_)skill(\.|_)injected$/i.test(metric.name)) continue;
    const skillName = metric.attributes.skill;
    if (!skillName) continue;
    const observedAt = metric.time ?? metric.startTime ?? new Date().toISOString();
    activities.push(makeActivity({
      provider: "codex",
      kind: "skill",
      name: String(skillName),
      outcome: outcomeFromStatus(metric.attributes.status),
      startedAt: observedAt,
      evidence: {
        basis: "otel_metric",
        signal: metric.name,
        sourceId: metric.sourceId,
        observedAt,
        identityConfidence: "high",
        timingConfidence: "low",
        metricStatus: metric.attributes.status,
        note: "Codex emits skill injection as a point metric, not a duration span.",
      },
    }));
  }

  return activities;
}

export function extractSkillActivitiesFromOtlpDir(inputDir) {
  const bodies = readOtlpBodies(inputDir);
  const logs = collectLogs(bodies);
  const spans = collectSpans(bodies);
  const metrics = collectMetrics(bodies);
  const activity = dedupeActivities([
    ...extractClaudeSkillActivities(logs, spans),
    ...extractCodexSkillActivities(metrics),
  ]).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));

  return {
    inputDir: resolve(inputDir),
    profileVersion: PROFILE_VERSION,
    activity,
    diagnostics: {
      filesRead: bodies.length,
      logRecords: logs.length,
      spans: spans.length,
      metricPoints: metrics.length,
    },
  };
}

function dedupeActivities(activities) {
  const score = (activity) => {
    let value = 0;
    if (activity.evidence.signal === "claude_code.tool_result") value += 5;
    if (activity.evidence.signal === "claude_code.skill_activated") value += 4;
    if (activity.evidence.signal === "claude_code.tool") value += 3;
    if (activity.endedAt) value += 1;
    if (activity.durationMs != null) value += 1;
    if (activity.outcome === "success" || activity.outcome === "failure") value += 1;
    return value;
  };

  const byKey = new Map();
  for (const activity of activities) {
    const key = activity.evidence.toolUseId
      ? `${activity.provider}:${activity.kind}:${activity.name}:tool:${activity.evidence.toolUseId}`
      : `${activity.provider}:${activity.kind}:${activity.name}:${activity.startedAt}:${activity.evidence.signal}`;
    const existing = byKey.get(key);
    if (!existing || score(activity) > score(existing)) byKey.set(key, activity);
  }
  return [...byKey.values()];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [inputDir] = process.argv.slice(2);
  if (!inputDir) {
    console.error("Usage: node tirion_activity_extractor.mjs <otlp-capture-dir>");
    process.exit(2);
  }
  console.log(JSON.stringify(extractSkillActivitiesFromOtlpDir(inputDir), null, 2));
}
