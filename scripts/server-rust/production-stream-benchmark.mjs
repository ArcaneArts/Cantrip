// Development benchmark: run with node --import tsx for WorkerConnection.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  productionProcess,
  productionClient,
} from "./production-server-process.mjs";
import { managementWorker } from "./worker-management-http-worker.mjs";
import { LogProbe } from "./worker-log-stream-probe.mjs";
import { eventually } from "./full-worker.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { productionStreamContainer } from "./production-stream-container.mjs";
const { values } = parseArgs({
  options: {
    runtime: { type: "string" },
    root: { type: "string" },
    artifact: { type: "string" },
    "node-directory": { type: "string" },
    image: { type: "string" },
    "postgres-image": { type: "string", default: "postgres:18" },
    database: { type: "string", default: "pglite" },
    "payload-mib": { type: "string", default: "16" },
    pressure: { type: "boolean", default: false },
    recovery: { type: "boolean", default: false },
  },
});
assert.ok(["node", "rust"].includes(values.runtime));
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(values.database));
const root = path.resolve(values.root),
  runtime = values.runtime,
  run = path.join(root, runtime, "runs", `${Date.now()}-${process.pid}`);
await mkdir(run, { recursive: true });
const artifact = values.image
  ? undefined
  : path.resolve(values.artifact ?? process.env.CANTRIP_BENCH_NATIVE_ARTIFACT);
const nodeDirectory = values.image
  ? undefined
  : path.resolve(
      values["node-directory"] ?? process.env.CANTRIP_BENCH_NODE_DIRECTORY,
    );
const payloadMiB = Number(values["payload-mib"]);
assert.ok(
  Number.isSafeInteger(payloadMiB * 1024 * 1024) && payloadMiB > 0,
  "--payload-mib must describe a positive integer byte count",
);
const profile = path.join(run, "profile");
const manifest = artifact
  ? JSON.parse(
      await readFile(path.join(artifact, "native-server.json"), "utf8"),
    )
  : undefined;
const report = {
  runtime,
  database: values.database,
  artifact,
  nativeArtifactVersion: manifest?.version.version,
  nodeDirectory,
  payloadMiB,
  status: "running",
  scope:
    "Production server entries and actual WorkerConnection; log production is controlled. No test-only server endpoints. Bulk worker-log JSON stream and slow consumer; not opaque WorkerLink binary throughput.",
};
let server, worker, probe, pg, databaseUrl, container;
async function start(port, directory) {
  const logs = path.join(run, directory);
  return container
    ? container.start({ port, logs })
    : productionProcess({
        runtime,
        artifact,
        nodeDirectory,
        profile,
        database: values.database,
        databaseUrl,
        port,
        logs,
      });
}
const state = { commands: [], background: [], disconnects: 0 };
const handlers = Object.fromEntries(
  ["start", "renew", "stop"].map((kind) => [
    "diagnostics.logs.stream." + kind,
    async (command) => {
      state.commands.push(command);
      return kind === "start"
        ? { accepted: true, latestCursor: 0 }
        : { accepted: true };
    },
  ]),
);
handlers["diagnostics.logs.read"] = async (command) => {
  state.commands.push(command);
  return {
    records: [],
    nextCursor: 0,
    oldestCursor: null,
    latestCursor: 0,
    hasMore: false,
    truncated: false,
  };
};
const message = "x".repeat(16384);
const note = (subscriptionId, index, count = 4) => ({
  type: "diagnostics.logs.observed",
  subscriptionId,
  records: Array.from({ length: count }, (_, i) => ({
    cursor: index * count + i + 1,
    timestamp: "2026-11-09T00:00:00.000Z",
    system: "worker",
    level: "info",
    message,
    context: { sequence: index * count + i + 1 },
  })),
  nextCursor: (index + 1) * count,
  oldestCursor: 1,
  latestCursor: (index + 1) * count,
  truncated: false,
});
const stops = (id) =>
  state.commands.filter(
    (c) => c.type === "diagnostics.logs.stream.stop" && c.subscriptionId === id,
  ).length;
async function open(f) {
  probe = await new LogProbe(f).open();
  const ready = await probe.message((f) => f.type === "ready");
  probe.history.length = 0;
  return ready;
}
try {
  if (values.image) {
    container = await productionStreamContainer({
      image: values.image,
      runtime,
      database: values.database,
      postgresImage: values["postgres-image"],
    });
    report.container = {
      image: values.image,
      imageId: container.imageId,
      architecture: container.architecture,
      externalDatabase: container.databaseIdentity,
    };
  } else if (
    values.database === "postgres" ||
    (runtime === "node" && values.database === "bundled-postgres")
  ) {
    pg = await postgresFixture(path.join(run, "external-postgres"));
    databaseUrl = await pg.database();
  }
  server = await start(undefined, "initial");
  report.initialStartupMs = server.startupMs;
  if (container) {
    report.container.initial = server.identity;
    report.nativeArtifactVersion = server.identity.artifactVersion?.version;
  }
  await writeFile(
    path.join(run, "running.json"),
    JSON.stringify({ pid: server.child?.pid, profile, origin: server.origin }) +
      "\n",
  );
  let f = productionClient(server);
  await f.visit("session", "GET", "/api/auth/session");
  const bootstrap = await f.visit("identity", "GET", "/api/bootstrap");
  report.identity = bootstrap.server.id;
  report.serverVersion = bootstrap.server.version.version;
  const visit = (...args) => f.visit(...args);
  worker = await managementWorker({
    f,
    visit,
    root: path.join(profile, "controlled-worker"),
    state,
    handlers,
  });
  const ready = await open(f),
    frames = Math.ceil((report.payloadMiB * 1024 * 1024) / (4 * 16384));
  let consumed = 0,
    wireBytes = 0,
    accepted = 0,
    refused = 0,
    failure;
  const hash = createHash("sha256"),
    startedAt = performance.now();
  const reading = (async () => {
    for (let i = 0; i < frames; i++) {
      const frame = await probe.message((v) => v.type === "batch");
      const expected = note(ready.subscriptionId, i);
      assert.deepEqual(frame.records, expected.records);
      assert.equal(frame.nextCursor, expected.nextCursor);
      for (const r of frame.records) hash.update(r.message);
      wireBytes += probe.history.reduce(
        (n, { encoded }) => n + Buffer.byteLength(encoded),
        0,
      );
      probe.history.length = 0;
      consumed++;
    }
  })().catch((e) => {
    failure = e;
    throw e;
  });
  const sending = (async () => {
    for (let i = 0; i < frames; i++) {
      while (i - consumed >= 8) {
        if (failure) throw failure;
        await delay(1);
      }
      const input = note(ready.subscriptionId, i);
      while (!worker.notify(input)) {
        refused++;
        assert.equal(worker.connected, true);
        if (failure) throw failure;
        await delay(1);
      }
      accepted++;
    }
  })();
  const completed = await Promise.allSettled([reading, sending]);
  for (const r of completed) if (r.status === "rejected") throw r.reason;
  const durationMs = performance.now() - startedAt;
  report.stream = {
    frames,
    accepted,
    refused,
    payloadBytes: frames * 4 * 16384,
    observedWireBytes: wireBytes,
    durationMs,
    payloadMiBPerSecond:
      (frames * 4 * 16384) / 1024 / 1024 / (durationMs / 1000),
    payloadSha256: hash.digest("hex"),
    rss: await server.rss(),
    windowFrames: 8,
  };
  const expectedHash = createHash("sha256");
  for (let i = 0; i < frames * 4; i++) expectedHash.update(message);
  assert.equal(report.stream.payloadSha256, expectedHash.digest("hex"));
  await probe.close();
  probe = undefined;
  await eventually(
    () => stops(ready.subscriptionId),
    (n) => assert.equal(n, 1),
  );
  if (values.pressure) {
    const ready = await open(f);
    probe.socket.pause();
    const start = performance.now();
    let accepted = 0,
      refused = 0;
    for (let i = 0; i < 128 && !stops(ready.subscriptionId); i++) {
      if (worker.notify(note(ready.subscriptionId, i, 64))) accepted++;
      else refused++;
      await delay(5);
    }
    await eventually(
      () => stops(ready.subscriptionId),
      (n) => assert.equal(n, 1),
    );
    report.pressure = {
      accepted,
      refused,
      durationToLeaseStopMs: performance.now() - start,
      rss: await server.rss(),
    };
    probe.socket.resume();
    report.pressure.closed = await probe.waitClosed();
    assert.deepEqual(report.pressure.closed, {
      code: 1013,
      reason: "Worker log stream consumer is too slow",
    });
    report.pressure.receivedFrames = probe.history.length;
    probe = undefined;
    await f.visit("still healthy", "GET", "/readyz");
  }
  await f.visit("durable write", "PATCH", "/api/settings", {
    json: { theme: "dark" },
  });
  if (values.recovery) {
    const port = server.port,
      recoveryAt = performance.now();
    report.crashExit = await server.stop("SIGKILL");
    server = undefined;
    await eventually(
      () => worker.connected,
      (v) => assert.equal(v, false),
    );
    server = await start(port, "recovery");
    if (container) {
      report.container.restarted = server.identity;
      if (runtime === "rust")
        assert.equal(
          server.identity.sha256,
          report.container.initial.sha256,
          "recovery uses the same packaged executable",
        );
    }
    f = productionClient(server);
    await f.visit("recovered session", "GET", "/api/auth/session");
    assert.equal(
      (await f.visit("retained identity", "GET", "/api/bootstrap")).server.id,
      report.identity,
    );
    assert.equal(
      (await f.visit("retained write", "GET", "/api/settings")).preferences
        .theme,
      "dark",
    );
    await eventually(
      () => worker.connected,
      (v) => assert.equal(v, true),
    );
    await f.visit("reconnected command", "GET", "/api/workers/alpha/logs");
    report.recovery = {
      completeMs: performance.now() - recoveryAt,
      serverStartupMs: server.startupMs,
      disconnects: state.disconnects,
      retainedIdentity: true,
      retainedWrite: true,
    };
    const ready = await open(f);
    assert.equal(worker.notify(note(ready.subscriptionId, 0)), true);
    assert.deepEqual(
      (await probe.message((v) => v.type === "batch")).records,
      note(ready.subscriptionId, 0).records,
    );
    await probe.close();
    probe = undefined;
    await eventually(
      () => stops(ready.subscriptionId),
      (n) => assert.equal(n, 1),
    );
  }
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.failure = { message: e.message, stack: e.stack };
  process.exitCode = 1;
} finally {
  if (probe) {
    probe.socket.resume();
    probe.socket.terminate();
  }
  worker?.close();
  if (server)
    try {
      report.exit = await server.stop();
    } catch (e) {
      report.status = "failed";
      report.shutdownFailure = e.message;
      process.exitCode = 1;
    }
  if (pg)
    try {
      await pg.close();
    } catch (e) {
      report.status = "failed";
      report.databaseShutdownFailure = e.message;
      process.exitCode = 1;
    }
  if (container)
    try {
      await container.close();
    } catch (e) {
      report.status = "failed";
      report.containerCleanupFailure = String(e.errors ?? e);
      process.exitCode = 1;
    }
  report.commands = state.commands;
  report.disconnects = state.disconnects;
  await writeFile(
    path.join(run, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
if (report.status !== "passed")
  throw new Error(
    report.failure?.message ??
      report.shutdownFailure ??
      report.databaseShutdownFailure ??
      report.containerCleanupFailure,
  );
console.log("stream benchmark complete");
