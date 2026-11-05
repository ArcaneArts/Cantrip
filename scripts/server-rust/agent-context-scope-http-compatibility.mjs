// Real authenticated MCP probes preserve project/Task/standalone boundaries.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import { buildRustExample } from "./build.mjs";
import {
  settingsHttpFixture,
  settingsChat as chat,
  settingsProject as project,
  settingsWorker as worker,
  settingsTree as tree,
} from "./native-settings-http-fixture.mjs";
import { literal, json, label } from "./project-target-state.mjs";
import { taskContent } from "./task-wire-fixtures.mjs";
const reportPath = process.argv[process.argv.indexOf("--report") + 1];
const root = await mkdtemp(path.join(tmpdir(), "cantrip-mcp-context-scope-"));
const report = {
  root,
  actualHttp: true,
  actualWorkerConnection: true,
  fullWorkerProcess: false,
  databaseMode: "pglite",
  completeReplacement: false,
  profiles: [],
};
let h, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ??
    (await buildRustExample("http-sql-fixture"));
  report.executable = executable;
  const passwordHash = await hashPassword(password);
  for (const profile of ["none", "password", "accounts"]) {
    const p = { profile, peers: [] };
    report.profiles.push(p);
    for (const kind of ["node", "rust"]) {
      const result = { kind, observations: [], commands: [], calls: [] };
      p.peers.push(result);
      h = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        databaseMode: "pglite",
        passwordHash,
        result,
        liveSqlFixture: true,
        onCommand: async (command) => {
          result.commands.push({ type: command.type });
        },
      });
      try {
        const standalone = "eeeeeeee-eeee-4eee-8eee-000000000400";
        await h.fixture.sql([
          `INSERT INTO chats(id,owner_id,context_kind,protected_label,active_worker_id,active_scratch_root_id,worktree_mode,status,permission_profile_id) VALUES(${literal(standalone)},${literal(h.owner)},'standalone',${json(label("chat"))},${literal(worker)},'mcp-scratch',NULL,'running',':workspace')`,
          `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,protected_path_handle,status) VALUES('mcp-scratch',${literal(standalone)},${literal(h.owner)},${literal(worker)},'ctrr_${"A".repeat(43)}','ready')`,
          `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,scratch_root_id,codex_thread_id) VALUES('mcp-standalone-runtime',${literal(standalone)},${literal(worker)},'mcp-scratch','mcp-standalone-thread')`,
          `INSERT INTO chat_execution_lanes(id,chat_id,scratch_root_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('mcp-standalone-lane',${literal(standalone)},'mcp-scratch',${literal(worker)},'agent',false,'Qualification','active',now(),'mcp-standalone-runtime')`,
        ]);
        const binding = {
          bindingId: randomUUID(),
          ownerId: h.owner,
          contextKind: "standalone",
          projectId: null,
          chatId: standalone,
          executionLaneId: "mcp-standalone-lane",
          workerId: worker,
          worktreeId: null,
          rootKind: null,
          scratchRootId: "mcp-scratch",
          permissionProfileId: ":workspace",
          allowedOperations: [
            "context.get",
            "chat.list",
            "chat.read",
            "chat.wait",
          ],
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 120000).toISOString(),
        };
        async function call(
          name,
          operation,
          args,
          status,
          expected,
          claims = binding,
        ) {
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
                binding: claims,
                request: { operation, arguments: args },
              }),
              signal: AbortSignal.timeout(15000),
            },
          );
          const body = await response.json();
          result.calls.push({ name, status: response.status, body });
          assert.equal(
            response.status,
            status,
            JSON.stringify({ kind, name, body }),
          );
          assert.deepEqual(body, expected);
        }
        await call(
          "standalone context remains unsupported",
          "context.get",
          {},
          409,
          {
            code: "unsupported-capability",
            error: "Standalone Chats do not support IDE execution operations.",
          },
        );
        for (const operation of ["chat.list", "chat.read", "chat.wait"])
          await call(
            "standalone " + operation + " requires project Agent",
            operation,
            operation === "chat.list" ? {} : { chatId: chat },
            403,
            {
              code: "invalid",
              error: "Chat tools require a project Agent chat.",
            },
          );
        await h.fixture.sql([
          `UPDATE chats SET status='running',experience='task',permission_profile_id=':workspace' WHERE id=${literal(chat)}`,
          `INSERT INTO tasks(chat_id,state,plan_goal_enabled,protected_content) VALUES(${literal(chat)},'draft',false,${json(taskContent().protectedContent)})`,
          `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('mcp-task-caller-lane',${literal(chat)},${literal(tree)},${literal(worker)},'agent',false,'Qualification','active',now(),'settings-runtime')`,
        ]);
        const projectBinding = {
          ...binding,
          contextKind: "project",
          projectId: project,
          chatId: chat,
          executionLaneId: "mcp-task-caller-lane",
          worktreeId: tree,
          rootKind: "git-worktree",
          scratchRootId: null,
        };
        for (const operation of ["chat.list", "chat.read", "chat.wait"])
          await call(
            "Task caller " + operation + " requires Agent experience",
            operation,
            operation === "chat.list" ? {} : { chatId: chat },
            403,
            {
              code: "invalid",
              error: "Chat tools require a project Agent chat.",
            },
            projectBinding,
          );
      } finally {
        result.diagnostics = h.diagnostics();
        await h.close();
        h = undefined;
      }
    }
    assert.deepEqual(p.peers[0].calls, p.peers[1].calls);
  }
  report.compatibilityPassed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await h?.close();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      report: reportPath,
      compatibilityPassed: report.compatibilityPassed,
      profiles: report.profiles.map((p) => ({
        profile: p.profile,
        calls: p.peers.map((v) => v.calls.length),
      })),
      failure: report.failure,
    }),
  );
}
if (failure) throw failure;
assert.equal(report.compatibilityPassed, true);
