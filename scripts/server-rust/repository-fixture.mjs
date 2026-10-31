import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import path from "node:path";
import { repositoryRoot } from "./build.mjs";
import { fixtureEnvironment, startServer } from "./process.mjs";
import { repositoryDebugger } from "./repository-debugger.mjs";

export async function repositoryFixture({
  kind,
  executable,
  root,
  databaseMode,
  databaseUrl,
  nodeScript = "scripts/server-rust/project-node-fixture.mjs",
  requestTimeoutMs = 15000,
}) {
  const environment = {
    ...fixtureEnvironment(path.join(root, kind)),
    ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
    ...(kind === "rust" && process.env.CANTRIP_FIXTURE_STACK_BYTES
      ? { CANTRIP_FIXTURE_STACK_BYTES: process.env.CANTRIP_FIXTURE_STACK_BYTES }
      : {}),
  };
  if (databaseMode === "bundled-postgres" && kind === "rust")
    environment.CANTRIP_POSTGRES_BIN_DIR =
      process.env.CANTRIP_TEST_POSTGRES_BIN_DIR;
  let server;
  try {
    const launch =
      kind === "rust"
        ? await repositoryDebugger(executable, ["--database", databaseMode])
        : { command: process.execPath, args: ["--import", "tsx", nodeScript] };
    server = await startServer(launch.command, launch.args, {
      cwd: repositoryRoot,
      env: environment,
    });
  } catch (error) {
    error.message = `${kind}/${databaseMode}: ${error.message}`;
    throw error;
  }
  const waiting = new Map();
  let sequence = 0;
  const lines = createInterface({ input: server.child.stdout });
  lines.on("line", (line) => {
    let result;
    try {
      result = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = waiting.get(result.id);
    if (!waiter) return;
    waiting.delete(result.id);
    clearTimeout(waiter.timer);
    waiter.resolve(result);
  });
  server.child.once("exit", (code, signal) => {
    for (const waiter of waiting.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`${kind} fixture exited (${code ?? signal})`));
    }
    waiting.clear();
  });
  return {
    diagnostics: () => server.diagnostics(),
    async request(operation) {
      const id = sequence++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(
            new Error(
              `${kind} repository operation timed out: ${operation.op}`,
            ),
          );
        }, requestTimeoutMs);
        waiting.set(id, { resolve, reject, timer });
        server.child.stdin.write(
          JSON.stringify({ id, ...operation })
            .replaceAll("\u2028", "\\u2028")
            .replaceAll("\u2029", "\\u2029") + "\n",
          (error) => {
            if (error) {
              clearTimeout(timer);
              waiting.delete(id);
              reject(error);
            }
          },
        );
      });
    },
    async seed(sql) {
      const result = await this.request({ op: "sql", sql });
      assert.equal(
        result.rejected,
        false,
        `${kind} fixture seeding: ${result.diagnostic}`,
      );
    },
    close: () => server.close(),
  };
}
