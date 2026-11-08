// Actual production entrypoints; the ordinary Node app fixture does not initialize logs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { postgresFixture } from "./postgres-fixture.mjs";
import { fixtureEnvironment } from "./process.mjs";
import { repositoryRoot } from "./build.mjs";
import { databaseHealthCases } from "./database-health-cases.mjs";
import { logRuntimeAuth } from "./log-runtime-auth.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { verifyAccountingRuntime } from "./accounting-runtime-cases.mjs";
import {
  targetPolicyCases,
  verifyTargetPolicy,
  targetPolicyNormalization,
} from "./http-target-policy-cases.mjs";
const WebSocket = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("ws");

const { values } = parseArgs({
  options: {
    report: { type: "string" },
    "http-records": { type: "boolean", default: false },
    "http-targets": { type: "boolean", default: false },
    "accounting-records": { type: "boolean", default: false },
    "database-records": { type: "boolean", default: false },
    "database-health": { type: "boolean", default: false },
    "database-health-outage": { type: "boolean", default: false },
    "database-retries": { type: "boolean", default: false },
    "database-listener-retries": { type: "boolean", default: false },
    "database-exhaustion": { type: "boolean", default: false },
    "rust-first": { type: "boolean", default: false },
  },
});
const retryRequested =
  values["database-retries"] || values["database-listener-retries"];
const healthRequested =
  values["database-health"] ||
  values["database-health-outage"] ||
  retryRequested;
const root = await mkdtemp(path.join(tmpdir(), "cantrip-log-production-"));
console.error(JSON.stringify({ event: "log-production.created", root }));
const report = { root, peers: [], completeReplacement: false };
const password = "isolated production outage fixture password";
const passwordHash =
  values["database-health-outage"] ||
  values["accounting-records"] ||
  values["http-targets"]
    ? await hashPassword(password)
    : undefined;
let pg, failure;
const scenarios = [
  { name: "postgres-default", database: "postgres", burst: 24 },
  { name: "pglite-default", database: "pglite" },
  { name: "bundled-default", database: "bundled-postgres" },
  {
    name: "directory-precedence",
    database: "postgres",
    directory: true,
    file: true,
    signal: "SIGINT",
  },
  { name: "legacy-file", database: "postgres", file: true, threshold: "error" },
  { name: "blank-settings", database: "postgres", blank: true },
  { name: "archive-recovery", database: "postgres", obstruct: true },
  { name: "startup-failure", database: "postgres", invalid: true },
];
if (values["accounting-records"] || values["http-targets"])
  for (const database of ["pglite", "bundled-postgres", "postgres"])
    for (const auth of ["password", "accounts"])
      scenarios.push({
        name: `${database}-${auth}-${values["accounting-records"] ? "accounting" : "target-policy"}`,
        database,
        auth,
      });
else if (values["database-health-outage"])
  for (const auth of ["password", "accounts"])
    scenarios.push({
      name: `postgres-${auth}-outage`,
      database: "postgres",
      auth,
    });
if (values["database-exhaustion"])
  scenarios.push({
    name: "postgres-retry-exhausted",
    database: "postgres",
    invalid: true,
    failDatabase: true,
  });
const legacy = {
  timestamp: "2020-01-01T00:00:00.000Z",
  system: "server",
  level: "info",
  message: "legacy-original",
  context: { event: "fixture.legacy" },
};
if (values["database-records"]) {
  for (const [name, key] of [
    ["json", "{"],
    ["array", "[]"],
    ["metadata", '{"version":2,"id":"local-v1","key":"AA=="}'],
    [
      "base64",
      '{"version":1,"id":"local-v1","key":"invalid-private-key-marker"}',
    ],
  ])
    scenarios.push({
      name: `key-invalid-${name}`,
      database: "postgres",
      invalid: true,
      key,
    });
  scenarios.push({
    name: "key-retained",
    database: "postgres",
    key:
      JSON.stringify(
        {
          version: 1,
          id: "local-v1",
          key: Buffer.alloc(32, 7).toString("base64"),
          extra: "preserve-original-key-file",
        },
        null,
        2,
      ) + "\n",
  });
  scenarios.push({
    name: "key-explicit-bypass",
    database: "postgres",
    key: "invalid-private-key-marker",
    explicitKey: true,
  });
}
try {
  pg = await postgresFixture(path.join(root, "postgres"));
  for (const scenario of scenarios)
    for (const kind of values["rust-first"]
      ? ["rust", "node"]
      : ["node", "rust"]) {
      const listener = createServer();
      await new Promise((yes, no) => {
        listener.once("error", no);
        listener.listen(0, "127.0.0.1", yes);
      });
      const port = listener.address().port;
      await new Promise((yes) => listener.close(yes));
      const dataDirectory = path.join(root, scenario.name, kind);
      await mkdir(dataDirectory, { recursive: true });
      const env = {
        ...fixtureEnvironment(dataDirectory),
        CANTRIP_SERVER_PORT: String(port),
        CANTRIP_LICENSE_WHITELIST_ENABLED: "false",
        CANTRIP_LOG_LEVEL: scenario.threshold ?? "info",
      };
      const args = ["--port", String(port), "--database", scenario.database];
      if (scenario.auth) {
        env.CANTRIP_AUTH_MODE = scenario.auth;
        env.CANTRIP_REGISTRATION_ENABLED = "true";
        delete env.CANTRIP_WORKER_TOKEN;
        if (scenario.auth === "password")
          env.CANTRIP_PASSWORD_HASH = passwordHash;
      }
      let healthCases;
      if (
        scenario.database !== "pglite" &&
        (kind === "node" || scenario.database === "postgres")
      )
        env.DATABASE_URL = await pg.database();
      if (scenario.database === "bundled-postgres" && kind === "rust")
        args.push(
          "--postgres-bin-dir",
          process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
        );
      if (
        (healthRequested &&
          scenario.database === "postgres" &&
          (scenario.name === "postgres-default" || scenario.auth)) ||
        scenario.failDatabase
      ) {
        healthCases = await databaseHealthCases(env.DATABASE_URL, {
          includeOutage: values["database-health-outage"],
          startupFailures: scenario.failDatabase ? 31 : retryRequested ? 6 : 0,
          startupConnectionLimit: values["database-listener-retries"] ? 1 : 0,
        });
        env.DATABASE_URL = healthCases.url;
      }
      let directory = path.join(dataDirectory, "logs");
      if (scenario.file) {
        directory = path.join(dataDirectory, "file-choice");
        env.CANTRIP_SERVICE_LOG_FILE = `  ${path.join(directory, "custom.service.jsonl")}  `;
      }
      if (scenario.directory) {
        directory = path.join(dataDirectory, "directory-choice");
        env.CANTRIP_SERVICE_LOG_DIR = `  ${directory}/nested/..  `;
      }
      if (scenario.blank) {
        env.CANTRIP_SERVICE_LOG_DIR = " \ufeff  ";
        env.CANTRIP_SERVICE_LOG_FILE = "\ufeff\t";
      }
      if (
        scenario.invalid &&
        scenario.key === undefined &&
        !scenario.failDatabase
      )
        env.CANTRIP_AUTH_MODE = "invalid";
      if (scenario.key !== undefined)
        await writeFile(
          path.join(dataDirectory, "secret-encryption-key.json"),
          scenario.key,
          { mode: 0o644 },
        );
      if (scenario.explicitKey)
        env.CANTRIP_SECRET_ENCRYPTION_KEYS = JSON.stringify({
          fixture: Buffer.alloc(32, 9).toString("base64"),
        });
      if (scenario.obstruct)
        await writeFile(directory, "actual filesystem obstruction");
      else if (scenario.file) {
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, "custom.service.jsonl"),
          JSON.stringify(legacy) + "\n",
          { mode: 0o600 },
        );
      }
      const child = spawn(
        kind === "node"
          ? process.execPath
          : process.env.CANTRIP_RUST_SERVER_BINARY,
        kind === "node"
          ? ["--import", "tsx", "cantrip_server/src/index.ts"]
          : args,
        { cwd: repositoryRoot, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      const result = {
        scenario: scenario.name,
        database: scenario.database,
        kind,
        directory,
        stdout: "",
        stderr: "",
        responses: [],
        ...(healthCases ? { databaseHealth: healthCases.result } : {}),
      };
      report.peers.push(result);
      child.stdout.on("data", (chunk) => {
        result.stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        result.stderr += chunk;
      });
      const waitForConsole = async (fragment) => {
        const deadline = Date.now() + 10000;
        while (
          !(result.stdout + result.stderr)
            .replace(/\x1b\[[0-9;]*m/g, "")
            .includes(fragment)
        ) {
          assert.ok(
            Date.now() < deadline,
            "Actual console completion: " + fragment,
          );
          await delay(10);
        }
      };
      const accounting =
        values["accounting-records"] &&
        (scenario.name.endsWith("-default") || scenario.auth);
      const completion = new Promise((yes, no) => {
        child.once("error", no);
        child.once("close", (code, signal) => yes({ code, signal }));
      });
      let stopTimer;
      try {
        if (scenario.invalid) {
          stopTimer = setTimeout(
            () => child.kill("SIGKILL"),
            scenario.failDatabase ? 70000 : 15000,
          );
          try {
            result.exit = await completion;
          } finally {
            clearTimeout(stopTimer);
          }
          assert.deepEqual(result.exit, { code: 1, signal: null });
        } else {
          const origin = `http://127.0.0.1:${port}`,
            deadline = Date.now() + 60000;
          for (;;) {
            assert.equal(
              child.exitCode,
              null,
              "Actual production server remains alive: " + result.stderr,
            );
            try {
              const response = await fetch(origin + "/readyz", {
                signal: AbortSignal.timeout(1000),
              });
              if (response.status === 200) break;
            } catch {}
            assert.ok(
              Date.now() < deadline,
              "Production readiness deadline: " + result.stderr,
            );
            await delay(50);
          }
          const authentication = await logRuntimeAuth(
            origin,
            scenario.auth ?? "none",
            password,
          );
          const { cookie } = authentication;
          result.authentication = authentication.evidence;
          if (accounting)
            await waitForConsole("Account usage history maintenance completed");
          const request = async (route) => {
            const response = await fetch(origin + route, {
              headers: { cookie, origin: "http://127.0.0.1:5173" },
            });
            result.responses.push({
              route,
              status: response.status,
              requestId: response.headers.get("x-request-id"),
              body: await response.json(),
            });
            assert.equal(
              response.status,
              route.includes("catalog") ? 404 : 200,
            );
          };
          if (scenario.obstruct) {
            for (let i = 0; i < 6; i++)
              await request(`/api/settings/providers/log-blocked-${i}/catalog`);
            // Restore actual storage while this same healthy server remains running.
            await rm(directory);
          }
          const count = scenario.burst ?? 1;
          for (let i = 0; i < count; i++)
            await request("/api/settings/providers/log-missing/catalog");
          await request("/readyz?token=private-log-query-marker");
          if (
            values["http-targets"] &&
            (scenario.name.endsWith("-default") || scenario.auth)
          )
            result.targetPolicy = {
              normalization: targetPolicyNormalization,
              responses: await targetPolicyCases(origin, cookie, {
                metrics: false,
              }),
            };
          if (values["http-records"] && scenario.name === "postgres-default") {
            for (const spec of [
              { method: "HEAD", route: "/api/auth/session", status: 200 },
              {
                method: "OPTIONS",
                route: "/api/settings",
                status: 204,
                headers: { "access-control-request-method": "GET" },
              },
              { method: "OPTIONS", route: "/api/settings", status: 400 },
              {
                method: "GET",
                route: "/api/settings",
                status: 403,
                headers: { origin: "https://forbidden.example" },
              },
              {
                method: "POST",
                route: "/api/settings",
                status: 400,
                headers: { "content-type": "application/json" },
                body: "{",
              },
              {
                method: "PATCH",
                route: "/api/settings",
                status: 400,
                headers: { "content-type": "application/json" },
                body: "{",
              },
              ...["POST", "PUT", "PATCH", "DELETE"].flatMap((method) => [
                {
                  method,
                  route: "/api/log-missing-fallback",
                  status: 400,
                  headers: { "content-type": "application/json" },
                  body: "{",
                },
                {
                  method,
                  route: "/api/log-missing-fallback",
                  status: 404,
                  headers: { "content-type": "application/json" },
                  body: "null",
                },
              ]),
              ...["", "json", "application /json"].map((type) => ({
                method: "POST",
                route: "/api/log-missing-fallback",
                status: 415,
                headers: { "content-type": type },
                body: "x",
              })),
              {
                method: "POST",
                route: "/api/log-missing-fallback",
                status: 404,
                headers: { "content-type": "application/xml" },
                body: "x",
              },
              {
                method: "POST",
                route: "/api/log-missing-fallback",
                status: 400,
                headers: { "content-type": "application/json" },
                body: "",
              },
              {
                method: "POST",
                route: "/api/log-missing-fallback",
                status: 404,
                headers: { "content-type": "application/octet-stream" },
                body: Buffer.from([0, 255]),
              },
              {
                method: "POST",
                route: "/api/log-missing-fallback",
                status: 404,
                headers: { "content-type": "text/plain" },
                body: "text",
              },
              {
                method: "QUERY",
                route: "/api/log-missing-fallback",
                status: 400,
              },
              {
                method: "QUERY",
                route: "/api/log-missing-fallback",
                status: 400,
                headers: { "content-type": "application/json" },
                body: "",
              },
              {
                method: "POST",
                route: "/api/github/log-removed",
                status: 410,
                headers: { "content-type": "application/json" },
                body: "{",
              },
            ]) {
              const response = await fetch(origin + spec.route, {
                method: spec.method,
                headers: {
                  cookie,
                  origin: "http://127.0.0.1:5173",
                  ...spec.headers,
                },
                body: spec.body,
              });
              const observed = {
                route: spec.route,
                method: spec.method,
                status: response.status,
                requestId: response.headers.get("x-request-id"),
                body: await response.text(),
              };
              result.responses.push(observed);
              assert.equal(observed.status, spec.status);
            }
          }
          if (values["http-records"] && scenario.name === "postgres-default") {
            const socket = new WebSocket(
              origin.replace("http://", "ws://") + "/api/live",
              { headers: { cookie, origin: "http://127.0.0.1:5173" } },
            );
            const closed = new Promise((resolve, reject) => {
              socket.once("error", reject);
              socket.once("close", (code, reason) =>
                resolve({ code, reason: reason.toString() }),
              );
            });
            closed.catch(() => {});
            try {
              await new Promise((resolve, reject) => {
                socket.once("open", resolve);
                socket.once("error", reject);
              });
              socket.close(1000, "logging-check");
              result.websocket = await closed;
              assert.equal(result.websocket.code, 1000);
            } finally {
              if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
            }
          }
          if (healthCases) {
            result.databaseHealth = healthCases.result;
            await healthCases.run(origin, cookie, waitForConsole);
          }
          result.expectedCatalogRecords = count;
          assert.ok(
            !result.stdout.includes("provider.catalog.refresh-started"),
            "Debug console output is suppressed independently of archive capture",
          );
          assert.ok(
            result.stdout.includes("Cantrip Server is ready"),
            "Info service output remains visible, including an error console threshold",
          );
        }
      } finally {
        try {
          if (!result.exit) {
            if (child.exitCode === null && child.signalCode === null)
              child.kill(scenario.signal ?? "SIGTERM");
            stopTimer = setTimeout(() => child.kill("SIGKILL"), 15000);
            try {
              result.exit = await completion;
            } finally {
              clearTimeout(stopTimer);
            }
          }
        } finally {
          await healthCases?.close();
        }
      }
      assert.deepEqual(result.exit, {
        code: scenario.invalid ? 1 : 0,
        signal: null,
      });
      if (scenario.key !== undefined) {
        const file = path.join(dataDirectory, "secret-encryption-key.json");
        assert.equal(
          await readFile(file, "utf8"),
          scenario.key,
          "Retained key bytes are never replaced",
        );
        if (process.platform !== "win32")
          assert.equal(
            (await stat(file)).mode & 0o777,
            scenario.invalid || scenario.explicitKey ? 0o644 : 0o600,
          );
      }
      result.files = await readdir(directory);
      result.records = [];
      for (const name of result.files.filter((name) => name.endsWith(".jsonl")))
        result.records.push(
          ...(await readFile(path.join(directory, name), "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        );
      if (healthCases && !scenario.invalid)
        result.databaseHealthRecords = healthCases.verify(result.records);
      if (accounting)
        result.accountingRecords = verifyAccountingRuntime(result.records);
      if (scenario.failDatabase)
        assert.equal(
          result.databaseHealth.startupFailures.length,
          30,
          "The real backend rejects all thirty startup attempts",
        );
      const event = (name) =>
        result.records.filter((record) => record.context?.event === name);
      if (result.websocket)
        assert.equal(
          event("http.request.completed").filter(
            (record) => record.context.path === "/api/live",
          ).length,
          0,
          "Raw WebSocket upgrades do not become completed ordinary HTTP requests",
        );
      if (scenario.invalid) {
        assert.equal(event("server.startup.failed").length, 1);
        assert.equal(event("server.startup.failed")[0].level, "fatal");
      } else {
        if (values["http-records"]) {
          const requests = result.responses.filter(
            (response) =>
              response.route === "/api/settings/providers/log-missing/catalog",
          );
          const records = event("http.request.completed").filter(
            (record) =>
              record.context.path ===
              "/api/settings/providers/log-missing/catalog",
          );
          assert.equal(
            records.length,
            requests.length,
            "Every actual HTTP completion is archived",
          );
          assert.deepEqual(
            records.map((record) => ({
              id: record.context.requestId,
              code: record.context.statusCode,
              method: record.context.method,
              status: record.context.status,
            })),
            requests.map((request) => ({
              id: request.requestId,
              code: request.status,
              method: "GET",
              status: "failed",
            })),
          );
          for (const request of result.responses.filter(
            (request) => request.method,
          )) {
            const found = event("http.request.completed").filter(
              (record) => record.context.requestId === request.requestId,
            );
            assert.equal(
              found.length,
              1,
              "Early/HEAD/error completion is logged exactly once",
            );
            assert.equal(found[0].context.method, request.method);
            assert.equal(found[0].context.path, request.route);
            assert.equal(found[0].context.statusCode, request.status);
          }
          assert.ok(
            result.stderr.includes(
              "GET /api/settings/providers/log-missing/catalog -> 404 Not Found (",
            ),
            "Actual HTTP warnings use the existing console presentation",
          );
        }
        assert.equal(
          event("provider.catalog.refresh-started").filter(
            (record) => record.context.providerId === "log-missing",
          ).length,
          result.expectedCatalogRecords,
          "Every post-recovery/normal catalog debug record drains to the archive",
        );
        for (const name of [
          "server.startup.started",
          "server.startup.database-ready",
          "server.startup.completed",
          "server.shutdown.started",
          "server.shutdown.completed",
        ]) {
          if (scenario.obstruct && name.startsWith("server.startup"))
            assert.ok(event(name).length <= 1);
          else
            assert.equal(
              event(name).length,
              1,
              `${scenario.name}/${kind}: ${name}`,
            );
        }
        assert.equal(
          event("server.shutdown.started")[0].context.reasonCode,
          (scenario.signal ?? "SIGTERM").toLowerCase(),
        );
        assert.ok(
          event("server.shutdown.completed")[0].context.durationMs >= 0,
        );
      }
      if (scenario.file) {
        assert.ok(
          result.records.some((record) => record.message === "legacy-original"),
        );
        assert.ok(!result.files.includes("custom.service.jsonl"));
      }
      if (scenario.directory)
        assert.equal(
          await stat(path.join(dataDirectory, "file-choice")).then(
            () => true,
            (error) => {
              if (error.code === "ENOENT") return false;
              throw error;
            },
          ),
          false,
        );
      if (scenario.obstruct)
        assert.equal(
          (
            result.stderr.match(
              /Service log archive (?:initialize|append) failed/g,
            ) ?? []
          ).length,
          1,
          "Archive failure diagnostics are throttled without preventing real recovery",
        );
      assert.ok(
        !JSON.stringify(result.records).includes("private-log-query-marker"),
      );
      assert.ok(
        !JSON.stringify(result.records).includes(
          env.DATABASE_URL ?? "private-log-query-marker",
        ),
      );
      if (process.platform !== "win32") {
        assert.equal((await stat(directory)).mode & 0o777, 0o700);
        for (const name of result.files)
          assert.equal(
            (await stat(path.join(directory, name))).mode & 0o777,
            0o600,
          );
      }
    }
  for (const scenario of scenarios) {
    const peers = report.peers
      .filter((peer) => peer.scenario === scenario.name)
      .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "node" ? -1 : 1));
    if (peers[0].targetPolicy) {
      const comparison = verifyTargetPolicy(
        peers.map((peer) => ({
          responses: peer.targetPolicy.responses,
          records: peer.records,
        })),
      );
      (report.targetPolicyPairs ??= []).push({
        scenario: scenario.name,
        ...comparison,
      });
      assert.equal(
        comparison.wireDifferences.length,
        0,
        "Actual request-target responses and headers: " + scenario.name,
      );
      assert.equal(
        comparison.loggingDifferences.length,
        0,
        "Actual route-level log filtering: " + scenario.name,
      );
    }
    if (
      healthRequested &&
      scenario.database === "postgres" &&
      (scenario.name === "postgres-default" || scenario.auth)
    )
      assert.deepEqual(
        peers[1].databaseHealthRecords,
        peers[0].databaseHealthRecords,
        "Actual database slow/failure/repeated-event diagnostics match",
      );
    if (peers[0].accountingRecords)
      assert.deepEqual(
        peers[1].accountingRecords,
        peers[0].accountingRecords,
        "Actual production accounting lifecycle records match",
      );
    if (
      (retryRequested && scenario.name === "postgres-default") ||
      scenario.failDatabase
    ) {
      const normalize = (peer) =>
        peer.records
          .filter(
            (record) =>
              record.context?.event === "database.connection.retrying",
          )
          .map((record) => {
            const copy = structuredClone(record);
            delete copy.timestamp;
            delete copy.cursor;
            return copy;
          });
      assert.deepEqual(
        normalize(peers[1]),
        normalize(peers[0]),
        "Actual startup retry warning/summary records match",
      );
      for (const peer of peers) {
        if (scenario.failDatabase) {
          assert.equal(peer.databaseHealth.startupFailures.length, 30);
          continue;
        }
        assert.equal(
          peer.records.find(
            (record) =>
              record.context?.event === "database.migrations.completed",
          ).context.attempt,
          7,
        );
        assert.equal(peer.databaseHealth.startupFailures.length, 6);
      }
    }
    if (values["database-records"] && !scenario.obstruct) {
      const names = [
        "database.connection.started",
        "database.migrations.completed",
        "database.connection.completed",
      ];
      const records = peers.map((peer) =>
        peer.records.filter((record) => names.includes(record.context?.event)),
      );
      assert.deepEqual(
        records[0].map((record) => record.context.event),
        scenario.invalid
          ? scenario.key === undefined && !scenario.failDatabase
            ? []
            : names.slice(0, 1)
          : names,
        `${scenario.name}: actual Node database lifecycle order`,
      );
      const normalize = (records) =>
        records.map((record) => {
          const copy = structuredClone(record);
          delete copy.timestamp;
          delete copy.cursor;
          delete copy.context.durationMs;
          return copy;
        });
      assert.deepEqual(
        normalize(records[1]),
        normalize(records[0]),
        `${scenario.name}: actual database lifecycle records`,
      );
      for (const [index, peer] of peers.entries()) {
        if (scenario.invalid) continue;
        const ready = peer.records.findIndex(
          (record) => record.context?.event === "server.startup.database-ready",
        );
        assert.ok(
          peer.records.indexOf(records[index][2]) < ready,
          "Database readiness follows successful repository/migration initialization",
        );
        for (const record of records[index].slice(1)) {
          assert.ok(
            record.context.durationMs >= 0,
            "Measured database duration",
          );
        }
      }
    }
    const summaries = peers.map((peer) =>
      peer.records
        .filter(
          (record) =>
            record.context?.subsystem === "server-lifecycle" &&
            (!scenario.obstruct ||
              record.context.event.startsWith("server.shutdown")),
        )
        .map((record) => {
          const copy = structuredClone(record);
          delete copy.timestamp;
          delete copy.cursor;
          delete copy.context.durationMs;
          return copy;
        }),
    );
    assert.deepEqual(
      summaries[1],
      summaries[0],
      `${scenario.name}: lifecycle contracts`,
    );
    if (values["http-records"] && scenario.name === "postgres-default") {
      const normalize = (p) =>
        p.responses
          .filter((r) => r.method)
          .map((r) => {
            let body = r.body;
            try {
              body = JSON.parse(body);
            } catch {}
            return { route: r.route, method: r.method, status: r.status, body };
          });
      assert.deepEqual(
        normalize(peers[1]),
        normalize(peers[0]),
        "Actual fallback/parser precedence and error contracts match",
      );
    }
  }
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await pg?.close();
  if (values.report)
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    passed: true,
    root,
    peers: report.peers.length,
    records: report.peers.map((peer) => ({
      scenario: peer.scenario,
      kind: peer.kind,
      count: peer.records.length,
    })),
  }),
);
