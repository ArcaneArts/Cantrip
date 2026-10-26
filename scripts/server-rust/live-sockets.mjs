import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { appLiveServerMessageSchema } from "../../packages/protocol/dist/index.js";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const WebSocket = require("ws");
export const appOrigin = "http://127.0.0.1:5173";
export const currentUser = { kind: "current-user" };
export const initialize = (resume = null) => ({
  type: "initialize",
  protocolVersion: 1,
  client: {
    id: "native-live-fixture",
    name: "Cantrip Live fixture",
    version: "1",
    controlCapabilities: [],
  },
  resume,
});
export function deadline(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Live socket timed out: ${label}`)),
        15000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
export class LiveProbe {
  constructor(
    fixture,
    {
      client = "main",
      origin = appOrigin,
      protocols = [],
      autoPong = true,
    } = {},
  ) {
    this.fixture = fixture;
    this.frames = [];
    this.history = [];
    this.waiters = [];
    const cookies = [...fixture.client(client).cookies]
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    const socket = (this.socket = new WebSocket(
      fixture.server.origin.replace(/^http/, "ws") + "/api/live",
      protocols,
      {
        headers: {
          ...(cookies ? { cookie: cookies } : {}),
          ...(origin === null ? {} : { origin }),
        },
        autoPong,
      },
    ));
    this.opened = new Promise((resolve, reject) => {
      socket.once("open", () => resolve(true));
      socket.once("error", reject);
      socket.once("unexpected-response", (_request, response) => {
        const chunks = [];
        response.on("data", (bytes) => chunks.push(bytes));
        response.once("end", () => {
          this.rejection = {
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          };
          response.destroy();
          socket.terminate();
          resolve(false);
        });
      });
    });
    this.closed = new Promise((resolve) =>
      socket.once("close", (code, reason) => {
        this.closeResult = { code, reason: reason.toString() };
        for (const waiter of this.waiters.splice(0))
          waiter.reject(new Error(`Live socket closed ${code}: ${reason}`));
        resolve(this.closeResult);
      }),
    );
    socket.on("error", () => {});
    socket.once("upgrade", (response) => {
      this.upgrade = {
        status: response.statusCode,
        headers: Object.fromEntries(
          [
            "sec-websocket-protocol",
            "cache-control",
            "access-control-allow-origin",
            "access-control-allow-credentials",
            "set-cookie",
            "x-request-id",
          ].map((name) => [name, response.headers[name] ?? null]),
        ),
      };
      assert.equal(response.statusCode, 101);
    });
    socket.on("message", (bytes, binary) => {
      assert.equal(binary, false, "Live server emits JSON text");
      const frame = appLiveServerMessageSchema.parse(
        JSON.parse(bytes.toString()),
      );
      this.history.push(frame);
      const index = this.waiters.findIndex((waiter) => waiter.matches(frame));
      if (index >= 0) this.waiters.splice(index, 1)[0].resolve(frame);
      else this.frames.push(frame);
    });
  }
  async open() {
    assert.equal(
      await deadline(this.opened, "upgrade"),
      true,
      JSON.stringify(this.rejection),
    );
    return this;
  }
  async message(matches = () => true) {
    const index = this.frames.findIndex(matches);
    if (index >= 0) return this.frames.splice(index, 1)[0];
    if (this.closeResult)
      throw new Error(
        `Live socket already closed: ${JSON.stringify(this.closeResult)}`,
      );
    let waiter;
    try {
      return await deadline(
        new Promise((resolve, reject) => {
          waiter = { matches, resolve, reject };
          this.waiters.push(waiter);
        }),
        "message",
      );
    } finally {
      const index = this.waiters.indexOf(waiter);
      if (index >= 0) this.waiters.splice(index, 1);
    }
  }
  send(value) {
    this.socket.send(JSON.stringify(value));
  }
  async initialized(resume = null) {
    this.send(initialize(resume));
    const ready = await this.message((frame) => frame.type === "ready");
    assert.match(ready.connectionId, /^[0-9a-f-]{36}$/);
    assert.match(ready.serverEpoch, /^[0-9a-f-]{36}$/);
    assert.equal(ready.protocolVersion, 1);
    assert.equal(ready.heartbeatIntervalMs, 30000);
    assert.equal(ready.resume, resume ? "replaying" : "not-requested");
    return ready;
  }
  async subscribed(requestId = "subscription", scopes = [currentUser]) {
    this.send({ type: "subscribe", requestId, scopes });
    const response = await this.message(
      (frame) => frame.requestId === requestId,
    );
    assert.equal(response.type, "subscribed");
    assert.deepEqual(response.scopes, scopes);
    return response;
  }
  async ping(nonce = "fixture barrier") {
    this.send({ type: "ping", nonce });
    return this.message(
      (frame) => frame.type === "pong" && frame.nonce === nonce,
    );
  }
  waitClosed() {
    return deadline(this.closed, "close");
  }
  async close() {
    const initiated = this.socket.readyState === WebSocket.OPEN;
    if (initiated) this.socket.close(1000, "fixture close");
    else if (this.socket.readyState === WebSocket.CONNECTING)
      this.socket.terminate();
    const result = await this.waitClosed();
    if (initiated)
      assert.deepEqual(
        result,
        { code: 1000, reason: "fixture close" },
        "Client close is acknowledged",
      );
  }
}
