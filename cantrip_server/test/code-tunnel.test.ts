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
    broker.configureControlPlane(repository, vi.fn());

    try {
      const attachment = await broker.createProtectedAttachment({
        authSessionId: "auth-session-1",
        codeTabId: "code-1",
        ownerId: "user-1",
        projectId: "project-1",
        protectedRecord,
        runtime,
        sessionId: runtime.sessionId,
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
    } finally {
      await broker.close();
    }
  });
});
