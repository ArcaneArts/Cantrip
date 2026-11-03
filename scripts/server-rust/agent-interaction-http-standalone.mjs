import assert from "node:assert/strict";
import {
  settingsChat,
  settingsWorker as worker,
  otherChat as chat,
} from "./native-settings-http-fixture.mjs";
import { literal, json } from "./project-target-state.mjs";

export async function standaloneInteractionHttpCases(c) {
  const { h, result, seed, response, respond, durable } = c,
    root = "99999999-9999-4999-8999-999999999999",
    lane = "88888888-8888-4888-8888-888888888888",
    owned = { chatId: chat, projectId: null },
    sql = (...statements) => h.fixture.sql(statements);
  await sql(
    `INSERT INTO chats(id,owner_id,context_kind,project_id,protected_label,active_worker_id,active_scratch_root_id,worktree_mode,model_id,automation_paused) SELECT ${literal(chat)},owner_id,'standalone',NULL,protected_label,${literal(worker)},${literal(root)},NULL,'inventory-provider-model-1',true FROM chats WHERE id=${literal(settingsChat)}`,
    `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,protected_path_handle,status) VALUES(${literal(root)},${literal(chat)},${literal(h.owner)},${literal(worker)},${literal("ctrr_" + Buffer.alloc(32, 39).toString("base64url"))},'ready')`,
    `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,scratch_root_id,codex_thread_id) VALUES('interaction-standalone-runtime',${literal(chat)},${literal(worker)},${literal(root)},'standalone-thread')`,
  );
  await h.live.subscribed("interaction-standalone", [
    { kind: "chat", chatId: settingsChat },
    { kind: "chat", chatId: chat },
  ]);
  const reply = async (n, protectedReply, kind = "fileChange") => {
    const value = await h.visit(`standalone reply ${n}`, "POST", respond(n), {
      json: await response(n, protectedReply, kind),
    });
    assert.equal(value.status, "resolved");
    assert.equal(value.provenance.chatId, chat);
    assert.equal(value.projectId, null);
    await durable(n, "standalone acknowledged " + n);
    return result.commands.at(-1);
  };
  for (const n of [30, 31]) {
    await seed(n, { ...owned, protected: n === 31 });
    const command = await reply(n, n === 31);
    assert.equal(command.executionProfile, "standalone-chat");
    assert.equal(command.threadId, "standalone-thread");
  }
  await seed(32, {
    ...owned,
    computer: true,
    protected: true,
    kind: "permissions",
  });
  let command = await reply(32, true, "permissions");
  assert.equal(command.previewAuthority.contextKind, "standalone");
  assert.equal(command.previewAuthority.projectId, null);
  assert.equal(command.previewAuthority.placementId, root);
  await sql(
    `INSERT INTO chat_execution_lanes(id,chat_id,scratch_root_id,worker_id,acquiring_actor,state,runtime_session_id,codex_thread_id) VALUES(${literal(lane)},${literal(chat)},${literal(root)},${literal(worker)},'agent','active','interaction-standalone-runtime','standalone-thread')`,
    `INSERT INTO native_commands(operation_id,owner_id,worker_id,chat_id,operation_generation,activation_generation,execution_lane_id,origin,method,kind,payload_digest,protected_payload,identity,intent,status) VALUES('interaction-standalone-operation',${literal(h.owner)},${literal(worker)},${literal(chat)},'interaction-standalone-generation','interaction-standalone-activation',${literal(lane)},'gui','turn/start','start','${"a".repeat(64)}','{}',${json({ runtimeGeneration: "interaction-standalone-runtime" })},'{}','applied')`,
    `INSERT INTO native_command_activations(chat_id,generation,operation_id,execution_lane_id,worker_id,runtime_generation,active) VALUES(${literal(chat)},'interaction-standalone-activation','interaction-standalone-operation',${literal(lane)},${literal(worker)},'interaction-standalone-runtime',true)`,
    `UPDATE chats SET model_id=NULL WHERE id=${literal(chat)}`,
  );
  await seed(33, { ...owned, lane, protected: true });
  command = await reply(33, true);
  assert.equal(command.type, "chat.native-control");
  assert.equal(command.threadId, "standalone-thread");
  assert.equal(
    command.nativeActivationGeneration,
    "interaction-standalone-activation",
  );
  await seed(34, {
    ...owned,
    lane,
    computer: true,
    protected: true,
    kind: "permissions",
  });
  command = await reply(34, true, "permissions");
  assert.equal(command.agentAuthority.contextKind, "standalone");
  assert.equal(command.agentAuthority.placementId, root);
  assert.equal(command.agentAuthority.executionLaneId, lane);
  await h.live.subscribed("interaction-standalone-barrier", [
    { kind: "chat", chatId: settingsChat },
    { kind: "chat", chatId: chat },
  ]);
  await sql(
    `UPDATE native_command_activations SET active=false WHERE chat_id=${literal(chat)}`,
    `UPDATE chat_execution_lanes SET state='released' WHERE id=${literal(lane)}`,
    `UPDATE chats SET status='idle' WHERE id=${literal(chat)}`,
  );
}
