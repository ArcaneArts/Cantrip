import type { WorkerCommand, WorkerNotification } from "@cantrip/protocol";
import type { WorkerLinkPeerConfiguration } from "@cantrip/protocol/worker-link";
import { describe, expect, it, vi } from "vitest";

import {
  createInMemoryRelayCoordinatorBackend,
  InMemoryRelayCoordinator,
} from "../src/coordination/relay-coordinator.js";
import { WorkerLinkCoordinator } from "../src/worker-links/coordinator.js";
import { WorkerLinkService } from "../src/worker-links/service.js";
import type {
  WorkerCommandBus,
  WorkerRequestOptions,
} from "../src/workers/bridge.js";

const serverId = "server-1";

class FakeWorkerBus {
  readonly commands: WorkerCommand[] = [];
  readonly notificationListeners = new Map<
    string,
    Set<(notification: WorkerNotification) => Promise<void> | void>
  >();

  request = vi.fn(
    async (
      workerId: string,
      command: WorkerCommand,
      options?: WorkerRequestOptions,
    ) => {
      this.commands.push(command);
      return command.type === "worker-link.identity.resolve"
        ? {
            serverId,
            ownerId: options?.ownerId ?? "owner-1",
            workerId,
            workerProcessGeneration: "worker-generation-1",
          }
        : { accepted: true };
    },
  );

  subscribeWorkerDisconnect() {
    return () => undefined;
  }

  subscribeWorkerOffline() {
    return () => undefined;
  }

  subscribeNotifications(
    workerId: string,
    listener: (notification: WorkerNotification) => Promise<void> | void,
  ) {
    const listeners = this.notificationListeners.get(workerId) ?? new Set();
    listeners.add(listener);
    this.notificationListeners.set(workerId, listeners);
    return () => listeners.delete(listener);
  }

  async emit(workerId: string, notification: WorkerNotification) {
    await Promise.all(
      [...(this.notificationListeners.get(workerId) ?? [])].map((listener) =>
        listener(notification),
      ),
    );
  }

  asBus(): WorkerCommandBus {
    return this as unknown as WorkerCommandBus;
  }
}

function peerConfiguration(): WorkerLinkPeerConfiguration {
  const laneLimit = {
    maxChannels: 64,
    maxQueuedFrames: 128,
    maxQueuedBytes: 4 * 1_024 * 1_024,
    maxBytesPerSecond: 16 * 1_024 * 1_024,
  };
  return {
    directRoutes: { local: true, lan: true, wan: true },
    relayOnly: false,
    stunUrls: ["stun:stun.cloudflare.com:3478"],
    interfacePolicy: { mode: "default", interfaces: [] },
    vpnPolicy: { defaultRoute: "wan", lanAllowlist: [] },
    negotiationTimeoutMs: 8_000,
    upgradeProbeTimeoutMs: 15_000,
    maxPeerSessionsPerClient: 4,
    maxPeerSessionsPerWorker: 32,
    invalidHandshakeRatePerMinute: 60,
    laneLimits: {
      events: laneLimit,
      interactive: laneLimit,
      stream: laneLimit,
      realtime: laneLimit,
      bulk: laneLimit,
    },
  };
}

describe("WorkerLinkService replicated authority", () => {
  it("resolves and mutates a session from any coordinated server instance", async () => {
    const backend = createInMemoryRelayCoordinatorBackend();
    const coordinationA = new InMemoryRelayCoordinator("instance-a", backend);
    const coordinationB = new InMemoryRelayCoordinator("instance-b", backend);
    await Promise.all([coordinationA.start(), coordinationB.start()]);
    const workersA = new FakeWorkerBus();
    const workersB = new FakeWorkerBus();
    const serviceA = new WorkerLinkService(
      new WorkerLinkCoordinator(workersA.asBus(), {
        peerConfiguration: peerConfiguration(),
        serverGeneration: "generation-a",
        serverId,
        sweepIntervalMs: 0,
      }),
      coordinationA,
    );
    const serviceB = new WorkerLinkService(
      new WorkerLinkCoordinator(workersB.asBus(), {
        peerConfiguration: peerConfiguration(),
        serverGeneration: "generation-b",
        serverId,
        sweepIntervalMs: 0,
      }),
      coordinationB,
    );

    const opened = await serviceA.openSession({
      accountSessionId: "account-session-1",
      clientInstanceId: "client-instance-1",
      ownerId: "owner-1",
      workerId: "worker-1",
    });
    const relayRevocationsA: unknown[] = [];
    const relayRevocationsB: unknown[] = [];
    serviceA.subscribeRelayRevocations((scope) =>
      relayRevocationsA.push(scope),
    );
    serviceB.subscribeRelayRevocations((scope) =>
      relayRevocationsB.push(scope),
    );
    await expect(
      serviceB.sessionForAuthorization(opened.sessionId, {
        accountSessionId: "account-session-1",
        ownerId: "owner-1",
      }),
    ).resolves.toEqual(opened);
    await expect(
      serviceB.sessionForAuthorization(opened.sessionId, {
        accountSessionId: "account-session-2",
        ownerId: "owner-1",
      }),
    ).resolves.toBeNull();

    const peer = await serviceB.openPeerSession(opened.sessionId, {
      route: "lan",
      routeGeneration: opened.routeGeneration,
    });
    expect(peer.identity.serverGeneration).toBe("generation-a");
    expect(workersA.commands).toContainEqual({
      type: "worker-link.peer.install",
      peerSession: peer,
      configuration: peerConfiguration(),
    });
    expect(workersB.commands).toHaveLength(0);
    await serviceB.signalPeer(opened.sessionId, {
      peerSessionId: peer.peerSessionId,
      sessionId: peer.sessionId,
      routeGeneration: peer.routeGeneration,
      route: peer.route,
      sender: "client",
      signalSequence: 0,
      signal: { type: "offer", sdp: "offer-sdp" },
    });
    expect(workersA.commands).toContainEqual(
      expect.objectContaining({
        type: "worker-link.peer.signal",
        envelope: expect.objectContaining({
          peerSessionId: peer.peerSessionId,
          sender: "client",
        }),
      }),
    );
    await workersA.emit("worker-1", {
      type: "worker-link.peer.signal",
      envelope: {
        peerSessionId: peer.peerSessionId,
        sessionId: peer.sessionId,
        routeGeneration: peer.routeGeneration,
        route: peer.route,
        sender: "worker",
        signalSequence: 0,
        signal: { type: "answer", sdp: "answer-sdp" },
      },
    });
    await expect(
      serviceB.readPeerMailbox(opened.sessionId, peer.peerSessionId, {
        afterSignalSequence: null,
        afterAdvertisementSequence: null,
      }),
    ).resolves.toMatchObject({
      peerSessionId: peer.peerSessionId,
      signals: [
        expect.objectContaining({
          sender: "worker",
          signal: { type: "answer", sdp: "answer-sdp" },
        }),
      ],
    });

    const relayed = await serviceB.replaceRoute(opened.sessionId, "relay");
    expect(relayed).toMatchObject({
      preferredRoute: "relay",
      routeGeneration: 2,
    });
    expect(workersA.commands).toContainEqual({
      type: "worker-link.session.route",
      sessionId: opened.sessionId,
      preferredRoute: "relay",
      routeGeneration: 2,
    });
    expect(workersB.commands).toHaveLength(0);
    expect(relayRevocationsA).toContainEqual({
      kind: "session",
      sessionId: opened.sessionId,
    });
    expect(relayRevocationsB).toContainEqual({
      kind: "session",
      sessionId: opened.sessionId,
    });
    await expect(
      serviceB.sessionForAuthorization(opened.sessionId, {
        accountSessionId: "account-session-1",
        ownerId: "owner-1",
      }),
    ).resolves.toMatchObject({ preferredRoute: "relay", routeGeneration: 2 });

    const grant = await serviceB.issueGrant({
      lanes: ["interactive", "stream"],
      operations: ["stream:open", "stream:read", "stream:write"],
      resourceId: "terminal-1",
      resourceKind: "terminal",
      sessionId: opened.sessionId,
    });
    expect(grant.binding.identity.serverGeneration).toBe("generation-a");
    expect(workersA.commands).toContainEqual(
      expect.objectContaining({
        type: "worker-link.grant.install",
        sessionId: opened.sessionId,
      }),
    );
    await expect(
      serviceB.renewGrant(opened.sessionId, grant.binding.grantId),
    ).resolves.toMatchObject({
      absoluteExpiresAt: grant.binding.lease.absoluteExpiresAt,
    });
    expect(workersA.commands).toContainEqual(
      expect.objectContaining({
        type: "worker-link.grant.renew",
        sessionId: opened.sessionId,
        grantId: grant.binding.grantId,
      }),
    );
    await expect(
      serviceB.revokeGrant(opened.sessionId, grant.binding.grantId),
    ).resolves.toBe(true);
    expect(workersA.commands).toContainEqual(
      expect.objectContaining({
        type: "worker-link.grant.revoke",
        sessionId: opened.sessionId,
        grantId: grant.binding.grantId,
      }),
    );

    const tunnelGrant = await serviceB.issueGrant({
      attachmentId: "attachment-1",
      lanes: ["stream"],
      operations: ["stream:open", "stream:read", "stream:write"],
      resourceId: "tunnel-1",
      resourceKind: "tunnel",
      sessionId: opened.sessionId,
    });
    await expect(
      serviceB.revokeAttachment(
        "owner-1",
        "tunnel",
        "tunnel-1",
        "attachment-1",
      ),
    ).resolves.toBe(0);
    await expect(
      serviceA.renewGrant(opened.sessionId, tunnelGrant.binding.grantId),
    ).rejects.toThrow(/missing/i);

    await expect(serviceB.revokeSession(opened.sessionId)).resolves.toBe(true);
    await expect(
      coordinationB.findWorkerLinkSession(opened.sessionId),
    ).resolves.toBeNull();
    expect(workersA.commands).toContainEqual(
      expect.objectContaining({
        type: "worker-link.session.revoke",
        sessionId: opened.sessionId,
      }),
    );

    await serviceA.close();
    await serviceB.close();
    await Promise.all([coordinationA.close(), coordinationB.close()]);
  });

  it("broadcasts account-session revocation to the authority instance", async () => {
    const backend = createInMemoryRelayCoordinatorBackend();
    const coordinationA = new InMemoryRelayCoordinator("instance-a", backend);
    const coordinationB = new InMemoryRelayCoordinator("instance-b", backend);
    await Promise.all([coordinationA.start(), coordinationB.start()]);
    const workersA = new FakeWorkerBus();
    const serviceA = new WorkerLinkService(
      new WorkerLinkCoordinator(workersA.asBus(), {
        serverGeneration: "generation-a",
        serverId,
        sweepIntervalMs: 0,
      }),
      coordinationA,
    );
    const serviceB = new WorkerLinkService(
      new WorkerLinkCoordinator(new FakeWorkerBus().asBus(), {
        serverGeneration: "generation-b",
        serverId,
        sweepIntervalMs: 0,
      }),
      coordinationB,
    );
    const opened = await serviceA.openSession({
      accountSessionId: "account-session-1",
      clientInstanceId: "client-instance-1",
      ownerId: "owner-1",
      workerId: "worker-1",
    });
    const relayRevocationsA: unknown[] = [];
    const relayRevocationsB: unknown[] = [];
    serviceA.subscribeRelayRevocations((scope) =>
      relayRevocationsA.push(scope),
    );
    serviceB.subscribeRelayRevocations((scope) =>
      relayRevocationsB.push(scope),
    );
    await serviceB.revokeAccountSession("account-session-1");
    expect(workersA.commands).toContainEqual(
      expect.objectContaining({
        type: "worker-link.session.revoke",
        sessionId: opened.sessionId,
        revocation: expect.objectContaining({
          reason: "account-session-ended",
        }),
      }),
    );
    expect(relayRevocationsA).toContainEqual({
      kind: "account-session",
      accountSessionId: "account-session-1",
    });
    expect(relayRevocationsB).toContainEqual({
      kind: "account-session",
      accountSessionId: "account-session-1",
    });

    await serviceA.close();
    await serviceB.close();
    await Promise.all([coordinationA.close(), coordinationB.close()]);
  });
});
