// Compare Fastify's per-method route selection with the native router, including
// literals that are also valid :policyId paths for another HTTP method.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-policy-routing-"));
const report = {
  suite: "policy-http-method-routing",
  databaseMode,
  root,
  completeReplacement: false,
  runtimes: [],
};
let postgresOwner, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
  if (databaseMode !== "pglite")
    postgresOwner = await postgresFixture(path.join(root, "postgres"));
  for (const kind of ["node", "rust"]) {
    const databaseUrl =
      postgresOwner && (kind === "node" || databaseMode === "postgres")
        ? await postgresOwner.database()
        : undefined;
    const fixture = new HttpFixture({
      kind,
      executable,
      root,
      name: "routing",
      databaseMode,
      environment: {
        CANTRIP_AUTH_MODE: "none",
        ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
        ...(kind === "rust" && databaseMode === "bundled-postgres"
          ? {
              CANTRIP_POSTGRES_BIN_DIR:
                process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
            }
          : {}),
      },
    });
    const cases = [];
    report.runtimes.push({ kind, cases });
    try {
      await fixture.start();
      for (const url of [
        "/api/policies",
        "/api/policies/bootstrap",
        "/api/policies/order",
        "/api/policies/missing",
        "/api/policy-templates",
        "/api/policy-templates/missing",
        "/api/workspaces/missing/policies",
        "/api/projects/missing/policies",
        "/api/projects/missing/effective-policies",
      ])
        for (const method of [
          "GET",
          "HEAD",
          "POST",
          "PUT",
          "PATCH",
          "DELETE",
          "OPTIONS",
        ]) {
          const body = ["POST", "PUT", "PATCH", "DELETE"].includes(method)
            ? "{}"
            : undefined;
          const response = await fetch(fixture.server.origin + url, {
            method,
            headers: {
              origin: "http://127.0.0.1:5173",
              ...(body ? { "content-type": "application/json" } : {}),
              ...(method === "OPTIONS"
                ? { "access-control-request-method": "GET" }
                : {}),
            },
            body,
            signal: AbortSignal.timeout(15000),
          });
          const text = await response.text();
          assert.ok(
            [200, 204, 400, 404].includes(response.status),
            `${kind}/${method}/${url}: ${text}`,
          );
          assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
          cases.push({
            method,
            url,
            status: response.status,
            body: text ? JSON.parse(text) : null,
            headers: Object.fromEntries(
              [
                "content-type",
                "cache-control",
                "access-control-allow-origin",
                "access-control-allow-credentials",
                "vary",
                "content-security-policy",
                "x-frame-options",
                "x-content-type-options",
              ].map((name) => [name, response.headers.get(name)]),
            ),
          });
        }
    } finally {
      await fixture.close();
    }
  }
  assert.deepEqual(report.runtimes[1].cases, report.runtimes[0].cases);
} catch (error) {
  failure = error;
  report.failure = error.stack ?? String(error);
} finally {
  await postgresOwner?.close();
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    casesPerRuntime: report.runtimes.map((r) => r.cases.length),
    reportPath,
  }),
);
