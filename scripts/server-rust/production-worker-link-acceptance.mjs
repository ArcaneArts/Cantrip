// Run with node --import tsx. No SQL fixture routes or substitute server entry.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { ProductionWorkerLinkFixture } from "./production-worker-link-fixture.mjs";
import {
  crashWorkerLinkServer,
  exhaustWorkerLinkQuota,
  restartWorkerLinkEndpoint,
  selectiveWorkerLinkRevocation,
  slowWorkerLinkConsumer,
  transferWorkerLink,
} from "./production-worker-link-cases.mjs";

const { values } = parseArgs({
  options: {
    runtime: { type: "string" },
    database: { type: "string", default: "pglite" },
    scenario: { type: "string", default: "acceptance" },
    root: { type: "string" },
    artifact: { type: "string" },
    "node-directory": { type: "string" },
    "payload-mib": { type: "string", default: "64" },
    "window-frames": { type: "string", default: "64" },
    "server-outage-ms": { type: "string", default: "0" },
  },
});
assert.ok(["node", "rust"].includes(values.runtime));
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(values.database));
assert.ok(["acceptance", "download", "echo"].includes(values.scenario));
const serverOutageMs = Number(values["server-outage-ms"]);
assert.ok(Number.isSafeInteger(serverOutageMs) && serverOutageMs >= 0);
assert.ok(serverOutageMs === 0 || values.scenario === "acceptance");
const run = path.resolve(
  values.root,
  values.database,
  values.scenario,
  values.runtime,
  "runs",
  `${Date.now()}-${process.pid}`,
);
await mkdir(run, { recursive: true });
const fixture = new ProductionWorkerLinkFixture({
  runtime: values.runtime,
  database: values.database,
  root: run,
  artifact: path.resolve(
    values.artifact ?? process.env.CANTRIP_BENCH_NATIVE_ARTIFACT,
  ),
  nodeDirectory: path.resolve(
    values["node-directory"] ?? process.env.CANTRIP_BENCH_NODE_DIRECTORY,
  ),
});
const report = {
  runtime: values.runtime,
  database: values.database,
  scenario: values.scenario,
  serverOutageMs,
  root: run,
  status: "running",
  scope:
    "Production server, WorkerConnection and WorkerLinkGateway; actual HTTP-issued observation/tunnel grants; controlled opaque endpoint bytes on events/stream lanes. Worker restart recreates the endpoint/gateway/transport in the driver, not a full worker process. No product encryption or other QoS/platform/multi-instance performance claim.",
};
const payloadMiB = Number(values["payload-mib"]),
  windowFrames = Number(values["window-frames"]);
try {
  await fixture.start();
  report.serverVersion = fixture.bootstrap.server.version.version;
  report.serverIdentity = fixture.bootstrap.server.id;
  if (values.scenario !== "echo") {
    const probe = await fixture.relay("events-transfer");
    const channel = await fixture.observation(probe);
    report.download = await transferWorkerLink({
      probe,
      channel,
      payloadMiB,
      windowFrames,
    });
    report.download.rss = await fixture.server.rss();
    await fixture.client.visit(
      "release download",
      "DELETE",
      `/api/worker-links/${probe.session.sessionId}`,
      { status: 204 },
    );
    assert.deepEqual(await probe.closed, {
      code: 1008,
      reason: "WorkerLink session ended",
    });
    if (probe.failure) throw probe.failure;
  }
  if (values.scenario !== "download") {
    const probe = await fixture.relay("tunnel-transfer");
    const channel = await fixture.tunnel(probe);
    report.echo = await transferWorkerLink({
      probe,
      channel,
      payloadMiB,
      windowFrames,
      echo: true,
    });
    report.echo.rss = await fixture.server.rss();
    if (values.scenario === "acceptance")
      report.revocation = await selectiveWorkerLinkRevocation(
        fixture,
        probe,
        channel,
      );
    else {
      await fixture.client.visit(
        "release echo",
        "DELETE",
        `/api/worker-links/${probe.session.sessionId}`,
        { status: 204 },
      );
      assert.deepEqual(await probe.closed, {
        code: 1008,
        reason: "WorkerLink session ended",
      });
      if (probe.failure) throw probe.failure;
    }
  }
  if (values.scenario === "acceptance") {
    report.pressure = await slowWorkerLinkConsumer(fixture);
    report.workerRestart = await restartWorkerLinkEndpoint(fixture);
    report.serverCrash = await crashWorkerLinkServer(fixture, serverOutageMs);
    report.quota = await exhaustWorkerLinkQuota(fixture);
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = {
    message: error.message,
    stack: error.stack,
    transferProgress: error.transferProgress,
  };
  process.exitCode = 1;
} finally {
  try {
    await fixture.stop();
    report.exit = fixture.exit;
    if (fixture.gateway) {
      report.gatewayAfterShutdown = fixture.gateway.stats();
      assert.deepEqual(report.gatewayAfterShutdown, {
        channels: 0,
        grants: 0,
        invalidAttempts: 0,
        sessions: 0,
      });
    }
  } catch (error) {
    report.status = "failed";
    report.shutdownFailure = error.message;
    process.exitCode = 1;
  }
  report.commands = fixture.commands;
  await writeFile(
    path.join(run, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
if (report.status !== "passed")
  throw new Error(report.failure?.message ?? report.shutdownFailure);
console.log("Production WorkerLink scenario passed");
