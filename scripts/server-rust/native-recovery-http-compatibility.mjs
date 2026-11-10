// Current native recovery routes through real HTTP/worker identity, controlled
// checkpoint facts, real restart and endpoint-encrypted canonical persistence.
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
import { seedEventChats } from "./native-event-http-setup.mjs";
import { nativeRecoveryHttpSuspension } from "./native-recovery-http-suspension.mjs";
import { nativeRecoveryHttpGoal } from "./native-recovery-http-goal.mjs";
import { nativeRecoveryHttpRound } from "./native-recovery-http-round.mjs";

const option = (key) => {
  const at = process.argv.indexOf(key);
  return at < 0 ? undefined : process.argv[at + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-native-recovery-http-"),
);
const report = {
  suite: "native-recovery-public-http",
  databaseMode,
  root,
  completeReplacement: false,
  actualNativeCore: false,
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
    const cases = [];
    report.profiles.push({ profile, cases });
    for (const scenario of ["gui", "terminal", "goal", "round"].filter(
      (p) =>
        !(option("--case") ?? option("--origin")) ||
        (option("--case") ?? option("--origin")) === p,
    )) {
      const outputs = [];
      cases.push({ scenario, outputs });
      const caseRoot = path.join(root, scenario);
      for (const kind of ["node", "rust"]) {
        const result = {
          kind,
          observations: [],
          cryptoProofs: 0,
          snapshotProofs: 0,
          proofs: [],
          serverExits: [],
          goalCommands: [],
          goalCommandContracts: [],
        };
        outputs.push(result);
        const url =
          pg && (kind === "node" || databaseMode === "postgres")
            ? await pg.database()
            : undefined;
        const h = (active = await settingsHttpFixture({
          kind,
          profile,
          root: caseRoot,
          executable,
          repositoryExecutable,
          databaseMode,
          url,
          passwordHash,
          result,
          configure: seedEventChats,
          liveSqlFixture: true,
          onCommand: (command) => {
            if (
              scenario === "goal" &&
              (command.type.startsWith("chat.goal.") ||
                command.type === "chat.turn")
            )
              result.goalCommands.push(structuredClone(command));
          },
        }));
        let proof;
        try {
          proof = await (scenario === "goal"
            ? nativeRecoveryHttpGoal(h, result)
            : scenario === "round"
              ? nativeRecoveryHttpRound(h, result)
              : nativeRecoveryHttpSuspension(h, result, scenario));
        } catch (error) {
          result.error = {
            message: error.message,
            diagnostics: h.diagnostics(),
          };
          throw error;
        } finally {
          await h.close();
          active = null;
        }
        const repository = await repositoryFixture({
          kind,
          executable: repositoryExecutable,
          root: path.join(caseRoot, profile),
          databaseMode,
          databaseUrl: url,
        });
        try {
          const data = await repository.request({
            op: "query-json",
            sql: proof.storageSql,
          });
          assert.equal(data.rejected, false, data.diagnostic);
          await proof.proveStored(data.value);
          result.rawState = data.value;
          result.state = proof.content.canonical(
            h.fixture.normalize(data.value),
          );
        } finally {
          await repository.close();
        }
        proof.content.finish();
        result.observations = proof.content.canonical(result.observations);
      }
      for (const key of [
        "observations",
        "cryptoProofs",
        "state",
        "proofs",
        "goalCommandContracts",
      ])
        assert.deepEqual(
          outputs[1][key],
          outputs[0][key],
          profile + " " + scenario + " " + key,
        );
    }
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
