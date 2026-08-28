import { afterEach, describe, expect, it, vi } from "vitest";

import {
  observeTaskLaunchStage,
  TaskLaunchStageTimeoutError,
  withTaskLaunchStageTimeout,
} from "../src/tasks/launch-observation.js";

const cycle = { chatId: "chat", id: "cycle" };

afterEach(() => {
  vi.useRealTimers();
});

describe("Task launch observation", () => {
  it("records completed launch stages at an operator-visible level", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };

    await expect(
      observeTaskLaunchStage(
        logger as never,
        cycle,
        "resolve-context",
        async () => "ready",
        { slowWarningMs: null },
      ),
    ).resolves.toBe("ready");

    expect(logger.info).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        event: "task.operation.launch-stage",
        status: "started",
        stage: "resolve-context",
      }),
      "Scheduled Task launch stage started",
    );
    expect(logger.info).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event: "task.operation.launch-stage",
        status: "completed",
        stage: "resolve-context",
      }),
      "Scheduled Task launch stage completed",
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns on a slow stage and rejects it at the configured deadline", async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const pending = observeTaskLaunchStage(
      logger as never,
      cycle,
      "begin-turn",
      () => new Promise<never>(() => undefined),
      { slowWarningMs: 100, timeoutMs: 200 },
    );
    const rejection = expect(pending).rejects.toMatchObject({
      name: "TaskLaunchStageTimeoutError",
      stage: "begin-turn",
      timeoutMs: 200,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: "slow-stage",
        status: "waiting",
        stage: "begin-turn",
      }),
      "Scheduled Task launch stage is still waiting",
    );

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: "stage-timeout",
        status: "failed",
        stage: "begin-turn",
      }),
      "Scheduled Task launch stage failed",
    );
  });

  it("bounds scheduler runtime resolution without lifecycle log noise", async () => {
    vi.useFakeTimers();
    const pending = withTaskLaunchStageTimeout(
      "resolve-runtime",
      50,
      () => new Promise<never>(() => undefined),
    );
    const rejection = expect(pending).rejects.toBeInstanceOf(
      TaskLaunchStageTimeoutError,
    );

    await vi.advanceTimersByTimeAsync(50);
    await rejection;
  });
});
