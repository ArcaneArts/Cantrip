// Real macOS native windows -> production Rust package -> unchanged full worker.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { startEditorRecoveryFixture } from "../qa/editor-recovery-fixture.mjs";
import { nativeDesktopBridge } from "./native-desktop-bridge.mjs";
import { nativeDesktopWorkspaceFlow } from "./native-desktop-workspace-flow.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({
  options: {
    "server-artifact": { type: "string" },
    database: { type: "string", default: "all" },
    "data-root": { type: "string" },
    report: { type: "string" },
    cli: { type: "string" },
  },
});
assert.equal(
  process.platform,
  "darwin",
  "This harness exercises actual macOS windows",
);
const artifact = path.resolve(values["server-artifact"]);
const modes =
  values.database === "all"
    ? ["pglite", "bundled-postgres", "postgres"]
    : [values.database];
assert.ok(
  modes.every((mode) =>
    ["pglite", "bundled-postgres", "postgres"].includes(mode),
  ),
);
const directory = values["data-root"]
  ? path.resolve(values["data-root"])
  : path.join(root, ".qa", "native-desktop-" + randomUUID());
await mkdir(directory, { recursive: true });
const manifest = JSON.parse(
  await readFile(path.join(artifact, "native-server.json")),
);
async function hash(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
const report = {
  suite: "native-desktop-workspace",
  scope:
    "Actual debug macOS app/current production frontend plus acceptance-only DOM controller; packaged Rust server and current full worker; disposable account/repository, native windows, real worker files. Separate production-release packaging/encryption qualification remains authoritative for shipping assets.",
  sourceCommit: (
    await execute("git", ["rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim(),
  artifact: {
    path: artifact,
    version: manifest.version.version,
    sha256: await hash(path.join(artifact, "bin/cantrip-server")),
  },
  cases: [],
};
const inventoryBinary = path.join(directory, "owned-window-inventory");
await execute("swiftc", [
  fileURLToPath(
    new URL("./native-desktop-window-inventory.swift", import.meta.url),
  ),
  "-o",
  inventoryBinary,
]);
const appRequire = createRequire(path.join(root, "cantrip_app/package.json"));
let cluster;
let failure;
async function externalPostgres() {
  const pg = path.join(artifact, manifest.postgres.bin);
  const data = path.join(directory, "external-postgres");
  await execute(path.join(pg, "initdb"), [
    "-D",
    data,
    "-U",
    "cantrip",
    "-A",
    "trust",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  await execute(path.join(pg, "pg_ctl"), [
    "-D",
    data,
    "-l",
    path.join(directory, "external-postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${port} -k ''`,
    "-w",
    "start",
  ]);
  cluster = { pg, data };
  return `postgresql://cantrip@127.0.0.1:${port}/postgres`;
}
async function run(mode) {
  const target = path.join(directory, mode);
  await mkdir(target);
  const events = [];
  const current = { mode, events, screenshots: [], passed: false };
  report.cases.push(current);
  const record = (event, details = {}) => {
    const entry = { event, status: "pass", details };
    events.push(entry);
    console.log("QA_EVT " + JSON.stringify({ ...entry, database: mode }));
  };
  const originalEnvironment = { ...process.env };
  const bridge = await nativeDesktopBridge();
  let fixture, browser, app, completion, appPid, previousAppPid, appExit;
  let productCompleted = false;
  const output = createWriteStream(path.join(target, "native-app.log"));
  async function observe(read, description, timeoutMs = 45_000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (appExit)
        throw new Error(
          "Native app build/launcher exited: " + JSON.stringify(appExit),
        );
      const value = await read();
      if (value) return value;
      if (Date.now() > end)
        throw new Error("Timed out observing " + description);
      await delay(100);
    }
  }
  try {
    process.env.CANTRIP_TEST_WORKER_HOME = path.join(target, "worker-home");
    await mkdir(process.env.CANTRIP_TEST_WORKER_HOME);
    process.env.NODE_OPTIONS = [
      originalEnvironment.NODE_OPTIONS,
      "--import=" + new URL("./worker-test-home.mjs", import.meta.url).href,
    ]
      .filter(Boolean)
      .join(" ");
    process.env.CANTRIP_DEVELOPMENT_KEY_VAULT = "1";
    if (values.cli) process.env.CANTRIP_CLI_BIN = path.resolve(values.cli);
    const databaseUrl =
      mode === "postgres" ? await externalPostgres() : undefined;
    fixture = await startEditorRecoveryFixture({
      repositoryProject: true,
      nativeLoopbackOrigin: true,
      serverExecutable: path.join(artifact, "start.sh"),
      serverEnvironment: {
        CANTRIP_DATABASE_MODE: mode,
        ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
      },
      clientPlugins: [bridge.plugin],
    });
    bridge.setClientOrigin(fixture.origin);
    current.fixtureDirectory = fixture.directory;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      acceptDownloads: true,
      viewport: { width: 1280, height: 800 },
    });
    await page.goto(fixture.origin);
    const save = page.getByRole("button", {
      name: "Save recovery file",
      exact: true,
    });
    await save.waitFor({ timeout: 90_000 });
    const download = page.waitForEvent("download");
    await save.click();
    const recoveryFile = path.join(target, "disposable-recovery.json");
    await (await download).saveAs(recoveryFile);
    await page
      .getByRole("checkbox", {
        name: "I saved the recovery file somewhere I can access later.",
        exact: true,
      })
      .check();
    await page
      .getByRole("button", { name: "Continue to Cantrip", exact: true })
      .click();
    // Bootstrap initially precedes account setup. Exercise the actual worker
    // restart and a command after setup before protected project creation.
    await fixture.inject({ type: "restart", process: "worker" });
    await observe(async () => {
      const response = await fetch(
        `${fixture.origin}/api/workers/${fixture.workerId}/version`,
      );
      return response.ok;
    }, "restarted worker command");
    const project = await page.evaluate(() =>
      window.__qaRepositoryFixture.create(),
    );
    await page.waitForFunction(
      async () =>
        (await window.__qaRepositoryFixture.project())?.setupStatus === "ready",
      undefined,
      { timeout: 90_000 },
    );
    record("native-workspace.disposable-account-project", {
      projectId: project.id,
      realWorkerCommand: true,
    });
    await browser.close();
    browser = null;
    const identifier =
      "art.cantrip.qa.workspace" + randomUUID().replaceAll("-", "");
    current.identifier = identifier;
    const config = {
      identifier,
      productName: "Cantrip Workspace QA",
      build: { beforeDevCommand: "", devUrl: fixture.origin },
    };
    app = spawn(
      process.execPath,
      [
        appRequire.resolve("@tauri-apps/cli/tauri.js"),
        "dev",
        "--no-watch",
        "--runner",
        path.join(root, "scripts/qa/workspace-native-runner.mjs"),
        "--config",
        JSON.stringify(config),
      ],
      {
        cwd: path.join(root, "cantrip_app"),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "2",
          CARGO_INCREMENTAL: "0",
          CARGO_PROFILE_DEV_DEBUG: "0",
          CARGO_TERM_COLOR: "never",
          CANTRIP_QA_BUNDLE_ID: identifier,
          CANTRIP_QA_FIXTURE_DIR: fixture.directory,
          CANTRIP_QA_RESTART_AFTER_CRASH: "true",
          CANTRIP_LOCAL_ONLY: "true",
          CANTRIP_SERVER_URL: fixture.origin,
          CANTRIP_WORKER_ID: fixture.workerId,
          CANTRIP_WORKER_DATA_DIR: path.join(fixture.directory, "worker"),
          CANTRIP_DESKTOP_DATA_DIR: path.join(fixture.directory, "desktop"),
        },
      },
    );
    app.stdout.pipe(output, { end: false });
    app.stderr.pipe(output, { end: false });
    createInterface({ input: app.stdout }).on("line", (line) => {
      if (!line.startsWith("QA_EVT ")) return;
      try {
        const entry = JSON.parse(line.slice(7));
        if (entry.event === "native.workspace.process") {
          previousAppPid = appPid;
          appPid = entry.pid;
        }
      } catch {}
    });
    completion = new Promise((resolve, reject) => {
      app.once("error", reject);
      app.once("close", (code, signal) => {
        appExit = { code, signal };
        resolve(appExit);
      });
    });
    await observe(() => appPid, "actual native app startup", 600_000);
    const capture = async (name) => {
      const windows = JSON.parse(
        (await execute(inventoryBinary, [String(appPid)])).stdout,
      );
      assert.ok(windows.length > 0, "Actual owned native windows are present");
      for (const window of windows) {
        const destination = path.join(target, `${name}-${window.id}.png`);
        await execute("/usr/sbin/screencapture", [
          "-x",
          "-l",
          String(window.id),
          destination,
        ]);
        current.screenshots.push({
          stage: name,
          window,
          path: destination,
          sha256: await hash(destination),
        });
      }
    };
    await nativeDesktopWorkspaceFlow({
      bridge,
      fixture,
      projectId: project.id,
      recoveryFile,
      directory: target,
      record,
      capture,
      crashApp: async () => {
        const oldPid = appPid;
        process.kill(oldPid, "SIGKILL");
        await observe(
          () => appPid !== oldPid && appPid,
          "one-shot app restart",
        );
        assert.equal(previousAppPid, oldPid);
        return { oldPid, newPid: appPid };
      },
    });
    current.nativeAppSha256 = await hash(
      path.join(
        fixture.directory,
        "Cantrip Workspace QA.app/Contents/MacOS/cantrip-app",
      ),
    );
    productCompleted = true;
  } catch (error) {
    current.failure = error.stack;
    throw error;
  } finally {
    const cleanupErrors = [];
    const cleanup = async (name, action) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push({ name, error: error.stack });
      }
    };
    await cleanup("browser", async () => browser?.close());
    await cleanup("native app", async () => {
      if (!app) return;
      if (!appExit) {
        try {
          process.kill(appPid ?? -app.pid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        const timer = setTimeout(() => {
          try {
            process.kill(-app.pid, "SIGKILL");
          } catch {}
        }, 15_000);
        try {
          current.launcherExit = await completion;
        } finally {
          clearTimeout(timer);
        }
      } else current.launcherExit = appExit;
      if (productCompleted)
        assert.deepEqual(current.launcherExit, { code: 0, signal: null });
    });
    output.end();
    await cleanup("fixture", async () => {
      await fixture?.close();
      if (!productCompleted) return;
      current.processStops = fixture.events.filter(
        (event) => event.type === "process.stopped",
      );
      for (const name of ["server", "worker"]) {
        const stopped = current.processStops.findLast(
          (event) => event.name === name,
        );
        assert.equal(stopped.code, 0);
        assert.equal(stopped.signal, null);
        assert.deepEqual(stopped.survivors, []);
      }
    });
    await cleanup("native bridge", () => bridge.close());
    await cleanup("external PostgreSQL", async () => {
      if (!cluster) return;
      await execute(path.join(cluster.pg, "pg_ctl"), [
        "-D",
        cluster.data,
        "-m",
        "fast",
        "-w",
        "stop",
      ]);
      cluster = undefined;
    });
    for (const key of Object.keys(process.env))
      if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    current.passed = productCompleted && cleanupErrors.length === 0;
    if (cleanupErrors.length) current.cleanupErrors = cleanupErrors;
    await writeFile(
      path.join(target, "report.json"),
      JSON.stringify(current, null, 2),
    );
    if (cleanupErrors.length)
      throw new Error(
        "Native acceptance cleanup failed: " + JSON.stringify(cleanupErrors),
      );
  }
}
try {
  for (const mode of modes) await run(mode);
  assert.equal(
    report.artifact.sha256,
    manifest.files.find((file) => file.path === "bin/cantrip-server").sha256,
  );
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = error.stack;
} finally {
  await writeFile(
    values.report ?? path.join(directory, "report.json"),
    JSON.stringify(report, null, 2),
  );
}
if (failure) throw failure;
