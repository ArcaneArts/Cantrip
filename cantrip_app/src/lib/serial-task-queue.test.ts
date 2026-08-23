import { describe, expect, it, vi } from "vitest";

import { SerialTaskQueue } from "./serial-task-queue";

describe("SerialTaskQueue", () => {
  it("does not start a newer task until the previous task settles", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const queue = new SerialTaskQueue();

    const first = queue.run(async () => {
      order.push("first-started");
      await firstGate;
      order.push("first-finished");
    });
    const second = queue.run(async () => {
      order.push("second-started");
    });
    await vi.waitFor(() => expect(order).toEqual(["first-started"]));

    releaseFirst?.();
    await Promise.all([first, second]);

    expect(order).toEqual([
      "first-started",
      "first-finished",
      "second-started",
    ]);
  });

  it("continues after a rejected task", async () => {
    const queue = new SerialTaskQueue();
    const rejected = queue.run(async () => {
      throw new Error("superseded");
    });
    const next = queue.run(async () => "latest");

    await expect(rejected).rejects.toThrow("superseded");
    await expect(next).resolves.toBe("latest");
  });
});
