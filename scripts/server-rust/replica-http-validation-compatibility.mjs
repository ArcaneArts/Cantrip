// Real HTTP validation/lookup precedence; executor scenarios live in a separate suite.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { password } from "./security-fixtures.mjs";
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-replica-http-validation-"),
);
const report = {
  suite: "replica-http-validation",
  databaseMode,
  profiles: [],
  completeReplacement: false,
};
const id = "33333333-3333-4333-8333-000000000001";
let pg, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "accounts"]) {
    const runtimes = [];
    report.profiles.push({ profile, runtimes });
    for (const kind of ["node", "rust"]) {
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const fixture = new HttpFixture({
        kind,
        executable,
        root,
        name: profile,
        databaseMode,
        environment: {
          CANTRIP_AUTH_MODE: profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
          ...(url ? { DATABASE_URL: url } : {}),
          ...(kind === "rust" && databaseMode === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      });
      const observations = [];
      runtimes.push({ kind, observations });
      const visit = async (label, method, route, options = {}) =>
        observations.push({
          label,
          ...(await fixture.observe(label, method, route, {
            csrf: method === "POST" && !!fixture.client().csrf,
            ...options,
          })),
        });
      try {
        await fixture.start();
        if (profile === "accounts")
          await visit("register", "POST", "/api/auth/register", {
            status: 201,
            json: {
              email: "replicas@example.invalid",
              displayName: "Replicas",
              password,
            },
          });
        else await visit("session", "GET", "/api/auth/session");
        for (const route of [
          `/api/projects/${id}/replicas`,
          `/api/projects/${id}/replicas/${id}`,
          `/api/projects/${id}/replica-jobs`,
          `/api/project-replica-jobs/${id}`,
        ])
          await visit(route, "GET", route, { status: 404 });
        for (const route of [
          `/api/projects/${id}/replicas`,
          `/api/projects/${id}/replicas/${id}/synchronize`,
          `/api/projects/${id}/replicas/${id}/remove`,
          `/api/project-replica-jobs/${id}/retry`,
          `/api/project-replica-jobs/${id}/cancel`,
        ]) {
          await visit(route + " invalid", "POST", route, {
            status: 400,
            json: {},
          });
          await visit(route + " malformed", "POST", route, {
            status: 400,
            raw: "{",
            headers: { "content-type": "application/json" },
          });
        }
        for (const action of ["retry", "cancel"])
          await visit(
            action + " missing",
            "POST",
            `/api/project-replica-jobs/${id}/${action}`,
            { status: 404, json: { stateRevision: 1 } },
          );
        await visit(
          "repair missing",
          "POST",
          `/api/projects/${id}/replicas/${id}/repair-link`,
          { status: 404 },
        );
      } finally {
        await fixture.close();
      }
    }
    assert.deepEqual(runtimes[1].observations, runtimes[0].observations);
  }
} catch (e) {
  failure = e;
  report.failure = e.stack;
} finally {
  await pg?.close();
  if (!failure) await rm(root, { recursive: true, force: true });
  else report.retainedRoot = root;
  if (option("--report"))
    await writeFile(option("--report"), JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
console.log(JSON.stringify(report));
