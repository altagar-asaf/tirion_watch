#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const [inputArg] = process.argv.slice(2);
if (!inputArg) {
  console.error("Usage: node summarize_provider_native_activity.mjs <otlp-capture-dir>");
  process.exit(2);
}

const inputDir = resolve(inputArg);

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

function readJsonBodies(dir) {
  const bodies = [];
  for (const file of readdirSync(dir).sort()) {
    const path = join(dir, file);
    if (!statSync(path).isFile() || !file.endsWith(".body")) continue;
    const text = readFileSync(path, "utf8").trim();
    if (!text.startsWith("{")) {
      bodies.push({ file, binary: true, bytes: text.length });
      continue;
    }
    try {
      bodies.push({ file, json: JSON.parse(text) });
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
          name: attributes["event.name"] ?? attributes["name"] ?? otlpValue(record.body) ?? "",
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
          kind: span.kind,
          attributes: attrs(span.attributes),
        });
      }
    }
  }
  return spans;
}

function groupCounts(items, getKey) {
  const counts = new Map();
  for (const item of items) {
    const key = getKey(item) || "(unnamed)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function sample(items, predicate) {
  const item = items.find(predicate);
  if (!item) return null;
  return {
    file: item.file,
    name: item.name,
    body: item.body,
    attributes: item.attributes,
  };
}

function hasAttr(item, pattern) {
  return Object.entries(item.attributes ?? {}).some(([key, value]) => pattern.test(`${key}=${value}`));
}

function classify(records, spans) {
  const all = [...records, ...spans];
  const hasName = (pattern) => all.some((item) => pattern.test(item.name ?? ""));
  return {
    llmRequest: {
      present: hasName(/(llm_request|api_request|sse_event)/i),
      sample: sample(all, (item) => /(llm_request|api_request|sse_event)/i.test(item.name ?? "")),
    },
    tool: {
      present: hasName(/tool/i) || all.some((item) => hasAttr(item, /\btool/i)),
      sample: sample(all, (item) => /tool/i.test(item.name ?? "") || hasAttr(item, /\btool/i)),
    },
    mcp: {
      present: hasName(/mcp/i) || all.some((item) => hasAttr(item, /\bmcp/i)),
      sample: sample(all, (item) => /mcp/i.test(item.name ?? "") || hasAttr(item, /\bmcp/i)),
    },
    subagent: {
      present: hasName(/subagent/i) || all.some((item) => hasAttr(item, /(subagent|agent_type|subagent_type)/i)),
      sample: sample(all, (item) => /subagent/i.test(item.name ?? "") || hasAttr(item, /(subagent|agent_type|subagent_type)/i)),
    },
    skill: {
      present: hasName(/skill/i) || all.some((item) => hasAttr(item, /\bskill/i)),
      sample: sample(all, (item) => /skill/i.test(item.name ?? "") || hasAttr(item, /\bskill/i)),
    },
  };
}

function providerFor(item) {
  const serviceName = item.resource?.["service.name"] ?? "";
  if (/claude/i.test(serviceName)) return "claude-code";
  if (/codex/i.test(serviceName)) return "codex";
  return "unknown";
}

function providerItems(records, spans, provider) {
  return {
    records: records.filter((item) => providerFor(item) === provider),
    spans: spans.filter((item) => providerFor(item) === provider),
  };
}

function sampleMatch(items, predicate) {
  const item = items.find(predicate);
  if (!item) return null;
  return {
    file: item.file,
    name: item.name,
    body: item.body,
    attributes: item.attributes,
  };
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

function providerFindings(records, spans) {
  const claude = providerItems(records, spans, "claude-code");
  const codex = providerItems(records, spans, "codex");
  const claudeAll = [...claude.records, ...claude.spans];
  const codexAll = [...codex.records, ...codex.spans];

  const claudeHas = (predicate) => claudeAll.some(predicate);
  const codexHas = (predicate) => codexAll.some(predicate);
  const attr = (item, key) => item.attributes?.[key] ?? "";
  const param = (item, key) => parseToolParameters(item)?.[key] ?? "";

  return {
    "claude-code": {
      observedNativeActivity: {
        llmRequest: claudeHas((item) => item.body === "claude_code.api_request" || item.name === "claude_code.llm_request"),
        tool: claudeHas((item) => item.body === "claude_code.tool_result" || item.body === "claude_code.tool_decision" || item.name === "claude_code.tool"),
        mcpInvocation: claudeHas((item) => /^mcp__/i.test(String(attr(item, "tool_name"))) || String(attr(item, "mcp_server_name")).length > 0 || String(param(item, "mcp_server_name")).length > 0),
        subagentInvocation: claudeHas((item) => String(attr(item, "subagent_type")).length > 0 || String(param(item, "subagent_type")).length > 0 || String(attr(item, "agent_id")).length > 0),
        skillInvocation: claudeHas((item) => String(attr(item, "skill_name")).length > 0 || String(attr(item, "skill.name")).length > 0 || String(param(item, "skill_name")).length > 0),
      },
      samples: {
        llmRequest: sampleMatch(claudeAll, (item) => item.body === "claude_code.api_request" || item.name === "claude_code.llm_request"),
        tool: sampleMatch(claudeAll, (item) => item.body === "claude_code.tool_result" || item.body === "claude_code.tool_decision" || item.name === "claude_code.tool"),
        mcpInvocation: sampleMatch(claudeAll, (item) => /^mcp__/i.test(String(attr(item, "tool_name"))) || String(attr(item, "mcp_server_name")).length > 0 || String(param(item, "mcp_server_name")).length > 0),
        subagentInvocation: sampleMatch(claudeAll, (item) => String(attr(item, "subagent_type")).length > 0 || String(param(item, "subagent_type")).length > 0 || String(attr(item, "agent_id")).length > 0),
        skillInvocation: sampleMatch(claudeAll, (item) => String(attr(item, "skill_name")).length > 0 || String(attr(item, "skill.name")).length > 0 || String(param(item, "skill_name")).length > 0),
      },
      note: "Claude Code documents mcp, subagent, and skill details as tool-span/tool-event attributes when those tools are actually used; this probe only forced a built-in Read tool.",
    },
    codex: {
      observedNativeActivity: {
        llmRequestLike: codexHas((item) => item.name === "codex.api_request" || item.name === "codex.sse_event"),
        tool: codexHas((item) => item.name === "codex.tool_result" || item.name === "codex.tool_decision" || String(attr(item, "tool_name")).length > 0),
        mcpInvocation: codexHas((item) => item.name === "codex.tool_result" && String(attr(item, "mcp_server")).length > 0),
        subagentInvocation: false,
        skillInvocation: false,
      },
      observedInternals: {
        mcpConfiguredOrListed: codexHas((item) => /mcp/i.test(item.name) || String(attr(item, "mcp_servers")).length > 0 || String(attr(item, "server_name")).length > 0),
        skillCatalogOrLoading: codexHas((item) => /skill/i.test(item.name)),
        threadSpawnSpan: codexHas((item) => item.name === "thread_spawn"),
      },
      samples: {
        llmRequestLike: sampleMatch(codexAll, (item) => item.name === "codex.api_request" || item.name === "codex.sse_event"),
        tool: sampleMatch(codexAll, (item) => item.name === "codex.tool_result" || item.name === "codex.tool_decision" || String(attr(item, "tool_name")).length > 0),
        mcpInvocation: sampleMatch(codexAll, (item) => item.name === "codex.tool_result" && String(attr(item, "mcp_server")).length > 0),
      },
      note: "Codex exposes API/SSE/tool telemetry natively. MCP invocations appear as codex.tool_result rows with mcp_server metadata; skill and subagent did not appear as user activity kinds in this probe.",
    },
  };
}

const bodies = readJsonBodies(inputDir);
const records = bodies.flatMap(collectLogs);
const spans = bodies.flatMap(collectSpans);

console.log(JSON.stringify({
  inputDir,
  filesRead: bodies.length,
  binaryBodies: bodies.filter((body) => body.binary).length,
  parseErrors: bodies.filter((body) => body.parseError).map((body) => ({ file: body.file, parseError: body.parseError })),
  logRecordCount: records.length,
  spanCount: spans.length,
  logNames: groupCounts(records, (record) => record.name),
  spanNames: groupCounts(spans, (span) => span.name),
  resources: groupCounts([...records, ...spans], (item) => item.resource?.["service.name"] ?? item.resource?.["service"] ?? ""),
  providerFindings: providerFindings(records, spans),
}, null, 2));
