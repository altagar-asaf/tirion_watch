import { appendFileSync, chmodSync, copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentDiagnosticEventV1 } from "@tirion/agent-contract";
import { ensurePrivateDirectory } from "@tirion/platform";

export const MAX_LOG_BYTES = 5 * 1024 * 1024;
export const MAX_LOG_ROTATIONS = 3;

export class SafeStructuredLog {
  constructor(private readonly path: string) {}

  append(event: AgentDiagnosticEventV1): void {
    ensurePrivateDirectory(dirname(this.path));
    if (existsSync(this.path) && statSync(this.path).size >= MAX_LOG_BYTES) {
      rotateLogs(this.path);
    }
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(this.path, 0o600);
  }

  read(limit: number): AgentDiagnosticEventV1[] {
    const boundedLimit = Math.max(1, Math.floor(limit));
    const events: AgentDiagnosticEventV1[] = [];
    for (const candidate of retainedPaths(this.path)) {
      if (!existsSync(candidate)) {
        continue;
      }
      for (const line of readFileSync(candidate, "utf8").split("\n")) {
        if (!line.trim()) {
          continue;
        }
        try {
          events.push(JSON.parse(line) as AgentDiagnosticEventV1);
        } catch {
          continue;
        }
      }
    }
    return events.reverse().slice(0, boundedLimit);
  }

  clear(): void {
    for (const candidate of retainedPaths(this.path)) {
      rmSync(candidate, { force: true });
    }
  }
}

function rotateLogs(path: string): void {
  for (let index = MAX_LOG_ROTATIONS; index >= 1; index -= 1) {
    const current = `${path}.${index}`;
    const next = `${path}.${index + 1}`;
    if (index === MAX_LOG_ROTATIONS) {
      rmSync(current, { force: true });
      continue;
    }
    if (existsSync(current)) {
      copyFileSync(current, next);
      chmodSync(next, 0o600);
    }
  }
  if (existsSync(path)) {
    copyFileSync(path, `${path}.1`);
    chmodSync(`${path}.1`, 0o600);
  }
  writeFileSync(path, "", { encoding: "utf8", mode: 0o600 });
}

function retainedPaths(path: string): string[] {
  const paths: string[] = [];
  for (let index = MAX_LOG_ROTATIONS; index >= 1; index -= 1) {
    paths.push(`${path}.${index}`);
  }
  paths.push(path);
  return paths;
}
