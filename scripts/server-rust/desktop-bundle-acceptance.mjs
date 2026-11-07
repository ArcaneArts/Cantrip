// macOS release-shell rehearsal. Build a dedicated QA identifier first and
// retain its installation/log directory as evidence; never reset app profiles.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { fixtureEnvironment } from "./process.mjs";

const execute = promisify(execFile);
const { values } = parseArgs({
  options: {
    bundle: { type: "string" },
    "data-root": { type: "string" },
    "previous-report": { type: "string" },
    report: { type: "string" },
    "external-url": { type: "string" },
    "stop-on-startup": { type: "boolean", default: false },
  },
});
const bundle = path.resolve(values.bundle);
const root = values["data-root"]
  ? path.resolve(values["data-root"])
  : await mkdtemp(path.join(tmpdir(), "cantrip-desktop-bundle-"));
await mkdir(root, { recursive: true });
const info = path.join(bundle, "Contents/Info.plist");
const property = async (name) =>
  (
    await execute("/usr/libexec/PlistBuddy", ["-c", "Print " + name, info])
  ).stdout.trim();
const identifier = await property("CFBundleIdentifier");
const binary = path.join(
  bundle,
  "Contents/MacOS",
  await property("CFBundleExecutable"),
);
const appData = path.join(homedir(), "Library/Application Support", identifier);
const previous = values["previous-report"]
  ? JSON.parse(await readFile(values["previous-report"], "utf8"))
  : null;
const report = {
  suite: "macos-native-desktop-bundle",
  bundle,
  root,
  identifier,
  appData,
  modes: [],
};
let failure;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === "ESRCH") return false;
    throw e;
  }
};
async function logRecords(source, since) {
  const directory = path.join(appData, "logs", source);
  let files;
  try {
    files = await readdir(directory);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const records = [];
  for (const file of files.filter((f) => f.endsWith(".jsonl")).sort()) {
    for (const line of (
      await readFile(path.join(directory, file), "utf8")
    ).split("\n")) {
      try {
        const r = JSON.parse(line);
        if (Date.parse(r.timestamp) >= since) records.push(r);
      } catch {}
    }
  }
  return records;
}
try {
  for (const mode of values["stop-on-startup"]
    ? ["pglite"]
    : [
        "pglite",
        "bundled-postgres",
        ...(values["external-url"] ? ["postgres"] : []),
      ]) {
    const data = path.join(root, mode);
    await mkdir(data, { recursive: true });
    const environment = fixtureEnvironment(data);
    for (const key of [
      "CANTRIP_DATA_DIR",
      "CANTRIP_WORKER_TOKEN",
      "PGLITE_RUNTIME_DIR",
    ])
      delete environment[key];
    Object.assign(environment, {
      CANTRIP_DESKTOP_DATA_DIR: data,
      CANTRIP_DATABASE_MODE: mode,
      CANTRIP_TEST_WORKER_HOME: path.join(data, "worker-home"),
      NODE_OPTIONS:
        "--import=" + new URL("./worker-test-home.mjs", import.meta.url).href,
    });
    await mkdir(environment.CANTRIP_TEST_WORKER_HOME, { recursive: true });
    if (mode === "postgres") environment.DATABASE_URL = values["external-url"];
    const since = Date.now();
    const app = spawn(binary, [], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let diagnostics = "";
    app.stdout.on(
      "data",
      (c) => (diagnostics = (diagnostics + c).slice(-262144)),
    );
    app.stderr.on(
      "data",
      (c) => (diagnostics = (diagnostics + c).slice(-262144)),
    );
    let spawnError;
    app.once("error", (e) => {
      spawnError = e;
    });
    const completion = new Promise((resolve) =>
      app.once("close", (code, signal) => resolve({ code, signal })),
    );
    const wait = async (operation) => {
      const deadline = Date.now() + 90_000;
      let error;
      for (;;) {
        if (spawnError) throw spawnError;
        if (app.exitCode !== null || app.signalCode !== null)
          throw new Error("App exited during acceptance: " + diagnostics);
        try {
          return await operation();
        } catch (e) {
          error = e;
        }
        if (Date.now() >= deadline)
          throw new Error(String(error) + "\n" + diagnostics);
        await delay(100);
      }
    };
    let children = [];
    let modeFailure;
    try {
      const origin = await wait(async () => {
        const records = await logRecords("server", since);
        const record = records.findLast(
          (r) => r.context?.event === "server.listening",
        );
        assert.ok(
          record,
          "native server startup must appear in the existing server archive",
        );
        return new URL(record.context.origin).origin;
      });
      if (values["stop-on-startup"]) {
        const ps = (await execute("ps", ["-axo", "pid,ppid,comm"])).stdout;
        children = ps.split("\n").flatMap((line) => {
          const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
          return match && Number(match[2]) === app.pid
            ? [{ pid: Number(match[1]), command: match[3] }]
            : [];
        });
        assert.ok(
          children.some((child) =>
            child.command.endsWith("/bin/cantrip-server"),
          ),
        );
        report.modes.push({
          mode,
          earlyStartupSigterm: true,
          origin,
          children,
        });
        continue;
      }
      const request = async (route, options = {}) => {
        const response = await fetch(origin + route, {
          ...options,
          headers: {
            origin: "http://127.0.0.1:5173",
            ...(options.body ? { "content-type": "application/json" } : {}),
          },
        });
        const body = await response.json();
        assert.equal(response.status, 200, JSON.stringify(body));
        return body;
      };
      assert.equal(
        (await request("/readyz")).database.engine,
        mode === "pglite" ? "pglite" : "postgres",
      );
      const bootstrap = await request("/api/bootstrap");
      assert.equal(bootstrap.server.bootstrapMode, "tauri");
      const retained = previous?.modes.find(
        (candidate) => candidate.mode === mode,
      );
      if (previous) {
        assert.ok(retained, "previous acceptance includes this storage mode");
        assert.equal(
          bootstrap.server.id,
          retained.identity,
          "server identity survives the package update",
        );
        assert.equal(
          (await request("/api/settings")).preferences.theme,
          retained.settingsTheme ?? "dark",
          "verify retained state before accepting another write",
        );
      }
      const settingsTheme = retained
        ? retained.settingsTheme === "light"
          ? "dark"
          : "light"
        : "dark";
      await request("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ theme: settingsTheme }),
      });
      assert.equal(
        (await request("/api/settings")).preferences.theme,
        settingsTheme,
      );
      const worker = await wait(async () => {
        const online = (await request("/api/workers")).find((w) => w.online);
        assert.ok(online, "real packaged worker must connect");
        await request(
          `/api/workers/${encodeURIComponent(online.workerId)}/version`,
        );
        return online;
      });
      const client = await wait(async () => {
        const records = await logRecords("client", since);
        assert.ok(
          records.some(
            (r) =>
              r.message.includes('"event":"session.refresh.completed"') &&
              r.message.includes('"status":"authenticated"'),
          ),
          "release WebView must finish encryption preparation and authenticate the existing client session",
        );
        return records;
      });
      const ps = (await execute("ps", ["-axo", "pid,ppid,comm"])).stdout;
      children = ps.split("\n").flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        return match && Number(match[2]) === app.pid
          ? [{ pid: Number(match[1]), command: match[3] }]
          : [];
      });
      assert.ok(
        children.some((c) => c.command.endsWith("/bin/cantrip-server")),
      );
      assert.ok(children.some((c) => c.command.endsWith("/runtime/node")));
      report.modes.push({
        mode,
        origin,
        identity: bootstrap.server.id,
        workerId: worker.workerId,
        realReleaseShell: true,
        rendererAnonymousSessionReady: true,
        clientRecords: client.length,
        actualWorkerCommand: true,
        serverLogsCaptured: true,
        settingsWrite: true,
        settingsTheme,
        retainedStateVerifiedBeforeWrite: Boolean(previous),
        children,
      });
    } catch (error) {
      modeFailure = error;
      throw error;
    } finally {
      app.kill("SIGTERM");
      const deadline = setTimeout(() => app.kill("SIGKILL"), 30_000);
      let result;
      try {
        result = await completion;
      } finally {
        clearTimeout(deadline);
      }
      await writeFile(path.join(data, "app-process.log"), diagnostics);
      try {
        assert.equal(
          result.code,
          0,
          "release shell must shut down cleanly: " +
            JSON.stringify(result) +
            "\n" +
            diagnostics,
        );
        for (const child of children)
          assert.equal(
            alive(child.pid),
            false,
            "owned desktop child survived app shutdown",
          );
      } catch (error) {
        if (!modeFailure) throw error;
        report.cleanupFailure = { message: error.message };
      }
      if (report.modes.at(-1)?.mode === mode)
        report.modes.at(-1).sigtermExitCode = 0;
    }
    if (values.report)
      await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  }
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
