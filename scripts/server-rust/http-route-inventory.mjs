// Discovery audit through real production HTTP. Missing-resource and invalid
// input observations detect missing routes; they do not prove domain parity.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { buildRustServer, repositoryRoot } from "./build.mjs";
import { fixtureEnvironment, startServer } from "./process.mjs";
import { startPackagedNodeServer } from "./packaged-node-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    report: { type: "string" },
  },
});
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(values.database));
const root = await mkdtemp(path.join(tmpdir(), "cantrip-rust-http-inventory-"));
const rawInventory = await readFile(
  path.join(repositoryRoot, "docs/security/server-route-inventory.json"),
);
const inventory = JSON.parse(rawInventory);
const executable =
  process.env.CANTRIP_RUST_SERVER_BINARY ??
  (await buildRustServer({ release: true }));
const report = {
  root,
  database: values.database,
  completeReplacement: false,
  inventorySha256: createHash("sha256").update(rawInventory).digest("hex"),
  rustExecutableSha256: createHash("sha256")
    .update(await readFile(executable))
    .digest("hex"),
  scope:
    "All declared methods/paths through the frozen Node reference and production Rust routers on isolated local profiles with absent resource identities and empty JSON bodies. Includes HTTP status, content type and stable body parity. Non-upgrade requests inspect WebSocket routes. Runtime-dependent bodies are recorded for review.",
  responses: [],
  exits: [],
};
const identity = "99999999-9999-4999-8999-999999999999";
const runtimeDependentBodies = new Map([
  ["GET /api/account/live-traffic", "clock, cursor, and traffic samples"],
  ["GET /api/account/resource-usage", "measurement time"],
  ["GET /api/analytics/provider-telemetry", "clock and measured time range"],
  ["GET /api/bootstrap", "instance identity and artifact version"],
  ["POST /api/chat-imports/:jobId/retry", "request ID"],
  ["POST /api/direct-attachments/:capabilityId/telemetry", "request ID"],
  ["GET /api/health", "clock, instance, and operational counters"],
  ["POST /api/projects/:projectId/chat-imports", "request ID"],
  ["POST /api/workers/enrollment-codes", "generated code, ID, and expiration"],
  ["GET /api/workspaces", "default workspace creation time"],
  ["GET /healthz", "clock"],
  ["GET /metrics", "operational measurements"],
  ["GET /readyz", "clock and measured database latency"],
  ["GET /version", "artifact version"],
]);
const errorContracts = [
  ["GET", "/api/internal/agent-operations/capabilities", 400],
  [
    "POST",
    "/api/cantrip-os/:instanceId/package-operations/:operationId/observe",
    409,
  ],
  [
    "POST",
    "/api/projects/:projectId/cantrip-os/bindings/:bindingId/recover",
    409,
  ],
  [
    "POST",
    "/api/projects/:projectId/cantrip-os/bindings/:bindingId/verify",
    409,
  ],
];
const capabilityQueryCases = [
  ["?workerId=", 400],
  ["?workerId=worker&workerId=other", 400],
  ["?workerId=worker&%GG=1", 400],
  ["?workerId=worker", 401],
];
let server, pg, failure;
try {
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "reference-postgres"), {
      restartable: true,
    });
  for (const kind of ["node", "rust"]) {
    const directory = path.join(root, kind);
    await mkdir(directory);
    const databaseUrl =
      pg && (kind === "node" || values.database === "postgres")
        ? await pg.database()
        : undefined;
    const environment = {
      ...fixtureEnvironment(directory),
      CANTRIP_AUTH_RATE_LIMIT: "1000",
      CANTRIP_API_RATE_LIMIT_PER_MINUTE: "10000",
      ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
      ...(kind === "rust" &&
      values.database === "bundled-postgres" &&
      process.env.CANTRIP_TEST_POSTGRES_BIN_DIR
        ? {
            CANTRIP_POSTGRES_BIN_DIR: process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
          }
        : {}),
    };
    server =
      kind === "node"
        ? await startPackagedNodeServer(
            path.join(repositoryRoot, "tests/reference-node-server"),
            environment,
            { nodeExecutable: process.execPath },
          )
        : await startServer(
            executable,
            [
              "--port",
              "0",
              "--data-dir",
              directory,
              "--database",
              values.database,
              "--shutdown-on-stdin-close",
            ],
            { cwd: repositoryRoot, env: environment },
          );
    const log = path.join(directory, "server.log");
    appendFileSync(log, server.diagnostics());
    for (const stream of [server.child.stdout, server.child.stderr])
      stream.on("data", (chunk) => appendFileSync(log, chunk));
    const rows = [];
    report.responses.push({ kind, rows });
    for (const route of inventory.routes) {
      const url = route.path.replace(/:[A-Za-z_][A-Za-z_0-9]*/g, identity);
      const write = !["GET", "HEAD"].includes(route.method);
      try {
        const response = await fetch(server.origin + url, {
          method: route.method,
          headers: {
            origin: "http://127.0.0.1:5173",
            ...(write ? { "content-type": "application/json" } : {}),
          },
          ...(write ? { body: "{}" } : {}),
          signal: AbortSignal.timeout(5000),
        });
        const text = await response.text();
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
        rows.push({
          method: route.method,
          path: route.path,
          url,
          status: response.status,
          body,
          contentType: response.headers.get("content-type"),
        });
      } catch (error) {
        rows.push({
          method: route.method,
          path: route.path,
          url,
          error: error.message,
        });
      }
    }
    const capabilityQueries = [];
    report.responses.at(-1).capabilityQueries = capabilityQueries;
    for (const [query, status] of capabilityQueryCases) {
      const response = await fetch(
        server.origin + "/api/internal/agent-operations/capabilities" + query,
        { signal: AbortSignal.timeout(5000) },
      );
      assert.equal(response.status, status, kind + " capabilities " + query);
      capabilityQueries.push({ query, status, body: await response.json() });
    }
    await server.close();
    report.exits.push({
      kind,
      code: server.child.exitCode,
      signal: server.child.signalCode,
    });
    server = undefined;
  }
  assert.equal(report.responses[0].rows.length, inventory.routes.length);
  assert.equal(report.responses[1].rows.length, inventory.routes.length);
  const [node, rust] = report.responses;
  const comparison = {
    statusAndContentTypeDifferences: [],
    stableBodyDifferences: [],
    runtimeDependentBodies: [],
    exactBodyMatches: 0,
  };
  report.comparison = comparison;
  report.rustFallbacks = [];
  for (const [index, actual] of rust.rows.entries()) {
    const expected = node.rows[index];
    const { method, path, status, contentType, body } = actual;
    if (actual.error || expected.error) continue;
    const label = method + " " + path;
    const reason = runtimeDependentBodies.get(label);
    const bodyMatches = isDeepStrictEqual(body, expected.body);
    if (status !== expected.status || contentType !== expected.contentType)
      comparison.statusAndContentTypeDifferences.push({
        method,
        path,
        node: { status: expected.status, contentType: expected.contentType },
        rust: { status, contentType },
      });
    if (reason)
      comparison.runtimeDependentBodies.push({
        method,
        path,
        reason,
        bodyMatches,
      });
    else if (!bodyMatches)
      comparison.stableBodyDifferences.push({ method, path });
    if (bodyMatches) comparison.exactBodyMatches += 1;
    if (
      status === 404 &&
      body?.error === "Not Found" &&
      body?.message?.startsWith("Route ") &&
      !bodyMatches
    )
      report.rustFallbacks.push({ method, path, node: expected, rust: actual });
  }
  assert.ok(
    report.responses.every((runtime) =>
      runtime.rows.every((row) => !row.error),
    ),
    "Every HTTP request must complete; errors are retained in the report",
  );
  for (const runtime of report.responses) {
    const ready = runtime.rows.find((row) => row.path === "/readyz");
    assert.equal(ready?.status, 200, runtime.kind + " is ready");
    assert.equal(
      ready?.body?.database?.engine,
      values.database === "pglite" ? "pglite" : "postgres",
      runtime.kind + " reports the selected database engine",
    );
  }
  assert.deepEqual(comparison.statusAndContentTypeDifferences, []);
  assert.deepEqual(comparison.stableBodyDifferences, []);
  for (const [method, path, status] of errorContracts) {
    const expected = node.rows.find(
      (r) => r.method === method && r.path === path,
    );
    const actual = rust.rows.find(
      (r) => r.method === method && r.path === path,
    );
    assert.equal(expected?.status, status, "Reference " + method + " " + path);
    assert.deepEqual(actual, expected, method + " " + path);
  }
  assert.deepEqual(rust.capabilityQueries, node.capabilityQueries);
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  try {
    try {
      await server?.close();
    } finally {
      await pg?.close();
    }
  } catch (error) {
    failure ??= error;
    report.teardownFailure = { message: error.message };
  }
  if (values.report)
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      root,
      database: values.database,
      routesPerPeer: inventory.routes.length,
      rustFallbacks: report.rustFallbacks?.length,
      statusAndContentTypeDifferences:
        report.comparison?.statusAndContentTypeDifferences.length,
      stableBodyDifferences: report.comparison?.stableBodyDifferences.length,
      exactBodyMatches: report.comparison?.exactBodyMatches,
      exits: report.exits,
      failed: Boolean(failure),
    }),
  );
}
if (failure) throw failure;
if (report.rustFallbacks.length) process.exitCode = 1;
