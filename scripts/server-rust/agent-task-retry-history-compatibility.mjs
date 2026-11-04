// MCP admission preserves retry history; public start resets it. Both survive restart.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
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

const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const reportPath = process.argv[process.argv.indexOf("--report") + 1];
const root = await mkdtemp(path.join(tmpdir(), "cantrip-task-retry-history-"));
const report = {
  root,
  actualHttp: true,
  actualWorkerConnection: true,
  fullWorkerProcess: false,
  databaseMode,
  actualServerRestarts: true,
  retainedHistoryFixture: true,
  completeReplacement: false,
  profiles: [],
};
let pg, h, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ??
    (await buildRustExample("http-sql-fixture"));
  report.executable = executable;
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !option("--profile") || p === option("--profile"),
  )) {
    const p = { profile, peers: [] };
    report.profiles.push(p);
    for (const kind of ["node", "rust"]) {
      const result = { kind, observations: [], commands: [], cases: [] };
      p.peers.push(result);
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      try {
        h = await settingsHttpFixture({
          kind,
          profile,
          root,
          executable,
          databaseMode,
          passwordHash,
          result,
          liveSqlFixture: true,
          url,
          onCommand: async (command) => {
            result.commands.push({ type: command.type });
          },
        });
        await h.fixture.sql([
          `UPDATE projects SET task_scheduling_paused=true,task_scheduling_paused_at=now() WHERE id=${literal(project)}`,
          `INSERT INTO model_profiles(id,owner_id,name) VALUES('retained-retry-model',${literal(h.owner)},'Owned Task model')`,
          `UPDATE chats SET status='running',permission_profile_id=':workspace',model_id='retained-retry-model' WHERE id=${literal(chat)}`,
          `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('retained-retry-lane',${literal(chat)},${literal(tree)},${literal(worker)},'agent',false,'Qualification','active',now(),'settings-runtime')`,
        ]);
        const [backend] = await h.fixture.sql(
          [],
          [
            "SELECT jsonb_build_object('version',version(),'dataDirectory',current_setting('data_directory'))::text result",
          ],
        );
        result.observedBackend = backend;
        const binding = {
          bindingId: randomUUID(),
          ownerId: h.owner,
          contextKind: "project",
          projectId: project,
          chatId: chat,
          executionLaneId: "retained-retry-lane",
          workerId: worker,
          worktreeId: tree,
          rootKind: "git-worktree",
          scratchRootId: null,
          permissionProfileId: ":workspace",
          allowedOperations: ["task.create", "task.list", "task.status"],
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 120000).toISOString(),
        };
        for (const channel of ["mcp", "public"]) {
          const operationId = randomUUID();
          const hex = createHash("sha256")
            .update(`agent-task:${chat}:${operationId}`)
            .digest("hex");
          const child = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
          const entry = { channel, operationId, child, calls: [], states: [] };
          result.cases.push(entry);
          const task = {
            chatId: child,
            titleProtection: label("chat"),
            task: taskContent(),
            worktreeMode: "agent-managed",
            autoTitle: false,
            planGoalEnabled: false,
            priority: 0,
            modelConfiguration: { modelId: "retained-retry-model" },
          };
          entry.created = await h.visit(
            `${channel} create resumable draft`,
            "POST",
            `/api/projects/${project}/tasks`,
            { status: 201, json: task },
          );
          const now = Date.now();
          const retry = {
            status: "latched",
            failureKind: "connection",
            failureKey: "owned-retained-retry-history",
            dueAt: null,
            attempts: [
              now - 5000,
              now - 4000,
              now - 3000,
              now - 2000,
              now - 1000,
            ],
            claim: null,
          };
          // Explicit persisted-history fixture, not a claim that this probe
          // recreated the older execution lifecycle that produced that history.
          await h.fixture.sql([
            `UPDATE tasks SET automatic_retry=${literal(JSON.stringify(retry))}::jsonb WHERE chat_id=${literal(child)}`,
          ]);
          const state = async () => {
            const [value] = await h.fixture.sql(
              [],
              [
                `SELECT jsonb_build_object('rows',coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT chat_id,row_version,plan_goal_enabled,state,automatic_retry,protected_content,model_configuration,ARRAY(SELECT operation_id FROM task_dispatch_cycles d WHERE d.chat_id=t.chat_id ORDER BY id) AS operation_ids FROM tasks t WHERE chat_id=${literal(child)}) r),'[]'::jsonb))::text result`,
              ],
            );
            return value.rows;
          };
          entry.seed = await state();
          assert.equal(entry.seed.length, 1);
          assert.deepEqual(entry.seed[0].automatic_retry, retry);
          assert.deepEqual(entry.seed[0].operation_ids, []);
          assert.ok(Object.hasOwn(entry.seed[0], "protected_content"));
          const input = agentTaskCreateWireSchema.parse({
            operationId,
            task: {
              chatId: child,
              titleProtection: task.titleProtection,
              task: task.task,
            },
          });
          for (let attempt = 0; attempt < 2; attempt++) {
            if (channel === "mcp") {
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
                    request: { operation: "task.create", arguments: input },
                  }),
                  signal: AbortSignal.timeout(15000),
                },
              );
              const call = {
                status: response.status,
                body: await response.json(),
                httpRequestId: response.headers.get("x-request-id"),
              };
              entry.calls.push(call);
              assert.equal(call.status, 200, JSON.stringify(call));
              assert.equal(call.body.data.tasks[0].id, child);
              assert.equal(call.body.mutated, true);
            } else {
              const value = await h.visit(
                `public start attempt${attempt}`,
                "POST",
                `/api/tasks/${child}/start`,
                { status: 202, json: { operationId, rowVersion: 1 } },
              );
              entry.calls.push({ status: 202, body: value });
            }
            const rows = await state();
            entry.states.push(rows);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].row_version, 1);
            assert.equal(rows[0].plan_goal_enabled, false);
            assert.deepEqual(rows[0].operation_ids, [operationId]);
            assert.deepEqual(
              rows[0].protected_content,
              entry.seed[0].protected_content,
            );
            assert.deepEqual(
              rows[0].model_configuration,
              entry.seed[0].model_configuration,
            );
            assert.deepEqual(
              rows[0].automatic_retry,
              channel === "mcp" ? retry : null,
            );
          }
          entry.historyPreserved = entry.states.every(
            (rows) =>
              JSON.stringify(rows[0].automatic_retry) ===
              JSON.stringify(entry.seed[0].automatic_retry),
          );
          h.worker.close();
          await h.live.close();
          const port = Number(new URL(h.fixture.server.origin).port);
          await h.fixture.close();
          await h.fixture.start({ port });
          await h.reconnectWorker();
          entry.afterActualServerRestart = await state();
          assert.deepEqual(
            entry.afterActualServerRestart,
            entry.states.at(-1),
            "Task retry metadata, opaque payload, model configuration, revision and operation identity survive actual restart",
          );
          entry.serverRestartVerified = true;
        }
        result.serverDiagnostics = h.diagnostics();
      } finally {
        await h?.close();
        h = undefined;
      }
    }
  }
  report.investigationCompleted = true;
  report.compatibilityPassed = report.profiles.every((p) =>
    p.peers.every(
      (peer) => peer.cases.find((c) => c.channel === "mcp").historyPreserved,
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
      completed: report.investigationCompleted,
      compatibilityPassed: report.compatibilityPassed,
      profiles: report.profiles.map((p) => ({
        profile: p.profile,
        peers: p.peers.map((v) => ({
          kind: v.kind,
          cases: v.cases.map((c) => ({
            channel: c.channel,
            historyPreserved: c.historyPreserved,
          })),
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
  "Both MCP peers preserve retry history across replays and actual restarts",
);
