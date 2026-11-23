// Actual Node/Rust HTTP, worker credentials, SQL projections and App Live.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { buildRustExample } from "./build.mjs";
import { populatedAlertCases } from "./project-alert-populated-cases.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    profile: { type: "string" },
    report: { type: "string" },
    "keep-fixture": { type: "boolean", default: false },
  },
});
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(values.database));
assert.ok(
  !values.profile || ["none", "password", "accounts"].includes(values.profile),
);
const root = await mkdtemp(path.join(tmpdir(), "cantrip-alert-populated-"));
const report = {
  suite: "populated-project-alert-http-live",
  databaseMode: values.database,
  root,
  completeReplacement: false,
  scope:
    "Actual production HTTP handlers, worker enrollment/credential authentication, SQL Goal/AI Alert projection and real App Live. Resource rows are seeded through an explicit development-only SQL adapter. No worker handler or public response is substituted. This is domain acceptance on the current host, not full product/platform acceptance.",
  profiles: [],
  cleanupFailures: [],
};
let pg, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ??
    (await buildRustExample("http-sql-fixture"));
  const passwordHash = await hashPassword(password);
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of values.profile
    ? [values.profile]
    : ["none", "password", "accounts"]) {
    const current = { profile, peers: [] };
    report.profiles.push(current);
    for (const kind of ["node", "rust"]) {
      const url =
        pg && (kind === "node" || values.database === "postgres")
          ? await pg.database()
          : undefined;
      const fixture = new HttpFixture({
        kind,
        executable,
        root,
        name: profile,
        databaseMode: values.database,
        liveSqlFixture: true,
        environment: {
          CANTRIP_AUTH_MODE: profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
          ...(profile === "password"
            ? { CANTRIP_PASSWORD_HASH: passwordHash }
            : {}),
          ...(url ? { DATABASE_URL: url } : {}),
          ...(kind === "rust" && values.database === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      });
      const result = { kind, http: [], exits: [] };
      current.peers.push(result);
      try {
        await fixture.start();
        result.server = fixture.server;
        await populatedAlertCases(fixture, result, profile);
        result.passed = true;
      } finally {
        result.diagnostics = result.server?.diagnostics();
        let closingError;
        try {
          await fixture.close();
        } catch (error) {
          closingError = error;
          report.cleanupFailures.push(error.stack);
        } finally {
          result.exits.push({
            code: result.server?.child.exitCode,
            signal: result.server?.child.signalCode,
          });
          delete result.server;
        }
        if (closingError) throw closingError;
      }
    }
    assert.deepEqual(
      current.peers[1].http,
      current.peers[0].http,
      profile + ": exact HTTP parity",
    );
    assert.deepEqual(
      current.peers[1].publications,
      current.peers[0].publications,
      profile + ": exact Alert invalidation sequence",
    );
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  try {
    await pg?.close();
  } catch (error) {
    failure ??= error;
    report.cleanupFailures.push(error.stack);
  }
  if (values.report) {
    await mkdir(path.dirname(path.resolve(values.report)), { recursive: true });
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure && !values["keep-fixture"])
    await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode: values.database,
    profiles: report.profiles.length,
    passed: true,
  }),
);
