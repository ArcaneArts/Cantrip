// Real receipt view lifetimes. SQL control exists only in the development
// executable/oracle; normal production HTTP is covered by the companion suite.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import {
  settingsHttpFixture,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import {
  seedEventChats,
  prepareEventCommands,
} from "./native-event-http-setup.mjs";
import { literal } from "./project-target-state.mjs";
import { ManagedNativeQueueClient } from "../../cantrip_worker/src/managed-native-queue-client.ts";
import { nativeQueueReceiptCases } from "./native-queue-receipt-cases.mjs";
import { nativeQueueAuthorityCase } from "./native-queue-authority-case.mjs";
import { nativeQueueTransactionCase } from "./native-queue-transaction-case.mjs";
import { nativeQueueDisconnectedMutation } from "./native-queue-disconnected-mutation.mjs";

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(path.join(tmpdir(), "cantrip-queue-receipts-"));
const report = {
  suite: "actual-native-queue-receipt-http",
  databaseMode,
  completeReplacement: false,
  cases: [],
};
let pg, active, failure;
try {
  const executable = await buildRustExample("http-sql-fixture"),
    repositoryExecutable = await buildRustExample("project-repository-fixture"),
    passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !option("--profile") || p === option("--profile"),
  )) {
    const scenarios = option("--cases")?.split(",") ?? [
      "settlement",
      "disconnect",
      "sql-error",
      ...(profile === "accounts"
        ? [
            "authority",
            "transactions",
            "timeout",
            ...(databaseMode === "postgres"
              ? ["inflight-disconnect", "inflight-mutation-disconnect"]
              : []),
          ]
        : []),
    ];
    for (const scenario of scenarios) {
      const outputs = [];
      report.cases.push({ profile, scenario, outputs });
      for (const kind of ["node", "rust"]) {
        const result = {
          kind,
          observations: [],
          sdkObservations: [],
          workerSdkOperations: 0,
          cryptoProofs: 0,
          proofs: [],
        };
        outputs.push(result);
        report.currentOperation = { profile, scenario, kind, phase: "setup" };
        const databaseUrl =
          pg && (kind === "node" || databaseMode === "postgres")
            ? await pg.database()
            : undefined;
        const h = (active = await settingsHttpFixture({
          kind,
          profile,
          root: path.join(root, scenario),
          executable,
          repositoryExecutable,
          databaseMode,
          passwordHash,
          result,
          liveSqlFixture: true,
          url: databaseUrl,
          configure: (owner) => [
            ...seedEventChats(owner),
            `INSERT INTO model_profiles(id,owner_id,name) VALUES('queue-model',${literal(owner)},'Controlled receipt queue')`,
          ],
          onCommand: async (command) =>
            command.type === "chat.queue.changed" ? null : undefined,
        }));
        try {
          h.prepared = await prepareEventCommands(h);
          const client = new ManagedNativeQueueClient({
            serverUrl: h.fixture.server.origin,
            workerId: worker,
            token: () => h.credential,
          });
          report.currentOperation.phase = "receipt";
          if (scenario === "authority")
            await nativeQueueAuthorityCase({ h, client, result });
          else if (scenario === "transactions")
            await nativeQueueTransactionCase({ h, client, result });
          else if (scenario === "inflight-mutation-disconnect")
            await nativeQueueDisconnectedMutation({
              h,
              client,
              result,
              databaseUrl,
            });
          else
            await nativeQueueReceiptCases({
              h,
              client,
              result,
              scenario,
              databaseUrl,
            });
          result.diagnostics = h.diagnostics();
        } finally {
          result.diagnostics = h.diagnostics();
          await h.close();
          active = null;
        }
      }
      for (const key of [
        "observations",
        "sdkObservations",
        "workerSdkOperations",
        "cryptoProofs",
        "proofs",
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
  report.retainedRoot = root;
  report.diagnostics = active?.diagnostics();
} finally {
  await active?.close().catch(() => {});
  await pg?.close();
  if (option("--report")) {
    const file = path.resolve(option("--report"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({ passed: true, databaseMode, cases: report.cases.length }),
);
