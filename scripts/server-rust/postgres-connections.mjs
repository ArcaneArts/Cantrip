// Actual SSL-on/off PostgreSQL and real Node/Rust service entrypoints.
// Rejected Node connections use the same driver/options as connectPostgres;
// accepted configurations additionally run the complete reference service.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, repositoryRoot } from "./build.mjs";
import { fixtureEnvironment, startServer } from "./process.mjs";

const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const postgres = require("postgres");
// This URL-policy matrix owns its TLS choices. Do not let a developer's shell
// change the omitted-option baseline or disable the strict rejection control.
delete process.env.PGSSL;
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
const root = await mkdtemp(path.join(tmpdir(), "cantrip-pg-tls-"));
const directory = path.join(root, "postgres");
const bin = process.env.CANTRIP_TEST_POSTGRES_BIN_DIR;
const reportAt = process.argv.indexOf("--report");
const reportPath = reportAt < 0 ? undefined : process.argv[reportAt + 1];
const report = {
  suite: "postgres-connection-compatibility",
  completeReplacement: false,
  root,
  cases: [],
};
const binary = (name) =>
  path.join(bin, process.platform === "win32" ? name + ".exe" : name);
let startAttempted = false,
  failure;

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 30000,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${executable} exited ${result.status}: ${result.stderr}\n${result.stdout}`,
    );
  return result.stdout;
}

async function concurrency(origin, url) {
  const control = new URL(url);
  control.searchParams.set("application_name", "cantrip-concurrency-control");
  const locker = postgres(control.href, { max: 1, ssl: false });
  const inspector = postgres(control.href, { max: 1, ssl: false });
  let held = false,
    blocked,
    independent,
    result,
    failure;
  const request = async (route) => {
    const start = performance.now();
    const response = await fetch(origin + route, {
      headers: { origin: "http://127.0.0.1:5173" },
      signal: AbortSignal.timeout(30000),
    });
    return {
      status: response.status,
      body: await response.json(),
      elapsedMs: performance.now() - start,
    };
  };
  try {
    await locker`BEGIN`;
    held = true;
    const [{ pid }] = await locker`SELECT pg_backend_pid() AS pid`;
    await locker`LOCK TABLE workers IN ACCESS EXCLUSIVE MODE`;
    blocked = request("/api/workers");
    blocked.catch(() => {});
    const waiting = async () =>
      (
        await inspector`SELECT pid, wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`
      ).find((row) => row.blockers.includes(pid));
    let actual;
    const deadline = performance.now() + 10000;
    while (!(actual = await waiting())) {
      assert.ok(
        performance.now() < deadline,
        "Actual server query must reach the held relation lock",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    independent = request("/api/account/sessions");
    independent.catch(() => {});
    let timer;
    const observed = await Promise.race([
      independent.then((value) => ({ state: "completed", ...value })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ state: "pending" }), 3000);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(
      observed.state,
      "completed",
      "Unrelated HTTP request must complete while workers stays locked",
    );
    assert.equal(observed.status, 200);
    assert.deepEqual(observed.body, []);
    const stillWaiting = await waiting();
    assert.equal(
      stillWaiting?.pid,
      actual.pid,
      "Original query must still be blocked when unrelated request completes",
    );
    await locker`ROLLBACK`;
    held = false;
    const released = await blocked;
    assert.equal(released.status, 200);
    result = {
      waitEventType: actual.wait_event_type,
      waitEvent: actual.wait_event,
      lockerVerified: true,
      independentWhileLocked: observed,
      blockedAfterRelease: released,
    };
  } catch (error) {
    failure = error;
  } finally {
    const cleanups = [];
    if (held) cleanups.push(...(await Promise.allSettled([locker`ROLLBACK`])));
    cleanups.push(...(await Promise.allSettled([blocked, independent])));
    cleanups.push(
      ...(await Promise.allSettled([
        locker.end({ timeout: 5 }),
        inspector.end({ timeout: 5 }),
      ])),
    );
    const errors = cleanups
      .filter((value) => value.status === "rejected")
      .map((value) => value.reason);
    if (errors.length)
      failure = new AggregateError(
        [...(failure ? [failure] : []), ...errors],
        "HTTP concurrency or cleanup failed",
      );
  }
  if (failure) throw failure;
  return result;
}

try {
  const executable = await buildRustServer();
  await mkdir(directory, { mode: 0o700 });
  run(binary("initdb"), [
    "-D",
    directory,
    "-A",
    "trust",
    "--no-locale",
    "-E",
    "UTF8",
    "-U",
    "cantrip_tls_fixture",
  ]);
  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    path.join(directory, "server.key"),
    "-out",
    path.join(directory, "server.crt"),
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost",
  ]);
  await chmod(path.join(directory, "server.key"), 0o600);
  const reservation = net.createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const { port } = reservation.address();
  await new Promise((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  await appendFile(
    path.join(directory, "postgresql.conf"),
    `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nunix_socket_directories = ''\nssl = on\n`,
  );
  const log = await open(path.join(root, "postgres.log"), "a");
  try {
    startAttempted = true;
    // A detached Windows postmaster can keep captured launcher pipes open
    // after pg_ctl exits. Match the native owner: inherit null stdin and the
    // append log directly, without -l reopening that Windows file handle.
    run(binary("pg_ctl"), ["-D", directory, "-w", "-t", "15", "start"], {
      stdio: ["ignore", log.fd, log.fd],
    });
  } finally {
    await log.close();
  }
  const base = `postgres://cantrip_tls_fixture@127.0.0.1:${port}/postgres`;
  const admin = postgres(base, { ssl: false, max: 1 });
  try {
    for (const sslEnabled of [true, false]) {
      if (!sslEnabled) {
        await admin`ALTER SYSTEM SET ssl = off`;
        await admin`SELECT pg_reload_conf()`;
        const deadline = Date.now() + 5000;
        while (
          (await admin`SELECT current_setting('ssl') AS value`)[0].value !==
          "off"
        ) {
          assert.ok(
            Date.now() < deadline,
            "Actual PostgreSQL SSL configuration did not reload",
          );
        }
      }
      for (const [index, mode] of (sslEnabled
        ? [undefined, "disable", "prefer", "require", "verify-full"]
        : [undefined, "disable", "prefer", "require"]
      ).entries()) {
        const name = `cantrip_tls_${sslEnabled ? "on" : "off"}_${index}`;
        await admin`CREATE DATABASE ${admin(name)}`;
        const url = new URL(base);
        url.pathname = `/${name}`;
        url.searchParams.set("application_name", name);
        if (mode) url.searchParams.set("sslmode", mode);
        const entry = {
          sslEnabled,
          mode: mode ?? "omitted",
          node: {},
          rust: {},
        };
        const sql = postgres(url.href, { connect_timeout: 2, max: 5 });
        try {
          const [row] =
            await sql`SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()`;
          entry.node = { connected: true, ssl: row.ssl };
        } catch (error) {
          entry.node = {
            connected: false,
            message: error.message,
            code: error.code,
          };
        } finally {
          await sql.end({ timeout: 5 });
        }
        if (entry.node.connected) {
          let reference;
          try {
            const data = path.join(root, `node-server-${name}`);
            reference = await startServer(
              process.execPath,
              ["--import", "tsx", "scripts/server-rust/node-server.mjs"],
              {
                cwd: repositoryRoot,
                env: { ...fixtureEnvironment(data), DATABASE_URL: url.href },
              },
            );
            const response = await fetch(`${reference.origin}/healthz`);
            assert.equal(response.status, 200);
            const rows =
              await admin`SELECT ssl.ssl FROM pg_stat_ssl ssl JOIN pg_stat_activity activity ON activity.pid=ssl.pid WHERE activity.application_name=${name}`;
            assert.ok(rows.length >= 1);
            assert.ok(rows.every((row) => row.ssl === entry.node.ssl));
            entry.node.server = {
              connected: true,
              ssl: rows.map((row) => row.ssl),
              healthStatus: response.status,
            };
            if (sslEnabled && mode === "require")
              entry.node.server.concurrency = await concurrency(
                reference.origin,
                url.href,
              );
          } catch (error) {
            entry.node.server = { connected: false, message: error.message };
          } finally {
            await reference?.close();
          }
        }
        let server;
        try {
          const data = path.join(root, `server-${name}`);
          server = await startServer(
            executable,
            [
              "--database",
              "postgres",
              "--database-url",
              url.href,
              "--port",
              "0",
              "--shutdown-on-stdin-close",
            ],
            { cwd: repositoryRoot, env: fixtureEnvironment(data) },
          );
          const response = await fetch(`${server.origin}/healthz`);
          assert.equal(response.status, 200);
          const rows =
            await admin`SELECT ssl.ssl FROM pg_stat_ssl ssl JOIN pg_stat_activity activity ON activity.pid=ssl.pid WHERE activity.application_name=${name}`;
          assert.ok(rows.length >= 1);
          assert.ok(rows.every((row) => row.ssl === rows[0].ssl));
          entry.rust = {
            connected: true,
            ssl: rows[0].ssl,
            connections: rows.length,
            healthStatus: response.status,
          };
          if (sslEnabled && mode === "require")
            entry.rust.concurrency = await concurrency(server.origin, url.href);
        } catch (error) {
          entry.rust = { connected: false, message: error.message };
        } finally {
          await server?.close();
        }
        report.cases.push(entry);
        if (entry.node.connected)
          assert.equal(
            entry.node.server?.connected,
            true,
            "Full reference service must reach HTTP readiness",
          );
        assert.equal(
          entry.rust.connected,
          entry.node.connected,
          `Connection acceptance: SSL ${sslEnabled}, ${entry.mode}`,
        );
        if (entry.node.connected)
          assert.equal(
            entry.rust.ssl,
            entry.node.ssl,
            `Actual pg_stat_ssl: ${entry.mode}`,
          );
        if (mode === "verify-full")
          assert.match(entry.rust.message, /TLS|certificate|trust|handshake/i);
        console.log(JSON.stringify(entry));
      }
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
} catch (error) {
  failure = error;
  report.failure = error.stack;
} finally {
  report.databaseStopped = false;
  try {
    // A launcher observation error does not prove the database never started.
    // Always attempt actual shutdown for this unique owned data directory.
    if (startAttempted)
      run(binary("pg_ctl"), [
        "-D",
        directory,
        "-m",
        "fast",
        "-w",
        "-t",
        "15",
        "stop",
      ]);
    report.databaseStopped = startAttempted;
  } catch (error) {
    report.cleanupFailure = error.stack;
    failure = failure
      ? new AggregateError(
          [failure, error],
          "PostgreSQL conformance and cleanup failed",
        )
      : error;
    report.failure ??= error.stack;
  }
  report.postgresLog = await readFile(
    path.join(root, "postgres.log"),
    "utf8",
  ).catch(() => "");
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  if (!report.failure) await rm(root, { recursive: true, force: true });
  else console.error(`Retained PostgreSQL TLS fixture: ${root}`);
}
if (failure) throw failure;
