import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { protectChatTurn } from "../../cantrip_worker/src/chat-message-encryption.ts";
import {
  nativeGoalRecoveryReceiptSchema,
  nativeGoalClaimRecoveryReceiptSchema,
} from "../../packages/protocol/dist/index.js";
import {
  settingsChat as chat,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import { literal, json, stamp } from "./project-target-state.mjs";

const source = {
  operationId: "agent-recovery-original",
  operationGeneration: "agent-recovery-generation",
  threadId: "thread",
  goalEpoch: "lost-agent-goal",
};
const claim = {
  claimId: "agent-first-cycle-claim",
  promptId: "66666666-6666-4666-8666-666666666691",
  promptRevision: 0,
  operationId: "agent-first-cycle-setter",
  operationGeneration: "agent-first-cycle-generation",
  threadId: "thread",
  goalEpoch: "applied-first-goal",
  admission: null,
};
const staleGeneration = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";

export function agentGoalRecoveryHttpCases(
  h,
  result,
  { model, route, provider },
) {
  let binding,
    held,
    release,
    goalAttempts = 0,
    claimAttempts = 0;
  const raw = (result.rawAgentRecoveryStages = []);
  result.rawAgentRecoveryReceipts = [];
  function holdSecond() {
    held = {
      requested: false,
      promise: new Promise((resolve) => (release = resolve)),
    };
    return held;
  }
  async function handle(command) {
    if (
      command.type !== "chat.goal.recover" &&
      command.type !== "chat.goal.claim-recover"
    )
      return undefined;
    assert.equal(command.chatId, chat);
    assert.equal(command.threadId, binding.threadId);
    assert.equal(command.model.routeId, route);
    assert.equal(command.provider.id, provider);
    const { bindingId: _bindingId, ...scope } = binding;
    let receipt;
    if (command.type === "chat.goal.recover") {
      assert.deepEqual(command.source, source);
      assert.deepEqual(command.recovery, {
        source,
        providerId: provider,
        orderEpoch: 0,
        admission: null,
      });
      const attempt = ++goalAttempts;
      if (attempt === 2) {
        held.requested = true;
        await held.promise;
      }
      receipt = nativeGoalRecoveryReceiptSchema.parse({
        status: "ineligible",
        source,
        reason: "not-active",
        workerGeneration:
          attempt === 1 ? staleGeneration : h.worker.connectionGeneration(),
        observation: { ...scope, orderEpoch: 0 },
      });
    } else {
      assert.deepEqual(command.claim, claim);
      const attempt = ++claimAttempts;
      if (attempt === 2) {
        held.requested = true;
        await held.promise;
      }
      receipt = nativeGoalClaimRecoveryReceiptSchema.parse(
        attempt === 1
          ? {
              status: "deferred",
              claim,
              workerGeneration: h.worker.connectionGeneration(),
            }
          : {
              status: "ineligible",
              claim,
              workerGeneration: h.worker.connectionGeneration(),
              observation: {
                ...scope,
                goalEpoch: "different-native-goal",
                goalStatus: "active",
              },
            },
      );
    }
    result.rawAgentRecoveryReceipts.push({
      command: structuredClone(command),
      receipt,
    });
    return receipt;
  }
  const query = `SELECT jsonb_build_object('queue',to_jsonb(q),'source',(SELECT to_jsonb(n) FROM native_commands n WHERE operation_id=${literal(source.operationId)}),'setter',(SELECT to_jsonb(n) FROM native_commands n WHERE operation_id=${literal(claim.operationId)}),'claim',(SELECT to_jsonb(c) FROM managed_queue_claims c WHERE id=${literal(claim.claimId)}),'prompt',(SELECT to_jsonb(p) FROM queued_prompts p WHERE id=${literal(claim.promptId)}),'messageCount',(SELECT count(*) FROM chat_messages WHERE chat_id=${literal(chat)}),'commandCount',(SELECT count(*) FROM native_commands WHERE chat_id=${literal(chat)})) result FROM managed_queue_states q WHERE q.chat_id=${literal(chat)}`;
  async function state(label) {
    const [value] = await h.fixture.sql(
      [],
      [query.replace(" result", "::text result")],
    );
    if (label) raw.push({ label, value });
    return value;
  }
  async function wait(read, predicate, label) {
    let value;
    const deadline = Date.now() + 20000;
    do {
      value = await read();
      if (predicate(value)) return value;
      await delay(100);
    } while (Date.now() < deadline);
    assert.ok(predicate(value), label);
  }
  async function run() {
    const refreshed = await h.visit(
      "bind actual Agent native settings",
      "POST",
      `/api/chats/${chat}/native-settings/refresh`,
    );
    binding = refreshed.binding;
    assert.equal(binding.modelRouteId, route);
    assert.equal(binding.chatId, chat);
    assert.equal(binding.workerId, worker);
    result.rawAgentBinding = binding;
    const { workerId: _worker, ...scope } = h.scope;
    const session = {
      ...scope,
      runtimeGeneration: binding.runtimeGeneration,
      connectionId: null,
    };
    const recovering = {
      source,
      providerId: provider,
      orderEpoch: 0,
      admission: null,
    };
    const waitHeld = (gate, label) =>
      wait(() => gate.requested, Boolean, label);
    const acked = (value) =>
      value.queue.notified_revision === value.queue.revision;
    const first = holdSecond();
    try {
      await h.fixture.sql([
        `INSERT INTO native_commands(operation_id,owner_id,worker_id,chat_id,operation_generation,origin,method,kind,payload_digest,protected_payload,identity,intent,status,rejection_code,execution_completed_at,goal_recovery_source) VALUES(${literal(source.operationId)},${literal(h.owner)},${literal(worker)},${literal(chat)},${literal(source.operationGeneration)},'autonomous','turn/start','start','${"a".repeat(64)}','{}',${json(session)},'{}','rejected','worker-inference-deferred',${literal(stamp)},${json(source)})`,
        `INSERT INTO managed_queue_states(chat_id,revision,notified_revision,notification_due_at,goal_recovery) VALUES(${literal(chat)},1,0,now(),${json(recovering)}) ON CONFLICT(chat_id) DO UPDATE SET revision=managed_queue_states.revision+1,notification_due_at=now(),goal_recovery=excluded.goal_recovery`,
      ]);
      await waitHeld(
        first,
        "the actual Agent recovery notification retries after stale generation",
      );
      const failed = await state("stale worker receipt keeps original source");
      assert.deepEqual(failed.queue.goal_recovery, recovering);
      assert.ok(!acked(failed));
      assert.equal(failed.commandCount, 1);
      assert.equal(failed.messageCount, 0);
      release();
      await wait(
        () => state(),
        (value) => value.queue.goal_recovery === null && acked(value),
        "actual current-binding observation retires Agent source",
      );
    } finally {
      release();
    }
    const retired = await state(
      "bound negative observation retires only Agent recovery marker",
    );
    assert.equal(goalAttempts, 2);
    assert.equal(retired.commandCount, 1);
    assert.equal(retired.source.status, "rejected");
    assert.deepEqual(retired.source.goal_recovery_source, source);
    assert.equal(retired.messageCount, 0);

    const turn = await protectChatTurn({
      service: h.encryption,
      text: "private-applied-goal-first-cycle",
      idempotencyKey: "agent-first-cycle-input",
      promptId: claim.promptId,
      messageId: "66666666-6666-4666-8666-666666666692",
      mode: "goal",
      modelId: model,
      reasoningEffort: null,
    });
    const prompt = { ...turn.queuedPrompt, frozen: true };
    const second = holdSecond();
    try {
      await h.fixture.sql([
        `INSERT INTO queued_prompts(id,chat_id,text,opaque_content,mode,model_id,position,frozen,idempotency_key,revision,state) VALUES(${literal(prompt.id)},${literal(chat)},NULL,${json(prompt)},'goal',${literal(model)},0,true,${literal(prompt.idempotencyKey)},0,'claimed')`,
        `INSERT INTO native_commands(operation_id,owner_id,worker_id,chat_id,operation_generation,origin,method,kind,payload_digest,protected_payload,identity,intent,status,execution_completed_at) VALUES(${literal(claim.operationId)},${literal(h.owner)},${literal(worker)},${literal(chat)},${literal(claim.operationGeneration)},'gui','thread/goal/set','goal','${"b".repeat(64)}',${json(prompt.protectedContent.envelope)},${json(session)},'{}','applied',${literal(stamp)})`,
        `INSERT INTO managed_queue_claims(id,chat_id,prompt_id,prompt_revision,status,operation_id,operation_generation,awaiting_goal,goal_epoch) VALUES(${literal(claim.claimId)},${literal(chat)},${literal(claim.promptId)},0,'dispatched',${literal(claim.operationId)},${literal(claim.operationGeneration)},true,${literal(claim.goalEpoch)})`,
        `UPDATE managed_queue_states SET revision=revision+1,notification_due_at=now() WHERE chat_id=${literal(chat)}`,
      ]);
      await waitHeld(
        second,
        "actual first-cycle notification retries after a deferred receipt",
      );
      const deferred = await state(
        "deferred receipt retains exact applied Goal claim",
      );
      assert.equal(deferred.claim.status, "dispatched");
      assert.equal(deferred.prompt.state, "claimed");
      assert.equal(deferred.setter.status, "applied");
      assert.ok(!acked(deferred));
      release();
      await wait(
        () => state(),
        (value) => value.claim.status === "consumed" && acked(value),
        "current binding retires the exact first-cycle claim",
      );
    } finally {
      release();
    }
    const finished = await state(
      "no replay after first-cycle claim retirement",
    );
    assert.equal(claimAttempts, 2);
    assert.equal(finished.prompt.state, "consumed");
    assert.equal(finished.prompt.text, null);
    assert.deepEqual(finished.prompt.opaque_content, prompt);
    assert.equal(finished.setter.status, "applied");
    assert.equal(finished.commandCount, 2);
    assert.equal(finished.messageCount, 0);
    result.agentRecovery = {
      goalAttempts,
      claimAttempts,
      sourceRetained: finished.source.status === "rejected",
      setterRetained: finished.setter.status === "applied",
      claimStatus: finished.claim.status,
      promptState: finished.prompt.state,
      commandCount: finished.commandCount,
      messageCount: finished.messageCount,
    };
    assert.equal(
      JSON.stringify([finished, h.live.history, h.diagnostics()]).includes(
        "private-applied-goal-first-cycle",
      ),
      false,
    );
    return { query, finished };
  }
  return { handle, run, release: () => release?.() };
}
