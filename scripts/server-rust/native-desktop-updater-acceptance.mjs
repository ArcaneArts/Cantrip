import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
    "signing-identity": { type: "string", default: "-" },
    "data-root": { type: "string" },
    report: { type: "string" },
  },
});
assert.equal(process.platform, "darwin");
const historicalInputs = [
  values.profiles,
  values["external-profile"],
  values["previous-report"],
];
const historical = historicalInputs.some(Boolean);
if (historical)
  assert.ok(
    historicalInputs.every(Boolean),
    "Supply all three historical inputs",
  );
const identifier = historical
  ? updaterIdentifier
  : "art.cantrip.rust-qa-updater-" + randomUUID();
const directory = path.resolve(values["data-root"]);
await mkdir(directory, { recursive: true });
const appData = path.join(homedir(), "Library/Application Support", identifier);
const report = {
  suite: "native-desktop-signed-updater",
  sourceCommit: (
    await execute("git", ["rev-parse", "HEAD"], { cwd: repository })
  ).stdout.trim(),
  identifier,
  historical,
  signingIdentity: values["signing-identity"],
  appData,
  cases: [],
};
const hash = async (file) => {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest("hex");
};
async function codeRequirement(bundle) {
  await execute("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    bundle,
  ]);
  const { stdout, stderr } = await execute("/usr/bin/codesign", [
    "-d",
    "-r-",
    bundle,
  ]);
  const requirement = (stdout + "\n" + stderr)
    .split("\n")
    .find((line) => line.startsWith("designated => "));
  assert.ok(requirement, "macOS bundle has a designated signing requirement");
  return requirement;
}
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
  let files;
  try {
    files = await readdir(root);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
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
async function saveRecoveryArtifact(bridge, data, serverId) {
  const artifact = await bridge.until("main", async () => {
    const save = [...document.querySelectorAll("button")].find(
      (button) => button.textContent.trim() === "Save recovery file",
    );
    if (!save || save.disabled) return false;
    const create = URL.createObjectURL;
    const click = HTMLAnchorElement.prototype.click;
    const urls = new Map();
    let saved;
    URL.createObjectURL = function (blob) {
      const url = create.call(this, blob);
      urls.set(url, blob);
      return url;
    };
    // Route the real WebView download to the owned test directory.
    HTMLAnchorElement.prototype.click = function () {
      if (this.download.endsWith(".cantrip-recovery.json")) {
        saved = urls.get(this.href);
        return;
      }
      return click.call(this);
    };
    try {
      save.click();
      if (!saved) throw new Error("Recovery download did not produce a file");
      return await saved.text();
    } finally {
      URL.createObjectURL = create;
      HTMLAnchorElement.prototype.click = click;
    }
  });
  const metadata = JSON.parse(artifact);
  assert.equal(metadata.purpose, "anonymous-account-recovery");
  assert.equal(metadata.serverId, serverId);
  await writeFile(
    path.join(data, "anonymous.cantrip-recovery.json"),
    artifact,
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  await bridge.until("main", () => {
    const input = document.querySelector('input[type="checkbox"]');
    if (!input || input.disabled) return false;
    input.click();
    return true;
  });
  await bridge.until("main", () => {
    const confirm = [...document.querySelectorAll("button")].find(
      (button) => button.textContent.trim() === "Continue to Cantrip",
    );
    if (!confirm || confirm.disabled) return false;
    confirm.click();
    return true;
  });
  await bridge.until(
    "main",
    () =>
      ![...document.querySelectorAll("h1")].some(
        (heading) => heading.textContent.trim() === "Save anonymous recovery",
      ),
  );
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
  if (historical)
    await execute("cp", [
      "-cR",
      appData,
      path.join(directory, "client-before"),
    ]);
  const previousBundle = path.resolve(values["previous-bundle"]);
  const previous = historical
    ? JSON.parse(await readFile(values["previous-report"], "utf8"))
    : null;
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
    identifier,
    signingIdentity: values["signing-identity"],
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
    candidateRuntimeInputSha256: await hash(
      path.join(currentRuntime, "server/bin/cantrip-server"),
    ),
    candidateServerSha256: await hash(
      path.join(
        activePackage.bundle,
        "Contents/Resources/runtime/server/bin/cantrip-server",
      ),
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
  if (historical)
    await execute("cp", [
      "-cR",
      path.resolve(values["external-profile"]),
      externalData,
    ]);
  else
    await execute(path.join(pg, "initdb"), [
      "-D",
      externalData,
      "--username=cantrip",
      "--auth=trust",
      "--locale=C",
      "--encoding=UTF8",
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
  const liveCatalog = () =>
    readCatalogSnapshot(path.join(appData, "installation/v1/catalog.sqlite3"));
  for (const mode of ["pglite", "bundled-postgres", "postgres"]) {
    const entry = { mode, passed: false };
    const retained = previous?.modes.find((item) => item.mode === mode);
    if (historical)
      assert.ok(retained, "Historical profile report includes " + mode);
    report.cases.push(entry);
    const data = path.join(directory, mode);
    if (historical)
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
    const request = async (route, body, waitForWorker = false) => {
      const response = await fetch(apiOrigin + route, {
        method: body ? "PATCH" : "GET",
        signal: AbortSignal.timeout(10_000),
        headers: {
          origin: "http://127.0.0.1:5173",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      if (
        waitForWorker &&
        response.status === 502 &&
        result.error ===
          "Worker encryption has not verified the logical server identity."
      ) {
        entry.workerReadinessRetries = (entry.workerReadinessRetries ?? 0) + 1;
        return null;
      }
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    };
    const checkDatabase = async () => {
      const { database } = await request("/readyz");
      assert.equal(database.engine, mode === "pglite" ? "pglite" : "postgres");
      if (mode === "postgres") {
        const { stdout } = await execute(path.join(pg, "psql"), [
          "-XAtw",
          "-h",
          "127.0.0.1",
          "-p",
          String(pgPort),
          "-U",
          "cantrip",
          "-d",
          "postgres",
          "-c",
          "SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND usename = 'cantrip' AND backend_type = 'client backend'",
        ]);
        assert.ok(
          Number(stdout.trim()) > 0,
          "Server connected to the external PostgreSQL cluster",
        );
        return { engine: database.engine, externalConnection: true };
      }
      const versionFile =
        mode === "pglite" ? "server-db/PG_VERSION" : "postgres/data/PG_VERSION";
      const major = (
        await readFile(path.join(data, "server", versionFile), "utf8")
      ).trim();
      assert.match(major, /^\d+$/);
      return { engine: database.engine, versionFile, major };
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
        const version = await request(
          `/api/workers/${encodeURIComponent(worker.workerId)}/version`,
          undefined,
          true,
        );
        if (!version) {
          await delay(500);
          return false;
        }
        return worker;
      }, mode + " real worker command");
    };
    let readySince = since;
    if (!historical) {
      const { server: seed } = await request("/api/bootstrap");
      await saveRecoveryArtifact(bridge, data, seed.id);
      entry.anonymousRecoverySaved = true;
      readySince = Date.now();
      await bridge.evaluate("main", () => {
        setTimeout(() => location.reload(), 200);
        return true;
      });
    }
    const worker = await ready(readySince);
    entry.baselineDatabase = await checkDatabase();
    const bootstrap = await request("/api/bootstrap");
    assert.equal(bootstrap.server.version.version, previousVersion);
    const baselineTheme = (await request("/api/settings")).preferences.theme;
    if (retained) {
      assert.equal(bootstrap.server.id, retained.identity);
      assert.equal(worker.workerId, retained.workerId);
      assert.equal(baselineTheme, retained.settingsTheme);
    }
    const theme = baselineTheme === "dark" ? "light" : "dark";
    const context = await bridge.evaluate(
      "main",
      () => window.__qaNativeContext,
    );
    assert.equal(
      await bridge.evaluate("main", () => window.__qaUpdaterVersion()),
      previousVersion,
    );
    await request("/api/settings", { theme });
    const catalogBeforeUpdate = liveCatalog();
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
    entry.candidateDatabase = await checkDatabase();
    assert.deepEqual(entry.candidateDatabase, entry.baselineDatabase);
    assert.equal(currentWorker.workerId, worker.workerId);
    const current = await request("/api/bootstrap");
    assert.equal(current.server.id, bootstrap.server.id);
    assert.equal(current.server.version.version, version);
    assert.equal((await request("/api/settings")).preferences.theme, theme);
    assert.ok(before.every((child) => !alive(child.pid)));
    assert.equal(await hash(executable), report.artifacts.candidateAppSha256);
    if (values["signing-identity"] !== "-")
      entry.codeSigningRequirement = await codeRequirement(bundle);
    assert.equal(
      await hash(
        path.join(
          bundle,
          "Contents/Resources/runtime/server/bin/cantrip-server",
        ),
      ),
      report.artifacts.candidateServerSha256,
    );
    await request("/api/settings", { theme: baselineTheme });
    assert.equal(
      (await request("/api/settings")).preferences.theme,
      baselineTheme,
    );
    entry.clientContinuity = verifyCatalogContinuity(
      catalogBeforeUpdate,
      liveCatalog(),
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
  if (values["signing-identity"] !== "-") {
    const [before, after] = await Promise.all([
      codeRequirement(baseline.bundle),
      codeRequirement(activePackage.bundle),
    ]);
    assert.equal(
      after,
      before,
      "Both app versions satisfy the same code requirement",
    );
    for (const entry of report.cases)
      assert.equal(entry.codeSigningRequirement, after);
    report.artifacts.codeSigningRequirement = before;
  }
  await execute("cp", ["-cR", appData, path.join(directory, "client-after")]);
  if (historical) {
    const catalog = (label) =>
      readCatalogSnapshot(
        path.join(directory, label, "installation/v1/catalog.sqlite3"),
      );
    report.clientContinuity = verifyCatalogContinuity(
      catalog("client-before"),
      catalog("client-after"),
    );
  }
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
