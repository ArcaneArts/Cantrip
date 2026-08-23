import type { CodeRuntimeStatus } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import { CodeTunnelBroker } from "../src/code/tunnel.js";
import type { ServerRepository } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const runtime: CodeRuntimeStatus = {
  sessionId: "session-1",
  workspaceUri: "file:///worker/state/project.code-workspace",
  status: "running",
  editorBuild: {
    version: "1.109.5-cantrip.1",
    upstreamRevision: "a".repeat(40),
    patchset: 1,
    fingerprint: "b".repeat(64),
  },
  processInstanceId: "process-1",
  bridgeConnected: true,
  dirtyEditors: [],
  workbench: {
    activeEditor: null,
    git: null,
    conflicts: [],
    savePolicy: "always",
    agentStatus: "idle",
  },
  startedAt: "2026-08-08T12:00:00.000Z",
  lastActivityAt: "2026-08-08T12:00:00.000Z",
  lastError: null,
};

describe("protected Cantrip Code attachments", () => {
  it("registers and revokes only an opaque generic tunnel", async () => {
    const tunnelId = "11111111-1111-4111-8111-111111111111";
    const protectedRecord = {
      operationId: tunnelId,
      revision: 1,
      protectedContent: {
        formatVersion: 1 as const,
        domain: "tunnel-content" as const,
        keyRevision: 1,
        envelope: {
          version: 1 as const,
          algorithm: "AES-256-GCM" as const,
          keyRevision: 1,
          nonce: "AAAAAAAAAAAAAAAA",
          ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    };
    const registerManagedTunnel = vi.fn(async () => ({ id: tunnelId }));
    const removeManagedTunnel = vi.fn(async () => true);
    const repository = {
      registerManagedTunnel,
      removeManagedTunnel,
    } as unknown as ServerRepository;
    const worker = {
      isConnected: (workerId: string) => workerId === "worker-1",
      request: vi.fn(async () => null),
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
    } as unknown as WorkerCommandBus;
    const broker = new CodeTunnelBroker(worker);
    const cleanupTunnelResources = vi.fn(async () => undefined);
    broker.configureControlPlane(repository, vi.fn(), cleanupTunnelResources);

    try {
      const attachment = await broker.createProtectedAttachment({
        authSessionId: "auth-session-1",
        codeTabId: "code-1",
        ownerId: "user-1",
        projectId: "project-1",
        protectedRecord,
        runtime,
        sessionId: runtime.sessionId,
        stopSessionOnRelease: true,
        tunnelId,
        workerId: "worker-1",
      });

      expect(attachment).toMatchObject({
        attachmentId: tunnelId,
        sessionId: runtime.sessionId,
        tunnelId,
      });
      expect(registerManagedTunnel).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          source: { kind: "desktop-loopback" },
          destination: {
            kind: "worker-adapter",
            workerId: "worker-1",
            adapter: "code",
            resourceId: tunnelId,
          },
          managedBy: { kind: "code", id: tunnelId },
        }),
        { id: tunnelId, protectedRecord },
      );
      await expect(broker.revokeAttachment(tunnelId, "user-1")).resolves.toBe(
        true,
      );
      expect(removeManagedTunnel).toHaveBeenCalledWith("user-1", {
        kind: "code",
        id: tunnelId,
      });
      expect(cleanupTunnelResources).toHaveBeenCalledWith(
        "user-1",
        tunnelId,
        "Code attachment revoked",
        1008,
      );
      expect(worker.request).toHaveBeenCalledWith(
        "worker-1",
        { type: "code.endpoint.revoke", tunnelId },
        { timeoutMs: 5_000 },
      );
      expect(worker.request).toHaveBeenCalledWith(
        "worker-1",
        { type: "code.stop", sessionId: runtime.sessionId },
        { timeoutMs: 5_000 },
      );
    } finally {
      await broker.close();
    }
  });

  it("retains attachment ownership when managed tunnel cleanup rejects", async () => {
    const tunnelId = "11111111-1111-4111-8111-111111111111";
    const removeManagedTunnel = vi
      .fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(true);
    const repository = {
      registerManagedTunnel: vi.fn(async () => ({ id: tunnelId })),
      removeManagedTunnel,
    } as unknown as ServerRepository;
    const worker = {
      isConnected: () => true,
      request: vi.fn(async () => null),
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
    } as unknown as WorkerCommandBus;
    const broker = new CodeTunnelBroker(worker);
    broker.configureControlPlane(repository, vi.fn(), vi.fn());
    const protectedRecord = {
      operationId: tunnelId,
      revision: 1,
      protectedContent: {
        formatVersion: 1 as const,
        domain: "tunnel-content" as const,
        keyRevision: 1,
        envelope: {
          version: 1 as const,
          algorithm: "AES-256-GCM" as const,
          keyRevision: 1,
          nonce: "AAAAAAAAAAAAAAAA",
          ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    };

    try {
      await broker.createProtectedAttachment({
        codeTabId: "code-1",
        ownerId: "user-1",
        projectId: "project-1",
        protectedRecord,
        runtime,
        sessionId: runtime.sessionId,
        tunnelId,
        workerId: "worker-1",
      });

      await expect(broker.revokeAttachment(tunnelId, "user-1")).rejects.toThrow(
        "database unavailable",
      );
      await expect(broker.revokeAttachment(tunnelId, "user-1")).resolves.toBe(
        true,
      );
      expect(removeManagedTunnel).toHaveBeenCalledTimes(2);
    } finally {
      await broker.close();
    }
  });

  it("deduplicates concurrent attachment cleanup", async () => {
    const tunnelId = "11111111-1111-4111-8111-111111111111";
    let finishRemoval: (() => void) | undefined;
    const removalGate = new Promise<void>((resolve) => {
      finishRemoval = resolve;
    });
    const removeManagedTunnel = vi.fn(async () => {
      await removalGate;
      return true;
    });
    const repository = {
      registerManagedTunnel: vi.fn(async () => ({ id: tunnelId })),
      removeManagedTunnel,
    } as unknown as ServerRepository;
    const worker = {
      isConnected: () => true,
      request: vi.fn(async () => null),
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
    } as unknown as WorkerCommandBus;
    const cleanupTunnelResources = vi.fn(async () => undefined);
    const broker = new CodeTunnelBroker(worker);
    broker.configureControlPlane(repository, vi.fn(), cleanupTunnelResources);
    const protectedRecord = {
      operationId: tunnelId,
      revision: 1,
      protectedContent: {
        formatVersion: 1 as const,
        domain: "tunnel-content" as const,
        keyRevision: 1,
        envelope: {
          version: 1 as const,
          algorithm: "AES-256-GCM" as const,
          keyRevision: 1,
          nonce: "AAAAAAAAAAAAAAAA",
          ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    };

    try {
      await broker.createProtectedAttachment({
        codeTabId: "code-1",
        ownerId: "user-1",
        projectId: "project-1",
        protectedRecord,
        runtime,
        sessionId: runtime.sessionId,
        tunnelId,
        workerId: "worker-1",
      });

      const first = broker.revokeAttachment(tunnelId, "user-1");
      const second = broker.revokeAttachment(tunnelId, "user-1");
      await vi.waitFor(() =>
        expect(removeManagedTunnel).toHaveBeenCalledOnce(),
      );
      finishRemoval?.();

      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
      expect(cleanupTunnelResources).toHaveBeenCalledOnce();
      expect(worker.request).toHaveBeenCalledOnce();
    } finally {
      await broker.close();
    }
  });
});
