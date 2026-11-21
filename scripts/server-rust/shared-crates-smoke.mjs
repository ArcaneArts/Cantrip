// Focused production-server smoke, not a worker runtime or domain test suite.
// Run with Node's tsx loader to use the current, unchanged Node worker modules.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { cantripVersion } from "../../packages/version/dist/index.js";
import {
  cantripVersionSchema,
  workerHeartbeatSchema,
} from "../../packages/protocol/dist/index.js";
import { enrollWorker } from "../../tests/reference-node-worker/src/enrollment.ts";
import {
  createHeartbeat,
  sendHeartbeat,
} from "../../tests/reference-node-worker/src/heartbeat.ts";
import { WorkerConnection } from "../../tests/reference-node-worker/src/transport.ts";
import { buildRustServer, repositoryRoot } from "./build.mjs";
import { fixtureEnvironment, startServer } from "./process.mjs";

const { values } = parseArgs({ options: { binary: { type: "string" } } });
const binary = values.binary ?? (await buildRustServer());
const root = await mkdtemp(path.join(tmpdir(), "cantrip-shared-crates-"));
let server, connection;
try {
  const environment = fixtureEnvironment(path.join(root, "server"));
  environment.CANTRIP_BOOTSTRAP_MODE = "standalone";
  delete environment.CANTRIP_WORKER_TOKEN;
  server = await startServer(
    binary,
    ["--database", "pglite", "--port", "0", "--shutdown-on-stdin-close"],
    { cwd: repositoryRoot, env: environment },
  );
  const call = async (method, route, body, status = 200) => {
    const response = await fetch(server.origin + route, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        origin: "http://127.0.0.1:5173",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    assert.equal(response.status, status, route + ": " + text);
    return text ? JSON.parse(text) : null;
  };
  await call("GET", "/healthz");
  await call("GET", "/readyz");
  const enrollment = await call(
    "POST",
    "/api/workers/enrollment-codes",
    { label: "Shared crate smoke", expiresInSeconds: 300 },
    201,
  );
  const config = {
    workerId: "shared-crates-worker",
    name: "Shared crate smoke worker",
    dataDirectory: path.join(root, "worker"),
    serverUrl: server.origin,
    enrollmentCode: enrollment.code,
    replacement: null,
    token: "",
    tokenSource: "enrollment",
  };
  const now = new Date().toISOString();
  const unavailableRuntime = workerHeartbeatSchema.parse({
    workerId: config.workerId,
    name: config.name,
    platform: process.platform,
    architecture: process.arch,
    codexVersion: null,
    startedAt: now,
  }).codexRuntime;
  const heartbeat = createHeartbeat(config, unavailableRuntime, now);
  await enrollWorker(config, heartbeat);
  await sendHeartbeat(config, heartbeat);
  let versionRequests = 0;
  const backgroundCommands = new Set();
  const { promise: ready, resolve: onReady } = Promise.withResolvers();
  connection = new WorkerConnection(
    config,
    async (command) => {
      if (command.type === "worker.version") {
        versionRequests++;
        // Same result as the current Node worker's worker.version handler.
        return cantripVersion;
      }
      backgroundCommands.add(command.type);
      throw new Error(
        "Focused smoke does not implement worker resource domains.",
      );
    },
    undefined,
    undefined,
    undefined,
    1000,
    onReady,
  );
  connection.start();
  let readyTimer;
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        readyTimer = setTimeout(
          () => reject(new Error("Worker did not become ready.")),
          15_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(readyTimer);
  }
  assert.deepEqual(
    await call("GET", `/api/workers/${config.workerId}/version`),
    cantripVersionSchema.parse(cantripVersion),
  );
  assert.equal(versionRequests, 1);
  connection.close();
  connection = undefined;
  await server.close();
  server = undefined;
  console.log(
    JSON.stringify({
      suite: "shared-crates-server-node-worker-smoke",
      passed: true,
      database: "pglite",
      enrollment: true,
      heartbeat: true,
      workerVersionRequests: versionRequests,
      cleanShutdown: true,
      backgroundCommands: [...backgroundCommands],
      scope:
        "Production server and unchanged Node enrollment/heartbeat/WorkerConnection, controlled version handler; no full worker runtime.",
    }),
  );
} finally {
  connection?.close();
  try {
    await server?.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
