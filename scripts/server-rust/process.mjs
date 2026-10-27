import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";

export function fixtureEnvironment(dataDirectory) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith("CANTRIP_") &&
        !["DATABASE_URL", "REDIS_URL"].includes(name),
    ),
  );
  return {
    ...environment,
    NODE_ENV: "test",
    CANTRIP_DATA_DIR: dataDirectory,
    CANTRIP_AUTH_MODE: "none",
    CANTRIP_DEPLOYMENT_MODE: "local",
    CANTRIP_BOOTSTRAP_MODE: "pnpm-dev",
    CANTRIP_SERVER_HOST: "127.0.0.1",
    CANTRIP_SERVER_PORT: "4310",
    CANTRIP_WORKER_TOKEN: "rust-server-isolated-compatibility-fixture",
  };
}

export async function startServer(command, arguments_, options) {
  const startedAt = performance.now();
  const child = spawn(command, arguments_, {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stderr.on("data", (chunk) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-32_768);
  });
  const completion = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let timer;
  let origin;
  try {
    origin = await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Server startup timed out.\n${diagnostics}`)),
        60_000,
      );
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        reject(
          new Error(
            `Server exited before listening (${code ?? signal}).\n${diagnostics}`,
          ),
        ),
      );
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try {
          const message = JSON.parse(line);
          if (message.event === "server.listening") resolve(message.origin);
        } catch {
          /* Native backend startup messages are not readiness evidence. */
        }
      });
    });
  } catch (error) {
    child.kill("SIGKILL");
    await completion;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return {
    child,
    origin,
    startupMs: performance.now() - startedAt,
    async close() {
      const shutdownStartedAt = performance.now();
      let forcedShutdown = false;
      if (child.exitCode === null && child.signalCode === null)
        child.stdin.end();
      const killTimer = setTimeout(() => {
        forcedShutdown = true;
        child.kill("SIGKILL");
      }, 15_000);
      try {
        const result = await completion;
        if (result.code !== 0)
          throw new Error(
            `Server did not shut down cleanly (${result.code ?? result.signal}, ${Math.round(performance.now() - shutdownStartedAt)}ms, shutdown deadline ${forcedShutdown ? "expired" : "not reached"}).\n${diagnostics}`,
          );
      } finally {
        clearTimeout(killTimer);
      }
    },
  };
}
