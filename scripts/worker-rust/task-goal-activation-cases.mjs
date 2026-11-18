import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { goalCycles } from "./task-goal-cycle-cases.mjs";
import {
  editAndResumeTaskGoal,
  verifyManagedGoalClear,
} from "./task-goal-control-cases.mjs";
import { observeTaskGoal } from "./task-goal-observation-cases.mjs";
import {
  decryptTaskGoalObjective,
  decryptTaskMessageProtectedContent,
  decryptTaskProtectedContent,
} from "../../packages/crypto/dist/index.js";
import {
  taskGoalOutcomeDeliverySchema,
  taskGoalWorkerResultSchema,
  taskInferenceInputDispatchSchema,
  taskMessageRelayResultSchema,
} from "../../packages/protocol/dist/index.js";

export async function verifyTaskGoalActivation({
  command,
  result,
  ownerId,
  key,
  chatKey,
  invoke,
  directory,
  modelCalls,
  setAnswer,
  serverId,
  workerId,
  generation,
  attach,
  attachMutation,
  oracle,
  untilProvider,
  available,
  waitForFrame,
  diagnostics,
  stop,
  start,
}) {
  const { goal, task } = result.structuredResult;
  const { chatId, worktreeId, provider } = command;
  const threadId = result.threadId;
  const binding = { ownerId, keyRevision: 2, componentKey: key };
  const openObjective = (snapshot, classification) =>
    decryptTaskGoalObjective({
      ...binding,
      chatId,
      threadId,
      encrypted: snapshot.protectedObjective,
      publicClassification: classification,
    });
  const finalized = await openObjective(goal, goal.classification);
  const openMessage = (message) =>
    decryptTaskMessageProtectedContent({
      ...binding,
      messageId: message.id,
      encrypted: message.protectedContent,
      publicClassification: message.classification,
    });
  const plan = (await openMessage(goal.startMessage)).content[0].text;
  const control = {
    id: randomUUID(),
    idempotencyKey: "goal-start-fixture",
    kind: "start",
  };
  const activation = {
    type: "chat.goal.create",
    chatId,
    threadId,
    provider,
    objective: goal,
    tokenBudget: 5000,
    planMode: "default",
    permissionProfileId: ":workspace",
    taskRuntime: {
      projectId: command.policyProjectId,
      worktreeId,
      rootKind: command.rootKind,
      computerUseEnabled: false,
    },
    taskContext: {
      task,
      automationPaused: false,
      chatStatus: "idle",
      message: control,
    },
  };
  const observer = observeTaskGoal({
    invoke,
    command,
    binding,
    chatKey,
    threadId,
    task,
    modelCalls,
    diagnostics,
  });
  const calls = modelCalls();
  await observer.beforeActivation();
  const reply = await invoke(activation);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const started = taskGoalWorkerResultSchema.parse(reply.result);
  assert.ok(
    started.goal,
    JSON.stringify(
      await decryptTaskProtectedContent({
        ...binding,
        chatId,
        encrypted: started.task.protectedContent,
        publicClassification: started.task.classification,
      }),
    ),
  );
  const classification = { chatId, threadId, status: "active" };
  const actual = await openObjective(started.goal, classification);
  assert.equal(started.goal.threadId, threadId);
  assert.equal(started.goal.tokenBudget, activation.tokenBudget);
  assert.equal(started.goal.status, "active");
  assert.equal(started.goal.tokensUsed, 0);
  assert.deepEqual(started.task, task);
  assert.equal(started.message.id, control.id);
  assert.equal(started.message.idempotencyKey, control.idempotencyKey);
  assert.deepEqual((await openMessage(started.message)).content, [
    {
      type: "text",
      phase: "final_answer",
      text: "Begin Task Goal:\n\n" + actual.objective,
    },
  ]);
  const captured = actual.objective.match(
    /implementation plan at (".*?") before making changes/u,
  );
  assert.ok(captured, "The active Goal must reference its full private plan.");
  const filename = JSON.parse(captured[1]);
  const relative = path.relative(directory, filename);
  assert.ok(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
  );
  const digest = createHash("sha256")
    .update(JSON.stringify([chatId, threadId, plan]))
    .digest("hex");
  assert.equal(path.basename(path.dirname(filename)), "task-goal-" + digest);
  assert.equal(await readFile(filename, "utf8"), plan);
  if (process.platform !== "win32")
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.ok(actual.objective.startsWith(finalized.objective + "\n\n"));
  assert.ok(!JSON.stringify(reply).includes(finalized.objective));

  const retry = await invoke(activation);
  assert.equal(retry.ok, true);
  assert.equal(retry.result.goal.createdAt, started.goal.createdAt);
  assert.equal(retry.result.goal.updatedAt, started.goal.updatedAt);
  assert.deepEqual(
    await openObjective(retry.result.goal, classification),
    actual,
  );

  const rejected = await invoke({
    ...activation,
    objective: {
      ...goal,
      classification: { ...goal.classification, threadId: randomUUID() },
    },
  });
  assert.equal(rejected.ok, true, JSON.stringify(rejected));
  assert.equal(rejected.result.goal, null);
  const failed = await decryptTaskProtectedContent({
    ...binding,
    chatId,
    encrypted: rejected.result.task.protectedContent,
    publicClassification: rejected.result.task.classification,
  });
  assert.equal(failed.classification.state, "failed");
  assert.equal(failed.classification.stableStateBeforeFailure, "review");
  assert.equal(
    failed.finalPlanMarkdown,
    plan.split("## Final implementation plan\n\n").at(-1),
  );
  await observer.active();
  await stop();
  await start();
  const saved = await observer.activeWithoutOwner();
  assert.equal(saved.createdAt, started.goal.createdAt);
  const { message: resumedMessage } = await editAndResumeTaskGoal({
    invoke,
    activation,
    started,
    ownerId,
    chatKey,
    objective: actual.objective,
    openObjective,
    openMessage,
  });
  assert.equal(modelCalls(), calls);
  console.log(
    "Activated, paused, edited and resumed the retained Task Goal without early inference.",
  );

  const { prompt, ...base } = command;
  const { id: clientMessageId } = resumedMessage;
  const dispatch = {
    ...command.taskInferenceInput.dispatch,
    cycleId: randomUUID(),
    operationId: randomUUID(),
  };
  const receipt = {
    ...command.taskInferenceInput,
    kind: "goal",
    operationId: randomUUID(),
    queueOrderEpoch: 3,
    clientMessageId,
    dispatch,
  };
  const resultMode = {
    kind: "task-message-encrypted",
    messageId: randomUUID(),
    idempotencyKey: "fixture-first-goal-result",
  };
  const cycles = goalCycles({ receipt, threadId, serverId, generation });
  const answer = "Native first Goal result.";
  const phases = [];
  const admissions = Promise.withResolvers();
  const attempted = Promise.withResolvers();
  const replayed = Promise.withResolvers();
  let delivery;
  attach({
    answer,
    cycle: cycles.authorize,
    dispatch: (body, send) => {
      const request = taskInferenceInputDispatchSchema.parse(body);
      assert.deepEqual(request.receipt, receipt);
      assert.equal(request.serverId, serverId);
      assert.equal(request.workerId, workerId);
      assert.equal(request.workerGeneration, generation());
      assert.equal(
        request.phase,
        ["claim", "dispatch", "native"][phases.length],
      );
      phases.push(request.phase);
      if (request.phase === "native") {
        assert.equal(request.nativeExecution.threadId, threadId);
        admissions.resolve({
          native: request.nativeExecution,
          acknowledge: () =>
            send({
              receipt,
              nativeExecution: request.nativeExecution,
              nativeRuntimeGeneration: request.nativeRuntimeGeneration,
            }),
        });
      } else {
        send({ receipt });
      }
    },
    outcome: (body, send) => {
      const record = taskGoalOutcomeDeliverySchema.parse(body);
      if (record.inputKind === "goal-cycle") {
        cycles.deliver(body, send);
        return;
      }
      assert.equal(record.inputKind, "goal");
      assert.equal(record.ownerId, ownerId);
      assert.equal(record.serverId, serverId);
      assert.equal(record.workerId, workerId);
      assert.equal(record.notification.clientMessageId, clientMessageId);
      assert.equal(
        record.notification.taskInferenceInputOperationId,
        receipt.operationId,
      );
      assert.deepEqual(record.notification.taskDispatchFence, dispatch);
      if (!delivery) {
        delivery = record;
        send({
          committed: true,
          deliveryId: record.deliveryId,
          taskInferenceInputOperationId: randomUUID(),
        });
        attempted.resolve();
      } else {
        assert.deepEqual(record, delivery);
        replayed.resolve(() =>
          send({
            committed: true,
            deliveryId: record.deliveryId,
            taskInferenceInputOperationId: receipt.operationId,
          }),
        );
      }
    },
  });

  const streaming = [];
  const providerRequest = untilProvider();
  const notification = waitForFrame(
    (frame) => frame.notification?.clientMessageId === clientMessageId,
  );
  const running = invoke(
    {
      ...base,
      threadId,
      clientMessageId,
      planMode: "default",
      permissionProfileId: activation.permissionProfileId,
      protectedTaskPrompt: resumedMessage,
      resultMode,
      taskInferenceInput: receipt,
      taskDispatchLease: {
        ...dispatch,
        leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    },
    (event) => streaming.push(event),
  );
  const earlyReply = running.then((reply) => {
    throw new Error(JSON.stringify(reply) + "\n" + diagnostics());
  });
  const { native, acknowledge } = await available(
    Promise.race([
      admissions.promise,
      providerRequest.then(() => {
        throw new Error(
          "The provider was reached before native Goal admission.",
        );
      }),
      earlyReply,
    ]),
  );
  acknowledge();
  const model = await Promise.race([providerRequest, earlyReply]);
  assert.deepEqual(phases, ["claim", "dispatch", "native"]);
  const promptText = (await openMessage(resumedMessage)).content[0].text;
  assert.ok(
    model.body.input.some(
      (item) =>
        item.role === "user" &&
        item.content?.some(({ text }) => text === promptText),
    ),
  );
  await observer.running();
  model.finish();

  await available(Promise.race([attempted.promise, earlyReply]));
  const namespace = createHash("sha256")
    .update(JSON.stringify([serverId, ownerId, workerId]))
    .digest("hex");
  const pending = path.join(
    directory,
    "task-goal-outcomes",
    namespace,
    delivery.deliveryId + ".json",
  );
  const bytes = await readFile(pending, "utf8");
  assert.deepEqual(JSON.parse(bytes), delivery);
  const commit = await available(Promise.race([replayed.promise, earlyReply]));
  assert.equal(await readFile(pending, "utf8"), bytes);
  assert.equal(modelCalls(), calls + 1);
  cycles.commitParent();
  commit();

  const outcome = await running;
  assert.equal(
    outcome.ok,
    true,
    JSON.stringify(outcome) + "\n" + diagnostics(),
  );
  assert.equal(outcome.result.threadId, native.threadId);
  assert.equal(outcome.result.turnId, native.turnId);
  assert.equal(outcome.result.text, "");
  const { message } = taskMessageRelayResultSchema.parse(
    outcome.result.structuredResult,
  );
  assert.equal(message.id, resultMode.messageId);
  assert.equal(message.idempotencyKey, resultMode.idempotencyKey);
  assert.equal(message.classification.mode, "goal");
  assert.equal((await openMessage(message)).content[0].text, answer);
  assert.ok(
    streaming.some(
      (event) =>
        event.type === "agent.protected-task-message" &&
        event.telemetry.streaming,
    ),
  );
  assert.ok(!JSON.stringify({ outcome, delivery, streaming }).includes(answer));
  assert.deepEqual(delivery.notification.outcome, {
    ok: true,
    result: outcome.result,
  });
  assert.deepEqual(
    (await available(notification)).notification,
    delivery.notification,
  );
  await assert.rejects(stat(pending), { code: "ENOENT" });
  assert.equal(modelCalls(), calls + 1);
  console.log(
    "Ran the first native Goal input and waited for its exact encrypted outcome commit.",
  );
  await cycles.verify({
    firstTurnId: native.turnId,
    untilProvider,
    available,
    openMessage,
    outcomeDirectory: path.dirname(pending),
    setAnswer,
    stop,
    start,
  });
  await observer.afterRestart();
  const beforeClear = modelCalls();
  await verifyManagedGoalClear({
    activation,
    invoke,
    oracle,
    attachMutation,
    workerId,
    generation,
  });
  assert.equal(modelCalls(), beforeClear);
}
