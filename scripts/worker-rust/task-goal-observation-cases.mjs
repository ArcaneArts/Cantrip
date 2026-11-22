import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  decryptChatMessageProtectedContent,
  decryptTaskGoalObjective,
  decryptTaskProtectedContent,
} from "../../packages/crypto/dist/index.js";
import {
  chatGoalWireResponseSchema,
  taskGoalWorkerResultSchema,
} from "../../packages/protocol/dist/index.js";
import { protectTaskGoalResult } from "../../tests/reference-node-worker/src/task-operation.ts";

export function observeTaskGoal({
  invoke,
  command,
  binding,
  chatKey,
  threadId,
  task,
  modelCalls,
  diagnostics,
}) {
  const { chatId, provider } = command;
  const read = async (fields = {}) => {
    const reply = await invoke({
      type: "chat.goal.get",
      chatId,
      threadId,
      provider,
      permissionProfileId: ":workspace",
      ...fields,
    });
    assert.equal(reply.ok, true, JSON.stringify(reply) + "\n" + diagnostics());
    return reply.result;
  };
  const openTask = (task) =>
    decryptTaskProtectedContent({
      ...binding,
      chatId,
      encrypted: task.protectedContent,
      publicClassification: task.classification,
    });
  const context = {
    task,
    automationPaused: false,
    chatStatus: "failed",
    runtimeFailure: {
      kind: "capacity",
      occurredAt: "2026-11-06T00:00:00.000Z",
    },
    message: null,
  };
  async function compare(projected, native, expectedContext) {
    const node = await protectTaskGoalResult({
      chatId,
      ownerId: binding.ownerId,
      context: expectedContext,
      rawResult: { goal: native },
      getComponentKey: () => ({
        key: binding.componentKey.slice(),
        keyRevision: binding.keyRevision,
      }),
    });
    const openGoal = (snapshot) =>
      decryptTaskGoalObjective({
        ...binding,
        chatId,
        threadId,
        encrypted: snapshot.protectedObjective,
        publicClassification: { chatId, threadId, status: snapshot.status },
      });
    assert.deepEqual(await openGoal(projected.goal), await openGoal(node.goal));
    assert.deepEqual(await openTask(projected.task), await openTask(node.task));
    for (const field of [
      "createdAt",
      "updatedAt",
      "tokenBudget",
      "timeUsedSeconds",
      "tokensUsed",
    ]) {
      assert.equal(projected.goal[field], node.goal[field]);
    }
    assert.ok(!JSON.stringify(projected).includes(native.objective));
  }
  return {
    async beforeActivation() {
      assert.deepEqual(await read(), { goal: null });
      assert.deepEqual(await read({ protectObjective: true }), {
        kind: "chat-encrypted",
        goal: null,
      });
    },
    async active() {
      const base = await read();
      assert.equal(base.goal.status, "active");
      const projected = taskGoalWorkerResultSchema.parse(
        await read({ taskContext: context }),
      );
      assert.equal(projected.execution, undefined);
      assert.equal(projected.task.classification.state, "failed");
      await compare(projected, base.goal, context);
    },
    async activeWithoutOwner() {
      const before = modelCalls();
      const projected = taskGoalWorkerResultSchema.parse(
        await read({
          taskContext: context,
          observeExecution: true,
        }),
      );
      assert.equal(projected.goal.status, "active");
      assert.deepEqual(projected.execution, { threadId, status: "idle" });
      assert.equal(
        modelCalls(),
        before,
        "A saved Goal read must not resume it.",
      );
      return projected.goal;
    },
    async running() {
      const before = modelCalls();
      const active = await read();
      // A fresh provider name would select a different Codex process. The
      // observation must use the live owner of the actual running turn.
      const projected = taskGoalWorkerResultSchema.parse(
        await read({
          provider: { ...provider, name: "Updated Goal provider display name" },
          taskContext: context,
          observeExecution: true,
        }),
      );
      assert.deepEqual(projected.execution, { threadId, status: "running" });
      assert.deepEqual(projected.task, task);
      assert.equal(projected.message, null);
      const { runtimeFailure, ...rest } = context;
      await compare(projected, active.goal, { ...rest, chatStatus: "running" });
      assert.equal(modelCalls(), before);
    },
    async pausedExecution(nativeCycle, pausedAndIdleRevision) {
      let projected;
      const deadline = Date.now() + 5_000;
      do {
        projected = taskGoalWorkerResultSchema.parse(
          await read({
            observeExecution: true,
            taskContext: { ...context, automationPaused: true, nativeCycle },
          }),
        );
        if (projected.execution?.status === "idle") break;
        await delay(25);
      } while (Date.now() < deadline);
      assert.deepEqual(projected.execution, {
        threadId,
        status: "idle",
        ...(pausedAndIdleRevision === undefined
          ? {}
          : { pausedAndIdleRevision }),
      });
    },
    async afterRestart() {
      const before = modelCalls();
      const { goal } = await read();
      assert.equal(goal.threadId, threadId);
      assert.equal(goal.status, "complete");
      const stale = { ...context, automationPaused: true };
      const projected = taskGoalWorkerResultSchema.parse(
        await read({
          taskContext: stale,
          observeExecution: true,
        }),
      );
      assert.equal(projected.task.classification.state, "complete");
      assert.deepEqual(projected.execution, { threadId, status: "idle" });
      await compare(projected, goal, { ...stale, chatStatus: "idle" });

      const encrypted = chatGoalWireResponseSchema.parse(
        await read({ protectObjective: true }),
      );
      assert.equal(encrypted.kind, "chat-encrypted");
      const objective = encrypted.goal.protectedObjective;
      assert.equal(objective.idempotencyKey, "goal-snapshot:" + objective.id);
      assert.deepEqual(
        (
          await decryptChatMessageProtectedContent({
            ownerId: binding.ownerId,
            keyRevision: 1,
            componentKey: chatKey,
            messageId: objective.id,
            encrypted: objective.protectedContent,
            publicClassification: objective.classification,
          })
        ).content,
        [{ type: "text", text: goal.objective }],
      );
      assert.ok(!JSON.stringify(encrypted).includes(goal.objective));
      assert.equal(modelCalls(), before);
      console.log(
        "Observed absent, active, running and completed native Goals with Node-compatible encrypted projection.",
      );
    },
  };
}
