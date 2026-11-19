import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import {
  decodeWorkerLinkFrame,
  encodeWorkerLinkFrame,
} from "../../packages/protocol/dist/worker-link.js";
import { workerObservationEnvelopeSchema } from "../../packages/protocol/dist/worker-observations.js";

const WebSocket = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("ws");
const clientOrigin = "http://127.0.0.1:5173";

export async function verifyLiveRunObservations({
  origin,
  workerId,
  call,
  start,
  privateValue,
}) {
  const clientInstanceId = randomUUID();
  const opened = await call(
    "POST",
    "/api/workers/" + workerId + "/worker-link/sessions",
    { clientInstanceId },
  );
  assert.equal(opened.status, 201, JSON.stringify(opened));
  const session = opened.body;
  const base = "/api/worker-links/" + session.sessionId;
  const installed = await call("POST", base + "/observations/grant", {
    topics: ["runtime"],
  });
  assert.equal(installed.status, 201);
  const grant = installed.body;
  const route = new URL(base + "/connect", origin);
  route.protocol = "ws:";
  route.searchParams.set("clientInstanceId", clientInstanceId);
  route.searchParams.set("routeGeneration", String(session.routeGeneration));
  const socket = new WebSocket(route, {
    headers: { origin: clientOrigin },
    handshakeTimeout: 8000,
  });
  const frames = [];
  let failure;
  socket.on("error", (error) => {
    failure ??= error;
  });
  socket.on("message", (data, binary) => {
    try {
      assert.equal(binary, true);
      frames.push(decodeWorkerLinkFrame(data));
    } catch (error) {
      failure ??= error;
    }
  });
  const wait = async (select) => {
    const deadline = Date.now() + 8000;
    for (;;) {
      if (failure) throw failure;
      const found = frames.find((frame) => select(frame.header, frame.payload));
      if (found) return found;
      assert.ok(
        Date.now() < deadline,
        JSON.stringify(frames.map((f) => f.header)),
      );
      await delay(20);
    }
  };
  const header = {
    protocolVersion: 1,
    sessionId: session.sessionId,
    routeGeneration: session.routeGeneration,
    effectiveRoute: "relay",
    channel: { channelId: randomUUID(), connectionId: randomUUID() },
    lane: "events",
  };
  const routeFrame = (detail) =>
    socket.send(
      encodeWorkerLinkFrame(
        {
          ...header,
          ...detail,
        },
        new Uint8Array(),
      ),
    );

  try {
    await once(socket, "open", { signal: AbortSignal.timeout(9000) });
    routeFrame({
      kind: "open",
      sequence: 0,
      openNonce: randomUUID(),
      channelKind: "event-subscription",
      grant,
      initialCreditBytes: 1,
    });
    const accepted = await wait(
      ({ kind }) => kind === "accept" || kind === "reject",
    );
    assert.equal(
      accepted.header.kind,
      "accept",
      JSON.stringify(accepted.header),
    );
    assert.deepEqual(accepted.header.channel, header.channel);
    assert.equal(accepted.header.initialCreditBytes, 1);
    assert.equal(accepted.header.sequence, 0);

    const firstRun = await start();
    assert.ok(
      !frames.some(({ header }) => header.kind === "data"),
      "Initial credit is insufficient",
    );
    routeFrame({
      kind: "credit",
      sequence: 1,
      direction: "worker-to-client",
      bytes: 64 * 1024,
    });
    const matching = await wait(({ kind }, payload) => {
      if (kind !== "data") return false;
      const envelope = workerObservationEnvelopeSchema.parse(
        JSON.parse(new TextDecoder().decode(payload)),
      );
      return (
        envelope.payload.notification?.observation?.runtimeId ===
          firstRun.running.id &&
        envelope.payload.notification.observation.state === "running"
      );
    });

    const delivered = frames.filter(({ header }) => header.kind === "data");
    assert.ok(delivered.length >= 2);
    for (const [index, frame] of delivered.entries()) {
      const raw = new TextDecoder().decode(frame.payload);
      assert.ok(!raw.includes(privateValue));
      const envelope = workerObservationEnvelopeSchema.parse(JSON.parse(raw));
      assert.equal(frame.header.sequence, index + 1);
      assert.equal(frame.header.direction, "worker-to-client");
      assert.equal(frame.header.payloadFormat, "raw");
      assert.equal(envelope.payload.topic, "runtime");
      assert.equal(envelope.continuitySequence, index);
      assert.equal(
        envelope.subscriptionId,
        grant.binding.resource.attachmentId,
      );
    }
    const notification = workerObservationEnvelopeSchema.parse(
      JSON.parse(new TextDecoder().decode(matching.payload)),
    ).payload.notification;
    assert.equal(
      notification.type,
      "project.run-configuration-runtime.observed",
    );
    assert.equal(
      notification.observation.configurationId,
      firstRun.running.configurationId,
    );
    const revoked = await call(
      "DELETE",
      base + "/grants/" + grant.binding.grantId,
    );
    assert.equal(revoked.status, 204);
    const closed = await wait(({ kind }) => kind === "close");
    assert.equal(closed.header.code, "revoked");
    return firstRun;
  } finally {
    socket.terminate();
    await call("DELETE", base);
  }
}
