import { createHash, randomUUID } from "node:crypto";

import type {
  InstalledWorkerLinkGrant,
  WorkerLinkFrameHeader,
  WorkerLinkResourceGrant,
  WorkerLinkSession,
} from "@cantrip/protocol/worker-link";
import { describe, expect, it, vi } from "vitest";

import {
  WorkerLinkGateway,
  type WorkerLinkAdapterEmitter,
} from "./worker-link-gateway.js";

const serverId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const serverGeneration = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const workerGeneration = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const sessionId = "11111111-1111-4111-8111-111111111111";
const grantId = "22222222-2222-4222-8222-222222222222";
const channelId = "33333333-3333-4333-8333-333333333333";
const connectionId = "44444444-4444-4444-8444-444444444444";
const token = "a".repeat(43);

function fixtures(now: number) {
  const identity = {
    serverId,
    serverGeneration,
    ownerId: "owner-1",
    accountSessionId: "account-session-1",
    clientInstanceId: "client-instance-1",
    workerId: "worker-1",
    workerProcessGeneration: workerGeneration,
  };
  const lease = {
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    absoluteExpiresAt: new Date(now + 120_000).toISOString(),
  };
  const session: WorkerLinkSession = {
    sessionId,
    identity,
    lease,
    routePolicy: {
      priority: ["local", "lan", "wan", "relay"],
      enabled: ["local", "relay"],
    },
    routeGeneration: 1,
    preferredRoute: "local",
  };
  const binding: WorkerLinkResourceGrant["binding"] = {
    grantId,
    grantGeneration: 1,
    sessionId,
    identity,
    resource: {
      kind: "terminal" as const,
      resourceId: "terminal-1",
      attachmentId: "attachment-1",
    },
    lanes: ["interactive", "stream"],
    operations: [
      "stream:open",
      "stream:read",
      "stream:write",
      "stream:half-close",
    ],
    maxChannels: 2,
    lease,
  };
  const grant: WorkerLinkResourceGrant = { binding, token };
  const installed: InstalledWorkerLinkGrant = {
    binding,
    tokenHash: createHash("sha256").update(token).digest("hex"),
  };
  const open: Extract<WorkerLinkFrameHeader, { kind: "open" }> = {
    protocolVersion: 1,
    sessionId,
    routeGeneration: 1,
    effectiveRoute: "local",
    channel: { channelId, connectionId },
    lane: "interactive",
    sequence: 0,
    kind: "open",
    openNonce: "55555555-5555-4555-8555-555555555555",
    channelKind: "reliable-stream",
    grant,
    initialCreditBytes: 256 * 1_024,
  };
  return { grant, installed, open, session };
}

async function install(
  gateway: WorkerLinkGateway,
  fixture: ReturnType<typeof fixtures>,
) {
  await gateway.handleCoordinatorCommand({
    type: "worker-link.session.install",
    session: fixture.session,
  });
  await gateway.handleCoordinatorCommand({
    type: "worker-link.grant.install",
    sessionId: fixture.session.sessionId,
    grant: fixture.installed,
  });
}

describe("WorkerLinkGateway", () => {
  it("opens only adapter-scoped channels and rejects replayed bearer grants", async () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const fixture = fixtures(now);
    const closed = vi.fn();
    const opened = vi.fn(() => ({ close: closed }));
    const gateway = new WorkerLinkGateway({
      now: () => now,
      ownerId: "owner-1",
      serverId,
      sweepIntervalMs: 0,
      workerId: "worker-1",
      workerProcessGeneration: workerGeneration,
    });
    gateway.registerAdapter({ kind: "terminal", open: opened });
    await install(gateway, fixture);

    await expect(gateway.openChannel(fixture.open)).resolves.toMatchObject({
      kind: "accept",
      channel: fixture.open.channel,
      effectiveRoute: "local",
      routeGeneration: 1,
    });
    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({
        grant: fixture.installed,
        lane: "interactive",
        session: fixture.session,
      }),
    );
    expect(gateway.stats()).toMatchObject({
      channels: 1,
      grants: 1,
      sessions: 1,
    });
    await gateway.closeChannel(channelId);
    await expect(gateway.openChannel(fixture.open)).rejects.toMatchObject({
      code: "grant-replayed",
    });

    const second = {
      ...fixture.open,
      channel: { channelId: randomUUID(), connectionId: randomUUID() },
      openNonce: randomUUID(),
      grant: { ...fixture.grant, token: "b".repeat(43) },
    };
    await expect(gateway.openChannel(second)).rejects.toMatchObject({
      code: "unauthorized",
    });
    await gateway.close();
  });

  it("rejects cross-session, cross-account, stale-route, and wrong-process authority", async () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const fixture = fixtures(now);
    const gateway = new WorkerLinkGateway({
      now: () => now,
      ownerId: "owner-1",
      serverId,
      sweepIntervalMs: 0,
      workerId: "worker-1",
      workerProcessGeneration: workerGeneration,
    });
    gateway.registerAdapter({ kind: "terminal", open: () => ({}) });
    await install(gateway, fixture);

    await expect(
      gateway.openChannel({ ...fixture.open, routeGeneration: 2 }),
    ).rejects.toMatchObject({ code: "route-generation-stale" });
    await expect(
      gateway.openChannel({ ...fixture.open, sessionId: randomUUID() }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      gateway.openChannel({
        ...fixture.open,
        grant: {
          ...fixture.grant,
          binding: {
            ...fixture.grant.binding,
            identity: {
              ...fixture.grant.binding.identity,
              accountSessionId: "another-account-session",
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: "wrong-account-session" });

    const wrongProcess = fixtures(now);
    wrongProcess.session = {
      ...wrongProcess.session,
      sessionId: randomUUID(),
      identity: {
        ...wrongProcess.session.identity,
        workerProcessGeneration: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      },
    };
    await expect(
      gateway.handleCoordinatorCommand({
        type: "worker-link.session.install",
        session: wrongProcess.session,
      }),
    ).rejects.toThrow(/another worker process/i);

    await gateway.close();
  });

  it("renews only the installed session and grant generations", async () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const fixture = fixtures(now);
    const gateway = new WorkerLinkGateway({
      now: () => now,
      ownerId: "owner-1",
      serverId,
      sweepIntervalMs: 0,
      workerId: "worker-1",
      workerProcessGeneration: workerGeneration,
    });
    await install(gateway, fixture);
    const renewedLease = {
      ...fixture.session.lease,
      expiresAt: new Date(now + 90_000).toISOString(),
    };
    await expect(
      gateway.handleCoordinatorCommand({
        type: "worker-link.session.renew",
        sessionId,
        lease: renewedLease,
      }),
    ).resolves.toEqual({ accepted: true });
    await expect(
      gateway.handleCoordinatorCommand({
        type: "worker-link.grant.renew",
        sessionId,
        grantId,
        grantGeneration: 1,
        lease: renewedLease,
      }),
    ).resolves.toEqual({ accepted: true });
    await expect(
      gateway.handleCoordinatorCommand({
        type: "worker-link.grant.renew",
        sessionId,
        grantId,
        grantGeneration: 2,
        lease: renewedLease,
      }),
    ).rejects.toThrow(/not installed at this generation/i);
    await expect(
      gateway.handleCoordinatorCommand({
        type: "worker-link.session.route",
        sessionId,
        preferredRoute: "relay",
        routeGeneration: 2,
      }),
    ).resolves.toEqual({ accepted: true });
    await expect(
      gateway.handleCoordinatorCommand({
        type: "worker-link.session.route",
        sessionId,
        preferredRoute: "local",
        routeGeneration: 4,
      }),
    ).rejects.toThrow(/generation is invalid/i);
    await gateway.close();
  });

  it("retires active channels when the route generation changes", async () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const fixture = fixtures(now);
    const closed = vi.fn();
    const gateway = new WorkerLinkGateway({
      now: () => now,
      ownerId: "owner-1",
      serverId,
      sweepIntervalMs: 0,
      workerId: "worker-1",
      workerProcessGeneration: workerGeneration,
    });
    gateway.registerAdapter({
      kind: "terminal",
      open: () => ({ close: closed }),
    });
    await install(gateway, fixture);
    await gateway.openChannel(fixture.open);

    await gateway.handleCoordinatorCommand({
      type: "worker-link.session.route",
      sessionId,
      preferredRoute: "relay",
      routeGeneration: 2,
    });
    expect(closed).toHaveBeenCalledWith("route-replaced");
    expect(gateway.stats().channels).toBe(0);

    const replacement = {
      ...fixture.open,
      channel: { channelId: randomUUID(), connectionId: randomUUID() },
      openNonce: randomUUID(),
    };
    await expect(gateway.openChannel(replacement)).rejects.toMatchObject({
      code: "route-generation-stale",
    });
    await expect(
      gateway.openChannel({
        ...replacement,
        channel: { channelId: randomUUID(), connectionId: randomUUID() },
        effectiveRoute: "relay",
        openNonce: randomUUID(),
        routeGeneration: 2,
      }),
    ).resolves.toMatchObject({
      effectiveRoute: "relay",
      routeGeneration: 2,
    });
    await gateway.close();
  });

  it("expires and independently revokes grants while closing their channels", async () => {
    let now = Date.parse("2026-08-26T12:00:00.000Z");
    const fixture = fixtures(now);
    const closed = vi.fn();
    const gateway = new WorkerLinkGateway({
      now: () => now,
      ownerId: "owner-1",
      serverId,
      sweepIntervalMs: 0,
      workerId: "worker-1",
      workerProcessGeneration: workerGeneration,
    });
    gateway.registerAdapter({
      kind: "terminal",
      open: () => ({ close: closed }),
    });
    await install(gateway, fixture);
    await gateway.openChannel(fixture.open);

    await gateway.handleCoordinatorCommand({
      type: "worker-link.grant.revoke",
      sessionId,
      grantId,
      grantGeneration: 1,
      revocation: {
        reason: "resource-stopped",
        revokedAt: new Date(now).toISOString(),
      },
    });
    expect(closed).toHaveBeenCalledWith("revoked");
    expect(gateway.stats()).toMatchObject({ channels: 0, grants: 0 });
    await expect(gateway.openChannel(fixture.open)).rejects.toMatchObject({
      code: "grant-revoked",
    });

    const expiring = fixtures(now);
    expiring.session = {
      ...expiring.session,
      sessionId: randomUUID(),
      identity: {
        ...expiring.session.identity,
        clientInstanceId: "client-instance-2",
      },
    };
    expiring.installed = {
      ...expiring.installed,
      binding: {
        ...expiring.installed.binding,
        grantId: randomUUID(),
        sessionId: expiring.session.sessionId,
        identity: expiring.session.identity,
      },
    };
    await gateway.handleCoordinatorCommand({
      type: "worker-link.session.install",
      session: expiring.session,
    });
    await gateway.handleCoordinatorCommand({
      type: "worker-link.grant.install",
      sessionId: expiring.session.sessionId,
      grant: expiring.installed,
    });
    now += 60_001;
    expect(await gateway.sweepExpired()).toBeGreaterThanOrEqual(1);
    expect(gateway.stats().sessions).toBe(0);

    await gateway.close();
  });

  it("does not turn installed authority into arbitrary worker access", async () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const fixture = fixtures(now);
    const gateway = new WorkerLinkGateway({
      now: () => now,
      ownerId: "owner-1",
      serverId,
      sweepIntervalMs: 0,
      workerId: "worker-1",
      workerProcessGeneration: workerGeneration,
    });
    await install(gateway, fixture);
    await expect(gateway.openChannel(fixture.open)).rejects.toMatchObject({
      code: "resource-unavailable",
    });
    expect(gateway.stats().channels).toBe(0);

    const foreignServer = fixtures(now);
    foreignServer.session = {
      ...foreignServer.session,
      sessionId: randomUUID(),
      identity: { ...foreignServer.session.identity, serverId: randomUUID() },
    };
    await expect(
      gateway.handleCoordinatorCommand({
        type: "worker-link.session.install",
        session: foreignServer.session,
      }),
    ).rejects.toThrow(/another server/i);

    const foreignServerGeneration = fixtures(now);
    foreignServerGeneration.session = {
      ...foreignServerGeneration.session,
      sessionId: randomUUID(),
      identity: {
        ...foreignServerGeneration.session.identity,
        serverGeneration: randomUUID(),
      },
    };
    await expect(
      gateway.handleCoordinatorCommand({
        type: "worker-link.session.install",
        session: foreignServerGeneration.session,
      }),
    ).resolves.toEqual({ accepted: true });

    const foreignAccount = fixtures(now);
    foreignAccount.session = {
      ...foreignAccount.session,
      sessionId: randomUUID(),
      identity: {
        ...foreignAccount.session.identity,
        ownerId: "owner-2",
      },
    };
    await expect(
      gateway.handleCoordinatorCommand({
        type: "worker-link.session.install",
        session: foreignAccount.session,
      }),
    ).rejects.toThrow(/another account/i);

    await gateway.close();
  });

  it("revokes installed state when the worker security identity changes", async () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const fixture = fixtures(now);
    let ownerId = "owner-1";
    const closed = vi.fn();
    const gateway = new WorkerLinkGateway({
      now: () => now,
      ownerId: () => ownerId,
      serverId,
      sweepIntervalMs: 0,
      workerId: "worker-1",
      workerProcessGeneration: workerGeneration,
    });
    gateway.registerAdapter({
      kind: "terminal",
      open: () => ({ close: closed }),
    });
    await install(gateway, fixture);
    await gateway.openChannel(fixture.open);

    ownerId = "owner-2";
    expect(await gateway.reconcileSecurityIdentity()).toBe(1);
    expect(gateway.stats()).toEqual({
      channels: 0,
      grants: 0,
      invalidAttempts: 0,
      sessions: 0,
    });
    expect(closed).toHaveBeenCalledWith("revoked");
    await gateway.close();
  });

  it("runs reliable stream frames through adapters with sequence and credit fencing", async () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const fixture = fixtures(now);
    const write = vi.fn();
    const credit = vi.fn();
    let emit!: WorkerLinkAdapterEmitter;
    const responses: Array<{
      header: WorkerLinkFrameHeader;
      payload: Uint8Array;
    }> = [];
    const respond = (header: WorkerLinkFrameHeader, payload: Uint8Array) => {
      responses.push({ header, payload });
      return true;
    };
    const gateway = new WorkerLinkGateway({
      now: () => now,
      ownerId: "owner-1",
      serverId,
      sweepIntervalMs: 0,
      workerId: "worker-1",
      workerProcessGeneration: workerGeneration,
    });
    gateway.registerAdapter({
      kind: "terminal",
      open: (context) => {
        emit = context.emit;
        return { credit, write };
      },
    });
    await install(gateway, fixture);

    await expect(
      gateway.handleFrame(fixture.open, new Uint8Array(), respond),
    ).resolves.toBe(true);
    expect(responses[0]?.header).toMatchObject({ kind: "accept", sequence: 0 });

    const input = new Uint8Array([1, 2, 3]);
    await expect(
      gateway.handleFrame(
        {
          protocolVersion: 1,
          sessionId,
          routeGeneration: 1,
          effectiveRoute: "local",
          channel: fixture.open.channel,
          lane: "interactive",
          sequence: 1,
          kind: "data",
          direction: "client-to-worker",
          payloadFormat: "raw",
        },
        input,
        respond,
      ),
    ).resolves.toBe(true);
    expect(write).toHaveBeenCalledWith(input);
    expect(responses[1]?.header).toMatchObject({
      kind: "credit",
      direction: "client-to-worker",
      bytes: 3,
      sequence: 1,
    });

    expect(emit.data(new Uint8Array([4, 5]))).toBe(true);
    expect(responses[2]).toMatchObject({
      header: {
        kind: "data",
        direction: "worker-to-client",
        sequence: 2,
      },
      payload: new Uint8Array([4, 5]),
    });

    await expect(
      gateway.handleFrame(
        {
          protocolVersion: 1,
          sessionId,
          routeGeneration: 1,
          effectiveRoute: "local",
          channel: fixture.open.channel,
          lane: "interactive",
          sequence: 2,
          kind: "credit",
          direction: "worker-to-client",
          bytes: 2,
        },
        new Uint8Array(),
        respond,
      ),
    ).resolves.toBe(true);
    expect(credit).toHaveBeenCalledWith(2);

    await expect(
      gateway.handleFrame(
        {
          protocolVersion: 1,
          sessionId,
          routeGeneration: 2,
          effectiveRoute: "local",
          channel: fixture.open.channel,
          lane: "interactive",
          sequence: 3,
          kind: "half-close",
          direction: "client-to-worker",
        },
        new Uint8Array(),
        respond,
      ),
    ).resolves.toBe(false);
    expect(responses.at(-1)?.header).toMatchObject({
      kind: "close",
      code: "protocol-error",
    });
    expect(gateway.stats().channels).toBe(0);
    await gateway.close();
  });

  it("orders synchronous adapter output after the channel acceptance", async () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const fixture = fixtures(now);
    const responses: Array<{
      header: WorkerLinkFrameHeader;
      payload: Uint8Array;
    }> = [];
    const gateway = new WorkerLinkGateway({
      now: () => now,
      ownerId: "owner-1",
      serverId,
      sweepIntervalMs: 0,
      workerId: "worker-1",
      workerProcessGeneration: workerGeneration,
    });
    gateway.registerAdapter({
      kind: "terminal",
      open: ({ emit }) => {
        expect(emit.data(new Uint8Array([7, 8]))).toBe(true);
        return {};
      },
    });
    await install(gateway, fixture);

    await expect(
      gateway.handleFrame(fixture.open, new Uint8Array(), (header, payload) => {
        responses.push({ header, payload });
        return true;
      }),
    ).resolves.toBe(true);
    expect(responses.map(({ header }) => header.kind)).toEqual([
      "accept",
      "data",
    ]);
    expect(responses[1]).toMatchObject({
      header: { direction: "worker-to-client", sequence: 1 },
      payload: new Uint8Array([7, 8]),
    });
    await gateway.close();
  });

  it("closes an accepted adapter when the acceptance cannot be delivered", async () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const fixture = fixtures(now);
    const close = vi.fn();
    const gateway = new WorkerLinkGateway({
      now: () => now,
      ownerId: "owner-1",
      serverId,
      sweepIntervalMs: 0,
      workerId: "worker-1",
      workerProcessGeneration: workerGeneration,
    });
    gateway.registerAdapter({ kind: "terminal", open: () => ({ close }) });
    await install(gateway, fixture);

    await expect(
      gateway.handleFrame(fixture.open, new Uint8Array(), () => false),
    ).resolves.toBe(false);
    expect(close).toHaveBeenCalledWith("endpoint-disconnected");
    expect(gateway.stats().channels).toBe(0);
    await gateway.close();
  });

  it("reserves capacity while adapters are opening concurrently", async () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const fixture = fixtures(now);
    fixture.installed = {
      ...fixture.installed,
      binding: { ...fixture.installed.binding, maxChannels: 1 },
    };
    fixture.open = {
      ...fixture.open,
      grant: {
        ...fixture.open.grant,
        binding: { ...fixture.open.grant.binding, maxChannels: 1 },
      },
    };
    let finishOpen!: () => void;
    const opening = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });
    const adapterStarted = vi.fn();
    const gateway = new WorkerLinkGateway({
      maxActiveChannels: 1,
      now: () => now,
      ownerId: "owner-1",
      serverId,
      sweepIntervalMs: 0,
      workerId: "worker-1",
      workerProcessGeneration: workerGeneration,
    });
    gateway.registerAdapter({
      kind: "terminal",
      open: async () => {
        adapterStarted();
        await opening;
        return {};
      },
    });
    await install(gateway, fixture);

    const first = gateway.openChannel(fixture.open);
    await vi.waitFor(() => expect(adapterStarted).toHaveBeenCalledOnce());
    const second = {
      ...fixture.open,
      channel: { channelId: randomUUID(), connectionId: randomUUID() },
      openNonce: randomUUID(),
    };
    await expect(gateway.openChannel(second)).rejects.toMatchObject({
      code: "limit-exceeded",
    });
    finishOpen();
    await expect(first).resolves.toMatchObject({ kind: "accept" });
    expect(gateway.stats().channels).toBe(1);
    await gateway.close();
  });
});
