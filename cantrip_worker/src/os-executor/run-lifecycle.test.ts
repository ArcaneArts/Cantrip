import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  CantripOsRunLaunch,
  CantripOsRunCapture,
} from "@cantrip/protocol";
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
  const resume = vi.fn(
    async (
      _input: CantripOsRunCapture,
      supplied: OsRunCallbacks,
    ): Promise<{
      completion: Promise<OsRunResult>;
      signal: typeof signal;
    } | null> => {
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
    resume,
    stopRecorded,
    signal,
    finish: (result: OsRunResult) => finish(result),
    started: () => callbacks.started(1),
    output: (data: string) => callbacks.output(data),
    truncated: () => callbacks.truncated?.(),
  };
}

describe("Linux Run common lifecycle", () => {
  it("resumes an existing Linux process after Worker memory loss without starting or stopping it", async () => {
    const driver = controlledDriver();
    const supervisor = new RunConfigurationRuntimeSupervisor({
      authorize: async () => {
        throw new Error("Host");
      },
      linux: driver,
    });
    const input = fixture();
    const capture = {
      identity: input.identity,
      definitions: input.definitions,
      target: input.target,
    };
    const recovered = await supervisor.reconcileLinux([capture]);
    expect(recovered.runtimes).toMatchObject([
      {
        found: true,
        observation: {
          state: "starting",
          generation: input.identity.generation,
        },
      },
    ]);
    expect(driver.resume).toHaveBeenCalledTimes(1);
    expect(driver.start).not.toHaveBeenCalled();
    expect(driver.stopRecorded).not.toHaveBeenCalled();
    driver.started();
    driver.output("retained output\n");
    driver.truncated();
    expect(
      supervisor.output({
        type: "cantrip-os.run-runtime.output",
        ...capture,
        serverId: "fixture",
        requestOperationId: randomUUID(),
        tail: 65536,
      }),
    ).toMatchObject({ data: "retained output\n", truncated: true });
    await supervisor.reconcileLinux([capture]);
    expect(supervisor.status(input.identity, capture)).toMatchObject({
      found: true,
      observation: { state: "running" },
    });
    expect(driver.resume).toHaveBeenCalledTimes(1);
    driver.finish({ outcome: "exited", exitCode: 7, signal: null });
    await vi.waitFor(() =>
      expect(supervisor.status(input.identity, capture)).toMatchObject({
        found: true,
        observation: { state: "exited", exitCode: 7 },
      }),
    );
    expect(driver.signal).not.toHaveBeenCalled();
    await supervisor.closeAll();
  });

  it("leaves a missing native admission unknown rather than stopping or launching a process", async () => {
    const driver = controlledDriver();
    driver.resume.mockResolvedValue(null);
    const supervisor = new RunConfigurationRuntimeSupervisor({
      authorize: async () => {
        throw new Error("Host");
      },
      linux: driver,
    });
    const input = fixture();
    const capture = {
      identity: input.identity,
      definitions: input.definitions,
      target: input.target,
    };
    expect((await supervisor.reconcileLinux([capture])).runtimes).toEqual([
      { found: false, identity: input.identity },
    ]);
    expect(driver.start).not.toHaveBeenCalled();
    expect(driver.stopRecorded).not.toHaveBeenCalled();
    await supervisor.closeAll();
  });

  it("confirms a naturally exited Linux generation under the new Stop operation after its launch reply was lost", async () => {
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
    driver.finish({ outcome: "exited", exitCode: 0, signal: null });
    await vi.waitFor(() =>
      expect(supervisor.status(input.identity, input)).toMatchObject({
        found: true,
        observation: { state: "exited" },
      }),
    );
    const identity = { ...input.identity, operationId: randomUUID() };
    const command = {
      type: "cantrip-os.run-runtime.stop" as const,
      ...input,
      identity,
    };
    await expect(supervisor.stop(command)).rejects.toThrow(
      "could not be confirmed",
    );
    driver.stopRecorded.mockResolvedValue({
      outcome: "exited",
      exitCode: 0,
      signal: null,
    });
    const retryIdentity = { ...identity, operationId: randomUUID() };
    expect(
      await supervisor.stop({ ...command, identity: retryIdentity }),
    ).toMatchObject({
      observation: { ...retryIdentity, state: "idle", exitCode: 0 },
    });
    expect(driver.start).toHaveBeenCalledTimes(1);
    expect(driver.stopRecorded).toHaveBeenCalledTimes(2);
    await supervisor.closeAll();
  });

  it("acknowledges an explicit stop after memory loss only when recorded native cleanup confirms it", async () => {
    const driver = controlledDriver();
    const supervisor = new RunConfigurationRuntimeSupervisor({
      authorize: async () => {
        throw new Error("Host");
      },
      linux: driver,
    });
    const input = fixture();
    const command = {
      type: "cantrip-os.run-runtime.stop" as const,
      identity: input.identity,
      definitions: input.definitions,
      target: input.target,
    };
    await expect(supervisor.stop(command)).rejects.toThrow(
      "could not be confirmed",
    );
    driver.stopRecorded.mockResolvedValue({
      outcome: "interrupted",
      exitCode: 137,
      signal: null,
    });
    expect(await supervisor.stop(command)).toMatchObject({
      outcome: "accepted",
      observation: { ...input.identity, state: "idle", exitCode: 137 },
    });
    expect(driver.start).not.toHaveBeenCalled();
    await supervisor.closeAll();
  });
  it("confirms the journal when stopping a lost runtime whose in-memory handle was cleared", async () => {
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
    driver.signal.mockImplementation(async () => {
      driver.finish({ outcome: "interrupted", exitCode: null, signal: null });
    });
    await supervisor.reconcileLinux([]);
    expect(supervisor.status(input.identity, input)).toMatchObject({
      found: true,
      observation: { state: "lost" },
    });
    const identity = { ...input.identity, operationId: randomUUID() };
    const command = {
      type: "cantrip-os.run-runtime.stop" as const,
      identity,
      definitions: input.definitions,
      target: input.target,
    };
    await expect(supervisor.stop(command)).rejects.toThrow(
      "could not be confirmed",
    );
    expect(supervisor.status(identity, input)).toMatchObject({
      found: true,
      observation: { state: "stopping" },
    });
    driver.stopRecorded.mockResolvedValue({
      outcome: "interrupted",
      exitCode: null,
      signal: null,
    });
    expect(
      (
        await supervisor.stop({
          ...command,
          identity: { ...identity, operationId: randomUUID() },
        })
      ).observation?.state,
    ).toBe("idle");
    expect(driver.stopRecorded).toHaveBeenCalledTimes(2);
    await supervisor.closeAll();
  });
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
