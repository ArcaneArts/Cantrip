// Real HTTP, Live and WorkerConnection with actual Task codecs and SQL.
// Native model replies and their binding facts are controlled.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import { settingsHttpFixture } from "./native-settings-http-fixture.mjs";
import { taskExecutionHttpCases } from "./task-execution-http-cases.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const databaseMode = option("--database") ?? "pglite";
const profiles = ["none", "password", "accounts"];
const selected = option("--profile");
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(databaseMode));
assert.ok(!selected || profiles.includes(selected));
const root = await mkdtemp(path.join(tmpdir(), "cantrip-task-execution-http-"));
const report = {
  suite: "task-execution-http",
  root,
  databaseMode,
  completeReplacement: false,
  fullWorkerProcess: false,
  profiles: [],
};
let pg, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_HTTP_FIXTURE_BINARY ??
    (await buildRustExample("http-sql-fixture"));
  const repositoryExecutable =
    process.env.CANTRIP_RUST_PROJECT_REPOSITORY_BINARY ??
    (await buildRustExample("project-repository-fixture"));
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of profiles.filter(
    (profile) => !selected || selected === profile,
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = { kind, observations: [], snapshotProofs: 0 };
      outputs.push(result);
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const cases = taskExecutionHttpCases(result);
      const h = await settingsHttpFixture({
        kind,
        profile,
        root,
        databaseMode,
        url,
        passwordHash,
        result,
        executable,
        repositoryExecutable,
        liveSqlFixture: true,
        environment: { CANTRIP_FIXTURE_LOGGING: "true" },
        configure: cases.configure,
        prepare: cases.prepare,
        onCommand: cases.onCommand,
      });
      try {
        await cases.run(h, profile);
      } finally {
        cases.release();
        result.rawHttp = Object.fromEntries(h.fixture.records);
        result.diagnostics = h.diagnostics();
        await h.close();
      }
      const reopened = await repositoryFixture({
        kind,
        executable: repositoryExecutable,
        root: path.join(root, profile),
        databaseMode,
        databaseUrl: url,
      });
      try {
        result.rawReopened = [];
        for (const sql of cases.queries) {
          const row = await reopened.request({ op: "query-json", sql });
          assert.equal(row.rejected, false, row.diagnostic);
          result.rawReopened.push(row.value);
        }
        assert.deepEqual(result.rawReopened, result.rawRetained);
      } finally {
        await reopened.close();
      }
      console.log(
        JSON.stringify({
          phase: "peer-complete",
          databaseMode,
          profile,
          kind,
          http: result.productObservations.length,
          exactReopens: result.rawReopened.length,
        }),
      );
    }
    for (const key of [
      "productObservations",
      "effects",
      "messageEvents",
      "cryptoProofs",
    ])
      assert.deepEqual(outputs[1][key], outputs[0][key], profile + " " + key);
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await pg?.close();
  const destination = path.resolve(
    option("--report") ?? `.qa/rust-server/task-execution-${databaseMode}.json`,
  );
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(report, null, 2) + "\n");
  if (!failure && !process.argv.includes("--keep-fixture"))
    await rm(root, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      databaseMode,
      passed: report.passed ?? false,
      root,
      report: destination,
    }),
  );
}
if (failure) throw failure;
