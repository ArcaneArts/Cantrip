import type { WorkerCommand, WorkerSummary } from "@cantrip/protocol";
import {
  createServiceLogEmitter,
  minimizeServiceLogRecordInput,
  type ServiceLogRecordInput,
} from "@cantrip/logging";
import { describe, expect, it, vi } from "vitest";

import {
  DirectAttachmentCoordinator,
  DirectAttachmentUnavailableError,
  type DirectAttachmentPrepareInput,
} from "../src/direct-attachments/coordinator.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";
import { WorkerUnavailableError } from "../src/workers/bridge.js";

function worker(leaseRenewal = false): WorkerSummary {
  return {
    workerId: "worker-1",
    name: "Worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: null,
    codexRuntime: {
      adapter: "app-server",
      compatibility: "missing",
      version: null,
      testedRange: ">=0.149.0 <0.150.0",
      initialize: null,
      methods: {},
      features: [],
      degradedReasons: ["unavailable"],
    },
    remoteSurfaces: {
      browser: false,
      desktop: false,
      transports: ["websocket"],
      iceTransportPolicies: ["relay"],
      maxSessions: 4,
    },
    directBroker: {
      available: true,
      leaseRenewal,
      protocol: "ws-v1",
      loopbackHost: "127.0.0.1",
      loopbackPort: 43123,
      instanceId: crypto.randomUUID(),
      publicKey: "a".repeat(43),
      fingerprint: "b".repeat(64),
    },
    projectReplicas: {
      provision: false,
      synchronize: false,
      remove: false,
      exactRevision: false,
    },
    chatRelocation: false,
    code: {
      available: false,
      version: null,
      upstreamRevision: null,
      patchset: 0,
      transport: "web-proxy",
      maxSessions: 1,
      reason: "unavailable",
    },
    online: true,
    startedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
}

function capturedLogger() {
  const records: ServiceLogRecordInput[] = [];
  return {
    logger: createServiceLogEmitter("server", {
      onRecord: (record) => records.push(record),
    }),
    records,
  };
}

function eventContext(
  records: ServiceLogRecordInput[],
  event: string,
): Record<string, unknown> {
  const record = records.find(
    (candidate) =>
      candidate.context &&
      typeof candidate.context === "object" &&
      !Array.isArray(candidate.context) &&
      (candidate.context as Record<string, unknown>).event === event,
  );
  expect(record, `Missing log event ${event}`).toBeDefined();
  return record!.context as Record<string, unknown>;
}

async function prepareDirect(
  coordinator: DirectAttachmentCoordinator,
  input: Omit<DirectAttachmentPrepareInput, "preparationLease">,
  fencedMessage = "The owning resource is being revoked.",
) {
  const preparationLease = coordinator.acquirePreparationLease({
    attachmentId: input.attachmentId,
    authSessionId: input.authSessionId,
    ownerId: input.ownerId,
    resourceId: input.resourceId,
    resourceKind: input.resourceKind,
  });
  if (!preparationLease) {
    throw new DirectAttachmentUnavailableError(fencedMessage);
  }
  try {
    return await coordinator.prepare({ ...input, preparationLease });
  } finally {
    coordinator.releasePreparationLease(preparationLease);
  }
}

describe("DirectAttachmentCoordinator", () => {
  it("rejects renewal at the fixed-expiry boundary before a delayed timer can resurrect it", async () => {
    const commands: WorkerCommand[] = [];
    const bus = {
      isConnected: () => true,
      request: vi.fn(async (_workerId: string, command: WorkerCommand) => {
        commands.push(command);
        if (command.type === "direct.capability.prepare") {
          return { accepted: true, capabilityId: command.binding.capabilityId };
        }
        if (command.type === "direct.capability.renew") {
          return { renewed: true, leaseExpiresAt: command.leaseExpiresAt };
        }
        return { revoked: true };
      }),
      subscribeWorkerDisconnect: () => () => undefined,
    } as unknown as WorkerCommandBus;
    const coordinator = new DirectAttachmentCoordinator(bus);
    const ticket = await prepareDirect(coordinator, {
      authSessionId: "session-1",
      channels: ["probe"],
      ownerId: "owner-1",
      resourceId: "worker-1",
      resourceKind: "probe",
      worker: worker(true),
    });
    coordinator.recordActivationOutcome(
      ticket.binding.capabilityId,
      {
        attachmentId: ticket.binding.attachmentId,
        authSessionId: "session-1",
        ownerId: "owner-1",
      },
      "completed",
    );

    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse(ticket.binding.leaseExpiresAt) + 1);
    try {
      await expect(
        coordinator.renewActiveLease(ticket.binding.capabilityId, {
          authSessionId: "session-1",
          ownerId: "owner-1",
        }),
      ).resolves.toMatchObject({ status: "expired" });
      expect(
        commands.filter(
          (command) => command.type === "direct.capability.renew",
        ),
      ).toHaveLength(0);
      expect(
        coordinator.matches(ticket.binding.capabilityId, {
          attachmentId: ticket.binding.attachmentId,
          authSessionId: "session-1",
          ownerId: "owner-1",
        }),
      ).toBe(false);
    } finally {
      now.mockRestore();
      await coordinator.close();
    }
  });

  it("keeps legacy workers compatible by treating lease renewal as unsupported", async () => {
    const commands: WorkerCommand[] = [];
    const bus = {
      isConnected: () => true,
      request: vi.fn(async (_workerId: string, command: WorkerCommand) => {
        commands.push(command);
        return command.type === "direct.capability.prepare"
          ? { accepted: true, capabilityId: command.binding.capabilityId }
          : { revoked: true };
      }),
      subscribeWorkerDisconnect: () => () => undefined,
    } as unknown as WorkerCommandBus;
    const coordinator = new DirectAttachmentCoordinator(bus);
    const ticket = await prepareDirect(coordinator, {
      authSessionId: "session-1",
      channels: ["probe"],
      ownerId: "owner-1",
      resourceId: "worker-1",
      resourceKind: "probe",
      worker: worker(),
    });
    coordinator.recordActivationOutcome(
      ticket.binding.capabilityId,
      {
        attachmentId: ticket.binding.attachmentId,
        authSessionId: "session-1",
        ownerId: "owner-1",
      },
      "completed",
    );
    try {
      await expect(
        coordinator.renewActiveLease(ticket.binding.capabilityId, {
          authSessionId: "session-1",
          ownerId: "owner-1",
        }),
      ).resolves.toEqual({ status: "unsupported" });
      expect(
        commands.filter(
          (command) => command.type === "direct.capability.renew",
        ),
      ).toHaveLength(0);
    } finally {
      await coordinator.close();
    }
  });

  it("slides an exact Code root on heartbeat but renews the child only inside its stable window", async () => {
    const startedAtMs = Date.now();
    const hardExpiresAtMs = startedAtMs + 12 * 60 * 60_000;
    let rootExpiresAtMs = startedAtMs + 15 * 60_000;
    let rootValid = true;
    const generation = Symbol("code-root");
    const rootState = () =>
      rootValid
        ? {
            expiresAt: new Date(rootExpiresAtMs).toISOString(),
            generation,
            hardExpiresAt: new Date(hardExpiresAtMs).toISOString(),
          }
        : null;
    const authoritativeRoot = {
      ...rootState()!,
      recordActivity: () => {
        if (!rootValid) return null;
        rootExpiresAtMs = Math.min(hardExpiresAtMs, Date.now() + 15 * 60_000);
        return rootState();
      },
      validate: rootState,
    };
    const commands: WorkerCommand[] = [];
    const requestOptions: unknown[] = [];
    const bus = {
      isConnected: () => true,
      request: vi.fn(
        async (
          _workerId: string,
          command: WorkerCommand,
          options?: unknown,
        ) => {
          commands.push(command);
          requestOptions.push(options);
          if (command.type === "direct.capability.prepare") {
            return {
              accepted: true,
              capabilityId: command.binding.capabilityId,
            };
          }
          if (command.type === "direct.capability.renew") {
            return { renewed: true, leaseExpiresAt: command.leaseExpiresAt };
          }
          return { revoked: true };
        },
      ),
      subscribeWorkerDisconnect: () => () => undefined,
    } as unknown as WorkerCommandBus;
    const coordinator = new DirectAttachmentCoordinator(bus);
    const ticket = await prepareDirect(coordinator, {
      attachmentId: "desktop-attachment-1",
      authoritativeRoot,
      authSessionId: "session-1",
      channels: ["tunnel-data"],
      leaseExpiresAt: new Date(rootExpiresAtMs),
      maxLeaseExpiresAt: new Date(hardExpiresAtMs),
      ownerId: "owner-1",
      resourceId: "code-tunnel-1",
      resourceKind: "tunnel",
      tunnelRoute: {
        tunnelId: "code-tunnel-1",
        attachmentId: "desktop-attachment-1",
        sourceEndpointId: "desktop:client-1:desktop-attachment-1",
        destinationEndpointId: "worker:worker-1",
        target: { kind: "tcp", host: "127.0.0.1", port: 43124 },
      },
      worker: worker(true),
    });
    coordinator.recordActivationOutcome(
      ticket.binding.capabilityId,
      {
        attachmentId: ticket.binding.attachmentId,
        authSessionId: "session-1",
        ownerId: "owner-1",
      },
      "completed",
    );

    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(startedAtMs + 60_000);
      await expect(
        coordinator.renewActiveLease(ticket.binding.capabilityId, {
          authSessionId: "session-1",
          ownerId: "owner-1",
        }),
      ).resolves.toMatchObject({ status: "completed", renewed: false });
      expect(rootExpiresAtMs).toBe(startedAtMs + 16 * 60_000);
      expect(
        commands.filter(
          (command) => command.type === "direct.capability.renew",
        ),
      ).toHaveLength(0);

      now.mockReturnValue(startedAtMs + 14 * 60_000);
      await expect(
        coordinator.renewActiveLease(ticket.binding.capabilityId, {
          authSessionId: "session-1",
          ownerId: "owner-1",
        }),
      ).resolves.toMatchObject({ status: "completed", renewed: true });
      const renew = commands.find(
        (command) => command.type === "direct.capability.renew",
      );
      expect(renew).toMatchObject({
        type: "direct.capability.renew",
        capabilityId: ticket.binding.capabilityId,
        leaseExpiresAt: new Date(startedAtMs + 29 * 60_000).toISOString(),
      });
      expect(requestOptions.at(-1)).toMatchObject({
        ownerId: "owner-1",
        timeoutMs: 5_000,
      });

      rootValid = false;
      await expect(
        coordinator.renewActiveLease(ticket.binding.capabilityId, {
          authSessionId: "session-1",
          ownerId: "owner-1",
        }),
      ).resolves.toMatchObject({ status: "root-missing" });
    } finally {
      now.mockRestore();
      await coordinator.close();
    }
  });

  it("retains the original Code hard cap when renewing near maximum lifetime", async () => {
    const codeCreatedAtMs = 1_000_000;
    const hardExpiresAtMs = codeCreatedAtMs + 12 * 60 * 60_000;
    const prepareAtMs = hardExpiresAtMs - 15 * 60_000;
    let rootExpiresAtMs = hardExpiresAtMs - 30_000;
    const generation = Symbol("code-root-hard-cap");
    const rootState = () => ({
      expiresAt: new Date(rootExpiresAtMs).toISOString(),
      generation,
      hardExpiresAt: new Date(hardExpiresAtMs).toISOString(),
    });
    const authoritativeRoot = {
      ...rootState(),
      recordActivity: () => {
        rootExpiresAtMs = Math.min(hardExpiresAtMs, Date.now() + 15 * 60_000);
        return rootState();
      },
      validate: rootState,
    };
    const commands: WorkerCommand[] = [];
    const bus = {
      isConnected: () => true,
      request: vi.fn(async (_workerId: string, command: WorkerCommand) => {
        commands.push(command);
        if (command.type === "direct.capability.prepare") {
          return { accepted: true, capabilityId: command.binding.capabilityId };
        }
        if (command.type === "direct.capability.renew") {
          return { renewed: true, leaseExpiresAt: command.leaseExpiresAt };
        }
        return { revoked: true };
      }),
      subscribeWorkerDisconnect: () => () => undefined,
    } as unknown as WorkerCommandBus;
    const now = vi.spyOn(Date, "now").mockReturnValue(prepareAtMs);
    const coordinator = new DirectAttachmentCoordinator(bus);
    try {
      const ticket = await prepareDirect(coordinator, {
        attachmentId: "desktop-attachment-1",
        authoritativeRoot,
        authSessionId: "session-1",
        channels: ["tunnel-data"],
        leaseExpiresAt: new Date(rootExpiresAtMs),
        maxLeaseExpiresAt: new Date(hardExpiresAtMs),
        ownerId: "owner-1",
        resourceId: "code-tunnel-1",
        resourceKind: "tunnel",
        tunnelRoute: {
          tunnelId: "code-tunnel-1",
          attachmentId: "desktop-attachment-1",
          sourceEndpointId: "desktop:client-1:desktop-attachment-1",
          destinationEndpointId: "worker:worker-1",
          target: { kind: "tcp", host: "127.0.0.1", port: 43124 },
        },
        worker: worker(true),
      });
      coordinator.recordActivationOutcome(
        ticket.binding.capabilityId,
        {
          attachmentId: ticket.binding.attachmentId,
          authSessionId: "session-1",
          ownerId: "owner-1",
        },
        "completed",
      );
      now.mockReturnValue(hardExpiresAtMs - 90_000);
      await expect(
        coordinator.renewActiveLease(ticket.binding.capabilityId, {
          authSessionId: "session-1",
          ownerId: "owner-1",
        }),
      ).resolves.toMatchObject({
        leaseExpiresAt: new Date(hardExpiresAtMs).toISOString(),
        renewed: true,
        status: "completed",
      });
      expect(
        commands.filter(
          (command) => command.type === "direct.capability.renew",
        ),
      ).toEqual([
        expect.objectContaining({
          capabilityId: ticket.binding.capabilityId,
          leaseExpiresAt: new Date(hardExpiresAtMs).toISOString(),
        }),
      ]);
    } finally {
      now.mockRestore();
      await coordinator.close();
    }
  });

  it("keeps the old valid lease after a transient worker transport failure", async () => {
    const commands: WorkerCommand[] = [];
    const options: unknown[] = [];
    const bus = {
      isConnected: () => true,
      request: vi.fn(
        async (
          _workerId: string,
          command: WorkerCommand,
          requestOptions?: unknown,
        ) => {
          commands.push(command);
          options.push(requestOptions);
          if (command.type === "direct.capability.prepare") {
            return {
              accepted: true,
              capabilityId: command.binding.capabilityId,
            };
          }
          if (command.type === "direct.capability.renew") {
            throw new WorkerUnavailableError("Worker temporarily unavailable.");
          }
          return { revoked: true };
        },
      ),
      subscribeWorkerDisconnect: () => () => undefined,
    } as unknown as WorkerCommandBus;
    const coordinator = new DirectAttachmentCoordinator(bus);
    const ticket = await prepareDirect(coordinator, {
      attachmentId: "attachment-1",
      authSessionId: "session-1",
      channels: ["probe"],
      maxLeaseExpiresAt: new Date(Date.now() + 10 * 60_000),
      ownerId: "owner-1",
      resourceId: "worker-1",
      resourceKind: "probe",
      worker: worker(true),
    });
    coordinator.recordActivationOutcome(
      ticket.binding.capabilityId,
      {
        attachmentId: ticket.binding.attachmentId,
        authSessionId: "session-1",
        ownerId: "owner-1",
      },
      "completed",
    );
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse(ticket.binding.leaseExpiresAt) - 30_000);
    try {
      await expect(
        coordinator.renewActiveLease(ticket.binding.capabilityId, {
          authSessionId: "session-1",
          ownerId: "owner-1",
        }),
      ).resolves.toEqual({ status: "retryable-failure" });
      expect(options.at(-1)).toMatchObject({
        ownerId: "owner-1",
        timeoutMs: 5_000,
      });
      expect(
        commands.filter(
          (command) => command.type === "direct.capability.revoke",
        ),
      ).toHaveLength(0);
      expect(
        coordinator.matches(ticket.binding.capabilityId, {
          attachmentId: ticket.binding.attachmentId,
          authSessionId: "session-1",
          ownerId: "owner-1",
        }),
      ).toBe(true);
    } finally {
      now.mockRestore();
      await coordinator.close();
    }
  });

  it("fails closed when the worker no longer has the exact active grant", async () => {
    const commands: WorkerCommand[] = [];
    const bus = {
      isConnected: () => true,
      request: vi.fn(async (_workerId: string, command: WorkerCommand) => {
        commands.push(command);
        if (command.type === "direct.capability.prepare") {
          return { accepted: true, capabilityId: command.binding.capabilityId };
        }
        if (command.type === "direct.capability.renew") {
          return { renewed: false };
        }
        return { revoked: true };
      }),
      subscribeWorkerDisconnect: () => () => undefined,
    } as unknown as WorkerCommandBus;
    const coordinator = new DirectAttachmentCoordinator(bus);
    const ticket = await prepareDirect(coordinator, {
      attachmentId: "attachment-1",
      authSessionId: "session-1",
      channels: ["probe"],
      maxLeaseExpiresAt: new Date(Date.now() + 10 * 60_000),
      ownerId: "owner-1",
      resourceId: "worker-1",
      resourceKind: "probe",
      worker: worker(true),
    });
    coordinator.recordActivationOutcome(
      ticket.binding.capabilityId,
      {
        attachmentId: ticket.binding.attachmentId,
        authSessionId: "session-1",
        ownerId: "owner-1",
      },
      "completed",
    );
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse(ticket.binding.leaseExpiresAt) - 30_000);
    try {
      await expect(
        coordinator.renewActiveLease(ticket.binding.capabilityId, {
          authSessionId: "session-1",
          ownerId: "owner-1",
        }),
      ).resolves.toEqual({ status: "worker-rejected" });
      expect(
        coordinator.matches(ticket.binding.capabilityId, {
          attachmentId: ticket.binding.attachmentId,
          authSessionId: "session-1",
          ownerId: "owner-1",
        }),
      ).toBe(false);
      expect(commands.at(-1)).toMatchObject({
        type: "direct.capability.revoke",
        capabilityId: ticket.binding.capabilityId,
      });
    } finally {
      now.mockRestore();
      await coordinator.close();
    }
  });

  it("cannot resurrect a grant when resource revocation overtakes worker renewal", async () => {
    let releaseRenew!: () => void;
    let signalRenew!: () => void;
    const renewStarted = new Promise<void>((resolve) => {
      signalRenew = resolve;
    });
    const renewRelease = new Promise<void>((resolve) => {
      releaseRenew = resolve;
    });
    const commands: WorkerCommand[] = [];
    const bus = {
      isConnected: () => true,
      request: vi.fn(async (_workerId: string, command: WorkerCommand) => {
        commands.push(command);
        if (command.type === "direct.capability.prepare") {
          return { accepted: true, capabilityId: command.binding.capabilityId };
        }
        if (command.type === "direct.capability.renew") {
          signalRenew();
          await renewRelease;
          return { renewed: true, leaseExpiresAt: command.leaseExpiresAt };
        }
        return { revoked: true };
      }),
      subscribeWorkerDisconnect: () => () => undefined,
    } as unknown as WorkerCommandBus;
    const coordinator = new DirectAttachmentCoordinator(bus);
    const ticket = await prepareDirect(coordinator, {
      attachmentId: "attachment-1",
      authSessionId: "session-1",
      channels: ["probe"],
      maxLeaseExpiresAt: new Date(Date.now() + 10 * 60_000),
      ownerId: "owner-1",
      resourceId: "worker-1",
      resourceKind: "probe",
      worker: worker(true),
    });
    coordinator.recordActivationOutcome(
      ticket.binding.capabilityId,
      {
        attachmentId: ticket.binding.attachmentId,
        authSessionId: "session-1",
        ownerId: "owner-1",
      },
      "completed",
    );
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse(ticket.binding.leaseExpiresAt) - 30_000);
    try {
      const renewal = coordinator.renewActiveLease(
        ticket.binding.capabilityId,
        { authSessionId: "session-1", ownerId: "owner-1" },
      );
      await renewStarted;
      await coordinator.revokeResource("owner-1", "probe", "worker-1");
      releaseRenew();
      await expect(renewal).resolves.toMatchObject({ status: "missing" });
      expect(
        coordinator.matches(ticket.binding.capabilityId, {
          attachmentId: ticket.binding.attachmentId,
          authSessionId: "session-1",
          ownerId: "owner-1",
        }),
      ).toBe(false);
      expect(
        commands.filter(
          (command) => command.type === "direct.capability.revoke",
        ).length,
      ).toBeGreaterThanOrEqual(2);
    } finally {
      releaseRenew();
      now.mockRestore();
      await coordinator.close();
    }
  });
  it("fences an unbound tunnel route lease across resource revocation", async () => {
    const bus = {
      isConnected: () => true,
      request: vi.fn(async () => ({ revoked: true })),
      subscribeWorkerDisconnect: () => () => undefined,
    } as unknown as WorkerCommandBus;
    const coordinator = new DirectAttachmentCoordinator(bus);
    const unbound = coordinator.acquirePreparationLease({
      attachmentId: "attachment-1",
      authSessionId: "session-1",
      ownerId: "owner-1",
      resourceId: null,
      resourceKind: "tunnel",
    })!;
    const unrelatedBound = coordinator.acquirePreparationLease({
      attachmentId: "attachment-2",
      authSessionId: "session-1",
      ownerId: "owner-1",
      resourceId: "tunnel-2",
      resourceKind: "tunnel",
    })!;
    let cleanupFinished = false;
    const cleanup = coordinator
      .revokeResource("owner-1", "tunnel", "tunnel-1")
      .then(() => {
        cleanupFinished = true;
      });

    await Promise.resolve();
    expect(cleanupFinished).toBe(false);
    expect(
      coordinator.bindPreparationLease(unbound, "tunnel", "tunnel-1"),
    ).toBe(false);
    expect(coordinator.preparationLeaseIsActive(unbound)).toBe(false);
    expect(coordinator.preparationLeaseIsActive(unrelatedBound)).toBe(true);
    expect(
      coordinator.acquirePreparationLease({
        attachmentId: "attachment-3",
        authSessionId: "session-1",
        ownerId: "owner-1",
        resourceId: null,
        resourceKind: "tunnel",
      }),
    ).toBeNull();

    coordinator.releasePreparationLease(unbound);
    await expect(cleanup).resolves.toBeUndefined();
    expect(cleanupFinished).toBe(true);
    expect(coordinator.preparationLeaseIsActive(unrelatedBound)).toBe(true);
    coordinator.releasePreparationLease(unrelatedBound);
    await coordinator.close();
  });

  it.each(["session", "owner", "attachment"] as const)(
    "waits for a route-entry lease across %s revocation",
    async (scope) => {
      const bus = {
        isConnected: () => true,
        request: vi.fn(async () => ({ revoked: true })),
        subscribeWorkerDisconnect: () => () => undefined,
      } as unknown as WorkerCommandBus;
      const coordinator = new DirectAttachmentCoordinator(bus);
      const lease = coordinator.acquirePreparationLease({
        attachmentId: "attachment-1",
        authSessionId: "session-1",
        ownerId: "owner-1",
        resourceId: "tunnel-1",
        resourceKind: "tunnel",
      })!;
      let cleanupFinished = false;
      const cleanup = (
        scope === "session"
          ? coordinator.revokeSession("session-1")
          : scope === "owner"
            ? coordinator.revokeOwner("owner-1")
            : coordinator.revokeAttachment("attachment-1")
      ).then(() => {
        cleanupFinished = true;
      });

      await Promise.resolve();
      expect(cleanupFinished).toBe(false);
      expect(coordinator.preparationLeaseIsActive(lease)).toBe(false);
      coordinator.releasePreparationLease(lease);
      await expect(cleanup).resolves.toBeUndefined();
      expect(cleanupFinished).toBe(true);
      await coordinator.close();
    },
  );

  it("waits for a route-entry lease during shutdown", async () => {
    const bus = {
      isConnected: () => true,
      request: vi.fn(async () => ({ revoked: true })),
      subscribeWorkerDisconnect: () => () => undefined,
    } as unknown as WorkerCommandBus;
    const coordinator = new DirectAttachmentCoordinator(bus);
    const lease = coordinator.acquirePreparationLease({
      authSessionId: "session-1",
      ownerId: "owner-1",
      resourceId: "worker-1",
      resourceKind: "probe",
    })!;
    let shutdownFinished = false;
    const shutdown = coordinator.close().then(() => {
      shutdownFinished = true;
    });

    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    expect(coordinator.preparationLeaseIsActive(lease)).toBe(false);
    expect(
      coordinator.acquirePreparationLease({
        authSessionId: "session-2",
        ownerId: "owner-2",
        resourceId: "worker-2",
        resourceKind: "probe",
      }),
    ).toBeNull();
    coordinator.releasePreparationLease(lease);
    await expect(shutdown).resolves.toBeUndefined();
  });

  it("does not leave a direct grant registered across resource revocation", async () => {
    let releasePrepare!: () => void;
    let signalPrepareStarted!: () => void;
    const prepareStarted = new Promise<void>((resolve) => {
      signalPrepareStarted = resolve;
    });
    const prepareRelease = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const commands: WorkerCommand[] = [];
    const bus = {
      isConnected: () => true,
      request: vi.fn(async (_workerId: string, command: WorkerCommand) => {
        commands.push(command);
        if (command.type === "direct.capability.prepare") {
          signalPrepareStarted();
          await prepareRelease;
          return { accepted: true, capabilityId: command.binding.capabilityId };
        }
        return { revoked: true };
      }),
      subscribeWorkerDisconnect: () => () => undefined,
    } as unknown as WorkerCommandBus;
    const coordinator = new DirectAttachmentCoordinator(bus);
    const input = {
      attachmentId: "attachment-1",
      authSessionId: "session-1",
      channels: ["tunnel-data"],
      ownerId: "owner-1",
      resourceId: "tunnel-1",
      resourceKind: "tunnel" as const,
      worker: worker(),
    };

    try {
      const preparation = prepareDirect(coordinator, input);
      await prepareStarted;
      const capabilityId = (
        commands[0]?.type === "direct.capability.prepare"
          ? commands[0].binding.capabilityId
          : null
      )!;
      let cleanupFinished = false;
      const cleanup = coordinator
        .revokeResource("owner-1", "tunnel", "tunnel-1")
        .then(() => {
          cleanupFinished = true;
        });
      await expect(prepareDirect(coordinator, input)).rejects.toThrow(
        "The owning resource is being revoked.",
      );
      expect(cleanupFinished).toBe(false);

      releasePrepare();
      await expect(preparation).rejects.toThrow(
        "The owning resource changed while direct access was being prepared.",
      );
      await cleanup;
      expect(cleanupFinished).toBe(true);
      expect(commands).toContainEqual({
        type: "direct.capability.revoke",
        capabilityId,
        reason: "Owning resource was revoked",
      });
      expect(
        coordinator.recordTelemetry(
          capabilityId,
          { ownerId: "owner-1", authSessionId: "session-1" },
          {
            bytesFromLocal: 1,
            bytesToLocal: 0,
            connectionsClosed: 0,
            connectionsOpened: 1,
          },
        ),
      ).toBeNull();
    } finally {
      releasePrepare();
      await coordinator.close();
    }
  });

  it.each(["session", "owner"] as const)(
    "fences a delayed preparation across %s revocation",
    async (scope) => {
      let releasePrepare!: () => void;
      let signalPrepareStarted!: () => void;
      const prepareStarted = new Promise<void>((resolve) => {
        signalPrepareStarted = resolve;
      });
      const prepareRelease = new Promise<void>((resolve) => {
        releasePrepare = resolve;
      });
      const commands: WorkerCommand[] = [];
      const bus = {
        isConnected: () => true,
        request: vi.fn(async (_workerId: string, command: WorkerCommand) => {
          commands.push(command);
          if (command.type === "direct.capability.prepare") {
            signalPrepareStarted();
            await prepareRelease;
            return {
              accepted: true,
              capabilityId: command.binding.capabilityId,
            };
          }
          return { revoked: true };
        }),
        subscribeWorkerDisconnect: () => () => undefined,
      } as unknown as WorkerCommandBus;
      const coordinator = new DirectAttachmentCoordinator(bus);
      const input = {
        attachmentId: "attachment-1",
        authSessionId: "session-1",
        channels: ["tunnel-data"],
        ownerId: "owner-1",
        resourceId: "tunnel-1",
        resourceKind: "tunnel" as const,
        worker: worker(),
      };

      try {
        const preparation = prepareDirect(coordinator, input);
        await prepareStarted;
        const capabilityId = (
          commands[0]?.type === "direct.capability.prepare"
            ? commands[0].binding.capabilityId
            : null
        )!;
        let cleanupFinished = false;
        const cleanup = (
          scope === "session"
            ? coordinator.revokeSession(input.authSessionId)
            : coordinator.revokeOwner(input.ownerId)
        ).then(() => {
          cleanupFinished = true;
        });

        await expect(prepareDirect(coordinator, input)).rejects.toThrow(
          "The owning resource is being revoked.",
        );
        expect(cleanupFinished).toBe(false);
        expect(
          commands.filter(
            (command) => command.type === "direct.capability.prepare",
          ),
        ).toHaveLength(1);

        releasePrepare();
        await expect(preparation).rejects.toThrow(
          "The owning resource changed while direct access was being prepared.",
        );
        await expect(cleanup).resolves.toBeUndefined();
        expect(commands).toContainEqual({
          type: "direct.capability.revoke",
          capabilityId,
          reason: "Owning resource was revoked",
        });
        expect(
          coordinator.recordTelemetry(
            capabilityId,
            { ownerId: input.ownerId, authSessionId: input.authSessionId },
            {
              bytesFromLocal: 1,
              bytesToLocal: 0,
              connectionsClosed: 0,
              connectionsOpened: 1,
            },
          ),
        ).toBeNull();
      } finally {
        releasePrepare();
        await coordinator.close();
      }
    },
  );

  it("waits for and revokes a late direct preparation during shutdown", async () => {
    let releasePrepare!: () => void;
    let signalPrepareStarted!: () => void;
    const prepareStarted = new Promise<void>((resolve) => {
      signalPrepareStarted = resolve;
    });
    const prepareRelease = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const commands: WorkerCommand[] = [];
    const bus = {
      isConnected: () => true,
      request: vi.fn(async (_workerId: string, command: WorkerCommand) => {
        commands.push(command);
        if (command.type === "direct.capability.prepare") {
          signalPrepareStarted();
          await prepareRelease;
          return { accepted: true, capabilityId: command.binding.capabilityId };
        }
        return { revoked: true };
      }),
      subscribeWorkerDisconnect: () => () => undefined,
    } as unknown as WorkerCommandBus;
    const coordinator = new DirectAttachmentCoordinator(bus);
    const input = {
      attachmentId: "attachment-1",
      authSessionId: "session-1",
      channels: ["tunnel-data"],
      ownerId: "owner-1",
      resourceId: "tunnel-1",
      resourceKind: "tunnel" as const,
      worker: worker(),
    };
    const preparation = prepareDirect(coordinator, input);
    await prepareStarted;
    const capabilityId = (
      commands[0]?.type === "direct.capability.prepare"
        ? commands[0].binding.capabilityId
        : null
    )!;
    let shutdownFinished = false;
    const shutdown = coordinator.close().then(() => {
      shutdownFinished = true;
    });

    try {
      await expect(
        prepareDirect(
          coordinator,
          input,
          "The direct attachment coordinator is shutting down.",
        ),
      ).rejects.toThrow("The direct attachment coordinator is shutting down.");
      expect(shutdownFinished).toBe(false);
      expect(
        commands.filter(
          (command) => command.type === "direct.capability.prepare",
        ),
      ).toHaveLength(1);

      releasePrepare();
      await expect(preparation).rejects.toThrow(
        "The owning resource changed while direct access was being prepared.",
      );
      await expect(shutdown).resolves.toBeUndefined();
      expect(commands).toContainEqual({
        type: "direct.capability.revoke",
        capabilityId,
        reason: "Owning resource was revoked",
      });
      expect(
        coordinator.recordTelemetry(
          capabilityId,
          { ownerId: input.ownerId, authSessionId: input.authSessionId },
          {
            bytesFromLocal: 1,
            bytesToLocal: 0,
            connectionsClosed: 0,
            connectionsOpened: 1,
          },
        ),
      ).toBeNull();
      await expect(coordinator.close()).resolves.toBeUndefined();
      expect(
        commands.filter(
          (command) => command.type === "direct.capability.revoke",
        ),
      ).toHaveLength(1);
    } finally {
      releasePrepare();
      await coordinator.close();
    }
  });

  it("correlates activation, telemetry, and final state without logging capability material", async () => {
    const diagnosticTraceId = crypto.randomUUID();
    const commands: WorkerCommand[] = [];
    const bus = {
      isConnected: () => true,
      request: vi.fn(async (_workerId: string, command: WorkerCommand) => {
        commands.push(command);
        return command.type === "direct.capability.prepare"
          ? { accepted: true, capabilityId: command.binding.capabilityId }
          : { revoked: true };
      }),
      subscribeWorkerDisconnect: () => () => undefined,
    } as unknown as WorkerCommandBus;
    const captured = capturedLogger();
    const coordinator = new DirectAttachmentCoordinator(bus, captured.logger);
    const ticket = await prepareDirect(coordinator, {
      attachmentId: "attachment-1",
      authSessionId: "session-1",
      channels: ["tunnel-data"],
      diagnosticTraceId,
      ownerId: "owner-1",
      resourceId: "tunnel-1",
      resourceKind: "tunnel",
      tunnelRoute: {
        tunnelId: "tunnel-1",
        attachmentId: "attachment-1",
        sourceEndpointId: "desktop:client-1:attachment-1",
        destinationEndpointId: "worker:worker-1",
        target: { kind: "tcp", host: "127.0.0.1", port: 43124 },
      },
      worker: worker(),
    });

    expect(
      coordinator.recordActivationOutcome(
        ticket.binding.capabilityId,
        {
          attachmentId: ticket.binding.attachmentId,
          authSessionId: "session-1",
          ownerId: "owner-1",
        },
        "completed",
      ),
    ).toBe(true);
    expect(
      coordinator.recordTelemetry(
        ticket.binding.capabilityId,
        { ownerId: "owner-1", authSessionId: "session-1" },
        {
          bytesFromLocal: 120,
          bytesToLocal: 80,
          connectionsClosed: 1,
          connectionsOpened: 2,
          lastDestinationRejectionCode: "protected-record-unavailable",
        },
      ),
    ).toMatchObject({
      bytesFromLocal: 120,
      bytesToLocal: 80,
      lastDestinationRejectionCode: "protected-record-unavailable",
      resourceId: "tunnel-1",
      resourceKind: "tunnel",
    });
    expect(
      coordinator.recordTelemetry(
        ticket.binding.capabilityId,
        { ownerId: "owner-1", authSessionId: "session-1" },
        {
          bytesFromLocal: 10,
          bytesToLocal: 20,
          connectionsClosed: 0,
          connectionsOpened: 1,
        },
      ),
    ).toMatchObject({
      bytesFromLocal: 0,
      bytesToLocal: 0,
      connectionsClosed: 0,
      connectionsOpened: 0,
    });
    await coordinator.revoke(ticket.binding.capabilityId, "released");

    const prepared = eventContext(
      captured.records,
      "direct_attachment.prepare.completed",
    );
    const activation = eventContext(
      captured.records,
      "direct_attachment.activation.completed",
    );
    const telemetry = eventContext(
      captured.records,
      "direct_attachment.telemetry.recorded",
    );
    const finalState = eventContext(
      captured.records,
      "direct_attachment.finalized",
    );
    expect(prepared.diagnosticTraceId).toBe(diagnosticTraceId);
    expect(prepared.leaseDurationMs).toBeGreaterThan(0);
    expect(prepared.leaseDurationMs).toBeLessThanOrEqual(60_000);
    expect(activation.diagnosticTraceId).toBe(diagnosticTraceId);
    expect(telemetry.diagnosticTraceId).toBe(diagnosticTraceId);
    expect(telemetry.leaseRemainingMs).toBeGreaterThan(0);
    expect(telemetry.leaseRemainingMs).toBeLessThanOrEqual(
      prepared.leaseDurationMs as number,
    );
    expect(telemetry.lastDestinationRejectionCode).toBe(
      "protected-record-unavailable",
    );
    expect(finalState).toMatchObject({
      diagnosticTraceId,
      mode: "direct-tunnel",
      activationAttemptCount: 1,
      activationCount: 1,
      telemetryReportCount: 2,
      fromLocalBytes: 120,
      toLocalBytes: 80,
      openedConnectionCount: 2,
      closedConnectionCount: 1,
      lastDestinationRejectionCode: "protected-record-unavailable",
    });

    const persisted = captured.records.map(minimizeServiceLogRecordInput);
    expect(
      eventContext(persisted, "direct_attachment.telemetry.recorded"),
    ).toMatchObject({
      lastDestinationRejectionCode: "protected-record-unavailable",
    });
    expect(
      eventContext(persisted, "direct_attachment.prepare.completed"),
    ).toMatchObject({
      leaseDurationMs: prepared.leaseDurationMs,
    });
    expect(
      eventContext(persisted, "direct_attachment.telemetry.recorded"),
    ).toMatchObject({
      leaseRemainingMs: telemetry.leaseRemainingMs,
    });
    expect(
      eventContext(persisted, "direct_attachment.finalized"),
    ).toMatchObject({
      diagnosticTraceId,
      mode: "direct-tunnel",
      activationAttemptCount: 1,
      activationCount: 1,
      telemetryReportCount: 2,
      fromLocalBytes: 120,
      toLocalBytes: 80,
      openedConnectionCount: 2,
      closedConnectionCount: 1,
      lastDestinationRejectionCode: "protected-record-unavailable",
    });
    const serialized = JSON.stringify(captured.records);
    const persistedSerialized = JSON.stringify(persisted);
    expect(serialized).not.toContain(ticket.binding.capabilityId);
    expect(serialized).not.toContain(ticket.secret);
    expect(persistedSerialized).not.toContain(ticket.binding.capabilityId);
    expect(persistedSerialized).not.toContain(ticket.secret);
    expect(ticket).not.toHaveProperty("diagnosticTraceId");
    expect(ticket.binding).not.toHaveProperty("diagnosticTraceId");
    expect(commands[0]).toMatchObject({
      type: "direct.capability.prepare",
      diagnosticTraceId,
    });
    expect(
      commands[0]?.type === "direct.capability.prepare"
        ? commands[0].binding
        : {},
    ).not.toHaveProperty("diagnosticTraceId");
    expect(commands.at(-1)).toMatchObject({
      type: "direct.capability.revoke",
      capabilityId: ticket.binding.capabilityId,
    });
    await coordinator.close();
  });

  it("captures an unactivated zero-report final state on worker disconnect", async () => {
    let disconnect: (() => void) | null = null;
    const bus = {
      isConnected: () => true,
      request: vi.fn(async (_workerId: string, command: WorkerCommand) =>
        command.type === "direct.capability.prepare"
          ? { accepted: true, capabilityId: command.binding.capabilityId }
          : { revoked: true },
      ),
      subscribeWorkerDisconnect: (_workerId: string, listener: () => void) => {
        disconnect = listener;
        return () => undefined;
      },
    } as unknown as WorkerCommandBus;
    const captured = capturedLogger();
    const coordinator = new DirectAttachmentCoordinator(bus, captured.logger);
    const ticket = await prepareDirect(coordinator, {
      authSessionId: "session-1",
      channels: ["probe"],
      ownerId: "owner-1",
      resourceId: "worker-1",
      resourceKind: "probe",
      worker: worker(),
    });

    expect(disconnect).not.toBeNull();
    disconnect!();

    expect(
      coordinator.matches(ticket.binding.capabilityId, {
        attachmentId: ticket.binding.attachmentId,
        authSessionId: "session-1",
        ownerId: "owner-1",
      }),
    ).toBe(false);
    expect(
      eventContext(captured.records, "direct_attachment.finalized"),
    ).toMatchObject({
      reasonCode: "worker_disconnected",
      activationAttemptCount: 0,
      activationCount: 0,
      telemetryReportCount: 0,
      fromLocalBytes: 0,
      toLocalBytes: 0,
      openedConnectionCount: 0,
      closedConnectionCount: 0,
    });
    expect(
      eventContext(captured.records, "direct_attachment.finalized"),
    ).not.toHaveProperty("telemetryAgeMs");
    await coordinator.close();
  });

  it("retains a direct grant while the worker is reconnecting", async () => {
    let reconnecting: (() => void) | null = null;
    let offline: (() => void) | null = null;
    const bus = {
      isConnected: () => true,
      request: vi.fn(async (_workerId: string, command: WorkerCommand) =>
        command.type === "direct.capability.prepare"
          ? { accepted: true, capabilityId: command.binding.capabilityId }
          : { revoked: true },
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
    const coordinator = new DirectAttachmentCoordinator(bus);
    const ticket = await prepareDirect(coordinator, {
      authSessionId: "session-1",
      channels: ["probe"],
      ownerId: "owner-1",
      resourceId: "worker-1",
      resourceKind: "probe",
      worker: worker(),
    });
    const identity = {
      attachmentId: ticket.binding.attachmentId,
      authSessionId: "session-1",
      ownerId: "owner-1",
    };

    expect(reconnecting).toBeNull();
    expect(offline).not.toBeNull();
    expect(coordinator.matches(ticket.binding.capabilityId, identity)).toBe(
      true,
    );

    offline!();
    expect(coordinator.matches(ticket.binding.capabilityId, identity)).toBe(
      false,
    );
    await coordinator.close();
  });

  it("preserves final state when worker revoke delivery fails", async () => {
    const bus = {
      isConnected: () => true,
      request: vi.fn(async (_workerId: string, command: WorkerCommand) => {
        if (command.type === "direct.capability.prepare") {
          return { accepted: true, capabilityId: command.binding.capabilityId };
        }
        throw new Error("worker disconnected");
      }),
      subscribeWorkerDisconnect: () => () => undefined,
    } as unknown as WorkerCommandBus;
    const captured = capturedLogger();
    const coordinator = new DirectAttachmentCoordinator(bus, captured.logger);
    const ticket = await prepareDirect(coordinator, {
      authSessionId: "session-1",
      channels: ["probe"],
      ownerId: "owner-1",
      resourceId: "worker-1",
      resourceKind: "probe",
      worker: worker(),
    });

    await expect(
      coordinator.revoke(ticket.binding.capabilityId, "released"),
    ).resolves.toBe(true);

    const finalIndex = captured.records.findIndex(
      (record) =>
        (record.context as Record<string, unknown> | undefined)?.event ===
        "direct_attachment.finalized",
    );
    const revokeIndex = captured.records.findIndex(
      (record) =>
        (record.context as Record<string, unknown> | undefined)?.event ===
        "direct_attachment.revoked",
    );
    expect(finalIndex).toBeGreaterThanOrEqual(0);
    expect(revokeIndex).toBeGreaterThan(finalIndex);
    expect(
      eventContext(captured.records, "direct_attachment.revoked"),
    ).toMatchObject({ status: "degraded", success: false });
    await coordinator.close();
  });

  it("correlates preparation failures without retaining sensitive error details", async () => {
    const secretMarker = "direct-secret-marker-123456789";
    const protectedRecordMarker = "protected-record-marker-987654321";
    const pathMarker = "/Users/private/worktrees/sensitive-project";
    const workerError = Object.assign(
      new Error(
        `prepare failed at ${pathMarker} with ${secretMarker} and ${protectedRecordMarker}`,
      ),
      {
        code: "ECONNRESET",
        secret: secretMarker,
        protectedRecord: { protectedContent: protectedRecordMarker },
      },
    );
    const bus = {
      isConnected: () => true,
      request: vi.fn(async () => {
        throw workerError;
      }),
      subscribeWorkerDisconnect: () => () => undefined,
    } as unknown as WorkerCommandBus;
    const captured = capturedLogger();
    const coordinator = new DirectAttachmentCoordinator(bus, captured.logger);

    await expect(
      prepareDirect(coordinator, {
        attachmentId: "attachment-1",
        authSessionId: "session-1",
        channels: ["tunnel-data"],
        ownerId: "owner-1",
        resourceId: "tunnel-1",
        resourceKind: "tunnel",
        worker: worker(),
      }),
    ).rejects.toThrow("Worker could not prepare a local direct capability");

    const started = eventContext(
      captured.records,
      "direct_attachment.prepare.started",
    );
    const failed = eventContext(
      captured.records,
      "direct_attachment.prepare.failed",
    );
    expect(failed).toMatchObject({
      diagnosticTraceId: started.diagnosticTraceId,
      reasonCode: "worker_prepare_failed",
      status: "failed",
      errorClass: "Error",
      errorCode: "ECONNRESET",
    });
    expect(failed).not.toHaveProperty("error");
    const serialized = JSON.stringify(captured.records);
    const persisted = JSON.stringify(
      captured.records.map(minimizeServiceLogRecordInput),
    );
    for (const marker of [secretMarker, protectedRecordMarker, pathMarker]) {
      expect(serialized).not.toContain(marker);
      expect(persisted).not.toContain(marker);
    }
    await coordinator.close();
  });

  it("rejects alphanumeric protected material in error identity fields", async () => {
    const secretName = "SecretMarkerABC123";
    const protectedCode = "PROTECTEDRECORDABC123";
    const workerError = Object.assign(new Error("safe message"), {
      name: secretName,
      code: protectedCode,
    });
    const bus = {
      isConnected: () => true,
      request: vi.fn(async () => {
        throw workerError;
      }),
      subscribeWorkerDisconnect: () => () => undefined,
    } as unknown as WorkerCommandBus;
    const captured = capturedLogger();
    const coordinator = new DirectAttachmentCoordinator(bus, captured.logger);

    await expect(
      prepareDirect(coordinator, {
        attachmentId: "attachment-1",
        authSessionId: "session-1",
        channels: ["tunnel-data"],
        ownerId: "owner-1",
        resourceId: "tunnel-1",
        resourceKind: "tunnel",
        worker: worker(),
      }),
    ).rejects.toThrow("Worker could not prepare a local direct capability");

    const failed = eventContext(
      captured.records,
      "direct_attachment.prepare.failed",
    );
    expect(failed).toMatchObject({ errorClass: "Error" });
    expect(failed).not.toHaveProperty("errorCode");
    const serialized = JSON.stringify(captured.records);
    expect(serialized).not.toContain(secretName);
    expect(serialized).not.toContain(protectedCode);
    await coordinator.close();
  });

  it("has the worker install a bound one-use ticket before returning it", async () => {
    const commands: WorkerCommand[] = [];
    const bus = {
      isConnected: () => true,
      request: vi.fn(async (_workerId: string, command: WorkerCommand) => {
        commands.push(command);
        return command.type === "direct.capability.prepare"
          ? { accepted: true, capabilityId: command.binding.capabilityId }
          : { revoked: true };
      }),
      subscribeWorkerDisconnect: () => () => undefined,
    } as unknown as WorkerCommandBus;
    const coordinator = new DirectAttachmentCoordinator(bus);
    const ticket = await prepareDirect(coordinator, {
      authSessionId: "session-1",
      channels: ["probe"],
      ownerId: "owner-1",
      resourceId: "worker-1",
      resourceKind: "probe",
      worker: worker(),
    });
    expect(commands[0]).toMatchObject({
      type: "direct.capability.prepare",
      diagnosticTraceId: expect.any(String),
      binding: {
        ownerId: "owner-1",
        authSessionId: "session-1",
        workerId: "worker-1",
        channels: ["probe"],
      },
    });
    expect(
      coordinator.recordTelemetry(
        ticket.binding.capabilityId,
        { ownerId: "owner-1", authSessionId: "session-1" },
        {
          bytesFromLocal: 120,
          bytesToLocal: 80,
          connectionsClosed: 1,
          connectionsOpened: 2,
        },
      ),
    ).toEqual({
      bytesFromLocal: 120,
      bytesToLocal: 80,
      connectionsClosed: 1,
      connectionsOpened: 2,
      resourceId: "worker-1",
      resourceKind: "probe",
    });
    expect(
      coordinator.recordTelemetry(
        ticket.binding.capabilityId,
        { ownerId: "owner-1", authSessionId: "session-1" },
        {
          bytesFromLocal: 150,
          bytesToLocal: 80,
          connectionsClosed: 1,
          connectionsOpened: 2,
        },
      ),
    ).toMatchObject({ bytesFromLocal: 30, bytesToLocal: 0 });
    expect(
      coordinator.recordTelemetry(
        ticket.binding.capabilityId,
        { ownerId: "owner-1", authSessionId: "session-1" },
        {
          bytesFromLocal: 10,
          bytesToLocal: 20,
          connectionsClosed: 0,
          connectionsOpened: 1,
        },
      ),
    ).toMatchObject({
      bytesFromLocal: 0,
      bytesToLocal: 0,
      connectionsClosed: 0,
      connectionsOpened: 0,
    });
    expect(
      coordinator.recordTelemetry(
        ticket.binding.capabilityId,
        { ownerId: "another-owner", authSessionId: "session-1" },
        {
          bytesFromLocal: 999,
          bytesToLocal: 999,
          connectionsClosed: 9,
          connectionsOpened: 9,
        },
      ),
    ).toBeNull();
    expect(
      await coordinator.revoke(ticket.binding.capabilityId, "wrong session", {
        ownerId: "owner-1",
        authSessionId: "session-2",
      }),
    ).toBe(false);
    expect(
      await coordinator.revoke(ticket.binding.capabilityId, "released", {
        ownerId: "owner-1",
        authSessionId: "session-1",
      }),
    ).toBe(true);
    expect(commands.at(-1)).toMatchObject({
      type: "direct.capability.revoke",
      capabilityId: ticket.binding.capabilityId,
    });
    await coordinator.close();
  });

  it("revokes only capabilities owned by the ended authorization session", async () => {
    const commands: WorkerCommand[] = [];
    const bus = {
      isConnected: () => true,
      request: vi.fn(async (_workerId: string, command: WorkerCommand) => {
        commands.push(command);
        return command.type === "direct.capability.prepare"
          ? { accepted: true, capabilityId: command.binding.capabilityId }
          : { revoked: true };
      }),
      subscribeWorkerDisconnect: () => () => undefined,
    } as unknown as WorkerCommandBus;
    const coordinator = new DirectAttachmentCoordinator(bus);
    const ended = await prepareDirect(coordinator, {
      authSessionId: "session-ended",
      channels: ["probe"],
      ownerId: "owner-1",
      resourceId: "worker-1",
      resourceKind: "probe",
      worker: worker(),
    });
    const active = await prepareDirect(coordinator, {
      authSessionId: "session-active",
      channels: ["probe"],
      ownerId: "owner-1",
      resourceId: "worker-1",
      resourceKind: "probe",
      worker: worker(),
    });

    await coordinator.revokeSession("session-ended");

    expect(
      coordinator.matches(ended.binding.capabilityId, {
        attachmentId: ended.binding.attachmentId,
        authSessionId: "session-ended",
        ownerId: "owner-1",
      }),
    ).toBe(false);
    expect(
      coordinator.matches(active.binding.capabilityId, {
        attachmentId: active.binding.attachmentId,
        authSessionId: "session-active",
        ownerId: "owner-1",
      }),
    ).toBe(true);
    expect(commands).toContainEqual(
      expect.objectContaining({
        type: "direct.capability.revoke",
        capabilityId: ended.binding.capabilityId,
      }),
    );
    await coordinator.close();
  });
});
