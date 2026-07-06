#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const [rootArg] = process.argv.slice(2);
if (!rootArg) {
  console.error("Usage: node summarize_provider_native_skill_usage.mjs <probe-root>");
  process.exit(2);
}

const rootDir = resolve(rootArg);

const runs = [
  { id: "claude-control", provider: "claude-code", skillName: "tirion-claude-skill-probe" },
  { id: "claude-slash-skill", provider: "claude-code", skillName: "tirion-claude-skill-probe" },
  { id: "claude-tool-skill", provider: "claude-code", skillName: "tirion-claude-skill-probe" },
  { id: "codex-control", provider: "codex", skillName: "tirion-codex-skill-probe" },
  { id: "codex-skill", provider: "codex", skillName: "tirion-codex-skill-probe" },
];

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

function readOtlpBodies(dir) {
  const bodies = [];
  if (!existsSync(dir)) return bodies;
  for (const file of readdirSync(dir).sort()) {
    const path = join(dir, file);
    if (!statSync(path).isFile() || !file.endsWith(".body")) continue;
    const text = readFileSync(path, "utf8").trim();
    if (!text.startsWith("{")) {
      bodies.push({ file, binary: true, bytes: text.length });
      continue;
    }
    try {
      bodies.push({ file, json: JSON.parse(text), raw: text });
    } catch (error) {
      bodies.push({ file, parseError: error.message });
    }
  }
  return bodies;
}

function collectLogs(body) {
  const records = [];
  for (const resourceLog of body.json?.resourceLogs ?? []) {
    const resource = attrs(resourceLog.resource?.attributes);
    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      const scope = scopeLog.scope?.name ?? "";
      for (const record of scopeLog.logRecords ?? []) {
        const attributes = attrs(record.attributes);
        records.push({
          file: body.file,
          scope,
          resource,
          name: attributes["event.name"] ?? attributes.name ?? "",
          body: otlpValue(record.body),
          attributes,
        });
      }
    }
  }
  return records;
}

function collectSpans(body) {
  const spans = [];
  for (const resourceSpan of body.json?.resourceSpans ?? []) {
    const resource = attrs(resourceSpan.resource?.attributes);
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      const scope = scopeSpan.scope?.name ?? "";
      for (const span of scopeSpan.spans ?? []) {
        spans.push({
          file: body.file,
          scope,
          resource,
          name: span.name ?? "",
          attributes: attrs(span.attributes),
        });
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
  if ("valueAtQuantile" in point) return point.valueAtQuantile;
  return undefined;
}

function collectMetrics(body) {
  const metrics = [];
  for (const resourceMetric of body.json?.resourceMetrics ?? []) {
    const resource = attrs(resourceMetric.resource?.attributes);
    for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
      const scope = scopeMetric.scope?.name ?? "";
      for (const metric of scopeMetric.metrics ?? []) {
        const points = metricPoints(metric).map((point) => ({
          attributes: attrs(point.attributes),
          value: pointValue(point),
        }));
        metrics.push({
          file: body.file,
          scope,
          resource,
          name: metric.name ?? "",
          description: metric.description ?? "",
          unit: metric.unit ?? "",
          points,
        });
      }
    }
  }
  return metrics;
}

function collectStdoutJson(runDir) {
  const path = join(runDir, "stdout.jsonl");
  if (!existsSync(path)) return { lines: 0, parseErrors: 0, events: [], raw: "" };
  const raw = readFileSync(path, "utf8");
  const events = [];
  let parseErrors = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      parseErrors += 1;
    }
  }
  return { lines: raw.split(/\r?\n/).filter(Boolean).length, parseErrors, events, raw };
}

function groupCounts(items, getKey) {
  const counts = new Map();
  for (const item of items) {
    const key = getKey(item) || "(unnamed)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function valueContains(value, needle) {
  if (value == null) return false;
  if (typeof value === "string") return value.includes(needle);
  if (typeof value === "object") return JSON.stringify(value).includes(needle);
  return String(value).includes(needle);
}

function attrContains(attrsObj, needle) {
  return Object.entries(attrsObj ?? {}).some(([key, value]) => key.includes(needle) || valueContains(value, needle));
}

function parseToolParameters(item) {
  const raw = item.attributes?.tool_parameters;
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function relevantAttrs(attributes) {
  const keep = {};
  const patterns = /(event\.name|skill|tool|status|success|trigger|source|service\.name|mcp|agent|command_name|command_source)/i;
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (patterns.test(key) || patterns.test(String(value))) keep[key] = value;
  }
  return keep;
}

function sampleLogOrSpan(item) {
  return {
    file: item.file,
    name: item.name,
    body: item.body,
    attributes: relevantAttrs(item.attributes),
  };
}

function sampleMetric(metric) {
  return {
    file: metric.file,
    name: metric.name,
    points: metric.points.map((point) => ({
      attributes: relevantAttrs(point.attributes),
      value: point.value,
    })),
  };
}

function stdoutSkillEvents(stdout, skillName) {
  return stdout.events
    .filter((event) => valueContains(event, skillName) || attrContains(event, "skill"))
    .slice(0, 5)
    .map(slimStdoutEvent);
}

function snippet(text, max = 160) {
  if (typeof text !== "string") return text;
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function slimStdoutEvent(event) {
  const content = (event.message?.content ?? []).map((item) => {
    if (item.type === "tool_use") {
      return { type: item.type, id: item.id, name: item.name, input: item.input };
    }
    if (item.type === "tool_result") {
      return { type: item.type, tool_use_id: item.tool_use_id, is_error: item.is_error, content: snippet(item.content) };
    }
    if (item.type === "text") {
      return { type: item.type, text: snippet(item.text) };
    }
    return { type: item.type };
  });
  const slim = { type: event.type };
  if (event.subtype) slim.subtype = event.subtype;
  if (content.length > 0) slim.content = content;
  if (event.tool_use_result) {
    slim.tool_use_result = {
      success: event.tool_use_result.success,
      commandName: event.tool_use_result.commandName,
    };
  }
  if (event.item) {
    slim.item = {
      type: event.item.type,
      text: snippet(event.item.text),
    };
  }
  if (event.result) slim.result = snippet(event.result);
  return slim;
}

function claudeStreamSkillToolUse(stdout, skillName) {
  const matches = [];
  for (const event of stdout.events) {
    for (const content of event.message?.content ?? []) {
      if (content?.type === "tool_use" && content.name === "Skill" && content.input?.skill === skillName) {
        matches.push({
          type: event.type,
          tool_use: {
            id: content.id,
            name: content.name,
            input: content.input,
          },
        });
      }
    }
    if (event.tool_use_result?.commandName === skillName) {
      matches.push({
        type: event.type,
        tool_use_result: {
          success: event.tool_use_result.success,
          commandName: event.tool_use_result.commandName,
        },
      });
    }
  }
  return matches;
}

function summarizeRun(run) {
  const runDir = join(rootDir, run.id);
  const bodies = readOtlpBodies(join(runDir, "otlp"));
  const logs = bodies.flatMap(collectLogs);
  const spans = bodies.flatMap(collectSpans);
  const metrics = bodies.flatMap(collectMetrics);
  const stdout = collectStdoutJson(runDir);
  const allTraceItems = [...logs, ...spans];

  const skillName = run.skillName;
  const skillActivatedLogs = logs.filter((item) => {
    const eventName = String(item.name || item.body || "");
    return /skill_activated/i.test(eventName) && valueContains(item.attributes?.["skill.name"], skillName);
  });
  const skillToolAttrs = allTraceItems.filter((item) => {
    const params = parseToolParameters(item);
    return (
      valueContains(item.attributes?.skill_name, skillName) ||
      valueContains(item.attributes?.["skill.name"], skillName) ||
      valueContains(params?.skill_name, skillName)
    );
  });
  const skillInjectedMetrics = metrics.filter((metric) => {
    return /(^|\.|_)skill(\.|_)injected$/i.test(metric.name) &&
      metric.points.some((point) => valueContains(point.attributes?.skill, skillName));
  });
  const genericSkillMetrics = metrics.filter((metric) => {
    return /skill/i.test(metric.name) || metric.points.some((point) => attrContains(point.attributes, "skill"));
  });
  const genericSkillLogOrSpan = allTraceItems.filter((item) => {
    return /skill/i.test(String(item.name || item.body || "")) || attrContains(item.attributes, "skill");
  });

  const rawTelemetryOccurrences = bodies.reduce((count, body) => count + (body.raw?.includes(skillName) ? 1 : 0), 0);

  return {
    provider: run.provider,
    skillName,
    filesRead: bodies.length,
    parseErrors: bodies.filter((body) => body.parseError).map((body) => ({ file: body.file, parseError: body.parseError })),
    logRecordCount: logs.length,
    spanCount: spans.length,
    metricCount: metrics.length,
    stdoutJson: {
      lines: stdout.lines,
      parseErrors: stdout.parseErrors,
      skillNameOccurrences: stdout.raw.split(skillName).length - 1,
      skillEventLikeSamples: stdoutSkillEvents(stdout, skillName),
      claudeSkillToolUseSamples: claudeStreamSkillToolUse(stdout, skillName).slice(0, 5),
    },
    names: {
      logs: groupCounts(logs, (item) => item.name || item.body),
      spans: groupCounts(spans, (item) => item.name),
      metrics: groupCounts(metrics, (item) => item.name),
    },
    nativeSkillEvidence: {
      claudeSkillActivatedLog: {
        present: skillActivatedLogs.length > 0,
        samples: skillActivatedLogs.slice(0, 3).map(sampleLogOrSpan),
      },
      skillToolOrRequestAttributes: {
        present: skillToolAttrs.length > 0,
        samples: skillToolAttrs.slice(0, 3).map(sampleLogOrSpan),
      },
      codexSkillInjectedMetric: {
        present: skillInjectedMetrics.length > 0,
        samples: skillInjectedMetrics.slice(0, 3).map(sampleMetric),
      },
      genericSkillTelemetry: {
        logOrSpanCount: genericSkillLogOrSpan.length,
        metricCount: genericSkillMetrics.length,
        logOrSpanSamples: genericSkillLogOrSpan.slice(0, 5).map(sampleLogOrSpan),
        metricSamples: genericSkillMetrics.slice(0, 5).map(sampleMetric),
      },
      rawTelemetryBodiesContainingSkillName: rawTelemetryOccurrences,
    },
  };
}

const runSummaries = Object.fromEntries(runs.map((run) => [run.id, summarizeRun(run)]));

const claudeSlashPositive = runSummaries["claude-slash-skill"].nativeSkillEvidence;
const claudeToolPositive = runSummaries["claude-tool-skill"].nativeSkillEvidence;
const claudeControl = runSummaries["claude-control"].nativeSkillEvidence;
const claudeToolStream = runSummaries["claude-tool-skill"].stdoutJson.claudeSkillToolUseSamples.length > 0;
const claudeControlStream = runSummaries["claude-control"].stdoutJson.claudeSkillToolUseSamples.length > 0;
const codexPositive = runSummaries["codex-skill"].nativeSkillEvidence;
const codexControl = runSummaries["codex-control"].nativeSkillEvidence;

const conclusions = {
  "claude-code": {
    safeNativeDetection: {
      slashCommandOtel:
        (claudeSlashPositive.claudeSkillActivatedLog.present || claudeSlashPositive.skillToolOrRequestAttributes.present) &&
        !claudeControl.claudeSkillActivatedLog.present &&
        !claudeControl.skillToolOrRequestAttributes.present,
      modelSkillToolOtel:
        (claudeToolPositive.claudeSkillActivatedLog.present || claudeToolPositive.skillToolOrRequestAttributes.present) &&
        !claudeControl.claudeSkillActivatedLog.present &&
        !claudeControl.skillToolOrRequestAttributes.present,
      modelSkillToolStreamJson: claudeToolStream && !claudeControlStream,
    },
    detector:
      "For model-selected skills, detect the Skill tool via claude_code.tool_result/tool_decision or tool spans and parse tool_parameters.skill_name; this requires OTEL_LOG_TOOL_DETAILS=1. In this Claude Code 2.1.50 probe, direct /skill slash-command activation did not emit a skill-specific OTLP log/span/metric.",
  },
  codex: {
    safeNativeDetection:
      codexPositive.codexSkillInjectedMetric.present &&
      !codexControl.codexSkillInjectedMetric.present,
    detector:
      "Use the OTel metric codex.skill.injected/skill.injected with the skill field for high-confidence occurrence detection. It is a point metric, not a duration span; logs/traces alone are not sufficient unless a future Codex version emits a dedicated skill event/span.",
  },
};

console.log(JSON.stringify({ rootDir, runSummaries, conclusions }, null, 2));
