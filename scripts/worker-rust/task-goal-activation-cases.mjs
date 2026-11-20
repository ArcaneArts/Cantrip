import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { goalCycles } from "./task-goal-cycle-cases.mjs";
import {
  editAndResumeTaskGoal,
  verifyManagedGoalClear,
} from "./task-goal-control-cases.mjs";
import { observeTaskGoal } from "./task-goal-observation-cases.mjs";
import {
  decryptNativeSettingsSnapshot,
  decryptTaskGoalObjective,
  decryptTaskMessageProtectedContent,
  decryptTaskProtectedContent,
} from "../../packages/crypto/dist/index.js";
import {
  taskGoalHandoffCaptureSchema,
  taskGoalOutcomeDeliverySchema,
  taskGoalWorkerResultSchema,
  taskInferenceInputDispatchSchema,
  taskMessageRelayResultSchema,
} from "../../packages/protocol/dist/index.js";

export async function verifyTaskGoalActivation({
  verifyPause,
  verifyTransferSource,
  verifyCheckpoint,
  verifyRestart,
  verifyStop,
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
  let calls = modelCalls();
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
  const resumeEpoch = receipt.queueOrderEpoch + Number(Boolean(verifyPause));
  const cycles = goalCycles({
    receipt,
    threadId,
    serverId,
    generation,
    orderEpoch: resumeEpoch,
  });
  const answer = "Native first Goal result.";
  const phases = [];
  const admissions = Promise.withResolvers();
  const attempted = Promise.withResolvers();
  const replayed = Promise.withResolvers();
  let delivery;
  let restoration;
  const inputCommand = {
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
  };
  attach({
    answer,
    cycle: cycles.authorize,
    dispatch: (body, send) => {
      const request = taskInferenceInputDispatchSchema.parse(body);
      if (
        restoration &&
        request.receipt.operationId === restoration.receipt.operationId
      ) {
        assert.deepEqual(request.receipt, restoration.receipt);
        assert.equal(request.workerGeneration, generation());
        assert.equal(
          request.phase,
          ["claim", "dispatch", "native"][restoration.phase++],
        );
        if (request.phase === "native") {
          assert.equal(request.nativeExecution.threadId, threadId);
          assert.equal(request.nativeExecution.turnId, restoration.turnId);
          restoration.bound.resolve(() =>
            send({
              receipt: restoration.receipt,
              nativeExecution: request.nativeExecution,
              nativeRuntimeGeneration: request.nativeRuntimeGeneration,
            }),
          );
        } else send({ receipt: restoration.receipt });
        return;
      }
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
      if (
        restoration &&
        record.notification.taskInferenceInputOperationId ===
          restoration.receipt.operationId
      ) {
        assert.equal(record.inputKind, "goal");
        assert.deepEqual(
          record.notification.taskDispatchFence,
          restoration.receipt.dispatch,
        );
        restoration.delivered.resolve({
          record,
          commit: () => {
            cycles.commitRestored();
            send({
              committed: true,
              deliveryId: record.deliveryId,
              taskInferenceInputOperationId: restoration.receipt.operationId,
            });
          },
        });
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

  const transferSource = {
    type: "task.goal.source",
    cycleId: dispatch.cycleId,
    scope: {
      workerId,
      chatId,
      threadId,
      contextKind: "project",
      projectId: command.policyProjectId,
      placementId: worktreeId,
      modelRouteId: receipt.modelRouteId,
      providerAccountId: receipt.providerAccountId,
    },
  };
  const holdProvider = async () => {
    const blockerId = randomUUID();
    const pending = untilProvider();
    const turn = invoke({
      type: "chat.turn",
      executionProfile: "ide",
      chatId: blockerId,
      contextKind: "project",
      clientMessageId: randomUUID(),
      executionLaneId: randomUUID(),
      worktreeId: randomUUID(),
      policyProjectId: randomUUID(),
      rootKind: "folder-root",
      isPrimary: true,
      worktreeMode: "agent-managed",
      worktreePolicy: "direct",
      scratchRootId: null,
      provider,
      prompt: "Occupy the Task Goal provider slot.",
    });
    const model = await available(
      Promise.race([
        pending,
        turn.then((reply) => assert.fail(JSON.stringify(reply))),
      ]),
    );
    calls++;
    return async () => {
      model.finish();
      assert.equal((await turn).ok, true, diagnostics());
    };
  };
  const providerOperations = async () => {
    const status = await invoke({ type: "inference.status" });
    assert.equal(status.ok, true, JSON.stringify(status));
    return (
      status.result.pools.find(({ providerId }) => providerId === provider.id)
        ?.operations ?? []
    );
  };
  const capture = async (input) => {
    const deadline = Date.now() + 10_000;
    const request = input ? { ...transferSource, input } : transferSource;
    let queued;
    let reply;
    while (Date.now() < deadline) {
      queued = (await providerOperations()).find(
        (operation) =>
          operation.chatId === chatId && operation.state === "waiting",
      );
      if (queued) {
        reply = await invoke(request);
        // The pool can observe a wait before the adapter sees its durable queue receipt.
        if (
          reply.ok ||
          !/no unique (unused first Goal input|queued private Goal source)/u.test(
            reply.error?.message,
          )
        )
          break;
      }
      await delay(50);
    }
    assert.ok(
      queued,
      "The Goal source should wait on actual provider capacity.",
    );
    assert.equal(reply?.ok, true, JSON.stringify(reply) + "\n" + diagnostics());
    const source = taskGoalHandoffCaptureSchema.parse(reply.result);
    assert.equal(source.record.state, "waiting");
    assert.equal(source.record.workerGeneration, generation());
    assert.equal(source.record.identity.operationId, queued.operationId);
    assert.equal(source.record.identity.chatId, chatId);
    assert.equal(source.record.identity.providerId, provider.id);
    const context = source.snapshot.context;
    assert.equal(context.threadId, threadId);
    assert.equal(
      source.record.identity.runtimeGeneration,
      queued.runtimeGeneration,
    );
    assert.equal(source.record.identity.recovery.threadId, threadId);
    const settings = await decryptNativeSettingsSnapshot({
      ownerId,
      serverId,
      componentKey: chatKey,
      keyRevision: 1,
      context,
      snapshot: source.snapshot,
    });
    assert.deepEqual(settings.settingsVersion, context.settingsVersion);
    assert.equal(settings.model, "gpt-5");
    const wrong = await invoke({
      ...request,
      scope: { ...request.scope, modelRouteId: "wrong-route" },
    });
    assert.equal(wrong.ok, false);
    return source;
  };
  const setCapacity = async (limit, revision) => {
    const configured = await invoke({
      type: "inference.configure",
      configurations: [
        {
          providerId: provider.id,
          maxConcurrentInference: limit,
          inferenceConfigRevision: revision,
        },
      ],
    });
    assert.equal(configured.ok, true, JSON.stringify(configured));
    const pool = configured.result.pools.find(
      ({ providerId }) => providerId === provider.id,
    );
    assert.equal(pool.maxConcurrentInference, limit);
  };
  let release;
  if (verifyTransferSource) {
    await setCapacity(1, 1);
    release = await holdProvider();
  }
  const streaming = [];
  const providerRequest = untilProvider();
  const notification = waitForFrame(
    (frame) => frame.notification?.clientMessageId === clientMessageId,
  );
  const running = invoke(inputCommand, (event) => streaming.push(event));
  const earlyReply = running.then((reply) => {
    throw new Error(JSON.stringify(reply) + "\n" + diagnostics());
  });
  let inputSource;
  if (verifyTransferSource) {
    inputSource = await capture(receipt);
    assert.deepEqual(inputSource.record.identity.recovery.taskInput, receipt);
    assert.equal(inputSource.taskGoalInput.orderEpoch, receipt.queueOrderEpoch);
    assert.equal(modelCalls(), calls);
    await release();
  }
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
  if (verifyPause) {
    const pauseScope = {
      workerId,
      projectId: command.policyProjectId,
      worktreeId,
      threadId,
      modelRouteId: receipt.modelRouteId,
      providerAccountId: receipt.providerAccountId,
      cycleId: dispatch.cycleId,
      orderEpoch: receipt.queueOrderEpoch,
      revision: 2,
    };
    const notice = (paused, scope = {}) =>
      invoke({
        type: "chat.queue.changed",
        chatId,
        revision: 10 + (scope.revision ?? pauseScope.revision),
        taskPause: { paused, scope: { ...pauseScope, ...scope } },
      });
    const applied = async (paused, scope) => {
      const result = await notice(paused, scope);
      assert.equal(
        result.ok,
        true,
        JSON.stringify(result) + "\n" + diagnostics(),
      );
      assert.deepEqual(result.result, { acknowledged: true });
    };
    const wrongWorker = await notice(true, { workerId: "not-this-worker" });
    assert.match(wrongWorker.error.message, /belongs to another worker/);
    await applied(true);
    await applied(true);
    const conflict = await notice(false);
    assert.match(conflict.error.message, /revision changed its intent/);
    await applied(false, { revision: 1 });
    acknowledge();
    await Promise.race([
      delay(150),
      earlyReply,
      providerRequest.then(() =>
        assert.fail("The paused worker forwarded a model request."),
      ),
    ]);
    assert.equal(modelCalls(), calls);
    await applied(false, { revision: 3, orderEpoch: resumeEpoch });
    await applied(true, { revision: 2 });
    console.log(
      "Task pause delivery held the real native Goal input, ignored stale revisions, and applied the newer Resume.",
    );
  } else {
    acknowledge();
  }
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
  if (verifyTransferSource) {
    // Reserve the second blocker while the first input still owns its model
    // response, then lower the cap before Codex can request its next cycle.
    await setCapacity(2, 2);
    release = await holdProvider();
    await setCapacity(1, 3);
  }
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
  const restoreCycle = async ({
    source,
    evidence,
    pauseCommand,
    check,
    model,
    expectedAnswer,
  }) => {
    const previous = generation();
    await stop();
    await start();
    assert.notEqual(generation(), previous);
    assert.deepEqual(
      check(
        await invoke({
          ...pauseCommand,
          paused: false,
          task: { ...pauseCommand.task, revision: 5 },
        }),
      ),
      { paused: false, active: null },
    );
    const fresh = {
      ...receipt,
      operationId: randomUUID(),
      dispatch: { ...dispatch, fencingToken: dispatch.fencingToken + 1 },
    };
    const controlId = randomUUID();
    restoration = {
      receipt: fresh,
      phase: 0,
      turnId: source.turnId,
      bound: Promise.withResolvers(),
      delivered: Promise.withResolvers(),
    };
    const resumed = Promise.withResolvers();
    const next = untilProvider();
    const continued = invoke(
      {
        ...inputCommand,
        taskInferenceInput: fresh,
        taskDispatchLease: {
          ...inputCommand.taskDispatchLease,
          ...fresh.dispatch,
        },
        taskResumption: {
          controlId,
          checkpoint: evidence,
          source: receipt,
          goalCycle: source,
        },
        resultMode: {
          ...inputCommand.resultMode,
          messageId: source.publication.id,
          idempotencyKey: source.publication.idempotencyKey,
        },
      },
      (event) => {
        if (event.type === "agent.task-resumed") resumed.resolve(event);
      },
    );
    const early = continued.then((reply) =>
      assert.fail(JSON.stringify(reply) + "\n" + diagnostics()),
    );
    const bind = await available(
      Promise.race([
        restoration.bound.promise,
        early,
        next.then(() =>
          assert.fail(
            "Restored Goal reached the provider before native binding.",
          ),
        ),
      ]),
    );
    assert.equal(modelCalls(), model.number);
    bind();
    assert.deepEqual(await available(Promise.race([resumed.promise, early])), {
      type: "agent.task-resumed",
      controlId,
      inputOperationId: fresh.operationId,
      threadId,
      turnId: source.turnId,
    });
    const provider = await Promise.race([next, early]);
    assert.equal(provider.number, model.number + 1);
    provider.finish();
    const { record, commit } = await available(
      Promise.race([restoration.delivered.promise, early]),
    );
    assert.equal(record.notification.outcome.ok, true);
    assert.equal(record.notification.outcome.result.turnId, source.turnId);
    const message = record.notification.outcome.result.structuredResult.message;
    assert.equal(message.id, source.publication.id);
    assert.equal((await openMessage(message)).content[0].text, expectedAnswer);
    console.log(
      "Restored the original autonomous Goal turn after restarting the Rust worker and Codex.",
    );
    return {
      record,
      commit: () => {
        commit();
        return continued;
      },
    };
  };
  if (verifyTransferSource) {
    const cycleSource = await capture();
    const cycle = cycleSource.record.identity.recovery.taskGoalCycle;
    assert.equal(cycle.cycleId, dispatch.cycleId);
    assert.equal(cycle.goalEpoch, inputSource.taskGoalInput.goalEpoch);
    assert.equal(
      cycle.runnerGeneration,
      inputSource.taskGoalInput.runnerGeneration,
    );
    assert.equal(cycle.orderEpoch, receipt.queueOrderEpoch);
    assert.equal(modelCalls(), calls + 1);
    await release();
    console.log(
      "Captured the unused Task Goal input and its private native cycle through the worker command.",
    );
  }
  await cycles.verify({
    firstTurnId: native.turnId,
    untilProvider,
    available,
    openMessage,
    outcomeDirectory: path.dirname(pending),
    checkpoint: verifyCheckpoint
      ? {
          invoke,
          oracle,
          modelCalls,
          directory,
          ownerId,
          projectId: command.policyProjectId,
          prompt: resumedMessage,
          diagnostics,
          stopCycle: verifyStop
            ? { start, stop, provider, generation }
            : undefined,
          restoreCycle: verifyRestart ? restoreCycle : undefined,
        }
      : undefined,
    setAnswer,
    stop,
    start,
  });
  if (verifyStop) return;
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
