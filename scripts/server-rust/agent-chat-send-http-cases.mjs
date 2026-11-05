import assert from "node:assert/strict";
import { json, literal } from "./project-target-state.mjs";
export async function runAgentChatSendCases(c) {
  const {
    binding,
    target,
    chat,
    tree,
    worker,
    wire,
    sql,
    call,
    invoke,
    state,
    unchanged,
    prove,
    result,
    id,
  } = c;
  await invoke("initial paused delivery", 1);
  await prove(1);
  let current = await state();
  assert.equal(current.queue.length, 1);
  assert.equal(current.messages.length, 2);
  assert.equal(current.paused, true);
  assert.deepEqual(result.proofs.at(-1), {
    operationId: id(1),
    queueId: wire.get(1).turn.queuedPrompt.id,
    modelId: "mcp-receiver",
    reasoningEffort: "medium",
    customSubagentModel: true,
    subagentModelId: "mcp-subagent",
    subagentReasoningEffort: "low",
    paused: true,
  });
  await unchanged("worker re-encrypts an exact operation replay", () =>
    invoke("reencrypted replay", 1),
  );
  await unchanged("concurrent duplicate operation", async () => {
    await Promise.all([invoke("duplicate-a", 1), invoke("duplicate-b", 1)]);
  });
  const raw = wire.get(1);
  for (const [name, change, status] of [
    [
      "unknown wire field",
      (v) => {
        v.future = true;
      },
      400,
    ],
    [
      "sender role",
      (v) => {
        v.sentMessage.classification.role = "user";
      },
      403,
    ],
    [
      "receiver role",
      (v) => {
        v.receivedMessage.classification.role = "user";
      },
      403,
    ],
    [
      "receiver idempotency",
      (v) => {
        v.receivedMessage.idempotencyKey = "unrelated";
      },
      403,
    ],
    [
      "sender idempotency",
      (v) => {
        v.sentMessage.idempotencyKey = "unrelated";
      },
      403,
    ],
    [
      "queued worktree",
      (v) => {
        v.turn.queuedPrompt.worktreeId = tree;
      },
      403,
    ],
    [
      "frozen input",
      (v) => {
        v.turn.queuedPrompt.frozen = true;
      },
      403,
    ],
  ]) {
    const args = structuredClone(raw);
    change(args);
    await unchanged(name, () => call(name, "chat.send", args, status));
  }
  await unchanged("missing target precedes wire parsing", () =>
    call("missing target first", "chat.send", { unknown: true }, 404),
  );
  const self = structuredClone(raw);
  self.chatId = chat;
  await unchanged("self-delivery", () =>
    call("self-delivery", "chat.send", self, 409),
  );
  await unchanged("mutation needs current lane", () =>
    call("stale mutation lane", "chat.send", raw, 409, {
      ...binding,
      executionLaneId: "previous-lane",
    }),
  );
  await unchanged("mutation needs allowed grant", () =>
    call("missing mutation grant", "chat.send", raw, 403, {
      ...binding,
      allowedOperations: ["chat.read"],
    }),
  );
  await sql([
    `UPDATE chats SET permission_profile_id=':read-only' WHERE id=${literal(chat)}`,
  ]);
  await unchanged("read-only source cannot send", () =>
    call("read-only mutation", "chat.send", raw, 403, {
      ...binding,
      permissionProfileId: ":read-only",
    }),
  );
  await sql([
    `UPDATE chats SET permission_profile_id=':workspace' WHERE id=${literal(chat)}`,
  ]);
  // The receiver's current settings override stale configuration prepared by a worker.
  const pending = await invoke(
    "prepare before receiver configuration edit",
    2,
    { prepare: true },
  );
  await sql([
    `UPDATE chats SET model_id=NULL,reasoning_effort='high',custom_subagent_model=false,subagent_model_id=NULL,subagent_reasoning_effort=NULL WHERE id=${literal(target)}`,
  ]);
  const delivered = await call(
    "receiver model configuration wins",
    "chat.send",
    pending,
  );
  assert.equal(delivered.status, 200);
  await prove(2);
  assert.deepEqual(result.proofs.at(-1), {
    operationId: id(2),
    queueId: wire.get(2).turn.queuedPrompt.id,
    modelId: "mcp-default",
    reasoningEffort: "high",
    customSubagentModel: false,
    subagentModelId: null,
    subagentReasoningEffort: null,
    paused: true,
  });
  const missingModel = await invoke(
    "prepare new operation before removing model",
    4,
    { prepare: true },
  );
  await sql([
    `UPDATE user_settings SET default_model_id=NULL WHERE user_id=${literal(binding.ownerId)}`,
  ]);
  await unchanged("committed replay survives removal of receiver model", () =>
    call("committed replay without receiver model", "chat.send", pending),
  );
  await unchanged("receiver without model", () =>
    call("missing receiver model", "chat.send", missingModel, 409),
  );
  await sql([
    `UPDATE user_settings SET default_model_id='mcp-default' WHERE user_id=${literal(binding.ownerId)}`,
  ]);
  const failing = await invoke("prepare rollback envelope", 3, {
    prepare: true,
  });
  await sql([
    "CREATE FUNCTION reject_agent_delivery_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=" +
      literal(failing.sentMessage.id) +
      " THEN RAISE EXCEPTION 'Agent delivery source write rejected.'; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER reject_agent_delivery_source BEFORE INSERT ON chat_messages FOR EACH ROW EXECUTE FUNCTION reject_agent_delivery_message()",
  ]);
  await unchanged("third write rolls back queue and receiver history", () =>
    call("actual outgoing message insert failure", "chat.send", failing, 400),
  );
  await sql([
    "DROP TRIGGER reject_agent_delivery_source ON chat_messages",
    "DROP FUNCTION reject_agent_delivery_message()",
  ]);
  await call("retry after actual rollback", "chat.send", failing);
  await prove(3);
  const beforeConcurrent = await state();
  await Promise.all([
    invoke("duplicate-initial-a", 5),
    invoke("duplicate-initial-b", 5),
  ]);
  current = await state();
  assert.equal(current.queue.length, beforeConcurrent.queue.length + 1);
  assert.equal(current.messages.length, beforeConcurrent.messages.length + 2);
  assert.equal(current.commands.length, beforeConcurrent.commands.length + 1);
  await prove(5);
  // The caller's worker and placement must never replace the recipient's.
  const receiverWorker = "mcp-delivery-receiver-worker";
  const receiverTree = "mcp-delivery-receiver-tree";
  await sql([
    `INSERT INTO workers(id,owner_id,name,platform,architecture,remote_surface_capabilities,started_at,last_seen_at) VALUES(${literal(receiverWorker)},${literal(binding.ownerId)},'Receiver worker','linux','x64','{"browser":true,"desktop":true}',now(),now())`,
    `INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path) VALUES('mcp-delivery-receiver-source',${literal(c.project)},${literal(receiverWorker)},'git','/worker-owned/receiver','/worker-owned/receiver')`,
    `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES(${literal(receiverTree)},'mcp-delivery-receiver-source',${literal(receiverWorker)},'receiver','/worker-owned/receiver','/worker-owned/receiver',false,'cantrip','ready')`,
    `UPDATE chats SET active_worker_id=${literal(receiverWorker)},active_worktree_id=${literal(receiverTree)} WHERE id=${literal(target)}`,
  ]);
  await invoke("recipient worker and placement win", 8);
  await prove(8);
  const scoped = await state();
  const scopedCommand = scoped.commands.find(
    (r) => r.operation_id === `agent-chat:queue:${chat}:${target}:${id(8)}`,
  );
  assert.equal(scopedCommand.worker_id, receiverWorker);
  assert.equal(scopedCommand.identity.placementId, receiverTree);
  const received = scoped.messages.find(
    (r) => r.id === wire.get(8).receivedMessage.id,
  );
  const sent = scoped.messages.find((r) => r.id === wire.get(8).sentMessage.id);
  assert.equal(received.worktree_id, receiverTree);
  assert.equal(sent.worktree_id, tree);
  assert.equal(
    scoped.queue.find((r) => r.id === wire.get(8).turn.queuedPrompt.id)
      .worktree_id,
    null,
  );
  result.recipientAuthorityProof = {
    workerId: scopedCommand.worker_id,
    placementId: scopedCommand.identity.placementId,
    receivedWorktree: received.worktree_id,
    sentWorktree: sent.worktree_id,
  };
  await sql([
    `UPDATE chats SET active_worker_id=${literal(worker)},active_worktree_id=${literal(tree)} WHERE id=${literal(target)}`,
  ]);
  await sql([
    `UPDATE chats SET status='running',permission_profile_id=':workspace' WHERE id=${literal(target)}`,
    `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at) VALUES('mcp-delivery-target-lane',${literal(target)},${literal(tree)},${literal(worker)},'agent',false,'Qualification','active',now())`,
  ]);
  // Running recipients require an actual current native activation. A bare
  // execution lane correctly fails Source admission with stale-activation.
  for (const [activeChat, lane, thread, suffix] of [
    [chat, "mcp-delivery-lane", "thread", "source"],
    [target, "mcp-delivery-target-lane", null, "target"],
  ]) {
    const operation = "controlled-delivery-root-" + suffix;
    const generation = "controlled-delivery-activation-" + suffix;
    const runtime = "controlled-delivery-runtime-" + suffix;
    const identity = {
      chatId: activeChat,
      threadId: thread,
      contextKind: "project",
      projectId: c.project,
      placementId: tree,
      modelRouteId: null,
      providerAccountId: null,
      runtimeGeneration: runtime,
      connectionId: null,
    };
    await sql([
      `INSERT INTO native_commands(operation_id,owner_id,worker_id,chat_id,operation_generation,activation_generation,execution_lane_id,origin,method,kind,payload_digest,protected_payload,identity,intent,status) VALUES(${literal(operation)},${literal(binding.ownerId)},${literal(worker)},${literal(activeChat)},${literal(operation + "-generation")},${literal(generation)},${literal(lane)},'gui','turn/start','start','${"a".repeat(64)}',${json(raw.sentMessage.protectedContent.envelope)},${json(identity)},'{}','applied')`,
      `INSERT INTO native_command_activations(chat_id,generation,operation_id,execution_lane_id,worker_id,runtime_generation,active) VALUES(${literal(activeChat)},${literal(generation)},${literal(operation)},${literal(lane)},${literal(worker)},${literal(runtime)},true)`,
    ]);
  }
  const reverse = {
    ...binding,
    bindingId: id(901),
    chatId: target,
    executionLaneId: "mcp-delivery-target-lane",
  };
  const beforeReverse = await state();
  await Promise.all([
    invoke("reverse-a", 6),
    invoke("reverse-b", 7, { claims: reverse, receiver: chat }),
  ]);
  current = await state();
  assert.equal(current.queue.length, beforeReverse.queue.length + 2);
  assert.equal(current.messages.length, beforeReverse.messages.length + 4);
  assert.equal(current.commands.length, beforeReverse.commands.length + 2);
  await c.read("decrypted receiving transcript");
  await c.read("decrypted sending transcript", chat);
  await sql([
    `UPDATE chats SET automation_paused=true WHERE id IN (${literal(chat)},${literal(target)})`,
  ]);
  const retained = await state();
  await c.restart();
  assert.deepEqual(
    await state(),
    retained,
    "Restart preserves every delivery, queue entry and receipt",
  );
  await call(
    "recovered mutation requires fresh turn",
    "chat.send",
    wire.get(3),
    409,
  );
  await sql([
    `UPDATE chats SET status='running' WHERE id=${literal(chat)}`,
    `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('mcp-delivery-restarted-lane',${literal(chat)},${literal(tree)},${literal(worker)},'agent',false,'Qualification','active',now(),'settings-runtime')`,
  ]);
  binding.executionLaneId = "mcp-delivery-restarted-lane";
  binding.issuedAt = new Date().toISOString();
  binding.expiresAt = new Date(Date.now() + 120000).toISOString();
  await unchanged("committed operation replay after actual restart", () =>
    call("durable replay after actual restart", "chat.send", wire.get(3)),
  );
  await c.read("decrypted receiving transcript after restart");
}
