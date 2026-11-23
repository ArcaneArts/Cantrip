import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { TaskInputExecutions } from "./task-input-executions.js";

function fixture() {
  const scope = { serverId: "server", ownerId: "owner", workerId: "worker" };
  const receipt = {
    operationId: randomUUID(),
    chatId: "chat",
    clientMessageId: "message",
    workerId: scope.workerId,
    worktreeId: "tree",
    executionLaneId: "lane",
    executionLaneActivatedAt: new Date().toISOString(),
    providerId: "provider",
    modelRouteId: "route",
    providerAccountId: null,
    dispatch: {
      operationId: randomUUID(),
      cycleId: randomUUID(),
      leaseOwner: "lease",
      fencingToken: 1,
    },
  };
  const native = { threadId: "thread", turnId: "turn", scopeId: "scope" };
  const target = {
    revision: 1,
    workerId: "worker",
    projectId: "project",
    worktreeId: "tree",
    threadId: native.threadId,
    modelRouteId: "route",
    providerAccountId: null,
    cycleId: receipt.dispatch.cycleId,
  };
  const evidence = {
    storageId: randomUUID(),
    runtimeVersion: "0.166.0",
    runtimeFingerprint: null,
    suspension: {
      threadId: native.threadId,
      turnId: native.turnId,
      checkpointId: "checkpoint",
      revision: 1,
    },
  };
  const registry = new TaskInputExecutions(vi.fn());
  const workerGeneration = randomUUID(),
    runtimeGeneration = randomUUID();
  return {
    scope,
    receipt,
    native,
    target,
    evidence,
    registry,
    workerGeneration,
    runtimeGeneration,
  };
}

describe("Task suspension physical ownership", () => {
  it("selects only the restored Goal cycle and rejects two physical owners", async () => {
    const f = fixture();
    const sourceKey = "c".repeat(64);
    const receipt = { ...f.receipt, kind: "goal" as const };
    const foreign = { ...receipt, operationId: randomUUID() };
    const capture = vi.fn(async () => f.evidence),
      foreignCapture = vi.fn(async () => f.evidence);
    const target = {
      ...f.target,
      taskGoalCycle: {
        cycleId: receipt.dispatch.cycleId,
        sourceKey,
        operationId: "original-native-goal-operation",
        goalEpoch: "original-goal-epoch",
        scopeId: f.native.scopeId,
      },
    };
    expect(
      await f.registry.pauseState(
        "chat",
        f.scope,
        target,
        f.native,
        true,
        f.workerGeneration,
        true,
      ),
    ).toBeNull();
    f.registry.begin(
      receipt,
      f.scope,
      undefined,
      capture,
      undefined,
      sourceKey,
    );
    f.registry.bind(receipt, f.scope, f.native, f.runtimeGeneration);
    f.registry.begin(
      foreign,
      f.scope,
      undefined,
      foreignCapture,
      undefined,
      "d".repeat(64),
    );
    f.registry.bind(foreign, f.scope, f.native, f.runtimeGeneration);
    expect(
      (
        await f.registry.pauseState(
          "chat",
          f.scope,
          target,
          f.native,
          true,
          f.workerGeneration,
        )
      ).actor.operationId,
    ).toBe(receipt.operationId);
    expect(capture).toHaveBeenCalledOnce();
    expect(foreignCapture).not.toHaveBeenCalled();
    const duplicate = { ...receipt, operationId: randomUUID() };
    f.registry.begin(
      duplicate,
      f.scope,
      undefined,
      capture,
      undefined,
      sourceKey,
    );
    f.registry.bind(duplicate, f.scope, f.native, f.runtimeGeneration);
    await expect(
      f.registry.pauseState(
        "chat",
        f.scope,
        target,
        f.native,
        true,
        f.workerGeneration,
        true,
      ),
    ).rejects.toThrow("no unique canonical native owner");
    expect(capture).toHaveBeenCalledOnce();
  });

  it("requires the acknowledged native binding and captures only that canonical Task", async () => {
    const f = fixture();
    const capture = vi.fn(async () => f.evidence);
    f.registry.begin(f.receipt, f.scope, undefined, capture);
    const pause = () =>
      f.registry.pauseState(
        "chat",
        f.scope,
        f.target,
        f.native,
        true,
        f.workerGeneration,
      );
    await expect(pause()).rejects.toThrow("no unique canonical native owner");
    expect(capture).not.toHaveBeenCalled();
    expect(() =>
      f.registry.bind(
        f.receipt,
        { ...f.scope, ownerId: "foreign" },
        f.native,
        f.runtimeGeneration,
      ),
    ).toThrow("no longer has its physical owner");
    f.registry.bind(f.receipt, f.scope, f.native, f.runtimeGeneration);
    await expect(
      f.registry.pauseState(
        "chat",
        f.scope,
        { ...f.target, cycleId: randomUUID() },
        f.native,
        true,
        f.workerGeneration,
      ),
    ).rejects.toThrow("no unique canonical native owner");
    expect(await pause()).toEqual({
      checkpoint: f.evidence,
      actor: {
        workerGeneration: f.workerGeneration,
        runtimeGeneration: f.runtimeGeneration,
        operationId: f.receipt.operationId,
        operationGeneration: f.receipt.operationId,
      },
    });
    expect(capture).toHaveBeenCalledExactlyOnceWith(f.native);
    expect(
      (
        await f.registry.pauseState(
          "chat",
          f.scope,
          f.target,
          f.native,
          false,
          f.workerGeneration,
        )
      ).checkpoint,
    ).toBeNull();
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge a checkpoint after its physical execution settled", async () => {
    const f = fixture();
    let committed!: () => void;
    const commit = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const execution = f.registry.begin(
      f.receipt,
      f.scope,
      undefined,
      async () => {
        await commit;
        return f.evidence;
      },
    );
    f.registry.bind(f.receipt, f.scope, f.native, f.runtimeGeneration);
    const paused = f.registry.pauseState(
      "chat",
      f.scope,
      f.target,
      f.native,
      true,
      f.workerGeneration,
    );
    execution.settled();
    committed();
    await expect(paused).rejects.toThrow("execution changed");
  });

  it("propagates actual checkpoint failure while keeping its live owner controllable", async () => {
    const f = fixture();
    f.registry.begin(f.receipt, f.scope, undefined, async () => {
      throw new Error("actual disk write failed");
    });
    f.registry.bind(f.receipt, f.scope, f.native, f.runtimeGeneration);
    await expect(
      f.registry.pauseState(
        "chat",
        f.scope,
        f.target,
        f.native,
        true,
        f.workerGeneration,
      ),
    ).rejects.toThrow("actual disk write failed");
    expect(
      (
        await f.registry.pauseState(
          "chat",
          f.scope,
          f.target,
          f.native,
          false,
          f.workerGeneration,
        )
      ).checkpoint,
    ).toBeNull();
  });
});
