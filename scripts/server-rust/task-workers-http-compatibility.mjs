// Retired Task Worker routes must stay unavailable on both production servers.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-retired-task-workers-http-"),
);
const report = {
  suite: "retired-task-worker-http-routes",
  databaseMode,
  profiles: [],
};
let pg, active, failure;
try {
  const executable = await buildRustServer(),
    passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !option("--profile") || p === option("--profile"),
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const fixture = (active = new HttpFixture({
        kind,
        executable,
        root,
        name: profile,
        databaseMode,
        environment: {
          CANTRIP_AUTH_MODE: profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
          CANTRIP_SESSION_TTL_SECONDS: "3600",
          ...(profile === "password"
            ? { CANTRIP_PASSWORD_HASH: passwordHash }
            : {}),
          ...(url ? { DATABASE_URL: url } : {}),
          ...(kind === "rust" && databaseMode === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      }));
      try {
        await fixture.start();
        if (profile === "accounts")
          await fixture.observe("register", "POST", "/api/auth/register", {
            status: 201,
            json: {
              email: "retired-presets@example.invalid",
              displayName: "Tasks",
              password,
            },
          });
        else {
          await fixture.observe("session", "GET", "/api/auth/session");
          if (profile === "password")
            await fixture.observe("login", "POST", "/api/auth/login", {
              json: { password },
            });
        }
        const observations = [];
        for (const [method, suffix] of [
          ["GET", ""],
          ["POST", ""],
          ["PATCH", "/00000000-0000-4000-8000-000000000001"],
          ["DELETE", "/00000000-0000-4000-8000-000000000001"],
          ["PUT", "/order"],
        ]) {
          const result = await fixture.observe(
            method,
            method,
            "/api/settings/task-workers" + suffix,
            {
              status: 404,
              csrf: method !== "GET" && Boolean(fixture.client().csrf),
              ...(method === "GET" ? {} : { json: {} }),
            },
          );
          observations.push(result);
        }
        outputs.push({ kind, observations });
      } finally {
        await fixture.close();
        active = null;
      }
    }
    assert.equal(outputs.length, 2);
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.passed = false;
  report.error = error.stack ?? String(error);
} finally {
  await active?.close();
  await pg?.close();
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    profiles: report.profiles.length,
    passed: report.passed,
  }),
);
