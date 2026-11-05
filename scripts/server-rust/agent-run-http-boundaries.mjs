import assert from "node:assert/strict";
import { label, json, literal } from "./project-target-state.mjs";
import queries from "../../cantrip_server_rs/contracts/mcp-target-queries.json" with { type: "json" };
import {
  settingsChat as chat,
  settingsWorker as worker,
  settingsTree as tree,
} from "./native-settings-http-fixture.mjs";

export async function runRestartCases({
  h,
  call,
  binding,
  state,
  start,
  secret,
  configurationId,
  id,
}) {
  h.worker.close();
  await h.live.close();
  const port = Number(new URL(h.fixture.server.origin).port);
  await h.fixture.close();
  await h.fixture.start({ port });
  await h.reconnectWorker();
  await call("restart fences prior execution", "list", {}, 409);
  await h.fixture.sql([
    `UPDATE chats SET status='running' WHERE id=${literal(chat)}`,
  ]);
  binding.issuedAt = new Date().toISOString();
  binding.expiresAt = new Date(Date.now() + 120000).toISOString();
  const retained = await call(
    "restart retains definition and secret availability",
    "get",
    { configurationId },
  );
  assert.equal(retained.data.result.found, true);
  assert.ok(
    retained.data.secretReferences.some(
      (row) => row.reference === "run/api" && row.available,
    ),
  );
  await call("restart retains runtime status", "status");
  await call("restart rejects prior mutation binding", "start", start, 409);
  // The controlled worker has a fresh execution after server restart. Preserve
  // the old-binding denial above; receipt replay requires that new authority.
  await h.fixture.sql([
    `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('mcp-run-restarted-lane',${literal(chat)},${literal(tree)},${literal(worker)},'agent',false,'Qualification after restart','active',now(),'settings-runtime')`,
  ]);
  binding.executionLaneId = "mcp-run-restarted-lane";
  let count = state.commands.length;
  assert.equal(
    (await call("restart retains operation receipt", "start", start)).data
      .replayed,
    true,
  );
  assert.equal(
    state.commands.length,
    count,
    "Receipt replay cannot dispatch a second worker operation",
  );
  count = state.commands.length;
  assert.equal(
    (await call("restart retains secret receipt", "secret-set", secret))
      .mutated,
    false,
  );
  assert.equal(state.commands.length, count);
  await call("restart preserves encrypted runtime output", "read-output", {
    operationId: id(),
    configurationId,
  });
}

export async function runStandaloneCases({ h, call, binding, operations }) {
  const standalone = "eeeeeeee-eeee-4eee-8eee-000000000708";
  await h.fixture.sql([
    `INSERT INTO chats(id,owner_id,context_kind,protected_label,active_worker_id,active_scratch_root_id,worktree_mode,status,permission_profile_id) VALUES(${literal(standalone)},${literal(h.owner)},'standalone',${json(label("chat"))},${literal(worker)},'mcp-run-scratch',NULL,'running',':workspace')`,
    `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,protected_path_handle,status) VALUES('mcp-run-scratch',${literal(standalone)},${literal(h.owner)},${literal(worker)},'ctrr_${"A".repeat(43)}','ready')`,
    `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,scratch_root_id,codex_thread_id) VALUES('mcp-run-standalone-runtime',${literal(standalone)},${literal(worker)},'mcp-run-scratch','mcp-run-standalone-thread')`,
    `INSERT INTO chat_execution_lanes(id,chat_id,scratch_root_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('mcp-run-standalone-lane',${literal(standalone)},'mcp-run-scratch',${literal(worker)},'agent',false,'Qualification','active',now(),'mcp-run-standalone-runtime')`,
  ]);
  for (const operation of operations) {
    assert.deepEqual(
      await call("standalone " + operation, operation, {}, 409, {
        ...binding,
        contextKind: "standalone",
        projectId: null,
        chatId: standalone,
        executionLaneId: "mcp-run-standalone-lane",
        worktreeId: null,
        rootKind: null,
        scratchRootId: "mcp-run-scratch",
      }),
      {
        code: "unsupported-capability",
        error: "Standalone Chats do not support IDE execution operations.",
      },
    );
  }
}

export function verifyRunQueryError({ body, args, owner, project }) {
  const query = queries.runWorktree;
  assert.equal(query.params[0], "fixture-owner");
  const parameters = query.params.map((value) =>
    value === "fixture-owner"
      ? owner
      : value === "fixture-project"
        ? project
        : value === "fixture-target"
          ? args.worktreeId
          : value,
  );
  const prefix = "Failed query: " + query.sql + "\nparams: ";
  const expected = (prefix + parameters.join(",")).slice(0, 2000);
  assert.equal(
    body.error,
    expected,
    "Source SQL and every original JavaScript query parameter remain exact before normalization",
  );
  return (
    prefix + "<verified owner>" + expected.slice(prefix.length + owner.length)
  );
}

export async function runTextCases({ call, state, id, configurationId }) {
  for (const worktreeId of [
    "not-a-uuid",
    "bad\u0000worktree",
    "\ud800",
    "\ufffd",
    "\ud800\u0000mixed",
    "\ufffd\u0000mixed",
  ])
    for (const action of ["status", "start", "read-output"]) {
      const count = state.commands.length;
      await call(
        "worktree text " + action + " " + JSON.stringify(worktreeId),
        action,
        {
          configurationId,
          worktreeId,
          ...(action === "status" ? {} : { operationId: id() }),
        },
        worktreeId.includes("\u0000") ? 400 : 404,
      );
      assert.equal(
        state.commands.length,
        count,
        "Failed target lookup cannot dispatch worker operations",
      );
    }
}
