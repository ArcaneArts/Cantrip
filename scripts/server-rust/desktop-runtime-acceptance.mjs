// Execute the desktop's production launcher/supervisor against a packaged tree.
// This checks service integration; renderer and OS installer acceptance remain
// separate product/platform work.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createPasswordKdfParameters,
  generateAccountMasterKey,
  generateHpkeKeyPair,
  publicKeyForPair,
  wrapAccountMasterKeyForClient,
  wrapAccountMasterKeyWithPassword,
} from "../../packages/crypto/dist/index.js";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { fixtureEnvironment, startServer } from "./process.mjs";

const { values } = parseArgs({
  options: {
    runtime: { type: "string" },
    probe: { type: "string" },
    report: { type: "string" },
    "external-url": { type: "string" },
    "without-worker": { type: "boolean", default: false },
  },
});
const runtime = path.resolve(values.runtime);
const probe = path.resolve(values.probe);
const root = await mkdtemp(path.join(tmpdir(), "cantrip-desktop-native-"));
const report = {
  suite: "desktop-native-launcher",
  runtime,
  probe,
  root,
  modes: [],
};
let failure;
async function eventually(operation, check) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const result = await operation();
    try {
      check(result);
      return result;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await delay(100);
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
try {
  const modes = [
    "pglite",
    "bundled-postgres",
    ...(values["external-url"] ? ["postgres"] : []),
  ];
  for (const mode of modes) {
    const data = path.join(root, mode);
    await mkdir(data);
    const environment = fixtureEnvironment(data);
    for (const name of [
      "CANTRIP_DATA_DIR",
      "CANTRIP_WORKER_TOKEN",
      "PGLITE_RUNTIME_DIR",
    ])
      delete environment[name];
    environment.CANTRIP_DATABASE_MODE = mode;
    const workerHome = path.join(data, "isolated-worker-home");
    await mkdir(workerHome);
    environment.CANTRIP_TEST_WORKER_HOME = workerHome;
    environment.NODE_OPTIONS = [
      environment.NODE_OPTIONS,
      "--import=" + new URL("./worker-test-home.mjs", import.meta.url).href,
    ]
      .filter(Boolean)
      .join(" ");
    if (mode === "postgres") environment.DATABASE_URL = values["external-url"];
    const launch = () =>
      startServer(
        probe,
        [
          runtime,
          data,
          ...(values["without-worker"] ? ["--without-worker"] : []),
        ],
        { env: environment },
      );
    let workerId;
    const visit = async (server, mutate) => {
      const cookies = new Map();
      let csrf;
      const request = async (route, options = {}) => {
        const response = await fetch(server.origin + route, {
          ...options,
          headers: {
            origin: "http://127.0.0.1:5173",
            cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
            ...(csrf ? { "x-cantrip-csrf": csrf } : {}),
            ...(options.body ? { "content-type": "application/json" } : {}),
          },
        });
        for (const cookie of response.headers.getSetCookie()) {
          const pair = cookie.split(";")[0],
            at = pair.indexOf("=");
          cookies.set(pair.slice(0, at), pair.slice(at + 1));
        }
        const body = await response.json();
        assert.equal(
          response.status,
          options.expectedStatus ?? 200,
          `${route}: ${JSON.stringify(body)}`,
        );
        if (body.csrfToken) csrf = body.csrfToken;
        return body;
      };
      await request("/api/auth/session");
      const bootstrap = await request("/api/bootstrap");
      const profile = await request("/api/encryption/profile");
      if (profile.status === "uninitialized") {
        const ownerId = bootstrap.auth.currentUser.id;
        const accountMasterKey = generateAccountMasterKey();
        const pair = await generateHpkeKeyPair();
        const publicKey = await publicKeyForPair(pair);
        const clientId = randomUUID();
        const passwordWrappedMasterKey = await wrapAccountMasterKeyWithPassword(
          {
            ownerId,
            accountMasterKey,
            password: "disposable desktop acceptance key",
            masterKeyRevision: 1,
            kdf: createPasswordKdfParameters({
              memoryKiB: 8192,
              iterations: 1,
            }),
          },
        );
        const wrappedMasterKey = await wrapAccountMasterKeyForClient({
          ownerId,
          accountMasterKey,
          clientId,
          masterKeyRevision: 1,
          clientPublicKey: publicKey,
        });
        await request("/api/encryption/profile/initialize", {
          method: "POST",
          expectedStatus: 201,
          body: JSON.stringify({
            profile: {
              formatVersion: 1,
              activeMasterKeyRevision: 1,
              passwordKdf: passwordWrappedMasterKey.kdf,
              passwordWrappedMasterKey,
              payloadMigrationStatus: "pending",
            },
            initialClient: {
              id: clientId,
              label: "Disposable desktop client",
              publicKey,
              wrappedMasterKey,
            },
          }),
        });
      }

      assert.equal(bootstrap.server.bootstrapMode, "tauri");
      const ready = await request("/readyz");
      assert.equal(
        ready.database.engine,
        mode === "pglite" ? "pglite" : "postgres",
      );
      if (mutate)
        await request("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({ theme: "dark" }),
        });
      assert.equal((await request("/api/settings")).preferences.theme, "dark");
      if (!values["without-worker"]) {
        const catalog = await eventually(
          () => request("/api/workers"),
          (body) => {
            assert.ok(
              body.some((w) => w.online),
              JSON.stringify(body),
            );
          },
        );
        const worker = catalog.find((w) => w.online);
        if (workerId)
          assert.equal(
            worker.workerId,
            workerId,
            "retained worker identity after restart",
          );
        workerId = worker.workerId;
        const version = await eventually(
          async () => {
            try {
              return await request(
                `/api/workers/${encodeURIComponent(workerId)}/version`,
              );
            } catch (error) {
              // The production worker retries authorization after the client
              // initializes its profile. Observe real command success.
              return { failure: error.message };
            }
          },
          (value) =>
            assert.equal(typeof value.version, "string", JSON.stringify(value)),
        );
        assert.equal(typeof version.version, "string");
        assert.ok(
          version.version.length > 0,
          "real packaged worker answered the command",
        );
      }
      return bootstrap.server.id;
    };
    let identity;
    for (let restart = 0; restart < 2; restart++) {
      const server = await launch();
      const started = server.events.find(
        (e) => e.event === "server.listening" && e.serverPid,
      );
      assert.equal(started.native, true);
      assert.equal(started.workerPid !== null, !values["without-worker"]);
      try {
        const observed = await visit(server, restart === 0);
        if (identity) assert.equal(observed, identity);
        identity = observed;
      } finally {
        await server.close({ shutdownTimeoutMs: 30_000 });
        assert.ok(
          server.events.some(
            (e) => e.event === "desktop.server.stopped" && e.exitCode === 0,
          ),
          server.diagnostics(),
        );
        assert.equal(alive(started.serverPid), false);
        if (started.workerPid) assert.equal(alive(started.workerPid), false);
        await writeFile(
          path.join(data, `restart-${restart}.log`),
          server.diagnostics(),
        );
      }
    }
    // Abrupt supervisor loss closes only its native-server pipe. Reopening the
    // same database must succeed; private PostgreSQL must not remain owned.
    const crashed = await startServer(
      probe,
      [runtime, data, "--without-worker"],
      { env: environment },
    );
    const child = crashed.events.find(
      (e) => e.event === "server.listening" && e.serverPid,
    );
    const closed = new Promise((resolve) =>
      crashed.child.once("close", resolve),
    );
    crashed.child.kill("SIGKILL");
    await closed;
    await eventually(
      () => alive(child.serverPid),
      (value) => assert.equal(value, false),
    );
    const reopened = await launch();
    try {
      assert.equal(await visit(reopened, false), identity);
    } finally {
      await reopened.close({ shutdownTimeoutMs: 30_000 });
    }
    report.modes.push({
      mode,
      identity,
      workerId,
      settingsWriteAndRestart: true,
      nativeExitCode: 0,
      childrenReaped: true,
      supervisorLossAndRecovery: true,
      actualWorker: !values["without-worker"],
    });
  }
  report.desktopServerConfiguration = JSON.parse(
    await readFile(path.join(runtime, "server/desktop-server.json")),
  );
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  if (values.report) {
    await mkdir(path.dirname(values.report), { recursive: true });
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  }
}
if (failure) throw failure;
console.log(JSON.stringify(report));
