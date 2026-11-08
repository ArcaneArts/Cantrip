// Real WebSocket observations; application messages retain their exact bytes.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { workerLogStreamServerMessageSchema } from "../../packages/protocol/dist/index.js";
import { appOrigin } from "./live-sockets.mjs";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const WebSocket = require("ws");
export function bounded(promise, label, timeout = 15000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Worker log observation timed out: " + label)),
        timeout,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
export class LogProbe {
  constructor(
    f,
    target = "/api/workers/alpha/logs/stream",
    { client = "main", origin = appOrigin, ...options } = {},
  ) {
    this.frames = [];
    this.history = [];
    this.pings = [];
    this.waiters = [];
    const cookies = [...f.client(client).cookies]
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    const socket = (this.socket = new WebSocket(
      f.server.origin.replace(/^http/, "ws") + target,
      {
        ...options,
        headers: {
          ...(cookies ? { cookie: cookies } : {}),
          ...(origin === null ? {} : { origin }),
        },
      },
    ));
    this.opened = new Promise((resolve, reject) => {
      socket.once("open", () => resolve(true));
      socket.once("error", reject);
      socket.once("unexpected-response", (_request, response) => {
        const chunks = [];
        response.on("data", (bytes) => chunks.push(bytes));
        response.once("end", () => {
          const text = Buffer.concat(chunks).toString();
          this.rejection = {
            status: response.statusCode,
            body: text ? JSON.parse(text) : null,
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
          waiter.reject(
            new Error(
              "Worker log stream closed: " + JSON.stringify(this.closeResult),
            ),
          );
        resolve(this.closeResult);
      }),
    );
    socket.on("error", () => {});
    socket.on("ping", () => this.pings.push(Date.now()));
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
      try {
        assert.equal(binary, false);
        const frame = workerLogStreamServerMessageSchema.parse(
          JSON.parse(bytes.toString()),
        );
        this.history.push({ frame, encoded: bytes.toString() });
        const index = this.waiters.findIndex((waiter) => waiter.matches(frame));
        if (index >= 0) this.waiters.splice(index, 1)[0].resolve(frame);
        else this.frames.push(frame);
      } catch (error) {
        this.failure = error.stack;
        for (const waiter of this.waiters.splice(0)) waiter.reject(error);
      }
    });
  }
  async open() {
    assert.equal(
      await bounded(this.opened, "upgrade"),
      true,
      JSON.stringify(this.rejection),
    );
    return this;
  }
  async message(matches = () => true) {
    const index = this.frames.findIndex(matches);
    if (index >= 0) return this.frames.splice(index, 1)[0];
    assert.equal(this.failure, undefined);
    assert.equal(this.closeResult, undefined);
    let waiter;
    try {
      return await bounded(
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
  waitClosed(timeout) {
    return bounded(this.closed, "close", timeout);
  }
  async close() {
    if (this.socket.readyState === WebSocket.OPEN)
      this.socket.close(1000, "worker log fixture close");
    else if (this.socket.readyState === WebSocket.CONNECTING)
      this.socket.terminate();
    return this.waitClosed();
  }
}
export const gate = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
