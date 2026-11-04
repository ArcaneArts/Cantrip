// Paired real HTTP, databases and WorkerConnection preserve MCP Task contracts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
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
import { label, literal, json } from "./project-target-state.mjs";
import { taskContent } from "./task-wire-fixtures.mjs";
import { agentTaskCreateWireSchema } from "../../packages/protocol/dist/agent-task-tools.js";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const taskReadQueries = JSON.parse(
  await readFile(
    new URL(
      "../../cantrip_server_rs/contracts/task-read-queries.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const reportPath =
  option("--report") ??
  `.qa/rust-server/agent-task-audit-matrix-current-${databaseMode}.json`;
const id = (n) => `eeeeeeee-eeee-4eee-8eee-${String(n).padStart(12, "0")}`;
const root = await mkdtemp(path.join(tmpdir(), "cantrip-agent-task-matrix-"));
const report = {
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  databaseMode,
  actualHttp: true,
  actualWorkerConnection: true,
  fullWorkerProcess: false,
  nativeTaskExecution: false,
  completeReplacement: false,
  profiles: [],
  compatibilityPassed: false,
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
    (v) => !option("--profile") || v === option("--profile"),
  )) {
    const p = { profile, peers: [], differences: [], auditDifferences: [] };
    report.profiles.push(p);
    for (const kind of ["node", "rust"]) {
      const result = {
        kind,
        observations: [],
        commands: [],
        snapshotProofs: 0,
        taskObservations: [],
      };
      p.peers.push(result);
      h = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        databaseMode,
        passwordHash,
        result,
        liveSqlFixture: true,
        url:
          pg && (kind === "node" || databaseMode === "postgres")
            ? await pg.database()
            : undefined,
        configure: () => [
          `UPDATE projects SET task_scheduling_paused=true,task_scheduling_paused_at='2026-10-25' WHERE id=${literal(project)}`,
        ],
        onCommand: async (command) => {
          result.commands.push({ type: command.type });
          return undefined;
        },
      });
      try {
        const sql = (statements) => h.fixture.sql(statements);
        await sql([
          `UPDATE chats SET status='running',permission_profile_id=':workspace' WHERE id=${literal(chat)}`,
          `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('agent-task-lane',${literal(chat)},${literal(tree)},${literal(worker)},'agent',false,'Qualification','active',now(),'settings-runtime')`,
        ]);
        const binding = {
          bindingId: randomUUID(),
          ownerId: h.owner,
          contextKind: "project",
          projectId: project,
          chatId: chat,
          executionLaneId: "agent-task-lane",
          workerId: worker,
          worktreeId: tree,
          rootKind: "git-worktree",
          scratchRootId: null,
          permissionProfileId: ":workspace",
          allowedOperations: ["task.create", "task.list", "task.status"],
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 120000).toISOString(),
        };
        async function call(
          name,
          operation,
          args,
          sourceStatus,
          claims = binding,
          credential = h.credential,
        ) {
          const response = await fetch(
            h.fixture.server.origin + "/api/internal/agent-operations",
            {
              method: "POST",
              headers: {
                ...(credential
                  ? { authorization: "Bearer " + credential }
                  : {}),
                "content-type": "application/json",
              },
              body: JSON.stringify({
                requestId: randomUUID(),
                binding: claims,
                request: { operation, arguments: args },
              }),
              signal: AbortSignal.timeout(15000),
            },
          );
          const body = await response.json();
          result.taskObservations.push({
            name,
            operation,
            args,
            status: response.status,
            body,
            httpRequestId: response.headers.get("x-request-id"),
          });
          if (kind === "node" && sourceStatus !== undefined)
            assert.equal(
              response.status,
              sourceStatus,
              profile + "/" + name + ":" + JSON.stringify(body),
            );
          return body;
        }
        await call(
          "worker authentication required",
          "task.list",
          {},
          401,
          binding,
          null,
        );
        await call("forged binding owner", "task.list", {}, 403, {
          ...binding,
          ownerId: id(99),
        });
        await call("expired binding", "task.list", {}, 401, {
          ...binding,
          issuedAt: new Date(Date.now() - 2000).toISOString(),
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        });
        await call("stale execution lane read", "task.list", {}, 200, {
          ...binding,
          executionLaneId: "stale-lane",
        });
        await call("stale execution lane mutation", "task.create", {}, 409, {
          ...binding,
          executionLaneId: "stale-lane",
        });
        await call("empty project list", "task.list", {}, 200);
        for (const n of [1, 2])
          await sql([
            `INSERT INTO chats(id,owner_id,project_id,protected_label,active_worktree_id,active_worker_id,experience,created_at,updated_at) VALUES(${literal(id(n))},${literal(h.owner)},${literal(project)},${json(label("chat"))},${literal(tree)},${literal(worker)},'task','2026-10-25','2026-10-25')`,
            `INSERT INTO tasks(chat_id,state,plan_goal_enabled,protected_content,created_at,updated_at) VALUES(${literal(id(n))},'draft',false,${json(taskContent().protectedContent)},'2026-10-25','2026-10-25')`,
          ]);
        await call("two Task list", "task.list", {}, 200);
        await call("one Task page", "task.list", { cursor: 0, limit: 1 }, 200);
        await call(
          "empty tail page",
          "task.list",
          { cursor: 10, limit: 1 },
          200,
        );
        const status = await call(
          "requested order and deduplication",
          "task.status",
          { taskIds: [id(1), id(3), id(1), id(2), id(3)] },
          200,
        );
        if (kind === "node") {
          assert.deepEqual(
            status.data.tasks.map((t) => t.id),
            [id(1), id(2)],
          );
          assert.deepEqual(status.data.missingTaskIds, [id(3)]);
          assert.equal(status.summary, "Read 2 project Task statuses.");
        }
        const operationId = id(10),
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
        await call("missing selected model", "task.create", create, 409);
        await call(
          "wrong source identity",
          "task.create",
          { ...create, task: { ...create.task, chatId: id(11) } },
          403,
        );
        await call(
          "invalid status empty ids",
          "task.status",
          { taskIds: [] },
          400,
        );
        await call(
          "invalid list unknown field",
          "task.list",
          { unknown: true },
          400,
        );
        const legacy = { ...binding, canonicalRoot: "/worker-owned/settings" };
        delete legacy.contextKind;
        delete legacy.scratchRootId;
        await call("legacy project binding", "task.list", {}, 200, legacy);
        await call("unknown future grant filtered", "task.list", {}, 200, {
          ...binding,
          allowedOperations: [
            ...binding.allowedOperations,
            "future.unknown.operation",
          ],
        });
        await sql([
          `INSERT INTO chats(id,owner_id,context_kind,protected_label,active_worker_id,active_scratch_root_id,worktree_mode,status,permission_profile_id) VALUES('standalone',${literal(h.owner)},'standalone',${json(label("chat"))},${literal(worker)},'scratch',NULL,'running',':workspace')`,
          `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,protected_path_handle,status) VALUES('scratch','standalone',${literal(h.owner)},${literal(worker)},'ctrr_${"A".repeat(43)}','ready')`,
          `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,scratch_root_id,codex_thread_id) VALUES('standalone-runtime','standalone',${literal(worker)},'scratch','standalone-thread')`,
          `INSERT INTO chat_execution_lanes(id,chat_id,scratch_root_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('standalone-lane','standalone','scratch',${literal(worker)},'agent',false,'Qualification','active',now(),'standalone-runtime')`,
        ]);
        await call("standalone Task rejection", "task.list", {}, 403, {
          ...binding,
          contextKind: "standalone",
          projectId: null,
          chatId: "standalone",
          executionLaneId: "standalone-lane",
          worktreeId: null,
          rootKind: null,
          scratchRootId: "scratch",
        });
        await sql([
          `INSERT INTO model_profiles(id,owner_id,name) VALUES('agent-task-model',${literal(h.owner)},'Agent Task model')`,
          `UPDATE chats SET model_id='agent-task-model' WHERE id=${literal(chat)}`,
        ]);
        for (const attempt of [1, 2]) {
          const queued = await call(
            `positive source-scoped admission ${attempt}`,
            "task.create",
            create,
            200,
          );
          if (queued.data?.tasks?.length === 1) {
            assert.equal(queued.data.tasks[0].id, child);
            assert.equal(
              queued.data.tasks[0].configuration.modelId,
              "agent-task-model",
            );
            assert.equal(queued.mutated, true);
            const [stored] = await h.fixture.sql(
              [],
              [
                `SELECT jsonb_build_object('updatedAt',t.updated_at,'planGoalEnabled',t.plan_goal_enabled,'cycles',(SELECT count(*)::int4 FROM task_dispatch_cycles d WHERE d.chat_id=t.chat_id))::text result FROM tasks t WHERE t.chat_id=${literal(child)}`,
              ],
            );
            assert.equal(
              queued.data.tasks[0].updatedAt,
              new Date(stored.updatedAt).toISOString(),
            );
            assert.equal(stored.planGoalEnabled, false);
            assert.equal(stored.cycles, 1);
            // Verify the stored timestamp exactly before replacing only this peer-generated value.
            result.taskObservations.at(-1).verifiedTaskUpdatedAt =
              queued.data.tasks[0].updatedAt;
            queued.data.tasks[0].updatedAt = "<verified stored Task updatedAt>";
            const code = queued.data.tasks[0].eligibilityCode;
            assert.ok(
              code === null || code === "project-paused",
              "Only pending or paused-project eligibility is valid",
            );
            result.taskObservations.at(-1).observedEligibilityCode = code;
            queued.data.tasks[0].eligibilityCode =
              "<pending or observed paused-project eligibility>";
          }
        }
        await sql([
          `CREATE FUNCTION task_probe_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'mcp.operation.%' THEN RAISE EXCEPTION 'owned MCP audit-write failure'; END IF; RETURN NEW; END $$`,
          "CREATE TRIGGER task_probe_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION task_probe_reject_audit()",
        ]);
        const beforeAuditFault = result.taskObservations.length;
        await call(
          "successful Task read survives actual audit write failure",
          "task.status",
          { taskIds: [id(2)] },
          200,
        );
        const rejectedDespiteAuditFailure = await call(
          "invalid Task read survives actual audit write failure",
          "task.status",
          { taskIds: [] },
          400,
        );
        if (kind === "node")
          assert.deepEqual(rejectedDespiteAuditFailure, {
            code: "invalid",
            error: "Cantrip MCP operation validation failed on the server.",
          });
        const [auditFaultSnapshot] = await h.fixture.sql(
          [],
          [
            "SELECT jsonb_build_object('events',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM audit_events a WHERE a.action LIKE 'mcp.operation.%'),'[]'::jsonb))::text result",
          ],
        );
        const failedAuditRequestIds = result.taskObservations
          .slice(beforeAuditFault)
          .map((v) => v.httpRequestId);
        assert.ok(
          !auditFaultSnapshot.events.some((v) =>
            failedAuditRequestIds.includes(v.request_id),
          ),
          "The actual failing database trigger prevents both audit rows",
        );
        result.auditWriteFailureProof = {
          requestIds: failedAuditRequestIds,
          rowsAbsent: true,
          actualDatabaseTrigger: true,
        };
        await sql([
          "DROP TRIGGER task_probe_audit_failure ON audit_events",
          "DROP FUNCTION task_probe_reject_audit()",
        ]);
        await sql([
          "ALTER TABLE tasks RENAME TO task_probe_storage",
          `CREATE FUNCTION task_probe_remove(selected_chat text) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$ BEGIN IF selected_chat=${literal(id(1))} THEN DELETE FROM chats WHERE id=selected_chat; END IF; RETURN true; END $$`,
          "CREATE VIEW tasks AS SELECT t.* FROM task_probe_storage t WHERE task_probe_remove(t.chat_id)",
        ]);
        await call(
          "Task chat removed between reads",
          "task.status",
          { taskIds: [id(1)] },
          404,
        );
        const [removed] = await h.fixture.sql(
          [],
          [
            `SELECT jsonb_build_object('remaining',count(*)::int4)::text result FROM chats WHERE id=${literal(id(1))}`,
          ],
        );
        assert.equal(removed.remaining, 0);
        await sql([
          `CREATE OR REPLACE FUNCTION task_probe_remove(selected_chat text) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$ BEGIN IF selected_chat=${literal(id(2))} THEN RAISE EXCEPTION 'owned Task-list query failure'; END IF; RETURN true; END $$`,
        ]);
        const listQueryFailure = await call(
          "actual Task query failure",
          "task.list",
          {},
          400,
        );
        const precedence = await call(
          "Task query failure precedes argument validation",
          "task.list",
          { unknown: true },
          400,
        );
        const expectedQueryFailure = {
          code: "invalid",
          error:
            `Failed query: ${taskReadQueries.list}\nparams: ${h.owner},${project}`.slice(
              0,
              2000,
            ),
        };
        for (const observation of result.taskObservations.slice(-2)) {
          assert.equal(observation.status, 400);
          assert.deepEqual(
            observation.body,
            expectedQueryFailure,
            "The real query failure retains the exact Source SQL, actual owner/project parameters and UTF-16 limit",
          );
          observation.verifiedQueryFailure = {
            actualOwner: h.owner,
            actualProject: project,
            sourceSql: taskReadQueries.list,
          };
          // Accounts create a distinct owner in each isolated peer database.
          // Replace that identity only after checking the entire actual error.
          observation.comparisonBody = {
            code: "invalid",
            error:
              "<verified exact Source query failure with actual owner/project>",
          };
        }
        if (kind === "node")
          assert.deepEqual(
            precedence,
            listQueryFailure,
            "Source executes the actual repository read before parsing operation arguments",
          );
        const [audit] = await h.fixture.sql(
          [],
          [
            "SELECT jsonb_build_object('events',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM audit_events a WHERE a.action LIKE 'mcp.operation.%'),'[]'::jsonb))::text result",
          ],
        );
        result.rawMcpAuditEvents = audit.events;
        const byRequest = new Map(
          result.taskObservations.map((v) => [v.httpRequestId, v]),
        );
        result.mcpAuditEvents = audit.events.map((event) => {
          const observation = byRequest.get(event.request_id);
          assert.ok(
            observation,
            "Audit request identity must name the actual HTTP call",
          );
          assert.equal(event.owner_id, h.owner);
          assert.equal(event.actor_user_id, null);
          assert.equal(event.actor_session_id, null);
          assert.equal(event.resource_type, "mcp-binding");
          assert.equal(event.resource_id, binding.bindingId);
          assert.ok(
            Number.isFinite(Date.parse(event.occurred_at)) &&
              Date.parse(event.occurred_at) <= Date.now() + 1000,
            "Actual audit timestamp",
          );
          return {
            case: observation.name,
            action: event.action,
            result: event.result,
            owner: "<verified worker owner>",
            actorUserId: null,
            actorSessionId: null,
            resourceType: event.resource_type,
            resourceId: "<verified binding>",
            requestId: "<verified actual HTTP request ID>",
          };
        });
        result.mcpAuditCounts = Object.fromEntries(
          [
            "mcp.operation.executed",
            "mcp.operation.mutated",
            "mcp.operation.rejected",
          ].map((action) => [
            action,
            audit.events.filter((v) => v.action === action).length,
          ]),
        );
        if (kind === "node") {
          assert.deepEqual(result.mcpAuditCounts, {
            "mcp.operation.executed": 8,
            "mcp.operation.mutated": 2,
            "mcp.operation.rejected": 11,
          });
          assert.equal(
            audit.events.filter((v) => v.result === "denied").length,
            3,
          );
          assert.equal(
            audit.events.filter((v) => v.result === "failed").length,
            8,
          );
          assert.ok(
            !result.mcpAuditEvents.some(
              (v) => v.case === "worker authentication required",
            ),
            "Unauthenticated calls do not acquire an audit owner",
          );
        }
      } finally {
        await h.close();
        h = undefined;
      }
    }
    const [source, native] = p.peers;
    assert.equal(
      source.taskObservations.length,
      native.taskObservations.length,
    );
    for (let i = 0; i < source.taskObservations.length; i++) {
      const a = source.taskObservations[i],
        b = native.taskObservations[i];
      assert.equal(a.name, b.name);
      if (
        JSON.stringify([a.status, a.comparisonBody ?? a.body]) !==
        JSON.stringify([b.status, b.comparisonBody ?? b.body])
      )
        p.differences.push({
          name: a.name,
          node: { status: a.status, body: a.body },
          rust: { status: b.status, body: b.body },
        });
    }
    if (
      JSON.stringify(source.mcpAuditEvents) !==
      JSON.stringify(native.mcpAuditEvents)
    )
      p.auditDifferences.push({
        node: source.mcpAuditCounts,
        rust: native.mcpAuditCounts,
        orderedEventsEqual: false,
      });
  }
  report.investigationCompleted = true;
  report.compatibilityPassed = report.profiles.every(
    (p) => p.differences.length === 0 && p.auditDifferences.length === 0,
  );
  assert.equal(
    report.compatibilityPassed,
    true,
    "MCP Task response/audit comparisons must all match Source",
  );
  console.log(
    JSON.stringify({
      investigationCompleted: true,
      compatibilityPassed: report.compatibilityPassed,
      profiles: report.profiles.map((p) => ({
        profile: p.profile,
        casesPerPeer: p.peers[0].taskObservations.length,
        differences: p.differences.length,
        auditEvents: p.peers.map((v) => v.mcpAuditCounts),
        auditDifferences: p.auditDifferences.length,
      })),
    }),
  );
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  throw error;
} finally {
  await h?.close();
  await pg?.close();
  if (failure) report.retainedRoot = root;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  if (!failure) await rm(root, { recursive: true, force: true });
}
