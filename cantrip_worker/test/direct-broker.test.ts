import { randomBytes, randomUUID } from "node:crypto";

import {
  decodeTunnelDataPlaneFrame,
  directBrokerReadySchema,
  encodeTunnelDataPlaneFrame,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { DirectBroker } from "../src/direct-broker.js";

const brokers: DirectBroker[] = [];

afterEach(async () => {
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
    await broker.prepare({
      type: "direct.capability.prepare",
      binding: grant,
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
    socket.close();
  });
});
