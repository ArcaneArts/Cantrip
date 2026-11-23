import assert from "node:assert/strict";
import {
  settingsChat,
  otherChat,
  settingsTree,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import { literal, json } from "./project-target-state.mjs";

export const nativeControlContexts = [
  {
    name: "project",
    chat: settingsChat,
    placement: settingsTree,
    lane: "77777777-7777-4777-8777-777777777777",
    runtime: "settings-runtime",
    thread: "thread",
    profile: "ide",
  },
  {
    name: "standalone",
    chat: otherChat,
    placement: "99999999-9999-4999-8999-999999999999",
    lane: "88888888-8888-4888-8888-888888888888",
    runtime: "control-standalone-runtime",
    thread: "standalone-thread",
    profile: "standalone-chat",
  },
].map((p) => ({
  ...p,
  operation: p.name + "-control-operation",
  generation: p.name + "-control-generation",
  activation: p.name + "-control-activation",
  nativeRuntime: p.name + "-control-runtime",
}));

export function seedStandaloneControl(owner) {
  const p = nativeControlContexts[1];
  return [
    `INSERT INTO chats(id,owner_id,context_kind,project_id,protected_label,active_worker_id,active_scratch_root_id,worktree_mode,automation_paused) SELECT ${literal(p.chat)},owner_id,'standalone',NULL,protected_label,${literal(worker)},${literal(p.placement)},NULL,true FROM chats WHERE id=${literal(settingsChat)}`,
    `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,protected_path_handle,status) VALUES(${literal(p.placement)},${literal(p.chat)},${literal(owner)},${literal(worker)},${literal("ctrr_" + Buffer.alloc(32, 39).toString("base64url"))},'ready')`,
    `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,scratch_root_id,codex_thread_id) VALUES(${literal(p.runtime)},${literal(p.chat)},${literal(worker)},${literal(p.placement)},${literal(p.thread)})`,
  ];
}

export async function seedNativeControl(
  h,
  p,
  status = "idle",
  native = null,
  logical = true,
) {
  const placement = p.name === "project" ? "worktree_id" : "scratch_root_id";
  await h.fixture.sql([
    `DELETE FROM native_commands WHERE chat_id=${literal(p.chat)}`,
    `DELETE FROM chat_execution_lanes WHERE chat_id=${literal(p.chat)}`,
    `UPDATE chats SET status=${literal(status)},managed_autonomy_stopped=false,managed_input_revision=0 WHERE id=${literal(p.chat)}`,
    ...(status === "idle"
      ? []
      : [
          `INSERT INTO chat_execution_lanes(id,chat_id,${placement},worker_id,acquiring_actor,state,runtime_session_id,codex_thread_id) VALUES(${literal(p.lane)},${literal(p.chat)},${literal(p.placement)},${literal(worker)},'agent','active',${literal(p.runtime)},${literal(p.thread)})`,
        ]),
    ...(native
      ? [
          `INSERT INTO native_commands(operation_id,owner_id,worker_id,chat_id,operation_generation,activation_generation,execution_lane_id,origin,method,kind,payload_digest,protected_payload,identity,intent,status,logical_operation_id) VALUES(${literal(p.operation)},${literal(h.owner)},${literal(worker)},${literal(p.chat)},${literal(p.generation)},${literal(p.activation)},${literal(p.lane)},'gui','turn/start','start','${"a".repeat(64)}','{}',${json({ runtimeGeneration: p.nativeRuntime })},'{}',${literal(native)},${literal(logical ? p.operation : null)})`,
          `INSERT INTO native_command_activations(chat_id,generation,operation_id,execution_lane_id,worker_id,runtime_generation,active) VALUES(${literal(p.chat)},${literal(p.activation)},${literal(p.operation)},${literal(p.lane)},${literal(worker)},${literal(p.nativeRuntime)},true)`,
        ]
      : []),
  ]);
}

export function nativeControlQuery(p, raw = false) {
  if (raw)
    return `SELECT jsonb_build_object('chat',(SELECT to_jsonb(c) FROM chats c WHERE c.id=${literal(p.chat)}),'commands',COALESCE((SELECT jsonb_agg(to_jsonb(n) ORDER BY n.operation_id) FROM native_commands n WHERE n.chat_id=${literal(p.chat)}),'[]'::jsonb),'activations',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.chat_id) FROM native_command_activations a WHERE a.chat_id=${literal(p.chat)}),'[]'::jsonb),'lanes',COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM chat_execution_lanes l WHERE l.chat_id=${literal(p.chat)}),'[]'::jsonb)) result`;
  return `SELECT jsonb_build_object('chatStatus',c.status,'stopped',c.managed_autonomy_stopped,'inputRevision',c.managed_input_revision,'operation',(SELECT jsonb_build_object('id',n.operation_id,'status',n.status,'rejection',n.rejection_code,'logicalCompleted',n.logical_completed_at IS NOT NULL,'executionCompleted',n.execution_completed_at IS NOT NULL,'logicalRoot',n.logical_operation_id) FROM native_commands n WHERE n.operation_id=${literal(p.operation)}),'activation',(SELECT jsonb_build_object('generation',a.generation,'active',a.active,'logicalCancelled',a.logical_cancelled) FROM native_command_activations a WHERE a.chat_id=c.id),'lane',(SELECT jsonb_build_object('id',l.id,'state',l.state) FROM chat_execution_lanes l WHERE l.id=${literal(p.lane)})) result FROM chats c WHERE c.id=${literal(p.chat)}`;
}

export async function nativeControlSnapshot(h, p, result, label) {
  const [state, raw] = await h.fixture.sql(
    [],
    [
      nativeControlQuery(p).replace(" result", "::text result"),
      nativeControlQuery(p, true).replace(" result", "::text result"),
    ],
  );
  result.durable.push({ label, context: p.name, state });
  result.rawDurable.push({ label, context: p.name, state: raw });
  return state;
}

export function assertNativeCancelled(state, p, logical = true) {
  assert.equal(state.chatStatus, "idle");
  assert.equal(state.stopped, true);
  assert.deepEqual(state.operation, {
    id: p.operation,
    status: "rejected",
    rejection: "cancelled-before-dispatch",
    logicalCompleted: logical,
    executionCompleted: false,
    logicalRoot: logical ? p.operation : null,
  });
  assert.equal(state.activation.active, false);
  assert.equal(state.activation.logicalCancelled, true);
  assert.deepEqual(state.lane, { id: p.lane, state: "suspended" });
}
