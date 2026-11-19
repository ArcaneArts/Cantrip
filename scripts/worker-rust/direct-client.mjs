import assert from "node:assert/strict";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import {
  directAttachmentTicketSchema,
  directBrokerReadySchema,
} from "../../packages/protocol/dist/direct-data-plane.js";

const WebSocket = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("ws");

export async function connectDirect(
  ticket,
  { initialize = ticket, expectClose } = {},
) {
  const { broker, binding } = ticket;
  assert.equal(broker.loopbackHost, "127.0.0.1");
  assert.equal(broker.leaseRenewal, true);
  const socket = new WebSocket(
    `ws://${broker.loopbackHost}:${broker.loopbackPort}/direct/v1`,
  );
  let ready;
  let failure;
  const onError = (error) => {
    failure ??= error;
  };
  const onReady = (bytes, binary) => {
    try {
      assert.equal(binary, false);
      ready = directBrokerReadySchema.parse(JSON.parse(bytes.toString()));
    } catch (error) {
      failure ??= error;
    }
  };
  // Keep an error listener while control passes to the channel fixture.
  socket.on("error", onError);
  socket.on("message", onReady);
  try {
    await once(socket, "open", { signal: AbortSignal.timeout(5000) });
    const challenge = randomBytes(32).toString("base64url");
    const stopped =
      expectClose === undefined
        ? null
        : once(socket, "close", { signal: AbortSignal.timeout(5000) });
    socket.send(
      JSON.stringify({
        type: "initialize",
        binding: initialize.binding,
        secret: initialize.secret,
        challenge,
      }),
    );
    if (stopped) {
      assert.equal((await stopped)[0], expectClose);
      assert.equal(ready, undefined);
      return null;
    }
    const deadline = Date.now() + 5000;
    while (!ready) {
      if (failure) throw failure;
      assert.equal(socket.readyState, WebSocket.OPEN);
      assert.ok(Date.now() < deadline, "Signed direct broker readiness");
      await delay(20);
    }
    assert.equal(ready.brokerInstanceId, broker.instanceId);
    assert.equal(ready.challenge, challenge);
    assert.equal(ready.leaseExpiresAt, binding.leaseExpiresAt);
    const raw = Buffer.from(broker.publicKey, "base64url");
    assert.equal(
      createHash("sha256").update(raw).digest("hex"),
      ready.fingerprint,
    );
    assert.equal(ready.fingerprint, broker.fingerprint);
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
      format: "der",
      type: "spki",
    });
    assert.equal(
      verify(
        null,
        Buffer.from(`cantrip-direct-v1\0${binding.capabilityId}\0${challenge}`),
        key,
        Buffer.from(ready.signature, "base64url"),
      ),
      true,
    );
    return socket;
  } catch (error) {
    socket.terminate();
    throw error;
  } finally {
    socket.off("message", onReady);
  }
}

export async function openLocalWorkerLink(call, session) {
  const base = "/api/worker-links/" + session.sessionId;
  const ticket = directAttachmentTicketSchema.parse(
    await call("POST", base + "/direct", 201, {}),
  );
  assert.equal(ticket.binding.resourceKind, "worker-link");
  assert.equal(ticket.binding.resourceId, session.sessionId);
  assert.equal(ticket.binding.attachmentId, session.sessionId);
  const socket = await connectDirect(ticket);
  try {
    await call("POST", base + "/direct-activate", 204, {
      capabilityId: ticket.binding.capabilityId,
    });
    return socket;
  } catch (error) {
    socket.terminate();
    throw error;
  }
}

export async function openWorkerLinkSocket(origin, call, session) {
  if (session.preferredRoute === "local") {
    return openLocalWorkerLink(async (method, route, expected, body) => {
      const response = await call(method, route, body);
      assert.equal(response.status, expected, JSON.stringify(response));
      return response.body;
    }, session);
  }
  assert.equal(session.preferredRoute, "relay");
  const url = new URL(
    "/api/worker-links/" + session.sessionId + "/connect",
    origin,
  );
  url.protocol = "ws:";
  url.searchParams.set("clientInstanceId", session.identity.clientInstanceId);
  url.searchParams.set("routeGeneration", String(session.routeGeneration));
  return new WebSocket(url, {
    headers: { origin: "http://127.0.0.1:5173" },
    handshakeTimeout: 8000,
  });
}
