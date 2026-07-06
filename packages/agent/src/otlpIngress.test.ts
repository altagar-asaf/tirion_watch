import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStorageClient } from "@tirion/agent-storage";
import { OtlpIngress } from "./otlpIngress";

const ingresses: OtlpIngress[] = [];

afterEach(async () => {
  await Promise.all(ingresses.splice(0).map((ingress) => ingress.stop()));
});

describe("OtlpIngress", () => {
  it("acknowledges after durable append without waiting for downstream processing", async () => {
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation: vi.fn(async () => true)
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date("2026-06-30T08:00:00.000Z"),
      async () => {
        await new Promise(() => undefined);
      }
    );
    ingresses.push(ingress);
    await ingress.start();

    const response = callOtlp(ingress.address().port, "/v1/traces", codexTraceBody())
      .catch((error: Error) => ({ error: error.message }));
    const result = await Promise.race([
      response,
      wait(100).then(() => "timed_out")
    ]);

    expect(result).toMatchObject({ status: 200 });
    expect(storage.appendSafeObservation).toHaveBeenCalledTimes(1);
  });
});

function callOtlp(port: number, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const encoded = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path,
      headers: {
        "content-type": "application/json",
        "content-length": encoded.length
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
      }));
    });
    req.on("error", reject);
    req.end(encoded);
  });
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function codexTraceBody(): Record<string, unknown> {
  return {
    resourceSpans: [{
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "codex" } }]
      },
      scopeSpans: [{
        spans: [{
          traceId: "1234567890abcdef1234567890abcdef",
          spanId: "1234567890abcdef",
          name: "codex turn",
          startTimeUnixNano: "1782806400000000000",
          endTimeUnixNano: "1782806401000000000",
          attributes: [
            { key: "gen_ai.system", value: { stringValue: "openai" } },
            { key: "gen_ai.request.model", value: { stringValue: "gpt-5.4-mini" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "10" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: "5" } }
          ]
        }]
      }]
    }]
  };
}
