// Real HTTP/WS ingress through each production router and WorkerBridge.
// Fixture routes only observe dispatch; controlled handlers do not run domains.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { SocketProbe } from "./worker-sockets.mjs";
import { heartbeat } from "./security-fixtures.mjs";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { enrollWorker } from "../../cantrip_worker/src/enrollment.ts";
import {
  createHeartbeat,
  sendHeartbeat,
} from "../../cantrip_worker/src/heartbeat.ts";

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const executable =
  process.env.CANTRIP_RUST_WORKER_INGRESS_BINARY ??
  (await buildRustExample("worker-ingress-fixture"));
const root = await mkdtemp(path.join(tmpdir(), "cantrip-worker-ingress-"));
const report = {
  suite: "actual-worker-ingress-http-websocket",
  databaseMode,
  completeReplacement: false,
  root,
  scope:
    "Real production router/auth/worker socket/bridge with loopback test observers. Actual unchanged enrollment, heartbeat and WorkerConnection; controlled command handler. Includes raw malformed/deep frames, not complete resource/execution domains or whole worker runtime.",
  runtimes: [],
};
let postgresOwner, failure;
async function eventually(read, check, label) {
  const end = Date.now() + 15000;
  while (true) {
    const value = await read();
    try {
      check(value);
      return value;
    } catch (error) {
      if (Date.now() >= end) {
        error.message = label + ": " + error.message;
        throw error;
      }
    }
    await delay(20);
  }
}
async function flow(fixture) {
  const origin = fixture.server.origin;
  const call = async (method, url, body, status = 200) => {
    const response = await fetch(origin + url, {
      method,
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:5173",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.equal(response.status, status, url + ": " + text);
    return text ? JSON.parse(text) : undefined;
  };
  const state = () => call("GET", "/__worker_ingress/state");
  const api = (name, body) => call("POST", "/__worker_ingress/" + name, body);
  const workerId = "actual-ingress-worker";
  const enrollment = await call(
    "POST",
    "/api/workers/enrollment-codes",
    { label: "Ingress fixture", expiresInSeconds: 300 },
    201,
  );
  const config = {
    name: "Actual ingress WorkerConnection fixture",
    dataDirectory: path.join(
      fixture.environment.CANTRIP_DATA_DIR,
      "controlled-worker",
    ),
    serverUrl: origin,
    enrollmentCode: enrollment.code,
    replacement: null,
    token: "",
    tokenSource: "enrollment",
    workerId,
  };
  const workerHeartbeat = createHeartbeat(
    config,
    heartbeat.codexRuntime,
    new Date().toISOString(),
  );
  await enrollWorker(config, workerHeartbeat);
  await sendHeartbeat(config, workerHeartbeat);
  let connection, probe, flowFailure;
  let controlled = 0,
    connections = 0;
  const background = new Set(),
    pending = [];
  const request = (key, extra = {}) => {
    const promise = api("request", {
      key,
      workerId,
      command: { type: "worker.credential.rotate", credential: config.token },
      timeoutMs: 2000,
      ...extra,
    });
    pending.push(promise);
    void promise.catch(() => undefined);
    return promise;
  };
  try {
    const connect = () =>
      new WorkerConnection(
        config,
        async (command, emit) => {
          if (command.type !== "worker.credential.rotate") {
            background.add(command.type);
            throw new Error(
              "Controlled ingress worker does not implement resource domains.",
            );
          }
          controlled++;
          if (controlled <= 2) {
            emit({ type: "agent.plan.question-resolved", questionId: "one" });
            emit({ type: "agent.plan.question-resolved", questionId: "two" });
          }
          if (controlled === 3) return undefined;
          if (controlled === 4) return null;
          if (controlled === 5)
            return JSON.parse(
              '{"__proto__":{"fixture":true},"unicode":"\\ud800","numeric":null}',
            );
          return { accepted: true };
        },
        undefined,
        undefined,
        undefined,
        1000,
        () => {
          connections++;
        },
      );
    connection = connect();
    connection.start();
    await eventually(
      () => connections,
      (n) => assert.equal(n, 1),
      "unchanged worker readiness",
    );
    const ordered = request("ordered", { hold: true });
    await eventually(
      state,
      (s) => {
        assert.equal(s.started.filter((x) => x.key === "ordered").length, 1);
        assert.equal(s.stats.activeRequests, 0);
        assert.equal(s.settled.ordered, false);
      },
      "response removed while first event is held",
    );
    await delay(2200);
    assert.equal(
      (await state()).settled.ordered,
      false,
      "response clears its deadline before event completion",
    );
    await api("release", { key: "ordered" });
    const orderedResult = await ordered;
    assert.deepEqual(orderedResult, {
      ok: true,
      resultPresent: true,
      result: { accepted: true },
    });
    const orderedEvents = (await state()).completed
      .filter((x) => x.key === "ordered")
      .map((x) => x.value);
    assert.deepEqual(orderedEvents, [
      { type: "agent.plan.question-resolved", questionId: "one" },
      { type: "agent.plan.question-resolved", questionId: "two" },
    ]);
    const rejectedEvent = await request("event-failure", { fail: true });
    assert.deepEqual(rejectedEvent, {
      ok: false,
      message: "Controlled event failure",
      code: null,
    });
    // An own undefined result is accepted before encoding, but JSON omits it.
    // The current authoritative decoder rejects that missing required key.
    const absent = await request("missing-result", { timeoutMs: 100 });
    assert.deepEqual(absent, {
      ok: false,
      message: "Worker command worker.credential.rotate timed out.",
      code: "worker-command-timeout",
    });
    const nullResult = await request("null-result");
    assert.deepEqual(nullResult, {
      ok: true,
      resultPresent: true,
      result: null,
    });
    const opaque = await request("opaque-result");
    assert.deepEqual(opaque, {
      ok: true,
      resultPresent: true,
      result: JSON.parse(
        '{"__proto__":{"fixture":true},"unicode":"\\ud800","numeric":null}',
      ),
    });
    await api("subscribe", { key: "held", workerId, hold: true });
    await api("subscribe", { key: "rejecting", workerId, fail: true });
    for (const revision of [1, 2])
      assert.equal(
        connection.sendNotification({
          type: "chat.thread.changed",
          threadId: "fixture-thread",
          revision,
          changes: ["turn"],
        }),
        true,
      );
    const delivered = await eventually(
      state,
      (s) => {
        assert.equal(
          s.started.filter((x) => x.kind === "notification").length,
          4,
        );
      },
      "ordered notification prefixes",
    );
    assert.deepEqual(
      delivered.started
        .filter((x) => x.kind === "notification")
        .map((x) => [x.key, x.value.revision]),
      [
        ["held", 1],
        ["rejecting", 1],
        ["held", 2],
        ["rejecting", 2],
      ],
    );
    assert.equal(delivered.completed.filter((x) => x.key === "held").length, 0);
    await api("release", { key: "held" });
    await eventually(
      state,
      (s) =>
        assert.equal(s.completed.filter((x) => x.key === "held").length, 2),
      "independent notification completion",
    );
    await api("unsubscribe", { key: "held" });
    await api("unsubscribe", { key: "rejecting" });
    const notificationCount = (await state()).started.filter(
      (x) => x.kind === "notification",
    ).length;
    assert.equal(
      connection.sendNotification({
        type: "chat.thread.changed",
        threadId: "fixture-thread",
        revision: 3,
        changes: ["turn"],
      }),
      true,
    );
    assert.equal((await request("unsubscribe-barrier")).ok, true);
    assert.equal(
      (await state()).started.filter((x) => x.kind === "notification").length,
      notificationCount,
    );
    await api("subscribe", { key: "reconnected", workerId });
    connection.close();
    connection = connect();
    connection.start();
    await eventually(
      () => connections,
      (n) => assert.equal(n, 2),
      "unchanged worker reconnect",
    );
    assert.equal(
      connection.sendNotification({
        type: "chat.thread.changed",
        threadId: "fixture-thread",
        revision: 4,
        changes: ["turn"],
      }),
      true,
    );
    await eventually(
      state,
      (s) =>
        assert.equal(
          s.started.filter((x) => x.key === "reconnected").length,
          1,
        ),
      "notification after reconnect",
    );
    connection.close();
    probe = await new SocketProbe(fixture, {
      credential: config.token,
      query:
        "workerId=" +
        workerId +
        "&connectionGeneration=" +
        connection.connectionGeneration(),
    }).open();
    while ((await probe.message()).state !== "ready") {}
    await api("subscribe", { key: "raw", workerId });
    for (const raw of [
      "{",
      '{"kind":"notification","notification":{"type":"chat.thread.changed","threadId":"thread","revision":0,"changes":["turn"]}}',
      '{"kind":"event","requestId":1,"event":{"type":"terminal.ready"}}',
    ])
      probe.socket.send(raw);
    const deep = {
      kind: "event",
      requestId: "no-pending-request",
      event: {
        type: "agent.interaction.requested",
        request: {
          requestKey: "fixture",
          threadId: "fixture",
          turnId: null,
          itemId: null,
          payload: {
            kind: "permissions",
            startedAtMs: 1,
            environmentId: null,
            cwd: "/fixture",
            reason: null,
            requestedPermissions: null,
          },
          expiresAt: null,
        },
      },
    };
    const deepFrame = JSON.stringify(deep).replace(
      '"requestedPermissions":null',
      '"requestedPermissions":' + "[".repeat(16384) + "0" + "]".repeat(16384),
    );
    probe.socket.send(deepFrame);
    probe.socket.send(
      JSON.stringify({
        kind: "notification",
        notification: {
          type: "chat.thread.changed",
          threadId: "fixture-thread",
          revision: 100,
          changes: ["turn"],
        },
      }),
    );
    await probe.ping();
    await eventually(
      state,
      (s) =>
        assert.deepEqual(
          s.started.filter((x) => x.key === "raw").map((x) => x.value.revision),
          [100],
        ),
      "malformed frame isolation",
    );
    assert.equal((await request("raw-barrier")).ok, true);
    assert.equal((await fetch(origin + "/healthz")).status, 200);
    assert.equal((await fetch(origin + "/readyz")).status, 200);
    await probe.close();
    probe = undefined;
    const final = await state();
    return {
      passed: true,
      orderedResult,
      orderedEvents,
      eventFailure: rejectedEvent,
      missingResult: absent,
      nullResult,
      opaqueResult: opaque,
      notificationPrefixes: delivered.started
        .filter((x) => x.kind === "notification")
        .map((x) => [x.key, x.value.revision]),
      reconnects: connections,
      malformedFramesIsolated: true,
      deepFrameBytes: Buffer.byteLength(deepFrame),
      backgroundCommands: [...background].sort(),
      rawStats: final.stats,
    };
  } catch (error) {
    flowFailure = error;
    throw error;
  } finally {
    connection?.close();
    const cleanup = await Promise.allSettled([probe?.close(), fixture.close()]);
    const pendingResults = await Promise.allSettled(pending);
    const errors = [...cleanup, ...pendingResults]
      .filter((x) => x.status === "rejected")
      .map((x) => x.reason);
    if (errors.length)
      throw new AggregateError(
        [...(flowFailure ? [flowFailure] : []), ...errors],
        "Worker ingress flow and cleanup",
      );
  }
}
try {
  if (databaseMode !== "pglite")
    postgresOwner = await postgresFixture(
      path.join(root, "reference-postgres"),
    );
  for (const kind of ["node", "rust"]) {
    const fixture = new HttpFixture({
      kind,
      executable,
      root,
      name: "ingress",
      databaseMode,
      workerIngress: true,
    });
    if (postgresOwner) {
      if (kind === "node" || databaseMode === "postgres")
        fixture.environment.DATABASE_URL = await postgresOwner.database();
      else
        fixture.environment.CANTRIP_POSTGRES_BIN_DIR =
          process.env.CANTRIP_TEST_POSTGRES_BIN_DIR;
    }
    let fixtureFailure;
    try {
      await fixture.start();
      report.runtimes.push({ kind, ...(await flow(fixture)) });
    } catch (error) {
      fixtureFailure = error;
      throw error;
    } finally {
      try {
        await fixture.close();
      } catch (error) {
        throw new AggregateError(
          [...(fixtureFailure ? [fixtureFailure] : []), error],
          "Worker ingress fixture cleanup",
        );
      }
    }
  }
  const comparable = ({ backgroundCommands, rawStats, ...value }) => value;
  assert.deepEqual(comparable(report.runtimes[0]), {
    ...comparable(report.runtimes[1]),
    kind: "node",
  });
} catch (error) {
  failure = error;
  report.error = {
    name: error.name,
    message: error.message,
    ...(error.errors ? { errors: error.errors.map((e) => e.message) } : {}),
  };
} finally {
  try {
    await postgresOwner?.close();
  } catch (error) {
    failure ??= error;
    report.cleanupError = error.message;
  }
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    runtimes: report.runtimes.map((r) => ({ kind: r.kind, passed: r.passed })),
    completeReplacement: false,
  }),
);
