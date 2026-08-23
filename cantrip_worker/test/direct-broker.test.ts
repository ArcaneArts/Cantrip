import { randomBytes, randomUUID } from "node:crypto";

import {
  decodeTunnelDataPlaneFrame,
  directBrokerReadySchema,
  encodeTunnelDataPlaneFrame,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { DirectBroker } from "../src/direct-broker.js";
import { subscribeWorkerLogs } from "../src/logger.js";

const brokers: DirectBroker[] = [];
const subscriptions: Array<() => void> = [];

afterEach(async () => {
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
});

function binding(workerId = "worker-1") {
  return {
    capabilityId: randomUUID(),
    ownerId: "owner-1",
    authSessionId: "session-1",
    workerId,
    resourceKind: "probe" as const,
    resourceId: workerId,
    attachmentId: randomUUID(),
    channels: ["probe"],
    expiresAt: new Date(Date.now() + 10_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() + 20_000).toISOString(),
  };
}

async function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/direct/v1`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function rejectedInitialization(
  port: number,
  grant: ReturnType<typeof binding>,
  secret: string,
): Promise<number> {
  const socket = await connect(port);
  const closed = new Promise<number>((resolve) =>
    socket.once("close", (code) => resolve(code)),
  );
  socket.send(
    JSON.stringify({
      type: "initialize",
      binding: grant,
      secret,
      challenge: randomBytes(32).toString("base64url"),
    }),
  );
  return closed;
}

describe("DirectBroker", () => {
  it("binds loopback only and consumes an authenticated capability once", async () => {
    const broker = new DirectBroker();
    brokers.push(broker);
    const advertisement = await broker.start();
    expect(advertisement).toMatchObject({
      available: true,
      loopbackHost: "127.0.0.1",
      protocol: "ws-v1",
    });
    if (!advertisement.available) throw new Error("broker unavailable");
    const grant = binding();
    const secret = randomBytes(32).toString("base64url");
    await broker.prepare({
      type: "direct.capability.prepare",
      binding: grant,
      secret,
    });
    const socket = await connect(advertisement.loopbackPort);
    const ready = new Promise<unknown>((resolve) =>
      socket.once("message", (data) => resolve(JSON.parse(String(data)))),
    );
    socket.send(
      JSON.stringify({
        type: "initialize",
        binding: grant,
        secret,
        challenge: randomBytes(32).toString("base64url"),
      }),
    );
    expect(directBrokerReadySchema.parse(await ready)).toMatchObject({
      brokerInstanceId: advertisement.instanceId,
      fingerprint: advertisement.fingerprint,
    });
    socket.close();

    const replay = await connect(advertisement.loopbackPort);
    const closed = new Promise<number>((resolve) =>
      replay.once("close", (code) => resolve(code)),
    );
    replay.send(
      JSON.stringify({
        type: "initialize",
        binding: grant,
        secret,
        challenge: randomBytes(32).toString("base64url"),
      }),
    );
    expect(await closed).toBe(1008);
  });

  it("revokes all grants when the authenticated server channel is lost", async () => {
    const broker = new DirectBroker();
    brokers.push(broker);
    const advertisement = await broker.start();
    if (!advertisement.available) throw new Error("broker unavailable");
    const grant = binding();
    const secret = randomBytes(32).toString("base64url");
    await broker.prepare({
      type: "direct.capability.prepare",
      binding: grant,
      secret,
    });
    broker.revokeAll();
    const socket = await connect(advertisement.loopbackPort);
    const closed = new Promise<number>((resolve) =>
      socket.once("close", (code) => resolve(code)),
    );
    socket.send(
      JSON.stringify({
        type: "initialize",
        binding: grant,
        secret,
        challenge: randomBytes(32).toString("base64url"),
      }),
    );
    expect(await closed).toBe(1008);
  });

  it("rejects wrong bindings, expired tickets, and revoked capabilities", async () => {
    const broker = new DirectBroker();
    brokers.push(broker);
    const advertisement = await broker.start();
    if (!advertisement.available) throw new Error("broker unavailable");

    for (const mutate of [
      (grant: ReturnType<typeof binding>) => ({
        ...grant,
        workerId: "worker-2",
      }),
      (grant: ReturnType<typeof binding>) => ({
        ...grant,
        resourceId: "another-resource",
      }),
    ]) {
      const grant = binding();
      const secret = randomBytes(32).toString("base64url");
      await broker.prepare({
        type: "direct.capability.prepare",
        binding: grant,
        secret,
      });
      await expect(
        rejectedInitialization(
          advertisement.loopbackPort,
          mutate(grant),
          secret,
        ),
      ).resolves.toBe(1008);
      broker.revoke(grant.capabilityId, "test cleanup");
    }

    const expired = {
      ...binding(),
      expiresAt: new Date(Date.now() - 1).toISOString(),
    };
    await expect(
      broker.prepare({
        type: "direct.capability.prepare",
        binding: expired,
        secret: randomBytes(32).toString("base64url"),
      }),
    ).rejects.toThrow("expired");

    const revoked = binding();
    const revokedSecret = randomBytes(32).toString("base64url");
    await broker.prepare({
      type: "direct.capability.prepare",
      binding: revoked,
      secret: revokedSecret,
    });
    broker.revoke(revoked.capabilityId, "Authorization session was revoked");
    await expect(
      rejectedInitialization(
        advertisement.loopbackPort,
        revoked,
        revokedSecret,
      ),
    ).resolves.toBe(1008);
  });

  it("injects the server-authorized target into direct tunnel frames", async () => {
    const broker = new DirectBroker();
    brokers.push(broker);
    const advertisement = await broker.start();
    if (!advertisement.available) throw new Error("broker unavailable");
    const attachmentId = randomUUID();
    const tunnelId = randomUUID();
    const grant = {
      ...binding(),
      resourceKind: "project-share" as const,
      resourceId: attachmentId,
      attachmentId,
      channels: ["tunnel-data"],
    };
    const route = {
      tunnelId,
      attachmentId,
      sourceEndpointId: `desktop:client:${attachmentId}`,
      destinationEndpointId: "worker:worker-1",
      target: { kind: "tcp" as const, host: "127.0.0.1", port: 4173 },
    };
    const secret = randomBytes(32).toString("base64url");
    const diagnosticTraceId = randomUUID();
    const records: Array<{ context?: unknown }> = [];
    const unsubscribe = subscribeWorkerLogs((record) => records.push(record));
    subscriptions.push(unsubscribe);
    await broker.prepare({
      type: "direct.capability.prepare",
      binding: grant,
      diagnosticTraceId,
      secret,
      tunnelRoute: route,
    });
    const routed = new Promise<TunnelDataPlaneFrameHeader>((resolve) =>
      broker.setTunnelFrameHandler((header) => resolve(header)),
    );
    const socket = await connect(advertisement.loopbackPort);
    const ready = new Promise<void>((resolve) =>
      socket.once("message", () => resolve()),
    );
    socket.send(
      JSON.stringify({
        type: "initialize",
        binding: grant,
        secret,
        challenge: randomBytes(32).toString("base64url"),
      }),
    );
    await ready;
    const { target: _target, ...publicRoute } = route;
    const open: TunnelDataPlaneFrameHeader = {
      protocolVersion: 1,
      ...publicRoute,
      connectionId: randomUUID(),
      sequence: 0,
      kind: "open",
      initialCreditBytes: 1_024,
    };
    socket.send(encodeTunnelDataPlaneFrame(open, new Uint8Array()));
    await expect(routed).resolves.toMatchObject({
      kind: "connect",
      target: route.target,
    });

    const response = new Promise<ReturnType<typeof decodeTunnelDataPlaneFrame>>(
      (resolve) =>
        socket.once("message", (data) =>
          resolve(decodeTunnelDataPlaneFrame(Buffer.from(data as Buffer))),
        ),
    );
    expect(
      broker.routeTunnelFrame(
        {
          ...open,
          kind: "accepted",
          initialCreditBytes: 1_024,
        },
        new Uint8Array(),
      ),
    ).toBe(true);
    await expect(response).resolves.toMatchObject({
      header: { kind: "accepted", connectionId: open.connectionId },
    });
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          context: expect.objectContaining({
            event: "direct.capability.prepared",
            diagnosticTraceId,
          }),
        }),
        expect.objectContaining({
          context: expect.objectContaining({
            event: "direct.capability.connected",
            diagnosticTraceId,
          }),
        }),
        expect.objectContaining({
          context: expect.objectContaining({
            event: "direct.connection.accepted",
            diagnosticTraceId,
            tunnelId,
            attachmentId,
            connectionId: open.connectionId,
          }),
        }),
      ]),
    );
    const escapedConnectionId = randomUUID();
    const closed = new Promise<number>((resolve) =>
      socket.once("close", (code) => resolve(code)),
    );
    socket.send(
      encodeTunnelDataPlaneFrame(
        {
          ...open,
          tunnelId: randomUUID(),
          connectionId: escapedConnectionId,
        },
        new Uint8Array(),
      ),
    );
    await expect(closed).resolves.toBe(1003);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          context: expect.objectContaining({
            event: "direct.capability.disconnected",
            diagnosticTraceId,
          }),
        }),
        expect.objectContaining({
          context: expect.objectContaining({
            event: "direct.frame.rejected",
            reasonCode: "capability-binding-mismatch",
            diagnosticTraceId,
            tunnelId,
            attachmentId,
            connectionId: escapedConnectionId,
          }),
        }),
      ]),
    );
    const captured = JSON.stringify(records);
    expect(captured).not.toContain(grant.capabilityId);
    expect(captured).not.toContain(secret);
    unsubscribe();
    subscriptions.splice(subscriptions.indexOf(unsubscribe), 1);
  });

  it("keeps the direct capability alive while a source acknowledges a destination close", async () => {
    const broker = new DirectBroker();
    brokers.push(broker);
    const advertisement = await broker.start();
    if (!advertisement.available) throw new Error("broker unavailable");
    const attachmentId = randomUUID();
    const tunnelId = randomUUID();
    const grant = {
      ...binding(),
      resourceKind: "tunnel" as const,
      resourceId: tunnelId,
      attachmentId,
      channels: ["tunnel-data"],
    };
    const route = {
      tunnelId,
      attachmentId,
      sourceEndpointId: `desktop:client:${attachmentId}`,
      destinationEndpointId: "worker:worker-1",
      target: { kind: "tcp" as const, host: "127.0.0.1", port: 4173 },
    };
    const secret = randomBytes(32).toString("base64url");
    await broker.prepare({
      type: "direct.capability.prepare",
      binding: grant,
      secret,
      tunnelRoute: route,
    });
    const routed: TunnelDataPlaneFrameHeader[] = [];
    broker.setTunnelFrameHandler((header) => routed.push(header));
    const socket = await connect(advertisement.loopbackPort);
    const ready = new Promise<void>((resolve) =>
      socket.once("message", () => resolve()),
    );
    socket.send(
      JSON.stringify({
        type: "initialize",
        binding: grant,
        secret,
        challenge: randomBytes(32).toString("base64url"),
      }),
    );
    await ready;
    const { target: _target, ...publicRoute } = route;
    const firstConnectionId = randomUUID();
    const firstOpen: TunnelDataPlaneFrameHeader = {
      protocolVersion: 1,
      ...publicRoute,
      connectionId: firstConnectionId,
      sequence: 0,
      kind: "open",
      initialCreditBytes: 1_024,
    };
    socket.send(encodeTunnelDataPlaneFrame(firstOpen, new Uint8Array()));
    await vi.waitFor(() =>
      expect(routed).toContainEqual(
        expect.objectContaining({
          connectionId: firstConnectionId,
          kind: "connect",
        }),
      ),
    );

    const destinationClose = new Promise<void>((resolve) =>
      socket.once("message", () => resolve()),
    );
    expect(
      broker.routeTunnelFrame(
        {
          protocolVersion: 1,
          ...publicRoute,
          connectionId: firstConnectionId,
          sequence: 0,
          kind: "close",
          code: "normal",
        },
        new Uint8Array(),
      ),
    ).toBe(true);
    await destinationClose;
    socket.send(
      encodeTunnelDataPlaneFrame(
        {
          protocolVersion: 1,
          ...publicRoute,
          connectionId: firstConnectionId,
          sequence: 1,
          kind: "close",
          code: "normal",
        },
        new Uint8Array(),
      ),
    );

    const secondConnectionId = randomUUID();
    socket.send(
      encodeTunnelDataPlaneFrame(
        {
          ...firstOpen,
          connectionId: secondConnectionId,
        },
        new Uint8Array(),
      ),
    );
    await vi.waitFor(() =>
      expect(routed).toContainEqual(
        expect.objectContaining({
          connectionId: secondConnectionId,
          kind: "connect",
        }),
      ),
    );
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });
});
