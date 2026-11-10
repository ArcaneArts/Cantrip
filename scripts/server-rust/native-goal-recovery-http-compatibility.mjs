// Production HTTP and worker sockets with real SQL and controlled native
// capture/observation replies. This does not run a native Core Goal cycle.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import {
  settingsHttpFixture,
  settingsChat,
} from "./native-settings-http-fixture.mjs";
import { task } from "./native-event-http-setup.mjs";
import { agentGoalRecoveryHttpCases } from "./native-goal-recovery-http-agent.mjs";
import {
  goalRecoveryRouting,
  nativeGoalRecoverySeed,
  taskGoalRecoveryHttpCases,
} from "./native-goal-recovery-http-task.mjs";

const option = (key) => {
  const index = process.argv.indexOf(key);
  return index < 0 ? undefined : process.argv[index + 1];
};
const databaseMode = option("--database") ?? "pglite";
const requestedProfile = option("--profile");
const profiles = ["none", "password", "accounts"];
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(databaseMode));
assert.ok(!requestedProfile || profiles.includes(requestedProfile));
const root = await mkdtemp(path.join(tmpdir(), "cantrip-native-goal-http-"));
const report = {
  suite: "native-goal-recovery-http",
  databaseMode,
  root,
  completeReplacement: false,
  nativeCoreCapture: false,
  profiles: [],
};
let pg, h, failure;
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
    (value) => !requestedProfile || requestedProfile === value,
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = {
        kind,
        observations: [],
        rawCommands: [],
        snapshotProofs: 0,
      };
      outputs.push(result);
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      let taskCases, agentCases, queries;
      h = await settingsHttpFixture({
        kind,
        profile,
        root,
        databaseMode,
        url,
        passwordHash,
        result,
        liveSqlFixture: true,
        environment: { CANTRIP_FIXTURE_LOGGING: "true" },
        executable,
        repositoryExecutable,
        configure: nativeGoalRecoverySeed,
        onCommand: async (command, emit, scope) => {
          result.rawCommands.push(structuredClone(command));
          if (command.type === "chat.queue.changed") return null;
          const taskResult = await taskCases?.handle(command, emit, scope);
          if (taskResult !== undefined) return taskResult;
          return agentCases?.handle(command);
        },
      });
      try {
        taskCases = taskGoalRecoveryHttpCases(h, result);
        agentCases = agentGoalRecoveryHttpCases(h, result, goalRecoveryRouting);
        await h.live.subscribed(
          "native-goal-contexts",
          [task, settingsChat].map((chatId) => ({ kind: "chat", chatId })),
        );
        await taskCases.run(profile);
        const agent = await agentCases.run();
        await h.live.ping("native-goal-final-effects");
        queries = [...taskCases.queries, agent.query];
        result.rawRetained = await h.fixture.sql(
          [],
          queries.map((sql) => sql.replace(" result", "::text result")),
        );
        assert.deepEqual(result.rawRetained.at(-1), agent.finished);
        let previousCursor = 0;
        result.liveEffects = h.live.history
          .filter((frame) => frame.type === "event")
          .map(({ cursor, occurredAt, ...effect }) => {
            assert.ok(Number.isSafeInteger(cursor) && cursor > previousCursor);
            previousCursor = cursor;
            assert.ok(Number.isFinite(Date.parse(occurredAt)));
            return effect;
          });
        assert.equal(
          result.liveEffects.filter(
            (effect) => effect.resource === "chat-queue",
          ).length,
          9,
        );
        result.workerWitnesses = {
          taskGoalReads: result.rawTaskGoalObservations.map(
            ({ command, receipt, phase, workerGeneration }) => {
              assert.equal(
                workerGeneration,
                result.rawTaskWorkerReplacement.newGeneration,
              );
              return {
                phase,
                chatId: command.chatId,
                threadId: command.threadId,
                status: receipt.execution.status,
              };
            },
          ),
          source: result.rawTaskCaptureReceipts.map(({ command, mode }) => ({
            command,
            mode,
          })),
          taskRecovery: result.rawTaskRecoveryReceipts.map(
            ({ command, receipt }) => ({
              type: command.type,
              chatId: command.chatId,
              projectId: command.projectId,
              worktreeId: command.worktreeId,
              threadId: command.threadId,
              modelRoute: command.model.routeId,
              provider: command.provider.id,
              hadAdmission: command.recovery.admission !== null,
              acceptedGeneration:
                receipt.workerGeneration ===
                result.rawTaskWorkerReplacement.newGeneration,
            }),
          ),
          agentRecovery: result.rawAgentRecoveryReceipts.map(
            ({ command, receipt }) => ({
              type: command.type,
              chatId: command.chatId,
              threadId: command.threadId,
              modelRoute: command.model.routeId,
              provider: command.provider.id,
              status: receipt.status,
            }),
          ),
        };
      } finally {
        taskCases?.release();
        agentCases?.release();
        result.rawHttp = Object.fromEntries(h.fixture.records);
        result.rawLive = h.live.history;
        result.diagnostics = h.diagnostics();
        await h.close();
        h = null;
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
        for (const sql of queries) {
          const row = await reopened.request({ op: "query-json", sql });
          assert.equal(row.rejected, false, row.diagnostic);
          result.rawReopened.push(row.value);
        }
        assert.deepEqual(
          result.rawReopened,
          result.rawRetained,
          "all selected Task and Agent recovery state reopens exactly",
        );
        result.exactReopens = result.rawReopened.length;
      } finally {
        await reopened.close();
      }
      console.log(
        JSON.stringify({
          phase: "peer-complete",
          databaseMode,
          profile,
          kind,
          http: result.observations.length,
          exactReopens: result.exactReopens,
        }),
      );
    }
    for (const key of [
      "observations",
      "taskRecovery",
      "heartbeatAdoption",
      "agentRecovery",
      "workerWitnesses",
      "liveEffects",
      "snapshotProofs",
      "taskCryptoProofs",
      "exactReopens",
    ])
      assert.deepEqual(outputs[1][key], outputs[0][key], profile + " " + key);
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await h?.close().catch(() => {});
  await pg?.close();
  const destination = path.resolve(
    option("--report") ?? `.qa/rust-server/native-goal-${databaseMode}.json`,
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
