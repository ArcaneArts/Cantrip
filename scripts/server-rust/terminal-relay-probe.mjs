// Real client WebSocket frames and application payload-byte receipts.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { terminalServerMessageSchema } from "../../packages/protocol/dist/terminals.js";
const WebSocket = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("ws");
export async function until(read, name) {
  const end = Date.now() + 15000;
  for (;;) {
    const value = read();
    if (value) return value;
    assert.ok(Date.now() < end, name);
    await delay(10);
  }
}
export class TerminalRelayProbe {
  constructor(
    fixture,
    path,
    { client = "main", origin = "http://127.0.0.1:5173", protocols = [] } = {},
  ) {
    this.history = [];
    this.frames = [];
    this.ingress = { bytes: 0, operations: 0 };
    this.egress = { bytes: 0, operations: 0 };
    const cookie = [...fixture.client(client).cookies]
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    this.socket = new WebSocket(
      fixture.server.origin.replace(/^http/, "ws") + path,
      protocols,
      {
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(origin === null ? {} : { origin }),
        },
      },
    );
    this.opened = new Promise((resolve, reject) => {
      this.socket.once("open", () => resolve(true));
      this.socket.once("error", reject);
      this.socket.once("unexpected-response", (_request, response) => {
        const chunks = [];
        response.on("data", (bytes) => chunks.push(bytes));
        response.once("end", () => {
          this.rejection = {
            status: response.statusCode,
            body: Buffer.concat(chunks).toString(),
          };
          response.destroy();
          this.socket.terminate();
          resolve(false);
        });
      });
    });
    this.closed = new Promise((resolve) =>
      this.socket.once("close", (code, reason) => {
        this.closeResult = { code, reason: reason.toString() };
        resolve(this.closeResult);
      }),
    );
    this.socket.on("error", () => {});
    this.socket.once("upgrade", (response) => {
      this.upgrade = {
        status: response.statusCode,
        protocol: response.headers["sec-websocket-protocol"] ?? null,
        cookie: response.headers["set-cookie"] ?? null,
        requestId: response.headers["x-request-id"] ?? null,
      };
    });
    this.socket.on("message", (bytes, binary) => {
      this.egress.bytes += bytes.byteLength;
      this.egress.operations++;
      const raw = bytes.toString();
      this.history.push({ raw, binary });
      try {
        assert.equal(binary, false);
        this.frames.push(terminalServerMessageSchema.parse(JSON.parse(raw)));
      } catch (error) {
        this.failure = error;
      }
    });
  }
  async open() {
    assert.equal(await this.opened, true, JSON.stringify(this.rejection));
    return this;
  }
  async next(matches = () => true) {
    return await until(() => {
      if (this.failure) throw this.failure;
      const at = this.frames.findIndex(matches);
      if (at >= 0) return this.frames.splice(at, 1)[0];
      assert.ok(
        !this.closeResult,
        "terminal closed before expected frame: " +
          JSON.stringify(this.closeResult),
      );
    }, "terminal server frame");
  }
  send(value, { binary = false, raw = false } = {}) {
    const bytes = raw ? value : JSON.stringify(value);
    this.ingress.bytes += Buffer.byteLength(bytes);
    this.ingress.operations++;
    this.socket.send(bytes, { binary });
  }
  async close() {
    if (this.socket.readyState === 1) this.socket.close(1000);
    return await this.closed;
  }
  async ping() {
    const marker = Buffer.from("terminal-relay-barrier");
    let received = false;
    const listener = (bytes) => {
      if (bytes.equals(marker)) received = true;
    };
    this.socket.on("pong", listener);
    try {
      this.socket.ping(marker);
      await until(() => received, "actual terminal relay pong");
    } finally {
      this.socket.off("pong", listener);
    }
  }
  record(label, { validate = true } = {}) {
    if (validate && this.failure) throw this.failure;
    return {
      label,
      upgrade: this.upgrade,
      rejection: this.rejection ?? null,
      messages: this.history,
      closed: this.closeResult ?? null,
      ingress: this.ingress,
      egress: this.egress,
      ...(this.failure ? { validationFailure: this.failure.message } : {}),
    };
  }
}
