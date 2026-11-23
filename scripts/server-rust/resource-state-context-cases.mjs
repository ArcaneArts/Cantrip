import assert from "node:assert/strict";
import { literal, json, stamp, taskIds } from "./resource-state-fixtures.mjs";
import { label } from "./project-target-state.mjs";

export async function resourceContextCases({
  observe,
  seed,
  transaction,
  reopen,
  owner,
  other,
}) {
  for (const [chat, principal] of [
    ["missing", owner],
    ["other-chat", owner],
    ["chat", other],
  ])
    await observe(
      "execution context hides unavailable Chat " + chat + ":" + principal,
      "context",
      { chat, owner: principal },
      { expected: null },
    );
  for (const [chat, principal] of [
    ["chat", owner],
    ["other-chat", other],
    [taskIds[0], owner],
    [taskIds[1], owner],
  ])
    await observe(
      "complete project and Task execution context " + chat,
      "context",
      { chat, owner: principal },
      {
        check: ({ response }) => {
          assert.equal(response.value.contextKind, "project");
          assert.equal(response.value.chatId, chat);
          assert.equal(response.value.scratchRootId, null);
          assert.equal(typeof response.value.managedInputRevision, "number");
        },
      },
    );
  await seed(`UPDATE chats SET archived_at=${literal(stamp)} WHERE id='chat'`);
  await observe(
    "archived project Chat has no execution context",
    "context",
    {},
    { expected: null },
  );
  await seed("UPDATE chats SET archived_at=NULL WHERE id='chat'");
  await transaction([
    `INSERT INTO chats(id,owner_id,context_kind,active_worker_id,active_scratch_root_id,worktree_mode,protected_label,created_at,updated_at) VALUES('standalone-context',${literal(owner)},'standalone','alpha','standalone-context-root',NULL,${json(label("chat"))},${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,status,protected_path_handle,created_at,updated_at) VALUES('standalone-context-root','standalone-context',${literal(owner)},'alpha','ready','ctrr_${"a".repeat(43)}',${literal(stamp)},${literal(stamp)})`,
  ]);
  await seed(
    `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,scratch_root_id,codex_thread_id,created_at,updated_at) VALUES('${taskIds[9]}','standalone-context','alpha','standalone-context-root','standalone-thread',${literal(stamp)},${literal(stamp)})`,
  );
  await seed(
    `INSERT INTO chat_execution_lanes(id,chat_id,worker_id,scratch_root_id,acquiring_actor,exclusive,purpose,state,runtime_session_id,created_at,updated_at) VALUES('${taskIds[10]}','standalone-context','alpha','standalone-context-root','user',false,'Context comparison','active','${taskIds[9]}',${literal(stamp)},${literal(stamp)})`,
  );
  await observe(
    "complete standalone execution context and active binding",
    "context",
    { chat: "standalone-context" },
    {
      check: ({ response }) => {
        assert.equal(response.value.contextKind, "standalone");
        assert.equal(response.value.projectId, null);
        assert.equal(response.value.worktreeId, null);
        assert.equal(response.value.scratchRootId, "standalone-context-root");
        assert.equal(response.value.threadId, "standalone-thread");
        assert.equal(response.value.executionLaneId, taskIds[10]);
      },
    },
  );
  await observe(
    "standalone execution context preserves ownership",
    "context",
    { chat: "standalone-context", owner: other },
    { expected: null },
  );
  await reopen("project, Task and standalone execution context bindings");
  await observe(
    "standalone execution context after actual restart",
    "context",
    { chat: "standalone-context" },
  );
  await seed(
    `UPDATE chats SET archived_at=${literal(stamp)} WHERE id='standalone-context'`,
  );
  await observe(
    "archived standalone Chat has no execution context",
    "context",
    { chat: "standalone-context" },
    { expected: null },
  );
  await seed("UPDATE chats SET archived_at=NULL WHERE id='standalone-context'");
}
