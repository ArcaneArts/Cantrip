import { createHash } from "node:crypto";

import type { WorkerCommand } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import { WorkerLinkCoordinator } from "../src/worker-links/coordinator.js";
import type {
  WorkerCommandBus,
  WorkerRequestOptions,
} from "../src/workers/bridge.js";

const serverId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const serverGeneration = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const workerGeneration = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

class FakeWorkerBus {
  readonly commands: WorkerCommand[] = [];
  readonly offline = new Map<string, Set<() => void>>();
  requestImplementation: (
    workerId: string,
    command: WorkerCommand,
  ) => Promise<unknown> = async () => ({ accepted: true });
  workerProcessGeneration = workerGeneration;

  request = vi.fn(
    async (
      workerId: string,
      command: WorkerCommand,
      options?: WorkerRequestOptions,
    ) => {
      this.commands.push(command);
      if (command.type === "worker-link.identity.resolve") {
        return {
          serverId,
          ownerId: options?.ownerId ?? "owner-1",
          workerId,
          workerProcessGeneration: this.workerProcessGeneration,
        };
      }
      return this.requestImplementation(workerId, command);
    },
  );

  subscribeWorkerOffline(workerId: string, listener: () => void) {
    const listeners = this.offline.get(workerId) ?? new Set();
    listeners.add(listener);
    this.offline.set(workerId, listeners);
    return () => listeners.delete(listener);
  }

  subscribeWorkerDisconnect(workerId: string, listener: () => void) {
    return this.subscribeWorkerOffline(workerId, listener);
  }

  disconnect(workerId: string) {
    for (const listener of this.offline.get(workerId) ?? []) listener();
  }

  asBus(): WorkerCommandBus {
    return this as unknown as WorkerCommandBus;
  }
}

function sessionInput(
  overrides: Partial<{
    accountSessionId: string;
    clientInstanceId: string;
    ownerId: string;
    workerId: string;
  }> = {},
) {
  return {
    accountSessionId: "account-session-1",
    clientInstanceId: "client-instance-1",
    ownerId: "owner-1",
    workerId: "worker-1",
    ...overrides,
  };
}

describe("WorkerLinkCoordinator", () => {
  it("revokes one exact tunnel attachment without retiring sibling grants", async () => {
    const workers = new FakeWorkerBus();
    const coordinator = new WorkerLinkCoordinator(workers.asBus(), {
      serverGeneration,
      serverId,
      sweepIntervalMs: 0,
    });
    const session = await coordinator.openSession(sessionInput());
    const issue = (attachmentId: string) =>
      coordinator.issueGrant({
        attachmentId,
        lanes: ["stream"],
        maxChannels: 1,
        operations: ["stream:open", "stream:read", "stream:write"],
        resourceId: "tunnel-1",
        resourceKind: "tunnel",
        sessionId: session.sessionId,
      });
    const first = await issue("attachment-1");
    const second = await issue("attachment-2");

    await expect(
      coordinator.revokeAttachment(
        session.identity.ownerId,
        "tunnel",
        "tunnel-1",
        "attachment-1",
      ),
    ).resolves.toBe(1);
    await expect(
      coordinator.renewGrant(session.sessionId, first.binding.grantId),
    ).rejects.toThrow(/missing/i);
    await expect(
      coordinator.renewGrant(session.sessionId, second.binding.grantId),
    ).resolves.toBeDefined();
    await coordinator.close();
  });

  it("installs one exact session and a hash-only resource grant before returning authority", async () => {
    let now = Date.parse("2026-08-26T12:00:00.000Z");
    const workers = new FakeWorkerBus();
    const coordinator = new WorkerLinkCoordinator(workers.asBus(), {
      maxActiveSessions: 1,
      now: () => now,
      serverGeneration,
      serverId,
      sweepIntervalMs: 0,
    });

    const session = await coordinator.openSession(sessionInput());
    expect(session.identity).toEqual({
      serverId,
      serverGeneration,
      workerProcessGeneration: workerGeneration,
      ...sessionInput(),
    });
    expect(session.routePolicy.enabled).toEqual(["local", "relay"]);
    expect(workers.commands).toContainEqual({
      type: "worker-link.session.install",
      session,
    });

    const duplicate = await coordinator.openSession(sessionInput());
    expect(duplicate.sessionId).toBe(session.sessionId);
    await expect(
      coordinator.openSession(
        sessionInput({ clientInstanceId: "client-instance-at-capacity" }),
      ),
    ).rejects.toThrow(/session limit/i);
    expect(
      workers.commands.filter(
        (command) => command.type === "worker-link.session.install",
      ),
    ).toHaveLength(1);
    const relayed = await coordinator.replaceRoute(session.sessionId, "relay");
    expect(relayed).toMatchObject({
      preferredRoute: "relay",
      routeGeneration: 2,
    });
    expect(workers.commands).toContainEqual({
      type: "worker-link.session.route",
      sessionId: session.sessionId,
      preferredRoute: "relay",
      routeGeneration: 2,
    });

    const grant = await coordinator.issueGrant({
      absoluteExpiresAt: new Date(now + 45_000).toISOString(),
      attachmentId: "attachment-1",
      lanes: ["interactive", "stream"],
      maxChannels: 2,
      operations: [
        "stream:open",
        "stream:read",
        "stream:write",
        "stream:half-close",
      ],
      resourceId: "terminal-1",
      resourceKind: "terminal",
      sessionId: session.sessionId,
    });
    const install = workers.commands.find(
      (command) => command.type === "worker-link.grant.install",
    );
    expect(install).toMatchObject({
      type: "worker-link.grant.install",
      sessionId: session.sessionId,
      grant: { binding: grant.binding },
    });
    if (install?.type !== "worker-link.grant.install") {
      throw new Error("Grant install was not dispatched.");
    }
    expect(install.grant).not.toHaveProperty("token");
    expect(install.grant.tokenHash).toBe(
      createHash("sha256").update(grant.token).digest("hex"),
    );
    expect(coordinator.stats()).toEqual({ grants: 1, sessions: 1 });

    now += 30_000;
    const renewedSession = await coordinator.renewSession(
      session.sessionId,
      180_000,
    );
    expect(Date.parse(renewedSession.lease.expiresAt)).toBeGreaterThan(
      Date.parse(session.lease.expiresAt),
    );
    const renewed = await coordinator.renewGrant(
      session.sessionId,
      grant.binding.grantId,
    );
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(now);
    expect(renewed.absoluteExpiresAt).toBe(
      new Date(now + 15_000).toISOString(),
    );

    await coordinator.close();
  });

  it("does not return bearer authority before the worker acknowledges installation", async () => {
    const workers = new FakeWorkerBus();
    let acknowledgeGrant!: () => void;
    const grantAcknowledged = new Promise<void>((resolve) => {
      acknowledgeGrant = resolve;
    });
    workers.requestImplementation = async (_workerId, command) => {
      if (command.type === "worker-link.grant.install") {
        await grantAcknowledged;
      }
      return { accepted: true };
    };
    const coordinator = new WorkerLinkCoordinator(workers.asBus(), {
      serverGeneration,
      serverId,
      sweepIntervalMs: 0,
    });
    const session = await coordinator.openSession(sessionInput());
    let returned = false;
    const pending = coordinator
      .issueGrant({
        lanes: ["interactive"],
        operations: ["stream:open", "stream:read", "stream:write"],
        resourceId: "terminal-1",
        resourceKind: "terminal",
        sessionId: session.sessionId,
      })
      .then((grant) => {
        returned = true;
        return grant;
      });
    await vi.waitFor(() =>
      expect(
        workers.commands.some(
          (command) => command.type === "worker-link.grant.install",
        ),
      ).toBe(true),
    );
    expect(returned).toBe(false);
    acknowledgeGrant();
    await expect(pending).resolves.toMatchObject({
      binding: { resource: { resourceId: "terminal-1" } },
    });
    await coordinator.close();
  });

  it("fences account sessions, resources, worker loss, and process replacement", async () => {
    const workers = new FakeWorkerBus();
    const coordinator = new WorkerLinkCoordinator(workers.asBus(), {
      serverGeneration,
      serverId,
      sweepIntervalMs: 0,
    });
    const first = await coordinator.openSession(sessionInput());
    const second = await coordinator.openSession(
      sessionInput({ clientInstanceId: "client-instance-2" }),
    );
    const firstGrant = await coordinator.issueGrant({
      lanes: ["stream"],
      operations: ["stream:open", "stream:read", "stream:write"],
      resourceId: "tunnel-1",
      resourceKind: "tunnel",
      sessionId: first.sessionId,
    });
    await coordinator.issueGrant({
      lanes: ["stream"],
      operations: ["stream:open", "stream:read", "stream:write"],
      resourceId: "tunnel-1",
      resourceKind: "tunnel",
      sessionId: second.sessionId,
    });

    expect(
      await coordinator.revokeResource(
        "owner-1",
        "tunnel",
        "tunnel-1",
        "resource-deleted",
      ),
    ).toBe(2);
    expect(coordinator.stats().grants).toBe(0);
    expect(
      workers.commands.some(
        (command) =>
          command.type === "worker-link.grant.revoke" &&
          command.grantId === firstGrant.binding.grantId &&
          command.revocation.reason === "resource-deleted",
      ),
    ).toBe(true);
    workers.workerProcessGeneration = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const replacement = await coordinator.openSession(
      sessionInput({
        accountSessionId: "account-session-2",
        clientInstanceId: "client-instance-3",
      }),
    );
    expect(coordinator.stats().sessions).toBe(1);
    expect(
      workers.commands.filter(
        (command) =>
          command.type === "worker-link.session.revoke" &&
          command.revocation.reason === "worker-generation-changed",
      ),
    ).toHaveLength(2);

    workers.disconnect("worker-1");
    await vi.waitFor(() => expect(coordinator.stats().sessions).toBe(0));
    expect(
      workers.commands.some(
        (command) =>
          command.type === "worker-link.session.revoke" &&
          command.sessionId === replacement.sessionId &&
          command.revocation.reason === "worker-disconnected",
      ),
    ).toBe(true);
    expect(workers.request).toHaveBeenCalledWith(
      "worker-1",
      expect.objectContaining({
        type: "worker-link.session.revoke",
        sessionId: replacement.sessionId,
      }),
      expect.objectContaining({ ownerId: "owner-1" }),
    );

    const accountSession = await coordinator.openSession(
      sessionInput({
        accountSessionId: "account-session-ended",
        clientInstanceId: "client-instance-4",
      }),
    );
    expect(
      await coordinator.revokeAccountSession("account-session-ended"),
    ).toBe(1);
    expect(
      workers.commands.some(
        (command) =>
          command.type === "worker-link.session.revoke" &&
          command.sessionId === accountSession.sessionId &&
          command.revocation.reason === "account-session-ended",
      ),
    ).toBe(true);

    const relogged = await coordinator.openSession(
      sessionInput({
        accountSessionId: "account-session-after-login",
        clientInstanceId: "client-instance-5",
      }),
    );
    expect(await coordinator.revokeOwner("owner-1")).toBe(1);
    expect(coordinator.stats().sessions).toBe(0);
    expect(
      workers.commands.some(
        (command) =>
          command.type === "worker-link.session.revoke" &&
          command.sessionId === relogged.sessionId,
      ),
    ).toBe(true);

    await expect(
      coordinator.openSession(
        sessionInput({
          accountSessionId: "account-session-new-login",
          clientInstanceId: "client-instance-6",
        }),
      ),
    ).resolves.toMatchObject({
      identity: {
        accountSessionId: "account-session-new-login",
        ownerId: "owner-1",
      },
    });

    await coordinator.close();
  });

  it("expires grants and sessions and rolls back failed installations", async () => {
    let now = Date.parse("2026-08-26T12:00:00.000Z");
    const workers = new FakeWorkerBus();
    const coordinator = new WorkerLinkCoordinator(workers.asBus(), {
      now: () => now,
      serverGeneration,
      serverId,
      sessionLeaseMs: 1_000,
      sessionLifetimeMs: 10_000,
      sweepIntervalMs: 0,
    });
    const session = await coordinator.openSession(sessionInput());
    const grant = await coordinator.issueGrant({
      lanes: ["interactive"],
      leaseMs: 500,
      operations: ["stream:open", "stream:read", "stream:write"],
      resourceId: "terminal-1",
      resourceKind: "terminal",
      sessionId: session.sessionId,
    });
    now += 600;
    expect(await coordinator.sweepExpired()).toBe(1);
    expect(coordinator.stats()).toEqual({ grants: 0, sessions: 1 });
    expect(
      workers.commands.some(
        (command) =>
          command.type === "worker-link.grant.revoke" &&
          command.grantId === grant.binding.grantId &&
          command.revocation.reason === "lease-expired",
      ),
    ).toBe(true);

    now += 500;
    expect(await coordinator.sweepExpired()).toBe(1);
    expect(coordinator.stats()).toEqual({ grants: 0, sessions: 0 });

    workers.requestImplementation = async (_workerId, command) => {
      if (command.type === "worker-link.session.install") {
        throw new Error("worker rejected install");
      }
      return { accepted: true };
    };
    await expect(
      coordinator.openSession(
        sessionInput({
          accountSessionId: "account-session-2",
          clientInstanceId: "client-instance-2",
        }),
      ),
    ).rejects.toThrow("worker rejected install");
    expect(coordinator.stats().sessions).toBe(0);

    await coordinator.close();
  });
});
