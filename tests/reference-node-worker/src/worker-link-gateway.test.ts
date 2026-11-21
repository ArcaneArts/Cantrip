import { createHash, randomUUID } from "node:crypto";

import {
  decodeTunnelDataPlaneFrame,
  encodeTunnelDataPlaneFrame,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";
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
import type { TunnelDestinationRouter } from "./tunnel-destination-router.js";
import { TunnelWorkerLinkAdapter } from "./tunnel-worker-link-adapter.js";

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
      enabled: ["local", "lan", "relay"],
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

    await expect(
      gateway.openChannel({ ...fixture.open, effectiveRoute: "relay" }),
    ).resolves.toMatchObject({
      kind: "accept",
      channel: fixture.open.channel,
      effectiveRoute: "relay",
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

  it("opens server-to-client event subscriptions without stream authority", async () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const fixture = fixtures(now);
    const subscriptionId = "77777777-7777-4777-8777-777777777777";
    const binding: WorkerLinkResourceGrant["binding"] = {
      ...fixture.grant.binding,
      resource: {
        kind: "observations",
        resourceId: "worker-1",
        attachmentId: subscriptionId,
      },
      lanes: ["events"],
      operations: ["events:subscribe"],
      maxChannels: 1,
    };
    const grant: WorkerLinkResourceGrant = { binding, token };
    const installed: InstalledWorkerLinkGrant = {
      binding,
      observation: {
        subscriptionId,
        topics: ["filesystem"],
      },
      tokenHash: createHash("sha256").update(token).digest("hex"),
    };
    let adapterEmitter: WorkerLinkAdapterEmitter | null = null;
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
      kind: "observations",
      open: ({ emit }) => {
        adapterEmitter = emit;
        return {};
      },
    });
    await gateway.handleCoordinatorCommand({
      type: "worker-link.session.install",
      session: fixture.session,
    });
    await gateway.handleCoordinatorCommand({
      type: "worker-link.grant.install",
      sessionId,
      grant: installed,
    });
    await expect(
      gateway.openChannel({
        ...fixture.open,
        lane: "events",
        channelKind: "reliable-stream",
        grant,
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      gateway.openChannel(
        {
          ...fixture.open,
          lane: "events",
          channelKind: "event-subscription",
          grant,
        },
        (header, payload) => {
          responses.push({ header, payload });
          return true;
        },
      ),
    ).resolves.toMatchObject({ kind: "accept", lane: "events" });
    expect(adapterEmitter).not.toBeNull();
    expect(adapterEmitter!.data(new Uint8Array([1, 2, 3]))).toBe(true);
    expect(responses).toContainEqual({
      header: expect.objectContaining({
        kind: "data",
        lane: "events",
        direction: "worker-to-client",
      }),
      payload: new Uint8Array([1, 2, 3]),
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
      gateway.openChannel({ ...fixture.open, effectiveRoute: "wan" }),
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
    const revoked = vi.fn();
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
      revoke: revoked,
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
    expect(revoked).toHaveBeenCalledWith({
      grant: fixture.installed,
      session: fixture.session,
    });
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

  it("authorizes peer sessions only within one exact installed session", async () => {
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
    const peerSession = {
      peerSessionId: randomUUID(),
      sessionId,
      identity: fixture.session.identity,
      routeGeneration: 1,
      route: "lan" as const,
      lease: fixture.session.lease,
    };

    expect(gateway.peerSessionAuthorized(peerSession)).toBe(true);
    expect(
      gateway.peerSessionAuthorized({ ...peerSession, route: "wan" }),
    ).toBe(false);
    expect(
      gateway.peerSessionAuthorized({
        ...peerSession,
        identity: {
          ...peerSession.identity,
          accountSessionId: "another-account-session",
        },
      }),
    ).toBe(false);
    expect(
      gateway.peerSessionAuthorized({ ...peerSession, routeGeneration: 2 }),
    ).toBe(false);
    expect(
      gateway.peerSessionAuthorized({
        ...peerSession,
        lease: {
          ...peerSession.lease,
          expiresAt: new Date(now + 90_000).toISOString(),
        },
      }),
    ).toBe(false);
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

  it("coalesces carrier wakeups without spending credit or sequence on rejection", async () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const fixture = fixtures(now);
    const payload = new Uint8Array(64 * 1_024);
    const attempts: WorkerLinkFrameHeader[] = [];
    let emit!: WorkerLinkAdapterEmitter;
    let carrierAvailable = false;
    let releaseCarrier!: (available: boolean) => void;
    const carrierCapacity = new Promise<boolean>((resolve) => {
      releaseCarrier = resolve;
    });
    let releaseSecondCarrier!: (available: boolean) => void;
    const secondCarrierCapacity = new Promise<boolean>((resolve) => {
      releaseSecondCarrier = resolve;
    });
    const waitForCapacity = vi.fn(() =>
      waitForCapacity.mock.calls.length === 1
        ? carrierCapacity
        : secondCarrierCapacity,
    );
    const wakeResults: boolean[] = [];
    const carrierWritable = vi.fn(() => {
      wakeResults.push(emit.data(payload));
    });
    const respond = Object.assign(
      (header: WorkerLinkFrameHeader) => {
        if (header.kind !== "data") return true;
        attempts.push(header);
        return carrierAvailable;
      },
      { waitForCapacity },
    );
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
      open: ({ emit: openedEmitter }) => {
        emit = openedEmitter;
        return { carrierWritable };
      },
    });
    await install(gateway, fixture);
    await expect(
      gateway.handleFrame(fixture.open, new Uint8Array(), respond),
    ).resolves.toBe(true);

    expect(emit.data(payload)).toBe(false);
    expect(emit.data(payload)).toBe(false);
    await vi.waitFor(() => expect(waitForCapacity).toHaveBeenCalledTimes(1));

    releaseCarrier(true);
    await vi.waitFor(() => expect(waitForCapacity).toHaveBeenCalledTimes(2));
    expect(wakeResults).toEqual([false]);
    carrierAvailable = true;
    releaseSecondCarrier(true);
    await vi.waitFor(() => expect(carrierWritable).toHaveBeenCalledTimes(2));
    expect(wakeResults).toEqual([false, true]);
    expect(attempts.slice(0, 4).map(({ sequence }) => sequence)).toEqual([
      1, 1, 1, 1,
    ]);

    expect(emit.data(payload)).toBe(true);
    expect(emit.data(payload)).toBe(true);
    expect(emit.data(payload)).toBe(true);
    expect(emit.data(new Uint8Array([1]))).toBe(false);
    expect(waitForCapacity).toHaveBeenCalledTimes(2);
    expect(attempts.slice(3).map(({ sequence }) => sequence)).toEqual([
      1, 2, 3, 4,
    ]);
    await gateway.close();
  });

  it("retries rejected credit controls exactly before waking adapter output", async () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const fixture = fixtures(now);
    const creditAttempts: Array<
      Extract<WorkerLinkFrameHeader, { kind: "credit" }>
    > = [];
    const write = vi.fn();
    const carrierWritable = vi.fn();
    let carrierAvailable = false;
    let releaseCarrier!: (available: boolean) => void;
    const capacity = new Promise<boolean>((resolve) => {
      releaseCarrier = resolve;
    });
    const waitForCapacity = vi.fn(() => capacity);
    const respond = Object.assign(
      (header: WorkerLinkFrameHeader) => {
        if (header.kind !== "credit") return true;
        creditAttempts.push(header);
        return carrierAvailable;
      },
      { waitForCapacity },
    );
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
      open: () => ({ carrierWritable, write }),
    });
    await install(gateway, fixture);
    await expect(
      gateway.handleFrame(fixture.open, new Uint8Array(), respond),
    ).resolves.toBe(true);

    for (const [sequence, payload] of [
      [1, new Uint8Array([1, 2, 3])],
      [2, new Uint8Array([4, 5])],
    ] as const) {
      await expect(
        gateway.handleFrame(
          {
            protocolVersion: 1,
            sessionId,
            routeGeneration: 1,
            effectiveRoute: "local",
            channel: fixture.open.channel,
            lane: "interactive",
            sequence,
            kind: "data",
            direction: "client-to-worker",
            payloadFormat: "raw",
          },
          payload,
          respond,
        ),
      ).resolves.toBe(true);
    }
    await vi.waitFor(() => expect(waitForCapacity).toHaveBeenCalledTimes(1));
    expect(write).toHaveBeenCalledTimes(2);
    expect(creditAttempts).toEqual([
      expect.objectContaining({ bytes: 3, sequence: 1 }),
    ]);

    carrierAvailable = true;
    releaseCarrier(true);
    await vi.waitFor(() => expect(carrierWritable).toHaveBeenCalledTimes(1));
    expect(
      creditAttempts.map(({ bytes, sequence }) => ({ bytes, sequence })),
    ).toEqual([
      { bytes: 3, sequence: 1 },
      { bytes: 3, sequence: 1 },
      { bytes: 2, sequence: 2 },
    ]);
    await gateway.close();
  });

  it("does not authorize input from credit queued behind carrier congestion", async () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const fixture = fixtures(now);
    fixture.open = { ...fixture.open, initialCreditBytes: 3 };
    const write = vi.fn();
    const responses: WorkerLinkFrameHeader[] = [];
    const capacity = new Promise<boolean>(() => undefined);
    const respond = Object.assign(
      (header: WorkerLinkFrameHeader) => {
        responses.push(header);
        return header.kind !== "credit";
      },
      { waitForCapacity: vi.fn(() => capacity) },
    );
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
      open: () => ({ write }),
    });
    await install(gateway, fixture);
    await gateway.handleFrame(fixture.open, new Uint8Array(), respond);

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
        new Uint8Array([1, 2, 3]),
        respond,
      ),
    ).resolves.toBe(true);
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
          kind: "data",
          direction: "client-to-worker",
          payloadFormat: "raw",
        },
        new Uint8Array([4]),
        respond,
      ),
    ).resolves.toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(responses.map(({ kind }) => kind)).toEqual([
      "accept",
      "credit",
      "close",
    ]);
    await gateway.close();
  });

  it("cancels a blocked accept before a sequence-zero rejection", async () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const fixture = fixtures(now);
    const attempts: WorkerLinkFrameHeader[] = [];
    let releaseCapacity!: (available: boolean) => void;
    const capacity = new Promise<boolean>((resolve) => {
      releaseCapacity = resolve;
    });
    const respond = Object.assign(
      (header: WorkerLinkFrameHeader) => {
        attempts.push(header);
        return header.kind === "reject";
      },
      { waitForCapacity: vi.fn(() => capacity) },
    );
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

    const opening = gateway.handleFrame(
      fixture.open,
      new Uint8Array(),
      respond,
    );
    await vi.waitFor(() =>
      expect(respond.waitForCapacity).toHaveBeenCalledTimes(1),
    );
    await expect(gateway.closeChannel(channelId, "revoked")).resolves.toBe(
      true,
    );
    await expect(opening).resolves.toBe(false);
    releaseCapacity(true);
    await Promise.resolve();
    expect(attempts.map(({ kind, sequence }) => ({ kind, sequence }))).toEqual([
      { kind: "accept", sequence: 0 },
      { kind: "reject", sequence: 0 },
    ]);
    await gateway.close();
  });

  it("does not emit stale credit when a channel closes during adapter write", async () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const fixture = fixtures(now);
    const responses: WorkerLinkFrameHeader[] = [];
    let finishWrite!: () => void;
    const writing = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const write = vi.fn(() => writing);
    const respond = (header: WorkerLinkFrameHeader) => {
      responses.push(header);
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
      open: () => ({ write }),
    });
    await install(gateway, fixture);
    await gateway.handleFrame(fixture.open, new Uint8Array(), respond);

    const handling = gateway.handleFrame(
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
      new Uint8Array([1, 2, 3]),
      respond,
    );
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    await gateway.closeChannel(channelId, "revoked");
    finishWrite();
    await expect(handling).resolves.toBe(true);
    expect(responses.map(({ kind, sequence }) => ({ kind, sequence }))).toEqual(
      [
        { kind: "accept", sequence: 0 },
        { kind: "close", sequence: 1 },
      ],
    );
    await gateway.close();
  });

  it("drains four exact 64 KiB nested tunnel frames through one outer credit window", async () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const fixture = fixtures(now);
    const tunnelId = "66666666-6666-4666-8666-666666666666";
    const attachmentId = "attachment-1";
    const binding: WorkerLinkResourceGrant["binding"] = {
      ...fixture.grant.binding,
      resource: { kind: "tunnel", resourceId: tunnelId, attachmentId },
      lanes: ["stream"],
      maxChannels: 1,
    };
    fixture.grant = { binding, token };
    fixture.installed = {
      binding,
      tokenHash: createHash("sha256").update(token).digest("hex"),
    };
    fixture.open = {
      ...fixture.open,
      grant: fixture.grant,
      lane: "stream",
    };
    const destinations = {
      handleFrame: vi.fn(),
      revokeAttachment: vi.fn(() => 1),
    };
    const tunnel = new TunnelWorkerLinkAdapter(
      destinations as unknown as TunnelDestinationRouter,
    );
    const responses: Array<{
      header: WorkerLinkFrameHeader;
      payload: Uint8Array;
    }> = [];
    const respond = (header: WorkerLinkFrameHeader, payload: Uint8Array) => {
      responses.push({ header, payload: payload.slice() });
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
    gateway.registerAdapter(tunnel);
    await install(gateway, fixture);
    await expect(
      gateway.handleFrame(fixture.open, new Uint8Array(), respond),
    ).resolves.toBe(true);

    const encodedFrames: Uint8Array[] = [];
    for (let sequence = 0; sequence < 5; sequence += 1) {
      const header: TunnelDataPlaneFrameHeader = {
        protocolVersion: 1,
        tunnelId,
        attachmentId,
        sourceEndpointId: `worker-link-client:${grantId}`,
        destinationEndpointId: "worker-link-worker:worker-1",
        connectionId: "nested-connection-1",
        sequence,
        kind: "data",
        direction: "destination-to-source",
      };
      const overhead =
        encodeTunnelDataPlaneFrame(header, new Uint8Array([1])).byteLength - 1;
      const payload = new Uint8Array(64 * 1_024 - overhead).fill(sequence + 1);
      encodedFrames.push(encodeTunnelDataPlaneFrame(header, payload));
    }
    expect(encodedFrames.map(({ byteLength }) => byteLength)).toEqual(
      Array(5).fill(64 * 1_024),
    );

    for (const encoded of encodedFrames.slice(0, 4)) {
      const nested = decodeTunnelDataPlaneFrame(encoded);
      expect(tunnel.routeFrame(nested.header, nested.payload)).toBe(true);
    }
    expect(
      responses
        .filter(({ header }) => header.kind === "data")
        .map(({ header, payload }) => ({
          sequence: header.sequence,
          payloadFormat:
            header.kind === "data" ? header.payloadFormat : undefined,
          payload,
        })),
    ).toEqual(
      encodedFrames.slice(0, 4).map((payload, index) => ({
        sequence: index + 1,
        payloadFormat: "tunnel-data-plane-v1",
        payload,
      })),
    );

    const fifth = decodeTunnelDataPlaneFrame(encodedFrames[4]!);
    expect(tunnel.routeFrame(fifth.header, fifth.payload)).toBe(false);
    const protocolCapacity = tunnel.waitForCapacity(attachmentId)!;
    let settled = false;
    void protocolCapacity.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await gateway.handleFrame(
      {
        protocolVersion: 1,
        sessionId,
        routeGeneration: 1,
        effectiveRoute: "local",
        channel: fixture.open.channel,
        lane: "stream",
        sequence: 1,
        kind: "credit",
        direction: "worker-to-client",
        bytes: encodedFrames[4]!.byteLength,
      },
      new Uint8Array(),
      respond,
    );
    await expect(protocolCapacity).resolves.toBe(true);
    expect(tunnel.routeFrame(fifth.header, fifth.payload)).toBe(true);
    expect(
      responses.filter(({ header }) => header.kind === "data").at(-1),
    ).toEqual({
      header: expect.objectContaining({ kind: "data", sequence: 5 }),
      payload: encodedFrames[4],
    });
    await gateway.close();
  });

  it("closes a blocked channel when its carrier cannot become writable", async () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const fixture = fixtures(now);
    let emit!: WorkerLinkAdapterEmitter;
    const close = vi.fn();
    const respond = Object.assign(
      (header: WorkerLinkFrameHeader) => header.kind !== "data",
      { waitForCapacity: vi.fn(async () => false) },
    );
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
      open: ({ emit: openedEmitter }) => {
        emit = openedEmitter;
        return { close };
      },
    });
    await install(gateway, fixture);
    await gateway.handleFrame(fixture.open, new Uint8Array(), respond);

    expect(emit.data(new Uint8Array([1]))).toBe(false);
    await vi.waitFor(() =>
      expect(close).toHaveBeenCalledWith("endpoint-disconnected"),
    );
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
