// Actual production Rust worker/server: fresh encrypted root attachment, then
// restart and discover/import the persisted workspace. Owned profiles and native
// command handlers; selected catalog/admission fixtures seed only stopped profiles.
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
import { repositoryFixture } from "../server-rust/repository-fixture.mjs";
import { literal } from "../server-rust/project-target-state.mjs";
import { WorkerRoutingRegistry } from "../../tests/reference-node-worker/src/routing-registry.ts";
import { projectLabel } from "../server-rust/security-fixtures.mjs";
import { discoveryWireFixtures } from "../server-rust/discovery-wire-fixtures.mjs";
import * as cryptoClient from "../../packages/crypto/dist/index.js";
import * as protocol from "../../packages/protocol/dist/index.js";
import { verifyManagedFolders } from "./folder-smoke-cases.mjs";
import {
  folderConversionFixture,
  verifyFolderConversion,
} from "./folder-conversion-smoke.mjs";
import {
  assertSurfaceGrantRefresh,
  verifyExplorer,
} from "./explorer-smoke-cases.mjs";
import { verifyHostRuns } from "./run-runtime-smoke.mjs";
import { verifyRunDefinitions } from "./run-definitions-smoke.mjs";
import { verifyTerminalServices } from "./terminal-services-smoke.mjs";
import { verifyHostTerminal } from "./host-terminal-relay-smoke.mjs";
import { verifyGit } from "./git-smoke-cases.mjs";
import { verifyGitDrafts } from "./git-draft-smoke.mjs";
import { verifyProjectExport } from "./project-export-smoke.mjs";
import { verifyNativeWorktrees } from "./worktree-smoke-cases.mjs";
import { githubCatalogFixture } from "./github-catalog-fixture.mjs";
import { verifyGithubCatalog } from "./github-catalog-smoke-cases.mjs";
import { githubIssuesFixture } from "./github-issues-fixture.mjs";
import { verifyGithubIssues } from "./github-issues-smoke-cases.mjs";
import { pullRequestFixture } from "./pull-request-fixture.mjs";
import { verifyPullRequest } from "./pull-request-smoke-cases.mjs";
import { pullRequestActionsFixture } from "./pull-request-actions-fixture.mjs";
import { verifyPullRequestActions } from "./pull-request-actions-smoke-cases.mjs";
import { pullRequestLifecycleFixture } from "./pull-request-lifecycle-fixture.mjs";
import { verifyPullRequestLifecycle } from "./pull-request-lifecycle-smoke-cases.mjs";
import { githubOperationsFixture } from "./github-operations-fixture.mjs";
import { verifyGithubOperations } from "./github-operations-smoke-cases.mjs";
import { verifyWorktreeRecovery } from "./worktree-recovery-smoke-cases.mjs";
import { replicaProvisionFixture } from "./replica-provision-fixture.mjs";
import { verifyReplicaProvision } from "./replica-provision-smoke-cases.mjs";
import { verifyReplicaLifecycleJobs } from "./replica-lifecycle-smoke-cases.mjs";
// Every Git remote in this owned fixture is local. Preserve production Git
// policy while explicitly allowing this test's local submodule clones.
const previousGitProtocol = process.env.GIT_ALLOW_PROTOCOL;
process.env.GIT_ALLOW_PROTOCOL = "file";
const { values } = parseArgs({
  options: {
    worker: { type: "string" },
    server: { type: "string" },
    codex: { type: "string" },
    cli: { type: "string" },
    "observations-only": { type: "boolean", default: false },
    "codegraph-distribution": { type: "string" },
    "recovery-only": { type: "boolean", default: false },
    "github-catalog-only": { type: "boolean", default: false },
    "github-issues-only": { type: "boolean", default: false },
    "pull-request-only": { type: "boolean", default: false },
    "pull-request-actions-only": { type: "boolean", default: false },
    "pull-request-lifecycle-only": { type: "boolean", default: false },
    "github-operations-only": { type: "boolean", default: false },
    "replica-provision-only": { type: "boolean", default: false },
    "replica-lifecycle-only": { type: "boolean", default: false },
    "folder-conversion-only": { type: "boolean", default: false },
    "git-draft-only": { type: "boolean", default: false },
    "project-export-only": { type: "boolean", default: false },
    "terminal-relay-only": { type: "boolean", default: false },
    "terminal-direct-broker": { type: "string" },
    "worker-link-local": { type: "boolean", default: false },
    "shares-only": { type: "boolean", default: false },
    "run-definitions-only": { type: "boolean", default: false },
    "binary-writes-only": { type: "boolean", default: false },
    "file-imports-only": { type: "boolean", default: false },
    "run-runtime-only": { type: "boolean", default: false },
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
const exportHome = path.join(root, "export-user-home");
const exportCodex = path.join(exportHome, "external-codex");
await mkdir(checkout, { recursive: true });
await mkdir(bin);
if (values["project-export-only"])
  await mkdir(exportCodex, { recursive: true });
const git = execFileSync("/usr/bin/which", ["git"], {
  encoding: "utf8",
}).trim();
await symlink(git, path.join(bin, "git"));
// Git's existing noninteractive editor is the POSIX `true` utility. Keep that
// native dependency available while excluding Node from the worker's PATH.
await symlink("/usr/bin/true", path.join(bin, "true"));
// Git's native submodule shell frontend uses these system utilities. Keep the
// fixture's explicit native dependencies available while excluding Node.
for (const name of ["basename", "sed", "uname", "env"])
  await symlink(`/usr/bin/${name}`, path.join(bin, name));
if (
  !values["github-catalog-only"] &&
  !values["github-issues-only"] &&
  !values["pull-request-only"] &&
  !values["pull-request-actions-only"] &&
  !values["pull-request-lifecycle-only"] &&
  !values["github-operations-only"] &&
  !values["folder-conversion-only"] &&
  !values["git-draft-only"] &&
  !values["project-export-only"] &&
  !values["terminal-relay-only"] &&
  !values["run-definitions-only"] &&
  !values["binary-writes-only"] &&
  !values["file-imports-only"] &&
  !values["run-runtime-only"] &&
  !values["codegraph-distribution"] &&
  !(values["replica-provision-only"] || values["replica-lifecycle-only"])
)
  await symlink(
    execFileSync("/usr/bin/which", ["git-lfs"], { encoding: "utf8" }).trim(),
    path.join(bin, "git-lfs"),
  );
const githubFixture =
  values["replica-provision-only"] || values["replica-lifecycle-only"]
    ? await replicaProvisionFixture(root, git)
    : values["github-catalog-only"]
      ? await githubCatalogFixture(root, bin)
      : values["github-issues-only"]
        ? await githubIssuesFixture(root, bin)
        : values["github-operations-only"]
          ? await githubOperationsFixture(root, bin)
          : values["pull-request-lifecycle-only"]
            ? await pullRequestLifecycleFixture(root, bin)
            : values["pull-request-actions-only"]
              ? await pullRequestActionsFixture(root, bin)
              : values["pull-request-only"]
                ? await pullRequestFixture(root, bin)
                : undefined;
const conversionFixture = values["folder-conversion-only"]
  ? await folderConversionFixture(root, git)
  : undefined;
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
const codegraph = values["codegraph-distribution"]
  ? await import("./codegraph-smoke-cases.mjs")
  : undefined;
const workerId = "native-workspace-worker",
  workspaceId = "88888888-8888-4888-8888-000000000007",
  projectId = "99999999-9999-4999-8999-000000000007";
const environment = fixtureEnvironment(serverDirectory);
environment.CANTRIP_BOOTSTRAP_MODE = "standalone";
if (values["worker-link-local"])
  environment.CANTRIP_WORKER_LINK_LOCAL_ENABLED = "true";
delete environment.CANTRIP_WORKER_TOKEN;
let server,
  child,
  completion,
  diagnostics = "";
let master, componentKey, surfaceKey;
let workerStarts = 0;
let failure;
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
    ...(codegraph ? { HOME: path.join(root, "codegraph-home") } : {}),
    ...(values.cli ? { CANTRIP_CLI_BIN: path.resolve(values.cli) } : {}),
    ...(values.codex ? { CANTRIP_CODEX_BIN: path.resolve(values.codex) } : {}),
    ...(values["project-export-only"]
      ? {
          HOME: exportHome,
          CODEX_HOME: exportCodex,
          CANTRIP_LOG_LEVEL: "debug",
        }
      : {}),
    ...(values["terminal-relay-only"] || values["run-runtime-only"]
      ? { SHELL: "/bin/sh" }
      : {}),
    NO_COLOR: "1",
    CANTRIP_WORKER_DATA_DIR: workerDirectory,
    CANTRIP_WORKER_ID: workerId,
    CANTRIP_SERVER_URL: server.origin,
    ...(code ? { CANTRIP_WORKER_ENROLLMENT_CODE: code } : {}),
    ...(githubFixture || conversionFixture
      ? { GH_TOKEN: "", GITHUB_TOKEN: "" }
      : {}),
    ...conversionFixture?.environment,
    ...(values["replica-provision-only"] || values["replica-lifecycle-only"]
      ? githubFixture.environment
      : {}),
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
  const capture = () => {
    let partial = "";
    return (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-24000);
      const lines = (partial + chunk).split("\n");
      partial = lines.pop();
      workerStarts += lines.filter((line) =>
        /event=worker\.startup\.started\b/u.test(line),
      ).length;
    };
  };
  child.stdout.on("data", capture());
  child.stderr.on("data", capture());
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
async function restartWorker() {
  const before = workerStarts;
  const restarted = await call("POST", `/api/workers/${workerId}/restart`, {});
  assert.equal(restarted.status, 202, JSON.stringify(restarted));
  await eventually(
    () => call("GET", `/api/workers/${workerId}/version`),
    (value) => {
      assert.equal(value.status, 200);
      assert.ok(workerStarts > before, "actual native runtime restarted");
    },
    "native runtime restart and command socket readiness",
  );
}
async function enableFixtureWorktrees() {
  // Match the existing actual-project-worktrees catalog fixture. Production
  // servers and workers are stopped while the owned profile is seeded natively.
  const worktreePort = Number(new URL(server.origin).port);
  await stopWorker();
  await server.close();
  server = undefined;
  const seed = await repositoryFixture({
    kind: "rust",
    root,
    dataDirectory: serverDirectory,
    executable: path.join(
      path.dirname(path.resolve(values.server)),
      "examples",
      "project-repository-fixture" +
        (process.platform === "win32" ? ".exe" : ""),
    ),
    databaseMode: "pglite",
  });
  try {
    await seed.seed(
      "UPDATE projects SET origin_kind='github',folder_management=NULL,git_capability=true,github_capability=true,worktree_policy='agent-managed',github_repository_blind_index='native-worktree-fixture' WHERE id=" +
        literal(projectId),
    );
  } finally {
    await seed.close();
  }
  await start(worktreePort);
  startWorker();
  await ready();
}
async function seedReplicaSiblings(entries) {
  // Owned stopped-profile fixture: an offline sibling source is required by
  // the production API's last-replica rule. No sibling command is simulated.
  const port = Number(new URL(server.origin).port);
  await stopWorker();
  if (values.cli) {
    await assert.rejects(
      readFile(path.join(workerDirectory, "cli-connection.json")),
      { code: "ENOENT" },
    );
  }
  await server.close();
  server = undefined;
  const seed = await repositoryFixture({
    kind: "rust",
    root,
    dataDirectory: serverDirectory,
    executable: path.join(
      path.dirname(path.resolve(values.server)),
      "examples",
      "project-repository-fixture",
    ),
    databaseMode: "pglite",
  });
  const backup = "native-retained-replica-fixture";
  try {
    await seed.seed(
      "INSERT INTO workers SELECT (jsonb_populate_record(NULL::workers,to_jsonb(w)||jsonb_build_object('id'," +
        literal(backup) +
        ",'name','Retained offline fixture','last_seen_at','2020-01-01T00:00:00Z'))).* FROM workers w WHERE w.id=" +
        literal(workerId),
    );
    for (let index = 0; index < entries.length; index++) {
      const id =
        "aaaaaaaa-aaaa-4aaa-8aaa-" + String(index + 1).padStart(12, "0");
      await seed.seed(
        "INSERT INTO project_sources SELECT (jsonb_populate_record(NULL::project_sources,to_jsonb(s)||jsonb_build_object('id'," +
          literal(id) +
          ",'worker_id'," +
          literal(backup) +
          ",'primary_worktree_id',NULL))).* FROM project_sources s WHERE s.id=" +
          literal(entries[index].source.id),
      );
    }
  } finally {
    await seed.close();
  }
  await start(port);
  startWorker();
  await ready();
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
  async function operation(id, content, route, body, worktreeId = workerId) {
    const operationId = crypto.randomUUID();
    const context = {
      serverId,
      projectId: id,
      worktreeId,
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
    operation,
    ownerId,
    serverId,
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
  if (codegraph)
    await codegraph.stageCodeGraph({
      distribution: values["codegraph-distribution"],
      root,
      bin: githubFixture?.bin ?? bin,
      workerDirectory,
    });
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
  let githubCoverage,
    gitRuntimeCoverage,
    observationCoverage,
    recoveryCoverage,
    replicaCoverage;
  exercise: if (
    values["replica-provision-only"] ||
    values["replica-lifecycle-only"]
  ) {
    replicaCoverage = await verifyReplicaProvision({
      seedSiblings: seedReplicaSiblings,
      lifecycle: values["replica-lifecycle-only"]
        ? (input) =>
            verifyReplicaLifecycleJobs({
              ...input,
              codegraph: Boolean(codegraph),
            })
        : undefined,
      call,
      fixture: githubFixture,
      workerId,
      workerDirectory,
      root,
      registerMetadata: repository.registerMetadata,
      restartWorker,
      eventually,
    });
  } else if (conversionFixture) {
    await verifyFolderConversion({
      call,
      eventually,
      workerId,
      workerDirectory,
      registerMetadata: repository.registerMetadata,
      restartWorker,
      projectLabel,
      workspaceName:
        discoveryWireFixtures(projectLabel)
          .encryptedProjectWorkspaceCreateSchema[0].nameProtection,
      fixture: conversionFixture,
    });
  } else if (values["github-catalog-only"]) {
    githubCoverage = await verifyGithubCatalog({
      operation: repository.operation,
      fixture: githubFixture,
      workerId,
      workerDirectory,
      restartWorker,
    });
  } else {
    const attach = repository.attachRoot;
    const nameProtection =
      discoveryWireFixtures(projectLabel)
        .encryptedProjectWorkspaceCreateSchema[0].nameProtection;
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
          {
            candidateId: candidate.id,
            projectId,
            nameProtection: projectLabel,
          },
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
    if (values["project-export-only"]) {
      await enableFixtureWorktrees();
      await verifyProjectExport({
        call,
        eventually,
        projectId,
        workerId,
        workerDirectory,
        userHome: exportHome,
        codexHome: exportCodex,
        master,
        ownerId: repository.ownerId,
        restartWorker,
        checkout,
        registerMetadata: repository.registerMetadata,
      });
      break exercise;
    }
    if (values["git-draft-only"]) {
      await verifyGitDrafts({
        call,
        checkout,
        git,
        operation: repository.operation,
        projectId,
        workerId,
      });
      break exercise;
    }
    if (values["run-runtime-only"]) {
      const ownerId = repository.ownerId;
      const runKey = cryptoClient.deriveComponentKey({
        accountMasterKey: master,
        ownerId,
        component: "run-content",
        keyRevision: 1,
      });
      const policyKey = values.cli
        ? cryptoClient.deriveComponentKey({
            accountMasterKey: master,
            ownerId,
            component: "policy-content",
            keyRevision: 1,
          })
        : null;
      const metadataKey = values.cli
        ? cryptoClient.deriveComponentKey({
            accountMasterKey: master,
            ownerId,
            component: "private-surface-metadata",
            keyRevision: 1,
          })
        : null;
      try {
        const identity = JSON.parse(
          await readFile(
            path.join(workerDirectory, "worker-encryption-key.json"),
            "utf8",
          ),
        );
        const grants = [["run-content", runKey]];
        if (policyKey) grants.push(["policy-content", policyKey]);
        for (const [component, componentKey] of grants) {
          const wrappedKey = await cryptoClient.wrapComponentKeyForWorker({
            ownerId,
            workerId,
            component,
            keyRevision: 1,
            componentKey,
            workerPublicKey: identity.publicKey,
          });
          const stored = await call(
            "POST",
            `/api/encryption/principals/${identity.principalId}/grants`,
            {
              component,
              keyRevision: 1,
              wrappedKey,
            },
          );
          assert.equal(stored.status, 201, JSON.stringify(stored));
          const refreshed = await call(
            "POST",
            `/api/workers/${workerId}/encryption/refresh`,
            {
              component,
              keyRevision: 1,
            },
          );
          assert.equal(refreshed.status, 200, JSON.stringify(refreshed));
        }
        await verifyHostRuns({
          call,
          origin: server.origin,
          eventually,
          projectId,
          checkout,
          ownerId,
          serverId: repository.serverId,
          workerId,
          componentKey: runKey,
          restartWorker,
          cli: values.cli && path.resolve(values.cli),
          workerDirectory,
          policyKey,
          explorerKeys: {
            serverId: repository.serverId,
            surfaceKey,
            metadataKey,
          },
        });
      } finally {
        runKey.fill(0);
        policyKey?.fill(0);
        metadataKey?.fill(0);
      }
      break exercise;
    }
    if (values["run-definitions-only"]) {
      await verifyRunDefinitions({ call, projectId, checkout, restartWorker });
      break exercise;
    }
    if (values["binary-writes-only"] || values["file-imports-only"]) {
      const metadataKey = cryptoClient.deriveComponentKey({
        accountMasterKey: master,
        ownerId: repository.ownerId,
        component: "private-surface-metadata",
        keyRevision: 1,
      });
      try {
        await verifyExplorer({
          call,
          serverId: repository.serverId,
          ownerId: repository.ownerId,
          surfaceKey,
          metadataKey,
          projectId,
          workerId,
          checkout,
          fileImports: values["file-imports-only"] && { restartWorker },
          binary: {
            workerDirectory,
            stopWorker,
            restartWorker,
            startWorker: async () => {
              startWorker();
              await ready();
            },
          },
        });
      } finally {
        metadataKey.fill(0);
      }
      break exercise;
    }
    if (values["shares-only"]) {
      const { verifyNetworkShares } = await import("./project-share-cases.mjs");
      await verifyNetworkShares({
        call,
        origin: server.origin,
        ownerId: repository.ownerId,
        workerId,
        workerDirectory,
        serverId: repository.serverId,
        projectId,
        checkout,
        master,
        eventually,
      });
      break exercise;
    }
    if (values["terminal-relay-only"]) {
      const metadataKey = cryptoClient.deriveComponentKey({
        accountMasterKey: master,
        ownerId: repository.ownerId,
        component: "private-surface-metadata",
        keyRevision: 1,
      });
      try {
        await verifyHostTerminal({
          call,
          eventually,
          origin: server.origin,
          workerId,
          ownerId: repository.ownerId,
          serverId: repository.serverId,
          surfaceKey,
          metadataKey,
          projectId,
          checkout,
          cli: values.cli && path.resolve(values.cli),
          directBroker:
            values["terminal-direct-broker"] &&
            path.resolve(values["terminal-direct-broker"]),
          connectionPath: path.join(workerDirectory, "cli-connection.json"),
        });
        const reopen = await verifyTerminalServices({
          call,
          eventually,
          origin: server.origin,
          workerId,
          ownerId: repository.ownerId,
          serverId: repository.serverId,
          surfaceKey,
          metadataKey,
          projectId,
          checkout,
        });
        await restartWorker();
        await reopen();
      } finally {
        metadataKey.fill(0);
      }
      break exercise;
    }
    if (
      !values["observations-only"] &&
      !codegraph &&
      !values["recovery-only"] &&
      !values["github-issues-only"] &&
      !values["pull-request-only"] &&
      !values["pull-request-actions-only"] &&
      !values["pull-request-lifecycle-only"] &&
      !values["github-operations-only"]
    ) {
      const reopenGit = await verifyGit({
        call,
        ownerId: repository.ownerId,
        serverId: repository.serverId,
        componentKey,
        projectId,
        workerId,
        workerDirectory,
        checkout,
        restartWorker,
      });

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
      let reopenExplorer, reopenTerminals;
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
        reopenTerminals = await verifyTerminalServices({
          call,
          eventually,
          ownerId: identity.ownerId,
          serverId: identity.serverId,
          surfaceKey,
          metadataKey,
          projectId,
          checkout,
        });
      } finally {
        metadataKey.fill(0);
      }
      await restartWorker();
      await reopenExplorer();
      await reopenTerminals();
      gitRuntimeCoverage = await reopenGit();
    }
    await enableFixtureWorktrees();
    if (
      values["github-operations-only"] ||
      values["pull-request-lifecycle-only"] ||
      values["pull-request-actions-only"] ||
      values["pull-request-only"]
    ) {
      githubCoverage = await (
        values["github-operations-only"]
          ? verifyGithubOperations
          : values["pull-request-lifecycle-only"]
            ? verifyPullRequestLifecycle
            : values["pull-request-actions-only"]
              ? verifyPullRequestActions
              : verifyPullRequest
      )({
        call,
        ownerId: repository.ownerId,
        serverId: repository.serverId,
        componentKey,
        projectId,
        workerId,
        checkout,
        fixture: githubFixture,
        restartWorker,
      });
    } else if (values["github-issues-only"]) {
      githubCoverage = await verifyGithubIssues({
        call,
        ownerId: repository.ownerId,
        serverId: repository.serverId,
        componentKey,
        projectId,
        workerId,
        checkout,
        fixture: githubFixture,
        restartWorker,
      });
    } else if (values["recovery-only"]) {
      recoveryCoverage = await verifyWorktreeRecovery({
        call,
        ownerId: repository.ownerId,
        serverId: repository.serverId,
        componentKey,
        projectId,
        workerId,
        workerDirectory,
        checkout,
        restartWorker,
        registerMetadata: repository.registerMetadata,
      });
    } else if (codegraph) {
      try {
        await codegraph.verifyCodeGraph({
          call,
          eventually,
          origin: server.origin,
          projectId,
          workerId,
          checkout,
          restartWorker,
        });
      } catch (error) {
        throw new Error(`${error.message}\n${diagnostics}`, { cause: error });
      }
    } else if (values["observations-only"]) {
      const { verifyNativeObservations } =
        await import("./observation-smoke-cases.mjs");
      observationCoverage = await verifyNativeObservations({
        call,
        origin: server.origin,
        projectId,
        workerId,
        workerDirectory,
        checkout,
        restartWorker,
      });
    } else {
      await verifyNativeWorktrees({
        call,
        ownerId: repository.ownerId,
        serverId: repository.serverId,
        componentKey,
        projectId,
        workerId,
        workerDirectory,
        checkout,
        restartWorker,
        registerMetadata: repository.registerMetadata,
      });
    }
  }
  await stopWorker();
  await server.close();
  server = undefined;
  if (conversionFixture)
    console.log(
      JSON.stringify({
        suite: "actual-native-folder-conversion-worker-server",
        passed: true,
        preservesLocalEditsAcrossRetry: true,
        reconcilesCommittedPushWithoutReplay: true,
      }),
    );
  else if (values["git-draft-only"])
    console.log(
      JSON.stringify({
        suite: "actual-native-git-drafts-worker-server",
        passed: true,
        structuredFallbackAndUsage: true,
        preservedGitStatusAndHead: true,
      }),
    );
  else if (values["project-export-only"])
    console.log(
      JSON.stringify({
        suite: "actual-native-project-history-worker-server",
        passed: true,
        durableExternalCodexSession: true,
        replayReusesThread: true,
        recoveredProtectedChatAndAttachment: true,
        continuedImportedAndRelocatedChat: true,
        editedLatestNativeChatTurn: true,
        compactedNativeChatAfterEdit: true,
        agentScheduledNativeCompaction: true,
      }),
    );
  else if (values["run-runtime-only"])
    console.log(
      JSON.stringify({
        suite: "actual-native-host-run-worker-server",
        passed: true,
        workerLinkRunObservations: true,
        typedNodeProvider: true,
        typedCargoProvider: true,
        typedDartProvider: true,
        typedFlutterProvider: true,
        typedJavaProvider: true,
        nativeCliBroker: Boolean(values.cli),
        protectedCliPolicies: Boolean(values.cli),
        protectedCliExplorer: Boolean(values.cli),
        realGradleSdk: Boolean(
          process.env.CANTRIP_TEST_GRADLE && process.env.CANTRIP_TEST_JDK_HOME,
        ),
        realFlutterSdkTask: Boolean(process.env.CANTRIP_TEST_FLUTTER_SDK),
        realDartSdk: Boolean(process.env.CANTRIP_TEST_DART_SDK),
        encryptedOutput: true,
        nodeDifferential: true,
        nodeAbsentFromWorkerPath: true,
      }),
    );
  else if (values["run-definitions-only"])
    console.log(
      JSON.stringify({
        suite: "actual-native-run-definitions-worker-server",
        passed: true,
        nodeDifferential: true,
        nodeAbsentFromWorkerPath: true,
      }),
    );
  else if (values["binary-writes-only"])
    console.log(
      JSON.stringify({ suite: "native-Host-binary-saves", passed: true }),
    );
  else if (values["file-imports-only"])
    console.log(
      JSON.stringify({ suite: "native-Host-Explorer-imports", passed: true }),
    );
  else if (values["shares-only"])
    console.log(
      JSON.stringify({ suite: "native-worker-webdav-shares", passed: true }),
    );
  else if (values["terminal-relay-only"])
    console.log(
      JSON.stringify({
        suite: "actual-native-host-terminal-worker-server",
        passed: true,
        encryptedHostTerminalRelay: true,
        encryptedWorkerLinkTerminal: true,
        encryptedDirectTerminal: Boolean(values["terminal-direct-broker"]),
        protectedCliTerminal: Boolean(values.cli),
        nativeCliBroker: Boolean(values.cli),
        encryptedServiceRelayAcrossRestarts: true,
        realTerminalServiceEnableRestartAndRecovery: true,
        nodeAbsentFromWorkerPath: true,
      }),
    );
  else if (replicaCoverage)
    console.log(
      JSON.stringify({
        suite: values["replica-lifecycle-only"]
          ? "actual-native-replica-lifecycle-worker-server"
          : "actual-native-replica-provision-worker-server",
        passed: true,
        realWorkerAndServer: true,
        nodeAbsentFromWorkerPath: true,
        ...replicaCoverage,
      }),
    );
  else if (githubCoverage)
    console.log(
      JSON.stringify({
        suite: values["github-operations-only"]
          ? "actual-native-github-operations-worker-server"
          : values["pull-request-lifecycle-only"]
            ? "actual-native-pull-request-lifecycle-worker-server"
            : values["pull-request-actions-only"]
              ? "actual-native-pull-request-actions-worker-server"
              : values["pull-request-only"]
                ? "actual-native-pull-request-worker-server"
                : values["github-issues-only"]
                  ? "actual-native-github-issues-worker-server"
                  : "actual-native-github-catalog-worker-server",
        passed: true,
        realWorkerAndServer: true,
        nodeAbsentFromWorkerPath: true,
        ...githubCoverage,
      }),
    );
  else if (values["recovery-only"])
    console.log(
      JSON.stringify({
        suite: "actual-native-worktree-recovery-worker-server",
        passed: true,
        realWorkerAndServer: true,
        nodeAbsentFromWorkerPath: true,
        ...recoveryCoverage,
      }),
    );
  else if (codegraph)
    console.log(
      JSON.stringify({
        suite: "actual-native-codegraph-worker-server",
        passed: true,
      }),
    );
  else if (values["observations-only"])
    console.log(
      JSON.stringify({
        suite: "actual-native-observation-worker-server",
        passed: true,
        realWorkerAndServer: true,
        nodeAbsentFromWorkerPath: true,
        ...observationCoverage,
      }),
    );
  else
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
        surfaceGrantTerminalServiceReconciliation: true,
        realTerminalServiceEnableRestartAndRecovery: true,
        encryptedGitStatusAndDiff: true,
        encryptedGitActionsAndRestartGuard: true,
        encryptedGitHistoryAndInspection: true,
        encryptedManagedGitRecoveryAndRestart: true,
        nativeRebaseEditorWithoutNode: true,
        encryptedManagedGitPreviewAndStart: true,
        encryptedGitConflictResolutionAndContinue: true,
        encryptedReviewedCommitMutationsAndRecovery: true,
        encryptedStashSelectionsAndRecovery: true,
        encryptedPartialPatchSelectionsAndRestart: true,
        encryptedReviewedBranchesAndLocalRemote: true,
        encryptedReviewedRemotesDefaultsFetchAndPrune: true,
        encryptedReviewedTagsAndImmutableSignatures: true,
        encryptedReviewedNestedSubmodulesAndRecovery: true,
        encryptedReviewedLfsObjectsAndLocks: true,
        encryptedGitGraphMetricsBlameAndOverlays: true,
        completedGitRuntimeChecks: gitRuntimeCoverage.completedRuntimeChecks,
        nativeWorktreeApiLifecycleAndEncryptedStatus: true,
        nodeAbsentFromWorkerPath: true,
        scope:
          "Fresh attachment, discovery/import, managed/existing folders, encrypted host Explorer/file-document, Git queries/basic actions and managed recovery with native rebase editors, and host terminal-service lifecycle; other worker domains remain pending.",
      }),
    );
} catch (error) {
  failure = error;
} finally {
  master?.fill(0);
  componentKey?.fill(0);
  surfaceKey?.fill(0);
  const errors = [];
  for (const close of [
    stopWorker,
    () => server?.close(),
    () => rm(root, { recursive: true, force: true }),
  ]) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    if (failure)
      console.error(
        "Owned fixture cleanup errors",
        errors.map((error) => error.message),
      );
    else failure = new AggregateError(errors, "Owned fixture cleanup failed");
  }
  if (previousGitProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
  else process.env.GIT_ALLOW_PROTOCOL = previousGitProtocol;
}
if (failure) throw failure;
