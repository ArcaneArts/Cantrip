// Compare retained Run capture validation through real production HTTP callers.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { settingsHttpFixture } from "./native-settings-http-fixture.mjs";
import { runCaptureHttpCases } from "./run-capture-http-cases.mjs";
import { literal } from "./project-target-state.mjs";
import { password } from "./security-fixtures.mjs";
const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    profile: { type: "string" },
    report: { type: "string" },
    "keep-fixture": { type: "boolean", default: false },
    production: { type: "boolean", default: false },
  },
});
const root = await mkdtemp(path.join(tmpdir(), "cantrip-run-capture-http-"));
const report = {
  suite: "retained-run-capture-http",
  databaseMode: values.database,
  root,
  completeReplacement: false,
  productionRuntime: values.production,
  usesSqlHttpFixture: !values.production,
  profiles: [],
  cleanupFailures: [],
};
let pg, h, failure, databaseClient;
const require = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
);
try {
  const executable =
    process.env.CANTRIP_RUST_HTTP_FIXTURE_BINARY ??
    (await buildRustExample("http-sql-fixture"));
  const repositoryExecutable =
    process.env.CANTRIP_RUST_PROJECT_FIXTURE_BINARY ??
    (await buildRustExample("project-repository-fixture"));
  const passwordHash = await hashPassword(password);
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !values.profile || p === values.profile,
  )) {
    const peers = [];
    report.profiles.push({ profile, peers });
    for (const kind of ["node", "rust"]) {
      const result = { kind, profile, observations: [] };
      peers.push(result);
      const databaseUrl =
        pg && (kind === "node" || values.database === "postgres")
          ? await pg.database()
          : undefined;
      h = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        repositoryExecutable,
        databaseMode: values.database,
        passwordHash,
        result,
        liveSqlFixture: !values.production,
        environment: { CANTRIP_FIXTURE_LOGGING: "true" },
        url: databaseUrl,
        configure: (owner) => [
          `INSERT INTO model_profiles(id,owner_id,name) VALUES('probe-generic',${literal(owner)},'Generic')`,
        ],
        onCommand: async (command) =>
          command.type === "worktree.observation.configure"
            ? { accepted: true, paths: [] }
            : undefined,
      });
      const server = h.fixture.server;
      if (values.production)
        databaseClient = require("postgres")(databaseUrl, { max: 1 });
      const executeSql = async (statements = [], queries = []) => {
        if (!databaseClient) return h.fixture.sql(statements, queries);
        return databaseClient.begin(async (transaction) => {
          for (const statement of statements)
            await transaction.unsafe(statement);
          const results = [];
          for (const query of queries) {
            const rows = await transaction.unsafe(query);
            results.push(rows[0] ? JSON.parse(rows[0].result) : null);
          }
          return results;
        });
      };
      try {
        if (values.production)
          result.sqlRouteAbsent = await h.fixture.observe(
            "SQL test route absent",
            "POST",
            "/__fixture/sql",
            { csrf: true, json: { statements: [], queries: [] }, status: 404 },
          );
        await runCaptureHttpCases(h, result, executeSql);
        result.passed = true;
      } finally {
        result.diagnostics = server.diagnostics();
        await h.close();
        h = null;
        result.exit = {
          code: server.child.exitCode,
          signal: server.child.signalCode,
        };
      }
      assert.deepEqual(result.exit, { code: 0, signal: null });
      await databaseClient?.end({ timeout: 5 });
      databaseClient = null;
    }
    assert.deepEqual(
      peers[1].observations,
      peers[0].observations,
      profile + " actual retained capture responses and failures",
    );
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.passed = false;
} finally {
  for (const close of [
    () => h?.close(),
    () => databaseClient?.end({ timeout: 5 }),
    () => pg?.close(),
  ])
    try {
      await close();
    } catch (error) {
      failure ??= error;
      report.cleanupFailures.push(error.stack);
    }
  if (failure) report.passed = false;
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
    passed: true,
    database: values.database,
    profiles: report.profiles.length,
  }),
);
