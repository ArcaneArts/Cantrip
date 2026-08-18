import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runWorkerRuntimeLoop,
  scheduleWorkerRuntimeRestart,
} from "./runtime-loop.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("worker runtime restart loop", () => {
  it("starts a fresh runtime after every graceful restart outcome", async () => {
    const outcomes: Array<"restart" | "stop"> = ["restart", "restart", "stop"];
    const runOnce = vi.fn(async () => outcomes.shift() ?? "stop");

    await runWorkerRuntimeLoop(runOnce);

    expect(runOnce).toHaveBeenCalledTimes(3);
  });

  it("defers restart until the command response has time to flush", () => {
    vi.useFakeTimers();
    const restart = vi.fn();

    scheduleWorkerRuntimeRestart(restart, 250);
    vi.advanceTimersByTime(249);
    expect(restart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(restart).toHaveBeenCalledOnce();
  });

  it("can cancel a deferred restart during shutdown", () => {
    vi.useFakeTimers();
    const restart = vi.fn();

    const cancel = scheduleWorkerRuntimeRestart(restart, 250);
    cancel();
    vi.runAllTimers();

    expect(restart).not.toHaveBeenCalled();
  });
});
