// Actual legacy socket handshakes, JSON initialization and opaque CTTN bytes.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import {
  decodeTunnelDataPlaneFrame,
  encodeTunnelDataPlaneFrame,
  tunnelAttachmentReadySchema,
} from "../../packages/protocol/dist/index.js";
const WebSocket = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("ws");
export async function until(read, name, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value) return value;
    assert.ok(Date.now() < end, name);
    await delay(10);
  }
}
export class TunnelProbe {
  constructor(
    fixture,
    attachment,
    {
      secret,
      protocols = [],
      headers = {},
      origin = null,
      autoPong = true,
    } = {},
  ) {
    this.messages = [];
    this.raw = [];
    this.pings = [];
    this.socket = new WebSocket(
      fixture.server.origin.replace(/^http/, "ws") +
        `/api/tunnel-attachments/${attachment}/connect`,
      protocols,
      {
        autoPong,
        headers: {
          ...(secret === undefined
            ? {}
            : { authorization: "Bearer " + secret }),
          ...(origin === null ? {} : { origin }),
          ...headers,
        },
      },
    );
    this.opened = new Promise((resolve, reject) => {
      this.socket.once("open", () => resolve(true));
      this.socket.once("error", reject);
      this.socket.once("unexpected-response", (_request, response) => {
        const bytes = [];
        response.on("data", (chunk) => bytes.push(chunk));
        response.once("end", () => {
          this.rejection = {
            status: response.statusCode,
            body: Buffer.concat(bytes).toString(),
          };
          response.destroy();
          this.socket.terminate();
          resolve(false);
        });
      });
    });
    this.socket.on("error", () => {});
    this.socket.once("upgrade", (response) => {
      this.upgrade = {
        status: response.statusCode,
        protocol: response.headers["sec-websocket-protocol"] ?? null,
        cookie: response.headers["set-cookie"] ?? null,
        requestId: response.headers["x-request-id"] ?? null,
      };
    });
    this.socket.on("close", (code, reason) => {
      this.closed = { code, reason: reason.toString() };
    });
    this.socket.on("ping", (bytes) => this.pings.push(Buffer.from(bytes)));
    this.socket.on("message", (bytes, binary) => {
      this.raw.push({ binary, bytes: Buffer.from(bytes).toString("base64") });
      try {
        if (binary) {
          const frame = decodeTunnelDataPlaneFrame(bytes);
          assert.deepEqual(
            Buffer.from(
              encodeTunnelDataPlaneFrame(frame.header, frame.payload),
            ),
            bytes,
            "actual normalized CTTN wire bytes",
          );
          this.messages.push({
            binary,
            header: frame.header,
            payload: Buffer.from(frame.payload).toString("base64"),
          });
        } else
          this.messages.push({
            binary,
            value: tunnelAttachmentReadySchema.parse(
              JSON.parse(bytes.toString()),
            ),
          });
      } catch (error) {
        this.failure = error;
      }
    });
  }
  async open() {
    assert.equal(await this.opened, true, JSON.stringify(this.rejection));
    return this;
  }
  initialize(clientId, extra = {}) {
    this.socket.send(
      JSON.stringify({ type: "initialize", clientId, ...extra }),
    );
  }
  frame(header, payload = new Uint8Array()) {
    this.socket.send(encodeTunnelDataPlaneFrame(header, payload));
  }
  async next(matches = () => true) {
    return await until(() => {
      if (this.failure) throw this.failure;
      return this.messages.find(matches);
    }, "actual tunnel socket frame");
  }
  async close() {
    if (this.socket.readyState === 1) this.socket.close(1000);
    return await until(() => this.closed, "actual tunnel close");
  }
  async ping() {
    const nonce = Buffer.from("tunnel-socket-barrier");
    let seen = false;
    const listener = (bytes) => {
      if (bytes.equals(nonce)) seen = true;
    };
    this.socket.on("pong", listener);
    try {
      this.socket.ping(nonce);
      await until(() => seen, "tunnel pong barrier");
    } finally {
      this.socket.off("pong", listener);
    }
  }
  record(label) {
    if (this.failure) throw this.failure;
    return {
      label,
      upgrade: this.upgrade ?? null,
      rejection: this.rejection ?? null,
      messages: this.messages,
      closed: this.closed ?? null,
      pingLengths: this.pings.map((bytes) => bytes.length),
    };
  }
}
