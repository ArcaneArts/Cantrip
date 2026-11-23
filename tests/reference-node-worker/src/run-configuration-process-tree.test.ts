import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RunConfigurationProcessTreeController,
  type RunConfigurationProcessTreeChild,
} from "./run-configuration-process-tree.js";

class FakeTaskkill extends EventEmitter {
  readonly kill = vi.fn(() => true);

  exit(code: number | null): void {
    this.emit("exit", code);
  }

  fail(): void {
    this.emit("error", new Error("taskkill failed"));
  }
}

function fakeChild(): RunConfigurationProcessTreeChild {
  return {
    pid: 42,
    kill: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RunConfigurationProcessTreeController", () => {
  it.each([
    [false, "SIGTERM"],
    [true, "SIGKILL"],
  ] as const)(
    "signals the full POSIX process group (force=%s)",
    async (force, signal) => {
      const child = fakeChild();
      const killProcessGroup = vi.fn();
      const controller = new RunConfigurationProcessTreeController({
        killProcessGroup,
        platform: "linux",
      });

      await controller.signal(child, force);

      expect(killProcessGroup).toHaveBeenCalledWith(42, signal);
      expect(child.kill).not.toHaveBeenCalled();
    },
  );

  it("falls back to the direct PTY signal when a POSIX group is already gone", async () => {
    const child = fakeChild();
    const controller = new RunConfigurationProcessTreeController({
      killProcessGroup: () => {
        throw new Error("ESRCH");
      },
      platform: "darwin",
    });

    await controller.signal(child, false);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.each([
    [false, ["/PID", "42", "/T"]],
    [true, ["/PID", "42", "/T", "/F"]],
  ] as const)(
    "uses bounded taskkill tree signaling on Windows (force=%s)",
    async (force, expectedArguments) => {
      const child = fakeChild();
      const taskkill = new FakeTaskkill();
      const spawnTaskkill = vi.fn(() => taskkill);
      const controller = new RunConfigurationProcessTreeController({
        platform: "win32",
        spawnTaskkill,
      });

      const signaling = controller.signal(child, force);
      taskkill.exit(0);
      await signaling;

      expect(spawnTaskkill).toHaveBeenCalledWith(expectedArguments);
      expect(child.kill).not.toHaveBeenCalled();
      expect(taskkill.kill).not.toHaveBeenCalled();
    },
  );

  it.each(["nonzero exit", "spawn error", "spawn throw"])(
    "falls back to the PTY when taskkill reports a %s",
    async (failure) => {
      const child = fakeChild();
      const taskkill = new FakeTaskkill();
      const controller = new RunConfigurationProcessTreeController({
        platform: "win32",
        spawnTaskkill: () => {
          if (failure === "spawn throw") throw new Error("ENOENT");
          return taskkill;
        },
      });

      const signaling = controller.signal(child, false);
      if (failure === "nonzero exit") taskkill.exit(1);
      if (failure === "spawn error") taskkill.fail();
      await signaling;

      expect(child.kill).toHaveBeenCalledOnce();
      expect(child.kill).toHaveBeenCalledWith(undefined);
    },
  );

  it("bounds a hung taskkill and ignores its late exit", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const taskkill = new FakeTaskkill();
    const controller = new RunConfigurationProcessTreeController({
      platform: "win32",
      spawnTaskkill: () => taskkill,
      taskkillTimeoutMs: 25,
    });

    const signaling = controller.signal(child, true);
    await vi.advanceTimersByTimeAsync(25);
    await signaling;
    taskkill.exit(0);

    expect(taskkill.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("treats a process-exit race as an idempotent signal", async () => {
    const child = fakeChild();
    vi.mocked(child.kill).mockImplementation(() => {
      throw new Error("Process already exited");
    });
    const taskkill = new FakeTaskkill();
    const controller = new RunConfigurationProcessTreeController({
      platform: "win32",
      spawnTaskkill: () => taskkill,
    });

    const signaling = controller.signal(child, false);
    taskkill.exit(128);

    await expect(signaling).resolves.toBeUndefined();
  });
});
