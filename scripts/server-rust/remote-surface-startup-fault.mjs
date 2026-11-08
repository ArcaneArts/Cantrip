// Actual failed SQL at the socket admission boundary must not kill its server.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { HttpFixture } from "./http-fixture.mjs";
import { targetStateSql } from "./project-target-state.mjs";
import { SurfaceProbe } from "./remote-surface-socket-cases.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";

const { values } = parseArgs({
  options: {
    report: { type: "string" },
    runtime: { type: "string" },
    fault: { type: "string", default: "context" },
    database: { type: "string", default: "pglite" },
  },
});
assert.ok(["context", "settings"].includes(values.fault));
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(values.database));
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-surface-startup-fault-"),
);
console.error(JSON.stringify({ root }));
const report = {
  root,
  database: values.database,
  fault: values.fault,
  peers: [],
  passed: false,
};
const pg =
  values.database !== "pglite"
    ? await postgresFixture(path.join(root, "postgres"))
    : undefined;
try {
  for (const kind of values.runtime ? [values.runtime] : ["node", "rust"]) {
    const result = { kind };
    report.peers.push(result);
    const f = new HttpFixture({
      kind,
      root,
      name: "fault",
      databaseMode: values.database,
      liveSqlFixture: true,
      executable: process.env.CANTRIP_RUST_SERVER_BINARY,
      environment: {
        CANTRIP_AUTH_MODE: "none",
        CANTRIP_FIXTURE_LOGGING: "true",
        ...(pg && (kind === "node" || values.database === "postgres")
          ? { DATABASE_URL: await pg.database() }
          : {}),
        ...(kind === "rust" && values.database === "bundled-postgres"
          ? {
              CANTRIP_POSTGRES_BIN_DIR:
                process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
            }
          : {}),
      },
    });
    let p, server;
    const table =
      values.fault === "context" ? "remote_surfaces" : "user_settings";
    try {
      await f.start();
      server = f.server;
      await f.observe("session", "GET", "/api/auth/session");
      await f.sql(targetStateSql());
      await f.sql([`ALTER TABLE ${table} RENAME TO owned_socket_fault_table`]);
      p = new SurfaceProbe(
        f,
        values.fault === "context" ? "raw-browser" : "desktop",
      );
      await p.open();
      let timer;
      try {
        result.observation = await Promise.race([
          p.closed.then((value) => ({ closed: value })),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve({ deadlineExpired: true }), 2500);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      result.messages = p.history;
      result.exitBeforeShutdown = {
        code: server.child.exitCode,
        signal: server.child.signalCode,
      };
      result.recovered =
        result.observation.closed?.code === 1013 &&
        result.observation.closed?.reason === "Remote Surface unavailable" &&
        JSON.stringify(result.messages) ===
          JSON.stringify([
            {
              type: "error",
              message: "Remote Surface could not be opened.",
              recoverable: true,
            },
          ]) &&
        server.child.exitCode === null &&
        server.child.signalCode === null;
      if (server.child.exitCode === null && server.child.signalCode === null) {
        await f.sql([
          `ALTER TABLE owned_socket_fault_table RENAME TO ${table}`,
        ]);
        await f.observe(
          "server survives failed socket",
          "GET",
          "/api/bootstrap",
        );
      }
    } catch (error) {
      result.failure = error.stack;
    } finally {
      if (p)
        await p.close().catch((error) => {
          result.socketCleanupFailure = error.message;
        });
      try {
        await f.close();
      } catch (error) {
        result.shutdownFailure = error.message;
      }
      if (server) {
        result.diagnostics = server.diagnostics();
        result.exit = {
          code: server.child.exitCode,
          signal: server.child.signalCode,
        };
      }
    }
  }
} finally {
  await pg?.close();
}
report.passed = report.peers.every(
  (p) => p.recovered && p.exit?.code === 0 && !p.failure && !p.shutdownFailure,
);
if (values.report)
  await writeFile(
    path.resolve(values.report),
    JSON.stringify(report, null, 2) + "\n",
  );
console.log(
  JSON.stringify({
    root,
    passed: report.passed,
    peers: report.peers.map(({ kind, recovered, observation, exit }) => ({
      kind,
      recovered,
      observation,
      exit,
    })),
  }),
);
assert.equal(
  report.passed,
  true,
  "Failed socket admission must close recoverably and retain a usable server",
);
