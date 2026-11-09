// Committed Tasks and App Live publication survive an actual failed audit INSERT.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
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
const require = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
);
const postgres = require("postgres");
const reportPath = process.argv[process.argv.indexOf("--report") + 1];
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-task-postcommit-audit-"),
);
const report = {
  root,
  actualHttp: true,
  actualWorkerConnection: true,
  actualDatabaseAuditBarrier: true,
  databaseMode: "postgres",
  completeReplacement: false,
  investigationOnly: false,
  postCommitAuditFailure: true,
  appLivePublicationOrdering: true,
  profiles: [],
};
let pg, h, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ??
    (await buildRustExample("http-sql-fixture"));
  report.executable = executable;
  const passwordHash = await hashPassword(password);
  pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"]) {
    const p = { profile, peers: [] };
    report.profiles.push(p);
    for (const kind of ["node", "rust"]) {
      const result = { kind, observations: [], commands: [], cases: [] };
      p.peers.push(result);
      const url = await pg.database();
      let observer, blocker;
      try {
        h = await settingsHttpFixture({
          kind,
          profile,
          root,
          executable,
          databaseMode: "postgres",
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
          `INSERT INTO model_profiles(id,owner_id,name) VALUES('task-postcommit-model',${literal(h.owner)},'Owned Task model')`,
          `UPDATE chats SET status='running',permission_profile_id=':workspace',model_id='task-postcommit-model' WHERE id=${literal(chat)}`,

          `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('task-audit-lane',${literal(chat)},${literal(tree)},${literal(worker)},'agent',false,'Qualification','active',now(),'settings-runtime')`,
          `CREATE FUNCTION task_probe_block_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'mcp.operation.%' THEN PERFORM pg_advisory_xact_lock(2472,120); RAISE EXCEPTION 'owned post-commit MCP audit failure'; END IF; RETURN NEW; END $$`,
          "CREATE TRIGGER task_probe_audit_barrier BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION task_probe_block_audit()",
        ]);
        observer = postgres(url, {
          max: 1,
          connection: {
            application_name: "cantrip-owned-audit-barrier-observer",
          },
        });
        blocker = postgres(url, {
          max: 1,
          connection: {
            application_name: "cantrip-owned-audit-publication-gate",
          },
        });
        const binding = {
          bindingId: randomUUID(),
          ownerId: h.owner,
          contextKind: "project",
          projectId: project,
          chatId: chat,
          executionLaneId: "task-audit-lane",
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
        await h.live.subscribed("task-audit-project", [
          { kind: "project", projectId: project },
          { kind: "chat", chatId: chat },
        ]);
        for (const test of [
          {
            name: "creation survives post-commit audit failure",
            operation: "task.create",
            args: create,
            status: 200,
          },
          {
            name: "exact creation replay survives post-commit audit failure",
            operation: "task.create",
            args: create,
            status: 200,
          },
        ]) {
          const entry = { name: test.name };
          result.cases.push(entry);
          await h.live.ping("before owned MCP Task request");
          const liveStart = h.live.history.length;
          const liveCursor = Math.max(
            0,
            ...h.live.history
              .filter((frame) => frame.type === "event")
              .map((frame) => frame.cursor),
          );
          entry.beforeRequestLiveCursor = liveCursor;
          let held,
            release,
            acquired,
            pending,
            waiter,
            stop = false,
            headersReceived = false,
            responseCompleted = false;
          try {
            const ready = new Promise((r) => {
                acquired = r;
              }),
              gate = new Promise((r) => {
                release = r;
              });
            held = blocker.begin(async (tx) => {
              const [pid] = await tx`SELECT pg_backend_pid() AS pid`;
              await tx`SELECT pg_advisory_xact_lock(2472,120)`;
              acquired(pid.pid);
              await gate;
            });
            const blockerPid = await Promise.race([
              ready,
              held.then(() => {
                throw new Error(
                  "Audit gate ended before acquiring its advisory lock",
                );
              }),
            ]);
            pending = (async () => {
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
                    binding: test.claims ?? binding,
                    request: {
                      operation: test.operation,
                      arguments: test.args,
                    },
                  }),
                  signal: AbortSignal.timeout(15000),
                },
              );
              headersReceived = true;
              const body = await response.json();
              responseCompleted = true;
              return {
                event: "http-response",
                status: response.status,
                body,
                httpRequestId: response.headers.get("x-request-id"),
              };
            })();
            pending.catch(() => {});
            waiter = (async () => {
              const deadline = Date.now() + 12000;
              while (!stop && Date.now() < deadline) {
                const rows =
                  await observer`SELECT pid,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers,left(query,2000) AS query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active'`;
                const blocked = rows.find(
                  (r) =>
                    r.blockers.includes(blockerPid) &&
                    /audit_events/i.test(r.query),
                );
                if (blocked)
                  return {
                    event: "actual-blocked-audit-insert",
                    at: new Date().toISOString(),
                    blockerPid,
                    blocked,
                  };
                await sleep(10);
              }
              if (!stop)
                throw new Error(
                  "Neither a complete HTTP response nor an actual audit lock wait was observed",
                );
              return { event: "observer-stopped-after-response" };
            })();
            waiter.catch(() => {});
            entry.firstEvent = await Promise.race([pending, waiter]);
            entry.beforeRelease = { headersReceived, responseCompleted };
            const matches = (resource) => (frame) =>
              frame.type === "event" &&
              frame.cursor > liveCursor &&
              frame.scope.kind === "project" &&
              frame.scope.projectId === project &&
              frame.resource === resource &&
              frame.entityId === child;
            const chatEvent = await h.live.message(matches("chat"));
            const taskEvent = await h.live.message(matches("task"));
            await h.live.ping("actual Task publication before audit release");
            entry.liveBeforeAuditRelease = {
              headersReceived,
              responseCompleted,
              chatEvent,
              taskEvent,
              events: h.live.history
                .slice(liveStart)
                .filter(
                  (frame) => frame.type === "event" && frame.entityId === child,
                ),
            };
            entry.auditWaitAfterLive =
              await observer`SELECT pid,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND ${blockerPid}=ANY(pg_blocking_pids(pid)) AND query ILIKE '%audit_events%'`;
            {
              assert.equal(headersReceived, false);
              assert.equal(responseCompleted, false);
              assert.equal(
                entry.auditWaitAfterLive.length,
                1,
                "Actual audit INSERT is still blocked after both App Live events",
              );
              assert.equal(entry.auditWaitAfterLive[0].wait_event, "advisory");
            }
            assert.equal(chatEvent.action, "invalidated");
            assert.equal(taskEvent.action, "invalidated");
            assert.ok(
              chatEvent.cursor > liveCursor && taskEvent.cursor > liveCursor,
              "Both observed events follow this actual HTTP request",
            );
            assert.ok(
              entry.liveBeforeAuditRelease.events.some(
                (frame) => frame.cursor === chatEvent.cursor,
              ),
            );
            assert.ok(
              entry.liveBeforeAuditRelease.events.some(
                (frame) => frame.cursor === taskEvent.cursor,
              ),
            );
            entry.committedBeforeAuditRelease =
              await observer`SELECT t.chat_id,t.row_version,t.plan_goal_enabled,t.state,c.project_id,(SELECT count(*)::int FROM task_dispatch_cycles d WHERE d.chat_id=t.chat_id) AS cycles,ARRAY(SELECT operation_id FROM task_dispatch_cycles d WHERE d.chat_id=t.chat_id ORDER BY id) AS operation_ids FROM tasks t JOIN chats c ON c.id=t.chat_id WHERE t.chat_id=${child}`;
            assert.equal(entry.committedBeforeAuditRelease.length, 1);
            const stored = entry.committedBeforeAuditRelease[0];
            assert.equal(stored.plan_goal_enabled, false);
            assert.equal(stored.cycles, 1);
            assert.deepEqual(stored.operation_ids, [operationId]);
            assert.equal(stored.row_version, 1);
            assert.equal(stored.project_id, project);

            {
              assert.equal(
                entry.firstEvent.event,
                "actual-blocked-audit-insert",
              );
              assert.equal(headersReceived, false);
              assert.equal(responseCompleted, false);
            }
            stop = true;
            release();
            await held;
            held = undefined;
            entry.response = await pending;
            await waiter;
            assert.equal(
              entry.response.status,
              test.status,
              JSON.stringify(entry.response),
            );
            assert.equal(entry.response.body.data.tasks[0].id, child);
            assert.equal(entry.response.body.mutated, true);
            assert.equal(entry.response.body.data.tasks.length, 1);
            assert.equal(
              entry.response.body.data.tasks[0].configuration.modelId,
              "task-postcommit-model",
            );

            const rows =
              await observer`SELECT action,result,owner_id,actor_user_id,actor_session_id,resource_type,resource_id,request_id FROM audit_events WHERE request_id=${entry.response.httpRequestId} AND action LIKE 'mcp.operation.%'`;
            entry.auditRowsAfterResponse = rows;
            assert.equal(
              rows.length,
              0,
              "The actual failing database trigger prevents the audit row",
            );
            entry.afterResponse =
              await observer`SELECT t.chat_id,t.row_version,(SELECT count(*)::int FROM task_dispatch_cycles d WHERE d.chat_id=t.chat_id) AS cycles,ARRAY(SELECT operation_id FROM task_dispatch_cycles d WHERE d.chat_id=t.chat_id ORDER BY id) AS operation_ids FROM tasks t WHERE t.chat_id=${child}`;
            assert.equal(entry.afterResponse.length, 1);
            assert.equal(entry.afterResponse[0].cycles, 1);
            assert.deepEqual(entry.afterResponse[0].operation_ids, [
              operationId,
            ]);
            assert.equal(entry.afterResponse[0].row_version, 1);
          } finally {
            stop = true;
            release?.();
            await held?.catch(() => {});
            await pending?.catch(() => {});
            await waiter?.catch(() => {});
          }
        }
        result.serverDiagnostics = h.diagnostics();
      } finally {
        await observer?.end({ timeout: 5 });
        await blocker?.end({ timeout: 5 });
        await h?.close();
        h = undefined;
      }
    }
  }
  report.investigationCompleted = true;
  report.compatibilityPassed = report.profiles.every((p) =>
    p.peers.every((peer) =>
      peer.cases.every(
        (c) =>
          c.firstEvent.event === "actual-blocked-audit-insert" &&
          c.auditRowsAfterResponse.length === 0,
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
        peers: p.peers.map((peer) => ({
          kind: peer.kind,
          cases: peer.cases.map((c) => ({
            name: c.name,
            firstEvent: c.firstEvent?.event,
            status: c.response?.status,
            auditRows: c.auditRowsAfterResponse?.length,
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
  "Both peers retain committed Tasks, publish App Live and await best-effort audit before HTTP",
);
