import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { fixtureEnvironment } from "./process.mjs";
import { nativeDesktopBridge } from "./native-desktop-bridge.mjs";
import {
  readCatalogSnapshot,
  verifyCatalogContinuity,
} from "./desktop-client-continuity.mjs";
import {
  buildUpdaterBundle,
  prepareUpdaterFixture,
  updaterIdentifier,
} from "./desktop-updater-fixture.mjs";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({
  options: {
    "previous-bundle": { type: "string" },
    "current-runtime": { type: "string" },
    profiles: { type: "string" },
    "external-profile": { type: "string" },
    "previous-report": { type: "string" },
    "data-root": { type: "string" },
    report: { type: "string" },
  },
});
assert.equal(process.platform, "darwin");
const directory = path.resolve(values["data-root"]);
await mkdir(directory, { recursive: true });
const appData = path.join(
  homedir(),
  "Library/Application Support",
  updaterIdentifier,
);
const report = {
  suite: "native-desktop-signed-updater",
  sourceCommit: (
    await execute("git", ["rev-parse", "HEAD"], { cwd: repository })
  ).stdout.trim(),
  identifier: updaterIdentifier,
  appData,
  cases: [],
};
const hash = async (file) => {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest("hex");
};
async function availablePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
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
async function until(read, description, timeout = 120_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value) return value;
    assert.ok(Date.now() < end, "Timed out observing " + description);
    await delay(100);
  }
}
async function logs(source, since) {
  const root = path.join(appData, "logs", source);
  const records = [];
  for (const file of (await readdir(root)).filter((name) =>
    name.endsWith(".jsonl"),
  )) {
    for (const line of (await readFile(path.join(root, file), "utf8")).split(
      "\n",
    )) {
      try {
        const record = JSON.parse(line);
        if (Date.parse(record.timestamp) >= since) records.push(record);
      } catch {
        /* A final partial log line will be read on the next observation. */
      }
    }
  }
  return records;
}
async function children(pid) {
  return (await execute("ps", ["-axo", "pid=,ppid=,comm="])).stdout
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return match && Number(match[2]) === pid
        ? [{ pid: Number(match[1]), executable: match[3] }]
        : [];
    });
}
async function applicationPids(executable) {
  return (await execute("ps", ["-axo", "pid=,comm="])).stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.+)$/.exec(line))
    .filter((match) => match?.[2] === executable)
    .map((match) => Number(match[1]));
}
async function shutdown(pid) {
  const owned = await children(pid);
  if (alive(pid)) process.kill(pid, "SIGTERM");
  await until(() => !alive(pid), "owned desktop shutdown", 30_000);
  assert.ok(
    owned.every((child) => !alive(child.pid)),
    "Desktop services shut down",
  );
  return owned;
}
const bridge = await nativeDesktopBridge();
bridge.setClientOrigin("tauri://localhost");
let server,
  cluster,
  activePackage,
  tamper = false;
const launches = [];
const requests = [];
const tlsErrors = [];
try {
  await execute("cp", ["-cR", appData, path.join(directory, "client-before")]);
  const previousBundle = path.resolve(values["previous-bundle"]);
  const previous = JSON.parse(
    await readFile(values["previous-report"], "utf8"),
  );
  const previousVersion = (
    await execute("/usr/libexec/PlistBuddy", [
      "-c",
      "Print CFBundleShortVersionString",
      path.join(previousBundle, "Contents/Info.plist"),
    ])
  ).stdout.trim();
  const currentRuntime = path.resolve(values["current-runtime"]);
  const manifest = JSON.parse(
    await readFile(path.join(currentRuntime, "server/native-server.json")),
  );
  const version = manifest.version.version;
  const port = await availablePort();
  const origin = "https://127.0.0.1:" + port;
  const prepared = await prepareUpdaterFixture({
    directory,
    bridge,
    endpoint: origin + "/latest.json",
  });
  server = https.createServer(
    {
      key: await readFile(path.join(prepared.trust, "server.key")),
      cert: await readFile(path.join(prepared.trust, "server.crt")),
    },
    async (request, response) => {
      requests.push({
        url: request.url,
        tamper,
        timestamp: new Date().toISOString(),
      });
      if (request.url === "/latest.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            version,
            pub_date: new Date().toISOString(),
            notes: "Local updater acceptance",
            platforms: {
              "darwin-aarch64": {
                signature: activePackage.signature,
                url: origin + "/update.app.tar.gz",
              },
            },
          }),
        );
      } else if (request.url === "/update.app.tar.gz") {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        const bytes = createReadStream(activePackage.archive);
        if (tamper) {
          let first = true;
          bytes
            .pipe(
              new Transform({
                transform(chunk, _encoding, callback) {
                  if (first) {
                    chunk[0] ^= 1;
                    first = false;
                  }
                  callback(null, chunk);
                },
              }),
            )
            .pipe(response);
        } else bytes.pipe(response);
      } else {
        response.writeHead(404);
        response.end();
      }
    },
  );
  server.on("tlsClientError", (error) =>
    tlsErrors.push({ code: error.code, message: error.message }),
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const baseline = await buildUpdaterBundle(prepared, {
    directory,
    label: "baseline",
    version: previousVersion,
    runtime: path.join(previousBundle, "Contents/Resources/runtime"),
  });
  activePackage = await buildUpdaterBundle(prepared, {
    directory,
    label: "candidate",
    version,
    runtime: currentRuntime,
  });
  report.artifacts = {
    previousVersion,
    version,
    baselineAppSha256: await hash(
      path.join(baseline.bundle, "Contents/MacOS/cantrip-app"),
    ),
    candidateAppSha256: await hash(
      path.join(activePackage.bundle, "Contents/MacOS/cantrip-app"),
    ),
    candidateServerSha256: await hash(
      path.join(currentRuntime, "server/bin/cantrip-server"),
    ),
    signedPackageSha256: await hash(activePackage.archive),
  };
  report.scriptSha256 = {
    acceptance: await hash(fileURLToPath(import.meta.url)),
    fixture: await hash(
      fileURLToPath(new URL("./desktop-updater-fixture.mjs", import.meta.url)),
    ),
  };
  const pg = path.join(currentRuntime, "server", manifest.postgres.bin);
  const externalData = path.join(directory, "external-postgres");
  await execute("cp", [
    "-cR",
    path.resolve(values["external-profile"]),
    externalData,
  ]);
  const pgPort = await availablePort();
  await execute(path.join(pg, "pg_ctl"), [
    "-D",
    externalData,
    "-l",
    path.join(directory, "external-postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${pgPort} -k ''`,
    "-w",
    "start",
  ]);
  cluster = { pg, data: externalData };
  for (const mode of ["pglite", "bundled-postgres", "postgres"]) {
    const entry = { mode, passed: false };
    const retained = previous.modes.find((item) => item.mode === mode);
    assert.ok(retained, "Historical profile report includes " + mode);
    report.cases.push(entry);
    const data = path.join(directory, mode);
    await execute("cp", [
      "-cR",
      path.join(path.resolve(values.profiles), mode),
      data,
    ]);
    const installation = path.join(directory, mode + "-installed");
    await mkdir(installation);
    await execute("cp", ["-cR", baseline.bundle, installation]);
    const bundle = path.join(installation, prepared.productName + ".app");
    const executable = path.join(bundle, "Contents/MacOS/cantrip-app");
    const environment = fixtureEnvironment(data);
    delete environment.CANTRIP_DATA_DIR;
    delete environment.PGLITE_RUNTIME_DIR;
    delete environment.DATABASE_URL;
    Object.assign(environment, {
      CANTRIP_DESKTOP_DATA_DIR: data,
      CANTRIP_DATABASE_MODE: mode,
      CANTRIP_TEST_WORKER_HOME: path.join(data, "worker-home"),
      NODE_OPTIONS:
        "--import=" + new URL("./worker-test-home.mjs", import.meta.url).href,
      NO_PROXY: [environment.NO_PROXY, "127.0.0.1", "localhost"]
        .filter(Boolean)
        .join(","),
    });
    await mkdir(environment.CANTRIP_TEST_WORKER_HOME, { recursive: true });
    if (mode === "postgres")
      environment.DATABASE_URL = `postgresql://cantrip@127.0.0.1:${pgPort}/postgres`;
    const since = Date.now();
    const app = spawn(executable, [], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let diagnostics = "";
    launches.push({ app, executable, data, diagnostics: () => diagnostics });
    for (const stream of [app.stdout, app.stderr])
      stream.on("data", (bytes) => {
        diagnostics = (diagnostics + bytes).slice(-262144);
      });
    const originOfServer = async (timestamp) =>
      until(async () => {
        const record = (await logs("server", timestamp)).findLast(
          (row) => row.context?.event === "server.listening",
        );
        return record && new URL(record.context.origin).origin;
      }, mode + " packaged server startup");
    let apiOrigin = await originOfServer(since);
    const request = async (route, body) => {
      const response = await fetch(apiOrigin + route, {
        method: body ? "PATCH" : "GET",
        headers: {
          origin: "http://127.0.0.1:5173",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    };
    const ready = async (timestamp) => {
      await until(
        async () =>
          (await logs("client", timestamp)).some(
            (row) =>
              row.message.includes('"event":"session.refresh.completed"') &&
              row.message.includes('"status":"authenticated"'),
          ),
        mode + " encrypted renderer session",
      );
      return until(async () => {
        const worker = (await request("/api/workers")).find(
          (item) => item.online,
        );
        if (!worker) return false;
        await request(
          `/api/workers/${encodeURIComponent(worker.workerId)}/version`,
        );
        return worker;
      }, mode + " real worker command");
    };
    const worker = await ready(since);
    const bootstrap = await request("/api/bootstrap");
    assert.equal(bootstrap.server.id, retained.identity);
    assert.equal(bootstrap.server.version.version, previousVersion);
    assert.equal(worker.workerId, retained.workerId);
    assert.equal(
      (await request("/api/settings")).preferences.theme,
      retained.settingsTheme,
    );
    const theme = retained.settingsTheme === "dark" ? "light" : "dark";
    const context = await bridge.evaluate(
      "main",
      () => window.__qaNativeContext,
    );
    assert.equal(
      await bridge.evaluate("main", () => window.__qaUpdaterVersion()),
      previousVersion,
    );
    await request("/api/settings", { theme });
    const before = await children(app.pid);
    assert.ok(
      before.some((child) => child.executable.endsWith("/bin/cantrip-server")),
    );
    assert.ok(
      before.some((child) => child.executable.endsWith("/runtime/node")),
    );
    const check = () =>
      bridge.evaluate("main", () =>
        window.__qaUpdaterInvoke("check_desktop_update"),
      );
    assert.equal((await check()).release.version, version);
    if (mode === "pglite") {
      tamper = true;
      entry.rejectedPackage = await bridge.evaluate("main", async () => {
        try {
          await window.__qaUpdaterInvoke("install_desktop_update", {
            request: {
              activeWork: {
                activeChats: 0,
                queuedPrompts: 0,
                terminalServices: 0,
                backgroundJobs: 0,
              },
              confirmActiveWork: true,
            },
          });
          return null;
        } catch (error) {
          return error.code;
        }
      });
      assert.equal(entry.rejectedPackage, "update_signature_invalid");
      assert.ok(before.every((child) => alive(child.pid)));
      assert.equal(await hash(executable), report.artifacts.baselineAppSha256);
      tamper = false;
      await check();
    }
    const updateSince = Date.now();
    await bridge.evaluate("main", () => {
      window.__qaUpdateResult = null;
      void window
        .__qaUpdaterInvoke("install_desktop_update", {
          request: {
            activeWork: {
              activeChats: 0,
              queuedPrompts: 0,
              terminalServices: 0,
              backgroundJobs: 0,
            },
            confirmActiveWork: true,
          },
        })
        .then((result) => {
          window.__qaUpdateResult = result;
        })
        .catch((error) => {
          window.__qaUpdateResult = error;
        });
      return true;
    });
    await until(
      async () => {
        let observation;
        try {
          observation = await bridge.evaluate("main", async () => ({
            context: window.__qaNativeContext,
            version: await window.__qaUpdaterVersion(),
            error: window.__qaUpdateResult?.code,
          }));
        } catch {
          return false;
        }
        assert.equal(
          observation.error,
          undefined,
          "Signed update installation error",
        );
        return (
          observation.context !== context && observation.version === version
        );
      },
      mode + " updated app restart",
      180_000,
    );
    apiOrigin = await originOfServer(updateSince);
    const currentWorker = await ready(updateSince);
    assert.equal(currentWorker.workerId, worker.workerId);
    const current = await request("/api/bootstrap");
    assert.equal(current.server.id, bootstrap.server.id);
    assert.equal(current.server.version.version, version);
    assert.equal((await request("/api/settings")).preferences.theme, theme);
    assert.ok(before.every((child) => !alive(child.pid)));
    assert.equal(await hash(executable), report.artifacts.candidateAppSha256);
    assert.equal(
      await hash(
        path.join(
          bundle,
          "Contents/Resources/runtime/server/bin/cantrip-server",
        ),
      ),
      report.artifacts.candidateServerSha256,
    );
    await request("/api/settings", { theme: retained.settingsTheme });
    assert.equal(
      (await request("/api/settings")).preferences.theme,
      retained.settingsTheme,
    );
    const currentApps = await applicationPids(executable);
    assert.equal(
      currentApps.length,
      1,
      "One updated application remains running",
    );
    const newChildren = await shutdown(currentApps[0]);
    Object.assign(entry, {
      passed: true,
      identity: bootstrap.server.id,
      workerId: worker.workerId,
      oldChildren: before,
      newChildren,
      retainedTheme: theme,
      previousVersion,
      version,
    });
    console.log(
      "QA_EVT " +
        JSON.stringify({
          event: "signed-updater.retained",
          status: "pass",
          mode,
        }),
    );
  }
  await execute("cp", ["-cR", appData, path.join(directory, "client-after")]);
  const catalog = (label) =>
    readCatalogSnapshot(
      path.join(directory, label, "installation/v1/catalog.sqlite3"),
    );
  report.clientContinuity = verifyCatalogContinuity(
    catalog("client-before"),
    catalog("client-after"),
  );
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  const cleanup = await Promise.allSettled(
    launches.map(async ({ app, executable, data, diagnostics }) => {
      const pids = await applicationPids(executable);
      if (
        app.exitCode === null &&
        app.signalCode === null &&
        !pids.includes(app.pid)
      )
        pids.push(app.pid);
      for (const pid of pids) await shutdown(pid);
      await writeFile(path.join(data, "app-process.log"), diagnostics());
    }),
  );
  if (cluster)
    cleanup.push(
      ...(await Promise.allSettled([
        execute(path.join(cluster.pg, "pg_ctl"), [
          "-D",
          cluster.data,
          "-m",
          "fast",
          "-w",
          "stop",
        ]),
      ])),
    );
  report.cleanupErrors = cleanup.flatMap((result) =>
    result.status === "rejected" ? [result.reason.message] : [],
  );
  if (report.cleanupErrors.length) {
    report.passed = false;
    process.exitCode = 1;
  }
  await bridge.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  report.requests = requests;
  report.tlsErrors = tlsErrors;
  await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      report: values.report,
      passed: report.passed,
      error: report.error?.message,
    }),
  );
}
