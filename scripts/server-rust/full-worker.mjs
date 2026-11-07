// Shared supervision for acceptance tests using the full production worker.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { repositoryRoot } from "./build.mjs";
import { fixtureEnvironment } from "./process.mjs";
import { terminateWindowsWorkerTree } from "./windows-worker-tree.mjs";

export async function eventually(read, check, timeout = 30000) {
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

export function launchActualWorker(
  fixture,
  dataDirectory,
  {
    enrollmentCode,
    cliBinary,
    chromiumExecutable,
    chromiumTraceDirectory,
    workerId = "actual-catalog-worker",
    traceShutdown = false,
    isolatedProcessGroup = false,
    homeDirectory,
    workerPackage = process.env.CANTRIP_TEST_WORKER_PACKAGE ??
      path.join(repositoryRoot, "cantrip_worker"),
    environment: extraEnvironment = {},
  } = {},
) {
  const environment = {
    ...fixtureEnvironment(dataDirectory),
    CANTRIP_SERVER_URL: fixture.server.origin,
    CANTRIP_WORKER_DATA_DIR: dataDirectory,
    CANTRIP_WORKER_ID: workerId,
    CANTRIP_WORKER_NAME: "Disposable full worker",
    CANTRIP_CLI_BIN: cliBinary,
    ...(chromiumExecutable
      ? { CANTRIP_CHROMIUM_EXECUTABLE: chromiumExecutable }
      : {}),
    ...(chromiumTraceDirectory
      ? {
          CANTRIP_TEST_CHROMIUM_TRACE: chromiumTraceDirectory,
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS,
            "--import=" +
              pathToFileURL(
                path.join(
                  repositoryRoot,
                  "scripts/server-rust/chromium-launch-trace.mjs",
                ),
              ).href,
          ]
            .filter(Boolean)
            .join(" "),
        }
      : {}),
    ...(enrollmentCode
      ? { CANTRIP_WORKER_ENROLLMENT_CODE: enrollmentCode }
      : {}),
    ...(process.env.CANTRIP_CODEX_BIN
      ? { CANTRIP_CODEX_BIN: process.env.CANTRIP_CODEX_BIN }
      : {}),
    ...extraEnvironment,
  };
  if (homeDirectory) {
    environment.CANTRIP_TEST_WORKER_HOME = homeDirectory;
    environment.NODE_OPTIONS = [
      environment.NODE_OPTIONS,
      "--import=" +
        pathToFileURL(
          path.join(repositoryRoot, "scripts/server-rust/worker-test-home.mjs"),
        ).href,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (traceShutdown)
    environment.NODE_OPTIONS = [
      environment.NODE_OPTIONS,
      "--import=" +
        pathToFileURL(
          path.join(
            repositoryRoot,
            "scripts/server-rust/worker-lifecycle-trace.mjs",
          ),
        ).href,
    ]
      .filter(Boolean)
      .join(" ");
  delete environment.CANTRIP_WORKER_TOKEN;
  const child = spawn(
    process.execPath,
    [path.join(workerPackage, "dist/index.js")],
    {
      cwd: workerPackage,
      env: environment,
      detached: isolatedProcessGroup && process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-131072);
  });
  child.stderr.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-131072);
  });
  let spawnError;
  let ready = false;
  child.once("error", (error) => {
    spawnError = error;
  });
  const completion = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  return {
    child,
    diagnostics: () => output,
    async ready() {
      await eventually(
        () => {
          if (spawnError) throw spawnError;
          if (output.includes("FATAL Cantrip Worker failed to start"))
            throw new Error(`Production worker startup failed.\n${output}`);
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error(
              `Production worker exited during startup.\n${output}`,
            );
          return output;
        },
        (value) =>
          assert.ok(
            value.includes("Worker command channel connected"),
            value.slice(-8000),
          ),
        90000,
      );
      ready = true;
    },
    async close() {
      let forced = false;
      let verifyTree;
      const deadline = Date.now() + 30000;
      const timer = setTimeout(() => {
        forced = true;
        child.kill("SIGKILL");
      }, 30000);
      try {
        if (child.exitCode === null && child.signalCode === null) {
          if (process.platform === "win32") {
            // TerminateProcess alone leaves native runtime descendants alive.
            // End the owned tree before removing its disposable profile.
            verifyTree = await terminateWindowsWorkerTree(child.pid, deadline);
          } else child.kill("SIGTERM");
        }
        const result = await completion;
        if (verifyTree) result.treeTermination = await verifyTree();
        assert.equal(forced, false, `Worker shutdown timed out.\n${output}`);
        // Windows taskkill does not deliver Node signal handlers.
        // This exercises persisted-credential restart, not Windows graceful shutdown.
        if (!ready) return result;
        if (process.platform !== "win32") {
          assert.equal(result.code, 0, `Worker failed to stop.\n${output}`);
          assert.ok(
            output.includes("Cantrip Worker stopped"),
            output.slice(-8000),
          );
        } else {
          assert.equal(
            result.code,
            1,
            `Worker tree failed to stop.\n${output}`,
          );
          assert.equal(result.signal, null);
        }
        return result;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
