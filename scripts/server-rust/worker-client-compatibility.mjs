// Real Chromium runs the unchanged app API modules against each server. The
// unchanged worker enrollment, heartbeat, transport and credential store run
// with a controlled command handler; this is not whole-worker runtime coverage.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { enrollWorker } from "../../cantrip_worker/src/enrollment.ts";
import {
  createHeartbeat,
  sendHeartbeat,
} from "../../cantrip_worker/src/heartbeat.ts";
import {
  loadStoredWorkerCredential,
  saveWorkerCredential,
} from "../../cantrip_worker/src/credential-store.ts";
import { buildRustServer, repositoryRoot } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { heartbeat, password } from "./security-fixtures.mjs";

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(databaseMode));
const appRoot = path.join(repositoryRoot, "cantrip_app");
const appRequire = createRequire(path.join(appRoot, "package.json"));
const { createServer } = await import(appRequire.resolve("vite"));
const executable =
  process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
const root = await mkdtemp(path.join(tmpdir(), "cantrip-worker-client-"));
const report = {
  schemaVersion: 1,
  suite: "browser-worker-control-integration",
  databaseMode,
  completeReplacement: false,
  scope:
    "Unchanged browser API modules, worker enrollment/heartbeat/WorkerConnection/credential store; controlled credential-rotation command handler. Full app UI and full worker index/runtime are not covered.",
  runtimes: [],
};
let vite, browser, postgresOwner, failure;

async function eventually(read, check) {
  const expires = Date.now() + 15000;
  while (true) {
    const value = await read();
    try {
      check(value);
      return value;
    } catch (error) {
      if (Date.now() >= expires) throw error;
    }
    await delay(20);
  }
}
async function flow(fixture) {
  const context = await browser.newContext(),
    page = await context.newPage();
  const errors = [],
    background = new Set(),
    connections = [];
  let connection;
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${vite.resolvedUrls.local[0]}__worker_client_fixture`);
    const enrollment = await page.evaluate(
      async ({ serverUrl, password }) => {
        const servers = await import("/src/lib/server-connections.ts");
        const account = await import("/src/lib/api/account.ts");
        const session = await import("/src/lib/client-session.ts");
        const workers = await import("/src/lib/api/workers.ts");
        await servers.initializeServerConnections();
        const saved = await servers.saveServerConnection({
          name: "Disposable Rust compatibility server",
          url: serverUrl,
        });
        await servers.selectServerConnection(saved.id);
        const bootstrap = await account.getServerBootstrap();
        const registered = await account.registerAccount({
          email: "browser-worker@example.invalid",
          displayName: "Actual browser worker owner",
          password,
        });
        session.setClientSession({
          authMode: "accounts",
          serverId: bootstrap.server.id,
          user: registered.currentUser,
          csrfToken: registered.csrfToken,
          expiresAt: registered.expiresAt,
        });
        const authenticated = await account.getAuthSession();
        if (authenticated.currentUser?.id !== registered.currentUser.id)
          throw new Error(
            "Browser cookie session did not survive registration",
          );
        window.workerFixtureApi = workers;
        window.workerFixtureRequest = (
          await import("/src/lib/api-client.ts")
        ).request;
        return workers.createWorkerEnrollmentCode({
          label: "Actual browser enrollment",
          expiresInSeconds: 300,
        });
      },
      { serverUrl: fixture.server.origin, password },
    );
    const config = {
      dataDirectory: path.join(
        fixture.environment.CANTRIP_DATA_DIR,
        "controlled-worker",
      ),
      name: "Actual WorkerConnection fixture",
      serverUrl: fixture.server.origin,
      enrollmentCode: enrollment.code,
      replacement: null,
      token: "",
      tokenSource: "enrollment",
      workerId: "client-transport-worker",
    };
    const workerHeartbeat = createHeartbeat(
      config,
      heartbeat.codexRuntime,
      new Date().toISOString(),
    );
    await enrollWorker(config, workerHeartbeat);
    assert.equal(config.enrollmentCode, null);
    assert.equal(config.tokenSource, "persisted");
    const initialToken = config.token;
    assert.equal(
      loadStoredWorkerCredential(config.dataDirectory, config.serverUrl)
        .credential,
      initialToken,
    );
    await sendHeartbeat(config, workerHeartbeat);
    function connect() {
      return new WorkerConnection(
        config,
        async (command) => {
          if (command.type !== "worker.credential.rotate") {
            background.add(command.type);
            throw new Error(
              "Controlled worker does not implement this resource domain.",
            );
          }
          // The credential command handler has the same persistence/update order
          // as cantrip_worker/src/index.ts; all transport behavior is unmodified.
          saveWorkerCredential({
            credential: command.credential,
            dataDirectory: config.dataDirectory,
            serverUrl: config.serverUrl,
            workerId: config.workerId,
          });
          config.token = command.credential;
          config.tokenSource = "persisted";
          return { accepted: true };
        },
        undefined,
        undefined,
        undefined,
        1000,
        (generation) => connections.push(generation),
      );
    }
    connection = connect();
    connection.start();
    await eventually(
      () => connections.length,
      (value) => assert.equal(value, 1),
    );
    const rotation = await page.evaluate(
      async (workerId) =>
        window.workerFixtureApi.rotateWorkerCredential(workerId, {
          label: "Actual browser credential rotation",
        }),
      config.workerId,
    );
    assert.equal(rotation.delivered, true);
    assert.notEqual(rotation.credential, initialToken);
    assert.equal(config.token, rotation.credential);
    const persisted = loadStoredWorkerCredential(
      config.dataDirectory,
      config.serverUrl,
    );
    assert.equal(persisted.credential, rotation.credential);
    assert.equal(persisted.workerId, config.workerId);
    if (process.platform !== "win32")
      assert.equal(
        (await stat(path.join(config.dataDirectory, "worker-credential.json")))
          .mode & 0o777,
        0o600,
      );
    await eventually(
      () => connections.length,
      (value) => assert.equal(value, 2),
    );
    assert.equal(
      connections[0],
      connections[1],
      "Credential reconnect stays in the same server control-plane generation",
    );
    await sendHeartbeat(config, workerHeartbeat);
    await assert.rejects(
      sendHeartbeat({ ...config, token: initialToken }, workerHeartbeat),
      /HTTP 401/,
    );
    connection.close();
    config.token = persisted.credential;
    connection = connect();
    connection.start();
    await eventually(
      () => connections.length,
      (value) => assert.equal(value, 3),
    );
    const catalog = await page.evaluate(async () =>
      window.workerFixtureRequest("/api/workers"),
    );
    assert.equal(
      catalog.find((worker) => worker.workerId === config.workerId).online,
      true,
    );
    await page.evaluate(
      async ({ workerId, credentialId }) =>
        window.workerFixtureApi.revokeWorkerCredential(workerId, credentialId),
      {
        workerId: config.workerId,
        credentialId: rotation.credentialSummary.id,
      },
    );
    await eventually(
      () =>
        page.evaluate(async () => window.workerFixtureRequest("/api/workers")),
      (value) =>
        assert.equal(
          value.find((worker) => worker.workerId === config.workerId).online,
          false,
        ),
    );
    await assert.rejects(sendHeartbeat(config, workerHeartbeat), /HTTP 401/);
    const credentials = await page.evaluate(
      async (workerId) =>
        window.workerFixtureApi.getWorkerCredentials(workerId),
      config.workerId,
    );
    assert.equal(credentials.length, 2);
    assert.ok(credentials.every((credential) => !credential.active));
    assert.deepEqual(errors, []);
    return {
      passed: true,
      browser: "chromium",
      steps: [
        "real browser server profile and account registration",
        "cookie and CSRF session",
        "browser pairing code to unchanged worker enrollment",
        "persisted worker credential and real heartbeat",
        "authenticated ready via unchanged WorkerConnection",
        "browser rotation command delivered and acknowledged",
        "credential persisted and worker reconnects automatically",
        "old credential rejected",
        "new WorkerConnection resumes from stored credential",
        "browser revocation disconnects worker and rejects subsequent heartbeat",
      ],
      transportConnections: connections.length,
      backgroundResourceCommands: [...background].sort(),
    };
  } finally {
    connection?.close();
    await context.close();
  }
}
try {
  vite = await createServer({
    root: appRoot,
    configFile: path.join(appRoot, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    plugins: [
      {
        name: "rust-worker-client-fixture",
        configureServer(server) {
          server.middlewares.use(
            "/__worker_client_fixture",
            (_request, response) => {
              response.setHeader("content-type", "text/html");
              response.end(
                "<!doctype html><html><title>Worker client integration fixture</title><body>Disposable worker integration fixture</body></html>",
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
    postgresOwner = await postgresFixture(
      path.join(root, "reference-postgres"),
    );
  for (const kind of ["node", "rust"]) {
    const fixture = new HttpFixture({
      kind,
      executable,
      root,
      name: "browser-client",
      databaseMode,
      environment: {
        CANTRIP_AUTH_MODE: "accounts",
        CANTRIP_APP_ORIGINS: `http://127.0.0.1:5173,${new URL(vite.resolvedUrls.local[0]).origin}`,
      },
    });
    if (postgresOwner) {
      if (kind === "node" || databaseMode === "postgres")
        fixture.environment.DATABASE_URL = await postgresOwner.database();
      else
        fixture.environment.CANTRIP_POSTGRES_BIN_DIR =
          process.env.CANTRIP_TEST_POSTGRES_BIN_DIR;
    }
    try {
      await fixture.start();
      report.runtimes.push({ kind, ...(await flow(fixture)) });
    } finally {
      await fixture.close();
    }
  }
  const [reference, actual] = report.runtimes;
  assert.deepEqual(actual.steps, reference.steps);
  assert.equal(actual.transportConnections, reference.transportConnections);
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await browser?.close();
  await vite?.close();
  await postgresOwner?.close();
  await rm(root, { recursive: true, force: true });
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(JSON.stringify(report, null, 2));
}
if (failure) throw failure;
