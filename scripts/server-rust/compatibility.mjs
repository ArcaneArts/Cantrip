import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { buildRustServer, repositoryRoot } from "./build.mjs";
import { fixtureEnvironment, startServer } from "./process.mjs";

const executable =
  process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
const root = await mkdtemp(path.join(tmpdir(), "cantrip-rust-compatibility-"));
const report = {
  schemaVersion: 1,
  suite: "foundation-http",
  results: [],
  completeReplacement: false,
};
const reportIndex = process.argv.indexOf("--report");
const reportPath = reportIndex >= 0 ? process.argv[reportIndex + 1] : undefined;
const inventory = JSON.parse(
  await readFile(
    path.join(repositoryRoot, "docs/security/server-route-inventory.json"),
    "utf8",
  ),
);
report.baseline = {
  routes: inventory.routes.length,
  workerCommands: inventory.workerCommands.length,
  durableTables: inventory.durableTables.length,
};

function normalize(body) {
  // Only process-local timestamps and measured latency are nondeterministic.
  const normalized = structuredClone(body);
  if (normalized.timestamp !== undefined) {
    assert.match(
      normalized.timestamp,
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
    );
    normalized.timestamp = "<timestamp>";
  }
  if (normalized.database?.latencyMs !== undefined) {
    assert.ok(
      Number.isFinite(normalized.database.latencyMs) &&
        normalized.database.latencyMs >= 0,
    );
    normalized.database.latencyMs = "<measured-latency>";
  }
  return normalized;
}

const cases = [
  { method: "GET", path: "/api", status: 200 },
  { method: "HEAD", path: "/api", status: 200 },
  { method: "GET", path: "/healthz", status: 200 },
  { method: "GET", path: "/readyz", status: 200 },
  { method: "GET", path: "/does-not-exist?fixture=1", status: 404 },
  { method: "POST", path: "/api", status: 404 },
  { method: "GET", path: "/api/", status: 404 },
];

async function observe(server, scenario) {
  const startedAt = performance.now();
  const response = await fetch(`${server.origin}${scenario.path}`, {
    method: scenario.method,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  assert.equal(
    response.status,
    scenario.status,
    `${scenario.method} ${scenario.path}`,
  );
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: scenario.method === "HEAD" ? text : normalize(JSON.parse(text)),
    latencyMs: performance.now() - startedAt,
  };
}

let node;
let rust;
let failure;
try {
  node = await startServer(
    process.execPath,
    ["--import", "tsx", "scripts/server-rust/node-server.mjs"],
    { cwd: repositoryRoot, env: fixtureEnvironment(path.join(root, "node")) },
  );
  rust = await startServer(
    executable,
    [
      "--port",
      "0",
      "--data-dir",
      path.join(root, "rust"),
      "--database",
      "pglite",
      "--shutdown-on-stdin-close",
    ],
    { cwd: repositoryRoot, env: fixtureEnvironment(path.join(root, "rust")) },
  );
  for (const scenario of cases) {
    const expected = await observe(node, scenario);
    const actual = await observe(rust, scenario);
    const { latencyMs: nodeLatencyMs, ...nodeContract } = expected;
    const { latencyMs: rustLatencyMs, ...rustContract } = actual;
    assert.deepEqual(
      rustContract,
      nodeContract,
      `${scenario.method} ${scenario.path}`,
    );
    report.results.push({
      ...scenario,
      passed: true,
      nodeLatencyMs,
      rustLatencyMs,
    });
  }
  report.startupMs = { node: node.startupMs, rust: rust.startupMs };
  await rust.close();
  rust = undefined;
  rust = await startServer(
    executable,
    [
      "--port",
      "0",
      "--data-dir",
      path.join(root, "rust"),
      "--database",
      "pglite",
      "--shutdown-on-stdin-close",
    ],
    { cwd: repositoryRoot, env: fixtureEnvironment(path.join(root, "rust")) },
  );
  await observe(rust, { method: "GET", path: "/readyz", status: 200 });
  report.restart = { passed: true };
} catch (error) {
  failure = error;
  report.failure = error.message;
} finally {
  const cleanup = await Promise.allSettled([node?.close(), rust?.close()]);
  report.cleanup = cleanup.map((result) => result.status);
  const errors = cleanup
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length === 0) await rm(root, { recursive: true, force: true });
  else report.fixtureRoot = root;
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  if (failure) errors.unshift(failure);
  if (errors.length)
    throw new AggregateError(errors, "Rust server compatibility failed");
}
