import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EMPTY_MODEL_CONFIGURATION } from "../../packages/protocol/dist/index.js";
import { taskEncryptedOperationStartSchema } from "../../packages/protocol/dist/tasks.js";
import {
  decryptTaskMessageProtectedContent,
  decryptTaskPlanningRoundProtectedContent,
  decryptTaskProtectedContent,
  encryptTaskProtectedContent,
  openTaskOperationRelayRequest,
} from "../../packages/crypto/dist/index.js";
import { protectChatMessage } from "../../cantrip_worker/src/chat-message-encryption.ts";
import {
  prepareEncryptedTaskOperation,
  protectTaskConversationMessage,
} from "../../cantrip_worker/src/task-operation.ts";

export async function verifyTaskPreparation({
  dispatch,
  ownerId,
  oracle,
  key,
}) {
  const binding = { ownerId, componentKey: key, keyRevision: 2 };
  const chatId = randomUUID();
  const marker = "Private Task preparation fixture 🧙";
  const at = "2026-11-18T10:00:00.000Z";
  const message = await protectChatMessage({
    service: oracle,
    id: randomUUID(),
    message: {
      idempotencyKey: "fixture-goal-message",
      role: "user",
      mode: "goal",
      reasoningEffort: "high",
      content: [{ type: "text", text: marker }],
    },
  });
  const converted = await dispatch({ type: "task.message.protect", message });
  assert.equal(converted.ok, true, JSON.stringify(converted));
  assert.equal(converted.result.id, message.id);
  assert.equal(converted.result.idempotencyKey, message.idempotencyKey);
  assert.equal(converted.result.reasoningEffort, message.reasoningEffort);
  assert.deepEqual(converted.result.classification, message.classification);
  const referenceMessage = await protectTaskConversationMessage({
    message,
    service: oracle,
  });
  const openMessage = (item) =>
    decryptTaskMessageProtectedContent({
      ...binding,
      messageId: item.id,
      encrypted: item.protectedContent,
      publicClassification: item.classification,
    });
  assert.deepEqual(
    await openMessage(converted.result),
    await openMessage(referenceMessage),
  );
  assert.ok(!JSON.stringify(converted).includes(marker));

  const cases = [
    ["direct", "draft", ""],
    ["initial-plan", "draft", ""],
    ["continue-plan", "review", "\uFEFF  " + marker + "  \uFEFF"],
    ["finalize", "review", " \uFEFF "],
  ];
  const inputs = {};
  for (const [operationKind, state, additionalDirection] of cases) {
    const operationId = randomUUID();
    const questions =
      state === "review"
        ? [
            {
              id: "delivery",
              header: "Delivery",
              question: "Which delivery format?",
              options: [{ id: "native", label: "Native", description: "" }],
              recommendedOptionId: "native",
              allowFreeform: true,
              required: true,
            },
          ]
        : [];
    const answers = questions.map(({ id }) => ({
      questionId: id,
      optionId: null,
      freeform: marker,
    }));
    const classification = {
      state,
      stableStateBeforeFailure: null,
      activeOperationKind: null,
      planAuthorship: "agent",
      planningRound: state === "review" ? 2 : 0,
      hasPlan: state === "review",
      hasQuestions: questions.length > 0,
      hasFinalPlan: false,
      hasGoalPrompt: false,
      lastError: null,
    };
    const content = {
      version: 1,
      classification,
      briefMarkdown: marker,
      planMarkdown: classification.hasPlan ? marker + " review plan" : null,
      currentQuestions: questions,
      currentAnswers: answers,
      additionalDirection,
      finalPlanMarkdown: null,
      goalPrompt: null,
      lastError: null,
    };
    const task = {
      ...classification,
      chatId,
      planGoalEnabled: operationKind !== "direct",
      modelConfiguration: EMPTY_MODEL_CONFIGURATION,
      priority: 12,
      activeOperationId: null,
      draftAttachmentIds: [],
      requestedTaskWorkerId: null,
      continuityFamily: null,
      lastTaskWorkerId: null,
      dispatch: null,
      implementationStartedAt: null,
      completedAt: null,
      schedulerRevision: 3,
      rowVersion: 4,
      createdAt: at,
      updatedAt: at,
      protectedContent: await encryptTaskProtectedContent({
        ...binding,
        chatId,
        content,
      }),
    };
    const request = { operationId, operationKind, task };
    const reply = await dispatch({
      type: "task.operation.prepare",
      ...request,
    });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.ok(!JSON.stringify(reply).includes(marker));
    const rust = taskEncryptedOperationStartSchema.parse(reply.result);
    const node = await prepareEncryptedTaskOperation({
      ownerId,
      getComponentKey: () => ({ key: key.slice(), keyRevision: 2 }),
      request,
    });
    inputs[operationKind] = { operation: node.operation, marker };
    assert.equal(rust.rowVersion, node.rowVersion);
    assert.equal(rust.operation.operationId, operationId);
    assert.equal(rust.operation.chatId, chatId);
    assert.equal(
      rust.operation.userMessage.idempotencyKey,
      "task-operation:" + operationId,
    );

    // Opening the native relay verifies the complete keyed fingerprint with
    // the reference codec, including array order, defaults, and user identity.
    const openOperation = (operation) =>
      openTaskOperationRelayRequest({ ...binding, request: operation });
    assert.deepEqual(
      await openOperation(rust.operation),
      await openOperation(node.operation),
    );
    const openFailure = async (failure) => {
      const parameters = (opaque) => ({
        ...binding,
        encrypted: opaque.protectedContent,
        publicClassification: opaque.classification,
      });
      const failedTask = await decryptTaskProtectedContent({
        ...parameters(failure.task),
        chatId,
      });
      const failedRound = await decryptTaskPlanningRoundProtectedContent({
        ...parameters(failure.round),
        roundId: operationId,
      });
      assert.equal(
        failedTask.lastError.occurredAt,
        failedRound.error.occurredAt,
      );
      for (const error of [
        failedTask.lastError,
        failedTask.classification.lastError,
        failedRound.error,
        failedRound.classification.error,
      ]) {
        assert.ok(Number.isFinite(Date.parse(error.occurredAt)));
        delete error.occurredAt;
      }
      return { failedTask, failedRound };
    };
    assert.deepEqual(
      await openFailure(rust.failure),
      await openFailure(node.failure),
    );

    if (operationKind === "continue-plan") {
      for (const change of [
        { hasQuestions: false },
        { chatId: randomUUID() },
      ]) {
        const failure = await dispatch({
          type: "task.operation.prepare",
          ...request,
          task: { ...task, ...change },
        });
        assert.equal(failure.ok, false);
        assert.ok(!JSON.stringify(failure).includes(marker));
      }
    }
  }
  return inputs;
}
