// The Rust server relays CTTN frames between the existing TypeScript crypto
// consumer and a real Rust worker. The destination is an owned TCP listener.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
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

    const chunks = [response.subarray(0, smallCredit)];
    for (;;) {
      const frame = await first.next("data", "half-close");
      assert.equal(frame.header.direction, destination);
      if (frame.header.kind === "half-close") break;
      assert.ok(!Buffer.from(frame.payload).includes(response.subarray(0, 32)));
      chunks.push(
        openTunnelDataFrame(configuration, frame.header, frame.payload),
      );
    }
    assert.deepEqual(Buffer.concat(chunks), response);
    assert.equal((await first.next("close")).header.code, "normal");

    second.send({ kind: "half-close", direction: source, sequence: 4 });
    assert.equal((await second.next("close")).header.code, "protocol-error");
    const active = connection.stream(route);
    await active.next("accepted");
    await call("DELETE", base + "/grants/" + grant.binding.grantId, 204);
    const close = await connection.nextControl("close");
    assert.equal(close.code, "revoked");
    await until(
      () => sockets.size === 0,
      "owned TCP sockets close on revocation",
    );
    assert.equal(openedSockets, 3);
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

class Connection {
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
          const inner = decodeTunnelDataPlaneFrame(frame.payload);
          const stream = this.streams.get(inner.header.connectionId);
          assert.ok(stream, "known logical stream");
          for (const [key, value] of Object.entries(stream.binding))
            assert.equal(inner.header[key], value, key);
          assert.equal(inner.header.sequence, stream.expected++);
          stream.frames.push(inner);
        } else {
          this.control.push(frame.header);
        }
      } catch (error) {
        this.failure ??= error;
      }
    });
  }

  async open(grant) {
    await once(this.socket, "open", { signal: AbortSignal.timeout(5000) });
    this.wire({
      kind: "open",
      openNonce: randomUUID(),
      channelKind: "reliable-stream",
      initialCreditBytes: outerCredit,
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

  stream({ target, ...route }, override = target) {
    const binding = {
      protocolVersion: 1,
      ...route,
      connectionId: randomUUID(),
    };
    const stream = { binding, sequence: 0, expected: 0, frames: [] };
    stream.next = (...kinds) =>
      until(
        () => {
          if (this.failure) throw this.failure;
          return take(stream.frames, ({ header }) =>
            kinds.includes(header.kind),
          );
        },
        `TCP ${kinds.join("/")}`,
      );
    stream.send = (detail, plaintext, configuration) => {
      const header = { ...binding, sequence: stream.sequence++, ...detail };
      const frame = plaintext
        ? sealTunnelDataFrame(configuration, header, plaintext)
        : { header, payload: new Uint8Array() };
      this.wire(
        {
          kind: "data",
          direction: "client-to-worker",
          payloadFormat: "tunnel-data-plane-v1",
        },
        encodeTunnelDataPlaneFrame(frame.header, frame.payload),
      );
    };
    this.streams.set(binding.connectionId, stream);
    stream.send({
      kind: "connect",
      target: override,
      initialCreditBytes: smallCredit,
      diagnosticTraceId: randomUUID(),
    });
    return stream;
  }
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
