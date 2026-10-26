import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const WebSocket = require("ws");
const v1 = "cantrip-worker-auth-ready-v1",
  v2 = "cantrip-worker-auth-ready-v2";
const generation = "99999999-9999-4999-8999-999999999999";
const headers = [
  "sec-websocket-protocol",
  "cache-control",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "vary",
  "content-security-policy",
  "permissions-policy",
  "referrer-policy",
  "x-content-type-options",
  "x-frame-options",
  "x-permitted-cross-domain-policies",
  "x-request-id",
];
function deadline(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Worker socket timed out: ${label}`)),
        15000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export class SocketProbe {
  constructor(
    fixture,
    {
      query = `workerId=fixture-worker&connectionGeneration=${generation}`,
      protocols = [v2, v1],
      credential,
      origin,
      rotation = "accept",
    } = {},
  ) {
    this.fixture = fixture;
    this.frames = [];
    this.waiters = [];
    this.background = new Set();
    this.rotations = [];
    const socket = (this.socket = new WebSocket(
      `${fixture.server.origin.replace(/^http/, "ws")}/api/internal/workers/connect${query ? "?" + query : ""}`,
      protocols,
      {
        headers: credential ? { authorization: `Bearer ${credential}` } : {},
        ...(origin ? { origin } : {}),
      },
    ));
    this.opened = new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    this.closed = new Promise((resolve) =>
      socket.once("close", (code, reason) => {
        this.closeResult = { code, reason: reason.toString() };
        for (const waiter of this.waiters.splice(0))
          waiter.reject(new Error(`Socket closed ${code}: ${reason}`));
        resolve(this.closeResult);
      }),
    );
    socket.on("error", () => {});
    socket.on("upgrade", (response) => {
      assert.equal(response.statusCode, 101);
      this.upgrade = Object.fromEntries(
        headers.map((name) => [name, response.headers[name] ?? null]),
      );
      if (this.upgrade["x-request-id"]) {
        assert.match(this.upgrade["x-request-id"], /^[0-9a-f-]{36}$/);
        this.upgrade["x-request-id"] = "<request-id>";
      }
    });
    socket.on("message", (bytes, binary) => {
      assert.equal(binary, false, "Control fixture expects text commands");
      const frame = JSON.parse(bytes.toString());
      if (frame.kind === "request") {
        assert.match(frame.requestId, /^[0-9a-f-]{36}$/);
        if (frame.command.type === "worker.credential.rotate") {
          assert.match(frame.command.credential, /^ctwk_[A-Za-z0-9_-]{43}$/);
          this.rotations.push(frame.command.credential);
          if (rotation === "ignore") return;
          socket.send(
            JSON.stringify({
              kind: "response",
              requestId: frame.requestId,
              ...(rotation === "reject"
                ? {
                    ok: false,
                    error: {
                      code: "fixture-rotation-failed",
                      message: "Controlled credential persistence failed.",
                    },
                  }
                : {
                    ok: true,
                    result: rotation === "null" ? null : { accepted: true },
                  }),
            }),
          );
        } else {
          this.background.add(frame.command.type);
          socket.send(
            JSON.stringify({
              kind: "response",
              requestId: frame.requestId,
              ok: false,
              error: {
                code: "fixture-unsupported",
                message:
                  "Controlled worker does not implement this resource domain.",
              },
            }),
          );
        }
        return;
      }
      if (this.waiters.length) this.waiters.shift().resolve(frame);
      else this.frames.push(frame);
    });
  }
  async open() {
    await deadline(this.opened, "open");
    return this;
  }
  async message() {
    if (this.frames.length) return this.frames.shift();
    if (this.closeResult) throw new Error("Worker socket already closed");
    return deadline(
      new Promise((resolve, reject) => this.waiters.push({ resolve, reject })),
      "message",
    );
  }
  async waitClosed() {
    return deadline(this.closed, "close");
  }
  async ping(payload = Buffer.from("fixture barrier")) {
    const pong = new Promise((resolve, reject) => {
      const received = (bytes) => {
        if (Buffer.compare(bytes, payload) !== 0) return;
        cleanup();
        resolve();
      };
      const closed = () => {
        cleanup();
        reject(new Error("Socket closed before pong"));
      };
      const cleanup = () => {
        this.socket.off("pong", received);
        this.socket.off("close", closed);
      };
      this.socket.on("pong", received);
      this.socket.once("close", closed);
      this.socket.ping(payload);
    });
    await deadline(pong, "pong");
  }
  async close() {
    const initiated = this.socket.readyState === WebSocket.OPEN;
    if (initiated) this.socket.close(1000, "fixture close");
    else if (this.socket.readyState === WebSocket.CONNECTING)
      this.socket.terminate();
    const closed = await this.waitClosed();
    if (initiated)
      assert.deepEqual(
        closed,
        { code: 1000, reason: "fixture close" },
        "Client initiated close must be acknowledged",
      );
  }
}
export async function workerSocketFlow(fixture) {
  const cases = [],
    background = new Set(),
    active = new Set();
  let controlGeneration;
  let currentCredential = fixture.records.get("re-enrolled").credential;
  async function probe(label, options, expected) {
    const probe = new SocketProbe(fixture, options);
    active.add(probe);
    try {
      await probe.open();
      let frames = [];
      if (
        options.protocols?.includes(v2) ||
        options.protocols?.includes(v1) ||
        options.protocols === undefined
      ) {
        while (true) {
          try {
            const frame = await probe.message();
            frames.push(frame);
          } catch {
            break;
          }
        }
      }
      const closed = await probe.waitClosed();
      assert.deepEqual(closed, expected, label);
      cases.push({
        label,
        headers: probe.upgrade,
        frames: fixture.normalize(frames),
        closed,
      });
    } finally {
      await probe.close();
      active.delete(probe);
    }
  }
  async function ready(protocols, options = {}) {
    const probe = new SocketProbe(fixture, {
      credential: currentCredential,
      protocols,
      ...options,
    });
    active.add(probe);
    await probe.open();
    const pending = await probe.message(),
      ready = await probe.message();
    assert.equal(pending.kind, "connection");
    assert.equal(pending.state, "pending");
    assert.equal(ready.state, "ready");
    assert.equal(ready.connectionGeneration, generation);
    assert.equal(pending.connectionGeneration, generation);
    const version = protocols.includes(v2) ? 2 : 1;
    assert.equal(ready.protocolVersion, version);
    assert.equal(pending.protocolVersion, version);
    assert.equal(probe.socket.protocol, version === 2 ? v2 : v1);
    if (version === 2) {
      assert.equal(
        pending.serverControlPlaneGeneration,
        ready.serverControlPlaneGeneration,
      );
      if (controlGeneration)
        assert.equal(ready.serverControlPlaneGeneration, controlGeneration);
      else controlGeneration = ready.serverControlPlaneGeneration;
    }
    cases.push({
      label: `ready v${version}`,
      headers: probe.upgrade,
      frames: fixture.normalize([pending, ready]),
    });
    return probe;
  }
  try {
    await probe(
      "missing worker identity",
      { query: "", protocols: [v2] },
      { code: 1008, reason: "Unauthorized" },
    );
    await probe(
      "missing generation",
      { query: "workerId=fixture-worker", protocols: [v1] },
      { code: 1002, reason: "Worker connection generation is required" },
    );
    await probe(
      "invalid generation",
      {
        query: "workerId=fixture-worker&connectionGeneration=invalid",
        protocols: [v2],
      },
      { code: 1008, reason: "Unauthorized" },
    );
    await probe(
      "unauthorized with pending",
      {},
      { code: 1008, reason: "Unauthorized" },
    );
    const credential = fixture.records.get("re-enrolled").credential;
    await probe(
      "wrong worker credential",
      {
        query: `workerId=other-worker&connectionGeneration=${generation}`,
        credential,
      },
      { code: 1008, reason: "Unauthorized" },
    );
    for (const protocols of [
      [],
      ["cantrip-worker-legacy"],
      ["fixture-unknown-protocol", "cantrip-worker-legacy"],
    ]) {
      const legacy = new SocketProbe(fixture, {
        credential: currentCredential,
        query: "workerId=fixture-worker",
        protocols,
      });
      active.add(legacy);
      await legacy.open();
      const expires = Date.now() + 15000;
      let catalog;
      do {
        catalog = await fixture.observe(
          "legacy online catalog",
          "GET",
          "/api/workers",
        );
        if (catalog.body.find((w) => w.workerId === "fixture-worker").online)
          break;
        assert.ok(
          Date.now() < expires,
          "Legacy authenticated socket did not become online",
        );
        await delay(10);
      } while (true);
      await legacy.ping();
      assert.equal(legacy.socket.protocol, protocols[0] ?? "");
      assert.deepEqual(
        legacy.frames,
        [],
        "Legacy authentication must not emit pending/ready envelopes",
      );
      cases.push({
        label: `legacy protocol ${protocols.join(",") || "none"}`,
        headers: legacy.upgrade,
        online: true,
      });
      await legacy.close();
      active.delete(legacy);
      for (const type of legacy.background) background.add(type);
    }
    const first = await ready([v1]);
    await first.close();
    active.delete(first);
    for (const type of first.background) background.add(type);
    for (const [label, data, options, code] of [
      ["invalid UTF-8", Buffer.from([0xc3, 0x28]), { binary: false }, 1007],
      ["unmasked client frame", "invalid mask", { mask: false }, 1002],
      [
        "oversized message",
        Buffer.alloc(8 * 1024 * 1024 + 1),
        { binary: true },
        1009,
      ],
    ]) {
      const malformed = await ready([v2]);
      malformed.socket.send(data, options);
      const closed = await malformed.waitClosed();
      assert.deepEqual(closed, { code, reason: "" }, label);
      cases.push({ label, closed });
      active.delete(malformed);
      for (const type of malformed.background) background.add(type);
    }
    for (const rotation of [
      "reject",
      "null",
      ...(fixture.name === "development" ? ["ignore"] : []),
    ]) {
      const target = await ready([v2], { rotation });
      const label = `socket rotation ${rotation}`;
      const rotated = await fixture.observe(
        label,
        "POST",
        "/api/workers/fixture-worker/credentials/rotate",
        { csrf: true, json: { label } },
      );
      assert.equal(rotated.body.delivered, rotation === "null");
      const next = fixture.records.get(label).credential;
      assert.deepEqual(target.rotations, [next]);
      assert.deepEqual(await target.waitClosed(), {
        code: 1012,
        reason: "Worker credential was rotated",
      });
      cases.push({ label, ...rotated });
      active.delete(target);
      for (const type of target.background) background.add(type);
      await probe(
        `${label}: old credential rejected`,
        { credential: currentCredential },
        { code: 1008, reason: "Unauthorized" },
      );
      currentCredential = next;
    }
    const second = await ready(["fixture-other", v1, v2]);
    second.socket.send("{");
    second.socket.send(
      JSON.stringify({ kind: "response", requestId: "missing-fields" }),
    );
    second.socket.send(Buffer.from([1, 2, 3]), { binary: true });
    await second.ping();
    cases.push({
      label:
        "malformed control and binary frames isolated; ping/pong remains active",
      passed: true,
    });
    const online = await fixture.observe(
      "socket online catalog",
      "GET",
      "/api/workers",
    );
    assert.equal(
      online.body.find((w) => w.workerId === "fixture-worker").online,
      true,
    );
    cases.push({ label: "socket online catalog", ...online });
    const rotated = await fixture.observe(
      "socket rotation",
      "POST",
      "/api/workers/fixture-worker/credentials/rotate",
      { csrf: true, json: { label: "connected rotation" } },
    );
    assert.equal(rotated.body.delivered, true);
    assert.deepEqual(second.rotations, [
      fixture.records.get("socket rotation").credential,
    ]);
    assert.deepEqual(await second.waitClosed(), {
      code: 1012,
      reason: "Worker credential was rotated",
    });
    for (const type of second.background) background.add(type);
    cases.push({ label: "socket rotation", ...rotated });
    active.delete(second);
    const newProbe = new SocketProbe(fixture, {
      credential: fixture.records.get("socket rotation").credential,
    });
    active.add(newProbe);
    await newProbe.open();
    await newProbe.message();
    await newProbe.message();
    const revoked = await fixture.observe(
      "socket revocation",
      "DELETE",
      `/api/workers/fixture-worker/credentials/${fixture.records.get("socket rotation").credentialSummary.id}`,
      { csrf: true, status: 204 },
    );
    assert.deepEqual(await newProbe.waitClosed(), {
      code: 1008,
      reason: "Worker credential was revoked",
    });
    cases.push({ label: "socket revocation", ...revoked });
    for (const type of newProbe.background) background.add(type);
    active.delete(newProbe);
    await probe(
      "revoked socket credential",
      { credential: fixture.records.get("socket rotation").credential },
      { code: 1008, reason: "Unauthorized" },
    );
    return {
      passed: true,
      cases,
      backgroundResourceCommands: [...background].sort(),
    };
  } finally {
    await Promise.all([...active].map((p) => p.close()));
  }
}
