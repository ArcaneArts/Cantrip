import type { WorkerCommand } from "@cantrip/protocol";
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

  asBus(): WorkerCommandBus {
    return this as unknown as WorkerCommandBus;
  }
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
        serverGeneration: "generation-a",
        serverId,
        sweepIntervalMs: 0,
      }),
      coordinationA,
    );
    const serviceB = new WorkerLinkService(
      new WorkerLinkCoordinator(workersB.asBus(), {
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
