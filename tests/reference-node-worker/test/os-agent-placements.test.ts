import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { cantripOsExecutionSchema } from "@cantrip/protocol";
import { OsAgentPlacements } from "../src/os-executor/agent-placements.js";
import { managedRuntimeTarget } from "../src/codex/managed-runtime-namespaces.js";

it("retains exact OS placement on worker restart and rejects retargeting or another owner", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cantrip-os-agent-placement-"),
  );
  try {
    const identity = {
      serverId: "server",
      ownerId: "owner",
      workerId: "worker",
      chatId: "chat",
    };
    const scope = {
      ownerId: "owner",
      workerId: "worker",
      instanceId: randomUUID(),
      guestInstanceId: randomUUID(),
      attachmentGeneration: randomUUID(),
      runtimeGeneration: randomUUID(),
      bindingId: randomUUID(),
      bindingGeneration: randomUUID(),
      projectId: "project",
      projectSourceId: randomUUID(),
      worktreeId: randomUUID(),
      workspaceId: randomUUID(),
      guestWorkspaceId: "alpha",
      uid: 20000,
      gid: 20000,
      homeGuestPath: "/home/alpha",
      guestPath: "/home/alpha/source",
      dependencyOverlays: [],
      mode: "linux-owned",
      linkedWorkerPath: null,
      sourceKind: "folder",
    };
    const placement = cantripOsExecutionSchema.parse({
      kind: "cantrip-os",
      scope,
      transport: { kind: "docker", container: "fixture" },
    });
    const registry = new OsAgentPlacements(directory);
    expect(registry.resolve(identity)).toBeUndefined();
    expect(registry.resolve(identity, placement)).toEqual(placement);
    expect(new OsAgentPlacements(directory).resolve(identity)).toEqual(
      placement,
    );
    expect(() =>
      registry.resolve(identity, {
        ...placement,
        scope: { ...placement.scope, runtimeGeneration: randomUUID() },
      }),
    ).toThrow(/cannot be retargeted/);
    expect(() =>
      registry.resolve({ ...identity, ownerId: "other" }, placement),
    ).toThrow(/different owner/);
    expect(
      managedRuntimeTarget({
        threadId: "thread",
        session: {
          contextKind: "project",
          chatId: "chat",
          projectId: "project",
          worktreeId: scope.worktreeId,
          rootKind: "folder-root",
          osExecution: placement,
        },
      }),
    ).toEqual({ threadId: "thread", chatId: "chat", osExecution: placement });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
