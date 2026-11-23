// Real public catalog HTTP, worker identity, SQL faults and native storage reopen.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import { settingsHttpFixture } from "./native-settings-http-fixture.mjs";
import {
  providerStateSeed,
  providerStateWorker,
} from "./provider-state-worker.mjs";
import { providerStateHttpCases } from "./provider-state-http-cases.mjs";

const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  root = await mkdtemp(path.join(tmpdir(), "cantrip-provider-state-http-"));
const report = {
  suite: "provider-state-public-http",
  databaseMode,
  root,
  completeReplacement: false,
  actualProviderExecution: false,
  profiles: [],
};
let pg, active, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_HTTP_FIXTURE_BINARY ??
    (await buildRustExample("http-sql-fixture"));
  const repositoryExecutable =
    process.env.CANTRIP_RUST_PROJECT_FIXTURE_BINARY ??
    (await buildRustExample("project-repository-fixture"));
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !option("--profile") || option("--profile") === p,
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = {
        kind,
        startedAt: Date.now(),
        observations: [],
        catalogCommands: [],
        rawStages: [],
        stages: [],
        serverExits: [],
        snapshotProofs: 0,
      };
      outputs.push(result);
      const controller = providerStateWorker(result);
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const h = (active = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        repositoryExecutable,
        databaseMode,
        url,
        passwordHash,
        result,
        liveSqlFixture: true,
        configure: providerStateSeed,
        onCommand: controller.onCommand,
      }));
      let proof;
      try {
        proof = await providerStateHttpCases(h, result, controller, profile);
      } catch (error) {
        result.error = { message: error.message, diagnostics: h.diagnostics() };
        throw error;
      } finally {
        await h.close();
        active = null;
      }
      const repository = await repositoryFixture({
        kind,
        executable: repositoryExecutable,
        root: path.join(root, profile),
        databaseMode,
        databaseUrl: url,
      });
      try {
        const reopened = await repository.request({
          op: "query-json",
          sql: proof.storageSql,
        });
        assert.equal(reopened.rejected, false, reopened.diagnostic);
        assert.deepEqual(reopened.value, proof.final);
        result.reopened = proof.canonical(reopened.value);
      } finally {
        await repository.close();
      }
    }
    for (const key of [
      "observations",
      "catalogCommands",
      "stages",
      "reopened",
      "workerInferenceStatus",
      "workerInferenceEvents",
    ])
      assert.deepEqual(outputs[1][key], outputs[0][key], profile + " " + key);
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await active?.close().catch(() => {});
  await pg?.close();
  if (option("--report")) {
    const file = path.resolve(option("--report"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure && !process.argv.includes("--keep-fixture"))
    await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    passed: true,
    databaseMode,
    profiles: report.profiles.length,
  }),
);
