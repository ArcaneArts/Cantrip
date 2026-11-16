// Actual native worker/server control integration. No fake worker command handler.
import assert from "node:assert/strict";
import { verifyGrantFlow } from "./grant-server-flow.mjs";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { fixtureEnvironment, startServer } from "../server-rust/process.mjs";
import { repositoryRoot } from "../server-rust/build.mjs";
const { values } = parseArgs({
  options: {
    worker: { type: "string" },
    server: { type: "string" },
    shutdown: { type: "string", default: "stdin" },
  },
});
assert.ok(
  values.worker && values.server,
  "Pass linked --worker and --server binaries",
);
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-native-worker-control-"),
);
let server, child, completion, failure;
let diagnostics = "";
async function eventually(read, check, label) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    try {
      check(value);
      return value;
    } catch (error) {
      if (Date.now() >= deadline) {
        error.message = label + ": " + error.message + "\n" + diagnostics;
        throw error;
      }
    }
    await delay(40);
  }
}
async function stopWorker() {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    if (values.shutdown === "SIGTERM") child.kill("SIGTERM");
    else child.stdin.end();
  }
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    assert.equal(await completion, 0, diagnostics);
  } finally {
    clearTimeout(timer);
    child = undefined;
  }
}
try {
  const environment = fixtureEnvironment(path.join(root, "server"));
  environment.CANTRIP_BOOTSTRAP_MODE = "standalone";
  delete environment.CANTRIP_WORKER_TOKEN;
  server = await startServer(
    path.resolve(values.server),
    ["--database", "pglite", "--port", "0", "--shutdown-on-stdin-close"],
    { cwd: repositoryRoot, env: environment },
  );
  const call = async (method, route, body) => {
    const response = await fetch(server.origin + route, {
      method,
      headers: {
        origin: "http://127.0.0.1:5173",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const enrollment = await call("POST", "/api/workers/enrollment-codes", {
    label: "Native Rust worker smoke",
    expiresInSeconds: 300,
  });
  assert.equal(enrollment.status, 201);
  const dataDirectory = path.join(root, "worker");
  const cleanEnvironment = fixtureEnvironment(path.join(root, "unused"));
  delete cleanEnvironment.CANTRIP_WORKER_TOKEN;
  child = spawn(path.resolve(values.worker), ["--shutdown-on-stdin-close"], {
    cwd: root,
    env: {
      ...cleanEnvironment,
      PATH: "",
      NO_COLOR: "1",
      CANTRIP_WORKER_DATA_DIR: dataDirectory,
      CANTRIP_WORKER_NAME: "Native Rust worker smoke",
      CANTRIP_WORKER_ID: "native-control-worker",
      CANTRIP_SERVER_URL: server.origin,
      CANTRIP_WORKER_ENROLLMENT_CODE: enrollment.body.code,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pid = child.pid;
  completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  const capture = (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-64_000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const version = () =>
    call("GET", "/api/workers/native-control-worker/version");
  const first = await eventually(
    version,
    (value) => {
      assert.equal(value.status, 200);
      assert.match(value.body.version, /^\d+\.\d+\.\d+$/);
    },
    "initial native worker version",
  );
  const publishedVersion = spawnSync(
    path.resolve(values.worker),
    ["--version"],
    { encoding: "utf8", env: { PATH: "" } },
  );
  assert.equal(publishedVersion.status, 0, publishedVersion.stderr);
  assert.equal(JSON.parse(publishedVersion.stdout).version, first.body.version);
  const credentialPath = path.join(dataDirectory, "worker-credential.json");
  const encryptionPath = path.join(dataDirectory, "worker-encryption-key.json");
  let encryptionRecord = await readFile(encryptionPath, "utf8");
  assert.equal(JSON.parse(encryptionRecord).version, 2);
  assert.equal(JSON.parse(encryptionRecord).workerId, "native-control-worker");
  await verifyGrantFlow(call, encryptionPath, "native-control-worker");
  encryptionRecord = await readFile(encryptionPath, "utf8");
  const initialLogs = await call(
    "GET",
    "/api/workers/native-control-worker/logs?limit=200",
  );
  assert.equal(initialLogs.status, 200);
  assert.ok(
    initialLogs.body.records.some(
      (record) => record.context?.event === "worker.connection.connected",
    ),
  );
  const original = JSON.parse(await readFile(credentialPath, "utf8"));
  assert.equal(original.workerId, "native-control-worker");
  assert.equal(original.serverUrl, server.origin);
  const rotated = await call(
    "POST",
    "/api/workers/native-control-worker/credentials/rotate",
    {},
  );
  assert.equal(rotated.status, 200);
  assert.equal(rotated.body.delivered, true);
  const saved = JSON.parse(await readFile(credentialPath, "utf8"));
  assert.equal(saved.credential, rotated.body.credential);
  assert.notEqual(saved.credential, original.credential);
  await eventually(
    version,
    (value) => assert.equal(value.status, 200),
    "reconnect with rotated credential",
  );
  const starts = () =>
    (diagnostics.match(/event=worker\.startup\.started\b/g) ?? []).length;
  const beforeRestart = starts();
  const restarted = await call(
    "POST",
    "/api/workers/native-control-worker/restart",
    {},
  );
  assert.equal(restarted.status, 202);
  await eventually(
    version,
    (value) => {
      assert.equal(value.status, 200);
      assert.ok(starts() > beforeRestart);
    },
    "in-process native worker restart",
  );
  assert.equal(child.pid, pid);
  const restartedLogs = await call(
    "GET",
    "/api/workers/native-control-worker/logs?limit=200",
  );
  assert.equal(restartedLogs.status, 200);
  assert.deepEqual(
    restartedLogs.body.records.find(
      (record) => record.cursor === initialLogs.body.records[0].cursor,
    ),
    initialLogs.body.records[0],
    "same-process restart retains the log buffer",
  );
  assert.deepEqual(JSON.parse(await readFile(credentialPath, "utf8")), saved);
  assert.equal(
    await readFile(encryptionPath, "utf8"),
    encryptionRecord,
    "restart retains the exact endpoint encryption identity",
  );
  const revoked = await call(
    "DELETE",
    `/api/workers/native-control-worker/credentials/${rotated.body.credentialSummary.id}`,
  );
  assert.equal(revoked.status, 204);
  await eventually(
    async () => diagnostics,
    (text) => assert.match(text, /worker\.connection\.authentication-rejected/),
    "revocation stops socket retries",
  );
  const connections = (
    diagnostics.match(/event=worker\.connection\.connected\b/g) ?? []
  ).length;
  await delay(1600);
  assert.equal(
    (diagnostics.match(/event=worker\.connection\.connected\b/g) ?? []).length,
    connections,
  );
  await stopWorker();
  assert.ok(!diagnostics.includes(enrollment.body.code));
  assert.ok(!diagnostics.includes(saved.credential));
  const records = [];
  for (const name of (await readdir(path.join(dataDirectory, "logs"))).sort()) {
    if (name.endsWith(".jsonl"))
      records.push(
        ...(await readFile(path.join(dataDirectory, "logs", name), "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse),
      );
  }
  assert.ok(
    records.filter(
      (record) => record.context?.event === "worker.shutdown.completed",
    ).length >= 2,
    "restart and final shutdown were archived",
  );
  for (let i = 1; i < records.length; i++)
    assert.ok(
      records[i].cursor > records[i - 1].cursor,
      "archive cursors remain ordered across same-process restart",
    );
  await server.close();
  server = undefined;
  console.log(
    JSON.stringify({
      suite: "native-worker-control-integration",
      passed: true,
      workerPathEmpty: true,
      enrollmentAndHeartbeat: true,
      versionRoundTrip: true,
      credentialRotationAndReconnect: true,
      sameProcessRestart: true,
      actualScopedGrantRotationAndRevocation: true,
      credentialRevocation: true,
      archiveDrained: true,
      cleanShutdown: true,
      shutdownTrigger: values.shutdown,
      scope:
        "Real native worker implemented control handlers and real Rust server; execution/data-plane domains remain unimplemented.",
    }),
  );
} catch (error) {
  failure = error;
  throw error;
} finally {
  try {
    await stopWorker();
    await server?.close();
  } catch (error) {
    if (!failure) throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
