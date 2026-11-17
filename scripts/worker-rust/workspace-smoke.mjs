// Actual production Rust worker/server: fresh encrypted root attachment, then
// restart and discover/import the persisted workspace. No seed or fake handlers.
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
import * as cryptoClient from "../../packages/crypto/dist/index.js";
import * as protocol from "../../packages/protocol/dist/index.js";
import { verifyManagedFolders } from "./folder-smoke-cases.mjs";
import {
  assertSurfaceGrantRefresh,
  verifyExplorer,
} from "./explorer-smoke-cases.mjs";
const { values } = parseArgs({
  options: {
    worker: { type: "string" },
    server: { type: "string" },
  },
});
assert.ok(
  values.worker && values.server,
  "Pass linked --worker and --server binaries",
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
let master, componentKey, surfaceKey;
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
async function repositoryClient() {
  const ownerId = "00000000-0000-0000-0000-000000000001";
  const encryptionPath = path.join(
    workerDirectory,
    "worker-encryption-key.json",
  );
  const identity = JSON.parse(await readFile(encryptionPath, "utf8"));
  master = cryptoClient.generateAccountMasterKey();
  const client = await cryptoClient.generateHpkeKeyPair();
  const publicKey = await cryptoClient.publicKeyForPair(client);
  const clientId = "77777777-7777-4777-8777-777777777777";
  const wrappedMasterKey = await cryptoClient.wrapAccountMasterKeyForClient({
    ownerId,
    clientId,
    accountMasterKey: master,
    masterKeyRevision: 1,
    clientPublicKey: publicKey,
  });
  const initialized = await call("POST", "/api/encryption/profile/initialize", {
    profile: {
      formatVersion: 1,
      activeMasterKeyRevision: 1,
      passwordKdf: null,
      passwordWrappedMasterKey: null,
      payloadMigrationStatus: "pending",
    },
    initialClient: {
      id: clientId,
      label: "Native workspace client",
      publicKey,
      wrappedMasterKey,
    },
  });
  assert.equal(initialized.status, 201, JSON.stringify(initialized));
  const pending = await call(
    "POST",
    `/api/workers/${workerId}/encryption/refresh`,
    { component: "repository-content", keyRevision: 1 },
  );
  assert.equal(pending.status, 200, JSON.stringify(pending));
  const principals = await call("GET", "/api/encryption/principals");
  assert.equal(principals.status, 200);
  const principal = principals.body.find(
    (principal) => principal.id === identity.principalId,
  );
  assert.ok(principal);
  const approved = await call(
    "POST",
    `/api/encryption/principals/${principal.id}/approve`,
    { expectedRevision: principal.revision },
  );
  assert.equal(approved.status, 200, JSON.stringify(approved));
  componentKey = cryptoClient.deriveComponentKey({
    accountMasterKey: master,
    ownerId,
    component: "repository-content",
    keyRevision: 1,
  });
  const wrappedKey = await cryptoClient.wrapComponentKeyForWorker({
    ownerId,
    workerId,
    component: "repository-content",
    keyRevision: 1,
    componentKey,
    workerPublicKey: identity.publicKey,
  });
  const granted = await call(
    "POST",
    `/api/encryption/principals/${principal.id}/grants`,
    { component: "repository-content", keyRevision: 1, wrappedKey },
  );
  assert.equal(granted.status, 201, JSON.stringify(granted));
  const refreshed = await call(
    "POST",
    `/api/workers/${workerId}/encryption/refresh`,
    { component: "repository-content", keyRevision: 1 },
  );
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed));
  assert.equal(refreshed.body.status.state, "ready");
  surfaceKey = cryptoClient.deriveComponentKey({
    accountMasterKey: master,
    ownerId,
    component: "surface-private-state",
    keyRevision: 1,
  });
  const surfaceWrappedKey = await cryptoClient.wrapComponentKeyForWorker({
    ownerId,
    workerId,
    component: "surface-private-state",
    keyRevision: 1,
    componentKey: surfaceKey,
    workerPublicKey: identity.publicKey,
  });
  const surfaceGranted = await call(
    "POST",
    `/api/encryption/principals/${principal.id}/grants`,
    {
      component: "surface-private-state",
      keyRevision: 1,
      wrappedKey: surfaceWrappedKey,
    },
  );
  assert.equal(surfaceGranted.status, 201, JSON.stringify(surfaceGranted));
  const surfaceRefreshed = await call(
    "POST",
    `/api/workers/${workerId}/encryption/refresh`,
    { component: "surface-private-state", keyRevision: 1 },
  );
  assertSurfaceGrantRefresh(surfaceRefreshed);
  const serverId = JSON.parse(await readFile(encryptionPath, "utf8")).serverId;
  assert.equal(typeof serverId, "string");
  async function operation(id, content, route, body) {
    const operationId = crypto.randomUUID();
    const context = {
      serverId,
      projectId: id,
      worktreeId: workerId,
      operationId,
      direction: "request",
    };
    const plaintext = new TextEncoder().encode(
      JSON.stringify(
        protocol.repositoryOperationRequestContentSchema.parse(content),
      ),
    );
    let protectedRequest;
    try {
      protectedRequest = await cryptoClient.encryptRepositoryOperationPayload({
        ownerId,
        context,
        keyRevision: 1,
        componentKey,
        plaintext,
      });
    } finally {
      plaintext.fill(0);
    }
    const result = await call("POST", route, {
      ...body,
      operationId,
      protectedRequest,
    });
    const response = result.body.operation ?? result.body;
    assert.ok(response.protectedResponse, JSON.stringify(result));
    const opened = await cryptoClient.decryptRepositoryOperationPayload({
      ownerId,
      context: { ...context, direction: "response" },
      keyRevision: 1,
      componentKey,
      opaque: response.protectedResponse,
    });
    try {
      return {
        ...result,
        outcome: protocol.repositoryOperationOutcomeContentSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(opened)),
        ),
      };
    } finally {
      opened.fill(0);
    }
  }
  return {
    async attachRoot(id, rootPath, nameProtection) {
      const result = await operation(
        id,
        { type: "workspace.root.attach", arguments: { rootPath } },
        "/api/workspaces/attached",
        { id, nameProtection, storage: { kind: "attached", workerId } },
      );
      assert.equal(
        JSON.stringify(result.body).includes(rootPath),
        false,
        "root plaintext is private",
      );
      return result;
    },
    async registerMetadata(scopeId, values) {
      const result = await operation(
        scopeId,
        { type: "repository.metadata.register", arguments: { values } },
        `/api/workers/${workerId}/repository-operation`,
        { scopeId, access: "write", agent: false },
      );
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.equal(result.outcome.ok, true, JSON.stringify(result));
      return result.outcome.result.values;
    },
  };
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
  const repository = await repositoryClient();
  const attach = repository.attachRoot;
  const nameProtection =
    discoveryWireFixtures(projectLabel).encryptedProjectWorkspaceCreateSchema[0]
      .nameProtection;
  const rejected = await attach(
    "88888888-8888-4888-8888-000000000008",
    path.join(checkout, "untouched.txt"),
    nameProtection,
  );
  assert.equal(rejected.status, 200, JSON.stringify(rejected));
  assert.equal(rejected.body.workspace, null);
  assert.equal(rejected.outcome.ok, false);
  assert.equal(rejected.outcome.code, "invalid-root");
  const created = await attach(workspaceId, attached, nameProtection);
  assert.equal(created.status, 201, JSON.stringify(created));
  assert.equal(created.outcome.ok, true);
  assert.deepEqual(
    created.outcome.result,
    created.body.operation.workspaceRootAttachment,
  );
  assert.equal(created.body.workspace.id, workspaceId);
  assert.equal(
    created.body.workspace.storage.rootPathHandle,
    created.outcome.result.rootPathHandle,
  );
  await eventually(
    () => call("GET", `/api/workspaces/${workspaceId}/repository-discovery`),
    (value) => {
      assert.equal(value.status, 200);
      assert.equal(value.body.job.state, "succeeded");
    },
    "initial discovery after fresh encrypted attachment",
  );
  await stopWorker();
  await server.close();
  server = undefined;
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
  await verifyManagedFolders({
    call,
    eventually,
    root,
    workerDirectory,
    workerId,
    registerMetadata: repository.registerMetadata,
    projectLabel,
    workspaceName: nameProtection,
  });
  const metadataKey = cryptoClient.deriveComponentKey({
    accountMasterKey: master,
    ownerId: "00000000-0000-0000-0000-000000000001",
    component: "private-surface-metadata",
    keyRevision: 1,
  });
  let reopenExplorer;
  try {
    const identity = JSON.parse(
      await readFile(
        path.join(workerDirectory, "worker-encryption-key.json"),
        "utf8",
      ),
    );
    reopenExplorer = await verifyExplorer({
      call,
      serverId: identity.serverId,
      ownerId: identity.ownerId,
      surfaceKey,
      metadataKey,
      projectId,
      workerId,
      checkout,
    });
  } finally {
    metadataKey.fill(0);
  }
  const restarted = await call("POST", `/api/workers/${workerId}/restart`, {});
  assert.equal(restarted.status, 202, JSON.stringify(restarted));
  await ready();
  await reopenExplorer();
  await stopWorker();
  await server.close();
  server = undefined;
  console.log(
    JSON.stringify({
      suite: "actual-native-workspace-worker-server",
      passed: true,
      realWorkerAndServer: true,
      existingAttachedProfile: true,
      freshEncryptedRootAttachment: true,
      authenticatedClientAndGrants: true,
      encryptedRootErrors: true,
      opaquePaths: true,
      realGitDiscovery: true,
      actualImportValidationAndCommit: true,
      managedFolderCreateAndDelete: true,
      existingFolderRetryAndPreservation: true,
      encryptedExplorerAndFileDocument: true,
      fileDocumentBindingAndWorkerRestart: true,
      surfaceGrantTerminalServiceReconciliation:
        "pending native terminal services",
      nodeAbsentFromWorkerPath: true,
      scope:
        "Fresh attachment, discovery/import, managed/existing folders and host Explorer/file-document commands; other worker domains remain pending.",
    }),
  );
} finally {
  await stopWorker();
  await server?.close();
  master?.fill(0);
  componentKey?.fill(0);
  surfaceKey?.fill(0);
  await rm(root, { recursive: true, force: true });
}
