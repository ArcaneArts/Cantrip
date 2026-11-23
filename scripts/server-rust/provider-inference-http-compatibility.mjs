import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import { literal } from "./project-target-state.mjs";
import { settingsHttpFixture, until } from "./native-settings-http-fixture.mjs";
import { runSettingsInferenceHttpCases } from "./settings-inference-http-cases.mjs";
import { storedStateClocks } from "./stored-state-clocks.mjs";

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  root = await mkdtemp(path.join(tmpdir(), "cantrip-provider-inference-http-"));
const report = {
  suite: "provider-inference-configuration-http",
  databaseMode,
  root,
  completeReplacement: false,
  actualNativeModelExecution: false,
  profiles: [],
};
let pg, active, failure;
try {
  const executable =
      process.env.CANTRIP_RUST_HTTP_FIXTURE_BINARY ??
      (await buildRustExample("http-sql-fixture")),
    repositoryExecutable =
      process.env.CANTRIP_RUST_PROJECT_REPOSITORY_BINARY ??
      (await buildRustExample("project-repository-fixture")),
    passwordHash = await hashPassword(password);
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
        snapshotProofs: 0,
        rawCommands: [],
        rejectedAcknowledgements: [],
      };
      outputs.push(result);
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      let rejectNext = false,
        held,
        h;
      h = active = await settingsHttpFixture({
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
        configure: (owner) => [
          `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('probe-zai',${literal(owner)},'Probe','openai-compatible','https://api.z.ai/api/v1')`,
          `INSERT INTO model_profiles(id,owner_id,name) VALUES('probe-generic',${literal(owner)},'Generic')`,
          "INSERT INTO model_routes(id,model_id,provider_id,model_name,position) VALUES('probe-generic-route','probe-generic','probe-zai','glm-4.5',0)",
        ],
        onCommand: async (command) => {
          if (command.type !== "inference.configure") return;
          result.rawCommands.push(structuredClone(command));
          if (
            rejectNext &&
            command.configurations.some(
              (c) =>
                c.providerId === "probe-zai" && c.maxConcurrentInference === 4,
            )
          ) {
            rejectNext = false;
            held.requested = true;
            const status = {
              ...h.inferenceSnapshot(),
              ownerId: "99999999-9999-4999-8999-999999999999",
            };
            result.rejectedAcknowledgements.push({
              command: structuredClone(command),
              status,
            });
            await new Promise((resolve) => (held.release = resolve));
            return status;
          }
        },
      });
      let before;
      try {
        await runSettingsInferenceHttpCases(h, h.visit, result);
        const first = h.inferenceSyncs.length;
        rejectNext = true;
        held = { requested: false };
        const pending = h.visit(
          "saved limit survives invalid worker owner acknowledgement",
          "PATCH",
          "/api/settings/providers/probe-zai",
          {
            json: {
              name: "Probe",
              kind: "openai-compatible",
              baseUrl: "https://api.z.ai/api/v1",
              maxConcurrentInference: 4,
            },
          },
        );
        pending.catch(() => {});
        await until(() => held.requested, Boolean);
        const saved = await Promise.race([
          pending,
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    "HTTP save waited for the held worker acknowledgement",
                  ),
                ),
              1500,
            ).unref(),
          ),
        ]);
        assert.equal(saved.maxConcurrentInference, 4);
        assert.equal(saved.inferenceConfigRevision, 4);
        assert.equal(typeof held.release, "function");
        held.release();
        await until(
          () =>
            h.inferenceSyncs
              .slice(first)
              .find((delivery) =>
                delivery.configurations.some(
                  (c) =>
                    c.providerId === "probe-zai" &&
                    c.maxConcurrentInference === 4 &&
                    c.inferenceConfigRevision === 4,
                ),
              ),
          Boolean,
        );
        assert.equal(result.rejectedAcknowledgements.length, 1);
        const pool = h
          .inferenceSnapshot()
          .pools.find((pool) => pool.providerId === "probe-zai");
        assert.equal(pool.maxConcurrentInference, 4);
        assert.equal(pool.inferenceConfigRevision, 4);
        result.retry = {
          invalidOwnerRejected: true,
          deliveryRecovered: true,
          savedLimit: 4,
          savedRevision: 4,
          httpSaveBeforeWorkerAcknowledgement: true,
        };
        result.rawInferenceDeliveries = h.inferenceSyncs.map((value) =>
          structuredClone(value),
        );
        [before] = await h.fixture.sql(
          [],
          [
            "SELECT to_jsonb(p)::text result FROM model_providers p WHERE id='probe-zai'",
          ],
        );
      } finally {
        held?.release?.();
        await h.close();
        active = null;
      }
      const database = await repositoryFixture({
        kind,
        executable: repositoryExecutable,
        root: path.join(root, profile),
        databaseMode,
        databaseUrl: url,
      });
      try {
        const read = await database.request({
          op: "query-json",
          sql: "SELECT to_jsonb(p) result FROM model_providers p WHERE id='probe-zai'",
        });
        assert.equal(read.rejected, false, read.diagnostic);
        assert.deepEqual(read.value, before);
        result.rawProvider = { before, reopened: read.value };
        result.provider = h.fixture.normalize(
          storedStateClocks(read.value, result.startedAt),
        );
      } finally {
        await database.close();
      }
    }
    for (const key of [
      "observations",
      "providerInferenceLiveSynchronization",
      "retry",
      "provider",
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
