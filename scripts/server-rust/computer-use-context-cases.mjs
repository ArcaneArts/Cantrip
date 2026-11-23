import assert from "node:assert/strict";
import { id, input } from "./computer-use-http-fixtures.mjs";
import {
  activityEvent,
  agentBinding,
} from "./computer-use-http-additional.mjs";
import { literal } from "./project-target-state.mjs";

export async function computerUseContextCases({
  f,
  state,
  visit,
  worker,
  result,
  owner,
}) {
  const record = (name, value) => result.cases.push({ name, value });
  const saved = async (n) =>
    (
      await f.sql(
        [],
        [
          `SELECT COALESCE((SELECT jsonb_build_object('id',id,'role',role,'task',task_protected_content,'chat',protected_content) FROM chat_messages WHERE id=${literal(id(n))}),'null'::jsonb)::text result`,
        ],
      )
    )[0];
  await f.sql(["UPDATE chats SET experience='task' WHERE id='chat'"]);
  const task = await visit(
    "Task preview lease",
    "POST",
    "/api/chats/chat/computer-use/preview",
    { json: {} },
  );
  assert.equal(task.contentDomain, "task");
  record("Task preview command retains content domain", state.commands.at(-1));
  state.events = (command) => [
    activityEvent(command.request.operationId, id(101), true),
  ];
  await visit(
    "Task opaque activity",
    "POST",
    "/api/chats/chat/computer-use/operation",
    { json: input(100, "input.click") },
  );
  const taskMessage = await saved(101);
  assert.ok(taskMessage.task);
  assert.equal(taskMessage.chat, null);
  record("Task activity uses Task ciphertext column", taskMessage);
  state.events = (command) => [
    activityEvent(command.request.operationId, id(103), false),
  ];
  await visit(
    "wrong activity content domain",
    "POST",
    "/api/chats/chat/computer-use/operation",
    { status: 502, json: input(102, "input.click") },
  );
  assert.equal(await saved(103), null);
  state.events = (command) => [
    activityEvent(command.operationId, id(105), true),
  ];
  await visit(
    "Task Stop activity",
    "POST",
    "/api/chats/chat/computer-use/preview/stop",
    { json: { leaseId: task.leaseId, workerId: "alpha" } },
  );
  assert.ok((await saved(105)).task);
  record("Task Stop preserves opaque domain", await saved(105));
  delete state.events;
  await f.sql([
    "UPDATE chats SET experience='agent' WHERE id='chat'",
    `INSERT INTO chats(id,owner_id,context_kind,project_id,protected_label,active_worker_id,active_scratch_root_id,worktree_mode,automation_paused) SELECT 'cua-standalone',owner_id,'standalone',NULL,protected_label,'alpha',${literal(id(110))},NULL,true FROM chats WHERE id='chat'`,
    `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,protected_path_handle,status) VALUES(${literal(id(110))},'cua-standalone',${literal(owner)},'alpha',${literal("ctrr_" + Buffer.alloc(32, 39).toString("base64url"))},'ready')`,
    `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,scratch_root_id,codex_thread_id) VALUES('cua-standalone-runtime','cua-standalone','alpha',${literal(id(110))},'standalone-thread')`,
    `INSERT INTO chat_execution_lanes(id,chat_id,scratch_root_id,worker_id,acquiring_actor,state,runtime_session_id,codex_thread_id) VALUES(${literal(id(111))},'cua-standalone',${literal(id(110))},'alpha','agent','active','cua-standalone-runtime','standalone-thread')`,
  ]);
  const root = "/api/chats/cua-standalone/computer-use";
  const standalone = await visit(
    "standalone preview lease",
    "POST",
    root + "/preview",
    { json: {} },
  );
  const command = state.commands.at(-1);
  assert.equal(command.authority.contextKind, "standalone");
  assert.equal(command.authority.projectId, null);
  assert.equal(command.authority.placementId, id(110));
  record("standalone authority projection", command);
  state.events = (command) => [
    activityEvent(command.request.operationId, id(113)),
  ];
  await visit("standalone opaque activity", "POST", root + "/operation", {
    json: input(112, "input.click"),
  });
  assert.ok((await saved(113)).chat);
  record(
    "standalone activity persists encrypted Chat content",
    await saved(113),
  );
  delete state.events;
  const binding = {
    ...agentBinding(owner),
    chatId: "cua-standalone",
    executionLaneId: id(111),
    contextKind: "standalone",
    projectId: null,
    worktreeId: null,
    rootKind: null,
    scratchRootId: id(110),
  };
  const authority = await visit(
    "standalone worker authority",
    "POST",
    "/api/internal/computer-use/authority",
    {
      client: "worker",
      headers: { authorization: "Bearer " + worker.config.token },
      json: { binding },
    },
  );
  assert.equal(authority.executionLaneId, id(111));
  assert.equal(authority.placementId, id(110));
  record("standalone agent current authority", authority);
  await f.sql(["UPDATE chats SET archived_at=now() WHERE id='cua-standalone'"]);
  await visit(
    "standalone retained Stop after archival",
    "POST",
    root + "/preview/stop",
    { json: { leaseId: standalone.leaseId, workerId: "alpha" } },
  );
}
