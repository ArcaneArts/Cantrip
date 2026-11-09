// Real SQL/connection failures in disposable profiles; production handlers and
// probes run unchanged. No fake ping result or startup rejection is installed.
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import {
  operationalProbeSchema,
  systemHealthSchema,
} from "../../packages/protocol/dist/index.js";
import { HttpFixture } from "./http-fixture.mjs";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { password } from "./security-fixtures.mjs";
import { prometheus } from "./operational-status-http-cases.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    profile: { type: "string" },
    runtime: { type: "string" },
    report: { type: "string" },
  },
});
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(values.database));
assert.ok(!values.runtime || ["node", "rust"].includes(values.runtime));
assert.ok(
  !values.profile || ["none", "password", "accounts"].includes(values.profile),
);
const root = await mkdtemp(path.join(tmpdir(), "cantrip-operational-faults-"));
console.error(JSON.stringify({ event: "operational-faults.created", root }));
const report = {
  root,
  database: values.database,
  completeReplacement: false,
  profiles: [],
};
const token = "disposable-operation-metrics-".repeat(3),
  origin = "http://127.0.0.1:5173";
let pg, failure;
async function peer(options, result) {
  const { profile, kind } = options;
  const f = new HttpFixture({
    ...options,
    name: "faults-" + profile,
    liveSqlFixture: true,
    environment: {
      CANTRIP_AUTH_MODE: profile,
      CANTRIP_METRICS_TOKEN: token,
      CANTRIP_REGISTRATION_ENABLED: "true",
      ...(profile === "password"
        ? { CANTRIP_PASSWORD_HASH: options.passwordHash }
        : {}),
      ...(options.url ? { DATABASE_URL: options.url } : {}),
      ...(kind === "rust" && values.database === "bundled-postgres"
        ? {
            CANTRIP_POSTGRES_BIN_DIR: process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
          }
        : {}),
    },
  });
  result.processes = [];
  let capture;
  async function start(port) {
    await f.start(port === undefined ? {} : { port });
    const server = f.server;
    const record = {
      index: result.processes.length,
      startupDiagnostics: server.diagnostics(),
    };
    result.processes.push(record);
    const stdout = [],
      stderr = [];
    server.child.stdout.on("data", (chunk) => stdout.push(chunk));
    server.child.stderr.on("data", (chunk) => stderr.push(chunk));
    capture = { server, record, stdout, stderr };
  }
  async function close() {
    if (!f.server) return;
    const current = capture;
    try {
      await f.close();
    } finally {
      const exit = {
        code: current.server.child.exitCode,
        signal: current.server.child.signalCode,
      };
      current.record.exit = exit;
      result.exits.push(exit);
      for (const stream of ["stdout", "stderr"]) {
        const file = path.join(
          root,
          `fault-${profile}-${kind}-${current.record.index}.${stream}.log`,
        );
        await writeFile(file, Buffer.concat(current[stream]));
        current.record[stream] = file;
      }
      current.record.diagnostics = current.server.diagnostics();
    }
  }
  async function request(
    name,
    method,
    route,
    { status = 200, publicClient = false, json, fixtureControl = false } = {},
  ) {
    const c = f.client(publicClient ? "public" : "main"),
      started = Date.now();
    const response = await fetch(f.server.origin + route, {
      method,
      headers: {
        origin,
        ...(publicClient ? { authorization: "Bearer " + token } : {}),
        ...(c.cookies.size
          ? { cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ") }
          : {}),
        ...(c.csrf ? { "x-cantrip-csrf": c.csrf } : {}),
        ...(json === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text(),
      type = response.headers.get("content-type"),
      id = response.headers.get("x-request-id");
    assert.equal(response.status, status, name + ": " + text);
    if (!fixtureControl) assert.match(id, /^[a-f0-9-]{36}$/);
    const body =
      text && type?.startsWith("application/json") ? JSON.parse(text) : text;
    result.raw.push({
      name,
      method,
      route,
      status,
      headers: Object.fromEntries(response.headers),
      body,
    });
    if (method === "HEAD") assert.equal(text, "");
    if (route === "/readyz" && method !== "HEAD") {
      assert.deepEqual(operationalProbeSchema.parse(body), body);
      assert.ok(
        Date.parse(body.timestamp) >= started - 1000 &&
          Date.parse(body.timestamp) <= Date.now() + 1000,
      );
    }
    if (route === "/api/health" && status === 200)
      assert.deepEqual(systemHealthSchema.parse(body), body);
    if (status === 500) {
      assert.equal(text.includes("SELECT"), false);
      assert.equal(text.includes("workers"), false);
      assert.equal(text.includes("database is closed"), false);
    }
    const normalize = (x) =>
      Array.isArray(x)
        ? x.map(normalize)
        : x && typeof x === "object"
          ? Object.fromEntries(
              Object.entries(x).map(([k, v]) => [k, normalize(v)]),
            )
          : typeof x === "string" && id
            ? x.replaceAll(id, "<request-id>")
            : x;
    if (!fixtureControl && route !== "/metrics")
      result.cases.push({
        name,
        method,
        route,
        status,
        body:
          route === "/readyz" || route === "/healthz"
            ? {
                ...body,
                timestamp: body.timestamp ? "<validated timestamp>" : undefined,
                ...(body.database
                  ? {
                      database: {
                        ...body.database,
                        latencyMs: "<nonnegative measured latency>",
                      },
                    }
                  : {}),
              }
            : route === "/api/health" && status === 200
              ? {
                  status: body.status,
                  engine: body.database.engine,
                  ready: body.database.ready,
                }
              : normalize(body),
      });
    return body;
  }
  const scrape = (name) =>
    request(name, "GET", "/metrics", { publicClient: true }).then(prometheus);
  let primaryFailure;
  try {
    await start();
    if (profile === "accounts")
      await f.observe("register", "POST", "/api/auth/register", {
        status: 201,
        json: {
          email: "faults@example.invalid",
          displayName: "Fault fixture",
          password,
        },
      });
    else {
      await f.observe("session", "GET", "/api/auth/session");
      if (profile === "password")
        await f.observe("login", "POST", "/api/auth/login", {
          json: { password },
        });
    }
    await f.observe("bootstrap", "GET", "/api/bootstrap");
    const serverId = f.records.get("bootstrap").server.id;
    await request("healthy before actual query failure", "GET", "/api/health");
    await f.sql(["ALTER TABLE workers RENAME TO operational_hidden_workers"]);
    try {
      await request(
        "actual worker query error is redacted",
        "GET",
        "/api/health",
        { status: 500 },
      );
      const observed = await scrape(
        "successful ping preceding query error remains ready",
      );
      assert.equal(observed.number("cantrip_database_ready"), 1);
      assert.equal(observed.number("cantrip_database_probe_failures_total"), 0);
    } finally {
      await f.sql(["ALTER TABLE operational_hidden_workers RENAME TO workers"]);
    }
    await request("restored actual query works", "GET", "/api/health");
    const beforeClose = await scrape("probe state before connection shutdown");
    assert.equal(beforeClose.number("cantrip_database_ready"), 1);
    await request(
      "close the actual database connection",
      "POST",
      "/__fixture/close-database",
      { json: {}, fixtureControl: true },
    );
    await request(
      "health query against closed connection is redacted",
      "GET",
      "/api/health",
      { status: 500 },
    );
    const afterHealth = await scrape(
      "failed health does not record a completed ping",
    );
    assert.equal(afterHealth.number("cantrip_database_ready"), 1);
    assert.equal(
      afterHealth.number("cantrip_database_probe_failures_total"),
      0,
    );
    const unavailable = await request(
      "actual closed connection fails readiness",
      "GET",
      "/readyz",
      { status: 503, publicClient: true },
    );
    assert.equal(unavailable.database.status, "unavailable");
    assert.deepEqual(unavailable.coordination, {
      shared: false,
      status: "ready",
    });
    const afterProbe = await scrape(
      "failed readiness increments the real failure observation",
    );
    assert.equal(afterProbe.number("cantrip_database_ready"), 0);
    assert.equal(afterProbe.number("cantrip_database_probe_failures_total"), 1);
    assert.equal(
      afterProbe.number("cantrip_database_probe_latency_seconds"),
      unavailable.database.latencyMs / 1000,
    );
    await request(
      "HEAD performs actual failed readiness probe",
      "HEAD",
      "/readyz",
      { status: 503, publicClient: true },
    );
    const afterHead = await scrape("HEAD failure is observed once");
    assert.equal(afterHead.number("cantrip_database_probe_failures_total"), 2);
    const alive = await request(
      "liveness remains independent of the closed database",
      "GET",
      "/healthz",
      { publicClient: true },
    );
    assert.equal(alive.status, "alive");
    const old = f.server,
      port = Number(new URL(old.origin).port);
    await close();
    await start(port);
    const bootstrap = await request(
      "reopened profile keeps original identity",
      "GET",
      "/api/bootstrap",
    );
    assert.equal(bootstrap.server.id, serverId);
    result.cases.pop(); // Full bootstrap is retained raw; identity was compared, not randomized away.
    const fresh = await scrape(
      "new connection resets process-local probe observations",
    );
    assert.equal(fresh.number("cantrip_database_ready"), 0);
    assert.equal(fresh.number("cantrip_database_probe_failures_total"), 0);
    await request(
      "reopened database and original authenticated session work",
      "GET",
      "/api/health",
    );
  } catch (error) {
    primaryFailure = error;
    result.failure = { message: error.message, stack: error.stack };
  } finally {
    try {
      await close();
    } catch (error) {
      result.teardownFailure = { message: error.message, stack: error.stack };
      primaryFailure ??= error;
    }
  }
  if (primaryFailure) throw primaryFailure;
}
try {
  let executable;
  if (values.runtime !== "node") {
    const binary =
      process.env.CANTRIP_RUST_SERVER_BINARY ??
      (await buildRustExample("http-sql-fixture"));
    await mkdir(path.join(root, "bin"));
    executable = path.join(root, "bin", path.basename(binary));
    await copyFile(binary, executable);
    report.nativeExecutable = {
      path: executable,
      sha256: createHash("sha256")
        .update(await readFile(executable))
        .digest("hex"),
    };
  }
  const passwordHash = await hashPassword(password);
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of values.profile
    ? [values.profile]
    : ["none", "password", "accounts"]) {
    const runtimes = [];
    report.profiles.push({ profile, runtimes });
    for (const kind of values.runtime ? [values.runtime] : ["node", "rust"]) {
      const result = { kind, cases: [], raw: [], exits: [] };
      runtimes.push(result);
      const url =
        pg && (kind === "node" || values.database === "postgres")
          ? await pg.database()
          : undefined;
      await peer(
        {
          kind,
          profile,
          root,
          executable,
          databaseMode: values.database,
          url,
          passwordHash,
        },
        result,
      );
    }
    if (runtimes.length === 2)
      assert.deepEqual(
        runtimes[1].cases,
        runtimes[0].cases,
        "actual query/connection failure and recovery parity",
      );
  }
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  try {
    await pg?.close();
  } catch (error) {
    failure ??= error;
    report.teardownFailure = { message: error.message };
  }
  if (values.report)
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    root,
    profiles: report.profiles.map((p) => ({
      profile: p.profile,
      runtimes: p.runtimes.map((r) => ({
        kind: r.kind,
        cases: r.cases.length,
        exits: r.exits,
      })),
    })),
  }),
);
