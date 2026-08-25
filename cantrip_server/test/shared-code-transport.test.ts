import type { CodeRuntimeStatus, WorkerCommand } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  CodeTunnelBroker,
  type CodeAttachmentRootIdentity,
} from "../src/code/tunnel.js";
import type { ServerRepository } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const ownerId = "owner-1";
const authSessionId = "auth-session-1";
const serverId = "server-1";
const serverControlPlaneGeneration = "88888888-8888-4888-8888-888888888888";
const workerId = "worker-1";
const workerProcessGeneration = "99999999-9999-4999-8999-999999999999";
const transportId = "11111111-1111-4111-8111-111111111111";

function protectedRecord(id: string, keyRevision = 7) {
  return {
    operationId: id,
    revision: 1,
    protectedContent: {
      formatVersion: 1 as const,
      domain: "tunnel-content" as const,
      keyRevision,
      envelope: {
        version: 1 as const,
        algorithm: "AES-256-GCM" as const,
        keyRevision,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    },
  };
}

function runtime(sessionId: string, incarnationId: string): CodeRuntimeStatus {
  const now = "2026-08-25T12:00:00.000Z";
  return {
    sessionId,
    sessionIncarnationId: incarnationId,
    workspaceUri: "file:///worker/project.code-workspace",
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
    startedAt: now,
    lastActivityAt: now,
    lastError: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function workerCommandResult(command: WorkerCommand): unknown {
  switch (command.type) {
    case "code.stop":
      return {
        ...runtime(
          command.sessionId,
          command.expectedSessionIncarnationId ??
            "99999999-9999-4999-8999-999999999999",
        ),
        bridgeConnected: false,
        processInstanceId: null,
        sessionIncarnationId: null,
        status: "stopped",
      };
    case "code.transport.route.authorize":
      return {
        ownerId: command.ownerId,
        authSessionId: command.authSessionId,
        serverId: command.serverId,
        serverControlPlaneGeneration: command.serverControlPlaneGeneration,
        protectedKeyRevision: command.protectedKeyRevision,
        workerProcessGeneration: command.workerProcessGeneration,
        attachmentId: command.attachmentId,
        authorized: true,
        expiresAt: command.expiresAt,
        sessionId: command.sessionId,
        sessionIncarnationId: command.expectedSessionIncarnationId,
        transportId: command.transportId,
      };
    case "code.transport.route.revoke":
      return {
        ownerId: command.ownerId,
        authSessionId: command.authSessionId,
        serverId: command.serverId,
        serverControlPlaneGeneration: command.serverControlPlaneGeneration,
        protectedKeyRevision: command.protectedKeyRevision,
        workerProcessGeneration: command.workerProcessGeneration,
        attachmentId: command.attachmentId,
        revoked: true,
        transportId: command.transportId,
      };
    case "code.transport.revoke":
      return {
        ownerId: command.ownerId,
        authSessionId: command.authSessionId,
        serverId: command.serverId,
        serverControlPlaneGeneration: command.serverControlPlaneGeneration,
        protectedKeyRevision: command.protectedKeyRevision,
        workerProcessGeneration: command.workerProcessGeneration,
        revoked: true,
        transportId: command.transportId,
      };
    default:
      return {};
  }
}

function harness(
  options: ConstructorParameters<typeof CodeTunnelBroker>[1] = {},
) {
  const offlineListeners = new Map<string, () => void>();
  const transportGrantRevisions = new Set([7]);
  const request = vi.fn(async (_workerId: string, command: WorkerCommand) =>
    workerCommandResult(command),
  );
  const registerManagedTunnel = vi.fn(
    async (_ownerId: string, _input: unknown, options: { id: string }) => ({
      id: options.id,
    }),
  );
  const removeManagedTunnel = vi.fn(async () => true);
  const cleanup = vi.fn(async () => undefined);
  const repository = {
    encryptionRegistry: {
      findActiveWorkerPrincipal: vi.fn(async () => ({
        id: "worker-principal-1",
      })),
      listActiveGrants: vi.fn(async () => ({
        status: "ok",
        grants: [...transportGrantRevisions].map((keyRevision) => ({
          component: "tunnel-content",
          keyRevision,
        })),
      })),
    },
    registerManagedTunnel,
    removeManagedTunnel,
  } as unknown as ServerRepository;
  const bridge = {
    isConnected: () => true,
    request,
    subscribeWorkerDisconnect: () => () => undefined,
    subscribeWorkerOffline: (id: string, listener: () => void) => {
      offlineListeners.set(id, listener);
      return () => offlineListeners.delete(id);
    },
  } as unknown as WorkerCommandBus;
  const broker = new CodeTunnelBroker(bridge, options);
  broker.configureControlPlane(repository, vi.fn(), cleanup);
  return {
    broker,
    cleanup,
    offlineListeners,
    registerManagedTunnel,
    removeManagedTunnel,
    request,
    setTransportGrantActive(active: boolean) {
      transportGrantRevisions.clear();
      if (active) transportGrantRevisions.add(7);
    },
    addTransportGrantRevision(keyRevision: number) {
      transportGrantRevisions.add(keyRevision);
    },
    setTransportGrantRevision(keyRevision: number) {
      transportGrantRevisions.clear();
      transportGrantRevisions.add(keyRevision);
    },
  };
}

function sharedInput(
  index: number,
  overrides: Partial<
    Parameters<CodeTunnelBroker["createSharedSessionAttachment"]>[0]
  > = {},
): Parameters<CodeTunnelBroker["createSharedSessionAttachment"]>[0] {
  const suffix = String(index).padStart(12, "0");
  const attachmentId = `22222222-2222-4222-8222-${suffix}`;
  const sessionId = `33333333-3333-4333-8333-${suffix}`;
  const incarnationId = `44444444-4444-4444-8444-${suffix}`;
  return {
    appearance: "dark",
    attachmentId,
    authSessionId,
    codeTabId: `explorer:explorer-1:${sessionId}`,
    explorerId: "explorer-1",
    ownerId,
    projectId: `project-${index}`,
    protectedKeyRevision: 7,
    runtime: runtime(sessionId, incarnationId),
    serverId,
    serverControlPlaneGeneration,
    sessionId,
    stopSessionOnRelease: true,
    transport: {
      formatVersion: 2,
      transportId,
      protectedRecord: protectedRecord(transportId),
    },
    workerId,
    workerProcessGeneration,
    worktreeId: `worktree-${index}`,
    worktreePath: `/workspace/project-${index}`,
    ...overrides,
  };
}

function rootIdentity(
  overrides: Partial<CodeAttachmentRootIdentity> = {},
): CodeAttachmentRootIdentity {
  return {
    authSessionId,
    ownerId,
    protectedKeyRevision: 7,
    rootAttachmentId: transportId,
    serverId,
    tunnelId: transportId,
    workerId,
    ...overrides,
  };
}

function legacyInput(
  index: number,
  overrides: Partial<
    Parameters<CodeTunnelBroker["createProtectedAttachment"]>[0]
  > = {},
): Parameters<CodeTunnelBroker["createProtectedAttachment"]>[0] {
  const suffix = String(index).padStart(12, "0");
  const tunnelId = `66666666-6666-4666-8666-${suffix}`;
  const sessionId = `77777777-7777-4777-8777-${suffix}`;
  const incarnationId = `88888888-8888-4888-8888-${suffix}`;
  return {
    authSessionId,
    codeTabId: `legacy:${sessionId}`,
    ownerId,
    projectId: `legacy-project-${index}`,
    protectedRecord: protectedRecord(tunnelId),
    runtime: runtime(sessionId, incarnationId),
    serverId,
    sessionId,
    stopSessionOnRelease: true,
    tunnelId,
    workerId,
    worktreeId: `legacy-worktree-${index}`,
    worktreePath: `/workspace/legacy-${index}`,
    ...overrides,
  };
}

describe("shared Cantrip Code transport ownership", () => {
  it("uses one physical root for four isolated logical sessions", async () => {
    const context = harness();
    try {
      const attachments = await Promise.all(
        [1, 2, 3, 4].map((index) =>
          context.broker.createSharedSessionAttachment(sharedInput(index)),
        ),
      );

      expect(context.registerManagedTunnel).toHaveBeenCalledOnce();
      expect(
        new Set(attachments.map((value) => value.transport.transportId)),
      ).toEqual(new Set([transportId]));
      expect(
        new Set(attachments.map((value) => value.session.attachmentId)).size,
      ).toBe(4);
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 4,
        transports: 1,
      });
      expect(
        context.request.mock.calls.filter(
          ([, command]) => command.type === "code.transport.route.authorize",
        ),
      ).toHaveLength(4);

      await context.broker.revokeSharedSessionAttachment({
        attachmentId: attachments[0]!.session.attachmentId,
        authSessionId,
        ownerId,
      });

      expect(context.removeManagedTunnel).not.toHaveBeenCalled();
      expect(context.cleanup).not.toHaveBeenCalled();
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 3,
        transports: 1,
      });
      expect(
        context.broker.acquireAttachmentRootLease(rootIdentity()).lease,
      ).not.toBeNull();

      for (const attachment of attachments.slice(1)) {
        await context.broker.revokeSharedSessionAttachment({
          attachmentId: attachment.session.attachmentId,
          authSessionId,
          ownerId,
        });
      }

      expect(context.removeManagedTunnel).toHaveBeenCalledOnce();
      expect(context.cleanup).toHaveBeenCalledOnce();
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 0,
        transports: 0,
      });
    } finally {
      await context.broker.close();
    }
  });

  it("serializes concurrent first acquisition and returns the winning root", async () => {
    const context = harness();
    const otherTransportId = "55555555-5555-4555-8555-555555555555";
    try {
      const [first, second] = await Promise.all([
        context.broker.createSharedSessionAttachment(sharedInput(1)),
        context.broker.createSharedSessionAttachment(
          sharedInput(2, {
            transport: {
              formatVersion: 2,
              transportId: otherTransportId,
              protectedRecord: protectedRecord(otherTransportId),
            },
          }),
        ),
      ]);

      expect(context.registerManagedTunnel).toHaveBeenCalledOnce();
      expect(first.transport.transportId).toBe(transportId);
      expect(second.transport.transportId).toBe(transportId);
    } finally {
      await context.broker.close();
    }
  });

  it("partitions roots by authentication identity and key revision", async () => {
    const context = harness();
    const secondTransportId = "55555555-5555-4555-8555-555555555555";
    try {
      await context.broker.createSharedSessionAttachment(sharedInput(1));
      await context.broker.createSharedSessionAttachment(
        sharedInput(2, {
          authSessionId: "auth-session-2",
          transport: {
            formatVersion: 2,
            transportId: secondTransportId,
            protectedRecord: protectedRecord(secondTransportId),
          },
        }),
      );

      expect(context.registerManagedTunnel).toHaveBeenCalledTimes(2);
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 2,
        transports: 2,
      });
      expect(
        context.broker.acquireAttachmentRootLease(
          rootIdentity({ authSessionId: "auth-session-2" }),
        ).lease,
      ).toBeNull();
    } finally {
      await context.broker.close();
    }
  });

  it("replaces a prior worker-process generation before exposing the new root", async () => {
    const context = harness();
    const secondTransportId = "55555555-5555-4555-8555-555555555555";
    const secondGeneration = "66666666-6666-4666-8666-666666666666";
    let activeGeneration = workerProcessGeneration;
    context.request.mockImplementation(async (_workerId, command) => {
      if (
        command.type.startsWith("code.transport.") &&
        command.workerProcessGeneration !== activeGeneration
      ) {
        throw new Error("stale worker process generation");
      }
      return workerCommandResult(command);
    });
    try {
      const first = await context.broker.createSharedSessionAttachment(
        sharedInput(1),
      );
      const replacementCallIndex = context.request.mock.calls.length;
      activeGeneration = secondGeneration;
      const second = await context.broker.createSharedSessionAttachment(
        sharedInput(2, {
          transport: {
            formatVersion: 2,
            transportId: secondTransportId,
            protectedRecord: protectedRecord(secondTransportId),
          },
          workerProcessGeneration: secondGeneration,
        }),
      );

      expect(second.transport.transportId).toBe(secondTransportId);
      expect(context.registerManagedTunnel).toHaveBeenCalledTimes(2);
      expect(context.removeManagedTunnel).toHaveBeenCalledWith(
        ownerId,
        expect.objectContaining({ id: first.transport.transportId }),
      );
      expect(
        context.request.mock.calls
          .slice(replacementCallIndex)
          .some(
            ([, command]) =>
              command.type.startsWith("code.transport.") &&
              command.workerProcessGeneration === workerProcessGeneration,
          ),
      ).toBe(false);
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 1,
        transports: 1,
      });
    } finally {
      await context.broker.close();
    }
  });

  it("finishes an old-generation retirement before retrying a replacement root", async () => {
    const context = harness();
    const replacementTransportId = "55555555-5555-4555-8555-555555555555";
    const replacementGeneration = "66666666-6666-4666-8666-666666666666";
    context.cleanup.mockRejectedValueOnce(
      new Error("relay cleanup temporarily unavailable"),
    );
    try {
      await context.broker.createSharedSessionAttachment(sharedInput(1));
      const replacementInput = sharedInput(2, {
        transport: {
          formatVersion: 2,
          transportId: replacementTransportId,
          protectedRecord: protectedRecord(replacementTransportId),
        },
        workerProcessGeneration: replacementGeneration,
      });

      await expect(
        context.broker.createSharedSessionAttachment(replacementInput),
      ).rejects.toThrow("Could not clean up every shared Cantrip Code");
      expect(context.registerManagedTunnel).toHaveBeenCalledOnce();
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 0,
        transports: 0,
      });

      const retryCallIndex = context.request.mock.calls.length;
      const replacement =
        await context.broker.createSharedSessionAttachment(replacementInput);

      expect(replacement.transport.transportId).toBe(replacementTransportId);
      expect(context.registerManagedTunnel).toHaveBeenCalledTimes(2);
      expect(
        context.request.mock.calls
          .slice(retryCallIndex)
          .some(
            ([, command]) =>
              command.type.startsWith("code.transport.") &&
              command.workerProcessGeneration === workerProcessGeneration,
          ),
      ).toBe(false);
    } finally {
      await context.broker.close();
    }
  });

  it("replaces a key-revision root without sending stale lifecycle commands", async () => {
    const context = harness();
    const secondTransportId = "55555555-5555-4555-8555-555555555555";
    let activeRevision = 7;
    context.request.mockImplementation(async (_workerId, command) => {
      if (
        command.type.startsWith("code.transport.") &&
        command.protectedKeyRevision !== activeRevision
      ) {
        throw new Error("stale protected key revision");
      }
      return workerCommandResult(command);
    });
    try {
      const first = await context.broker.createSharedSessionAttachment(
        sharedInput(1),
      );
      const replacementCallIndex = context.request.mock.calls.length;
      activeRevision = 8;
      context.setTransportGrantRevision(8);

      const second = await context.broker.createSharedSessionAttachment(
        sharedInput(2, {
          protectedKeyRevision: 8,
          transport: {
            formatVersion: 2,
            transportId: secondTransportId,
            protectedRecord: protectedRecord(secondTransportId, 8),
          },
        }),
      );

      expect(second.transport.transportId).toBe(secondTransportId);
      expect(context.removeManagedTunnel).toHaveBeenCalledWith(
        ownerId,
        expect.objectContaining({ id: first.transport.transportId }),
      );
      expect(
        context.request.mock.calls
          .slice(replacementCallIndex)
          .some(
            ([, command]) =>
              command.type.startsWith("code.transport.") &&
              command.protectedKeyRevision === 7,
          ),
      ).toBe(false);
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 1,
        transports: 1,
      });
    } finally {
      await context.broker.close();
    }
  });

  it("requires exact owner and auth identity for lease renewal and release", async () => {
    const context = harness();
    try {
      const attached = await context.broker.createSharedSessionAttachment(
        sharedInput(1),
      );
      const authorization = {
        attachmentId: attached.session.attachmentId,
        authSessionId,
        ownerId,
      };

      await expect(
        context.broker.renewSharedSessionAttachment({
          ...authorization,
          authSessionId: "auth-session-2",
        }),
      ).resolves.toBeNull();
      await expect(
        context.broker.revokeSharedSessionAttachment({
          ...authorization,
          ownerId: "owner-2",
        }),
      ).resolves.toBe(false);
      expect(context.broker.sharedTransportStats().sessionAttachments).toBe(1);
      await expect(
        context.broker.revokeSharedSessionAttachment(authorization),
      ).resolves.toBe(true);
    } finally {
      await context.broker.close();
    }
  });

  it("renews the exact worker route grant before extending its wire lease", async () => {
    let now = 1_000;
    const context = harness({ idleTtlMs: 100, now: () => now });
    try {
      const attached = await context.broker.createSharedSessionAttachment(
        sharedInput(1),
      );
      const firstExpiry = attached.session.expiresAt;
      now = 1_050;

      const renewed = await context.broker.renewSharedSessionAttachment({
        attachmentId: attached.session.attachmentId,
        authSessionId,
        ownerId,
      });

      expect(renewed).not.toBeNull();
      expect(renewed!.session.routeGrant).toBe(attached.session.routeGrant);
      expect(renewed!.session.expiresAt).not.toBe(firstExpiry);
      const authorizations = context.request.mock.calls.filter(
        ([, command]) => command.type === "code.transport.route.authorize",
      );
      expect(authorizations).toHaveLength(2);
      expect(authorizations[1]![1]).toMatchObject({
        attachmentId: attached.session.attachmentId,
        expiresAt: renewed!.session.expiresAt,
        routeGrant: attached.session.routeGrant,
      });
    } finally {
      await context.broker.close();
    }
  });

  it("shares session ownership across legacy and v2 attachments", async () => {
    const context = harness();
    const legacy = legacyInput(1);
    const secondTransportId = "55555555-5555-4555-8555-555555555555";
    try {
      const legacyAttachment =
        await context.broker.createProtectedAttachment(legacy);
      const sharedAttachment =
        await context.broker.createSharedSessionAttachment(
          sharedInput(2, {
            authSessionId: "auth-session-2",
            runtime: legacy.runtime,
            sessionId: legacy.sessionId,
            transport: {
              formatVersion: 2,
              transportId: secondTransportId,
              protectedRecord: protectedRecord(secondTransportId),
            },
          }),
        );

      await context.broker.revokeSharedSessionAttachment({
        attachmentId: sharedAttachment.session.attachmentId,
        authSessionId: "auth-session-2",
        ownerId,
      });
      expect(
        context.request.mock.calls.filter(
          ([, command]) => command.type === "code.stop",
        ),
      ).toHaveLength(0);

      await context.broker.revokeAttachment(
        legacyAttachment.attachmentId,
        ownerId,
      );
      expect(
        context.request.mock.calls.filter(
          ([, command]) => command.type === "code.stop",
        ),
      ).toHaveLength(1);
    } finally {
      await context.broker.close();
    }
  });

  it("stops one shared incarnation exactly once after concurrent last releases", async () => {
    const context = harness();
    const firstInput = sharedInput(1);
    const secondTransportId = "55555555-5555-4555-8555-555555555555";
    try {
      const first =
        await context.broker.createSharedSessionAttachment(firstInput);
      const second = await context.broker.createSharedSessionAttachment(
        sharedInput(2, {
          authSessionId: "auth-session-2",
          runtime: firstInput.runtime,
          sessionId: firstInput.sessionId,
          transport: {
            formatVersion: 2,
            transportId: secondTransportId,
            protectedRecord: protectedRecord(secondTransportId),
          },
        }),
      );

      await Promise.all([
        context.broker.revokeSharedSessionAttachment({
          attachmentId: first.session.attachmentId,
          authSessionId,
          ownerId,
        }),
        context.broker.revokeSharedSessionAttachment({
          attachmentId: second.session.attachmentId,
          authSessionId: "auth-session-2",
          ownerId,
        }),
      ]);

      expect(
        context.request.mock.calls.filter(
          ([, command]) => command.type === "code.stop",
        ),
      ).toHaveLength(1);
    } finally {
      await context.broker.close();
    }
  });

  it("rechecks ownership after a same-session lease is released unused", async () => {
    const context = harness();
    const input = sharedInput(1);
    try {
      const attached =
        await context.broker.createSharedSessionAttachment(input);
      const lease = context.broker.acquireRegistrationLease({
        authSessionId,
        explorerId: "explorer-pending",
        ownerId,
        sessionId: input.sessionId,
        tunnelId: "99999999-9999-4999-8999-999999999999",
      });
      expect(lease).not.toBeNull();

      await context.broker.revokeSharedSessionAttachment({
        attachmentId: attached.session.attachmentId,
        authSessionId,
        ownerId,
      });
      expect(
        context.request.mock.calls.filter(
          ([, command]) => command.type === "code.stop",
        ),
      ).toHaveLength(0);

      context.broker.releaseRegistrationLease(lease!);
      await vi.waitFor(() =>
        expect(
          context.request.mock.calls.filter(
            ([, command]) => command.type === "code.stop",
          ),
        ).toHaveLength(1),
      );
    } finally {
      await context.broker.close();
    }
  });

  it("does not lose a successor registration while a deferred stop is waiting", async () => {
    const context = harness();
    const input = sharedInput(1);
    try {
      const attached =
        await context.broker.createSharedSessionAttachment(input);
      const firstLease = context.broker.acquireRegistrationLease({
        authSessionId,
        explorerId: "explorer-first-pending",
        ownerId,
        sessionId: input.sessionId,
        tunnelId: "99999999-9999-4999-8999-999999999991",
      });
      expect(firstLease).not.toBeNull();

      await context.broker.revokeSharedSessionAttachment({
        attachmentId: attached.session.attachmentId,
        authSessionId,
        ownerId,
      });
      const secondLease = context.broker.acquireRegistrationLease({
        authSessionId,
        explorerId: "explorer-second-pending",
        ownerId,
        sessionId: input.sessionId,
        tunnelId: "99999999-9999-4999-8999-999999999992",
      });
      expect(secondLease).not.toBeNull();

      context.broker.releaseRegistrationLease(firstLease!);
      await Promise.resolve();
      expect(
        context.request.mock.calls.filter(
          ([, command]) => command.type === "code.stop",
        ),
      ).toHaveLength(0);

      context.broker.releaseRegistrationLease(secondLease!);
      await vi.waitFor(() =>
        expect(
          context.request.mock.calls.filter(
            ([, command]) => command.type === "code.stop",
          ),
        ).toHaveLength(1),
      );
    } finally {
      await context.broker.close();
    }
  });

  it("retries a failed deferred conditional session stop", async () => {
    vi.useFakeTimers();
    const context = harness({ idleTtlMs: 100 });
    const input = sharedInput(1);
    let stopAttempts = 0;
    context.request.mockImplementation(async (_workerId, command) => {
      if (command.type === "code.stop" && stopAttempts++ === 0) {
        throw new Error("conditional session stop unavailable");
      }
      return workerCommandResult(command);
    });
    try {
      const attached =
        await context.broker.createSharedSessionAttachment(input);
      const lease = context.broker.acquireRegistrationLease({
        authSessionId,
        explorerId: "explorer-pending",
        ownerId,
        sessionId: input.sessionId,
        tunnelId: "99999999-9999-4999-8999-999999999993",
      });
      expect(lease).not.toBeNull();

      await context.broker.revokeSharedSessionAttachment({
        attachmentId: attached.session.attachmentId,
        authSessionId,
        ownerId,
      });
      context.broker.releaseRegistrationLease(lease!);
      await vi.advanceTimersByTimeAsync(1);
      expect(stopAttempts).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(stopAttempts).toBe(2);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(stopAttempts).toBe(2);
    } finally {
      await context.broker.close();
      vi.useRealTimers();
    }
  });

  it("fails shutdown closed when a deferred session stop remains incomplete", async () => {
    const context = harness();
    const input = sharedInput(1);
    context.request.mockImplementation(async (_workerId, command) => {
      if (command.type === "code.stop") {
        throw new Error("conditional session stop remains unavailable");
      }
      return workerCommandResult(command);
    });
    const attached = await context.broker.createSharedSessionAttachment(input);
    const lease = context.broker.acquireRegistrationLease({
      authSessionId,
      explorerId: "explorer-pending",
      ownerId,
      sessionId: input.sessionId,
      tunnelId: "99999999-9999-4999-8999-999999999994",
    });
    expect(lease).not.toBeNull();

    await context.broker.revokeSharedSessionAttachment({
      attachmentId: attached.session.attachmentId,
      authSessionId,
      ownerId,
    });
    context.broker.releaseRegistrationLease(lease!);
    await vi.waitFor(() =>
      expect(
        context.request.mock.calls.filter(
          ([, command]) => command.type === "code.stop",
        ),
      ).toHaveLength(1),
    );

    await expect(context.broker.close()).rejects.toThrow(
      "Could not revoke every protected Cantrip Code attachment during shutdown",
    );
  });

  it("rejects a new shared acquisition while its exact session stop is in flight", async () => {
    const context = harness();
    const stop = deferred<unknown>();
    const input = sharedInput(1);
    try {
      const attached =
        await context.broker.createSharedSessionAttachment(input);
      context.request.mockImplementation(async (_workerId, command) => {
        if (command.type === "code.stop") return stop.promise;
        return workerCommandResult(command);
      });
      const release = context.broker.revokeSharedSessionAttachment({
        attachmentId: attached.session.attachmentId,
        authSessionId,
        ownerId,
      });
      await vi.waitFor(() =>
        expect(
          context.request.mock.calls.some(
            ([, command]) => command.type === "code.stop",
          ),
        ).toBe(true),
      );

      await expect(
        context.broker.createSharedSessionAttachment(
          sharedInput(2, {
            runtime: input.runtime,
            sessionId: input.sessionId,
          }),
        ),
      ).rejects.toThrow("security identity is being revoked");

      stop.resolve(
        workerCommandResult({
          type: "code.stop",
          expectedSessionIncarnationId: input.runtime.sessionIncarnationId!,
          sessionId: input.sessionId,
        }),
      );
      await expect(release).resolves.toBe(true);
    } finally {
      stop.resolve(
        workerCommandResult({
          type: "code.stop",
          expectedSessionIncarnationId: input.runtime.sessionIncarnationId!,
          sessionId: input.sessionId,
        }),
      );
      await context.broker.close().catch(() => undefined);
    }
  });

  it("serializes a reused attachment id across different security identities", async () => {
    const context = harness();
    const secondTransportId = "55555555-5555-4555-8555-555555555555";
    try {
      const results = await Promise.allSettled([
        context.broker.createSharedSessionAttachment(sharedInput(1)),
        context.broker.createSharedSessionAttachment(
          sharedInput(1, {
            authSessionId: "auth-session-2",
            transport: {
              formatVersion: 2,
              transportId: secondTransportId,
              protectedRecord: protectedRecord(secondTransportId),
            },
          }),
        ),
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 1,
        transports: 1,
      });
    } finally {
      await context.broker.close();
    }
  });

  it("revokes only one Explorer's children on retarget", async () => {
    const context = harness();
    try {
      await context.broker.createSharedSessionAttachment(sharedInput(1));
      await context.broker.createSharedSessionAttachment(
        sharedInput(2, { explorerId: "explorer-2" }),
      );

      await context.broker.mutateExplorer(
        ownerId,
        "explorer-1",
        async () => true,
        Boolean,
      );

      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 1,
        transports: 1,
      });
      expect(context.removeManagedTunnel).not.toHaveBeenCalled();
    } finally {
      await context.broker.close();
    }
  });

  it("fails closed by retiring the root when route revocation fails", async () => {
    const context = harness();
    try {
      const first = await context.broker.createSharedSessionAttachment(
        sharedInput(1),
      );
      await context.broker.createSharedSessionAttachment(sharedInput(2));
      context.request.mockImplementation(async (_workerId, command) => {
        if (command.type === "code.transport.route.revoke") {
          throw new Error("route control unavailable");
        }
        return workerCommandResult(command);
      });

      await expect(
        context.broker.revokeSharedSessionAttachment({
          attachmentId: first.session.attachmentId,
          authSessionId,
          ownerId,
        }),
      ).rejects.toThrow();

      expect(context.removeManagedTunnel).toHaveBeenCalledOnce();
      expect(context.cleanup).toHaveBeenCalledOnce();
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 0,
        transports: 0,
      });
    } finally {
      await context.broker.close().catch(() => undefined);
    }
  });

  it("rolls back a failed route authorization without disturbing siblings", async () => {
    const context = harness();
    try {
      await context.broker.createSharedSessionAttachment(sharedInput(1));
      const secondAttachmentId = sharedInput(2).attachmentId;
      context.request.mockImplementation(async (_workerId, command) => {
        if (
          command.type === "code.transport.route.authorize" &&
          command.attachmentId === secondAttachmentId
        ) {
          throw new Error("route authorization rejected");
        }
        return workerCommandResult(command);
      });

      await expect(
        context.broker.createSharedSessionAttachment(sharedInput(2)),
      ).rejects.toThrow("route authorization rejected");

      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 1,
        transports: 1,
      });
      expect(context.removeManagedTunnel).not.toHaveBeenCalled();
      expect(context.cleanup).not.toHaveBeenCalled();
      expect(
        context.request.mock.calls.some(
          ([, command]) =>
            command.type === "code.transport.route.revoke" &&
            command.attachmentId === secondAttachmentId,
        ),
      ).toBe(true);
    } finally {
      await context.broker.close();
    }
  });

  it("retires the shared root when authorization rollback is ambiguous", async () => {
    const context = harness();
    try {
      await context.broker.createSharedSessionAttachment(sharedInput(1));
      const secondAttachmentId = sharedInput(2).attachmentId;
      context.request.mockImplementation(async (_workerId, command) => {
        if (
          command.attachmentId === secondAttachmentId &&
          (command.type === "code.transport.route.authorize" ||
            command.type === "code.transport.route.revoke")
        ) {
          throw new Error("route control result is unknown");
        }
        return workerCommandResult(command);
      });

      await expect(
        context.broker.createSharedSessionAttachment(sharedInput(2)),
      ).rejects.toThrow("route control result is unknown");

      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 0,
        transports: 0,
      });
      expect(context.removeManagedTunnel).toHaveBeenCalledOnce();
      expect(context.cleanup).toHaveBeenCalledOnce();
    } finally {
      await context.broker.close();
    }
  });

  it("rejects an attachment whose authorization overlaps auth revocation", async () => {
    const context = harness();
    const authorization = deferred<unknown>();
    context.request.mockImplementation(async (_workerId, command) => {
      if (command.type === "code.transport.route.authorize") {
        return authorization.promise;
      }
      return workerCommandResult(command);
    });
    try {
      const create = context.broker.createSharedSessionAttachment(
        sharedInput(1),
      );
      await vi.waitFor(() =>
        expect(
          context.request.mock.calls.some(
            ([, command]) => command.type === "code.transport.route.authorize",
          ),
        ).toBe(true),
      );
      const revoke = context.broker.revokeAuthSession(authSessionId);
      const authorizeCommand = context.request.mock.calls.find(
        ([, command]) => command.type === "code.transport.route.authorize",
      )?.[1];
      expect(authorizeCommand).toBeDefined();
      authorization.resolve(workerCommandResult(authorizeCommand!));

      await expect(create).rejects.toThrow("identity changed");
      await expect(revoke).resolves.toBeUndefined();
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 0,
        transports: 0,
      });
    } finally {
      const authorizeCommand = context.request.mock.calls.find(
        ([, command]) => command.type === "code.transport.route.authorize",
      )?.[1];
      if (authorizeCommand) {
        authorization.resolve(workerCommandResult(authorizeCommand));
      }
      await context.broker.close();
    }
  });

  it("sweeps a lease that finishes attaching while logout waits", async () => {
    const context = harness();
    const input = sharedInput(1);
    const lease = context.broker.acquireRegistrationLease({
      authSessionId,
      explorerId: input.explorerId,
      ownerId,
      sessionId: input.sessionId,
      tunnelId: input.attachmentId,
    });
    expect(lease).not.toBeNull();
    try {
      const revoke = context.broker.revokeAuthSession(authSessionId);
      await Promise.resolve();
      await Promise.resolve();

      await expect(
        context.broker.createSharedSessionAttachment({
          ...input,
          registrationLease: lease!,
        }),
      ).rejects.toThrow("Explorer changed");
      context.broker.releaseRegistrationLease(lease!);

      await expect(revoke).resolves.toBeUndefined();
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 0,
        transports: 0,
      });
    } finally {
      context.broker.releaseRegistrationLease(lease!);
      await context.broker.close();
    }
  });

  it("does not recreate a transport with a superseded key revision", async () => {
    const context = harness();
    const secondTransportId = "55555555-5555-4555-8555-555555555555";
    try {
      const first = await context.broker.createSharedSessionAttachment(
        sharedInput(1),
      );
      await context.broker.revokeSharedSessionAttachment({
        attachmentId: first.session.attachmentId,
        authSessionId,
        ownerId,
      });
      context.addTransportGrantRevision(6);

      await expect(
        context.broker.createSharedSessionAttachment(
          sharedInput(2, {
            protectedKeyRevision: 6,
            transport: {
              formatVersion: 2,
              transportId: secondTransportId,
              protectedRecord: protectedRecord(secondTransportId, 6),
            },
          }),
        ),
      ).rejects.toThrow("latest active worker tunnel-content");
      expect(context.registerManagedTunnel).toHaveBeenCalledOnce();
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 0,
        transports: 0,
      });
    } finally {
      await context.broker.close();
    }
  });

  it("rejects new attachment creation after its tunnel-content grant is revoked", async () => {
    const context = harness();
    try {
      context.setTransportGrantActive(false);

      await expect(
        context.broker.createSharedSessionAttachment(sharedInput(1)),
      ).rejects.toThrow("latest active worker tunnel-content");
      expect(context.registerManagedTunnel).not.toHaveBeenCalled();
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 0,
        transports: 0,
      });
    } finally {
      await context.broker.close();
    }
  });

  it("rejects a stale active grant revision in a cold registry", async () => {
    const context = harness();
    context.addTransportGrantRevision(8);
    try {
      await expect(
        context.broker.createSharedSessionAttachment(sharedInput(1)),
      ).rejects.toThrow("latest active worker tunnel-content");
      expect(context.registerManagedTunnel).not.toHaveBeenCalled();
    } finally {
      await context.broker.close();
    }
  });

  it("fences an in-flight route when its worker security grant is revoked", async () => {
    const context = harness();
    const authorization = deferred<unknown>();
    context.request.mockImplementation(async (_workerId, command) => {
      if (command.type === "code.transport.route.authorize") {
        return authorization.promise;
      }
      return workerCommandResult(command);
    });
    try {
      const create = context.broker.createSharedSessionAttachment(
        sharedInput(1),
      );
      await vi.waitFor(() =>
        expect(
          context.request.mock.calls.some(
            ([, command]) => command.type === "code.transport.route.authorize",
          ),
        ).toBe(true),
      );
      const revoke = context.broker.revokeSharedWorkerSecurity(
        ownerId,
        workerId,
        7,
      );
      const authorizeCommand = context.request.mock.calls.find(
        ([, command]) => command.type === "code.transport.route.authorize",
      )?.[1];
      expect(authorizeCommand).toBeDefined();
      authorization.resolve(workerCommandResult(authorizeCommand!));

      await expect(create).rejects.toThrow("identity changed");
      await expect(revoke).resolves.toBeUndefined();
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 0,
        transports: 0,
      });
    } finally {
      const authorizeCommand = context.request.mock.calls.find(
        ([, command]) => command.type === "code.transport.route.authorize",
      )?.[1];
      if (authorizeCommand) {
        authorization.resolve(workerCommandResult(authorizeCommand));
      }
      await context.broker.close();
    }
  });

  it("never reuses a transport id whose worker retirement was ambiguous", async () => {
    const context = harness();
    try {
      const attached = await context.broker.createSharedSessionAttachment(
        sharedInput(1),
      );
      context.request.mockImplementation(async (_workerId, command) => {
        if (command.type === "code.transport.revoke") {
          throw new Error("transport revoke result is unknown");
        }
        return workerCommandResult(command);
      });

      await expect(
        context.broker.revokeSharedSessionAttachment({
          attachmentId: attached.session.attachmentId,
          authSessionId,
          ownerId,
        }),
      ).rejects.toThrow("Could not clean up every shared");
      context.request.mockImplementation(async (_workerId, command) =>
        workerCommandResult(command),
      );

      await expect(
        context.broker.createSharedSessionAttachment(sharedInput(2)),
      ).rejects.toThrow("transport identity was already retired");
      expect(context.registerManagedTunnel).toHaveBeenCalledOnce();
    } finally {
      await context.broker.close().catch(() => undefined);
    }
  });

  it("reserves transport capacity across concurrent security identities", async () => {
    const context = harness({ maxAttachments: 1 });
    const secondTransportId = "55555555-5555-4555-8555-555555555555";
    try {
      const results = await Promise.allSettled([
        context.broker.createSharedSessionAttachment(sharedInput(1)),
        context.broker.createSharedSessionAttachment(
          sharedInput(2, {
            authSessionId: "auth-session-2",
            transport: {
              formatVersion: 2,
              protectedRecord: protectedRecord(secondTransportId),
              transportId: secondTransportId,
            },
          }),
        ),
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect(context.registerManagedTunnel).toHaveBeenCalledOnce();
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 1,
        transports: 1,
      });
    } finally {
      await context.broker.close();
    }
  });

  it("reserves session capacity across concurrent transport roots", async () => {
    const context = harness({ maxAttachments: 2 });
    const secondTransportId = "55555555-5555-4555-8555-555555555555";
    const secondRootInput = (index: number) =>
      sharedInput(index, {
        authSessionId: "auth-session-2",
        transport: {
          formatVersion: 2 as const,
          protectedRecord: protectedRecord(secondTransportId),
          transportId: secondTransportId,
        },
      });
    try {
      await Promise.all(
        [1, 2, 3, 4].map((index) =>
          context.broker.createSharedSessionAttachment(sharedInput(index)),
        ),
      );
      await Promise.all(
        [5, 6, 7].map((index) =>
          context.broker.createSharedSessionAttachment(secondRootInput(index)),
        ),
      );

      const results = await Promise.allSettled([
        context.broker.createSharedSessionAttachment(sharedInput(8)),
        context.broker.createSharedSessionAttachment(secondRootInput(9)),
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 8,
        transports: 2,
      });
    } finally {
      await context.broker.close();
    }
  });

  it("rolls back a route that expires while worker authorization is in flight", async () => {
    let now = 1_000;
    const context = harness({
      idleTtlMs: 100,
      maxLifetimeMs: 1_000,
      now: () => now,
    });
    context.request.mockImplementation(async (_workerId, command) => {
      if (command.type === "code.transport.route.authorize") now = 1_101;
      return workerCommandResult(command);
    });
    try {
      await expect(
        context.broker.createSharedSessionAttachment(sharedInput(1)),
      ).rejects.toThrow("expired while it was being authorized");
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 0,
        transports: 0,
      });
      expect(context.removeManagedTunnel).toHaveBeenCalledOnce();
    } finally {
      await context.broker.close();
    }
  });

  it("retires a root when its renewed route expires during authorization", async () => {
    let now = 1_000;
    let expireAuthorization = false;
    const context = harness({
      idleTtlMs: 100,
      maxLifetimeMs: 1_000,
      now: () => now,
    });
    context.request.mockImplementation(async (_workerId, command) => {
      if (
        expireAuthorization &&
        command.type === "code.transport.route.authorize"
      ) {
        now = 1_151;
      }
      return workerCommandResult(command);
    });
    try {
      const attached = await context.broker.createSharedSessionAttachment(
        sharedInput(1),
      );
      now = 1_050;
      expireAuthorization = true;

      await expect(
        context.broker.renewSharedSessionAttachment({
          attachmentId: attached.session.attachmentId,
          authSessionId,
          ownerId,
        }),
      ).rejects.toThrow("expired while its lease was renewing");
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 0,
        transports: 0,
      });
    } finally {
      await context.broker.close();
    }
  });

  it("rejects a worker authorization acknowledgement for another session incarnation", async () => {
    const context = harness();
    context.request.mockImplementation(async (_workerId, command) => {
      const result = workerCommandResult(command);
      if (command.type !== "code.transport.route.authorize") return result;
      return {
        ...(result as Record<string, unknown>),
        sessionIncarnationId: "99999999-9999-4999-8999-999999999999",
      };
    });
    try {
      await expect(
        context.broker.createSharedSessionAttachment(sharedInput(1)),
      ).rejects.toThrow("different shared Code route authorization");
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 0,
        transports: 0,
      });
    } finally {
      await context.broker.close();
    }
  });

  it("cancels an exact session attachment racing its creation", async () => {
    const context = harness();
    const authorization = deferred<unknown>();
    context.request.mockImplementation(async (_workerId, command) => {
      if (command.type === "code.transport.route.authorize") {
        return authorization.promise;
      }
      return workerCommandResult(command);
    });
    const input = sharedInput(1);
    try {
      const create = context.broker.createSharedSessionAttachment(input);
      await vi.waitFor(() =>
        expect(
          context.request.mock.calls.some(
            ([, command]) => command.type === "code.transport.route.authorize",
          ),
        ).toBe(true),
      );
      const revoke = context.broker.revokeSharedSessionAttachment({
        attachmentId: input.attachmentId,
        authSessionId,
        ownerId,
      });
      const authorizeCommand = context.request.mock.calls.find(
        ([, command]) => command.type === "code.transport.route.authorize",
      )![1];
      authorization.resolve(workerCommandResult(authorizeCommand));

      await expect(create).rejects.toThrow(/revok/u);
      await expect(revoke).resolves.toBe(true);
      await expect(
        context.broker.createSharedSessionAttachment(input),
      ).rejects.toThrow(/retired/u);
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 0,
        transports: 0,
      });
    } finally {
      const authorizeCommand = context.request.mock.calls.find(
        ([, command]) => command.type === "code.transport.route.authorize",
      )?.[1];
      if (authorizeCommand) {
        authorization.resolve(workerCommandResult(authorizeCommand));
      }
      await context.broker.close();
    }
  });

  it("drains an in-flight shared registration before shutdown completes", async () => {
    const context = harness();
    const authorization = deferred<unknown>();
    context.request.mockImplementation(async (_workerId, command) => {
      if (command.type === "code.transport.route.authorize") {
        return authorization.promise;
      }
      return workerCommandResult(command);
    });
    const input = sharedInput(1);
    const create = context.broker.createSharedSessionAttachment(input);
    await vi.waitFor(() =>
      expect(
        context.request.mock.calls.some(
          ([, command]) => command.type === "code.transport.route.authorize",
        ),
      ).toBe(true),
    );

    let closeSettled = false;
    const close = context.broker.close().finally(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    const authorizeCommand = context.request.mock.calls.find(
      ([, command]) => command.type === "code.transport.route.authorize",
    )![1];
    authorization.resolve(workerCommandResult(authorizeCommand));

    await expect(create).rejects.toThrow(/shutting down/u);
    await expect(close).resolves.toBeUndefined();
    expect(context.broker.sharedTransportStats()).toEqual({
      sessionAttachments: 0,
      transports: 0,
    });
    expect(context.removeManagedTunnel).toHaveBeenCalledWith(ownerId, {
      id: transportId,
      kind: "code",
    });
  });

  it("cancels an exact transport racing its creation and rejects delayed reuse", async () => {
    const context = harness();
    const authorization = deferred<unknown>();
    context.request.mockImplementation(async (_workerId, command) => {
      if (command.type === "code.transport.route.authorize") {
        return authorization.promise;
      }
      return workerCommandResult(command);
    });
    const input = sharedInput(1);
    try {
      const create = context.broker.createSharedSessionAttachment(input);
      await vi.waitFor(() =>
        expect(
          context.request.mock.calls.some(
            ([, command]) => command.type === "code.transport.route.authorize",
          ),
        ).toBe(true),
      );
      const revoke = context.broker.revokeSharedTransport(
        ownerId,
        authSessionId,
        transportId,
      );
      const authorizeCommand = context.request.mock.calls.find(
        ([, command]) => command.type === "code.transport.route.authorize",
      )![1];
      authorization.resolve(workerCommandResult(authorizeCommand));

      await expect(create).rejects.toThrow(/revok/u);
      await expect(revoke).resolves.toBe(true);
      await expect(
        context.broker.createSharedSessionAttachment(input),
      ).rejects.toThrow(/retired|revok/u);
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 0,
        transports: 0,
      });
    } finally {
      const authorizeCommand = context.request.mock.calls.find(
        ([, command]) => command.type === "code.transport.route.authorize",
      )?.[1];
      if (authorizeCommand) {
        authorization.resolve(workerCommandResult(authorizeCommand));
      }
      await context.broker.close();
    }
  });

  it("rejects a delayed transport create after DELETE observed no live root", async () => {
    const context = harness();
    const input = sharedInput(1);
    try {
      await expect(
        context.broker.revokeSharedTransport(
          ownerId,
          authSessionId,
          transportId,
        ),
      ).resolves.toBe(false);
      await expect(
        context.broker.createSharedSessionAttachment(input),
      ).rejects.toThrow(/revoked/u);
      expect(context.registerManagedTunnel).not.toHaveBeenCalled();
    } finally {
      await context.broker.close();
    }
  });

  it("does not let one auth identity cancel another identity's in-flight attachment", async () => {
    const context = harness();
    const authorization = deferred<unknown>();
    context.request.mockImplementation(async (_workerId, command) => {
      if (command.type === "code.transport.route.authorize") {
        return authorization.promise;
      }
      return workerCommandResult(command);
    });
    const input = sharedInput(1, { authSessionId: "auth-session-2" });
    try {
      const create = context.broker.createSharedSessionAttachment(input);
      await vi.waitFor(() =>
        expect(
          context.request.mock.calls.some(
            ([, command]) => command.type === "code.transport.route.authorize",
          ),
        ).toBe(true),
      );
      const otherAuthRevoke = context.broker.revokeSharedSessionAttachment({
        attachmentId: input.attachmentId,
        authSessionId,
        ownerId,
      });
      const authorizeCommand = context.request.mock.calls.find(
        ([, command]) => command.type === "code.transport.route.authorize",
      )![1];
      authorization.resolve(workerCommandResult(authorizeCommand));

      await expect(otherAuthRevoke).resolves.toBe(false);
      await expect(create).resolves.toMatchObject({
        session: { attachmentId: input.attachmentId },
      });
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 1,
        transports: 1,
      });
    } finally {
      const authorizeCommand = context.request.mock.calls.find(
        ([, command]) => command.type === "code.transport.route.authorize",
      )?.[1];
      if (authorizeCommand) {
        authorization.resolve(workerCommandResult(authorizeCommand));
      }
      await context.broker.close();
    }
  });

  it("bounds one-shot identity tombstones to the maximum resource lifetime", async () => {
    let now = 1_000;
    const context = harness({ maxLifetimeMs: 100, now: () => now });
    const input = sharedInput(1);
    try {
      const attached =
        await context.broker.createSharedSessionAttachment(input);
      await context.broker.revokeSharedSessionAttachment({
        attachmentId: attached.session.attachmentId,
        authSessionId,
        ownerId,
      });
      await expect(
        context.broker.createSharedSessionAttachment(input),
      ).rejects.toThrow(/retired/u);

      now = 1_101;
      await expect(
        context.broker.createSharedSessionAttachment(input),
      ).resolves.toMatchObject({
        session: { attachmentId: input.attachmentId },
        transport: { transportId: input.transport.transportId },
      });
    } finally {
      await context.broker.close();
    }
  });

  it("bounds absent DELETE lifecycle fences without unsafe eviction", async () => {
    let now = 1_000;
    const context = harness({
      maxLifecycleTombstones: 2,
      maxLifetimeMs: 100,
      now: () => now,
    });
    try {
      await expect(
        context.broker.revokeSharedTransport(
          ownerId,
          authSessionId,
          "55555555-5555-4555-8555-555555555555",
        ),
      ).resolves.toBe(false);
      await expect(
        context.broker.revokeSharedSessionAttachment({
          attachmentId: "66666666-6666-4666-8666-666666666666",
          authSessionId,
          ownerId,
        }),
      ).resolves.toBe(false);
      await expect(
        context.broker.revokeSharedTransport(
          ownerId,
          authSessionId,
          "77777777-7777-4777-8777-777777777777",
        ),
      ).rejects.toThrow("lifecycle fence limit");

      const otherOwnerId = "owner-2";
      const otherAuthSessionId = "auth-session-2";
      const otherTransportId = "88888888-8888-4888-8888-888888888888";
      await expect(
        context.broker.createSharedSessionAttachment(
          sharedInput(8, {
            authSessionId: otherAuthSessionId,
            ownerId: otherOwnerId,
            transport: {
              formatVersion: 2,
              protectedRecord: protectedRecord(otherTransportId),
              transportId: otherTransportId,
            },
          }),
        ),
      ).resolves.toMatchObject({
        session: { attachmentId: "22222222-2222-4222-8222-000000000008" },
        transport: { transportId: otherTransportId },
      });

      now = 1_101;
      await expect(
        context.broker.revokeSharedTransport(
          ownerId,
          authSessionId,
          "77777777-7777-4777-8777-777777777777",
        ),
      ).resolves.toBe(false);
    } finally {
      await context.broker.close();
    }
  });

  it("isolates authoritative lifecycle churn between security identities", async () => {
    const context = harness({ maxLifecycleTombstones: 2 });
    try {
      for (let index = 1; index <= 3; index += 1) {
        const candidateTransportId = `99999999-9999-4999-8999-${String(index).padStart(12, "0")}`;
        const attached = await context.broker.createSharedSessionAttachment(
          sharedInput(index, {
            transport: {
              formatVersion: 2,
              protectedRecord: protectedRecord(candidateTransportId),
              transportId: candidateTransportId,
            },
          }),
        );
        await context.broker.revokeSharedSessionAttachment({
          attachmentId: attached.session.attachmentId,
          authSessionId,
          ownerId,
        });
      }

      const exhaustedTransportId = "99999999-9999-4999-8999-000000000004";
      await expect(
        context.broker.createSharedSessionAttachment(
          sharedInput(4, {
            transport: {
              formatVersion: 2,
              protectedRecord: protectedRecord(exhaustedTransportId),
              transportId: exhaustedTransportId,
            },
          }),
        ),
      ).rejects.toThrow("authoritative lifecycle fence limit");

      const otherTransportId = "99999999-9999-4999-8999-000000000005";
      await expect(
        context.broker.createSharedSessionAttachment(
          sharedInput(5, {
            authSessionId: "auth-session-2",
            ownerId: "owner-2",
            transport: {
              formatVersion: 2,
              protectedRecord: protectedRecord(otherTransportId),
              transportId: otherTransportId,
            },
          }),
        ),
      ).resolves.toMatchObject({
        transport: { transportId: otherTransportId },
      });
    } finally {
      await context.broker.close();
    }
  });

  it("retries only incomplete exact retirement components", async () => {
    vi.useFakeTimers();
    const context = harness({ idleTtlMs: 100 });
    let sessionStopFailures = 0;
    let workerTransportFailures = 0;
    context.request.mockImplementation(
      async (_workerId: string, command: WorkerCommand) => {
        if (
          command.type === "code.transport.revoke" &&
          workerTransportFailures === 0
        ) {
          workerTransportFailures += 1;
          throw new Error("worker transport cleanup unavailable");
        }
        if (command.type === "code.stop" && sessionStopFailures === 0) {
          sessionStopFailures += 1;
          throw new Error("session stop unavailable");
        }
        return workerCommandResult(command);
      },
    );
    context.removeManagedTunnel.mockRejectedValueOnce(
      new Error("managed tunnel cleanup unavailable"),
    );
    context.cleanup.mockRejectedValueOnce(
      new Error("relay cleanup unavailable"),
    );
    try {
      const attached = await context.broker.createSharedSessionAttachment(
        sharedInput(1),
      );
      await expect(
        context.broker.revokeSharedSessionAttachment({
          attachmentId: attached.session.attachmentId,
          authSessionId,
          ownerId,
        }),
      ).rejects.toThrow("Could not clean up every shared Cantrip Code");

      expect(context.removeManagedTunnel).toHaveBeenCalledOnce();
      expect(context.cleanup).toHaveBeenCalledOnce();
      expect(
        context.request.mock.calls.filter(
          ([, command]) => command.type === "code.transport.revoke",
        ),
      ).toHaveLength(1);
      expect(
        context.request.mock.calls.filter(
          ([, command]) => command.type === "code.stop",
        ),
      ).toHaveLength(1);
      expect(context.broker.sharedTransportStats()).toEqual({
        sessionAttachments: 0,
        transports: 0,
      });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(context.removeManagedTunnel).toHaveBeenCalledTimes(2);
      expect(context.cleanup).toHaveBeenCalledTimes(2);
      expect(
        context.request.mock.calls.filter(
          ([, command]) => command.type === "code.transport.revoke",
        ),
      ).toHaveLength(2);
      expect(
        context.request.mock.calls.filter(
          ([, command]) => command.type === "code.stop",
        ),
      ).toHaveLength(2);
      expect(
        context.request.mock.calls.filter(
          ([, command]) => command.type === "code.transport.route.revoke",
        ),
      ).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(context.removeManagedTunnel).toHaveBeenCalledTimes(2);
      expect(context.cleanup).toHaveBeenCalledTimes(2);
      expect(
        context.request.mock.calls.filter(
          ([, command]) => command.type === "code.stop",
        ),
      ).toHaveLength(2);
    } finally {
      await context.broker.close();
      vi.useRealTimers();
    }
  });

  it("retries an incomplete retirement past its TTL and fails shutdown closed", async () => {
    let now = 1_000;
    const context = harness({
      idleTtlMs: 100,
      maxLifetimeMs: 100,
      now: () => now,
    });
    context.cleanup.mockRejectedValue(
      new Error("relay cleanup remains unavailable"),
    );
    try {
      const attached = await context.broker.createSharedSessionAttachment(
        sharedInput(1),
      );
      await expect(
        context.broker.revokeSharedSessionAttachment({
          attachmentId: attached.session.attachmentId,
          authSessionId,
          ownerId,
        }),
      ).rejects.toThrow("Could not clean up every shared Cantrip Code");

      now = 1_101;
      await expect(
        context.broker.createSharedSessionAttachment(sharedInput(2)),
      ).rejects.toThrow("Could not clean up every shared Cantrip Code");
      await expect(context.broker.close()).rejects.toThrow(
        "Could not revoke every protected Cantrip Code attachment during shutdown",
      );
      expect(context.cleanup).toHaveBeenCalledTimes(3);
    } finally {
      await context.broker.close().catch(() => undefined);
    }
  });

  it("cascades every child when the worker becomes terminally offline", async () => {
    const context = harness();
    try {
      await context.broker.createSharedSessionAttachment(sharedInput(1));
      await context.broker.createSharedSessionAttachment(sharedInput(2));

      context.offlineListeners.get(workerId)?.();

      await vi.waitFor(() =>
        expect(context.broker.sharedTransportStats()).toEqual({
          sessionAttachments: 0,
          transports: 0,
        }),
      );
      expect(context.removeManagedTunnel).toHaveBeenCalledOnce();
    } finally {
      await context.broker.close();
    }
  });

  it("treats a pending worker retirement as complete after terminal offline", async () => {
    const context = harness();
    let closed = false;
    context.request.mockImplementation(async (_workerId, command) => {
      if (command.type === "code.transport.revoke") {
        throw new Error("worker transport cleanup unavailable");
      }
      return workerCommandResult(command);
    });
    try {
      const attached = await context.broker.createSharedSessionAttachment(
        sharedInput(1),
      );
      await expect(
        context.broker.revokeSharedSessionAttachment({
          attachmentId: attached.session.attachmentId,
          authSessionId,
          ownerId,
        }),
      ).rejects.toThrow("Could not clean up every shared Cantrip Code");
      expect(context.offlineListeners.has(workerId)).toBe(true);

      context.offlineListeners.get(workerId)?.();

      await vi.waitFor(() =>
        expect(context.offlineListeners.has(workerId)).toBe(false),
      );
      await expect(context.broker.close()).resolves.toBeUndefined();
      closed = true;
      expect(
        context.request.mock.calls.filter(
          ([, command]) => command.type === "code.transport.revoke",
        ),
      ).toHaveLength(1);
    } finally {
      if (!closed) await context.broker.close().catch(() => undefined);
    }
  });
});
