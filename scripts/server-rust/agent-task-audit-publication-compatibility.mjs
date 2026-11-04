// Both implementations must await the actual audit INSERT before publishing HTTP.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
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
import { literal } from "./project-target-state.mjs";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const postgres = require("postgres");
const reportPath = process.argv[process.argv.indexOf("--report") + 1];
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-task-audit-publication-"),
);
const report = {
  root,
  actualHttp: true,
  actualWorkerConnection: true,
  actualDatabaseAuditBarrier: true,
  databaseMode: "postgres",
  completeReplacement: false,
  investigationOnly: false,
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
          `UPDATE chats SET status='running',permission_profile_id=':workspace' WHERE id=${literal(chat)}`,
          `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('task-audit-lane',${literal(chat)},${literal(tree)},${literal(worker)},'agent',false,'Qualification','active',now(),'settings-runtime')`,
          `CREATE FUNCTION task_probe_block_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'mcp.operation.%' THEN PERFORM pg_advisory_xact_lock(2472,120); END IF; RETURN NEW; END $$`,
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
          allowedOperations: ["task.list", "task.status"],
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 120000).toISOString(),
        };
        for (const test of [
          { name: "valid read", operation: "task.list", args: {}, status: 200 },
          {
            name: "invalid arguments",
            operation: "task.status",
            args: { taskIds: [] },
            status: 400,
          },
          {
            name: "forged binding owner",
            operation: "task.list",
            args: {},
            status: 403,
            claims: { ...binding, ownerId: randomUUID() },
          },
          {
            name: "abandoned authenticated read retains its audit",
            operation: "task.list",
            args: {},
            disconnect: true,
            claims: { ...binding, bindingId: randomUUID() },
          },
        ]) {
          const entry = { name: test.name };
          result.cases.push(entry);
          const controller = new AbortController();
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
                  signal: AbortSignal.any([
                    controller.signal,
                    AbortSignal.timeout(15000),
                  ]),
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
            {
              assert.equal(
                entry.firstEvent.event,
                "actual-blocked-audit-insert",
              );
              assert.equal(headersReceived, false);
              assert.equal(responseCompleted, false);
            }
            if (test.disconnect) {
              controller.abort();
              await assert.rejects(pending, { name: "AbortError" });
              entry.callerDisconnectedWhileAuditBlocked = true;
              stop = true;
              release();
              await held;
              held = undefined;
              await waiter;
              const deadline = Date.now() + 12000;
              let rows;
              do {
                rows =
                  await observer`SELECT action,result,owner_id,actor_user_id,actor_session_id,resource_type,resource_id,request_id FROM audit_events WHERE resource_id=${test.claims.bindingId} AND action LIKE 'mcp.operation.%'`;
                if (rows.length) break;
                await sleep(10);
              } while (Date.now() < deadline);
              assert.equal(
                rows.length,
                1,
                "The actual audit INSERT commits after the caller disconnects",
              );
              assert.equal(rows[0].action, "mcp.operation.executed");
              assert.equal(rows[0].result, "succeeded");
              assert.equal(rows[0].owner_id, h.owner);
              assert.equal(rows[0].actor_user_id, null);
              assert.equal(rows[0].actor_session_id, null);
              assert.equal(rows[0].resource_type, "mcp-binding");
              assert.equal(rows[0].resource_id, test.claims.bindingId);
              assert.equal(typeof rows[0].request_id, "string");
              assert.ok(rows[0].request_id.length > 0);
              entry.auditRowsAfterDisconnect = rows;
              continue;
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
            const rows =
              await observer`SELECT action,result,owner_id,actor_user_id,actor_session_id,resource_type,resource_id,request_id FROM audit_events WHERE request_id=${entry.response.httpRequestId} AND action LIKE 'mcp.operation.%'`;
            entry.auditRowsAfterResponse = rows;
            {
              assert.equal(rows.length, 1);
              assert.equal(rows[0].owner_id, h.owner);
              assert.equal(rows[0].request_id, entry.response.httpRequestId);
              assert.equal(rows[0].actor_user_id, null);
              assert.equal(rows[0].actor_session_id, null);
            }
          } finally {
            stop = true;
            release?.();
            await held?.catch(() => {});
            await pending?.catch(() => {});
            await waiter?.catch(() => {});
          }
        }
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
          (c.auditRowsAfterDisconnect ?? c.auditRowsAfterResponse).length === 1,
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
            auditRows: (c.auditRowsAfterDisconnect ?? c.auditRowsAfterResponse)
              ?.length,
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
  "Both MCP peers await their actual audit write before HTTP publication",
);
