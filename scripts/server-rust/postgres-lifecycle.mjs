// Real process ownership and retained-state tests. Every database is disposable.
import assert from "node:assert/strict";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { buildRustServer } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { heartbeat } from "./security-fixtures.mjs";
import { unixLifecycle } from "./postgres-lifecycle-unix.mjs";

const execute = promisify(execFile);
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const postgres = require("postgres");
const root = await mkdtemp(path.join(tmpdir(), "cantrip postgres lifecycle "));
const report = {
  suite: "private-postgres-lifecycle",
  root,
  completeReplacement: false,
  cases: [],
};
const i = process.argv.indexOf("--report");
const reportPath = i < 0 ? undefined : process.argv[i + 1];
const bin = process.env.CANTRIP_TEST_POSTGRES_BIN_DIR ?? "";
const password = "isolated lifecycle fixture password";
let fixture, control, controlSql, primary, privateRoot;

async function status() {
  try {
    const result = await execute(
      path.join(bin, `pg_ctl${process.platform === "win32" ? ".exe" : ""}`),
      ["-D", path.join(privateRoot, "data"), "status"],
    );
    return { code: 0, output: result.stdout.trim() };
  } catch (error) {
    return { code: error.code, output: error.stderr?.trim() };
  }
}
async function stopped() {
  const deadline = Date.now() + 10000;
  let last,
    attempts = 0;
  do {
    last = await status();
    attempts++;
    if (last.code === 3) return { stopped: true, attempts, last };
    if (last.code !== 0)
      throw new Error(`Owned pg_ctl status failed: ${JSON.stringify(last)}`);
    await delay(50);
  } while (Date.now() < deadline);
  return { stopped: false, attempts, last };
}
async function killServer() {
  const child = fixture.server.child;
  const completion = once(child, "close", {
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(child.kill("SIGKILL"), true);
  const [code, signal] = await completion;
  // Windows reports TerminateProcess as an exit code, rather than a Unix signal.
  if (process.platform !== "win32") assert.equal(signal, "SIGKILL");
  let diagnostic;
  try {
    await fixture.close();
  } catch (error) {
    diagnostic = error.message;
  }
  return { code, signal, diagnostic };
}
async function retained(identity, credential, label) {
  await fixture.observe(`${label} login`, "POST", "/api/auth/login", {
    client: "fresh",
    json: { email: "lifecycle@example.invalid", password },
  });
  await fixture.observe(`${label} identity`, "GET", "/api/bootstrap", {
    client: "fresh",
  });
  assert.equal(fixture.records.get(`${label} identity`).server.id, identity);
  await fixture.observe(
    `${label} credential`,
    "POST",
    "/api/internal/workers/heartbeat",
    {
      client: "worker",
      headers: { authorization: `Bearer ${credential}` },
      json: { ...heartbeat, name: `Retained ${label} worker 🦀` },
      status: 202,
    },
  );
  await fixture.observe(`${label} workers`, "GET", "/api/workers", {
    client: "fresh",
  });
  assert.ok(
    fixture.records
      .get(`${label} workers`)
      .some((w) => w.name === `Retained ${label} worker 🦀`),
  );
}

try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
  control = await postgresFixture(path.join(root, "external-control"));
  const externalUrl = await control.database();
  controlSql = postgres(externalUrl, { max: 1, connect_timeout: 2 });
  assert.equal((await controlSql`SELECT 1 AS value`)[0].value, 1);
  fixture = new HttpFixture({
    kind: "rust",
    executable,
    root,
    name: "private",
    databaseMode: "bundled-postgres",
    environment: {
      CANTRIP_AUTH_MODE: "accounts",
      CANTRIP_POSTGRES_BIN_DIR: bin,
    },
  });
  privateRoot = path.join(fixture.environment.CANTRIP_DATA_DIR, "postgres");
  await fixture.start();
  await fixture.observe("register", "POST", "/api/auth/register", {
    json: {
      email: "lifecycle@example.invalid",
      displayName: "Lifecycle fixture",
      password,
    },
    status: 201,
  });
  await fixture.observe("session", "GET", "/api/auth/session");
  await fixture.observe("identity", "GET", "/api/bootstrap");
  const identity = fixture.records.get("identity").server.id;
  await fixture.observe("code", "POST", "/api/workers/enrollment-codes", {
    csrf: true,
    json: {},
    status: 201,
  });
  await fixture.observe("enrolled", "POST", "/api/internal/workers/enroll", {
    client: "worker",
    json: { code: fixture.records.get("code").code, heartbeat },
    status: 201,
  });
  const credential = fixture.records.get("enrolled").credential;
  const pid = (
    await readFile(path.join(privateRoot, "data", "postmaster.pid"), "utf8")
  ).split("\n");
  report.initialPostmaster = Number(pid[0]);
  await fixture.close();
  const normal = await stopped();
  assert.equal(normal.stopped, true);
  await fixture.start();
  await retained(identity, credential, "normal restart");
  assert.equal((await controlSql`SELECT 1 AS value`)[0].value, 1);
  report.cases.push({
    name: "normal close and retained restart",
    ...normal,
    externalControlAlive: true,
    passed: true,
  });

  const killed = await killServer();
  const abrupt = await stopped();
  let restartError;
  // Always attempt the actual restart, even if observing process exit timed out.
  try {
    await fixture.start();
  } catch (error) {
    restartError = error.message;
  }
  const entry = {
    name: "main server SIGKILL",
    killed,
    ...abrupt,
    restartError,
  };
  report.cases.push(entry);
  assert.equal(
    abrupt.stopped,
    true,
    "Private PostgreSQL must stop after its server is killed",
  );
  assert.equal(
    restartError,
    undefined,
    "Actual restart must open the retained private cluster",
  );
  await retained(identity, credential, "abrupt restart");
  assert.equal((await controlSql`SELECT 1 AS value`)[0].value, 1);
  entry.externalControlAlive = true;
  entry.passed = true;
  await fixture.close();

  await unixLifecycle({
    executable,
    bin,
    root,
    privateRoot,
    cases: report.cases,
  });

  fixture = new HttpFixture({
    kind: "rust",
    executable,
    root,
    name: "external",
    databaseMode: "postgres",
    environment: { CANTRIP_AUTH_MODE: "accounts", DATABASE_URL: externalUrl },
  });
  await fixture.start();
  await fixture.observe("external register", "POST", "/api/auth/register", {
    json: {
      email: "external@example.invalid",
      displayName: "External fixture",
      password,
    },
    status: 201,
  });
  const externalKilled = await killServer();
  assert.equal(
    (
      await controlSql`SELECT count(*)::int AS count FROM users WHERE email='external@example.invalid'`
    )[0].count,
    1,
  );
  await fixture.start();
  await fixture.observe("external retained login", "POST", "/api/auth/login", {
    json: { email: "external@example.invalid", password },
  });
  report.cases.push({
    name: "external database survives server SIGKILL",
    killed: externalKilled,
    externalControlAlive: true,
    passed: true,
  });
} catch (error) {
  primary = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  const cleanup = await Promise.allSettled([
    fixture?.close(),
    controlSql?.end({ timeout: 2 }),
  ]);
  report.cleanup = cleanup.map((r) => ({
    status: r.status,
    message: r.reason?.message,
  }));
  if (privateRoot) {
    // Also clean up the reproduced old orphan; never touch another cluster.
    try {
      await execute(
        path.join(bin, `pg_ctl${process.platform === "win32" ? ".exe" : ""}`),
        [
          "-D",
          path.join(privateRoot, "data"),
          "stop",
          "-m",
          "fast",
          "-w",
          "-t",
          "10",
        ],
      );
    } catch (error) {
      report.cleanupStop = { code: error.code, message: error.stderr?.trim() };
    }
    report.finalPrivateStatus = await status();
  }
  try {
    await control?.close();
  } catch (error) {
    report.cleanup.push({ status: "rejected", message: error.message });
  }
  if (!primary) {
    try {
      assert.equal(
        report.finalPrivateStatus?.code,
        3,
        "Owned private PostgreSQL must be stopped after cleanup",
      );
      assert.ok(
        report.cleanup.every((r) => r.status === "fulfilled"),
        "All fixture owners must close",
      );
    } catch (error) {
      primary = error;
    }
  }
  report.passed = !primary;
  if (primary)
    report.failure = { message: primary.message, stack: primary.stack };
  if (reportPath)
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
if (primary) throw primary;
