// Run an actual relocated distribution, with Node absent from the server PATH.
// This does not build from source or substitute a repository fixture executable.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { fixtureEnvironment, startServer } from "./process.mjs";

const execute = promisify(execFile);
const windows = process.platform === "win32";
const executableName = (name) => name + (windows ? ".exe" : "");
const commandInterpreter = windows
  ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe")
  : null;
const { values } = parseArgs({
  options: {
    artifact: { type: "string" },
    "data-root": { type: "string" },
    report: { type: "string" },
    "startup-timeout-ms": { type: "string" },
    "isolate-homebrew": { type: "boolean", default: false },
  },
});
const startupTimeoutMs =
  values["startup-timeout-ms"] === undefined
    ? undefined
    : Number(values["startup-timeout-ms"]);
if (startupTimeoutMs !== undefined) {
  assert.ok(
    Number.isInteger(startupTimeoutMs) &&
      startupTimeoutMs > 0 &&
      startupTimeoutMs <= 2_147_483_647,
    "--startup-timeout-ms must be an integer between 1 and 2147483647",
  );
}
const artifact = path.resolve(values.artifact);
const root = values["data-root"]
  ? path.resolve(values["data-root"])
  : await mkdtemp(path.join(tmpdir(), "cantrip-native-package-"));
await mkdir(root, { recursive: true });
const manifest = JSON.parse(
  await readFile(path.join(artifact, "native-server.json")),
);
const pgBin = path.join(artifact, manifest.postgres.bin);
const envFile = path.join(artifact, ".env");
let originalEnv;
try {
  originalEnv = await readFile(envFile);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const environment = {
  ...fixtureEnvironment(root),
  NODE_ENV: "production",
  PATH: windows
    ? [
        path.dirname(commandInterpreter),
        process.env.SystemRoot ?? "C:\\Windows",
      ].join(path.delimiter)
    : "/usr/bin:/bin:/usr/sbin:/sbin",
  LD_LIBRARY_PATH: path.join(artifact, "lib"),
};
for (const name of [
  "CANTRIP_DATA_DIR",
  "CANTRIP_BOOTSTRAP_MODE",
  "CANTRIP_WORKER_TOKEN",
  "PGLITE_RUNTIME_DIR",
])
  delete environment[name];
const report = {
  suite: "relocated-native-server-artifact",
  artifact,
  root,
  target: manifest.target,
  platform: process.platform,
  driverArchitecture: process.arch,
  shutdownMethod: windows ? "supervision-stdin-close" : "SIGTERM",
  startupTimeoutMs,
  shutdownTimeoutMs: 15_000,
  shutdowns: [],
  modes: [],
};
const launcher = (name) =>
  path.join(artifact, name + (windows ? ".cmd" : ".sh"));
// Double-quoted dotenv values interpret backslash-n and backslash-r. Use
// Windows' other path separator for quoted fixture paths.
const dotenvPath = (value) => (windows ? value.replaceAll("\\", "/") : value);
const batch = (command) => windows && command.endsWith(".cmd");
const runtimeCommand = (command, arguments_) => {
  if (batch(command)) {
    const quoted = [command, ...arguments_]
      .map((value) => `"${value.replaceAll('"', '""')}"`)
      .join(" ");
    return [commandInterpreter, ["/d", "/s", "/c", `"${quoted}"`]];
  }
  return values["isolate-homebrew"]
    ? [
        "/usr/bin/sandbox-exec",
        [
          "-p",
          `(version 1)(allow default)(deny file-read* (subpath "/opt/homebrew"))(deny file-write* (subpath ${JSON.stringify(artifact)}))`,
          command,
          ...arguments_,
        ],
      ]
    : [command, arguments_];
};
const runtimeOptions = (command, options) =>
  batch(command) ? { ...options, windowsVerbatimArguments: true } : options;
const executeRuntime = (command, arguments_, options) => {
  const [executable, args] = runtimeCommand(command, arguments_);
  return execute(executable, args, runtimeOptions(command, options));
};
const startRuntime = (command, arguments_, options) =>
  startServer(
    ...runtimeCommand(command, arguments_),
    runtimeOptions(command, { ...options, startupTimeoutMs }),
  );
async function stop(server, mode, phase) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) {
    assert.fail(
      "server exited before the shutdown check: " + server.diagnostics(),
    );
  }
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const observation = { mode, phase, pid: server.child.pid, forced: false };
  report.shutdowns.push(observation);
  server.child.once("exit", (code, signal) => {
    observation.exit = { code, signal, elapsedMs: elapsed() };
  });
  const closed = new Promise((resolve) =>
    server.child.once("close", (code, signal) => resolve({ code, signal })),
  );
  const deadline = setTimeout(() => {
    observation.forced = true;
    observation.deadlineElapsedMs = elapsed();
    server.child.kill("SIGKILL");
  }, report.shutdownTimeoutMs);
  try {
    // Windows Node SIGTERM terminates a process; it cannot exercise the native
    // graceful signal handler. The desktop supervises this private stdin pipe.
    if (windows) server.child.stdin.end();
    else server.child.kill("SIGTERM");
    const result = await closed;
    observation.close = { ...result, elapsedMs: elapsed() };
    observation.serverStartedShutdown = server.events.some(
      (event) => event.event === "server.shutdown.started",
    );
    observation.stages = server.events
      .filter((event) => event.event === "server.shutdown.stage")
      .map(({ stage, phase, durationMs }) => ({ stage, phase, durationMs }));
    assert.equal(
      observation.forced,
      false,
      `${mode} ${phase}: ${report.shutdownMethod} must finish without forced termination`,
    );
    assert.equal(
      result.code,
      0,
      `${report.shutdownMethod} result ${JSON.stringify(result)}: ${server.diagnostics()}`,
    );
  } finally {
    clearTimeout(deadline);
  }
}
async function writeReport() {
  if (!values.report) return;
  await mkdir(path.dirname(values.report), { recursive: true });
  await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
}

let postgresStarted = false,
  failure;
const externalDirectory = path.join(root, "external");
try {
  // The test driver may use Node. The actual distribution and database children
  // receive only the restricted runtime PATH, and the final image has no Node.
  let nodeUnavailable = false;
  try {
    // Probe from cmd.exe on Windows: CreateProcess otherwise searches the test
    // driver's own Node directory even when that directory is absent from PATH.
    await execute(
      windows ? commandInterpreter : "node",
      windows ? ["/d", "/c", "node --version & exit /b"] : ["--version"],
      { cwd: root, env: environment, windowsVerbatimArguments: windows },
    );
  } catch (error) {
    if (error.code === "ENOENT" || (windows && error.code === 9009))
      nodeUnavailable = true;
    else throw error;
  }
  assert.ok(
    nodeUnavailable,
    "Node must actually be absent from the runtime PATH",
  );
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  await executeRuntime(
    path.join(pgBin, executableName("initdb")),
    [
      "-D",
      externalDirectory,
      "-U",
      "cantrip",
      "-A",
      "trust",
      "--no-locale",
      "-E",
      "UTF8",
    ],
    { env: environment },
  );
  const postgresStartArguments = [
    "-D",
    externalDirectory,
    "-l",
    path.join(root, "external.log"),
    "-o",
    `-h 127.0.0.1 -p ${port}${windows ? "" : " -k /tmp"}`,
    "-w",
    "start",
  ];
  if (windows) {
    // pg_ctl's intermediate cmd.exe retains inherited pipes while PostgreSQL
    // runs. The external fixture must not wait for those pipes to close.
    const child = spawn(
      path.join(pgBin, executableName("pg_ctl")),
      postgresStartArguments,
      {
        env: environment,
        stdio: "ignore",
      },
    );
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(
      code,
      0,
      "external PostgreSQL startup: " +
        (await readFile(path.join(root, "external.log"), "utf8")),
    );
  } else {
    await executeRuntime(
      path.join(pgBin, executableName("pg_ctl")),
      postgresStartArguments,
      { env: environment },
    );
  }
  postgresStarted = true;
  const externalUrl = `postgresql://cantrip@127.0.0.1:${port}/postgres`;
  for (const mode of ["pglite", "bundled-postgres", "postgres"]) {
    const data = path.join(root, mode);
    const startupMs = [];
    await mkdir(data);
    const dotenv =
      [
        `CANTRIP_DATA_DIR="${dotenvPath(data)}"`,
        "CANTRIP_BOOTSTRAP_MODE=standalone",
        // Process environment and CLI flags must take precedence over the file.
        "CANTRIP_AUTH_MODE=invalid-overridden-by-process",
        "CANTRIP_SERVER_HOST=invalid-overridden-by-process",
        "CANTRIP_SERVER_PORT=invalid-overridden-by-cli",
        ...(mode === "postgres"
          ? [`DATABASE_URL=${externalUrl}`]
          : [`CANTRIP_DATABASE_MODE=${mode}`]),
      ].join("\n") + "\n";
    await writeFile(path.join(artifact, ".env"), dotenv);
    const launch = async (extra = {}, additionalArguments = []) => {
      const server = await startRuntime(
        launcher("start"),
        ["--port", "0", "--shutdown-on-stdin-close", ...additionalArguments],
        { cwd: root, env: { ...environment, ...extra } },
      );
      startupMs.push(server.startupMs);
      return server;
    };
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
        assert.equal(response.status, 200, `${route}: ${JSON.stringify(body)}`);
        if (body.csrfToken) csrf = body.csrfToken;
        return body;
      };
      await request("/api/auth/session");
      const ready = await request("/readyz");
      assert.equal(
        ready.database.engine,
        mode === "pglite" ? "pglite" : "postgres",
      );
      const bootstrap = await request("/api/bootstrap");
      assert.equal(bootstrap.server.bootstrapMode, "standalone");
      if (mutate)
        await request("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({ theme: "dark" }),
        });
      const settings = await request("/api/settings");
      assert.equal(settings.preferences.theme, "dark");
      return bootstrap.server.id;
    };
    const first = await launch();
    let identity;
    try {
      identity = await visit(first, true);
    } finally {
      await stop(first, mode, "initial");
    }
    // The separate migration launcher must operate on the same existing data.
    await executeRuntime(launcher("migrate"), ["--port", "0"], {
      cwd: root,
      env: environment,
    });
    const exported = await executeRuntime(
      launcher("migrate"),
      ["--port", "0", "--export-sql", path.join(root, `${mode}-export.sql`)],
      { cwd: root, env: environment },
    );
    const exportEvent = exported.stdout
      .split("\n")
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      })
      .find((event) => event.event === "database.export.completed");
    assert.ok(
      exportEvent,
      "the bundled tools must perform a real native SQL export",
    );
    const sql = await readFile(path.join(root, `${mode}-export.sql`));
    assert.equal(sql.length, exportEvent.receipt.bytes);
    assert.equal(
      createHash("sha256").update(sql).digest("hex"),
      exportEvent.receipt.sha256,
    );
    const reopened = await launch();
    try {
      assert.equal(await visit(reopened, false), identity);
    } finally {
      await stop(reopened, mode, "reopen");
    }
    // Hosted startup can use the same selected backend and identity.
    const key = {
      id: "package-fixture",
      key: randomBytes(32).toString("base64"),
    };
    const hosted = await launch({
      CANTRIP_DEPLOYMENT_MODE: "hosted",
      CANTRIP_BOOTSTRAP_MODE: "hosted",
      CANTRIP_AUTH_MODE: "accounts",
      CANTRIP_ADMIN_EMAIL: "native-package@example.invalid",
      CANTRIP_APP_ORIGINS: "https://app.example.invalid",
      CANTRIP_PUBLIC_ORIGIN: "https://api.example.invalid",
      CANTRIP_TRUSTED_PROXIES: "loopback",
      CANTRIP_SECRET_ENCRYPTION_KEYS: JSON.stringify({ [key.id]: key.key }),
    });
    try {
      const response = await fetch(hosted.origin + "/api/bootstrap", {
        headers: {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "api.example.invalid",
        },
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.server.id, identity);
      assert.equal(body.server.deploymentMode, "hosted");
      assert.equal(body.server.bootstrapMode, "hosted");
    } finally {
      await stop(hosted, mode, "hosted");
    }
    if (mode === "pglite") {
      const emptyRuntime = path.join(root, "empty-configured-runtime");
      await mkdir(emptyRuntime);
      await writeFile(
        envFile,
        dotenv + `PGLITE_RUNTIME_DIR="${dotenvPath(emptyRuntime)}"\n`,
      );
      await assert.rejects(
        launch({}, ["--data-dir", path.join(root, "invalid-runtime-profile")]),
        /initdb|No such file|not found|cannot find the (?:file|path) specified/i,
      );
      const configured = await launch({
        PGLITE_RUNTIME_DIR: path.join(artifact, "pglite"),
      });
      try {
        assert.equal(
          await visit(configured, false),
          identity,
          "process configuration precedes the file and bundled PGlite fallback",
        );
      } finally {
        await stop(configured, mode, "configured-runtime");
      }
      await writeFile(envFile, dotenv);
    }
    if (mode === "bundled-postgres") {
      await executeRuntime(
        launcher("migrate"),
        ["--port", "0", "--remember-database"],
        { cwd: root, env: environment },
      );
      await writeFile(
        envFile,
        dotenv
          .split("\n")
          .filter((line) => !line.startsWith("CANTRIP_DATABASE_MODE="))
          .join("\n"),
      );
      // Distribution fallbacks are deliberately not saved as installation
      // paths: an update may relocate its bundled PostgreSQL binaries.
      const portableSelection = JSON.parse(
        await readFile(path.join(data, "server-database.json"), "utf8"),
      );
      assert.deepEqual(portableSelection, {
        version: 1,
        runtime: "rust",
        databaseMode: "bundled-postgres",
      });
      const portable = await launch();
      try {
        assert.equal(await visit(portable, false), identity);
      } finally {
        await stop(portable, mode, "portable-selection");
      }
      // A user's explicit binary selection is saved and must continue to win
      // over a different distribution fallback. Exercise the actual selection.
      await executeRuntime(
        launcher("migrate"),
        ["--port", "0", "--postgres-bin-dir", pgBin, "--remember-database"],
        { cwd: root, env: environment },
      );
      const saved = await startRuntime(
        path.join(artifact, "bin", executableName("cantrip-server")),
        [
          "--env-file-if-exists",
          envFile,
          "--bundled-postgres-bin-dir",
          path.join(root, "unused-missing-fallback"),
          "--port",
          "0",
          "--shutdown-on-stdin-close",
        ],
        { cwd: root, env: environment },
      );
      startupMs.push(saved.startupMs);
      try {
        assert.equal(
          await visit(saved, false),
          identity,
          "stored database settings precede the distribution fallback",
        );
      } finally {
        await stop(saved, mode, "saved-binary-selection");
      }
      await writeFile(
        path.join(artifact, ".env"),
        dotenv +
          `CANTRIP_POSTGRES_BIN_DIR=${path.join(root, "missing-postgres")}\n`,
      );
      await assert.rejects(
        launch(),
        /initdb|No such file|not found|cannot find the (?:file|path) specified/i,
      );
      const explicit = await launch({ CANTRIP_POSTGRES_BIN_DIR: pgBin });
      try {
        assert.equal(await visit(explicit, false), identity);
      } finally {
        await stop(explicit, mode, "explicit-binary-selection");
      }
    }
    report.modes.push({
      mode,
      startupMs,
      identity,
      engine: mode === "pglite" ? "pglite" : "postgres",
      settingsWriteAndRestart: true,
      migrationLauncher: true,
      sqlExport: exportEvent,
      ...(windows ? { supervisionStdinClose: true } : { sigterm: true }),
      hostedReopen: true,
      dotenvAndProcessAndCliPrecedence: true,
    });
  }
  await executeRuntime(
    path.join(artifact, "bin", executableName("cantrip-server")),
    [
      "--migrate-only",
      "--database",
      "pglite",
      "--data-dir",
      path.join(root, "embedded-profile"),
    ],
    {
      cwd: root,
      env: {
        ...environment,
        CANTRIP_BOOTSTRAP_MODE: "standalone",
        PGLITE_RUNTIME_DIR: path.join(root, "embedded-runtime"),
      },
    },
  );
  report.embeddedRuntimeFallback = true;
  for (const entry of manifest.files) {
    const bytes = await readFile(path.join(artifact, entry.path));
    assert.equal(bytes.length, entry.bytes, entry.path + " size");
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      entry.sha256,
      entry.path + " digest",
    );
  }
  report.verifiedFiles = manifest.files.length;
  for (const launcher of ["start.cmd", "migrate.cmd"]) {
    const contents = await readFile(path.join(artifact, launcher), "utf8");
    assert.ok(contents.includes("\r\n"), launcher + " uses actual CRLF");
    assert.ok(
      !contents.includes("\\r\\n"),
      launcher + " has no literal escaped line endings",
    );
  }
  report.windowsLauncherEncodingVerified = true;
  report.serverRuntimePathHasNoNode = true;
  report.homebrewAccessDenied = values["isolate-homebrew"];
  report.artifactWritesDenied = values["isolate-homebrew"];
} catch (error) {
  failure = error;
  report.failure = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
} finally {
  // Keep the failing stage and shutdown observations even if fixture cleanup
  // itself stalls or fails.
  if (failure) await writeReport();
  try {
    if (originalEnv) await writeFile(envFile, originalEnv);
    else await rm(envFile, { force: true });
  } catch (error) {
    report.environmentRestoreFailure = error.message;
    failure ??= error;
  }
  try {
    if (postgresStarted)
      await executeRuntime(
        path.join(pgBin, executableName("pg_ctl")),
        ["-D", externalDirectory, "-m", "fast", "-w", "stop"],
        { env: environment },
      );
  } catch (error) {
    report.externalPostgresShutdownFailure = error.message;
    failure ??= error;
  }
  await writeReport();
}
if (failure) throw failure;
console.log(JSON.stringify(report));
