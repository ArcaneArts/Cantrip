// Real setup/restart operations for durable backend selection. This is not yet
// the complete installation-profile transfer or packaged upgrade acceptance.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildRustServer, repositoryRoot } from "./build.mjs";
import { fixtureEnvironment, startServer } from "./process.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";

const execute = promisify(execFile);
const at = process.argv.indexOf("--report");
const reportPath = at < 0 ? undefined : process.argv[at + 1];
const root = await mkdtemp(path.join(tmpdir(), "cantrip-profile-database-"));
const report = { suite: "durable-database-selection", root, modes: [] };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
let pg, failure;
try {
  const executable = await buildRustServer();
  pg = await postgresFixture(path.join(root, "database-owner"));
  const probe = async (environment) => {
    const server = await startServer(
      executable,
      ["--port", "0", "--shutdown-on-stdin-close"],
      { cwd: repositoryRoot, env: environment },
    );
    try {
      const bootstrap = await fetch(server.origin + "/api/bootstrap");
      assert.equal(bootstrap.status, 200);
      const body = await bootstrap.json();
      const ready = await fetch(server.origin + "/readyz");
      assert.equal(ready.status, 200);
      return {
        serverId: body.server.id,
        database: (await ready.json()).database.engine,
      };
    } finally {
      await server.close();
    }
  };
  for (const mode of ["pglite", "bundled-postgres", "postgres"]) {
    const data = path.join(root, mode);
    await mkdir(data);
    const environment = fixtureEnvironment(data);
    const initial = {
      ...environment,
      CANTRIP_DATABASE_MODE: mode,
      CANTRIP_POSTGRES_BIN_DIR: process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
      ...(mode === "postgres" ? { DATABASE_URL: await pg.database() } : {}),
    };
    const key = Buffer.from(
      JSON.stringify({
        version: 1,
        id: "local-v1",
        key: randomBytes(32).toString("base64"),
      }) + "\n",
    );
    await writeFile(path.join(data, "secret-encryption-key.json"), key, {
      mode: 0o600,
    });
    await execute(executable, ["--migrate-only", "--remember-database"], {
      cwd: repositoryRoot,
      env: initial,
    });
    const profile = path.join(data, "server-database.json");
    const saved = await readFile(profile);
    assert.equal(JSON.parse(saved).databaseMode, mode);
    // Neither start receives the selected mode, PostgreSQL URL or binary path.
    const first = await probe(environment);
    const second = await probe(environment);
    assert.deepEqual(second, first);
    assert.deepEqual(
      await probe({ ...environment, DATABASE_URL: " \t" }),
      first,
      "an empty environment template value retains the stored backend and connection",
    );
    assert.equal(first.database, mode === "pglite" ? "pglite" : "postgres");
    assert.deepEqual(await readFile(profile), saved);
    assert.deepEqual(
      await readFile(path.join(data, "secret-encryption-key.json")),
      key,
    );

    let actualFailure;
    try {
      await execute(executable, ["--migrate-only", "--remember-database"], {
        cwd: repositoryRoot,
        env: {
          ...environment,
          CANTRIP_DATABASE_MODE: "bundled-postgres",
          CANTRIP_POSTGRES_BIN_DIR: path.join(root, "missing-binaries"),
        },
      });
    } catch (error) {
      actualFailure = error;
    }
    assert.ok(
      actualFailure,
      "the actual missing PostgreSQL executable must fail setup",
    );
    assert.deepEqual(
      await readFile(profile),
      saved,
      "failed actual setup never commits a new selection",
    );
    assert.deepEqual(
      await probe(environment),
      first,
      "the previous selected database remains usable after failure",
    );

    // Existing DATABASE_URL configuration still deliberately selects an
    // external database, without rewriting the remembered backend.
    const overridden = await probe({
      ...environment,
      DATABASE_URL: await pg.database(),
    });
    assert.equal(overridden.database, "postgres");
    assert.notEqual(overridden.serverId, first.serverId);
    assert.deepEqual(await readFile(profile), saved);
    assert.deepEqual(await probe(environment), first);
    report.modes.push({
      mode,
      selectedEngine: first.database,
      stableServerId: first.serverId,
      profileSha256: digest(saved),
      keySha256: digest(key),
      restartsRetainIdentity: true,
      failedSetupRetainsSelection: true,
      databaseUrlOverride: true,
    });
  }
} catch (error) {
  failure = error;
  report.failure = { name: error.name, message: error.message };
} finally {
  await pg?.close();
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(JSON.stringify({ suite: report.suite, modes: report.modes }));
