// Production browser API -> actual server -> production worker entrypoint.
// Only Ollama's public HTTP API is controlled. No worker transport, command
// handler, repository or client API is mocked.
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { loadStoredWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { buildRustServer, buildWorkerCli, repositoryRoot } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { launchActualWorker } from "./full-worker.mjs";
import { password } from "./security-fixtures.mjs";

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(databaseMode));
const reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-actual-worker-"));
const appRoot = path.join(repositoryRoot, "cantrip_app");
const appRequire = createRequire(path.join(appRoot, "package.json"));
const { createServer } = await import(
  pathToFileURL(appRequire.resolve("vite")).href
);
const report = {
  schemaVersion: 1,
  suite: "actual-browser-server-worker-catalog",
  databaseMode,
  completeReplacement: false,
  scope:
    "Existing browser account/provider APIs and AppLiveClient, actual server and full built worker index; Ollama discovery, retained enrollment and worker restart. No model inference, full UI, packaging or execution-domain acceptance.",
  runtimes: [],
};
let vite, browser, postgresOwner, failure, cliBinary;
let modelName = "cantrip-integration-a:8b";
let serviceFailure = false;
const calls = [];
const ollama = createHttpServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const call = {
      method: request.method,
      path: request.url,
      body: body ? JSON.parse(body) : null,
      status: 200,
    };
    calls.push(call);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/tags" && !serviceFailure) {
      response.end(
        JSON.stringify({
          models: [
            {
              name: modelName,
              model: modelName,
              size: 100,
              digest: "fixture-digest",
              modified_at: "2026-10-25T00:00:00.000Z",
            },
          ],
        }),
      );
    } else if (request.url === "/api/show" && !serviceFailure) {
      assert.equal(JSON.parse(body).model, modelName);
      response.end(
        JSON.stringify({
          details: {
            family: "llama",
            families: ["llama"],
            parameter_size: "8B",
            quantization_level: "Q4_K_M",
          },
          capabilities: ["completion", "tools", "vision", "thinking"],
          model_info: {
            "general.architecture": "llama",
            "llama.context_length": 32768,
          },
        }),
      );
    } else {
      response.statusCode = 503;
      call.status = 503;
      response.end(
        JSON.stringify({ error: "Disposable integration service unavailable" }),
      );
    }
  } catch (error) {
    response.statusCode = 500;
    response.end(JSON.stringify({ error: error.message }));
  }
});

async function eventually(read, check, timeout = 30000) {
  const expires = Date.now() + timeout;
  for (;;) {
    const value = await read();
    try {
      check(value);
      return value;
    } catch (error) {
      if (Date.now() >= expires) throw error;
    }
    await delay(50);
  }
}

async function flow(fixture, result) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const dataDirectory = path.join(root, fixture.kind, "full-worker");
  let worker;
  const steps = result.steps;
  const catalog = () =>
    page.evaluate(async () =>
      window.catalogApi.getProviderModelCatalog(
        window.catalogProvider.id,
        "actual-catalog-worker",
      ),
    );
  const refresh = () =>
    page.evaluate(async () =>
      window.catalogApi.refreshProviderModelCatalog(
        window.catalogProvider.id,
        "actual-catalog-worker",
      ),
    );
  const checkCatalog = (value, expectedModel) => {
    assert.ok(value.models.some((m) => m.nativeModelId === expectedModel));
    const model = value.models.find((m) => m.nativeModelId === expectedModel);
    assert.equal(model.contextWindow, 32768);
    assert.equal(model.family, "llama");
    assert.equal(model.supportsTools, true);
    assert.equal(model.supportsVision, true);
    assert.equal(model.supportsReasoning, true);
    assert.ok(
      value.availability.some(
        (a) =>
          a.providerModelId === model.id &&
          a.workerId === "actual-catalog-worker" &&
          a.state === "available",
      ),
    );
    assert.ok(
      value.syncStates.some(
        (s) =>
          s.workerId === "actual-catalog-worker" &&
          s.status === "current" &&
          s.error === null,
      ),
    );
    return model;
  };
  try {
    modelName = "cantrip-integration-a:8b";
    serviceFailure = false;
    const startCalls = calls.length;
    await page.goto(`${vite.resolvedUrls.local[0]}__actual_worker_fixture`);
    const enrollment = await page.evaluate(
      async ({ serverUrl, password }) => {
        const servers = await import("/src/lib/server-connections.ts");
        const account = await import("/src/lib/api/account.ts");
        const session = await import("/src/lib/client-session.ts");
        const workers = await import("/src/lib/api/workers.ts");
        window.catalogApi = await import("/src/lib/api/models.ts");
        window.catalogRequest = (
          await import("/src/lib/api-client.ts")
        ).request;
        await servers.initializeServerConnections();
        const saved = await servers.saveServerConnection({
          name: "Disposable full-worker server",
          url: serverUrl,
        });
        await servers.selectServerConnection(saved.id);
        const bootstrap = await account.getServerBootstrap();
        const registered = await account.registerAccount({
          email: "full-worker@example.invalid",
          displayName: "Full worker owner",
          password,
        });
        session.setClientSession({
          authMode: "accounts",
          serverId: bootstrap.server.id,
          user: registered.currentUser,
          csrfToken: registered.csrfToken,
          expiresAt: registered.expiresAt,
        });
        if (
          (await account.getAuthSession()).currentUser?.id !==
          registered.currentUser.id
        )
          throw new Error("Browser session was not retained");
        const { AppLiveClient, appLiveWebSocketUrl } =
          await import("/src/lib/app-live-client.ts");
        window.catalogEvents = [];
        window.catalogLive = new AppLiveClient({
          client: {
            id: "full-worker-browser",
            name: "Full worker integration",
            version: "1",
          },
          storage: localStorage,
          storageKey: "actual-worker-resume",
          url: appLiveWebSocketUrl(serverUrl, location.origin),
          onEvent: (event) => window.catalogEvents.push(event),
          onAuthenticationRequired: () => {
            throw new Error("Unexpected authentication revocation");
          },
          onResync: async () => {
            await window.catalogRequest("/api/workers");
          },
        });
        window.catalogLive.retainScope({ kind: "current-user" });
        window.catalogLive.start();
        return workers.createWorkerEnrollmentCode({
          label: "Full production worker",
          expiresInSeconds: 300,
        });
      },
      { serverUrl: fixture.server.origin, password },
    );
    steps.push(
      "actual browser server selection, account registration and retained cookie session",
    );
    await eventually(
      () => page.evaluate(() => window.catalogLive.snapshot().status),
      (status) => assert.equal(status, "live"),
    );
    worker = launchActualWorker(fixture, dataDirectory, {
      cliBinary,
      enrollmentCode: enrollment.code,
    });
    await worker.ready();
    steps.push(
      "full production worker starts, enrolls and negotiates its command socket",
    );
    const registeredWorker = await eventually(
      () => page.evaluate(() => window.catalogRequest("/api/workers")),
      (workers) => {
        assert.equal(workers.length, 1);
        assert.equal(workers[0].workerId, "actual-catalog-worker");
        assert.equal(workers[0].online, true);
      },
    );
    result.codexRuntime = registeredWorker[0].codexRuntime.compatibility;
    await eventually(
      () => page.evaluate(() => window.catalogEvents),
      (events) =>
        assert.ok(
          events.some(
            (event) =>
              event.resource === "worker" &&
              event.entityId === "actual-catalog-worker",
          ),
        ),
    );
    steps.push("existing AppLiveClient receives committed worker enrollment");
    await page.evaluate(async (baseUrl) => {
      window.catalogProvider = await window.catalogApi.createModelProvider({
        name: "Full worker Ollama",
        kind: "ollama",
        baseUrl,
        apiKey: null,
      });
    }, ollama.origin);
    checkCatalog(await refresh(), modelName);
    const first = checkCatalog(await catalog(), modelName);
    assert.ok(
      calls.slice(startCalls).some((call) => call.path === "/api/tags"),
    );
    assert.ok(
      calls
        .slice(startCalls)
        .some(
          (call) => call.path === "/api/show" && call.body.model === modelName,
        ),
    );
    steps.push(
      "existing provider client discovers Ollama models through full worker and reads persisted capabilities",
    );
    const credential = loadStoredWorkerCredential(
      dataDirectory,
      fixture.server.origin,
    );
    assert.ok(credential);
    result.workerStops = [await worker.close()];
    result.workerDiagnostics = [worker.diagnostics()];
    worker = undefined;
    assert.deepEqual(
      loadStoredWorkerCredential(dataDirectory, fixture.server.origin),
      credential,
    );
    const retained = checkCatalog(await catalog(), modelName);
    assert.equal(retained.id, first.id);
    steps.push("catalog persists while the enrolled worker is stopped");
    worker = launchActualWorker(fixture, dataDirectory, { cliBinary });
    await worker.ready();
    assert.deepEqual(
      loadStoredWorkerCredential(dataDirectory, fixture.server.origin),
      credential,
    );
    modelName = "cantrip-integration-b:8b";
    checkCatalog(await refresh(), modelName);
    steps.push(
      "full worker restarts from retained credential and serves another actual client refresh",
    );
    serviceFailure = true;
    const failureCallStart = calls.length;
    const failed = await refresh();
    result.failedCatalog = failed;
    assert.ok(failed.models.some((model) => model.nativeModelId === modelName));
    assert.equal(failed.servedStale, true);
    assert.ok(
      failed.syncStates.some(
        (state) =>
          state.workerId === "actual-catalog-worker" &&
          state.status === "stale" &&
          state.error === "ollama-catalog-refresh-failed",
      ),
    );
    assert.ok(
      calls
        .slice(failureCallStart)
        .some((call) => call.path === "/api/tags" && call.status === 503),
    );
    result.failureBehavior = {
      servedStale: failed.servedStale,
      status: "stale",
      error: "ollama-catalog-refresh-failed",
      retainedModel: modelName,
    };
    steps.push(
      "real worker HTTP failure reaches the client without deleting retained catalog",
    );
    serviceFailure = false;
    checkCatalog(await refresh(), modelName);
    steps.push(
      "discovery recovers after the actual Ollama HTTP service recovers",
    );
    assert.deepEqual(errors, []);
    result.catalog = {
      nativeModelId: modelName,
      contextWindow: 32768,
      workerId: "actual-catalog-worker",
      persistedFirstModel: first.nativeModelId,
    };
    result.ollamaRequests = calls
      .slice(startCalls)
      .filter((call) => call.path.startsWith("/api/"));
  } finally {
    try {
      if (worker) {
        (result.workerStops ??= []).push(await worker.close());
        (result.workerDiagnostics ??= []).push(worker.diagnostics());
      }
    } finally {
      await page.evaluate(() => window.catalogLive?.stop()).catch(() => {});
      await context.close();
    }
  }
}

try {
  const executable = await buildRustServer();
  cliBinary = await buildWorkerCli();
  await new Promise((resolve) => ollama.listen(0, "127.0.0.1", resolve));
  ollama.origin = `http://127.0.0.1:${ollama.address().port}`;
  vite = await createServer({
    root: appRoot,
    configFile: path.join(appRoot, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    plugins: [
      {
        name: "actual-worker-client-fixture",
        configureServer(server) {
          server.middlewares.use(
            "/__actual_worker_fixture",
            (_request, response) => {
              response.setHeader("content-type", "text/html");
              response.end(
                "<!doctype html><html><title>Actual worker integration</title><body>Disposable full-worker client</body></html>",
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
    postgresOwner = await postgresFixture(path.join(root, "postgres"));
  for (const kind of ["node", "rust"]) {
    const fixture = new HttpFixture({
      kind,
      executable,
      root,
      name: "actual-worker",
      databaseMode,
      environment: {
        CANTRIP_AUTH_MODE: "accounts",
        CANTRIP_APP_ORIGINS: `http://127.0.0.1:5173,${new URL(vite.resolvedUrls.local[0]).origin}`,
      },
      providerAuthDrain: true,
    });
    if (postgresOwner) {
      if (kind === "node" || databaseMode === "postgres")
        fixture.environment.DATABASE_URL = await postgresOwner.database();
      else
        fixture.environment.CANTRIP_POSTGRES_BIN_DIR =
          process.env.CANTRIP_TEST_POSTGRES_BIN_DIR;
    }
    const result = { kind, steps: [] };
    report.runtimes.push(result);
    try {
      await fixture.start();
      await flow(fixture, result);
    } finally {
      const server = fixture.server;
      try {
        await fixture.close();
      } finally {
        result.shutdownStages =
          server?.events.filter(
            (event) => event.event === "server.shutdown.stage",
          ) ?? [];
      }
    }
  }
  assert.deepEqual(report.runtimes[1].steps, report.runtimes[0].steps);
  assert.deepEqual(report.runtimes[1].catalog, report.runtimes[0].catalog);
  assert.deepEqual(
    report.runtimes[1].failureBehavior,
    report.runtimes[0].failureBehavior,
  );
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await browser?.close();
  await vite?.close();
  ollama.closeAllConnections();
  await new Promise((resolve) => ollama.close(resolve));
  await postgresOwner?.close();
  await rm(root, { recursive: true, force: true });
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(
    JSON.stringify(
      {
        ...report,
        runtimes: report.runtimes.map(
          ({ workerDiagnostics, ...runtime }) => runtime,
        ),
      },
      null,
      2,
    ),
  );
}
if (failure) throw failure;
