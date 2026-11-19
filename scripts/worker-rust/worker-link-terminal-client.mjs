import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import {
  decodeWorkerLinkFrame,
  encodeWorkerLinkFrame,
} from "../../packages/protocol/dist/worker-link.js";
import { terminalServerMessageSchema } from "../../packages/protocol/dist/terminals.js";
import { protectedTerminalView } from "./terminal-relay-client.mjs";

const WebSocket = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("ws");

export async function attachWorkerLinkTerminal({
  origin,
  call,
  workerId,
  ownerId,
  serverId,
  surfaceKey,
  id,
}) {
  const operationId = randomUUID();
  const clientInstanceId = randomUUID();
  const opened = await call(
    "POST",
    "/api/workers/" + workerId + "/worker-link/sessions",
    {
      clientInstanceId,
    },
  );
  assert.equal(opened.status, 201, JSON.stringify(opened));
  const session = opened.body;
  const base = "/api/worker-links/" + session.sessionId;
  let relay;
  try {
    const issued = await call("POST", base + "/terminals/" + id + "/grant", {
      operationId,
    });
    assert.equal(issued.status, 201, JSON.stringify(issued));
    const grant = issued.body;
    assert.equal(grant.binding.resource.attachmentId, operationId);
    const url = new URL(base + "/connect", origin);
    url.protocol = "ws:";
    url.searchParams.set("clientInstanceId", clientInstanceId);
    url.searchParams.set("routeGeneration", String(session.routeGeneration));
    const header = {
      protocolVersion: 1,
      sessionId: session.sessionId,
      routeGeneration: session.routeGeneration,
      effectiveRoute: "relay",
      channel: { channelId: randomUUID(), connectionId: randomUUID() },
      lane: "interactive",
    };
    relay = new Relay(url, header, grant);
    const view = await protectedTerminalView(relay, {
      ownerId,
      serverId,
      surfaceKey,
      id,
      operationId,
    });
    return {
      ...view,
      async revoke() {
        const result = await call(
          "DELETE",
          base + "/grants/" + grant.binding.grantId,
        );
        assert.equal(result.status, 204);
        assert.equal(
          (await relay.nextWire((header) => header.kind === "close")).header
            .code,
          "revoked",
        );
      },
      async close() {
        await relay.close();
        await call("DELETE", base);
      },
    };
  } catch (error) {
    await relay?.close();
    await call("DELETE", base);
    throw error;
  }
}

class Relay {
  constructor(url, header, grant) {
    this.header = header;
    this.grant = grant;
    this.frames = [];
    this.history = [];
    this.sequence = 0;
    this.expected = 0;
    this.socket = new WebSocket(url, {
      headers: { origin: "http://127.0.0.1:5173" },
      handshakeTimeout: 8000,
    });
    this.opened = once(this.socket, "open", {
      signal: AbortSignal.timeout(9000),
    });
    this.socket.on("error", (error) => {
      this.failure ??= error;
    });
    this.socket.on("message", (bytes, binary) => {
      try {
        assert.equal(binary, true);
        const frame = decodeWorkerLinkFrame(bytes);
        assert.deepEqual(frame.header.channel, this.header.channel);
        assert.equal(frame.header.sequence, this.expected++);
        this.frames.push(frame);
        this.history.push({ raw: bytes.toString("utf8") });
      } catch (error) {
        this.failure ??= error;
      }
    });
  }

  async open() {
    await this.opened;
    this.wire({
      kind: "open",
      openNonce: randomUUID(),
      channelKind: "reliable-stream",
      initialCreditBytes: 1024 * 1024,
      grant: this.grant,
    });
    const { header } = await this.nextWire(
      ({ kind }) => kind === "accept" || kind === "reject",
    );
    assert.equal(header.kind, "accept", JSON.stringify(header));
  }

  wire(detail, bytes = new Uint8Array()) {
    this.socket.send(
      encodeWorkerLinkFrame(
        {
          ...this.header,
          sequence: this.sequence++,
          ...detail,
        },
        bytes,
      ),
    );
  }

  send(message) {
    this.wire(
      { kind: "data", direction: "client-to-worker", payloadFormat: "raw" },
      Buffer.from(JSON.stringify(message)),
    );
  }

  async nextWire(select) {
    const deadline = Date.now() + 8000;
    for (;;) {
      if (this.failure) throw this.failure;
      const index = this.frames.findIndex(({ header, payload }) =>
        select(header, payload),
      );
      if (index >= 0) return this.frames.splice(index, 1)[0];
      assert.ok(
        Date.now() < deadline,
        JSON.stringify(this.frames.map(({ header }) => header)),
      );
      await delay(20);
    }
  }

  async next(select = () => true) {
    const { header, payload } = await this.nextWire(
      ({ kind }, bytes) =>
        kind === "error" ||
        (kind === "data" &&
          select(JSON.parse(Buffer.from(bytes).toString("utf8")))),
    );
    assert.equal(header.kind, "data", JSON.stringify(header));
    const message = terminalServerMessageSchema.parse(
      JSON.parse(Buffer.from(payload).toString("utf8")),
    );
    // The worker may close the logical channel immediately after the final exit data.
    if (message.type !== "exit")
      this.wire({
        kind: "credit",
        direction: "worker-to-client",
        bytes: payload.length,
      });
    return message;
  }

  close() {
    this.socket.terminate();
  }
}
