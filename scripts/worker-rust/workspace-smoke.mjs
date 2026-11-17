// Actual production Rust worker/server RPC over an existing attached-workspace
// profile. The seed tool prepares only stopped, owned fixture state; no handlers
// or production endpoints are replaced. New encrypted root attachment is pending.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  realpath,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { fixtureEnvironment, startServer } from "../server-rust/process.mjs";
import { WorkerRoutingRegistry } from "../../cantrip_worker/src/routing-registry.ts";
import { projectLabel } from "../server-rust/security-fixtures.mjs";
import { discoveryWireFixtures } from "../server-rust/discovery-wire-fixtures.mjs";
const { values } = parseArgs({
  options: {
    worker: { type: "string" },
    server: { type: "string" },
    seed: { type: "string" },
  },
});
assert.ok(
  values.worker && values.server && values.seed,
  "Pass linked --worker, --server and --seed binaries",
);
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "cantrip-native-workspace-")),
);
const workerDirectory = path.join(root, "worker"),
  serverDirectory = path.join(root, "server"),
  attached = path.join(root, "attached"),
  checkout = path.join(attached, "private-checkout"),
  bin = path.join(root, "bin");
await mkdir(checkout, { recursive: true });
await mkdir(bin);
const git = execFileSync("/usr/bin/which", ["git"], {
  encoding: "utf8",
}).trim();
await symlink(git, path.join(bin, "git"));
execFileSync(git, [
  "-c",
  "init.defaultBranch=main",
  "init",
  "--quiet",
  checkout,
]);
execFileSync(git, [
  "-C",
  checkout,
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
  "commit",
  "--quiet",
  "--allow-empty",
  "-m",
  "fixture",
]);
const sentinel = path.join(checkout, "untouched.txt");
await writeFile(sentinel, "private dirty content\n");
const registry = new WorkerRoutingRegistry(workerDirectory),
  handles = await registry.protectMetadata({
    rootPath: attached,
    displayPath: attached,
  });
const workerId = "native-workspace-worker",
  workspaceId = "88888888-8888-4888-8888-000000000007",
  projectId = "99999999-9999-4999-8999-000000000007";
const environment = fixtureEnvironment(serverDirectory);
environment.CANTRIP_BOOTSTRAP_MODE = "standalone";
delete environment.CANTRIP_WORKER_TOKEN;
let server,
  child,
  completion,
  diagnostics = "";
async function eventually(read, accept, label) {
  const until = Date.now() + 25000;
  for (;;) {
    const value = await read();
    try {
      accept(value);
      return value;
    } catch (error) {
      if (Date.now() >= until) {
        error.message = label + ": " + error.message + "\n" + diagnostics;
        throw error;
      }
    }
    await delay(50);
  }
}
async function start(port = 0) {
  server = await startServer(
    path.resolve(values.server),
    [
      "--database",
      "pglite",
      "--port",
      String(port),
      "--shutdown-on-stdin-close",
    ],
    { cwd: root, env: environment },
  );
}
async function call(method, route, body) {
  const response = await fetch(server.origin + route, {
    method,
    headers: {
      origin: "http://127.0.0.1:5173",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
function startWorker(code) {
  const workerEnvironment = {
    ...fixtureEnvironment(path.join(root, "unused")),
    PATH: bin,
    NO_COLOR: "1",
    CANTRIP_WORKER_DATA_DIR: workerDirectory,
    CANTRIP_WORKER_ID: workerId,
    CANTRIP_SERVER_URL: server.origin,
    ...(code ? { CANTRIP_WORKER_ENROLLMENT_CODE: code } : {}),
  };
  delete workerEnvironment.CANTRIP_WORKER_TOKEN;
  child = spawn(path.resolve(values.worker), ["--shutdown-on-stdin-close"], {
    cwd: root,
    env: workerEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  const capture = (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-24000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
}
async function stopWorker() {
  if (!child) return;
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    assert.equal(await completion, 0, diagnostics);
  } finally {
    clearTimeout(timer);
    child = undefined;
  }
}
async function ready() {
  await eventually(
    () => call("GET", `/api/workers/${workerId}/version`),
    (value) => assert.equal(value.status, 200),
    "actual worker command socket ready",
  );
}
async function seed(input) {
  const process = spawn(path.resolve(values.seed), [serverDirectory], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let errors = "";
  process.stderr.on("data", (chunk) => {
    errors = (errors + chunk).slice(-16000);
  });
  process.stdout.on("data", (chunk) => {
    errors = (errors + chunk).slice(-16000);
  });
  const done = new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("close", resolve);
  });
  process.stdin.write(JSON.stringify(input) + "\n");
  assert.equal(await done, 0, errors);
}
try {
  await start();
  const port = Number(new URL(server.origin).port);
  const enrollment = await call("POST", "/api/workers/enrollment-codes", {
    label: "Native workspace fixture",
    expiresInSeconds: 300,
  });
  assert.equal(enrollment.status, 201);
  startWorker(enrollment.body.code);
  await ready();
  await stopWorker();
  await server.close();
  server = undefined;
  const nameProtection =
    discoveryWireFixtures(projectLabel).encryptedProjectWorkspaceCreateSchema[0]
      .nameProtection;
  await seed({
    owner: "00000000-0000-0000-0000-000000000001",
    workspace: {
      id: workspaceId,
      nameProtection,
      storage: {
        kind: "attached",
        workerId,
        rootPathHandle: handles.rootPath,
        displayHandle: handles.displayPath,
      },
    },
  });
  await start(port);
  startWorker();
  await ready();
  const queued = await call(
    "POST",
    `/api/workspaces/${workspaceId}/repository-discovery`,
    {},
  );
  assert.equal(queued.status, 202, JSON.stringify(queued));
  const snapshot = await eventually(
    () => call("GET", `/api/workspaces/${workspaceId}/repository-discovery`),
    (value) => {
      assert.equal(value.status, 200);
      assert.equal(
        value.body.job.state,
        "succeeded",
        JSON.stringify(value.body),
      );
      assert.equal(value.body.candidates.length, 1);
    },
    "actual native discovery job",
  );
  const candidate = snapshot.body.candidates[0];
  assert.match(candidate.pathHandle, /^ctrr_[A-Za-z0-9_-]{43}$/);
  assert.equal(candidate.classification, "local-git");
  assert.equal(snapshot.body.job.counts.candidates, 1);
  assert.equal(
    JSON.stringify(snapshot).includes(attached),
    false,
    "worker paths remain private",
  );
  const reopened = new WorkerRoutingRegistry(workerDirectory);
  assert.equal(
    (await reopened.resolveMetadata({ path: candidate.pathHandle })).path,
    checkout,
  );
  const imported = await call(
    "POST",
    `/api/workspaces/${workspaceId}/repository-imports`,
    {
      expectedStateRevision: snapshot.body.job.stateRevision,
      candidates: [
        { candidateId: candidate.id, projectId, nameProtection: projectLabel },
      ],
    },
  );
  assert.equal(imported.status, 202, JSON.stringify(imported));
  await eventually(
    () => call("GET", `/api/workspaces/${workspaceId}/repository-discovery`),
    (value) => {
      assert.equal(value.status, 200);
      assert.equal(
        value.body.candidates[0].importState,
        "imported",
        JSON.stringify(value.body),
      );
      assert.equal(value.body.candidates[0].projectId, projectId);
    },
    "actual native checkout validation and durable import",
  );
  assert.equal(await readFile(sentinel, "utf8"), "private dirty content\n");
  const restarted = await call("POST", `/api/workers/${workerId}/restart`, {});
  assert.equal(restarted.status, 202, JSON.stringify(restarted));
  await ready();
  await stopWorker();
  await server.close();
  server = undefined;
  console.log(
    JSON.stringify({
      suite: "actual-native-workspace-worker-server",
      passed: true,
      realWorkerAndServer: true,
      existingAttachedProfile: true,
      opaquePaths: true,
      realGitDiscovery: true,
      actualImportValidationAndCommit: true,
      nodeAbsentFromWorkerPath: true,
      scope:
        "Existing attached workspace; new encrypted root attachment and other worker domains remain pending.",
    }),
  );
} finally {
  await stopWorker();
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
