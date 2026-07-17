import { describe, expect, it } from "vitest";
import { RuntimeWorkScheduler } from "./runtimeWorkScheduler";

describe("RuntimeWorkScheduler", () => {
  it("coalesces repeated work for the same key while keeping callers non-blocking", async () => {
    const scheduler = new RuntimeWorkScheduler();
    let release: (() => void) | undefined;
    const started: number[] = [];
    const work = async () => {
      started.push(started.length + 1);
      if (started.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    };

    scheduler.enqueue("usage_projection", work);
    scheduler.enqueue("usage_projection", work);
    scheduler.enqueue("usage_projection", work);
    await Promise.resolve();

    expect(started).toEqual([1]);
    release?.();
    await scheduler.drain();

    expect(started).toEqual([1, 2]);
  });

  it("runs independent keys without making them wait for a blocked key", async () => {
    const scheduler = new RuntimeWorkScheduler();
    let release: (() => void) | undefined;
    const completed: string[] = [];

    scheduler.enqueue("usage_projection", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      completed.push("usage_projection");
    });
    scheduler.enqueue("diagnostics_refresh", async () => {
      completed.push("diagnostics_refresh");
    });
    await scheduler.drainKey("diagnostics_refresh");

    expect(completed).toEqual(["diagnostics_refresh"]);
    release?.();
    await scheduler.drain();
    expect(completed).toEqual(["diagnostics_refresh", "usage_projection"]);
  });

  it("drains work enqueued by a completed prior lane to a fixed point", async () => {
    const scheduler = new RuntimeWorkScheduler();
    const completed: string[] = [];

    scheduler.enqueue("usage_projection", async () => {
      completed.push("usage_projection");
      scheduler.enqueue("webhook_lifecycle_projection", async () => {
        completed.push("webhook_lifecycle_projection");
      });
    });

    await expect(scheduler.drainToFixedPoint()).resolves.toBe(true);
    expect(completed).toEqual(["usage_projection", "webhook_lifecycle_projection"]);
  });

  it("fails closed for an invalid fixed-point round bound", async () => {
    const scheduler = new RuntimeWorkScheduler();
    await expect(scheduler.drainToFixedPoint(0)).resolves.toBe(false);
  });
});
