import { describe, expect, it, vi } from "vitest";

import { ExplorerCodeLaunchTiming } from "./explorer-code-launch-timing";

const context = {
  attachmentReadyAtRequest: false,
  explorerId: "explorer-one",
  launchKind: "file" as const,
  workerId: "worker-one",
  workerOnlineAtRequest: true,
  workbenchReadyAtRequest: false,
  worktreeId: "worktree-one",
};

describe("ExplorerCodeLaunchTiming", () => {
  it("records correlated phase and total launch durations", () => {
    let now = 100;
    const log = vi.fn();
    const timing = new ExplorerCodeLaunchTiming(context, {
      createId: () => "launch-one",
      log,
      now: () => now,
    });

    now = 110;
    const session = timing.beginPhase("session-route");
    now = 145;
    session.complete({ attachmentId: "attachment-one" });
    now = 150;
    const transport = timing.beginPhase("transport-ready");
    now = 190;
    transport.fail(new TypeError("Load failed"), { willRetry: true });
    now = 200;
    timing.milestone("workbench-ready");
    now = 215;
    timing.complete({ sessionId: "session-one" });

    expect(log).toHaveBeenNthCalledWith(
      1,
      "info",
      "Cantrip Code editor launch started",
      expect.objectContaining({
        event: "code.editor.launch.started",
        launchId: "launch-one",
      }),
    );
    expect(log).toHaveBeenNthCalledWith(
      2,
      "info",
      "Cantrip Code editor launch phase completed",
      expect.objectContaining({
        attempt: 1,
        durationMs: 35,
        phase: "session-route",
        totalDurationMs: 45,
      }),
    );
    expect(log).toHaveBeenNthCalledWith(
      3,
      "warn",
      "Cantrip Code editor launch phase failed",
      expect.objectContaining({
        durationMs: 40,
        errorClass: "TypeError",
        phase: "transport-ready",
        totalDurationMs: 90,
        willRetry: true,
      }),
    );
    expect(log).toHaveBeenNthCalledWith(
      4,
      "info",
      "Cantrip Code editor launch phase completed",
      expect.objectContaining({
        durationMs: 55,
        phase: "workbench-ready",
        totalDurationMs: 100,
      }),
    );
    expect(log).toHaveBeenNthCalledWith(
      5,
      "info",
      "Cantrip Code editor launch completed",
      expect.objectContaining({
        durationMs: 115,
        sessionId: "session-one",
      }),
    );
  });

  it("ignores late phase completions after a launch is cancelled", () => {
    let now = 0;
    const log = vi.fn();
    const timing = new ExplorerCodeLaunchTiming(context, {
      createId: () => "launch-two",
      log,
      now: () => now,
    });
    const fileOpen = timing.beginPhase("file-open");

    now = 25;
    timing.cancel("request-superseded");
    now = 50;
    fileOpen.complete();
    timing.complete();

    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith(
      "debug",
      "Cantrip Code editor launch cancelled",
      expect.objectContaining({
        durationMs: 25,
        reasonCode: "request-superseded",
      }),
    );
  });
});
