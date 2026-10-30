import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import path from "node:path";
import { repositoryRoot } from "./build.mjs";
import { fixtureEnvironment, startServer } from "./process.mjs";

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
  };
  if (databaseMode === "bundled-postgres" && kind === "rust")
    environment.CANTRIP_POSTGRES_BIN_DIR =
      process.env.CANTRIP_TEST_POSTGRES_BIN_DIR;
  let server;
  try {
    server = await startServer(
      kind === "node" ? process.execPath : executable,
      kind === "node"
        ? ["--import", "tsx", nodeScript]
        : ["--database", databaseMode],
      { cwd: repositoryRoot, env: environment },
    );
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
          JSON.stringify({ id, ...operation }) + "\n",
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
