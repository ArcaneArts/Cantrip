import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { encryptChatMessageProtectedContent } from "../../packages/crypto/dist/index.js";
import {
  nativeCommandAdmissionSchema,
  nativeCommandDispatchSchema,
  nativeCommandReceiptSchema,
  nativeCommandSettlementSchema,
  taskGoalWorkerResultSchema,
} from "../../packages/protocol/dist/index.js";
import {
  openNativeCommandContent,
  protectNativeCommandContent,
} from "../../tests/reference-node-worker/src/native-command-content.ts";

export async function editAndResumeTaskGoal({
  invoke,
  activation,
  started,
  ownerId,
  chatKey,
  objective,
  openObjective,
  openMessage,
}) {
  const { chatId, threadId, provider, permissionProfileId, taskRuntime } =
    activation;
  const base = {
    type: "chat.goal.update",
    chatId,
    threadId,
    provider,
    permissionProfileId,
  };
  const context = { ...activation.taskContext, message: null };
  const update = async (fields) => {
    const reply = await invoke({ ...base, taskContext: context, ...fields });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return taskGoalWorkerResultSchema.parse(reply.result);
  };
  const paused = await update({ status: "paused" });
  assert.equal(paused.task.classification.state, "paused");
  assert.equal(paused.message, null);
  assert.equal(paused.goal.status, "paused");
  const text = objective + "\n\nKeep the change focused.";
  const id = randomUUID();
  const classification = { role: "user", mode: "goal", attachmentIds: [] };
  const protectedObjective = {
    id,
    idempotencyKey: "goal-edit-fixture",
    classification,
    reasoningEffort: null,
    protectedContent: await encryptChatMessageProtectedContent({
      ownerId,
      componentKey: chatKey,
      keyRevision: 1,
      messageId: id,
      content: {
        version: 1,
        classification,
        content: [{ type: "text", text }],
      },
    }),
  };
  const invalid = await invoke({
    ...base,
    taskContext: context,
    protectedObjective: { ...protectedObjective, id: randomUUID() },
  });
  assert.equal(invalid.ok, false, JSON.stringify(invalid));
  const unchanged = await invoke({ ...base, type: "chat.goal.get" });
  assert.equal(unchanged.ok, true, JSON.stringify(unchanged));
  assert.equal(unchanged.result.goal.objective, objective);
  const edited = await update({
    protectedObjective,
    taskContext: { ...context, task: paused.task },
  });
  assert.equal(edited.goal.status, "paused");
  assert.equal(edited.goal.tokenBudget, started.goal.tokenBudget);
  assert.equal(edited.goal.createdAt, started.goal.createdAt);
  assert.equal(edited.task.classification.state, "paused");
  assert.equal(edited.message, null);
  const control = {
    kind: "resume",
    id: randomUUID(),
    idempotencyKey: "goal-resume-fixture",
  };
  const resumed = await update({
    status: "active",
    taskRuntime,
    subagentDefaults: activation.subagentDefaults,
    taskContext: { ...context, task: edited.task, message: control },
  });
  assert.equal(resumed.goal.status, "active");
  assert.equal(resumed.goal.createdAt, started.goal.createdAt);
  assert.equal(resumed.task.classification.state, "implementing");
  assert.equal(resumed.message.id, control.id);
  assert.equal(resumed.message.idempotencyKey, control.idempotencyKey);
  assert.equal(
    (await openObjective(resumed.goal, { chatId, threadId, status: "active" }))
      .objective,
    text,
  );
  assert.deepEqual((await openMessage(resumed.message)).content, [
    {
      type: "text",
      phase: "final_answer",
      text: "Resume Task Goal:\n\n" + text,
    },
  ]);
  assert.ok(!JSON.stringify({ edited, resumed }).includes(text));
  return resumed;
}

export async function verifyManagedGoalClear({
  activation,
  invoke,
  oracle,
  attachMutation,
  workerId,
  generation,
}) {
  const { chatId, threadId, provider, permissionProfileId, taskRuntime } =
    activation;
  const { projectId, worktreeId, rootKind } = taskRuntime;
  const base = { chatId, threadId, provider, permissionProfileId };
  const session = {
    chatId,
    projectId,
    worktreeId,
    rootKind,
    contextKind: "project",
    scratchRootId: null,
    computerUseEnabled: false,
  };
  let admitted;
  let receipt;
  const phases = [];
  const clearResults = [];
  const stamp = new Date().toISOString();
  const crypto = (direction) => ({
    service: oracle,
    context: { chatId, operationId: receipt.operationId, direction },
  });
  const reply = (send) =>
    send({ receipt, execution: null, computerUseAuthority: null });
  attachMutation(async (phase, body, response, send) => {
    phases.push(phase);
    assert.equal(body.workerId, workerId);
    if (phase === "admit") {
      const request = nativeCommandAdmissionSchema.parse(body);
      assert.equal(request.intent.workerGeneration, generation());
      assert.equal(request.origin, "gui");
      assert.equal(request.expectedActivationGeneration, null);
      assert.equal(request.session.chatId, chatId);
      assert.equal(request.session.threadId, threadId);
      assert.equal(request.session.projectId, projectId);
      assert.equal(request.session.placementId, worktreeId);
      assert.equal(request.intent.scope, "thread");
      if (request.method === "thread/goal/set") {
        assert.equal(request.intent.goalStatus, "paused");
        response.writeHead(409).end("{}");
        return;
      }
      assert.equal(request.method, "thread/goal/clear");
      assert.equal(request.intent.resumeAutonomy, undefined);
      if (admitted) {
        assert.notEqual(request.operationId, receipt.operationId);
        assert.deepEqual(request.session, admitted.session);
      }
      admitted = request;
      receipt = nativeCommandReceiptSchema.parse({
        operationId: request.operationId,
        operationGeneration: randomUUID(),
        activationGeneration: null,
        chatId,
        startsExecution: false,
        executionLaneId: null,
        status: "accepted",
        method: request.method,
        payloadDigest: request.payloadDigest,
        rejectionCode: null,
        threadId,
        createdAt: stamp,
        updatedAt: stamp,
      });
      const content = await openNativeCommandContent({
        ...crypto("request"),
        envelope: request.protectedPayload,
      });
      assert.deepEqual(content, {
        id: receipt.operationId,
        method: receipt.method,
        params: { threadId },
      });
      assert.equal(
        (await protectNativeCommandContent({ ...crypto("request"), content }))
          .digest,
        request.payloadDigest,
      );
      reply(send);
    } else if (phase === "dispatch") {
      const request = nativeCommandDispatchSchema.parse(body);
      assert.equal(request.operationId, receipt.operationId);
      assert.equal(request.operationGeneration, receipt.operationGeneration);
      assert.equal(request.workerGeneration, generation());
      assert.equal(request.payloadDigest, receipt.payloadDigest);
      assert.deepEqual(request.session, admitted.session);
      receipt.status = "dispatched";
      reply(send);
    } else {
      assert.equal(phase, "receipt");
      const result = nativeCommandSettlementSchema.parse(body);
      assert.equal(result.operationId, receipt.operationId);
      assert.equal(result.operationGeneration, receipt.operationGeneration);
      assert.equal(result.status, "applied");
      assert.equal(result.executionComplete, false);
      const content = await openNativeCommandContent({
        ...crypto("result"),
        envelope: result.protectedResult,
      });
      assert.deepEqual(content, { cleared: clearResults.length === 0 });
      clearResults.push(content.cleared);
      assert.equal(
        (await protectNativeCommandContent({ ...crypto("result"), content }))
          .digest,
        result.resultDigest,
      );
      receipt.status = "applied";
      send({ receipt });
    }
  });
  try {
    const denied = await invoke({
      ...base,
      type: "chat.goal.update",
      session,
      status: "paused",
    });
    assert.equal(denied.ok, false, JSON.stringify(denied));
    const unchanged = await invoke({ ...base, type: "chat.goal.get" });
    assert.equal(unchanged.ok, true, JSON.stringify(unchanged));
    assert.equal(unchanged.result.goal.status, "complete");
    const cleared = await invoke({ ...base, type: "chat.goal.clear", session });
    assert.equal(cleared.ok, true, JSON.stringify(cleared));
    assert.deepEqual(cleared.result, { cleared: true });
    assert.deepEqual(phases, ["admit", "admit", "dispatch", "receipt"]);
    const repeated = await invoke({ ...base, type: "chat.goal.clear" });
    assert.equal(repeated.ok, true, JSON.stringify(repeated));
    assert.deepEqual(repeated.result, { cleared: false });
    assert.deepEqual(clearResults, [true, false]);
    assert.deepEqual(phases, [
      "admit",
      "admit",
      "dispatch",
      "receipt",
      "admit",
      "dispatch",
      "receipt",
    ]);
    const absent = await invoke({ ...base, type: "chat.goal.get" });
    assert.equal(absent.ok, true, JSON.stringify(absent));
    assert.deepEqual(absent.result, { goal: null });
  } finally {
    attachMutation(undefined);
  }
  console.log(
    "Fenced managed Goal mutations at admission and settled both native clear results with distinct encrypted receipts.",
  );
}
