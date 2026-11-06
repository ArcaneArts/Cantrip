import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { DockerDeliveryError, type LocalDocker } from "@cantrip/os-host";
import type { CantripOsPowerWorkerCommand } from "@cantrip/protocol";
import { CantripOsPowerManager } from "./power.js";

type Operation = Extract<
  CantripOsPowerWorkerCommand,
  { type: "cantrip-os.power.operation" }
>;
it("observes absent, interrupted and failed admissions without authorizing another mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cantrip-power-journal-"));
  const command: Operation = {
    type: "cantrip-os.power.operation",
    mode: "execute",
    action: "restart",
    operationId: randomUUID(),
    transport: { kind: "docker", container: `unit-${randomUUID()}` },
    powerTarget: {
      kind: "docker",
      containerId: "a".repeat(64),
      generation: randomUUID(),
    },
    scope: {
      ownerId: "owner",
      workerId: "worker",
      serverId: "server",
      instanceId: randomUUID(),
      guestInstanceId: randomUUID(),
      attachmentGeneration: randomUUID(),
      runtimeGeneration: randomUUID(),
    },
  };
  let engineCalls = 0;
  const unavailable = () =>
    new CantripOsPowerManager(directory, "worker", async () => {
      engineCalls++;
      throw new Error("Engine unavailable fixture");
    });
  const observed = { ...command, mode: "observe" as const };
  try {
    expect(await unavailable().handle(observed)).toBeNull();
    expect(engineCalls).toBe(0);
    await expect(
      unavailable().handle({
        ...observed,
        scope: { ...command.scope, workerId: "another" },
      }),
    ).rejects.toThrow("another Worker");
    const admission = {
      action: command.action,
      transport: command.transport,
      powerTarget: command.powerTarget,
    };
    // A private outer admission can survive before any carrier journal exists.
    await unavailable().operations.execute(
      command.scope,
      command.operationId,
      command.type,
      admission,
      async () => {
        throw new DockerDeliveryError("Worker ended before carrier admission");
      },
      { version: 1, admission },
    );
    expect(await unavailable().handle(observed)).toMatchObject({
      state: "unknown",
      receipt: null,
    });
    await expect(
      unavailable().handle({ ...observed, action: "stop" }),
    ).rejects.toThrow("another admission");
    await expect(
      unavailable().handle({
        ...observed,
        scope: { ...command.scope, runtimeGeneration: randomUUID() },
      }),
    ).rejects.toThrow("scope changed");
    // Engine acquisition fails before any host effect. This is a definite failure,
    // whose history must remain failed even when later observation is unavailable.
    const failed = { ...command, operationId: randomUUID() };
    expect(await unavailable().handle(failed)).toMatchObject({
      state: "failed",
      receipt: null,
    });
    expect(
      await unavailable().handle({ ...failed, mode: "observe" }),
    ).toMatchObject({ state: "failed", receipt: null });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("pins the physical target and preserves completed history after carrier loss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cantrip-power-target-"));
  const container = `unit-${randomUUID()}`,
    physicalId = "a".repeat(64);
  const actual = {
    Id: physicalId,
    Name: container,
    State: {
      Running: true,
      Status: "running",
      StartedAt: "before",
      FinishedAt: "never",
    },
  };
  let posts = 0,
    unavailable = false;
  const engine: Pick<LocalDocker, "inspect" | "request"> = {
    inspect: async <T>() => {
      if (unavailable) throw new Error("Engine unavailable");
      return structuredClone(actual) as T;
    },
    request: async <T>(_method: string, path: string) => {
      expect(path).toBe(`/containers/${physicalId}/restart?t=20`);
      posts++;
      actual.State.StartedAt = "after";
      return null as T;
    },
  };
  const command: Operation = {
    type: "cantrip-os.power.operation",
    mode: "execute",
    action: "restart",
    operationId: randomUUID(),
    transport: { kind: "docker", container },
    powerTarget: {
      kind: "docker",
      containerId: physicalId,
      generation: randomUUID(),
    },
    scope: {
      ownerId: "owner",
      workerId: "worker",
      serverId: "server",
      instanceId: randomUUID(),
      guestInstanceId: randomUUID(),
      attachmentGeneration: randomUUID(),
      runtimeGeneration: randomUUID(),
    },
  };
  const manager = () =>
    new CantripOsPowerManager(directory, "worker", async () => engine);
  try {
    actual.Id = "b".repeat(64);
    expect(await manager().handle(command)).toMatchObject({ state: "failed" });
    expect(posts).toBe(0);
    actual.Id = physicalId;
    const successful = { ...command, operationId: randomUUID() };
    expect(await manager().handle(successful)).toMatchObject({
      state: "ready",
    });
    unavailable = true;
    expect(
      await manager().handle({ ...successful, mode: "observe" }),
    ).toMatchObject({
      state: "ready",
      observation: null,
      observationError: expect.any(String),
      receipt: { containerId: physicalId, after: { startedAt: "after" } },
    });
    expect(posts).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
