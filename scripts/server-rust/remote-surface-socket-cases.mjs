// Real legacy CTRS sockets with the unchanged worker's production transport.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  encodeRemoteSurfaceFrame,
  decodeRemoteSurfaceFrame,
  remoteSurfaceConnectionMessageSchema,
} from "../../packages/protocol/dist/index.js";
import { bounded, gate } from "./worker-log-stream-probe.mjs";
import { osIds } from "./remote-desktop-os-cases.mjs";
import { literal } from "./project-target-state.mjs";
import { eventually } from "./full-worker.mjs";
const require = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
);
const WebSocket = require("ws");
export class SurfaceProbe {
  constructor(
    f,
    surface = "raw-browser",
    {
      origin = "http://127.0.0.1:5173",
      query = "",
      compact = false,
      client = "main",
    } = {},
  ) {
    this.messages = [];
    this.binary = [];
    this.history = [];
    this.wire = [];
    this.sent = [];
    (f.surfaceProbes ??= []).push(this);
    this.socket = new WebSocket(
      f.server.origin.replace(/^http/, "ws") +
        `/api/remote-surfaces/${surface}/connect${query}`,
      {
        headers: {
          ...(origin === null ? {} : { origin }),
          cookie: [...f.client(client).cookies]
            .map(([k, v]) => `${k}=${v}`)
            .join("; "),
        },
      },
    );
    const send = this.socket.send.bind(this.socket);
    this.socket.send = (data, ...args) => {
      const result = send(data, ...args);
      this.sent.push({
        bytes:
          typeof data === "string" ? Buffer.byteLength(data) : data.byteLength,
      });
      return result;
    };
    this.opened = new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
    this.closed = new Promise((resolve) =>
      this.socket.once("close", (code, reason) => {
        this.closeResult = { code, reason: reason.toString() };
        resolve(this.closeResult);
      }),
    );
    this.socket.on("error", () => {});
    this.socket.on("message", (bytes, binary) => {
      try {
        this.wire.push({ binary, bytes: bytes.byteLength });
        if (binary) {
          const value = decodeRemoteSurfaceFrame(bytes);
          this.binary.push(
            compact
              ? { header: value.header, payloadBytes: value.payload.byteLength }
              : value,
          );
          this.history.push(
            compact
              ? {
                  header: value.header,
                  payloadBytes: value.payload.byteLength,
                  sha256: createHash("sha256")
                    .update(value.payload)
                    .digest("hex"),
                }
              : {
                  header: value.header,
                  payload: Buffer.from(value.payload).toString("hex"),
                },
          );
        } else {
          const value = remoteSurfaceConnectionMessageSchema.parse(
            JSON.parse(bytes.toString()),
          );
          this.messages.push(value);
          this.history.push(value);
        }
      } catch (error) {
        this.failure = error.stack;
      }
    });
  }
  async open() {
    await bounded(this.opened, "surface upgrade");
    return this;
  }
  async message(timeout = 15000) {
    await eventually(
      () => this.messages.length,
      (n) => {
        assert.equal(this.failure, undefined);
        assert.ok(n > 0);
      },
      timeout,
    );
    return this.messages.shift();
  }
  async close() {
    if (this.socket.readyState === WebSocket.OPEN)
      this.socket.close(1000, "surface fixture close");
    else if (this.socket.readyState === WebSocket.CONNECTING)
      this.socket.terminate();
    return bounded(this.closed, "surface close");
  }
}
export async function remoteSurfaceSocketCases({ f, state, worker, result }) {
  const probes = [];
  const probe = async (surface, options) => {
    const p = new SurfaceProbe(f, surface, options);
    probes.push(p);
    await p.open();
    return p;
  };
  const note = (name, p, commands = []) => {
    assert.equal(p.failure, undefined);
    result.cases.push({
      name,
      close: p.closeResult,
      frames: p.history,
      commands,
    });
  };
  const detached = async (attachment) =>
    eventually(
      () =>
        state.commands.filter(
          (c) => c.type === "surface.detach" && c.attachmentId === attachment,
        ).length,
      (n) => assert.equal(n, 1),
    );
  try {
    for (const [name, surface, options, code, reason] of [
      [
        "missing Origin",
        "raw-browser",
        { origin: null },
        1008,
        "Origin not allowed",
      ],
      [
        "foreign Origin",
        "raw-browser",
        { origin: "https://foreign.invalid" },
        1008,
        "Origin not allowed",
      ],
      [
        "bad viewport",
        "raw-browser",
        { query: "?width=0" },
        1008,
        "Invalid viewport",
      ],
      [
        "repeated viewport",
        "raw-browser",
        { query: "?width=1280&width=1" },
        1008,
        "Invalid viewport",
      ],
      ["missing surface", "missing", {}, 1008, "Remote Surface not found"],
      [
        "foreign surface",
        "other-raw-browser",
        {},
        1008,
        "Remote Surface not found",
      ],
    ]) {
      const p = await probe(surface, options);
      assert.deepEqual(await bounded(p.closed, name), { code, reason });
      note(name, p);
    }
    const before = state.commands.length;
    const p = await probe("raw-browser", {
      query: "?width=0x500&height=720&devicePixelRatio=2",
    });
    const ready = await p.message();
    assert.equal(ready.type, "ready");
    assert.equal(ready.transport, "websocket");
    assert.equal(ready.webrtc, null);
    const command = state.commands.find(
      (c) =>
        c.type === "surface.attach" && c.attachmentId === ready.attachmentId,
    );
    assert.deepEqual(command.viewport, {
      width: 1280,
      height: 720,
      devicePixelRatio: 2,
    });
    assert.equal(command.stateResource, "browser-remote-surface");
    const header = {
      protocolVersion: 1,
      surfaceId: "raw-browser",
      attachmentId: ready.attachmentId,
      sequence: 0,
      channel: "control",
    };
    const start = state.frames.length;
    p.socket.send(encodeRemoteSurfaceFrame(header, new Uint8Array([1, 2, 3])));
    p.socket.send(encodeRemoteSurfaceFrame(header, new Uint8Array([9])));
    p.socket.send(
      encodeRemoteSurfaceFrame({ ...header, sequence: 1 }, new Uint8Array([4])),
    );
    await eventually(
      () => state.frames.length,
      (n) => assert.equal(n, start + 2),
    );
    assert.deepEqual(
      state.frames.slice(start).map((v) => v.payload),
      ["010203", "04"],
    );
    worker.surfaceFrame(
      { ...header, channel: "frame" },
      new Uint8Array([5, 6]),
    );
    worker.surfaceFrame({ ...header, channel: "frame" }, new Uint8Array([9]));
    worker.surfaceFrame(
      { ...header, channel: "frame", sequence: 1 },
      new Uint8Array([7]),
    );
    await eventually(
      () => p.binary.length,
      (n) => assert.equal(n, 2),
    );
    assert.deepEqual(
      p.binary.map((v) => Buffer.from(v.payload).toString("hex")),
      ["0506", "07"],
    );
    await p.close();
    await detached(ready.attachmentId);
    note("bidirectional replay filtering", p, state.commands.slice(before));
    for (const [name, data, binary, expected] of [
      [
        "nonbinary",
        "bad",
        false,
        { code: 1003, reason: "Remote Surface data must be binary" },
      ],
      [
        "invalid carrier",
        Buffer.from("bad"),
        true,
        { code: 1008, reason: "Invalid Remote Surface frame" },
      ],
    ]) {
      const p = await probe();
      const ready = await p.message();
      p.socket.send(data, { binary });
      assert.deepEqual(await bounded(p.closed, name), expected);
      await detached(ready.attachmentId);
      note(name, p);
    }
    const mismatch = await probe();
    const mismatchReady = await mismatch.message();
    mismatch.socket.send(
      encodeRemoteSurfaceFrame(
        {
          ...header,
          attachmentId: mismatchReady.attachmentId,
          surfaceId: "foreign",
        },
        new Uint8Array([1]),
      ),
    );
    assert.deepEqual(await bounded(mismatch.closed, "binding mismatch"), {
      code: 1008,
      reason: "Remote Surface binding mismatch",
    });
    await detached(mismatchReady.attachmentId);
    note("binding mismatch", mismatch);
    const hold = gate();
    state.hold = hold.promise;
    const late = await probe();
    await eventually(
      () => state.commands.filter((c) => c.type === "surface.attach").length,
      (n) => assert.ok(n >= 5),
    );
    const pending = state.commands
      .filter((c) => c.type === "surface.attach")
      .at(-1);
    await late.close();
    hold.resolve();
    delete state.hold;
    await detached(pending.attachmentId);
    note("late attachment acknowledgement", late);
    const desktop = await probe("desktop");
    const desktopReady = await desktop.message();
    assert.equal(desktopReady.type, "ready");
    const desktopCommand = state.commands.find(
      (c) =>
        c.type === "surface.attach" &&
        c.attachmentId === desktopReady.attachmentId,
    );
    assert.equal(desktopCommand.stateResource, "remote-desktop-row");
    assert.deepEqual(desktopCommand.desktopStream, {
      targetFps: 30,
      quality: "adaptive",
    });
    await desktop.close();
    await detached(desktopReady.attachmentId);
    note("desktop stream preferences", desktop, [desktopCommand]);
    const os = await probe(osIds.desktop);
    const osReady = await os.message();
    assert.equal(osReady.type, "ready");
    const osCommand = state.commands.find(
      (c) =>
        c.type === "surface.attach" && c.attachmentId === osReady.attachmentId,
    );
    assert.equal(osCommand.osExecution.scope.bindingId, osIds.binding);
    assert.equal(osCommand.osExecution.scope.runtimeGeneration, osIds.runtime);
    await os.close();
    await detached(osReady.attachmentId);
    note("captured OS desktop attachment", os, [osCommand]);
    const race = gate();
    state.hold = race.promise;
    state.releaseHold = race.resolve;
    const offset = state.commands.length;
    const fenced = await probe(osIds.desktop);
    await eventually(
      () =>
        state.commands.slice(offset).find((c) => c.type === "surface.attach"),
      (c) => assert.ok(c),
    );
    const fencedCommand = state.commands
      .slice(offset)
      .find((c) => c.type === "surface.attach");
    await f.sql([
      `UPDATE remote_surfaces SET state_revision=state_revision+1 WHERE id=${literal(osIds.desktop)}`,
    ]);
    race.resolve();
    delete state.hold;
    delete state.releaseHold;
    assert.deepEqual(await fenced.message(), {
      type: "error",
      message: "Remote Surface could not be opened.",
      recoverable: true,
    });
    assert.deepEqual(await bounded(fenced.closed, "OS attachment fence"), {
      code: 1013,
      reason: "Remote Surface unavailable",
    });
    await detached(fencedCommand.attachmentId);
    note("OS revalidation after attachment acknowledgement", fenced);
    await f.sql([
      `UPDATE cantrip_os_instances SET runtime_generation=${literal(osIds.source)} WHERE id=${literal(osIds.instance)}`,
    ]);
    const stale = await probe(osIds.desktop);
    assert.deepEqual(await stale.message(), {
      type: "error",
      message: "Remote Surface could not be opened.",
      recoverable: true,
    });
    assert.deepEqual(await bounded(stale.closed, "stale OS runtime"), {
      code: 1013,
      reason: "Remote Surface unavailable",
    });
    note("saved OS runtime fence", stale);
    await f.sql([
      `UPDATE cantrip_os_instances SET runtime_generation=${literal(osIds.runtime)} WHERE id=${literal(osIds.instance)}`,
    ]);
    if (state.quotaKind) {
      const a = await probe();
      const first = await a.message();
      assert.equal(first.type, "ready");
      const b = await probe();
      const second = await b.message();
      assert.equal(second.type, "ready");
      const rejected = await probe();
      assert.deepEqual(await rejected.message(), {
        type: "error",
        message:
          (state.quotaKind === "account" ? "Account" : "Worker") +
          " Remote Surface connection quota reached.",
        recoverable: true,
      });
      assert.deepEqual(await bounded(rejected.closed, "surface quota"), {
        code: 1013,
        reason: "Remote Surface quota reached",
      });
      note("surface quota rejection", rejected);
      await a.close();
      await detached(first.attachmentId);
      const [active] = await f.sql(
        [],
        [
          "SELECT jsonb_build_object('status',status)::text result FROM remote_surfaces WHERE id='raw-browser'",
        ],
      );
      assert.equal(active.status, "active");
      note("first attachment close retains active surface", a);
      await b.close();
      await detached(second.attachmentId);
      await eventually(
        async () => {
          const [row] = await f.sql(
            [],
            [
              "SELECT jsonb_build_object('status',status)::text result FROM remote_surfaces WHERE id='raw-browser'",
            ],
          );
          return row.status;
        },
        (status) => assert.equal(status, "idle"),
      );
      note("last attachment close returns surface to idle", b);
      const recovered = await probe();
      const ready = await recovered.message();
      assert.equal(ready.type, "ready");
      await recovered.close();
      await detached(ready.attachmentId);
      note("surface quota release", recovered);
    }
  } finally {
    state.releaseHold?.();
    delete state.releaseHold;
    delete state.hold;
    for (const p of probes) await p.close();
  }
}
