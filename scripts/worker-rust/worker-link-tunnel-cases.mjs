// The Rust server relays CTTN frames between the existing TypeScript crypto
// consumer and a real Rust worker. The destination is an owned TCP listener.
import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  deriveComponentKey,
  encryptEndpointContentPayload,
  wrapComponentKeyForWorker,
} from "../../packages/crypto/dist/index.js";
import {
  decodeTunnelDataPlaneFrame,
  encodeTunnelDataPlaneFrame,
} from "../../packages/protocol/dist/tunnel-data-plane.js";
import { tunnelAttachmentReadySchema } from "../../packages/protocol/dist/tunnels.js";
import {
  directAttachmentTicketSchema,
  directBrokerReadySchema,
  directTunnelTicketSchema,
} from "../../packages/protocol/dist/direct-data-plane.js";
import {
  decodeWorkerLinkFrame,
  encodeWorkerLinkFrame,
  workerLinkTunnelGrantSchema,
} from "../../packages/protocol/dist/worker-link.js";
import {
  openTunnelDataFrame,
  sealTunnelDataFrame,
} from "../../cantrip_worker/src/tunnel-data-protection.ts";

const WebSocket = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("ws");
const source = "source-to-destination";
const destination = "destination-to-source";
const outerCredit = 4096;
const smallCredit = 17;

export async function verifyWorkerLinkTunnel({
  origin,
  call,
  relay,
  ownerId,
  workerId,
  workerDirectory,
  master,
}) {
  const component = "tunnel-content";
  const keyRevision = 1;
  const identity = JSON.parse(
    await readFile(
      path.join(workerDirectory, "worker-encryption-key.json"),
      "utf8",
    ),
  );
  const principals = await call("GET", "/api/encryption/principals", 200);
  const principal = principals.find(({ id }) => id === identity.principalId);
  assert.ok(principal);
  await call(
    "POST",
    `/api/encryption/principals/${principal.id}/approve`,
    200,
    {
      expectedRevision: principal.revision,
    },
  );
  const componentKey = deriveComponentKey({
    accountMasterKey: master,
    ownerId,
    component,
    keyRevision,
  });
  const sockets = new Set();
  const received = [];
  let openedSockets = 0;
  const response = Buffer.from(
    ("native-tunnel-response-" + randomUUID()).repeat(2300),
  );
  const tcp = createServer({ allowHalfOpen: true }, (socket) => {
    openedSockets += 1;
    sockets.add(socket);
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      received.push(Buffer.concat(chunks));
      socket.end(response);
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  const base = "/api/worker-links/" + relay.sessionId;
  let connection;
  try {
    await call(
      "POST",
      `/api/encryption/principals/${principal.id}/grants`,
      201,
      {
        component,
        keyRevision,
        wrappedKey: await wrapComponentKeyForWorker({
          ownerId,
          workerId,
          component,
          keyRevision,
          componentKey,
          workerPublicKey: identity.publicKey,
        }),
      },
    );
    const refreshed = await call(
      "POST",
      `/api/workers/${workerId}/encryption/refresh`,
      200,
      {
        component,
        keyRevision,
      },
    );
    assert.equal(refreshed.status.state, "ready");
    tcp.listen(0, "127.0.0.1");
    await once(tcp, "listening", { signal: AbortSignal.timeout(5000) });
    const tunnelId = randomUUID();
    const operationId = tunnelId;
    const configuration = {
      formatVersion: 1,
      algorithm: "AES-256-GCM",
      keyRevision,
      key: randomBytes(32).toString("base64url"),
    };
    const protectedRecord = {
      operationId,
      revision: 1,
      protectedContent: await encryptEndpointContentPayload({
        ownerId,
        componentKey,
        keyRevision,
        context: {
          domain: component,
          serverId: relay.identity.serverId,
          workerId,
          scopeId: JSON.stringify(["tunnel", tunnelId]),
          operationId,
          operation: "tunnel.record",
          direction: "stored",
          sequence: 1,
        },
        plaintext: Buffer.from(
          JSON.stringify({
            name: "Host TCP relay fixture",
            description: null,
            source: { kind: "desktop-loopback" },
            destination: {
              kind: "worker-tcp",
              workerId,
              host: "127.0.0.1",
              port: tcp.address().port,
            },
            dataProtection: configuration,
          }),
        ),
      }),
    };
    const tunnel = await call("POST", "/api/tunnels", 201, {
      id: tunnelId,
      projectId: null,
      protocolHint: "tcp",
      destination: { kind: "worker-tcp", workerId },
      protectedRecord,
    });
    assert.deepEqual(tunnel.protectedRecord, protectedRecord);
    const clientInstanceId = relay.identity.clientInstanceId;
    const { attachmentId } = await call(
      "POST",
      `/api/tunnels/${tunnelId}/attachments`,
      201,
      {
        clientId: clientInstanceId,
      },
    );
    const { grant, route } = workerLinkTunnelGrantSchema.parse(
      await call(
        "POST",
        base + "/tunnel-attachments/" + attachmentId + "/grant",
        201,
        {},
      ),
    );
    assert.deepEqual(route.target.protectedRecord, protectedRecord);
    const url = new URL(base + "/connect", origin);
    url.protocol = "ws:";
    url.searchParams.set("clientInstanceId", clientInstanceId);
    url.searchParams.set("routeGeneration", String(relay.routeGeneration));
    connection = new Connection(url, relay);
    await connection.open(grant);

    const mismatched = connection.stream(route, {
      ...route.target,
      protectedRecord: { ...protectedRecord, operationId: randomUUID() },
    });
    const rejected = await mismatched.next("rejected");
    assert.equal(rejected.header.code, "protected-record-unavailable");
    assert.equal(openedSockets, 0);

    const first = connection.stream(route);
    const second = connection.stream(route);
    for (const stream of [first, second]) {
      assert.equal(
        (await stream.next("accepted")).header.initialCreditBytes,
        256 * 1024,
      );
    }
    assert.equal(sockets.size, 2);
    const request = Buffer.from("private-request-" + randomUUID());
    first.send({ kind: "data", direction: source }, request, configuration);
    first.send({ kind: "half-close", direction: source });
    const credit = await first.next("credit");
    assert.equal(credit.header.direction, source);
    assert.equal(credit.header.bytes, request.length);
    const initial = await first.next("data");
    assert.equal(initial.header.direction, destination);
    assert.deepEqual(
      openTunnelDataFrame(configuration, initial.header, initial.payload),
      response.subarray(0, smallCredit),
    );
    assert.deepEqual(received, [request]);
    await delay(100);
    assert.ok(!first.frames.some(({ header }) => header.kind === "data"));

    first.send({
      kind: "credit",
      direction: destination,
      bytes: response.length,
    });
    await delay(100);
    assert.ok(!first.frames.some(({ header }) => header.kind === "half-close"));
    assert.ok(connection.bytes <= outerCredit);
    connection.wire({
      kind: "credit",
      direction: "worker-to-client",
      bytes: 1024 * 1024,
    });

    await receiveResponse(first, response, configuration);
    assert.equal((await first.next("close")).header.code, "normal");

    second.send({ kind: "half-close", direction: source, sequence: 4 });
    assert.equal((await second.next("close")).header.code, "protocol-error");
    const active = connection.stream(route);
    await active.next("accepted");
    await until(
      () => sockets.size === 1,
      "only the active WorkerLink TCP stream remains",
    );
    await verifyLegacyTunnel({
      origin,
      call,
      tunnelId,
      workerId,
      configuration,
      response,
      received,
      sockets,
      connectionId: active.binding.connectionId,
    });
    assert.equal(
      sockets.size,
      1,
      "revocation leaves the sibling WorkerLink stream open",
    );
    await call("DELETE", base + "/grants/" + grant.binding.grantId, 204);
    const close = await connection.nextControl("close");
    assert.equal(close.code, "revoked");
    await until(
      () => sockets.size === 0,
      "owned TCP sockets close on revocation",
    );
    assert.equal(openedSockets, 6);
    await verifyDirectTunnel({
      call,
      workerId,
      tunnelId,
      configuration,
      response,
      received,
      sockets,
    });
    assert.equal(openedSockets, 8);
    console.log(
      JSON.stringify({ suite: "native-workerlink-host-tcp", passed: true }),
    );
  } finally {
    componentKey.fill(0);
    connection?.socket.terminate();
    for (const socket of sockets) socket.destroy();
    if (tcp.listening) await new Promise((resolve) => tcp.close(resolve));
    await call("DELETE", base, 204);
  }
}

async function verifyDirectTunnel({
  call,
  workerId,
  tunnelId,
  configuration,
  response,
  received,
  sockets,
}) {
  const probe = directAttachmentTicketSchema.parse(
    await call("POST", `/api/workers/${workerId}/direct-probe`, 201, {}),
  );
  await connectDirect(
    probe,
    { ...probe, secret: randomBytes(32).toString("base64url") },
    1008,
  );
  const first = await connectDirect(probe);
  try {
    await connectDirect(probe, probe, 1008);
    const stopped = once(first.socket, "close", {
      signal: AbortSignal.timeout(5000),
    });
    await call(
      "DELETE",
      "/api/direct-attachments/" + probe.binding.capabilityId,
      204,
    );
    assert.equal((await stopped)[0], 1008);
  } finally {
    first.socket.terminate();
  }

  const { attachmentId } = await call(
    "POST",
    `/api/tunnels/${tunnelId}/attachments`,
    201,
    { clientId: randomUUID() },
  );
  const client = await openDirectTunnel(call, attachmentId);
  try {
    const working = client.open();
    const retained = client.open();
    for (const stream of [working, retained])
      assert.equal(
        (await stream.next("accepted")).header.initialCreditBytes,
        256 * 1024,
      );
    assert.equal(sockets.size, 2);
    const request = Buffer.from("direct-private-request-" + randomUUID());
    working.send({ kind: "data", direction: source }, request, configuration);
    working.send({ kind: "half-close", direction: source });
    assert.equal((await working.next("credit")).header.bytes, request.length);
    const firstResponse = await working.next("data");
    assert.deepEqual(
      openTunnelDataFrame(
        configuration,
        firstResponse.header,
        firstResponse.payload,
      ),
      response.subarray(0, smallCredit),
    );
    assert.deepEqual(received.at(-1), request);
    working.send({
      kind: "credit",
      direction: destination,
      bytes: response.length,
    });
    await receiveResponse(working, response, configuration);
    assert.equal((await working.next("close")).header.code, "normal");
    working.send({ kind: "close", code: "normal" });
    await until(
      () => sockets.size === 1,
      "one direct TCP stream remains before revocation",
    );
    const stopped = once(client.socket, "close", {
      signal: AbortSignal.timeout(5000),
    });
    await client.revoke();
    assert.equal((await stopped)[0], 1008);
    await until(
      () => sockets.size === 0,
      "direct revocation closes its TCP stream",
    );
  } finally {
    client.socket.terminate();
  }
  console.log(
    JSON.stringify({ suite: "native-direct-host-tcp", passed: true }),
  );
}

export async function openDirectTunnel(call, attachmentId) {
  const base = "/api/tunnel-attachments/" + attachmentId;
  const ticket = directTunnelTicketSchema.parse(
    await call("POST", base + "/direct", 201, {}),
  );
  const client = await connectDirect(ticket);
  try {
    await call("POST", base + "/direct-activate", 204, {
      capabilityId: ticket.binding.capabilityId,
    });
    return {
      socket: client.socket,
      open: (initialCreditBytes = smallCredit) =>
        startStream(
          client,
          { protocolVersion: 1, ...ticket.route, connectionId: randomUUID() },
          { kind: "open", initialCreditBytes },
          (bytes) => client.socket.send(bytes),
        ),
      revoke: () =>
        call(
          "DELETE",
          "/api/direct-attachments/" + ticket.binding.capabilityId,
          204,
        ),
    };
  } catch (error) {
    client.socket.terminate();
    throw error;
  }
}

async function connectDirect(ticket, initialize = ticket, expectClose) {
  const { broker, binding } = ticket;
  assert.equal(broker.loopbackHost, "127.0.0.1");
  assert.equal(broker.leaseRenewal, true);
  const socket = new WebSocket(
    `ws://${broker.loopbackHost}:${broker.loopbackPort}/direct/v1`,
  );
  const client = { socket, streams: new Map(), ready: null, failure: null };
  socket.on("error", (error) => {
    client.failure ??= error;
  });
  socket.on("message", (bytes, binary) => {
    try {
      if (binary) receiveTunnelFrame(client, bytes);
      else
        client.ready = directBrokerReadySchema.parse(
          JSON.parse(bytes.toString()),
        );
    } catch (error) {
      client.failure ??= error;
    }
  });
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
      assert.equal(client.ready, null);
      return null;
    }
    const ready = await until(() => {
      if (client.failure) throw client.failure;
      return client.ready;
    }, "signed direct broker readiness");
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
    return client;
  } catch (error) {
    socket.terminate();
    throw error;
  }
}

async function verifyLegacyTunnel({
  origin,
  call,
  tunnelId,
  workerId,
  configuration,
  response,
  received,
  sockets,
  connectionId,
}) {
  const clientId = randomUUID();
  const attachment = await call(
    "POST",
    `/api/tunnels/${tunnelId}/attachments`,
    201,
    { clientId },
  );
  const route = "/api/tunnel-attachments/" + attachment.attachmentId;
  let revoked = false;
  let socket;
  try {
    const legacy = await openLegacyTunnel({
      origin,
      attachment,
      clientId,
      tunnelId,
      workerId,
    });
    socket = legacy.socket;
    const { open } = legacy;
    const working = open(connectionId);
    const retained = open();
    for (const stream of [working, retained])
      assert.equal(
        (await stream.next("accepted")).header.initialCreditBytes,
        256 * 1024,
      );
    assert.equal(
      sockets.size,
      3,
      "two legacy streams and one WorkerLink stream are connected",
    );
    const request = Buffer.from("legacy-private-request-" + randomUUID());
    working.send({ kind: "data", direction: source }, request, configuration);
    working.send({ kind: "half-close", direction: source });
    const credit = await working.next("credit");
    assert.equal(credit.header.direction, source);
    assert.equal(credit.header.bytes, request.length);
    const initial = await working.next("data");
    assert.deepEqual(
      openTunnelDataFrame(configuration, initial.header, initial.payload),
      response.subarray(0, smallCredit),
    );
    assert.deepEqual(received.at(-1), request);
    await delay(100);
    assert.equal(
      working.frames.length,
      0,
      "legacy broker and worker honor plaintext credit",
    );
    working.send({
      kind: "credit",
      direction: destination,
      bytes: response.length,
    });
    await receiveResponse(working, response, configuration);
    assert.equal((await working.next("close")).header.code, "normal");
    retained.send({ kind: "close", code: "normal" });
    const reopened = open(retained.binding.connectionId);
    await reopened.next("accepted");
    await until(
      () => sockets.size === 2,
      "reopening a retired logical stream leaves the sibling WorkerLink socket intact",
    );
    const closed = once(socket, "close", { signal: AbortSignal.timeout(5000) });
    await call("DELETE", route, 204);
    revoked = true;
    assert.equal((await closed)[0], 1008);
    await until(
      () => sockets.size === 1,
      "Core revocation closes the owned legacy sockets",
    );
    console.log(
      JSON.stringify({ suite: "native-legacy-host-tcp", passed: true }),
    );
  } finally {
    socket?.terminate();
    if (!revoked) await call("DELETE", route, 204);
  }
}

export async function openLegacyTunnel({
  origin,
  attachment,
  clientId,
  tunnelId,
  workerId,
}) {
  const url = new URL(attachment.connectPath, origin);
  url.protocol = "ws:";
  const socket = new WebSocket(
    url,
    ["cantrip-tunnel-v1." + attachment.secret],
    {
      headers: { origin: "http://127.0.0.1:5173" },
    },
  );
  const peer = { streams: new Map(), ready: null, failure: null };
  socket.on("error", (error) => {
    peer.failure ??= error;
  });
  socket.on("message", (bytes, binary) => {
    try {
      if (binary) receiveTunnelFrame(peer, bytes);
      else
        peer.ready = tunnelAttachmentReadySchema.parse(
          JSON.parse(bytes.toString()),
        );
    } catch (error) {
      peer.failure ??= error;
    }
  });
  try {
    await once(socket, "open", { signal: AbortSignal.timeout(5000) });
    socket.send(JSON.stringify({ type: "initialize", clientId }));
    const ready = await until(() => {
      if (peer.failure) throw peer.failure;
      return peer.ready;
    }, "legacy attachment ready");
    assert.equal(ready.attachmentId, attachment.attachmentId);
    assert.equal(ready.tunnelId, tunnelId);
    assert.equal(
      ready.sourceEndpointId,
      `desktop:${clientId}:${attachment.attachmentId}`,
    );
    assert.equal(ready.destinationEndpointId, `worker:${workerId}`);
    const binding = {
      tunnelId,
      attachmentId: ready.attachmentId,
      sourceEndpointId: ready.sourceEndpointId,
      destinationEndpointId: ready.destinationEndpointId,
    };
    const open = (id = randomUUID(), initialCreditBytes = smallCredit) =>
      startStream(
        peer,
        { protocolVersion: 1, ...binding, connectionId: id },
        { kind: "open", initialCreditBytes },
        (bytes) => socket.send(bytes),
      );
    return { socket, open };
  } catch (error) {
    socket.terminate();
    throw error;
  }
}

async function receiveResponse(stream, response, configuration) {
  const chunks = [response.subarray(0, smallCredit)];
  for (;;) {
    const frame = await stream.next("data", "half-close");
    assert.equal(frame.header.direction, destination);
    if (frame.header.kind === "half-close") break;
    assert.ok(!Buffer.from(frame.payload).includes(response.subarray(0, 32)));
    chunks.push(
      openTunnelDataFrame(configuration, frame.header, frame.payload),
    );
  }
  assert.deepEqual(Buffer.concat(chunks), response);
}

export class Connection {
  constructor(url, relay) {
    this.identity = {
      protocolVersion: 1,
      sessionId: relay.sessionId,
      routeGeneration: relay.routeGeneration,
      effectiveRoute: "relay",
      channel: { channelId: randomUUID(), connectionId: randomUUID() },
      lane: "stream",
    };
    this.sequence = 0;
    this.expected = 0;
    this.bytes = 0;
    this.control = [];
    this.streams = new Map();
    this.socket = new WebSocket(url, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    this.socket.on("error", (error) => {
      this.failure ??= error;
    });
    this.socket.on("message", (bytes, binary) => {
      try {
        assert.equal(binary, true);
        const frame = decodeWorkerLinkFrame(bytes);
        assert.deepEqual(frame.header.channel, this.identity.channel);
        assert.equal(frame.header.sequence, this.expected++);
        if (frame.header.kind === "data") {
          assert.equal(frame.header.payloadFormat, "tunnel-data-plane-v1");
          assert.equal(frame.header.direction, "worker-to-client");
          this.bytes += frame.payload.length;
          receiveTunnelFrame(this, frame.payload);
        } else {
          this.control.push(frame.header);
        }
      } catch (error) {
        this.failure ??= error;
      }
    });
  }

  async open(grant, initialCreditBytes = outerCredit) {
    await once(this.socket, "open", { signal: AbortSignal.timeout(5000) });
    this.wire({
      kind: "open",
      openNonce: randomUUID(),
      channelKind: "reliable-stream",
      initialCreditBytes,
      grant,
    });
    const header = await this.nextControl("accept", "reject");
    assert.equal(header.kind, "accept", JSON.stringify(header));
  }

  wire(detail, payload = new Uint8Array()) {
    this.socket.send(
      encodeWorkerLinkFrame(
        {
          ...this.identity,
          sequence: this.sequence++,
          ...detail,
        },
        payload,
      ),
    );
  }

  nextControl(...kinds) {
    return until(
      () => {
        if (this.failure) throw this.failure;
        return take(this.control, ({ kind }) => kinds.includes(kind));
      },
      `WorkerLink ${kinds.join("/")}`,
    );
  }

  stream(
    { target, ...route },
    override = target,
    initialCreditBytes = smallCredit,
  ) {
    return startStream(
      this,
      { protocolVersion: 1, ...route, connectionId: randomUUID() },
      {
        kind: "connect",
        target: override,
        initialCreditBytes,
        diagnosticTraceId: randomUUID(),
      },
      (bytes) =>
        this.wire(
          {
            kind: "data",
            direction: "client-to-worker",
            payloadFormat: "tunnel-data-plane-v1",
          },
          bytes,
        ),
    );
  }
}

function startStream(peer, binding, open, write) {
  const stream = { binding, sequence: 0, expected: 0, frames: [] };
  stream.next = (...kinds) =>
    until(
      () => {
        if (peer.failure) throw peer.failure;
        return take(stream.frames, ({ header }) => kinds.includes(header.kind));
      },
      `TCP ${kinds.join("/")}`,
    );
  stream.send = (detail, plaintext, configuration) => {
    const header = { ...binding, sequence: stream.sequence++, ...detail };
    const frame = plaintext
      ? sealTunnelDataFrame(configuration, header, plaintext)
      : { header, payload: new Uint8Array() };
    write(encodeTunnelDataPlaneFrame(frame.header, frame.payload));
  };
  peer.streams.set(binding.connectionId, stream);
  stream.send(open);
  return stream;
}

function receiveTunnelFrame(peer, payload) {
  const inner = decodeTunnelDataPlaneFrame(payload);
  const stream = peer.streams.get(inner.header.connectionId);
  assert.ok(stream, "known logical stream");
  for (const [key, value] of Object.entries(stream.binding))
    assert.equal(inner.header[key], value, key);
  assert.equal(inner.header.sequence, stream.expected++);
  stream.frames.push(inner);
}

function take(frames, select) {
  const index = frames.findIndex(select);
  return index < 0 ? null : frames.splice(index, 1)[0];
}

async function until(read, label) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await delay(15);
  }
  assert.fail("Timed out waiting for " + label);
}
