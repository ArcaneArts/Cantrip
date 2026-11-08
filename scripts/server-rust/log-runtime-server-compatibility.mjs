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
const WebSocket = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("ws");

const { values } = parseArgs({
  options: {
    report: { type: "string" },
    "http-records": { type: "boolean", default: false },
  },
});
const root = await mkdtemp(path.join(tmpdir(), "cantrip-log-production-"));
console.error(JSON.stringify({ event: "log-production.created", root }));
const report = { root, peers: [], completeReplacement: false };
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
const legacy = {
  timestamp: "2020-01-01T00:00:00.000Z",
  system: "server",
  level: "info",
  message: "legacy-original",
  context: { event: "fixture.legacy" },
};
try {
  pg = await postgresFixture(path.join(root, "postgres"));
  for (const scenario of scenarios)
    for (const kind of ["node", "rust"]) {
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
      if (scenario.invalid) env.CANTRIP_AUTH_MODE = "invalid";
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
      };
      report.peers.push(result);
      child.stdout.on("data", (chunk) => {
        result.stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        result.stderr += chunk;
      });
      const completion = new Promise((yes, no) => {
        child.once("error", no);
        child.once("close", (code, signal) => yes({ code, signal }));
      });
      let stopTimer;
      try {
        if (scenario.invalid) {
          stopTimer = setTimeout(() => child.kill("SIGKILL"), 15000);
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
          const session = await fetch(origin + "/api/auth/session");
          assert.equal(session.status, 200);
          const cookie = session.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; ");
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
      }
      assert.deepEqual(result.exit, {
        code: scenario.invalid ? 1 : 0,
        signal: null,
      });
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
    const peers = report.peers.filter(
      (peer) => peer.scenario === scenario.name,
    );
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
