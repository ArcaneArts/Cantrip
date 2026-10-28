// Shared supervision for acceptance tests using the full production worker.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { repositoryRoot } from "./build.mjs";
import { fixtureEnvironment } from "./process.mjs";

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
  { enrollmentCode, cliBinary, workerId = "actual-catalog-worker" } = {},
) {
  const environment = {
    ...fixtureEnvironment(dataDirectory),
    CANTRIP_SERVER_URL: fixture.server.origin,
    CANTRIP_WORKER_DATA_DIR: dataDirectory,
    CANTRIP_WORKER_ID: workerId,
    CANTRIP_WORKER_NAME: "Disposable full worker",
    CANTRIP_CLI_BIN: cliBinary,
    ...(enrollmentCode
      ? { CANTRIP_WORKER_ENROLLMENT_CODE: enrollmentCode }
      : {}),
    ...(process.env.CANTRIP_CODEX_BIN
      ? { CANTRIP_CODEX_BIN: process.env.CANTRIP_CODEX_BIN }
      : {}),
  };
  delete environment.CANTRIP_WORKER_TOKEN;
  const child = spawn(
    process.execPath,
    [path.join(repositoryRoot, "cantrip_worker/dist/index.js")],
    {
      cwd: path.join(repositoryRoot, "cantrip_worker"),
      env: environment,
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
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      const timer = setTimeout(() => {
        forced = true;
        child.kill("SIGKILL");
      }, 30000);
      try {
        const result = await completion;
        assert.equal(forced, false, `Worker shutdown timed out.\n${output}`);
        // Windows TerminateProcess does not deliver Node signal handlers.
        // This exercises persisted-credential restart, not Windows graceful shutdown.
        if (!ready) return result;
        if (process.platform !== "win32") {
          assert.equal(result.code, 0, `Worker failed to stop.\n${output}`);
          assert.ok(
            output.includes("Cantrip Worker stopped"),
            output.slice(-8000),
          );
        } else assert.equal(result.signal, "SIGTERM");
        return result;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
