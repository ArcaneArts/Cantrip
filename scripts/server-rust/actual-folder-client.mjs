// Existing browser encryption/project APIs -> real server -> full built worker.
// Filesystem assertions inspect only disposable test directories. No transport,
// command handler, crypto adapter or repository implementation is substituted.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { createPasswordKdfParameters } from "../../packages/crypto/src/index.ts";
import { loadStoredWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { deriveManagedFolderLocation } from "../../cantrip_worker/src/managed-folders.ts";
import { normalizeProjectSourcePath } from "../../cantrip_worker/src/project-source-path.ts";
import { buildRustServer, buildWorkerCli, repositoryRoot } from "./build.mjs";
import { eventually, launchActualWorker } from "./full-worker.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { password } from "./security-fixtures.mjs";

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-actual-folder-"));
const appRoot = path.join(repositoryRoot, "cantrip_app");
const appRequire = createRequire(path.join(appRoot, "package.json"));
const { createServer } = await import(
  pathToFileURL(appRequire.resolve("vite")).href
);
const report = {
  suite: "actual-browser-server-worker-folders",
  databaseMode,
  completeReplacement: false,
  scope:
    "Existing browser account encryption, project and protected repository APIs; full worker startup, real managed/existing folders, failure/retry, reconnect and retained server state. Not whole UI, packaging, project worktree routes or multi-instance acceptance.",
  runtimes: [],
};
let vite, browser, postgres, failure;
async function flow(fixture, result, cliBinary) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [],
    requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      pathname.startsWith("/api/projects") ||
      pathname.endsWith("/repository-operation") ||
      pathname.endsWith("/encryption/refresh")
    )
      requests.push({
        method: request.method(),
        pathname,
        body: request.postData(),
      });
  });
  const dataDirectory = path.join(root, fixture.kind, "worker");
  const existingPath = path.join(root, fixture.kind, "private-existing-folder");
  const missingPath = path.join(root, fixture.kind, "private-repaired-folder");
  const workerId = "actual-folder-worker";
  let worker;
  const startWorker = async (enrollmentCode) => {
    worker = launchActualWorker(fixture, dataDirectory, {
      cliBinary,
      enrollmentCode,
      workerId,
    });
    await worker.ready();
  };
  const stopWorker = async () => {
    if (!worker) return;
    const current = worker;
    worker = undefined;
    result.workerStops.push(await current.close());
    result.workerDiagnostics.push(current.diagnostics());
  };
  const workers = () => page.evaluate(() => window.folderWorkers.getWorkers());
  const job = (id) =>
    page.evaluate((id) => window.folderApi.getProjectFolderSetupJob(id), id);
  const waitJob = (id, state) =>
    eventually(
      () => job(id),
      (job) => assert.equal(job.state, state),
    );
  const create = (name, existingPath) =>
    page.evaluate(
      ({ name, existingPath, workerId }) =>
        window.folderCrypto.createManagedFolderProject({
          name,
          workerId,
          ...(existingPath ? { existingPath } : {}),
        }),
      { name, existingPath, workerId },
    );
  const watch = async (id) => {
    await page.evaluate(
      (id) =>
        window.folderLive.retainScope({ kind: "project", projectId: id }) &&
        undefined,
      id,
    );
    await eventually(
      () => page.evaluate(() => window.folderLive.snapshot()),
      (snapshot) => {
        assert.equal(snapshot.status, "live");
        assert.equal(snapshot.activeScopeCount, snapshot.desiredScopeCount);
      },
    );
  };
  const filesystem = async (id) => {
    const target = deriveManagedFolderLocation(dataDirectory, id).target;
    assert.equal((await stat(target)).isDirectory(), true);
    return normalizeProjectSourcePath(await realpath(target));
  };
  const openedProject = async (id, name, actualPath) => {
    const projects = await page.evaluate(() =>
      window.folderCrypto.getProjects(),
    );
    const project = projects.find((project) => project.id === id);
    (result.openedProjects ??= []).push(project);
    assert.ok(project);
    assert.equal(project.name, name);
    assert.equal(project.setupStatus, "ready");
    assert.equal(project.source.path, actualPath);
    assert.equal(project.source.sourceKind, "folder");
    return project;
  };
  try {
    await mkdir(existingPath, { recursive: true });
    await writeFile(
      path.join(existingPath, "retained.txt"),
      "Existing user file remains intact.\n",
    );
    await page.goto(vite.resolvedUrls.local[0] + "__actual_folder_fixture");
    const enrollment = await page.evaluate(
      async ({ serverUrl, password, passwordKdf, workerId }) => {
        const servers = await import("/src/lib/server-connections.ts");
        const account = await import("/src/lib/api/account.ts");
        const session = await import("/src/lib/client-session.ts");
        window.folderWorkers = await import("/src/lib/api/worker-wire.ts");
        window.folderApi = await import("/src/lib/api/project-replicas.ts");
        window.folderWire = await import("/src/lib/api/projects.ts");
        window.folderCrypto = await import("/src/lib/project-encryption.ts");
        window.folderRequest = (await import("/src/lib/api-client.ts")).request;
        await servers.initializeServerConnections();
        const saved = await servers.saveServerConnection({
          name: "Disposable folder server",
          url: serverUrl,
        });
        await servers.selectServerConnection(saved.id);
        const bootstrap = await account.getServerBootstrap();
        const registered = await account.registerAccount({
          email: "folders@example.invalid",
          displayName: "Private folder owner",
          password,
        });
        session.setClientSession({
          authMode: "accounts",
          serverId: bootstrap.server.id,
          user: registered.currentUser,
          csrfToken: registered.csrfToken,
          expiresAt: registered.expiresAt,
        });
        window.folderIdentity = {
          ownerId: registered.currentUser.id,
          serverId: bootstrap.server.id,
        };
        const { prepareClientEncryption } =
          await import("/src/lib/account-encryption.ts");
        const access = await prepareClientEncryption({
          authMode: "accounts",
          identity: window.folderIdentity,
          password,
          passwordKdf,
        });
        if (access.status !== "ready")
          throw new Error(
            "Browser encryption did not initialize: " + access.status,
          );
        const { AppLiveClient, appLiveWebSocketUrl } =
          await import("/src/lib/app-live-client.ts");
        window.folderEvents = [];
        window.folderLive = new AppLiveClient({
          client: {
            id: "actual-folder-browser",
            name: "Folder acceptance",
            version: "1",
          },
          storage: localStorage,
          storageKey: "actual-folder-resume",
          url: appLiveWebSocketUrl(serverUrl, location.origin),
          onEvent: (event) => window.folderEvents.push(event),
          onResync: async () => {
            await window.folderWire.getProjectWireList();
          },
        });
        window.folderLive.retainScope({ kind: "current-user" });
        window.folderLive.start();
        return (
          await import("/src/lib/api/workers.ts")
        ).createWorkerEnrollmentCode({
          label: workerId,
          expiresInSeconds: 300,
        });
      },
      {
        serverUrl: fixture.server.origin,
        password,
        workerId,
        passwordKdf: createPasswordKdfParameters({
          memoryKiB: 8192,
          iterations: 1,
        }),
      },
    );
    result.steps.push(
      "existing browser initializes account, session and durable endpoint encryption",
    );
    await startWorker(enrollment.code);
    await eventually(workers, (workers) => {
      assert.equal(workers.length, 1);
      assert.equal(workers[0].workerId, workerId);
      assert.equal(workers[0].online, true);
      assert.equal(workers[0].managedFolders.attachExisting, true);
      assert.ok(workers[0].encryption.principalId);
    });
    result.steps.push(
      "full worker enrolls, advertises folder capabilities and registers encryption principal",
    );
    const credential = loadStoredWorkerCredential(
      dataDirectory,
      fixture.server.origin,
    );
    assert.ok(credential);
    const names = [
      "Private fresh 🍄 folder",
      "Private attached 🌲 folder",
      "Private repaired 🌙 folder",
      "Private resumed 🌤 folder",
    ];
    const created = await create(names[0]);
    assert.equal(created.name, names[0]);
    const firstJob = await waitJob(created.id, "succeeded");
    assert.equal(firstJob.attempt, 1);
    const first = await openedProject(
      created.id,
      names[0],
      await filesystem(created.id),
    );
    assert.equal(first.source.ownershipKind, "cantrip");
    assert.equal(
      result.workerStops.length,
      0,
      "the first repository operation needs no worker restart",
    );
    assert.ok(
      requests.some(
        (request) =>
          request.pathname.endsWith("/encryption/refresh") &&
          JSON.parse(request.body).component === "repository-content",
      ),
      "existing browser repository API authorizes and refreshes its key",
    );
    assert.deepEqual(
      loadStoredWorkerCredential(dataDirectory, fixture.server.origin),
      credential,
    );
    result.steps.push(
      "existing browser repository flow authorizes and refreshes its grant without restarting the worker",
    );
    result.steps.push(
      "existing project client encrypts label and full worker creates a real managed directory",
    );
    const attached = await create(names[1], existingPath);
    await waitJob(attached.id, "succeeded");
    const opened = await openedProject(
      attached.id,
      names[1],
      normalizeProjectSourcePath(await realpath(existingPath)),
    );
    assert.equal(opened.folderManagement, "external");
    // Source summaries retain the existing source-row ownership default;
    // external folder management is separately recorded on the project/root.
    assert.equal(opened.source.ownershipKind, "cantrip");
    assert.equal(
      await readFile(path.join(existingPath, "retained.txt"), "utf8"),
      "Existing user file remains intact.\n",
    );
    result.steps.push(
      "actual protected repository operations attach existing folder and preserve its user file",
    );
    const repaired = await create(names[2], missingPath);
    const failed = await waitJob(repaired.id, "failed");
    assert.deepEqual(failed.error, {
      code: "existing-path-missing",
      retryable: false,
    });
    await watch(repaired.id);
    await mkdir(missingPath);
    await page.evaluate(
      ({ id, revision }) =>
        window.folderApi.retryProjectFolderSetup(id, revision),
      { id: repaired.id, revision: failed.stateRevision },
    );
    const retried = await waitJob(repaired.id, "succeeded");
    assert.equal(retried.attempt, 2);
    await openedProject(
      repaired.id,
      names[2],
      normalizeProjectSourcePath(await realpath(missingPath)),
    );
    await eventually(
      () => page.evaluate(() => window.folderEvents),
      (events) => {
        assert.deepEqual(
          events
            .filter(
              (event) =>
                event.scope.projectId === repaired.id &&
                event.resource === "project-folder-setup-job",
            )
            .map((event) => event.revision),
          [4, 6],
        );
      },
    );
    result.steps.push(
      "real missing-path failure is retained and explicit browser retry succeeds after worker path repair",
    );
    await stopWorker();
    await eventually(workers, (workers) =>
      assert.equal(workers[0].online, false),
    );
    const resumed = await create(names[3]);
    const blocked = await waitJob(resumed.id, "blocked");
    assert.deepEqual(blocked.error, {
      code: "worker-offline",
      retryable: true,
    });
    await watch(resumed.id);
    await startWorker();
    const completed = await waitJob(resumed.id, "succeeded");
    assert.equal(completed.attempt, 2);
    await openedProject(resumed.id, names[3], await filesystem(resumed.id));
    await eventually(
      () => page.evaluate(() => window.folderEvents),
      (events) =>
        assert.ok(
          events.some(
            (event) =>
              event.resource === "worktree" &&
              event.scope.projectId === resumed.id,
          ),
        ),
    );
    result.steps.push(
      "offline folder job resumes on actual worker reconnect and existing AppLiveClient receives completion",
    );
    const wire = await page.evaluate(() =>
      window.folderWire.getProjectWireList(),
    );
    assert.equal(wire.length, 4);
    for (const project of wire) {
      assert.match(project.source.path, /^ctrr_[A-Za-z0-9_-]{43}$/);
      assert.match(project.source.displayPath, /^ctrr_[A-Za-z0-9_-]{43}$/);
      assert.equal(project.nameProtection.classification.recordKind, "project");
      assert.equal(project.nameProtection.protectedLabel.formatVersion, 1);
      assert.equal(
        project.nameProtection.protectedLabel.envelope.algorithm,
        "AES-256-GCM",
      );
      assert.equal(project.name, undefined);
    }
    const publicRequests = JSON.stringify(requests);
    for (const secret of [...names, existingPath, missingPath, dataDirectory])
      assert.equal(
        publicRequests.includes(secret),
        false,
        "server requests must retain endpoint opacity",
      );
    result.steps.push(
      "server receives opaque labels, encrypted repository operations and routing handles without private names or paths",
    );
    await stopWorker();
    await page.evaluate(() => window.folderLive.stop());
    await fixture.close();
    await fixture.start();
    const retained = await page.evaluate(
      async ({ serverUrl, password }) => {
        const servers = await import("/src/lib/server-connections.ts");
        const account = await import("/src/lib/api/account.ts");
        const session = await import("/src/lib/client-session.ts");
        const saved = await servers.saveServerConnection({
          name: "Retained folder server",
          url: serverUrl,
        });
        await servers.selectServerConnection(saved.id);
        const current = await account.getAuthSession();
        const bootstrap = await account.getServerBootstrap();
        session.setClientSession({
          authMode: "accounts",
          serverId: bootstrap.server.id,
          user: current.currentUser,
          csrfToken: current.csrfToken,
          expiresAt: current.expiresAt,
        });
        if (
          bootstrap.server.id !== window.folderIdentity.serverId ||
          current.currentUser.id !== window.folderIdentity.ownerId
        )
          throw new Error("Retained server/account identity changed");
        const { prepareClientEncryption } =
          await import("/src/lib/account-encryption.ts");
        const access = await prepareClientEncryption({
          authMode: "accounts",
          identity: window.folderIdentity,
          password,
        });
        if (access.status !== "ready")
          throw new Error("Retained encryption was not ready");
        const projects = await window.folderWire.getProjectWireList();
        const { decodePrivateDisplayLabelForClient } =
          await import("/src/lib/private-label-encryption.ts");
        const labels = await Promise.all(
          projects.map((project) =>
            decodePrivateDisplayLabelForClient({
              identity: window.folderIdentity,
              opaque: project.nameProtection,
              recordKind: "project",
              rowId: project.id,
            }),
          ),
        );
        return { projects, labels };
      },
      { serverUrl: fixture.server.origin, password },
    );
    assert.deepEqual(retained.projects, wire);
    assert.deepEqual(retained.labels, names);
    for (const project of retained.projects)
      assert.equal((await job(project.id)).state, "succeeded");
    result.steps.push(
      "server restart retains identity, encrypted labels, source handles and all completed job states",
    );
    result.projects = wire.map((project) => ({
      originKind: project.originKind,
      setupStatus: project.setupStatus,
      ownershipKind: project.source.ownershipKind,
      capabilities: project.capabilities,
    }));
    result.requests = requests;
    result.events = await page.evaluate(() => window.folderEvents);
    assert.deepEqual(errors, []);
  } finally {
    await stopWorker();
    await page.evaluate(() => window.folderLive?.stop()).catch(() => {});
    await context.close();
  }
}
try {
  const executable = await buildRustServer();
  const cliBinary = await buildWorkerCli();
  vite = await createServer({
    root: appRoot,
    configFile: path.join(appRoot, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    plugins: [
      {
        name: "actual-folder-client",
        configureServer(server) {
          server.middlewares.use(
            "/__actual_folder_fixture",
            (_request, response) => {
              response.setHeader("content-type", "text/html");
              response.end(
                "<!doctype html><html><title>Actual folder client</title><body>Disposable folder acceptance</body></html>",
              );
            },
          );
        },
      },
    ],
  });
  await vite.listen();
  browser = await chromium.launch({ headless: true });
  if (databaseMode !== "pglite")
    postgres = await postgresFixture(path.join(root, "postgres"));
  for (const kind of ["node", "rust"]) {
    const fixture = new HttpFixture({
      kind,
      executable,
      root,
      name: "actual-folder",
      databaseMode,
      providerAuthDrain: true,
      environment: {
        CANTRIP_AUTH_MODE: "accounts",
        CANTRIP_APP_ORIGINS: `http://127.0.0.1:5173,${new URL(vite.resolvedUrls.local[0]).origin}`,
      },
    });
    if (postgres) {
      if (kind === "node" || databaseMode === "postgres")
        fixture.environment.DATABASE_URL = await postgres.database();
      else
        fixture.environment.CANTRIP_POSTGRES_BIN_DIR =
          process.env.CANTRIP_TEST_POSTGRES_BIN_DIR;
    }
    const result = { kind, steps: [], workerStops: [], workerDiagnostics: [] };
    report.runtimes.push(result);
    try {
      await fixture.start();
      await flow(fixture, result, cliBinary);
    } finally {
      await fixture.close();
    }
  }
  assert.deepEqual(report.runtimes[1].steps, report.runtimes[0].steps);
  assert.deepEqual(report.runtimes[1].projects, report.runtimes[0].projects);
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await browser?.close();
  await vite?.close();
  await postgres?.close();
  await rm(root, { recursive: true, force: true });
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(
    JSON.stringify({
      suite: report.suite,
      databaseMode,
      runtimes: report.runtimes.map((runtime) => ({
        kind: runtime.kind,
        steps: runtime.steps.length,
        stoppedWorkers: runtime.workerStops.length,
      })),
      ...(failure ? { failure: report.failure } : {}),
    }),
  );
}
if (failure) throw failure;
