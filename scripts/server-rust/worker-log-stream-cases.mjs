// Real streams through the production bridge; no application-server substitute.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eventually } from "./full-worker.mjs";
import { LogProbe, gate, bounded } from "./worker-log-stream-probe.mjs";
import { record } from "./worker-log-http-cases.mjs";
export const batch = (subscriptionId) => ({
  type: "diagnostics.logs.observed",
  subscriptionId,
  records: [record()],
  nextCursor: 7,
  oldestCursor: 2,
  latestCursor: 9,
  truncated: false,
});
export async function workerLogStreamCases({
  f,
  state,
  worker,
  visit,
  result,
  profile,
}) {
  const target = "/api/workers/alpha/logs/stream";
  const probes = [];
  const probe = (path = target, options = {}) => {
    const p = new LogProbe(f, path, options);
    probes.push(p);
    (state.probes ??= []).push(p);
    return p;
  };
  const note = (name, p, extra = {}) => {
    assert.equal(p.failure, undefined);
    result.cases.push({
      name,
      upgrade: p.upgrade,
      closed: p.closeResult,
      frames: p.history.map(({ frame }) => normalize(frame)),
      ...extra,
    });
  };
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          k === "subscriptionId" ? "<subscription>" : normalize(v),
        ]),
      );
    return value;
  };
  const stopped = async (id) =>
    eventually(
      () =>
        state.commands.filter(
          (c) =>
            c.type === "diagnostics.logs.stream.stop" &&
            c.subscriptionId === id,
        ).length,
      (n) => assert.equal(n, 1),
    );
  try {
    for (const [name, path, options, code, reason] of [
      [
        "missing Origin",
        target,
        { origin: null },
        1008,
        "Origin is not allowed",
      ],
      [
        "foreign Origin",
        target,
        { origin: "https://foreign.invalid" },
        1008,
        "Origin is not allowed",
      ],
      [
        "invalid stream cursor",
        target + "?afterCursor=-1",
        {},
        1008,
        "Invalid worker log stream request",
      ],
      [
        "invalid stream level",
        target + "?minimumLevel=INFO",
        {},
        1008,
        "Invalid worker log stream request",
      ],
      [
        "repeated stream query",
        target + "?afterCursor=1&afterCursor=2",
        {},
        1008,
        "Invalid worker log stream request",
      ],
      [
        "foreign worker",
        target.replace("alpha", "foreign"),
        {},
        1008,
        "Worker log stream is not authorized",
      ],
      [
        "missing worker",
        target.replace("alpha", "missing"),
        {},
        1008,
        "Worker log stream is not authorized",
      ],
      [
        "offline worker",
        target.replace("alpha", "beta"),
        {},
        1013,
        "Worker is offline",
      ],
    ]) {
      const before = state.commands.length,
        p = await probe(path, options).open();
      assert.deepEqual(await p.waitClosed(), { code, reason });
      assert.equal(state.commands.length, before);
      note(name, p);
    }
    if (profile !== "none") {
      const before = state.commands.length;
      const anonymous = probe(target, { client: "anonymous" });
      assert.equal(
        await bounded(anonymous.opened, "anonymous stream rejection"),
        false,
      );
      assert.equal(anonymous.rejection.status, 401);
      await anonymous.waitClosed();
      assert.equal(state.commands.length, before);
      note("anonymous stream cannot upgrade", anonymous, {
        rejection: f.normalize(anonymous.rejection),
      });
    }
    const before = state.commands.length;
    state.beforeStartAck = (command) =>
      assert.equal(worker.notify(batch(command.subscriptionId)), true);
    const p = await probe(
      target +
        "?afterCursor=3&minimumLevel=warn&limit=invalid&beforeCursor=invalid&unknown=ignored",
    ).open();
    assert.equal(
      (await p.message()).type,
      "batch",
      "initial batch precedes start ACK",
    );
    const ready = await p.message();
    assert.equal(ready.type, "ready");
    assert.equal(ready.nextCursor, 3);
    assert.match(ready.subscriptionId, /^[0-9a-f-]{36}$/);
    delete state.beforeStartAck;
    assert.deepEqual(state.commands[before], {
      type: "diagnostics.logs.stream.start",
      subscriptionId: ready.subscriptionId,
      afterCursor: 3,
      minimumLevel: "warn",
      leaseMs: 120000,
    });
    assert.equal(worker.notify(batch(randomUUID())), true);
    assert.equal(worker.notify(batch(ready.subscriptionId)), true);
    const observed = await p.message();
    assert.equal(observed.type, "batch");
    assert.equal(observed.records[0].system, "worker");
    assert.equal(observed.records[0].unknown, undefined);
    p.socket.send("arbitrary ignored client text");
    p.socket.send(Buffer.from([1, 2, 3]));
    assert.equal(
      worker.notify({
        ...batch(ready.subscriptionId),
        records: [],
        nextCursor: 11,
      }),
      true,
    );
    assert.equal((await p.message()).nextCursor, 11);
    assert.deepEqual(await p.close(), {
      code: 1000,
      reason: "worker log fixture close",
    });
    await stopped(ready.subscriptionId);
    note("stream ordering, query selection and binding", p, {
      commands: normalize(state.commands.slice(before)),
    });
    for (const [name, data, options, code] of [
      ["invalid UTF-8", Buffer.from([255]), { binary: false }, 1007],
      ["unmasked client frame", "invalid client mask", { mask: false }, 1002],
    ]) {
      const socket = await probe().open();
      const ready = await socket.message((frame) => frame.type === "ready");
      socket.socket.send(data, options);
      assert.deepEqual(await socket.waitClosed(), { code, reason: "" });
      await stopped(ready.subscriptionId);
      note(name, socket);
    }
    for (const [name, reply, error] of [
      ["rejected start", { accepted: false, latestCursor: 9 }],
      ["strict start", { accepted: true, latestCursor: 9, unknown: true }],
      ["worker start failure", undefined, "Controlled log start failure"],
    ]) {
      if (reply !== undefined) state.startReply = reply;
      if (error) state.startError = error;
      const p = await probe().open();
      assert.deepEqual(await p.message(), {
        type: "error",
        code: "stream-unavailable",
        message: "Worker log stream could not start.",
        retryable: true,
      });
      assert.deepEqual(await p.waitClosed(), {
        code: 1013,
        reason: "Worker log stream could not start",
      });
      delete state.startReply;
      delete state.startError;
      note(name, p);
    }
    const held = gate(),
      offset = state.commands.length;
    state.startHold = held.promise;
    const late = await probe().open();
    await eventually(
      () =>
        state.commands
          .slice(offset)
          .find((c) => c.type === "diagnostics.logs.stream.start"),
      (value) => assert.ok(value),
    );
    const start = state.commands
      .slice(offset)
      .find((c) => c.type === "diagnostics.logs.stream.start");
    await late.close();
    held.resolve();
    delete state.startHold;
    await stopped(start.subscriptionId);
    note("caller closes before start ACK", late, {
      commands: normalize(state.commands.slice(offset)),
    });
    const offline = await probe().open();
    await offline.message((frame) => frame.type === "ready");
    worker.close();
    assert.deepEqual(await offline.message(), {
      type: "error",
      code: "worker-offline",
      message: "Worker disconnected.",
      retryable: true,
    });
    assert.deepEqual(await offline.waitClosed(), {
      code: 1013,
      reason: "Worker disconnected",
    });
    note("worker disconnect", offline);
    await worker.start();
    await visit(
      "read after worker reconnect",
      "GET",
      "/api/workers/alpha/logs",
    );
    if (profile !== "none") {
      const active = await probe().open();
      const ready = await active.message((frame) => frame.type === "ready");
      await visit("logout revokes log stream", "POST", "/api/auth/logout", {
        status: 204,
        json: {},
      });
      const close = await active.waitClosed();
      assert.equal(close.code, 1008);
      await stopped(ready.subscriptionId);
      note("session revocation", active);
    }
  } finally {
    for (const p of probes) {
      if (p.socket.readyState < 2) p.socket.terminate();
      await p.waitClosed().catch(() => {});
    }
  }
}
