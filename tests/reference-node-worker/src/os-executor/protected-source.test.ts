import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  cantripOsProvisionRequestContentSchema,
  workerCommandSchema,
} from "@cantrip/protocol";
import { WorkerRoutingRegistry } from "../routing-registry.js";
import {
  protectWorkerRepositoryOperationContent,
  openWorkerRepositoryOperationContent,
} from "../repository-operation-encryption.js";
import type { WorkerEncryptionService } from "../worker-encryption.js";
import { prepareOsSourceCommand } from "./protected-source.js";

describe("protected OS source admission", () => {
  it("opens an admitted source's still-active original key after rotation without changing ordinary repository key policy", async () => {
    const keys = new Map([
      [1, new Uint8Array(32).fill(13)],
      [2, new Uint8Array(32).fill(29)],
    ]);
    let current = 1;
    const ownerId = "source-history-owner";
    const service = {
      ownerId: () => ownerId,
      componentKey: vi.fn((_component: string, revision?: number) => {
        const keyRevision = revision ?? current,
          key = keys.get(keyRevision);
        if (!key) throw new Error("No active historical key.");
        return { key: key.slice(), keyRevision };
      }),
    } as unknown as WorkerEncryptionService;
    const scope = {
      ownerId,
      workerId: "worker",
      serverId: "server",
      instanceId: randomUUID(),
      guestInstanceId: randomUUID(),
      attachmentGeneration: randomUUID(),
      runtimeGeneration: randomUUID(),
      bindingId: randomUUID(),
      bindingGeneration: randomUUID(),
      projectId: randomUUID(),
      projectSourceId: randomUUID(),
      worktreeId: randomUUID(),
      workspaceId: randomUUID(),
      guestWorkspaceId: "restored",
      uid: 20000,
      gid: 20000,
      homeGuestPath: "/home/restored",
      guestPath: "/home/restored/repo",
      sourceKind: "git" as const,
      mode: "linux-owned" as const,
      linkedWorkerPath: null,
      dependencyOverlays: [],
    };
    const operationId = randomUUID();
    const context = {
      serverId: scope.serverId,
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      operationId,
      direction: "request" as const,
    };
    const content = {
      type: "cantrip-os.source.provision" as const,
      instanceId: scope.instanceId,
      workspaceId: scope.workspaceId,
      bindingId: scope.bindingId,
      bindingGeneration: scope.bindingGeneration,
      intent: {
        mode: "linux-owned" as const,
        source: { kind: "existing" as const, sourceKind: "git" as const },
      },
    };
    try {
      const protectedRequest = await protectWorkerRepositoryOperationContent({
        context,
        content,
        schema: cantripOsProvisionRequestContentSchema,
        service,
      });
      current = 2;
      const command = workerCommandSchema.parse({
        type: "cantrip-os.source.provision",
        scope,
        transport: { kind: "docker", container: "fixture" },
        operationId,
        protectedRequest,
      });
      if (command.type !== "cantrip-os.source.provision")
        throw new Error("Wrong command.");
      const routing = { resolveToken: vi.fn(async (value: string) => value) };
      expect(
        (await prepareOsSourceCommand(command, service, routing)).intent,
      ).toEqual(content.intent);
      expect(routing.resolveToken).not.toHaveBeenCalled();
      await expect(
        openWorkerRepositoryOperationContent({
          context,
          opaque: protectedRequest,
          schema: cantripOsProvisionRequestContentSchema,
          service,
        }),
      ).rejects.toThrow("stale key");
      keys.delete(1);
      await expect(
        prepareOsSourceCommand(command, service, routing),
      ).rejects.toThrow("No active historical key");
    } finally {
      for (const key of keys.values()) key.fill(0);
    }
  });
  it("keeps clone URLs opaque and binds plaintext to the admitted owner, operation and workspace", async () => {
    const ownerId = "owner-os-protected",
      key = new Uint8Array(32).fill(91);
    const service = {
      ownerId: () => ownerId,
      componentKey: () => ({ key: key.slice(), keyRevision: 1 }),
    } as unknown as WorkerEncryptionService;
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-os-protection-"),
    );
    const routing = new WorkerRoutingRegistry(directory);
    try {
      const scope = {
        ownerId,
        workerId: "worker",
        serverId: "server",
        instanceId: randomUUID(),
        guestInstanceId: randomUUID(),
        attachmentGeneration: randomUUID(),
        runtimeGeneration: randomUUID(),
        bindingId: randomUUID(),
        bindingGeneration: randomUUID(),
        projectId: randomUUID(),
        projectSourceId: randomUUID(),
        worktreeId: randomUUID(),
        workspaceId: randomUUID(),
        guestWorkspaceId: "protected",
        uid: 20000,
        gid: 20000,
        homeGuestPath: "/var/lib/workspaces/protected",
        guestPath: "/var/lib/workspaces/protected/source",
        sourceKind: "git" as const,
        dependencyOverlays: [],
        mode: "linux-owned" as const,
        linkedWorkerPath: null,
      };
      const operationId = randomUUID(),
        repositoryUrl = "https://repository.invalid/private-project.git";
      const protectedRequest = await protectWorkerRepositoryOperationContent({
        service,
        context: {
          serverId: scope.serverId,
          projectId: scope.projectId,
          worktreeId: scope.worktreeId,
          operationId,
          direction: "request",
        },
        schema: cantripOsProvisionRequestContentSchema,
        content: {
          type: "cantrip-os.source.provision",
          instanceId: scope.instanceId,
          workspaceId: scope.workspaceId,
          bindingId: scope.bindingId,
          bindingGeneration: scope.bindingGeneration,
          intent: {
            mode: "linux-owned",
            source: { kind: "git", repositoryUrl, revision: "a".repeat(40) },
          },
        },
      });
      const command = workerCommandSchema.parse({
        type: "cantrip-os.source.provision",
        scope,
        transport: { kind: "docker", container: "own-os" },
        operationId,
        protectedRequest,
      });
      if (command.type !== "cantrip-os.source.provision")
        throw new Error("Wrong test command");
      expect(JSON.stringify(command)).not.toContain(repositoryUrl);
      expect(
        (await prepareOsSourceCommand(command, service, routing)).intent,
      ).toMatchObject({ source: { repositoryUrl } });
      await expect(
        prepareOsSourceCommand(
          { ...command, operationId: randomUUID() },
          service,
          routing,
        ),
      ).rejects.toThrow(/authenticated/);
      await expect(
        prepareOsSourceCommand(
          { ...command, scope: { ...scope, workspaceId: randomUUID() } },
          service,
          routing,
        ),
      ).rejects.toThrow(/placement/);
      await expect(
        prepareOsSourceCommand(
          { ...command, scope: { ...scope, ownerId: "other" } },
          service,
          routing,
        ),
      ).rejects.toThrow(/owner/);
    } finally {
      key.fill(0);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
