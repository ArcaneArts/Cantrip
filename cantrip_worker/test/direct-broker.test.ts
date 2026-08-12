import { randomBytes, randomUUID } from "node:crypto";

import { directBrokerReadySchema } from "@cantrip/protocol";
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
    broker.prepare({
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
    broker.prepare({
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
});
