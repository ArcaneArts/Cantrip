import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CantripOsRunLaunch } from "@cantrip/protocol";
import { RunConfigurationRuntimeSupervisor } from "../run-configuration-runtime-supervisor.js";
import type { OsRunCallbacks, OsRunResult } from "./run-execution.js";

function fixture(): CantripOsRunLaunch {
  const id = randomUUID();
  const definitions = {
    kind: "cantrip-os" as const,
    transport: { kind: "docker" as const, container: "fixture" },
    scope: {
      ownerId: "owner",
      workerId: "worker",
      instanceId: id,
      guestInstanceId: id,
      attachmentGeneration: id,
      runtimeGeneration: id,
      bindingId: id,
      bindingGeneration: id,
      projectId: id,
      projectSourceId: id,
      sourceKind: "git" as const,
      worktreeId: id,
      workspaceId: id,
      guestWorkspaceId: "fixture",
      uid: 20000,
      gid: 20000,
      homeGuestPath: "/home/fixture",
      guestPath: "/home/fixture/project",
      dependencyOverlays: [],
      mode: "linux-owned" as const,
      linkedWorkerPath: null,
    },
  };
  return {
    definitions,
    target: definitions,
    protectedSecrets: [],
    identity: {
      runtimeId: randomUUID(),
      projectId: id,
      configurationId: id,
      worktreeId: id,
      workerId: "worker",
      definitionRevision: "a".repeat(64),
      codexEnvironmentRevision: null,
      generation: 1,
      operationId: randomUUID(),
      terminalId: id,
    },
  };
}

function controlledDriver() {
  let finish!: (result: OsRunResult) => void;
  let callbacks!: OsRunCallbacks;
  const completion = new Promise<OsRunResult>((resolve) => {
    finish = resolve;
  });
  const signal = vi.fn(async (_force: boolean) => {});
  const start = vi.fn(
    (_input: CantripOsRunLaunch, supplied: OsRunCallbacks) => {
      callbacks = supplied;
      return { completion, signal };
    },
  );
  const stopRecorded = vi.fn(async (): Promise<OsRunResult> => ({
    outcome: "unknown",
    phase: "reconcile",
    code: "transport-lost",
    message: "Transport lost",
  }));
  return {
    start,
    stopRecorded,
    signal,
    finish: (result: OsRunResult) => finish(result),
    started: () => callbacks.started(1),
    output: (data: string) => callbacks.output(data),
  };
}

describe("Linux Run common lifecycle", () => {
  it("fails a missing Linux executor without invoking Host authorization", async () => {
    const authorize = vi.fn(async () => {
      throw new Error("Host authorization");
    });
    const supervisor = new RunConfigurationRuntimeSupervisor({ authorize });
    const input = fixture();
    await supervisor.start({ type: "cantrip-os.run-runtime.start", ...input });
    await expect
      .poll(() => supervisor.status(input.identity, input))
      .toMatchObject({
        found: true,
        observation: {
          state: "failed",
          failure: { code: "linux-executor-unavailable" },
        },
      });
    expect(authorize).not.toHaveBeenCalled();
    await supervisor.closeAll();
  });

  it("owns preparation before started and ignores a late callback after stop", async () => {
    const driver = controlledDriver();
    const supervisor = new RunConfigurationRuntimeSupervisor({
      authorize: async () => {
        throw new Error("Host");
      },
      linux: driver,
    });
    const input = fixture();
    await supervisor.start({ type: "cantrip-os.run-runtime.start", ...input });
    driver.signal.mockImplementation(async () => {
      driver.finish({ outcome: "interrupted", exitCode: null, signal: null });
    });
    const identity = { ...input.identity, operationId: randomUUID() };
    const stopped = await supervisor.stop({
      type: "cantrip-os.run-runtime.stop",
      definitions: input.definitions,
      target: input.target,
      identity,
    });
    expect(stopped.observation?.state).toBe("idle");
    expect(driver.signal).toHaveBeenCalledWith(false);
    driver.started();
    driver.output("late output");
    expect(supervisor.status(identity, input)).toMatchObject({
      found: true,
      observation: { state: "idle" },
    });
    expect(driver.start).toHaveBeenCalledTimes(1);
    await supervisor.closeAll();
  });

  it("keeps unknown native handles until actual termination is confirmed", async () => {
    const driver = controlledDriver();
    const supervisor = new RunConfigurationRuntimeSupervisor({
      authorize: async () => {
        throw new Error("Host");
      },
      linux: driver,
    });
    const input = fixture();
    await supervisor.start({ type: "cantrip-os.run-runtime.start", ...input });
    driver.started();
    driver.finish({
      outcome: "unknown",
      phase: "reconcile",
      code: "transport-lost",
      message: "Transport lost",
    });
    await expect
      .poll(() => supervisor.status(input.identity, input))
      .toMatchObject({
        found: true,
        observation: { state: "lost", exitCode: null },
      });
    await expect(
      supervisor.start({
        type: "cantrip-os.run-runtime.start",
        ...input,
        identity: {
          ...input.identity,
          generation: 2,
          operationId: randomUUID(),
        },
      }),
    ).rejects.toThrow("cannot replace an active");
    const capture = {
      definitions: input.definitions,
      target: input.target,
      identity: { ...input.identity, operationId: randomUUID() },
    };
    await expect(
      supervisor.stop({ type: "cantrip-os.run-runtime.stop", ...capture }),
    ).rejects.toThrow("could not be confirmed");
    expect(supervisor.status(capture.identity, capture)).toMatchObject({
      found: true,
      observation: { state: "stopping" },
    });
    driver.stopRecorded.mockResolvedValue({
      outcome: "interrupted",
      exitCode: null,
      signal: null,
    });
    const stopped = await supervisor.stop({
      type: "cantrip-os.run-runtime.stop",
      ...capture,
    });
    expect(stopped.observation?.state).toBe("idle");
    expect(driver.stopRecorded).toHaveBeenCalledWith({
      definitions: input.definitions,
      target: input.target,
      identity: input.identity,
    });
    expect(driver.start).toHaveBeenCalledTimes(1);
    await supervisor.closeAll();
  });
});
