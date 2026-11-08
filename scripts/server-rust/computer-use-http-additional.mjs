import assert from "node:assert/strict";
import { id, input, opaque } from "./computer-use-http-fixtures.mjs";
import { literal } from "./project-target-state.mjs";
import { eventually } from "./full-worker.mjs";

export function activityEvent(operationId, messageId, task = false) {
  const { domain: _domain, ...content } = opaque();
  return {
    type: "computer-use.activity",
    operationId,
    event: {
      type: task ? "agent.protected-task-message" : "agent.protected-message",
      message: {
        id: messageId,
        classification: {
          role: "assistant",
          mode: "default",
          attachmentIds: [],
        },
        protectedContent: content,
        idempotencyKey: messageId,
      },
      telemetry: {
        kind: "activity",
        activityType: "computerUse",
        turnId: null,
      },
    },
  };
}
export function agentBinding(owner, now = Date.now()) {
  return {
    bindingId: id(90),
    ownerId: owner,
    chatId: "chat",
    executionLaneId: id(80),
    workerId: "alpha",
    permissionProfileId: ":workspace",
    allowedOperations: ["tool.help"],
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 3600000).toISOString(),
    contextKind: "project",
    projectId: "github",
    worktreeId: "github-alpha-main",
    rootKind: "git-worktree",
    scratchRootId: null,
  };
}
export async function additionalComputerUseCases({
  f,
  visit,
  state,
  worker,
  result,
  owner,
}) {
  const operation = "/api/chats/chat/computer-use/operation",
    stop = "/api/chats/chat/computer-use/preview/stop";
  const record = (name, value) => result.cases.push({ name, value });
  const saved = async (n) =>
    (
      await f.sql(
        [],
        [
          `SELECT COALESCE((SELECT jsonb_build_object('id',id,'role',role,'mode',mode,'attachments',attachment_ids,'opaque',protected_content) FROM chat_messages WHERE id=${literal(id(n))}),'null'::jsonb)::text result`,
        ],
      )
    )[0];
  state.events = (command) => [
    activityEvent(command.request.operationId, id(31)),
  ];
  await visit("durable opaque activity", "POST", operation, {
    json: input(30, "input.click"),
  });
  assert.ok(await saved(31));
  record("persisted opaque Chat activity", await saved(31));
  state.events = (command) => [
    activityEvent(command.request.operationId, id(33)),
    activityEvent(command.request.operationId, id(33)),
  ];
  await visit("duplicate activity rejects operation", "POST", operation, {
    status: 502,
    json: input(32, "input.click"),
  });
  assert.ok(await saved(33));
  record("duplicate activity retains exactly one write", await saved(33));
  state.events = (command) => [activityEvent(command.operationId, id(35))];
  await visit("Stop publishes one durable opaque activity", "POST", stop, {
    json: { leaseId: id(3), workerId: "alpha" },
  });
  record("persisted Stop activity", await saved(35));
  assert.ok(await saved(35));
  state.events = (command) => [
    { ...activityEvent(command.operationId, id(37)), operationId: id(999) },
  ];
  await visit("Stop succeeds despite failed activity", "POST", stop, {
    json: { leaseId: id(3), workerId: "alpha" },
  });
  assert.equal(await saved(37), null);
  record("failed Stop activity is absent", true);
  delete state.events;
  await f.sql([
    "INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id) VALUES('cua-runtime','chat','alpha','github-alpha-main','thread')",
    `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,state,runtime_session_id,codex_thread_id) VALUES(${literal(id(80))},'chat','github-alpha-main','alpha','agent','active','cua-runtime','thread')`,
  ]);
  const authority = "/api/internal/computer-use/authority",
    binding = agentBinding(owner);
  const call = (name, changes = {}, status = 200, options = {}) =>
    visit(name, "POST", authority, {
      client: "worker",
      headers: { authorization: "Bearer " + worker.config.token },
      status,
      json: { binding: { ...binding, ...changes } },
      ...options,
    });
  await call("malformed authority", {}, 400, { json: {} });
  await call("authority without credential", {}, 401, { headers: {} });
  await call("UTF16 authority worker identifier", { workerId: "\ud800" }, 401);
  await call("UTF16 authority Chat identifier", { chatId: "\ud800" }, 409);
  await visit(
    "UTF16 Stop worker identifier follows actual SQL encoding",
    "POST",
    stop,
    { status: 503, json: { leaseId: id(3), workerId: "\ud800" } },
  );
  const current = await call("current worker authority");
  assert.equal(current.executionLaneId, id(80));
  assert.equal(current.workerId, "alpha");
  record("current agent authority", current);
  await call("authority wrong owner", { ownerId: "foreign-owner" }, 401);
  await call("authority wrong credential worker", { workerId: "foreign" }, 401);
  await call("authority stale placement", { worktreeId: "missing" }, 409);
  await call("authority stale lane", { executionLaneId: "other-lane" }, 409);
  await call("authority absent Chat", { chatId: "missing" }, 409);
  await call(
    "authority expired binding",
    {
      issuedAt: new Date(Date.now() - 20000).toISOString(),
      expiresAt: new Date(Date.now() - 10000).toISOString(),
    },
    409,
  );
  await f.sql([
    `UPDATE user_settings SET computer_use_enabled=false WHERE user_id=${literal(owner)}`,
  ]);
  await call("authority requires current enabled policy", {}, 403);
  await f.sql([
    `UPDATE user_settings SET computer_use_enabled=true WHERE user_id=${literal(owner)}`,
  ]);
  await f.sql(["ALTER TABLE chats RENAME TO owned_cua_fault_chats"]);
  try {
    await call("authority SQL fault is redacted", {}, 503);
  } finally {
    await f.sql(["ALTER TABLE owned_cua_fault_chats RENAME TO chats"]);
  }
  await call("authority after SQL recovery");
  // Stop authenticates a retained worker lease even after Chat archival.
  await f.sql(["UPDATE chats SET archived_at=now() WHERE id='chat'"]);
  state.events = (command) => [activityEvent(command.operationId, id(39))];
  await visit("Stop after archival preserves completed close", "POST", stop, {
    json: { leaseId: id(3), workerId: "alpha" },
  });
  assert.equal(await saved(39), null);
  delete state.events;
  await f.sql(["UPDATE chats SET archived_at=NULL WHERE id='chat'"]);
  await eventually(
    () => worker.connected,
    (value) => assert.equal(value, true),
  );
}
