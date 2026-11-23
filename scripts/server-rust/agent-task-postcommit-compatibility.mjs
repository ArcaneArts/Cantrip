// Real PostgreSQL wire boundaries prove MCP enqueue has no retry-reset transaction.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import {
  settingsHttpFixture,
  settingsChat as chat,
  settingsProject as project,
  settingsWorker as worker,
  settingsTree as tree,
} from "./native-settings-http-fixture.mjs";
import { literal, label } from "./project-target-state.mjs";
import { taskContent } from "./task-wire-fixtures.mjs";
import { agentTaskCreateWireSchema } from "../../packages/protocol/dist/agent-task-tools.js";
import { taskRetryDeliveryFixture } from "./task-retry-delivery-fixture.mjs";
const require = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
);
const postgres = require("postgres");
const reportPath = process.argv[process.argv.indexOf("--report") + 1];
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-task-postcommit-database-"),
);
const report = {
  root,
  actualHttp: true,
  actualWorkerConnection: true,
  fullWorkerProcess: false,
  actualPostgresBackendTerminations: 0,
  nativeExtraRetryTransactionInvestigation: false,
  databaseMode: "postgres",
  completeReplacement: false,
  profiles: [],
};
let pg, h, failure;
try {
  const executable =
      process.env.CANTRIP_RUST_SERVER_BINARY ??
      (await buildRustExample("http-sql-fixture")),
    passwordHash = await hashPassword(password);
  report.executable = executable;
  pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"]) {
    const p = { profile, peers: [] };
    report.profiles.push(p);
    for (const kind of ["node", "rust"]) {
      const result = { kind, observations: [], commands: [], responses: [] };
      p.peers.push(result);
      const url = await pg.database();
      let observer, delivery, pending, timer;
      try {
        delivery = await taskRetryDeliveryFixture(url);
        h = await settingsHttpFixture({
          kind,
          profile,
          root,
          executable,
          databaseMode: "postgres",
          passwordHash,
          result,
          liveSqlFixture: true,
          url: delivery.url,
          onCommand: async (command) => {
            result.commands.push({ type: command.type });
          },
        });
        await h.fixture.sql([
          `UPDATE projects SET task_scheduling_paused=true,task_scheduling_paused_at=now() WHERE id=${literal(project)}`,
          `INSERT INTO model_profiles(id,owner_id,name) VALUES('task-postcommit-model',${literal(h.owner)},'Owned Task model')`,
          `UPDATE chats SET status='running',permission_profile_id=':workspace',model_id='task-postcommit-model' WHERE id=${literal(chat)}`,
          `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('task-postcommit-lane',${literal(chat)},${literal(tree)},${literal(worker)},'agent',false,'Qualification','active',now(),'settings-runtime')`,
        ]);
        observer = postgres(url, {
          max: 1,
          connection: {
            application_name: "cantrip-owned-postcommit-connection-observer",
          },
        });
        const binding = {
          bindingId: randomUUID(),
          ownerId: h.owner,
          contextKind: "project",
          projectId: project,
          chatId: chat,
          executionLaneId: "task-postcommit-lane",
          workerId: worker,
          worktreeId: tree,
          rootKind: "git-worktree",
          scratchRootId: null,
          permissionProfileId: ":workspace",
          allowedOperations: ["task.create", "task.list", "task.status"],
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 120000).toISOString(),
        };
        const operationId = randomUUID(),
          hex = createHash("sha256")
            .update(`agent-task:${chat}:${operationId}`)
            .digest("hex");
        const child = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
        const create = agentTaskCreateWireSchema.parse({
          operationId,
          task: {
            chatId: child,
            titleProtection: label("chat"),
            task: taskContent(),
          },
        });
        result.child = child;
        result.operationId = operationId;
        async function call() {
          const response = await fetch(
            h.fixture.server.origin + "/api/internal/agent-operations",
            {
              method: "POST",
              headers: {
                authorization: "Bearer " + h.credential,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                requestId: randomUUID(),
                binding,
                request: { operation: "task.create", arguments: create },
              }),
              signal: AbortSignal.timeout(15000),
            },
          );
          const item = {
            status: response.status,
            body: await response.json(),
            httpRequestId: response.headers.get("x-request-id"),
          };
          result.responses.push(item);
          return item;
        }
        async function state() {
          return observer`SELECT t.chat_id,t.row_version,t.plan_goal_enabled,t.state,t.automatic_retry,ARRAY(SELECT operation_id FROM task_dispatch_cycles d WHERE d.chat_id=t.chat_id ORDER BY id) AS operation_ids FROM tasks t JOIN chats c ON c.id=t.chat_id WHERE t.chat_id=${child}`;
        }
        function exact(rows) {
          assert.equal(rows.length, 1);
          assert.equal(rows[0].chat_id, child);
          assert.equal(rows[0].row_version, 1);
          assert.equal(rows[0].plan_goal_enabled, false);
          assert.equal(rows[0].state, "draft");
          assert.equal(rows[0].automatic_retry, null);
          assert.deepEqual(rows[0].operation_ids, [operationId]);
        }
        const reached = delivery.arm("task-retry-read");
        pending = call();
        pending.catch(() => {});
        const observed = await Promise.race([
          reached.then((boundary) => ({
            event: "extra-retry-query",
            boundary,
          })),
          pending.then((response) => ({ event: "http-response", response })),
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    "Neither HTTP completion nor an actual retry boundary was observed",
                  ),
                ),
              12000,
            );
          }),
        ]);
        clearTimeout(timer);
        result.firstEvent = observed.event;
        if (observed.event === "extra-retry-query") {
          result.extraRetryTransactionObserved = true;
          result.boundary = observed.boundary;
          result.committedBeforeConnectionTermination = await state();
          exact(result.committedBeforeConnectionTermination);
          const pid = result.boundary.backendPid;
          result.actualBackend =
            await observer`SELECT pid,state,left(query,2000) AS query FROM pg_stat_activity WHERE pid=${pid} AND datname=current_database()`;
          assert.equal(result.actualBackend.length, 1);
          assert.equal(result.actualBackend[0].state, "idle in transaction");
          result.termination =
            await observer`SELECT pg_terminate_backend(${pid}) AS terminated`;
          assert.equal(result.termination[0].terminated, true);
          report.actualPostgresBackendTerminations++;
          const first = await pending;
          pending = undefined;
          delivery.release();
          assert.notEqual(
            first.status,
            200,
            "The actual interrupted database transaction fails the initial request",
          );
          result.afterConnectionTermination = await state();
          exact(result.afterConnectionTermination);
        } else {
          result.extraRetryTransactionObserved = false;
          assert.equal(
            observed.response.status,
            200,
            JSON.stringify(observed.response),
          );
          pending = undefined;
          delivery.release();
          result.committedBeforeSuccessfulResponseObservation = await state();
          exact(result.committedBeforeSuccessfulResponseObservation);
        }
        if (kind === "node")
          assert.equal(
            result.extraRetryTransactionObserved,
            false,
            "Source MCP creates directly through dispatch enqueue, without retry reset",
          );
        for (let attempt = 0; attempt < 2; attempt++) {
          const replay = await call();
          assert.equal(replay.status, 200, JSON.stringify(replay));
          assert.equal(replay.body.mutated, true);
          assert.equal(replay.body.data.tasks.length, 1);
          assert.equal(replay.body.data.tasks[0].id, child);
          assert.equal(
            replay.body.data.tasks[0].configuration.modelId,
            "task-postcommit-model",
          );
          const rows = await state();
          exact(rows);
          (result.replayStates ??= []).push(rows);
        }
        result.postCommitRecoveryVerified = true;
      } finally {
        clearTimeout(timer);
        delivery?.release();
        await pending?.catch(() => {});
        result.deliveryObservations = delivery?.observations;
        result.serverDiagnostics = h?.diagnostics();
        await observer?.end({ timeout: 5 });
        await h?.close();
        h = undefined;
        await delivery?.close();
      }
    }
  }
  report.investigationCompleted = true;
  report.compatibilityPassed = report.profiles.every(
    (profile) =>
      profile.peers.length === 2 &&
      profile.peers.every(
        (peer) =>
          peer.extraRetryTransactionObserved === false &&
          peer.postCommitRecoveryVerified === true &&
          peer.responses.length === 3 &&
          peer.responses.every(
            (response) =>
              response.status === 200 &&
              response.body.mutated === true &&
              response.body.data.tasks.length === 1 &&
              response.body.data.tasks[0].id === peer.child &&
              response.body.data.tasks[0].configuration.modelId ===
                "task-postcommit-model",
          ),
      ),
  );
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await h?.close();
  await pg?.close();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      report: reportPath,
      investigationCompleted: report.investigationCompleted,
      compatibilityPassed: report.compatibilityPassed,
      profiles: report.profiles.map((p) => ({
        profile: p.profile,
        peers: p.peers.map((v) => ({
          kind: v.kind,
          statuses: v.responses.map((r) => r.status),
          extraRetryTransactionObserved: v.extraRetryTransactionObserved,
          recoveryVerified: v.postCommitRecoveryVerified,
        })),
      })),
      failure: report.failure,
    }),
  );
}
if (failure) throw failure;
assert.equal(
  report.compatibilityPassed,
  true,
  "Every MCP create/replay must preserve one committed Task/cycle without a post-commit retry-reset transaction",
);
