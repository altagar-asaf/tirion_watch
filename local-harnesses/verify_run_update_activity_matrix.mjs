#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_PROVIDERS = ["claude-code", "codex"];
const DEFAULT_KINDS = ["llm_request", "tool", "mcp", "subagent", "skill"];

function usage() {
  console.error(`Usage:
  node local-harnesses/verify_run_update_activity_matrix.mjs [options] <events-path>...

Options:
  --allow-simulator       Count Event Emitting Simulator events.
  --run-id <id>           Only count events from this run id. May be repeated.
  --provider <list>       Comma-separated providers. Default: ${DEFAULT_PROVIDERS.join(",")}
  --kind <list>           Comma-separated activity kinds. Default: ${DEFAULT_KINDS.join(",")}
  --help                  Show this help.

The verifier exits non-zero unless every provider/kind pair is present in
run.update.activity[] from non-simulator webhook events.`);
}

function parseArgs(argv) {
  const options = {
    allowSimulator: false,
    runIds: new Set(),
    providers: DEFAULT_PROVIDERS,
    kinds: DEFAULT_KINDS,
    paths: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--allow-simulator") {
      options.allowSimulator = true;
      continue;
    }
    if (arg === "--run-id") {
      const value = argv[++i];
      if (!value) throw new Error("--run-id requires a value");
      options.runIds.add(value);
      continue;
    }
    if (arg === "--provider") {
      const value = argv[++i];
      if (!value) throw new Error("--provider requires a value");
      options.providers = splitList(value);
      continue;
    }
    if (arg === "--kind") {
      const value = argv[++i];
      if (!value) throw new Error("--kind requires a value");
      options.kinds = splitList(value);
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    options.paths.push(arg);
  }

  if (options.paths.length === 0) {
    throw new Error("At least one events path is required");
  }
  return options;
}

function splitList(value) {
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) throw new Error(`Empty list: ${value}`);
  return items;
}

function collectFiles(paths) {
  const files = [];
  for (const inputPath of paths) {
    const absolutePath = resolve(inputPath);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      collectDirectory(absolutePath, files);
    } else {
      files.push(absolutePath);
    }
  }
  return files.sort();
}

function collectDirectory(directory, files) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      collectDirectory(path, files);
    } else if (entry.endsWith(".json") || entry.endsWith(".jsonl") || entry.endsWith(".ndjson")) {
      files.push(path);
    }
  }
}

function readEvents(file) {
  const text = readFileSync(file, "utf8").trim();
  if (!text) return [];

  const parsed = tryParseJson(text);
  if (parsed.ok) return normalizeParsedEvents(parsed.value, file);

  const events = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const lineParsed = tryParseJson(line);
    if (!lineParsed.ok) {
      throw new Error(`${file}:${index + 1} is not valid JSON`);
    }
    events.push(...normalizeParsedEvents(lineParsed.value, file));
  }
  return events;
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function normalizeParsedEvents(value, file) {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => {
    if (Array.isArray(item?.events)) {
      return item.events.map((event) => unwrapEvent(event, file));
    }
    return [unwrapEvent(item, file)];
  });
}

function unwrapEvent(item, file) {
  const event = item?.body ?? item?.payload ?? item?.event ?? item;
  return { event, file };
}

function senderName(event) {
  return [
    event?.sender?.name,
    event?.sender?.installationId,
    event?.sender?.team,
  ].filter(Boolean).join(" ");
}

function isSimulatorEvent(event) {
  return /simulator/i.test(senderName(event));
}

function countActivities(events, options) {
  const counts = new Map();
  const samples = new Map();
  const senderCounts = new Map();
  const skippedSimulatorCounts = new Map();
  const invalid = [];
  let runUpdateEvents = 0;
  let countedRunUpdateEvents = 0;
  let activityCount = 0;

  for (const { event, file } of events) {
    if (event?.eventType !== "run.update") continue;
    runUpdateEvents += 1;

    const sender = senderName(event) || "unknown";
    increment(senderCounts, sender);

    if (options.runIds.size > 0 && !options.runIds.has(event.runId)) continue;
    if (!options.allowSimulator && isSimulatorEvent(event)) {
      increment(skippedSimulatorCounts, sender);
      continue;
    }

    const provider = event.codingHarness ?? event.provider ?? event.runtime;
    if (!options.providers.includes(provider)) continue;
    countedRunUpdateEvents += 1;

    for (const activity of event.activity ?? []) {
      if (!options.kinds.includes(activity?.kind)) continue;
      activityCount += 1;
      const key = `${provider}\t${activity.kind}`;
      increment(counts, key);
      if (!samples.has(key)) {
        samples.set(key, {
          eventId: event.eventId,
          runId: event.runId,
          sender,
          name: activity.name,
          basis: activity.evidence?.basis,
          sourceId: activity.evidence?.sourceId,
          profileVersion: activity.evidence?.profileVersion,
          file,
        });
      }

      const missingFields = validateActivity(activity);
      if (missingFields.length > 0) {
        invalid.push({
          provider,
          kind: activity.kind,
          eventId: event.eventId,
          runId: event.runId,
          missingFields,
          file,
        });
      }
    }
  }

  return {
    runUpdateEvents,
    countedRunUpdateEvents,
    activityCount,
    counts,
    samples,
    senderCounts,
    skippedSimulatorCounts,
    invalid,
  };
}

function validateActivity(activity) {
  const required = [
    ["activityId", activity?.activityId],
    ["kind", activity?.kind],
    ["name", activity?.name],
    ["outcome", activity?.outcome],
    ["startedAt", activity?.startedAt],
    ["evidence.basis", activity?.evidence?.basis],
    ["evidence.sourceId", activity?.evidence?.sourceId],
    ["evidence.profileVersion", activity?.evidence?.profileVersion],
  ];
  return required.filter(([, value]) => value === undefined || value === null || value === "").map(([name]) => name);
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function plainObjectFromMap(map) {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function buildMatrix(options, counts, samples) {
  return options.providers.map((provider) => ({
    provider,
    kinds: Object.fromEntries(options.kinds.map((kind) => {
      const key = `${provider}\t${kind}`;
      return [kind, {
        count: counts.get(key) ?? 0,
        sample: samples.get(key) ?? null,
      }];
    })),
  }));
}

function missingPairs(options, counts) {
  const missing = [];
  for (const provider of options.providers) {
    for (const kind of options.kinds) {
      const key = `${provider}\t${kind}`;
      if ((counts.get(key) ?? 0) === 0) {
        missing.push({ provider, kind });
      }
    }
  }
  return missing;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = collectFiles(options.paths);
  const events = files.flatMap((file) => readEvents(file));
  const result = countActivities(events, options);
  const missing = missingPairs(options, result.counts);
  const report = {
    ok: missing.length === 0 && result.invalid.length === 0,
    allowSimulator: options.allowSimulator,
    filters: {
      providers: options.providers,
      kinds: options.kinds,
      runIds: [...options.runIds].sort(),
    },
    filesRead: files.length,
    eventsRead: events.length,
    runUpdateEvents: result.runUpdateEvents,
    countedRunUpdateEvents: result.countedRunUpdateEvents,
    countedActivities: result.activityCount,
    senderCounts: plainObjectFromMap(result.senderCounts),
    skippedSimulatorCounts: plainObjectFromMap(result.skippedSimulatorCounts),
    matrix: buildMatrix(options, result.counts, result.samples),
    missing,
    invalidActivities: result.invalid,
  };

  console.log(JSON.stringify(report, null, 2));

  if (missing.length > 0) {
    console.error(`Missing run.update.activity evidence for ${missing.length} provider/kind pair(s).`);
  }
  if (result.invalid.length > 0) {
    console.error(`Found ${result.invalid.length} activity row(s) missing required fields.`);
  }
  if (missing.length > 0 || result.invalid.length > 0) {
    process.exit(1);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  usage();
  process.exit(2);
}
