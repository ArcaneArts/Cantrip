import type { CodeRuntimeStatus, WorkerCommand } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  CodeTunnelBroker,
  ExplorerCodeAttachmentLeaseError,
} from "../src/code/tunnel.js";
import type { ServerRepository } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const sessionIncarnationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runtime: CodeRuntimeStatus = {
  sessionId: "session-1",
  sessionIncarnationId,
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

function workerCommandResult(command: WorkerCommand): unknown {
  if (command.type !== "code.stop") return null;
  return {
    ...runtime,
    bridgeConnected: false,
    processInstanceId: null,
    sessionId: command.sessionId,
    sessionIncarnationId: null,
    status: "stopped",
  } satisfies CodeRuntimeStatus;
}

function protectedRecord(tunnelId: string) {
  return {
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
}

describe("protected Cantrip Code attachments", () => {
  it("keeps an attachment through reconnecting and removes it only when the worker is offline", async () => {
    const tunnelId = "11111111-1111-4111-8111-111111111111";
    let reconnecting: (() => void) | null = null;
    let offline: (() => void) | null = null;
    const removeManagedTunnel = vi.fn(async () => true);
    const repository = {
      registerManagedTunnel: vi.fn(async () => ({ id: tunnelId })),
      removeManagedTunnel,
    } as unknown as ServerRepository;
    const worker = {
      isConnected: () => true,
      request: vi.fn(async (_workerId, command: WorkerCommand) =>
        workerCommandResult(command),
      ),
      subscribeWorkerDisconnect: (_workerId: string, listener: () => void) => {
        reconnecting = listener;
        return () => undefined;
      },
      subscribeWorkerOffline: (_workerId: string, listener: () => void) => {
        offline = listener;
        return () => undefined;
      },
    } as unknown as WorkerCommandBus;
    const broker = new CodeTunnelBroker(worker);
    broker.configureControlPlane(repository, vi.fn(), vi.fn());

    try {
      await broker.createProtectedAttachment({
        authSessionId: "auth-session-1",
        codeTabId: "code-1",
        ownerId: "user-1",
        projectId: "project-1",
        protectedRecord: protectedRecord(tunnelId),
        runtime,
        sessionId: runtime.sessionId,
        stopSessionOnRelease: true,
        tunnelId,
        workerId: "worker-1",
      });

      expect(reconnecting).toBeNull();
      expect(offline).not.toBeNull();
      await Promise.resolve();
      expect(removeManagedTunnel).not.toHaveBeenCalled();
      expect(broker.recordTunnelActivity(tunnelId)).not.toBeNull();

      offline!();
      await vi.waitFor(() =>
        expect(removeManagedTunnel).toHaveBeenCalledOnce(),
      );
      expect(broker.recordTunnelActivity(tunnelId)).toBeNull();
    } finally {
      await broker.close();
    }
  });

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
      request: vi.fn(async (_workerId, command: WorkerCommand) =>
        workerCommandResult(command),
      ),
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
        projectId: null,
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
          projectId: null,
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
        {
          type: "code.stop",
          sessionId: runtime.sessionId,
          expectedSessionIncarnationId: sessionIncarnationId,
        },
        { timeoutMs: 5_000 },
      );
    } finally {
      await broker.close();
    }
  });

  it("revokes a legacy attachment without issuing an unfenced automatic stop", async () => {
    const tunnelId = "11111111-1111-4111-8111-111111111111";
    const { sessionIncarnationId: _ignored, ...legacyRuntime } = runtime;
    const request = vi.fn(async (_workerId, command: WorkerCommand) =>
      workerCommandResult(command),
    );
    const broker = new CodeTunnelBroker({
      isConnected: () => true,
      request,
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
    } as unknown as WorkerCommandBus);
    broker.configureControlPlane(
      {
        registerManagedTunnel: vi.fn(async () => ({ id: tunnelId })),
        removeManagedTunnel: vi.fn(async () => true),
      } as unknown as ServerRepository,
      vi.fn(),
      vi.fn(),
    );

    try {
      await broker.createProtectedAttachment({
        codeTabId: "code-1",
        ownerId: "user-1",
        projectId: "project-1",
        protectedRecord: protectedRecord(tunnelId),
        runtime: legacyRuntime,
        sessionId: legacyRuntime.sessionId,
        stopSessionOnRelease: true,
        tunnelId,
        workerId: "worker-1",
      });
      await expect(broker.revokeAttachment(tunnelId, "user-1")).resolves.toBe(
        true,
      );
      expect(request).toHaveBeenCalledWith(
        "worker-1",
        { type: "code.endpoint.revoke", tunnelId },
        { timeoutMs: 5_000 },
      );
      expect(
        request.mock.calls.filter(
          ([, command]) => command.type === "code.stop",
        ),
      ).toHaveLength(0);
    } finally {
      await broker.close();
    }
  });

  it("stops an ephemeral session only after its final attachment lease is released", async () => {
    const firstTunnelId = "11111111-1111-4111-8111-111111111111";
    const secondTunnelId = "22222222-2222-4222-8222-222222222222";
    const replacementTunnelId = "33333333-3333-4333-8333-333333333333";
    const removeManagedTunnel = vi.fn(async () => true);
    const repository = {
      registerManagedTunnel: vi.fn(async (_ownerId, _input, identity) => ({
        id: identity.id,
      })),
      removeManagedTunnel,
    } as unknown as ServerRepository;
    let finishStop!: () => void;
    const stopFinished = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    let holdStop = false;
    const request = vi.fn(async (_workerId, command) => {
      if (command.type === "code.stop" && holdStop) await stopFinished;
      return workerCommandResult(command);
    });
    const worker = {
      isConnected: () => true,
      request,
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
    } as unknown as WorkerCommandBus;
    const broker = new CodeTunnelBroker(worker);
    broker.configureControlPlane(repository, vi.fn(), vi.fn());
    const stopRequests = () =>
      request.mock.calls.filter(([, command]) => command.type === "code.stop");
    let pendingSecondLease: ReturnType<typeof broker.acquireRegistrationLease> =
      null;

    try {
      const firstLease = broker.acquireRegistrationLease({
        authSessionId: "auth-session-1",
        ownerId: "user-1",
        sessionId: runtime.sessionId,
        tunnelId: firstTunnelId,
      })!;
      await broker.createProtectedAttachment({
        authSessionId: "auth-session-1",
        codeTabId: "code-1",
        ownerId: "user-1",
        projectId: "project-1",
        protectedRecord: protectedRecord(firstTunnelId),
        registrationLease: firstLease,
        runtime,
        sessionId: runtime.sessionId,
        stopSessionOnRelease: true,
        tunnelId: firstTunnelId,
        workerId: "worker-1",
      });
      broker.releaseRegistrationLease(firstLease);

      const secondLease = broker.acquireRegistrationLease({
        authSessionId: "auth-session-1",
        ownerId: "user-1",
        sessionId: runtime.sessionId,
        tunnelId: secondTunnelId,
      })!;
      pendingSecondLease = secondLease;
      const firstRevocation = broker.revokeAttachment(firstTunnelId, "user-1");
      await vi.waitFor(() =>
        expect(removeManagedTunnel).toHaveBeenCalledWith("user-1", {
          kind: "code",
          id: firstTunnelId,
        }),
      );
      expect(stopRequests()).toHaveLength(0);

      await broker.createProtectedAttachment({
        authSessionId: "auth-session-1",
        codeTabId: "code-1",
        ownerId: "user-1",
        projectId: "project-1",
        protectedRecord: protectedRecord(secondTunnelId),
        registrationLease: secondLease,
        runtime,
        sessionId: runtime.sessionId,
        stopSessionOnRelease: true,
        tunnelId: secondTunnelId,
        workerId: "worker-1",
      });
      broker.releaseRegistrationLease(secondLease);
      pendingSecondLease = null;
      await expect(firstRevocation).resolves.toBe(true);
      expect(stopRequests()).toHaveLength(0);

      holdStop = true;
      const finalRevocation = broker.revokeAttachment(secondTunnelId, "user-1");
      await vi.waitFor(() => expect(stopRequests()).toHaveLength(1));
      const duringStop = broker.acquireRegistrationLease({
        authSessionId: "auth-session-1",
        ownerId: "user-1",
        sessionId: runtime.sessionId,
        tunnelId: replacementTunnelId,
      });
      if (duringStop) broker.releaseRegistrationLease(duringStop);
      expect(duringStop).toBeNull();

      finishStop();
      await expect(finalRevocation).resolves.toBe(true);
      expect(stopRequests()).toEqual([
        [
          "worker-1",
          {
            type: "code.stop",
            sessionId: runtime.sessionId,
            expectedSessionIncarnationId: sessionIncarnationId,
          },
          { timeoutMs: 5_000 },
        ],
      ]);

      const replacementLease = broker.acquireRegistrationLease({
        authSessionId: "auth-session-1",
        ownerId: "user-1",
        sessionId: runtime.sessionId,
        tunnelId: replacementTunnelId,
      });
      expect(replacementLease).not.toBeNull();
      if (replacementLease) broker.releaseRegistrationLease(replacementLease);
    } finally {
      if (pendingSecondLease) {
        broker.releaseRegistrationLease(pendingSecondLease);
      }
      finishStop();
      await broker.close();
    }
  });

  it("consumes and fences an aborted registration before conditionally stopping its session", async () => {
    const tunnelId = "44444444-4444-4444-8444-444444444444";
    let finishStop!: () => void;
    const stopFinished = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const request = vi.fn(async (_workerId, command) => {
      if (command.type === "code.stop") await stopFinished;
      return workerCommandResult(command);
    });
    const broker = new CodeTunnelBroker({
      isConnected: () => true,
      request,
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
    } as unknown as WorkerCommandBus);
    const lease = broker.acquireRegistrationLease({
      authSessionId: "auth-session-1",
      ownerId: "user-1",
      sessionId: runtime.sessionId,
      tunnelId,
    })!;

    try {
      const abort = broker.abortRegistrationSession({
        lease,
        runtime,
        workerId: "worker-1",
      });
      expect(broker.registrationLeaseIsActive(lease)).toBe(false);
      expect(
        broker.acquireRegistrationLease({
          authSessionId: "auth-session-1",
          ownerId: "user-1",
          sessionId: runtime.sessionId,
          tunnelId: "55555555-5555-4555-8555-555555555555",
        }),
      ).toBeNull();
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          "worker-1",
          {
            type: "code.stop",
            sessionId: runtime.sessionId,
            expectedSessionIncarnationId: sessionIncarnationId,
          },
          { timeoutMs: 5_000 },
        ),
      );

      finishStop();
      await expect(abort).resolves.toBe(true);
      const replacement = broker.acquireRegistrationLease({
        authSessionId: "auth-session-1",
        ownerId: "user-1",
        sessionId: runtime.sessionId,
        tunnelId: "55555555-5555-4555-8555-555555555555",
      });
      expect(replacement).not.toBeNull();
      if (replacement) broker.releaseRegistrationLease(replacement);
    } finally {
      finishStop();
      broker.releaseRegistrationLease(lease);
      await broker.close();
    }
  });

  it("invalidates an exact held registration lease when its binding starts removal", async () => {
    const tunnelId = "44444444-4444-4444-8444-444444444444";
    let connected = true;
    let terminalOffline!: () => void;
    const broker = new CodeTunnelBroker({
      isConnected: () => connected,
      request: vi.fn(async (_workerId, command: WorkerCommand) =>
        workerCommandResult(command),
      ),
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
      subscribeWorkerOffline: (_workerId, listener) => {
        terminalOffline = listener;
        return () => undefined;
      },
    } as unknown as WorkerCommandBus);
    broker.configureControlPlane(
      {
        registerManagedTunnel: vi.fn(async () => ({ id: tunnelId })),
        removeManagedTunnel: vi.fn(async () => true),
      } as unknown as ServerRepository,
      vi.fn(),
      vi.fn(),
    );
    const lease = broker.acquireRegistrationLease({
      authSessionId: "auth-session-1",
      explorerId: "explorer-1",
      ownerId: "user-1",
      sessionId: runtime.sessionId,
      tunnelId,
    })!;

    try {
      await broker.createProtectedAttachment({
        authSessionId: "auth-session-1",
        codeTabId: "explorer:explorer-1:session-1",
        ownerId: "user-1",
        projectId: "project-1",
        protectedRecord: protectedRecord(tunnelId),
        registrationLease: lease,
        runtime,
        sessionId: runtime.sessionId,
        stopSessionOnRelease: true,
        tunnelId,
        workerId: "worker-1",
      });
      expect(broker.registrationLeaseIsActive(lease)).toBe(true);

      connected = false;
      terminalOffline();
      expect(broker.registrationLeaseIsActive(lease)).toBe(false);
      await vi.waitFor(() =>
        expect(broker.recordTunnelActivity(tunnelId)).toBeNull(),
      );
    } finally {
      broker.releaseRegistrationLease(lease);
      await broker.close();
    }
  });

  it("keeps an aborted registration from stopping an active sibling session", async () => {
    const firstTunnelId = "44444444-4444-4444-8444-444444444444";
    const secondTunnelId = "55555555-5555-4555-8555-555555555555";
    const repository = {
      registerManagedTunnel: vi.fn(async (_ownerId, _input, identity) => ({
        id: identity.id,
      })),
      removeManagedTunnel: vi.fn(async () => true),
    } as unknown as ServerRepository;
    const request = vi.fn(async (_workerId, command: WorkerCommand) =>
      workerCommandResult(command),
    );
    const broker = new CodeTunnelBroker({
      isConnected: () => true,
      request,
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
    } as unknown as WorkerCommandBus);
    broker.configureControlPlane(repository, vi.fn(), vi.fn());
    const firstLease = broker.acquireRegistrationLease({
      authSessionId: "auth-session-1",
      ownerId: "user-1",
      sessionId: runtime.sessionId,
      tunnelId: firstTunnelId,
    })!;
    const siblingLease = broker.acquireRegistrationLease({
      authSessionId: "auth-session-1",
      ownerId: "user-1",
      sessionId: runtime.sessionId,
      tunnelId: secondTunnelId,
    })!;

    try {
      const abort = broker.abortRegistrationSession({
        lease: firstLease,
        runtime,
        workerId: "worker-1",
      });
      await broker.createProtectedAttachment({
        authSessionId: "auth-session-1",
        codeTabId: "explorer:explorer-1:session-1",
        ownerId: "user-1",
        projectId: "project-1",
        protectedRecord: protectedRecord(secondTunnelId),
        registrationLease: siblingLease,
        runtime,
        sessionId: runtime.sessionId,
        stopSessionOnRelease: true,
        tunnelId: secondTunnelId,
        workerId: "worker-1",
      });
      broker.releaseRegistrationLease(siblingLease);

      await expect(abort).resolves.toBe(true);
      expect(
        request.mock.calls.filter(
          ([, command]) => command.type === "code.stop",
        ),
      ).toHaveLength(0);
    } finally {
      broker.releaseRegistrationLease(firstLease);
      broker.releaseRegistrationLease(siblingLease);
      await broker.close();
    }
  });

  it("deduplicates simultaneous aborted registrations without deadlocking", async () => {
    const request = vi.fn(async (_workerId, command: WorkerCommand) =>
      workerCommandResult(command),
    );
    const broker = new CodeTunnelBroker({
      isConnected: () => true,
      request,
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
    } as unknown as WorkerCommandBus);
    const leases = [
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
    ].map((tunnelId) =>
      broker.acquireRegistrationLease({
        authSessionId: "auth-session-1",
        ownerId: "user-1",
        sessionId: runtime.sessionId,
        tunnelId,
      })!,
    );

    try {
      const aborts = leases.map((lease) =>
        broker.abortRegistrationSession({
          lease,
          runtime,
          workerId: "worker-1",
        }),
      );
      expect(
        leases.every((lease) => !broker.registrationLeaseIsActive(lease)),
      ).toBe(true);
      await expect(Promise.all(aborts)).resolves.toEqual([true, true]);
      expect(
        request.mock.calls.filter(
          ([, command]) => command.type === "code.stop",
        ),
      ).toEqual([
        [
          "worker-1",
          {
            type: "code.stop",
            sessionId: runtime.sessionId,
            expectedSessionIncarnationId: sessionIncarnationId,
          },
          { timeoutMs: 5_000 },
        ],
      ]);
    } finally {
      for (const lease of leases) broker.releaseRegistrationLease(lease);
      await broker.close();
    }
  });

  it.each([
    ["missing", null],
    ["mismatched", { ...runtime, sessionId: "other-session" }],
    [
      "legacy",
      (({ sessionIncarnationId: _ignored, ...legacyRuntime }) => legacyRuntime)(
        runtime,
      ),
    ],
  ] as const)(
    "consumes an aborted registration but skips an unproven %s runtime stop",
    async (_kind, abortRuntime) => {
      const request = vi.fn(async (_workerId, command: WorkerCommand) =>
        workerCommandResult(command),
      );
      const broker = new CodeTunnelBroker({
        isConnected: () => true,
        request,
        subscribeWorkerDisconnect: vi.fn(() => () => undefined),
      } as unknown as WorkerCommandBus);
      const lease = broker.acquireRegistrationLease({
        authSessionId: "auth-session-1",
        ownerId: "user-1",
        sessionId: runtime.sessionId,
        tunnelId: "44444444-4444-4444-8444-444444444444",
      })!;

      try {
        await expect(
          broker.abortRegistrationSession({
            lease,
            runtime: abortRuntime,
            workerId: "worker-1",
          }),
        ).resolves.toBe(true);
        expect(broker.registrationLeaseIsActive(lease)).toBe(false);
        expect(request).not.toHaveBeenCalled();
      } finally {
        broker.releaseRegistrationLease(lease);
        await broker.close();
      }
    },
  );

  it("rejects a mismatched live runtime before registering a protected tunnel", async () => {
    const registerManagedTunnel = vi.fn(async () => ({
      id: "44444444-4444-4444-8444-444444444444",
    }));
    const broker = new CodeTunnelBroker({
      isConnected: () => true,
      request: vi.fn(async (_workerId, command: WorkerCommand) =>
        workerCommandResult(command),
      ),
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
    } as unknown as WorkerCommandBus);
    broker.configureControlPlane(
      {
        registerManagedTunnel,
        removeManagedTunnel: vi.fn(async () => true),
      } as unknown as ServerRepository,
      vi.fn(),
      vi.fn(),
    );

    try {
      await expect(
        broker.createProtectedAttachment({
          codeTabId: "code-1",
          ownerId: "user-1",
          projectId: "project-1",
          protectedRecord: protectedRecord(
            "44444444-4444-4444-8444-444444444444",
          ),
          runtime,
          sessionId: "other-session",
          tunnelId: "44444444-4444-4444-8444-444444444444",
          workerId: "worker-1",
        }),
      ).rejects.toThrow("runtime does not match");
      expect(registerManagedTunnel).not.toHaveBeenCalled();
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
      request: vi.fn(async (_workerId, command: WorkerCommand) =>
        workerCommandResult(command),
      ),
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

      const cleanupError = await broker
        .revokeAttachment(tunnelId, "user-1")
        .catch((error: unknown) => error);
      expect(cleanupError).toBeInstanceOf(AggregateError);
      expect(
        (cleanupError as AggregateError).errors.some(
          (error) =>
            error instanceof Error && error.message === "database unavailable",
        ),
      ).toBe(true);
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
      request: vi.fn(async (_workerId, command: WorkerCommand) =>
        workerCommandResult(command),
      ),
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

  it("revokes every Explorer-owned attachment and session before a mutation completes", async () => {
    const tunnelIds = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];
    const sessionIds = ["explorer-session-a", "explorer-session-b"];
    const repository = {
      registerManagedTunnel: vi.fn(async (_ownerId, _input, identity) => ({
        id: identity.id,
      })),
      removeManagedTunnel: vi.fn(async () => true),
    } as unknown as ServerRepository;
    const worker = {
      isConnected: () => true,
      request: vi.fn(async (_workerId, command: WorkerCommand) =>
        workerCommandResult(command),
      ),
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
    } as unknown as WorkerCommandBus;
    const cleanupTunnelResources = vi.fn(async () => undefined);
    const broker = new CodeTunnelBroker(worker);
    broker.configureControlPlane(repository, vi.fn(), cleanupTunnelResources);

    try {
      for (const [index, tunnelId] of tunnelIds.entries()) {
        const lease = broker.acquireRegistrationLease({
          authSessionId: null,
          explorerId: "explorer-1",
          ownerId: "user-1",
          sessionId: sessionIds[index]!,
          tunnelId,
        })!;
        try {
          await broker.createProtectedAttachment({
            codeTabId: `explorer:explorer-1:${sessionIds[index]}`,
            registrationLease: lease,
            ownerId: "user-1",
            projectId: "project-1",
            protectedRecord: protectedRecord(tunnelId),
            runtime: { ...runtime, sessionId: sessionIds[index]! },
            sessionId: sessionIds[index]!,
            stopSessionOnRelease: true,
            tunnelId,
            workerId: "worker-1",
          });
        } finally {
          broker.releaseRegistrationLease(lease);
        }
      }

      await expect(
        broker.mutateExplorer(
          "user-1",
          "explorer-1",
          async () => "retargeted",
          () => true,
        ),
      ).resolves.toBe("retargeted");
      expect(repository.removeManagedTunnel).toHaveBeenCalledTimes(2);
      expect(cleanupTunnelResources.mock.calls).toEqual(
        tunnelIds.map((tunnelId) => [
          "user-1",
          tunnelId,
          "Code attachment revoked",
          1008,
        ]),
      );
      expect(worker.request).toHaveBeenCalledWith(
        "worker-1",
        { type: "code.endpoint.revoke", tunnelId: tunnelIds[0] },
        { timeoutMs: 5_000 },
      );
      expect(worker.request).toHaveBeenCalledWith(
        "worker-1",
        { type: "code.endpoint.revoke", tunnelId: tunnelIds[1] },
        { timeoutMs: 5_000 },
      );
      expect(worker.request).toHaveBeenCalledWith(
        "worker-1",
        {
          type: "code.stop",
          sessionId: sessionIds[0],
          expectedSessionIncarnationId: sessionIncarnationId,
        },
        { timeoutMs: 5_000 },
      );
      expect(worker.request).toHaveBeenCalledWith(
        "worker-1",
        {
          type: "code.stop",
          sessionId: sessionIds[1],
          expectedSessionIncarnationId: sessionIncarnationId,
        },
        { timeoutMs: 5_000 },
      );

      await broker.mutateExplorer(
        "user-1",
        "explorer-1",
        async () => "deleted",
        () => true,
      );
      expect(repository.removeManagedTunnel).toHaveBeenCalledTimes(2);
      expect(cleanupTunnelResources).toHaveBeenCalledTimes(2);
    } finally {
      await broker.close();
    }
  });

  it("rejects a stale Explorer lease before tunnel registration", async () => {
    const tunnelId = "11111111-1111-4111-8111-111111111111";
    const registerManagedTunnel = vi.fn(async () => ({ id: tunnelId }));
    const repository = {
      registerManagedTunnel,
      removeManagedTunnel: vi.fn(async () => true),
    } as unknown as ServerRepository;
    const worker = {
      isConnected: () => true,
      request: vi.fn(async (_workerId, command: WorkerCommand) =>
        workerCommandResult(command),
      ),
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
    } as unknown as WorkerCommandBus;
    const broker = new CodeTunnelBroker(worker);
    broker.configureControlPlane(repository, vi.fn(), vi.fn());
    const lease = broker.acquireRegistrationLease({
      authSessionId: null,
      explorerId: "explorer-1",
      ownerId: "user-1",
      sessionId: runtime.sessionId,
      tunnelId,
    })!;

    try {
      const mutation = broker.mutateExplorer(
        "user-1",
        "explorer-1",
        async () => true,
        (result) => result,
      );
      await expect(
        broker.createProtectedAttachment({
          codeTabId: "explorer:explorer-1:session-1",
          registrationLease: lease,
          ownerId: "user-1",
          projectId: "project-1",
          protectedRecord: protectedRecord(tunnelId),
          runtime,
          sessionId: runtime.sessionId,
          stopSessionOnRelease: true,
          tunnelId,
          workerId: "worker-1",
        }),
      ).rejects.toBeInstanceOf(ExplorerCodeAttachmentLeaseError);
      expect(registerManagedTunnel).not.toHaveBeenCalled();
      broker.releaseRegistrationLease(lease);
      await expect(mutation).resolves.toBe(true);
    } finally {
      broker.releaseRegistrationLease(lease);
      await broker.close();
    }
  });

  it("invalidates a released Explorer lease while another lease remains active", async () => {
    const tunnelId = "11111111-1111-4111-8111-111111111111";
    const registerManagedTunnel = vi.fn(async () => ({ id: tunnelId }));
    const repository = {
      registerManagedTunnel,
      removeManagedTunnel: vi.fn(async () => true),
    } as unknown as ServerRepository;
    const worker = {
      isConnected: () => true,
      request: vi.fn(async (_workerId, command: WorkerCommand) =>
        workerCommandResult(command),
      ),
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
    } as unknown as WorkerCommandBus;
    const broker = new CodeTunnelBroker(worker);
    broker.configureControlPlane(repository, vi.fn(), vi.fn());
    const leaseInput = {
      authSessionId: null,
      explorerId: "explorer-1",
      ownerId: "user-1",
      sessionId: runtime.sessionId,
      tunnelId,
    };
    const releasedLease = broker.acquireRegistrationLease(leaseInput)!;
    const activeLease = broker.acquireRegistrationLease(leaseInput)!;
    broker.releaseRegistrationLease(releasedLease);

    try {
      await expect(
        broker.createProtectedAttachment({
          codeTabId: "explorer:explorer-1:session-1",
          registrationLease: releasedLease,
          ownerId: "user-1",
          projectId: "project-1",
          protectedRecord: protectedRecord(tunnelId),
          runtime,
          sessionId: runtime.sessionId,
          stopSessionOnRelease: true,
          tunnelId,
          workerId: "worker-1",
        }),
      ).rejects.toBeInstanceOf(ExplorerCodeAttachmentLeaseError);
      expect(registerManagedTunnel).not.toHaveBeenCalled();
      broker.releaseRegistrationLease(activeLease);
      const replacementLease = broker.acquireRegistrationLease(leaseInput)!;
      expect(replacementLease.explorerGeneration).not.toBe(
        activeLease.explorerGeneration,
      );
      broker.releaseRegistrationLease(replacementLease);
    } finally {
      broker.releaseRegistrationLease(activeLease);
      await broker.close();
    }
  });

  it("serializes an Explorer mutation that races managed tunnel registration", async () => {
    const tunnelId = "11111111-1111-4111-8111-111111111111";
    let releaseRegistration!: () => void;
    let signalRegistrationStarted!: () => void;
    const registrationStarted = new Promise<void>((resolve) => {
      signalRegistrationStarted = resolve;
    });
    const registrationRelease = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    const repository = {
      registerManagedTunnel: vi.fn(async () => {
        signalRegistrationStarted();
        await registrationRelease;
        return { id: tunnelId };
      }),
      removeManagedTunnel: vi.fn(async () => true),
    } as unknown as ServerRepository;
    const worker = {
      isConnected: () => true,
      request: vi.fn(async (_workerId, command: WorkerCommand) =>
        workerCommandResult(command),
      ),
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
    } as unknown as WorkerCommandBus;
    const cleanupTunnelResources = vi.fn(async () => undefined);
    const broker = new CodeTunnelBroker(worker);
    broker.configureControlPlane(repository, vi.fn(), cleanupTunnelResources);
    const lease = broker.acquireRegistrationLease({
      authSessionId: null,
      explorerId: "explorer-1",
      ownerId: "user-1",
      sessionId: runtime.sessionId,
      tunnelId,
    })!;

    try {
      const creation = broker.createProtectedAttachment({
        codeTabId: "explorer:explorer-1:session-1",
        registrationLease: lease,
        ownerId: "user-1",
        projectId: "project-1",
        protectedRecord: protectedRecord(tunnelId),
        runtime,
        sessionId: runtime.sessionId,
        stopSessionOnRelease: true,
        tunnelId,
        workerId: "worker-1",
      });
      await registrationStarted;
      const mutation = vi.fn(async () => "deleted");
      const cleanup = broker.mutateExplorer(
        "user-1",
        "explorer-1",
        mutation,
        () => true,
      );
      await Promise.resolve();
      expect(mutation).not.toHaveBeenCalled();

      releaseRegistration();
      await expect(creation).rejects.toBeInstanceOf(
        ExplorerCodeAttachmentLeaseError,
      );
      broker.releaseRegistrationLease(lease);
      await expect(cleanup).resolves.toBe("deleted");
      expect(mutation).toHaveBeenCalledOnce();
      expect(repository.removeManagedTunnel).toHaveBeenCalledWith("user-1", {
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
        {
          type: "code.stop",
          sessionId: runtime.sessionId,
          expectedSessionIncarnationId: sessionIncarnationId,
        },
        { timeoutMs: 5_000 },
      );
    } finally {
      releaseRegistration();
      broker.releaseRegistrationLease(lease);
      await broker.close();
    }
  });

  it("holds an Explorer mutation through final route validation after registration", async () => {
    const tunnelId = "11111111-1111-4111-8111-111111111111";
    const repository = {
      registerManagedTunnel: vi.fn(async () => ({ id: tunnelId })),
      removeManagedTunnel: vi.fn(async () => true),
    } as unknown as ServerRepository;
    const worker = {
      isConnected: () => true,
      request: vi.fn(async (_workerId, command: WorkerCommand) =>
        workerCommandResult(command),
      ),
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
    } as unknown as WorkerCommandBus;
    const broker = new CodeTunnelBroker(worker);
    broker.configureControlPlane(repository, vi.fn(), vi.fn());
    const lease = broker.acquireRegistrationLease({
      authSessionId: "auth-session-1",
      explorerId: "explorer-1",
      ownerId: "user-1",
      sessionId: runtime.sessionId,
      tunnelId,
    })!;

    try {
      await broker.createProtectedAttachment({
        authSessionId: "auth-session-1",
        codeTabId: "explorer:explorer-1:session-1",
        ownerId: "user-1",
        projectId: "project-1",
        protectedRecord: protectedRecord(tunnelId),
        registrationLease: lease,
        runtime,
        sessionId: runtime.sessionId,
        stopSessionOnRelease: true,
        tunnelId,
        workerId: "worker-1",
      });
      const mutation = vi.fn(async () => "deleted");
      let cleanupFinished = false;
      const cleanup = broker
        .mutateExplorer("user-1", "explorer-1", mutation, () => true)
        .then((result) => {
          cleanupFinished = true;
          return result;
        });
      await Promise.resolve();

      expect(broker.registrationLeaseIsActive(lease)).toBe(false);
      expect(mutation).not.toHaveBeenCalled();
      expect(cleanupFinished).toBe(false);

      broker.releaseRegistrationLease(lease);
      await expect(cleanup).resolves.toBe("deleted");
      expect(repository.removeManagedTunnel).toHaveBeenCalledWith("user-1", {
        kind: "code",
        id: tunnelId,
      });
    } finally {
      broker.releaseRegistrationLease(lease);
      await broker.close();
    }
  });

  it("waits for a delayed registration and revokes its late attachment during shutdown", async () => {
    const tunnelId = "11111111-1111-4111-8111-111111111111";
    const rejectedTunnelId = "22222222-2222-4222-8222-222222222222";
    let releaseRegistration!: () => void;
    let signalRegistrationStarted!: () => void;
    const registrationStarted = new Promise<void>((resolve) => {
      signalRegistrationStarted = resolve;
    });
    const registrationRelease = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    const registerManagedTunnel = vi.fn(async (_ownerId, _input, identity) => {
      signalRegistrationStarted();
      await registrationRelease;
      return { id: identity.id };
    });
    const removeManagedTunnel = vi.fn(async () => true);
    const repository = {
      registerManagedTunnel,
      removeManagedTunnel,
    } as unknown as ServerRepository;
    const worker = {
      isConnected: () => true,
      request: vi.fn(async (_workerId, command: WorkerCommand) =>
        workerCommandResult(command),
      ),
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
    } as unknown as WorkerCommandBus;
    const cleanupTunnelResources = vi.fn(async () => undefined);
    const broker = new CodeTunnelBroker(worker);
    broker.configureControlPlane(repository, vi.fn(), cleanupTunnelResources);

    const creation = broker.createProtectedAttachment({
      codeTabId: "explorer:explorer-1:session-1",
      ownerId: "user-1",
      projectId: "project-1",
      protectedRecord: protectedRecord(tunnelId),
      runtime,
      sessionId: runtime.sessionId,
      stopSessionOnRelease: true,
      tunnelId,
      workerId: "worker-1",
    });
    await registrationStarted;
    let shutdownFinished = false;
    const shutdown = broker.close().then(() => {
      shutdownFinished = true;
    });

    try {
      await expect(
        broker.createProtectedAttachment({
          codeTabId: "code-rejected",
          ownerId: "user-1",
          projectId: "project-1",
          protectedRecord: protectedRecord(rejectedTunnelId),
          runtime: { ...runtime, sessionId: "session-rejected" },
          sessionId: "session-rejected",
          tunnelId: rejectedTunnelId,
          workerId: "worker-1",
        }),
      ).rejects.toThrow("The Cantrip Code tunnel broker is shutting down.");
      expect(registerManagedTunnel).toHaveBeenCalledOnce();
      expect(shutdownFinished).toBe(false);

      releaseRegistration();
      await expect(creation).rejects.toThrow(
        "The Cantrip Code tunnel broker is shutting down.",
      );
      await expect(shutdown).resolves.toBeUndefined();
      expect(removeManagedTunnel).toHaveBeenCalledExactlyOnceWith("user-1", {
        kind: "code",
        id: tunnelId,
      });
      expect(cleanupTunnelResources).toHaveBeenCalledExactlyOnceWith(
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
        {
          type: "code.stop",
          sessionId: runtime.sessionId,
          expectedSessionIncarnationId: sessionIncarnationId,
        },
        { timeoutMs: 5_000 },
      );
      await expect(broker.close()).resolves.toBeUndefined();
      expect(removeManagedTunnel).toHaveBeenCalledOnce();
    } finally {
      releaseRegistration();
      await broker.close();
    }
  });

  it("waits for a pre-registration route lease during shutdown", async () => {
    const tunnelId = "11111111-1111-4111-8111-111111111111";
    const registerManagedTunnel = vi.fn(async () => ({ id: tunnelId }));
    const repository = {
      registerManagedTunnel,
      removeManagedTunnel: vi.fn(async () => true),
    } as unknown as ServerRepository;
    const worker = {
      isConnected: () => true,
      request: vi.fn(async (_workerId, command: WorkerCommand) =>
        workerCommandResult(command),
      ),
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
    } as unknown as WorkerCommandBus;
    const broker = new CodeTunnelBroker(worker);
    broker.configureControlPlane(repository, vi.fn(), vi.fn());
    const lease = broker.acquireRegistrationLease({
      authSessionId: "auth-session-1",
      ownerId: "user-1",
      sessionId: runtime.sessionId,
      tunnelId,
    })!;
    let shutdownFinished = false;
    const shutdown = broker.close().then(() => {
      shutdownFinished = true;
    });

    try {
      expect(broker.registrationLeaseIsActive(lease)).toBe(false);
      expect(shutdownFinished).toBe(false);
      expect(
        broker.acquireRegistrationLease({
          authSessionId: lease.authSessionId,
          ownerId: lease.ownerId,
          sessionId: lease.sessionId,
          tunnelId: "22222222-2222-4222-8222-222222222222",
        }),
      ).toBeNull();
      await expect(
        broker.createProtectedAttachment({
          authSessionId: lease.authSessionId,
          codeTabId: "code-1",
          ownerId: lease.ownerId,
          projectId: "project-1",
          protectedRecord: protectedRecord(tunnelId),
          registrationLease: lease,
          runtime,
          sessionId: lease.sessionId,
          tunnelId,
          workerId: "worker-1",
        }),
      ).rejects.toThrow("The Cantrip Code tunnel broker is shutting down.");
      expect(registerManagedTunnel).not.toHaveBeenCalled();

      broker.releaseRegistrationLease(lease);
      await expect(shutdown).resolves.toBeUndefined();
    } finally {
      broker.releaseRegistrationLease(lease);
      await broker.close();
    }
  });

  it("counts pending registrations against the attachment limit", async () => {
    const tunnelId = "11111111-1111-4111-8111-111111111111";
    const rejectedTunnelId = "22222222-2222-4222-8222-222222222222";
    let releaseRegistration!: () => void;
    let signalRegistrationStarted!: () => void;
    const registrationStarted = new Promise<void>((resolve) => {
      signalRegistrationStarted = resolve;
    });
    const registrationRelease = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    const registerManagedTunnel = vi.fn(async (_ownerId, _input, identity) => {
      signalRegistrationStarted();
      await registrationRelease;
      return { id: identity.id };
    });
    const repository = {
      registerManagedTunnel,
      removeManagedTunnel: vi.fn(async () => true),
    } as unknown as ServerRepository;
    const worker = {
      isConnected: () => true,
      request: vi.fn(async (_workerId, command: WorkerCommand) =>
        workerCommandResult(command),
      ),
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
    } as unknown as WorkerCommandBus;
    const broker = new CodeTunnelBroker(worker, { maxAttachments: 1 });
    broker.configureControlPlane(repository, vi.fn(), vi.fn());

    try {
      const creation = broker.createProtectedAttachment({
        codeTabId: "code-1",
        ownerId: "user-1",
        projectId: "project-1",
        protectedRecord: protectedRecord(tunnelId),
        runtime,
        sessionId: runtime.sessionId,
        tunnelId,
        workerId: "worker-1",
      });
      await registrationStarted;

      await expect(
        broker.createProtectedAttachment({
          codeTabId: "code-2",
          ownerId: "user-1",
          projectId: "project-1",
          protectedRecord: protectedRecord(rejectedTunnelId),
          runtime: { ...runtime, sessionId: "session-2" },
          sessionId: "session-2",
          tunnelId: rejectedTunnelId,
          workerId: "worker-1",
        }),
      ).rejects.toThrow(
        "This server has reached its Cantrip Code attachment limit.",
      );
      expect(registerManagedTunnel).toHaveBeenCalledOnce();

      releaseRegistration();
      await expect(creation).resolves.toMatchObject({ tunnelId });
    } finally {
      releaseRegistration();
      await broker.close();
    }
  });

  it("bounds pre-registration route leases by the attachment limit", async () => {
    const broker = new CodeTunnelBroker(
      {
        isConnected: () => true,
        request: vi.fn(async (_workerId, command: WorkerCommand) =>
          workerCommandResult(command),
        ),
        subscribeWorkerDisconnect: vi.fn(() => () => undefined),
      } as unknown as WorkerCommandBus,
      { maxAttachments: 1 },
    );
    const first = broker.acquireRegistrationLease({
      authSessionId: "auth-session-1",
      ownerId: "user-1",
      sessionId: "session-1",
      tunnelId: "11111111-1111-4111-8111-111111111111",
    })!;

    try {
      expect(
        broker.acquireRegistrationLease({
          authSessionId: "auth-session-2",
          ownerId: "user-1",
          sessionId: "session-2",
          tunnelId: "22222222-2222-4222-8222-222222222222",
        }),
      ).toBeNull();
      broker.releaseRegistrationLease(first);
      const replacement = broker.acquireRegistrationLease({
        authSessionId: "auth-session-2",
        ownerId: "user-1",
        sessionId: "session-2",
        tunnelId: "22222222-2222-4222-8222-222222222222",
      });
      expect(replacement).not.toBeNull();
      broker.releaseRegistrationLease(replacement!);
    } finally {
      broker.releaseRegistrationLease(first);
      await broker.close();
    }
  });

  it.each(["auth session", "runtime session", "owner", "attachment"] as const)(
    "fences a delayed registration across %s revocation",
    async (scope) => {
      const tunnelId = "11111111-1111-4111-8111-111111111111";
      let releaseRegistration!: () => void;
      let signalRegistrationStarted!: () => void;
      const registrationStarted = new Promise<void>((resolve) => {
        signalRegistrationStarted = resolve;
      });
      const registrationRelease = new Promise<void>((resolve) => {
        releaseRegistration = resolve;
      });
      const registerManagedTunnel = vi.fn(
        async (_ownerId, _input, identity) => {
          signalRegistrationStarted();
          await registrationRelease;
          return { id: identity.id };
        },
      );
      const removeManagedTunnel = vi.fn(async () => true);
      const repository = {
        registerManagedTunnel,
        removeManagedTunnel,
      } as unknown as ServerRepository;
      const worker = {
        isConnected: () => true,
        request: vi.fn(async (_workerId, command: WorkerCommand) =>
          workerCommandResult(command),
        ),
        subscribeWorkerDisconnect: vi.fn(() => () => undefined),
      } as unknown as WorkerCommandBus;
      const cleanupTunnelResources = vi.fn(async () => undefined);
      const broker = new CodeTunnelBroker(worker);
      broker.configureControlPlane(repository, vi.fn(), cleanupTunnelResources);
      const input = {
        authSessionId: "auth-session-1",
        codeTabId: "code-1",
        ownerId: "user-1",
        projectId: "project-1",
        protectedRecord: protectedRecord(tunnelId),
        runtime,
        sessionId: runtime.sessionId,
        stopSessionOnRelease: true,
        tunnelId,
        workerId: "worker-1",
      };

      try {
        const creation = broker.createProtectedAttachment(input);
        await registrationStarted;
        let cleanupFinished = false;
        const cleanup = (
          scope === "auth session"
            ? broker.revokeAuthSession(input.authSessionId)
            : scope === "runtime session"
              ? broker.revokeSession(input.sessionId)
              : scope === "owner"
                ? broker.revokeOwner(input.ownerId)
                : broker.revokeAttachment(input.tunnelId, input.ownerId)
        ).then(() => {
          cleanupFinished = true;
        });

        await expect(broker.createProtectedAttachment(input)).rejects.toThrow(
          "The protected Cantrip Code attachment is being revoked.",
        );
        expect(registerManagedTunnel).toHaveBeenCalledOnce();
        expect(cleanupFinished).toBe(false);

        releaseRegistration();
        await expect(creation).rejects.toThrow(
          "The protected Cantrip Code attachment is being revoked.",
        );
        await expect(cleanup).resolves.toBeUndefined();
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
          {
            type: "code.stop",
            sessionId: runtime.sessionId,
            expectedSessionIncarnationId: sessionIncarnationId,
          },
          { timeoutMs: 5_000 },
        );
      } finally {
        releaseRegistration();
        await broker.close();
      }
    },
  );

  it.each(["auth session", "runtime session", "owner", "attachment"] as const)(
    "invalidates and waits a pre-registration route lease across %s revocation",
    async (scope) => {
      const tunnelId = "11111111-1111-4111-8111-111111111111";
      const registerManagedTunnel = vi.fn(async () => ({ id: tunnelId }));
      const repository = {
        registerManagedTunnel,
        removeManagedTunnel: vi.fn(async () => true),
      } as unknown as ServerRepository;
      const worker = {
        isConnected: () => true,
        request: vi.fn(async (_workerId, command: WorkerCommand) =>
          workerCommandResult(command),
        ),
        subscribeWorkerDisconnect: vi.fn(() => () => undefined),
      } as unknown as WorkerCommandBus;
      const broker = new CodeTunnelBroker(worker);
      broker.configureControlPlane(repository, vi.fn(), vi.fn());
      const lease = broker.acquireRegistrationLease({
        authSessionId: "auth-session-1",
        ownerId: "user-1",
        sessionId: runtime.sessionId,
        tunnelId,
      })!;
      let cleanupFinished = false;
      const cleanup = (
        scope === "auth session"
          ? broker.revokeAuthSession(lease.authSessionId!)
          : scope === "runtime session"
            ? broker.revokeSession(lease.sessionId)
            : scope === "owner"
              ? broker.revokeOwner(lease.ownerId)
              : broker.revokeAttachment(lease.tunnelId, lease.ownerId)
      ).then(() => {
        cleanupFinished = true;
      });

      try {
        expect(broker.registrationLeaseIsActive(lease)).toBe(false);
        expect(cleanupFinished).toBe(false);
        expect(
          broker.acquireRegistrationLease({
            authSessionId: lease.authSessionId,
            ownerId: lease.ownerId,
            sessionId: lease.sessionId,
            tunnelId: lease.tunnelId,
          }),
        ).toBeNull();
        await expect(
          broker.createProtectedAttachment({
            authSessionId: lease.authSessionId,
            codeTabId: "code-1",
            ownerId: lease.ownerId,
            projectId: "project-1",
            protectedRecord: protectedRecord(tunnelId),
            registrationLease: lease,
            runtime,
            sessionId: lease.sessionId,
            tunnelId,
            workerId: "worker-1",
          }),
        ).rejects.toThrow(
          "The protected Cantrip Code attachment is being revoked.",
        );
        expect(registerManagedTunnel).not.toHaveBeenCalled();

        broker.releaseRegistrationLease(lease);
        await expect(cleanup).resolves.toBeUndefined();
      } finally {
        broker.releaseRegistrationLease(lease);
        await cleanup;
        await broker.close();
      }
    },
  );

  it("settles every shutdown cleanup before surfacing aggregate failures", async () => {
    const tunnelIds = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];
    let releaseSecondRemoval!: () => void;
    const secondRemovalRelease = new Promise<void>((resolve) => {
      releaseSecondRemoval = resolve;
    });
    const removeManagedTunnel = vi.fn(async (_ownerId, managedBy) => {
      if (managedBy.id === tunnelIds[0]) {
        throw new Error("database unavailable");
      }
      await secondRemovalRelease;
      return true;
    });
    const repository = {
      registerManagedTunnel: vi.fn(async (_ownerId, _input, identity) => ({
        id: identity.id,
      })),
      removeManagedTunnel,
    } as unknown as ServerRepository;
    const worker = {
      isConnected: () => true,
      request: vi.fn(async (_workerId, command: WorkerCommand) =>
        workerCommandResult(command),
      ),
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
    } as unknown as WorkerCommandBus;
    const broker = new CodeTunnelBroker(worker);
    broker.configureControlPlane(repository, vi.fn(), vi.fn());

    for (const [index, tunnelId] of tunnelIds.entries()) {
      await broker.createProtectedAttachment({
        codeTabId: `code-${index}`,
        ownerId: "user-1",
        projectId: "project-1",
        protectedRecord: protectedRecord(tunnelId),
        runtime: { ...runtime, sessionId: `session-${index}` },
        sessionId: `session-${index}`,
        stopSessionOnRelease: true,
        tunnelId,
        workerId: "worker-1",
      });
    }

    let shutdownSettled = false;
    const shutdown = broker.close().finally(() => {
      shutdownSettled = true;
    });
    try {
      await vi.waitFor(() =>
        expect(removeManagedTunnel).toHaveBeenCalledTimes(2),
      );
      expect(shutdownSettled).toBe(false);
      releaseSecondRemoval();
      await expect(shutdown).rejects.toThrow(
        "Could not revoke every protected Cantrip Code attachment during shutdown.",
      );
      expect(repository.removeManagedTunnel).toHaveBeenCalledWith("user-1", {
        kind: "code",
        id: tunnelIds[1],
      });
      expect(worker.request).toHaveBeenCalledWith(
        "worker-1",
        {
          type: "code.stop",
          sessionId: "session-0",
          expectedSessionIncarnationId: sessionIncarnationId,
        },
        { timeoutMs: 5_000 },
      );
      expect(worker.request).toHaveBeenCalledWith(
        "worker-1",
        {
          type: "code.stop",
          sessionId: "session-1",
          expectedSessionIncarnationId: sessionIncarnationId,
        },
        { timeoutMs: 5_000 },
      );
    } finally {
      releaseSecondRemoval();
      await broker.close().catch(() => undefined);
    }
  });

  it("settles every Explorer cleanup and retries the failed remainder", async () => {
    const tunnelIds = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];
    let firstTunnelFailure = true;
    const removeManagedTunnel = vi.fn(async (_ownerId, managedBy) => {
      if (managedBy.id === tunnelIds[0] && firstTunnelFailure) {
        firstTunnelFailure = false;
        throw new Error("database unavailable");
      }
      return true;
    });
    const repository = {
      registerManagedTunnel: vi.fn(async (_ownerId, _input, identity) => ({
        id: identity.id,
      })),
      removeManagedTunnel,
    } as unknown as ServerRepository;
    const worker = {
      isConnected: () => true,
      request: vi.fn(async (_workerId, command: WorkerCommand) =>
        workerCommandResult(command),
      ),
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
    } as unknown as WorkerCommandBus;
    const broker = new CodeTunnelBroker(worker);
    broker.configureControlPlane(repository, vi.fn(), vi.fn());

    try {
      for (const [index, tunnelId] of tunnelIds.entries()) {
        const lease = broker.acquireRegistrationLease({
          authSessionId: null,
          explorerId: "explorer-1",
          ownerId: "user-1",
          sessionId: `session-${index}`,
          tunnelId,
        })!;
        try {
          await broker.createProtectedAttachment({
            codeTabId: `explorer:explorer-1:session-${index}`,
            registrationLease: lease,
            ownerId: "user-1",
            projectId: "project-1",
            protectedRecord: protectedRecord(tunnelId),
            runtime: { ...runtime, sessionId: `session-${index}` },
            sessionId: `session-${index}`,
            stopSessionOnRelease: true,
            tunnelId,
            workerId: "worker-1",
          });
        } finally {
          broker.releaseRegistrationLease(lease);
        }
      }

      await expect(
        broker.mutateExplorer(
          "user-1",
          "explorer-1",
          async () => true,
          () => true,
        ),
      ).rejects.toThrow(
        "Could not revoke every protected Cantrip Code attachment.",
      );
      expect(removeManagedTunnel).toHaveBeenCalledWith("user-1", {
        kind: "code",
        id: tunnelIds[1],
      });
      await expect(
        broker.mutateExplorer(
          "user-1",
          "explorer-1",
          async () => false,
          () => true,
        ),
      ).resolves.toBe(false);
      expect(
        removeManagedTunnel.mock.calls.filter(
          ([, managedBy]) => managedBy.id === tunnelIds[0],
        ),
      ).toHaveLength(2);
      expect(
        removeManagedTunnel.mock.calls.filter(
          ([, managedBy]) => managedBy.id === tunnelIds[1],
        ),
      ).toHaveLength(1);
    } finally {
      await broker.close();
    }
  });

  it("renews an active tunnel lease without exceeding its maximum lifetime", async () => {
    const tunnelId = "11111111-1111-4111-8111-111111111111";
    let now = 1_000;
    const repository = {
      registerManagedTunnel: vi.fn(async () => ({ id: tunnelId })),
      removeManagedTunnel: vi.fn(async () => true),
    } as unknown as ServerRepository;
    const worker = {
      isConnected: () => true,
      request: vi.fn(async (_workerId, command: WorkerCommand) =>
        workerCommandResult(command),
      ),
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
    } as unknown as WorkerCommandBus;
    const broker = new CodeTunnelBroker(worker, {
      idleTtlMs: 100,
      maxLifetimeMs: 250,
      now: () => now,
    });
    broker.configureControlPlane(repository, vi.fn(), vi.fn());

    try {
      await broker.createProtectedAttachment({
        codeTabId: "code-1",
        ownerId: "user-1",
        projectId: "project-1",
        protectedRecord: protectedRecord(tunnelId),
        runtime,
        sessionId: runtime.sessionId,
        tunnelId,
        workerId: "worker-1",
      });
      expect(broker.recordTunnelActivity("unrelated-tunnel")).toBeNull();
      expect(broker.allowTunnelActivity("unrelated-tunnel")).toBe(true);
      now = 1_050;
      expect(broker.recordTunnelActivity(tunnelId)).toBe(
        new Date(1_150).toISOString(),
      );
      now = 1_140;
      expect(broker.recordTunnelActivity(tunnelId)).toBe(
        new Date(1_240).toISOString(),
      );
      now = 1_200;
      expect(broker.recordTunnelActivity(tunnelId)).toBe(
        new Date(1_250).toISOString(),
      );
      now = 1_250;
      expect(broker.allowTunnelActivity(tunnelId)).toBe(false);
      await vi.waitFor(() =>
        expect(repository.removeManagedTunnel).toHaveBeenCalledOnce(),
      );
    } finally {
      await broker.close();
    }
  });

  it("clamps the initial lease to the configured maximum lifetime", async () => {
    const tunnelId = "11111111-1111-4111-8111-111111111111";
    const repository = {
      registerManagedTunnel: vi.fn(async () => ({ id: tunnelId })),
      removeManagedTunnel: vi.fn(async () => true),
    } as unknown as ServerRepository;
    const worker = {
      isConnected: () => true,
      request: vi.fn(async (_workerId, command: WorkerCommand) =>
        workerCommandResult(command),
      ),
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
    } as unknown as WorkerCommandBus;
    const broker = new CodeTunnelBroker(worker, {
      idleTtlMs: 500,
      maxLifetimeMs: 250,
      now: () => 1_000,
    });
    broker.configureControlPlane(repository, vi.fn(), vi.fn());

    try {
      await expect(
        broker.createProtectedAttachment({
          codeTabId: "code-1",
          ownerId: "user-1",
          projectId: "project-1",
          protectedRecord: protectedRecord(tunnelId),
          runtime,
          sessionId: runtime.sessionId,
          tunnelId,
          workerId: "worker-1",
        }),
      ).resolves.toMatchObject({ expiresAt: new Date(1_250).toISOString() });
    } finally {
      await broker.close();
    }
  });

  it("issues an exact opaque direct-child root lease and invalidates it with the Code binding", async () => {
    const tunnelId = "11111111-1111-4111-8111-111111111111";
    let now = 1_000;
    let releaseRemoval!: () => void;
    let signalRemoval!: () => void;
    const removalStarted = new Promise<void>((resolve) => {
      signalRemoval = resolve;
    });
    const removalRelease = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    const repository = {
      registerManagedTunnel: vi.fn(async () => ({ id: tunnelId })),
      removeManagedTunnel: vi.fn(async () => {
        signalRemoval();
        await removalRelease;
        return true;
      }),
    } as unknown as ServerRepository;
    const worker = {
      isConnected: () => true,
      request: vi.fn(async (_workerId, command: WorkerCommand) =>
        workerCommandResult(command),
      ),
      subscribeWorkerDisconnect: vi.fn(() => () => undefined),
    } as unknown as WorkerCommandBus;
    const broker = new CodeTunnelBroker(worker, {
      idleTtlMs: 100,
      maxLifetimeMs: 250,
      now: () => now,
    });
    broker.configureControlPlane(repository, vi.fn(), vi.fn());

    try {
      await broker.createProtectedAttachment({
        authSessionId: "auth-session-1",
        codeTabId: "explorer:explorer-1:session-1",
        ownerId: "user-1",
        projectId: "project-1",
        protectedRecord: protectedRecord(tunnelId),
        runtime,
        serverId: "server-1",
        sessionId: runtime.sessionId,
        tunnelId,
        workerId: "worker-1",
        worktreeId: "worktree-1",
        worktreePath: "/worker/project",
      });
      const identity = {
        authSessionId: "auth-session-1",
        ownerId: "user-1",
        protectedKeyRevision: 1,
        rootAttachmentId: tunnelId,
        serverId: "server-1",
        tunnelId,
        workerId: "worker-1",
      };
      const acquired = broker.acquireAttachmentRootLease(identity);
      expect(acquired.managed).toBe(true);
      expect(acquired.lease).not.toBeNull();
      expect(acquired.lease).toMatchObject({
        expiresAt: new Date(1_100).toISOString(),
        hardExpiresAt: new Date(1_250).toISOString(),
      });
      expect(
        broker.allowRelayAttachmentActivity("relay-attachment", tunnelId),
      ).toBe(false);
      expect(
        broker.bindRelayAttachment("relay-attachment", {
          ...identity,
          authSessionId: "another-session",
        }),
      ).toBe(false);
      expect(broker.bindRelayAttachment("relay-attachment", identity)).toBe(
        true,
      );
      expect(
        broker.allowRelayAttachmentActivity("relay-attachment", tunnelId),
      ).toBe(true);

      for (const mismatch of [
        { ...identity, rootAttachmentId: "another-attachment" },
        { ...identity, authSessionId: "another-session" },
        { ...identity, ownerId: "another-owner" },
        { ...identity, protectedKeyRevision: 2 },
        { ...identity, serverId: "another-server" },
        { ...identity, workerId: "another-worker" },
      ]) {
        expect(broker.acquireAttachmentRootLease(mismatch)).toEqual({
          lease: null,
          managed: true,
        });
      }

      now = 1_050;
      expect(acquired.lease?.recordActivity()).toMatchObject({
        expiresAt: new Date(1_150).toISOString(),
        hardExpiresAt: new Date(1_250).toISOString(),
        generation: acquired.lease.generation,
      });
      const removal = broker.revokeAttachment(tunnelId, "user-1");
      await removalStarted;
      expect(acquired.lease?.validate()).toBeNull();
      expect(
        broker.allowRelayAttachmentActivity("relay-attachment", tunnelId),
      ).toBe(false);
      releaseRemoval();
      await removal;
      expect(acquired.lease?.validate()).toBeNull();
      expect(broker.acquireAttachmentRootLease(identity)).toEqual({
        lease: null,
        managed: false,
      });
    } finally {
      releaseRemoval();
      await broker.close();
    }
  });
});
