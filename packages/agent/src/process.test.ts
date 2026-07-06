import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStorageClient } from "@tirion/agent-storage";

const roots: string[] = [];
const children: ReturnType<typeof spawn>[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("standalone agent process", () => {
  it("starts without VS Code, survives client exit, and stays within the baseline resource budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-process-"));
    roots.push(root);
    const socketPath = join(root, "agent.sock");
    const child = spawn(process.execPath, [join(__dirname, "..", "dist", "main.js")], {
      env: {
        ...process.env,
        TIRION_AGENT_STATE_DIR: root,
        TIRION_AGENT_SOCKET: socketPath,
        TIRION_AGENT_OTLP_PORT: "0"
      },
      stdio: "ignore"
    });
    children.push(child);
    const first = await waitForStatus(socketPath);
    expect(first).toMatchObject({ health: "healthy", ownershipState: "agent_full_owner" });
    const second = await getStatus(socketPath);
    expect(second).toMatchObject({ health: "healthy" });
    expect(child.exitCode).toBeNull();
    const started = Date.now();
    for (let index = 0; index < 25; index += 1) {
      await getStatus(socketPath);
    }
    expect(Date.now() - started).toBeLessThan(3_000);
    if (process.platform !== "win32") {
      const residentKilobytes = Number(execFileSync("ps", ["-o", "rss=", "-p", String(child.pid)], { encoding: "utf8" }).trim());
      expect(residentKilobytes).toBeGreaterThan(0);
      expect(residentKilobytes).toBeLessThan(512 * 1024);
    }
  });

  it("completes the persisted usage-owner to full-owner cutover in a real process", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-process-cutover-"));
    roots.push(root);
    const databasePath = join(root, "agent.db");
    const storage = new AgentStorageClient({ databasePath });
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_usage_owner",
      protocolVersion: "1.0"
    });
    await storage.beginProductionUsageEpoch("2026-06-08T00:00:00.000Z");
    await storage.close();
    const socketPath = join(root, "agent.sock");
    const child = spawn(process.execPath, [join(__dirname, "..", "dist", "main.js")], {
      env: {
        ...process.env,
        TIRION_AGENT_STATE_DIR: root,
        TIRION_AGENT_SOCKET: socketPath,
        TIRION_AGENT_OTLP_PORT: "0"
      },
      stdio: "ignore"
    });
    children.push(child);
    expect(await waitForStatus(socketPath)).toMatchObject({ ownershipState: "agent_usage_owner" });
    const credential = readFileSync(join(root, "bootstrap.token"), "utf8").trim();
    expect(await call(socketPath, "POST", "/v1/ownership/transition", credential, {
      target: "agent_full_owner"
    })).toMatchObject({ state: "agent_full_owner" });
    expect(await getStatus(socketPath)).toMatchObject({ ownershipState: "agent_full_owner" });
  });
});

async function waitForStatus(socketPath: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = await getStatus(socketPath).catch(() => undefined);
    if (status?.health === "healthy") {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("agent_unavailable");
}

function getStatus(socketPath: string): Promise<Record<string, unknown>> {
  return call(socketPath, "GET", "/v1/status");
}

function call(socketPath: string, method: string, path: string, credential?: string, body?: unknown): Promise<Record<string, unknown>> {
  const encoded = body == null ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath,
      method,
      path,
      headers: {
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        ...(encoded ? { "content-type": "application/json", "content-length": encoded.length } : {})
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>));
    });
    req.on("error", reject);
    req.end(encoded);
  });
}
