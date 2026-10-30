import { actualProjectWorktrees } from "./actual-project-worktrees.mjs";
import {
  actualWorkerProjectSurfaces,
  retainedWorkerProjectSurfaces,
} from "./actual-worker-project-surfaces.mjs";
// Existing browser encryption/project APIs -> real server -> full built worker.
// Filesystem assertions inspect only disposable test directories. No transport,
// command handler, crypto adapter or repository implementation is substituted.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  actualProjectGitViews,
  retainedProjectGitViews,
} from "./actual-project-git-views.mjs";
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
import {
  buildRustServer,
  buildRustExample,
  buildWorkerCli,
  buildDesktopDirectProbe,
  repositoryRoot,
} from "./build.mjs";
import { eventually, launchActualWorker } from "./full-worker.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { password } from "./security-fixtures.mjs";
import { actualTerminalServices } from "./actual-terminal-services.mjs";
import {
  actualWorkerFileDocuments,
  retainedWorkerFileDocument,
} from "./actual-worker-file-documents.mjs";
import {
  actualWorkspaceClient,
  retainedWorkspaceClient,
} from "./actual-workspace-client.mjs";
import { actualNativeDirectProbe } from "./actual-native-direct-probe.mjs";
import {
  prepareTunnelLink,
  seedTunnelLink,
  actualWorkerTunnelLink,
} from "./actual-worker-tunnel-link.mjs";
import { actualWorkerTunnelRelay } from "./actual-worker-tunnel-relay.mjs";
import { actualWorkerBrowserDiscovery } from "./actual-worker-browser-discovery.mjs";
import {
  prepareProjectShares,
  prepareExistingScratch,
  seedExistingScratch,
  finishProjectShares,
  liveWorkerShareRestart,
} from "./actual-worker-project-shares.mjs";
import {
  prepareBrowserSurface,
  actualWorkerBrowserSurface,
} from "./actual-worker-browser-surface.mjs";

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const workerLinkRoute = option("--worker-link-route") ?? "relay";
const reportPath = option("--report");
const surfaceFixtureRequests = [];
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
    "Existing browser account encryption, project and protected repository APIs; full worker startup, real managed/existing folders, failure/retry, reconnect and retained server state. Optional --worktrees exercises actual local Git create/lock/unlock/reconcile/remove/prune, retained identity and real Run process retirement before deletion, with only disposable catalog classification seeded. Not whole UI, packaging or multi-instance acceptance.",
  runtimes: [],
};
let vite, browser, postgres, failure, surfaceRepositoryBinary;
async function flow(
  fixture,
  result,
  cliBinary,
  nativeProbeBinary,
  directBrokerBinary,
) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [],
    requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      pathname.startsWith("/api/projects") ||
      pathname.startsWith("/api/chats/") ||
      pathname.startsWith("/api/tunnel") ||
      pathname.startsWith("/api/project-shares/") ||
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
  let worker, tunnel;
  const startWorker = async (enrollmentCode) => {
    worker = launchActualWorker(fixture, dataDirectory, {
      cliBinary,
      enrollmentCode,
      workerId,
      ...(process.argv.includes("--surfaces")
        ? {
            chromiumExecutable: chromium.executablePath(),
            chromiumTraceDirectory: path.resolve(".qa/rust-server"),
          }
        : {}),
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
  const openedProject = async (id, name, actualPath, sourceKind = "folder") => {
    const projects = await page.evaluate(() =>
      window.folderCrypto.getProjects(),
    );
    const project = projects.find((project) => project.id === id);
    (result.openedProjects ??= []).push(project);
    assert.ok(project);
    assert.equal(project.name, name);
    assert.equal(project.setupStatus, "ready");
    assert.equal(project.source.path, actualPath);
    assert.equal(project.source.sourceKind, sourceKind);
    return project;
  };
  try {
    await mkdir(existingPath, { recursive: true });
    await writeFile(
      path.join(existingPath, "retained.txt"),
      "Existing user file remains intact.\n",
    );
    if (
      process.argv.includes("--project-surfaces") ||
      process.argv.includes("--worktrees")
    ) {
      execFileSync("git", ["init", "--initial-branch=main", existingPath]);
      execFileSync("git", ["-C", existingPath, "add", "retained.txt"]);
      execFileSync("git", [
        "-C",
        existingPath,
        "-c",
        "user.name=Cantrip Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "Disposable fixture",
      ]);
    }
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
    if (process.argv.includes("--tunnels"))
      await page.evaluate(async (workerId) => {
        await (
          await import("/src/lib/api/tunnels.ts")
        ).ensureTunnelWorker(workerId);
      }, workerId);
    result.steps.push(
      "full worker enrolls, advertises folder capabilities and registers encryption principal",
    );
    const credential = loadStoredWorkerCredential(
      dataDirectory,
      fixture.server.origin,
    );
    assert.ok(credential);
    if (nativeProbeBinary)
      await actualNativeDirectProbe({
        page,
        workerId,
        binary: nativeProbeBinary,
        result,
      });
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
      process.argv.includes("--project-surfaces") ||
        process.argv.includes("--worktrees")
        ? "git"
        : "folder",
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
    if (
      process.argv.includes("--terminals") ||
      process.argv.includes("--terminal-direct")
    )
      await actualTerminalServices({
        page,
        projectId: created.id,
        directory: await filesystem(created.id),
        workerId,
        startWorker,
        stopWorker,
        result,
        workerLinks: process.argv.includes("--worker-links"),
        workerLinkRoute,
        directBrokerBinary,
      });
    // The preceding terminal offline case intentionally stops the worker.
    // Subsequent document/browser flows use the worker through the public API.
    if (
      (process.argv.includes("--surfaces") ||
        process.argv.includes("--project-shares") ||
        process.argv.includes("--file-documents") ||
        process.argv.includes("--workspaces") ||
        process.argv.includes("--project-surfaces")) &&
      !worker
    )
      await startWorker();
    const fileDocuments =
      process.argv.includes("--file-documents") ||
      process.argv.includes("--workspaces")
        ? await actualWorkerFileDocuments({
            page,
            projectId: created.id,
            workerId,
            directory: await filesystem(created.id),
            result,
          })
        : undefined;
    const projectSurfaces = process.argv.includes("--project-surfaces")
      ? await actualWorkerProjectSurfaces({
          page,
          projectId: created.id,
          workerId,
          directory: await filesystem(created.id),
          result,
        })
      : undefined;
    const gitView = projectSurfaces
      ? await actualProjectGitViews({ page, projectId: attached.id, result })
      : undefined;
    const workspace = process.argv.includes("--workspaces")
      ? await actualWorkspaceClient({ page, document: fileDocuments, result })
      : undefined;
    const surface = process.argv.includes("--surfaces")
      ? await prepareBrowserSurface(
          page,
          vite.resolvedUrls.local[0],
          created.id,
          workerId,
        )
      : undefined;
    if (surface) {
      result.steps.push(
        "existing client creates a browser with encrypted title and state through the product route",
      );
      // The production OS scan must finish before opening the later tunnel's
      // exact-payload peer, which deliberately records every received byte.
      await actualWorkerBrowserDiscovery({ page, surface, workerId, result });
    }
    if (process.argv.includes("--tunnels"))
      tunnel = await prepareTunnelLink(page, created.id, workerId);
    const projectShares = process.argv.includes("--project-shares")
      ? await prepareProjectShares({
          page,
          project: first,
          workerId,
          result,
          requests,
        })
      : undefined;
    // Capture after browser creation has committed its project layout update.
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
    for (const secret of [
      ...names,
      existingPath,
      missingPath,
      dataDirectory,
      ...(surface
        ? [surface.token, surface.url, "Private WorkerLink browser"]
        : []),
    ])
      assert.equal(
        publicRequests.includes(secret),
        false,
        "server requests must retain endpoint opacity",
      );
    result.steps.push(
      "server receives opaque labels, encrypted repository operations and routing handles without private names or paths",
    );
    await stopWorker();
    const scratch = projectShares
      ? await prepareExistingScratch(dataDirectory)
      : undefined;
    await page.evaluate(() => window.folderLive.stop());
    const retainedPort =
      surface ||
      tunnel ||
      projectShares ||
      fileDocuments ||
      projectSurfaces ||
      process.argv.includes("--worktrees")
        ? Number(new URL(fixture.server.origin).port)
        : 0;
    // Retain a generous diagnostic deadline for both implementations. Earlier
    // reference runs retained a zero-byte connection beyond this whole window;
    // production idle-connection cleanup now has separate real-socket tests.
    // Record actual duration instead of treating the deadline as an observed timeout.
    const shutdownStarted = Date.now();
    await fixture.close({ shutdownTimeoutMs: 105000 });
    result.serverRestartShutdownMs = Date.now() - shutdownStarted;
    if (tunnel)
      await seedTunnelLink(fixture, root, surfaceRepositoryBinary, tunnel);
    if (scratch)
      await seedExistingScratch({
        fixture,
        root,
        executable: surfaceRepositoryBinary,
        page,
        scratch,
        workerId,
      });
    await fixture.start({ port: retainedPort });
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
    if (workspace) await retainedWorkspaceClient({ page, workspace, result });
    if (
      surface ||
      tunnel ||
      projectShares ||
      fileDocuments ||
      projectSurfaces
    ) {
      await startWorker();
      if (projectSurfaces)
        await retainedWorkerProjectSurfaces({
          page,
          surface: projectSurfaces,
          result,
        });
      if (gitView)
        await retainedProjectGitViews({ page, view: gitView, result });
      if (fileDocuments)
        await retainedWorkerFileDocument({
          page,
          workerId,
          document: fileDocuments,
          result,
        });
      if (surface)
        await actualWorkerBrowserSurface({
          page,
          surface,
          workerId,
          result,
          route: workerLinkRoute,
        });
      if (tunnel)
        await actualWorkerTunnelLink({
          page,
          tunnel,
          result,
          route: workerLinkRoute,
        });
      if (tunnel)
        await actualWorkerTunnelRelay({ page, tunnel, result, fixture });
      if (projectShares)
        await finishProjectShares({
          page,
          prepared: projectShares,
          scratch,
          result,
          requests,
        });
      if (projectShares)
        await liveWorkerShareRestart({
          page,
          fixture,
          project: first,
          workerId,
          worker,
          result,
          requests,
        });
      await stopWorker();
    }
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
    if (process.argv.includes("--worktrees"))
      await actualProjectWorktrees({
        page,
        fixture,
        root,
        executable: surfaceRepositoryBinary,
        projectId: attached.id,
        directory: normalizeProjectSourcePath(await realpath(existingPath)),
        startWorker,
        stopWorker,
        result,
      });
    result.requests = requests;
    result.events = await page.evaluate(() => window.folderEvents);
    assert.deepEqual(errors, []);
  } finally {
    await stopWorker();
    await tunnel?.close();
    await page.evaluate(() => window.folderLive?.stop()).catch(() => {});
    await context.close();
  }
}
try {
  const executable = await buildRustServer();
  if (
    process.argv.includes("--surfaces") ||
    process.argv.includes("--tunnels") ||
    process.argv.includes("--project-shares") ||
    process.argv.includes("--worktrees")
  )
    surfaceRepositoryBinary = await buildRustExample(
      "project-repository-fixture",
    );
  const cliBinary = await buildWorkerCli();
  const nativeProbeBinary = process.argv.includes("--native-probe")
    ? await buildDesktopDirectProbe()
    : undefined;
  const directBrokerBinary = process.argv.includes("--terminal-direct")
    ? await buildRustExample("desktop-direct-broker")
    : undefined;
  vite = await createServer({
    root: appRoot,
    configFile: path.join(appRoot, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    plugins: [
      {
        name: "actual-folder-client",
        configureServer(server) {
          server.middlewares.use(
            "/__actual_surface_fixture",
            (request, response) => {
              surfaceFixtureRequests.push({
                path: request.url,
                method: request.method,
                at: Date.now(),
              });
              response.setHeader("content-type", "text/html");
              response.end(
                "<!doctype html><html><body style='background:linear-gradient(45deg,#f82,#28f);height:100vh'><h1>Private remote browser</h1><script>const n=Number(sessionStorage.loads||0)+1;sessionStorage.loads=n;document.title=location.pathname.split('/').pop()+':'+n;</script></body></html>",
              );
            },
          );
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
        ...(process.argv.includes("--worker-links")
          ? workerLinkRoute === "relay"
            ? { CANTRIP_WORKER_LINK_RELAY_ONLY: "true" }
            : {
                CANTRIP_WORKER_LINK_RELAY_ONLY: "false",
                CANTRIP_WORKER_LINK_LOCAL_ENABLED: "false",
                CANTRIP_WORKER_LINK_LAN_ENABLED: "true",
                CANTRIP_WORKER_LINK_WAN_ENABLED: "false",
              }
          : {}),
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
      await flow(
        fixture,
        result,
        cliBinary,
        nativeProbeBinary,
        directBrokerBinary,
      );
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
  if (failure) {
    report.fixtureRoot = root;
    console.error("Retained failed full-worker fixture:", root);
  } else await rm(root, { recursive: true, force: true });
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    report.surfaceFixtureRequests = surfaceFixtureRequests;
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
