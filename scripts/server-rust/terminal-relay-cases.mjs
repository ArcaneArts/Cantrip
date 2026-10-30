// Legacy relay behavior through real WebSockets and the production worker client.
import assert from "node:assert/strict";
import { TerminalRelayProbe, until } from "./terminal-relay-probe.mjs";
import { workerIngressFixtures } from "./worker-wire-fixtures.mjs";
import { heartbeat, password } from "./security-fixtures.mjs";
import { directAttachmentWireFixtures } from "./direct-attachment-wire-fixtures.mjs";
import { terminalRelayLocks } from "./terminal-relay-locks.mjs";
const operation = "55555555-5555-4555-8555-555555555557";
const opaque = workerIngressFixtures.find(
  (v) => v.event?.type === "terminal.output",
).event.protectedData;
export async function terminalRelayCases({
  fixture,
  visit,
  state,
  result,
  profile,
  live,
  databaseMode,
}) {
  const start = result.commands.length,
    observations = [];
  result.terminalRelaySockets = observations;
  await visit(
    "terminal relay worker heartbeat",
    "POST",
    "/api/internal/workers/heartbeat",
    {
      client: "worker",
      status: 202,
      headers: {
        authorization: `Bearer ${fixture.records.get("enrolled worker").credential}`,
      },
      json: {
        ...heartbeat,
        workerId: "alpha",
        directBroker:
          directAttachmentWireFixtures.directAttachmentTicketSchema[0].broker,
      },
    },
  );
  const probes = [];
  const connect = (
    id = "terminal",
    query = `operationId=${operation}`,
    options = {},
  ) => {
    const probe = new TerminalRelayProbe(
      fixture,
      `/api/terminals/${id}/connect${query ? "?" + query : ""}`,
      options,
    );
    probe.commandStart = result.commands.length;
    probes.push(probe);
    return probe;
  };
  async function saved(name, probe) {
    await probe.close();
    const opened = result.commands
      .slice(probe.commandStart)
      .find((c) => c.type === "terminal.open");
    if (opened) {
      await until(
        () =>
          result.commands
            .slice(probe.commandStart)
            .find(
              (c) =>
                c.type === "terminal.detach" &&
                c.attachmentId === opened.attachmentId,
            ),
        "actual matching attachment detach after " + name,
      );
      if (name !== "close before readiness")
        await until(
          () => !state.pending.has(opened.attachmentId),
          "controlled worker completed matching detach after " + name,
        );
    }
    observations.push(probe.record(name));
  }
  try {
    if (databaseMode === "postgres")
      await terminalRelayLocks({ fixture, connect, saved, result });
    for (const [name, query, options, code, reason] of [
      [
        "missing origin",
        undefined,
        { origin: null },
        1008,
        "Origin not allowed",
      ],
      [
        "foreign origin",
        undefined,
        { origin: "https://example.invalid" },
        1008,
        "Origin not allowed",
      ],
      [
        "missing operation",
        "",
        {},
        1008,
        "Terminal stream operation is required",
      ],
      [
        "empty operation",
        "operationId=",
        {},
        1008,
        "Terminal stream operation is required",
      ],
      [
        "long operation",
        "operationId=" + "x".repeat(201),
        {},
        1008,
        "Terminal stream operation is required",
      ],
    ]) {
      const probe = await connect("terminal", query, options).open();
      assert.deepEqual(await probe.closed, { code, reason });
      await saved(name, probe);
    }
    if (profile === "accounts") {
      const probe = connect("terminal", undefined, { client: "worker" });
      assert.equal(await probe.opened, false);
      assert.equal(probe.rejection.status, 401);
      observations.push(probe.record("unauthenticated relay"));
    }
    for (const [id, code, reason, message] of [
      ["missing", 1008, "Terminal not found", "Terminal not found."],
      ["other-terminal", 1008, "Terminal not found", "Terminal not found."],
      [
        "run-terminal",
        1008,
        "Run configuration terminal is read-only",
        "Run configuration terminals are read-only and use the managed runtime output API.",
      ],
      [
        "placement-terminal",
        1013,
        "Worker offline",
        "Project worker is offline.",
      ],
    ]) {
      const probe = await connect(id).open();
      assert.deepEqual(await probe.next(), { type: "error", message });
      assert.deepEqual(await probe.closed, { code, reason });
      await saved("relay context " + id, probe);
    }
    let at = result.commands.length;
    const probe = await connect().open();
    assert.deepEqual(await probe.next(), { type: "ready" });
    const pending = await until(
      () =>
        [...state.pending.values()].find(
          (p) =>
            p.command.attachmentId ===
            result.commands.slice(at).find((c) => c.type === "terminal.open")
              ?.attachmentId,
        ),
      "actual relay terminal.open",
    );
    pending.emit({
      type: "terminal.output",
      operationId: operation,
      sequence: 0,
      protectedData: opaque,
    });
    assert.deepEqual(await probe.next(), {
      type: "output",
      operationId: operation,
      sequence: 0,
      protectedData: opaque,
    });
    for (const value of [
      "{",
      "{}",
      "[]",
      '{"type":"resize","cols":0,"rows":24}',
    ]) {
      probe.send(value, { raw: true, binary: true });
      assert.deepEqual(await probe.next(), {
        type: "error",
        message: "Invalid terminal message.",
      });
    }
    probe.send({
      type: "input",
      operationId: "different",
      sequence: 0,
      protectedData: opaque,
    });
    assert.deepEqual(await probe.next(), {
      type: "error",
      message: "Invalid terminal stream.",
    });
    state.relayMode = "hold-input";
    state.relayInputHeld = undefined;
    probe.send({
      type: "input",
      operationId: operation,
      sequence: 0,
      protectedData: opaque,
      extra: true,
    });
    const held = await until(
      () => state.relayInputHeld,
      "first input reaches worker",
    );
    at = result.commands.length;
    probe.send({
      type: "input",
      operationId: operation,
      sequence: 1,
      protectedData: opaque,
    });
    probe.send(
      { type: "resize", cols: 111, rows: 42, extra: true },
      { binary: true },
    );
    await until(
      () => result.commands.slice(at).find((c) => c.type === "terminal.resize"),
      "resize proceeds while prior input acknowledgment is held",
    );
    assert.equal(
      result.commands.slice(at).some((c) => c.type === "terminal.input"),
      false,
      "second input waits for acknowledgment",
    );
    state.relayMode = "normal";
    held.reject(new Error("Controlled terminal input failure"));
    assert.deepEqual(await probe.next(), {
      type: "error",
      message: "Controlled terminal input failure",
    });
    await until(
      () =>
        result.commands
          .slice(at)
          .find((c) => c.type === "terminal.input" && c.sequence === 1),
      "input queue recovers after rejection",
    );
    state.relayMode = "resize-error";
    probe.send({ type: "resize", cols: 90, rows: 25 });
    assert.deepEqual(await probe.next(), {
      type: "error",
      message: "Controlled terminal resize failure",
    });
    state.relayMode = "normal";
    at = result.commands.length;
    await saved("encrypted relay and ordered input", probe);
    await until(
      () => result.commands.slice(at).find((c) => c.type === "terminal.detach"),
      "disconnect detaches actual terminal attachment",
    );
    for (const mode of [
      "exited",
      "open-error",
      "invalid-open",
      "ready-invalid",
      "ready-exited",
    ]) {
      state.mode = mode;
      const probe = await connect().open();
      if (mode.startsWith("ready-"))
        assert.deepEqual(await probe.next(), { type: "ready" });
      const message = await probe.next();
      if (["exited", "ready-exited"].includes(mode))
        assert.deepEqual(message, { type: "exit", exitCode: 2, signal: null });
      else assert.equal(message.type, "error");
      await saved("relay startup " + mode, probe);
    }
    state.mode = "normal";
    const managed = await connect("linked-console").open();
    assert.deepEqual(await managed.next(), { type: "ready" });
    await saved("managed console relay", managed);
    state.mode = "hold-ready";
    state.relayDetachHolds = 1;
    state.relayDetachHeld = undefined;
    at = result.commands.length;
    const late = await connect().open();
    const pendingLate = await until(
      () =>
        [...state.pending.values()].find(
          (p) =>
            p.command.attachmentId ===
            result.commands.slice(at).find((c) => c.type === "terminal.open")
              ?.attachmentId,
        ),
      "relay startup held before readiness",
    );
    await saved("close before readiness", late);
    const detach = await until(
      () => state.relayDetachHeld,
      "actual disconnect detach is held",
    );
    pendingLate.emit({ type: "terminal.ready" });
    await until(
      () =>
        result.commands
          .slice(at)
          .filter(
            (c) =>
              c.type === "terminal.detach" &&
              c.attachmentId === pendingLate.command.attachmentId,
          ).length === 2,
      "late ready event triggers second reference detach",
    );
    detach.resolve(null);
    state.mode = "normal";
    if (profile === "accounts") {
      await visit("login relay session", "POST", "/api/auth/login", {
        client: "relay-session",
        json: { email: "terminal-main@example.invalid", password },
        status: 200,
      });
      const session = await connect("terminal", undefined, {
        client: "relay-session",
      }).open();
      assert.deepEqual(await session.next(), { type: "ready" });
      at = result.commands.length;
      await visit("logout relay session", "POST", "/api/auth/logout", {
        client: "relay-session",
        status: 204,
      });
      assert.deepEqual(await session.closed, {
        code: 1008,
        reason: "Session was revoked",
      });
      await saved("session revokes relay", session);
      await until(
        () =>
          result.commands.slice(at).find((c) => c.type === "terminal.detach"),
        "session revocation detaches relay",
      );
    }
    const reopened = await connect().open();
    assert.deepEqual(await reopened.next(), { type: "ready" });
    await saved("relay reopens after cleanup and session revocation", reopened);
    await live.ping();
    result.terminalRelayCommands = fixture.normalize(
      result.commands.slice(start),
    );
    result.terminalRelayExpectedUsage = {
      ingress: { bytes: 0, operations: 0 },
      egress: { bytes: 0, operations: 0 },
    };
    for (const probe of probes)
      for (const direction of ["ingress", "egress"])
        for (const key of ["bytes", "operations"])
          result.terminalRelayExpectedUsage[direction][key] +=
            probe[direction][key];
  } finally {
    result.terminalRelayRawReceipts = probes.map((probe, index) =>
      probe.record("raw relay " + index, { validate: false }),
    );
    state.mode = "normal";
    state.relayMode = "normal";
    state.relayDetachHeld?.resolve(null);
    state.relayInputHeld?.resolve(null);
    for (const probe of probes)
      if (probe.socket.readyState === 1) await probe.close();
  }
}
