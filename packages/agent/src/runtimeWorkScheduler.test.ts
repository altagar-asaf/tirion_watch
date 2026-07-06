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
});
