import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { modelFunctions } from "../server-rust/task-model-provider.mjs";
import { goalCycles } from "./task-goal-cycle-cases.mjs";
import { taskGoalHandoff } from "./task-goal-handoff-cases.mjs";
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
  nativeInferenceRecoverySchema,
  taskGoalHandoffCaptureSchema,
  taskGoalCycleRecoveryReceiptSchema,
  taskGoalOutcomeDeliverySchema,
  taskGoalWorkerResultSchema,
  taskInferenceInputDispatchSchema,
  taskMessageRelayResultSchema,
} from "../../packages/protocol/dist/index.js";

export async function verifyTaskGoalActivation({
  verifyPause,
  pauseObservationOnly,
  verifyChildModel,
  observeProvider,
  verifyTransferSource,
  verifyProviderHandoff,
  interruptProviderHandoff,
  withdrawSource,
  attachHandoff,
  attachRecovery,
  cwd,
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
  crash,
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
  const subagentDefaults = verifyChildModel
    ? {
        model: {
          id: "fixture-child-model",
          routeId: "fixture-child-route",
          name: "gpt-5-mini",
          reasoningEffort: "low",
          catalog: {
            nativeModelId: "gpt-5-mini",
            displayName: "Fixture child model",
            description: null,
            contextWindow: null,
            maxOutputTokens: null,
            inputModalities: ["text"],
            outputModalities: ["text"],
            supportsTools: true,
            supportsParallelTools: null,
            supportsStructuredOutput: null,
            supportsVision: false,
            supportsReasoning: true,
            supportedReasoningEfforts: [{ effort: "low", description: null }],
            defaultReasoningEffort: null,
            reasoningMandatory: null,
            metadataSource: "compatible-api",
          },
        },
        provider,
      }
    : undefined;
  const activation = {
    subagentDefaults,
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
  if (pauseObservationOnly) {
    const pausedCycle = {
      cycleId: command.taskInferenceInput.dispatch.cycleId,
      orderEpoch: command.taskInferenceInput.queueOrderEpoch ?? 0,
    };
    const pause = async (paused, revision) => {
      const reply = await invoke({
        type: "chat.pause.set",
        chatId,
        paused,
        waitForBoundary: false,
        task: {
          workerId,
          projectId: command.policyProjectId,
          worktreeId,
          threadId,
          modelRouteId: command.taskInferenceInput.modelRouteId,
          providerAccountId: command.taskInferenceInput.providerAccountId,
          ...pausedCycle,
          revision,
        },
      });
      assert.equal(
        reply.ok,
        true,
        JSON.stringify(reply) + "\n" + diagnostics(),
      );
      assert.deepEqual(reply.result, { paused, active: null });
    };
    await pause(true, 1);
    await observer.pausedExecution(pausedCycle, 1);
    await observer.pausedExecution({
      ...pausedCycle,
      orderEpoch: pausedCycle.orderEpoch + 1,
    });
    await pause(false, 2);
    await observer.pausedExecution(pausedCycle);
    await pause(true, 3);
    await observer.pausedExecution(pausedCycle, 3);
    await stop();
    await start();
    await observer.pausedExecution(pausedCycle);
    assert.equal(modelCalls(), calls);
    console.log(
      "Observed the exact native idle pause revision and withheld proof for a different epoch, after Resume, and after restart.",
    );
    return;
  }
  if (subagentDefaults) {
    const rejected = await invoke({
      ...activation,
      subagentDefaults: {
        ...subagentDefaults,
        provider: { ...provider, id: "unselected-provider" },
      },
    });
    assert.equal(rejected.ok, true, JSON.stringify(rejected));
    const failure = taskGoalWorkerResultSchema.parse(rejected.result);
    assert.equal(failure.goal, null);
    assert.equal(failure.task.classification.state, "failed");
    await observer.beforeActivation();
    assert.equal(modelCalls(), calls);
  }
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
  let delegated = false;
  const delegate = (body) => {
    if (body.client_metadata?.thread_id !== threadId)
      return "The fixture child completed its check.";
    if (delegated) return answer;
    const spawn = modelFunctions(body.tools).find(
      ({ name }) => name === "spawn_agent" || name.endsWith("__spawn_agent"),
    );
    assert.ok(spawn, "Codex must advertise the native delegation tool");
    delegated = true;
    return {
      ...spawn,
      call_id: "fixture-task-child",
      arguments: JSON.stringify({
        message: "Return a short fixture-only confirmation.",
        ...(spawn.namespace === "multi_agent_v1" ||
        spawn.name === "multi_agent_v1__spawn_agent"
          ? {}
          : { task_name: "fixture" }),
      }),
    };
  };
  const phases = [];
  const admissions = Promise.withResolvers();
  const attempted = Promise.withResolvers();
  const replayed = Promise.withResolvers();
  let delivery;
  let restoration;
  const inputCommand = {
    ...base,
    subagentDefaults,
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
    answer: subagentDefaults ? delegate : answer,
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
  const holdProvider = async (heldProvider = provider) => {
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
      provider: heldProvider,
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
  const providerOperations = async (selectedProvider = provider) => {
    const status = await invoke({ type: "inference.status" });
    assert.equal(status.ok, true, JSON.stringify(status));
    return (
      status.result.pools.find(
        ({ providerId }) => providerId === selectedProvider.id,
      )?.operations ?? []
    );
  };
  const capture = async (input, target) => {
    const deadline = Date.now() + 10_000;
    const request = input
      ? { ...transferSource, input }
      : target
        ? {
            ...transferSource,
            scope: { ...transferSource.scope, modelRouteId: target.routeId },
          }
        : transferSource;
    const sourceProvider = target?.provider ?? provider;
    let queued;
    let reply;
    while (Date.now() < deadline) {
      queued = (await providerOperations(sourceProvider)).find(
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
    assert.equal(source.record.identity.providerId, sourceProvider.id);
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
    assert.equal(settings.model, target?.model ?? "gpt-5");
    const wrong = await invoke({
      ...request,
      scope: { ...request.scope, modelRouteId: "wrong-route" },
    });
    assert.equal(wrong.ok, false);
    return source;
  };
  const setCapacity = async (limit, revision, selectedProvider = provider) => {
    const configured = await invoke({
      type: "inference.configure",
      configurations: [
        {
          providerId: selectedProvider.id,
          maxConcurrentInference: limit,
          inferenceConfigRevision: revision,
        },
      ],
    });
    assert.equal(configured.ok, true, JSON.stringify(configured));
    const pool = configured.result.pools.find(
      ({ providerId }) => providerId === selectedProvider.id,
    );
    assert.equal(pool.maxConcurrentInference, limit);
  };
  if (subagentDefaults) await setCapacity(2, 1);
  let release;
  if (verifyTransferSource) {
    await setCapacity(1, 1);
    release = await holdProvider();
  }
  const streaming = [];
  const providerRequest = withdrawSource === "input" ? null : untilProvider();
  const notification = waitForFrame(
    (frame) => frame.notification?.clientMessageId === clientMessageId,
  );
  const running = invoke(inputCommand, (event) => streaming.push(event));
  const transferGoal = (source, target, interruptFinish) =>
    taskGoalHandoff({
      capture: source,
      scope: transferSource.scope,
      cycleId: dispatch.cycleId,
      provider,
      target,
      interruptFinish,
      available,
      cwd,
      attach: attachHandoff,
      attachRecovery,
      observeRecovery: cycles.retainSource,
      invoke,
      diagnostics,
    });
  let inputSource;
  if (verifyTransferSource) {
    inputSource = await capture(receipt);
    assert.deepEqual(inputSource.record.identity.recovery.taskInput, receipt);
    assert.equal(inputSource.taskGoalInput.orderEpoch, receipt.queueOrderEpoch);
    assert.equal(modelCalls(), calls);
    if (withdrawSource === "input") {
      await transferGoal(inputSource);
      const deferred = await running;
      assert.equal(deferred.ok, false, JSON.stringify(deferred));
      assert.equal(deferred.error.code, "worker-inference-deferred");
      assert.deepEqual(phases, ["claim"]);
      assert.equal(delivery, undefined);
      assert.equal(modelCalls(), calls);
      await release();
      console.log(
        "Withdrew the exact queued Task input through a lost acknowledgement without sending it to the provider.",
      );
      return;
    }
    await release();
  }
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
  let stopChildReplies;
  if (subagentDefaults) {
    const child = untilProvider(
      ({ body }) => body.client_metadata?.thread_id !== threadId,
    );
    const parent = untilProvider(
      ({ body }) => body.client_metadata?.thread_id === threadId,
    );
    model.finish();
    const [childRequest, parentRequest] = await Promise.race([
      Promise.all([child, parent]),
      earlyReply,
    ]);
    const metadata = childRequest.body.client_metadata;
    assert.equal(metadata.root_turn_id, native.turnId);
    assert.notEqual(metadata.turn_id, native.turnId);
    assert.equal(childRequest.body.model, subagentDefaults.model.name);
    assert.equal(
      childRequest.body.reasoning?.effort,
      subagentDefaults.model.reasoningEffort,
    );
    assert.equal(parentRequest.body.model, "gpt-5");
    setAnswer(answer);
    // A completed child can wake the same root turn for its notification.
    stopChildReplies = observeProvider((request) => {
      const owner = request.body.client_metadata;
      if (owner?.thread_id === threadId && owner?.turn_id === native.turnId)
        request.finish();
    });
    childRequest.finish();
    parentRequest.finish();
    console.log(
      `The native Task Goal child used ${childRequest.body.model} with ${childRequest.body.reasoning.effort} reasoning on its own turn.`,
    );
  } else {
    model.finish();
  }
  await available(Promise.race([attempted.promise, earlyReply])).finally(() =>
    stopChildReplies?.(),
  );
  const firstInputCalls = modelCalls();
  if (subagentDefaults) assert.ok(firstInputCalls >= calls + 3);
  else assert.equal(firstInputCalls, calls + 1);
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
  assert.equal(modelCalls(), firstInputCalls);
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
  assert.equal(modelCalls(), firstInputCalls);
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
    if (withdrawSource === "cycle") {
      await transferGoal(cycleSource);
      const resumed = await capture();
      assert.notEqual(resumed.record.key, cycleSource.record.key);
      assert.equal(
        resumed.record.identity.recovery.taskGoalCycle.goalEpoch,
        cycle.goalEpoch,
      );
      assert.equal(modelCalls(), calls + 1);
      console.log(
        "Recovered the private cycle withdrawal acknowledgement and released its original Task root.",
      );
    }
    if (verifyProviderHandoff) {
      const target = {
        provider: {
          ...provider,
          id: "task-target-provider",
          baseUrl: new URL("/fixture-task-target/v1", provider.baseUrl).href,
        },
        routeId: "task-target-route",
        model: "gpt-5-mini",
      };
      await setCapacity(1, 1, target.provider);
      const releaseTarget = await holdProvider(target.provider);
      const before = modelCalls();
      const disconnected = generation();
      let destinationAdmission;
      const interruptFinish = interruptProviderHandoff
        ? async () => {
            const pending = (await providerOperations(target.provider)).find(
              (operation) => operation.chatId === chatId,
            );
            assert.equal(pending?.state, "waiting", diagnostics());
            destinationAdmission = pending;
            // Let the keeper grant the recorded reservation while Core's finish
            // response is still held. It must remain incapable of sampling.
            await release();
            await releaseTarget();
            const deadline = Date.now() + 8_000;
            let granted;
            while (Date.now() < deadline) {
              granted = (await providerOperations(target.provider)).find(
                (operation) => operation.operationId === pending.operationId,
              );
              if (granted?.state === "granted") break;
              await delay(25);
            }
            assert.equal(granted?.state, "granted", diagnostics());
            assert.equal(modelCalls(), before);
            await crash();
          }
        : undefined;
      cycles.retarget(target, resumedMessage);
      const handoff = await transferGoal(cycleSource, target, interruptFinish);
      const recoveryFrom = (record) => ({
        sourceKey: record.key,
        operationId: record.identity.operationId,
        runtimeGeneration: record.identity.runtimeGeneration,
        workerGeneration: record.workerGeneration,
        workerId,
        providerId: record.identity.providerId,
        threadId,
        turnId: record.identity.recovery.turnId,
        cycle: record.identity.recovery.taskGoalCycle,
      });
      const recoverCommand = (recovery) => ({
        type: "task.goal.recover",
        chatId,
        threadId,
        cwd,
        projectId: command.policyProjectId,
        worktreeId,
        rootKind: command.rootKind,
        computerUseEnabled: false,
        model: {
          id: target.model,
          name: target.model,
          routeId: target.routeId,
          reasoningEffort: null,
        },
        provider: target.provider,
        subagentDefaults: null,
        mcpServers: [],
        planMode: "default",
        permissionProfileId: ":workspace",
        recovery,
      });
      let liveRecord;
      if (!interruptFinish) {
        const source = await capture(undefined, target);
        liveRecord = source.record;
        assert.equal(
          handoff.binding.runtimeGeneration,
          source.snapshot.context.runtimeGeneration,
        );
        const response = await invoke(recoverCommand(recoveryFrom(liveRecord)));
        assert.equal(
          response.ok,
          true,
          JSON.stringify(response) + "\n" + diagnostics(),
        );
        const { operationId, runtimeGeneration } = liveRecord.identity;
        assert.deepEqual(
          taskGoalCycleRecoveryReceiptSchema.parse(response.result),
          {
            status: "scheduled",
            sourceKey: liveRecord.key,
            workerGeneration: disconnected,
            admission: { operationId, runtimeGeneration },
          },
        );
        destinationAdmission = { operationId, runtimeGeneration };
        assert.equal(modelCalls(), before);
        await release();
        await stop();
      }
      const reconciled = Promise.withResolvers();
      attachRecovery((body) => {
        const request = nativeInferenceRecoverySchema.parse(body);
        const record = request.record;
        if (record.identity.operationId !== destinationAdmission.operationId)
          return undefined;
        assert.notEqual(request.workerGeneration, disconnected);
        assert.equal(record.workerGeneration, disconnected);
        assert.equal(record.identity.chatId, chatId);
        assert.equal(record.identity.providerId, target.provider.id);
        assert.equal(
          record.identity.runtimeGeneration,
          destinationAdmission.runtimeGeneration,
        );
        assert.equal(record.identity.recovery.threadId, threadId);
        assert.ok(record.nativeExecution == null);
        assert.notEqual(record.key, cycleSource.record.key);
        if (liveRecord) {
          assert.equal(record.key, liveRecord.key);
          assert.deepEqual(record.identity, liveRecord.identity);
          assert.equal(record.order, liveRecord.order);
        }
        assert.ok(
          ["waiting", "granted"].includes(record.state) ||
            (record.state === "released" &&
              ["never-started", "runtime-exited"].includes(record.outcome)),
        );
        const recovered = recoveryFrom(record);
        assert.equal(recovered.cycle.goalEpoch, cycle.goalEpoch);
        assert.equal(recovered.cycle.orderEpoch, cycle.orderEpoch + 1);
        assert.equal(recovered.cycle.modelRouteId, target.routeId);
        reconciled.resolve(recovered);
        return {
          key: record.key,
          chatId,
          disposition: "requeued",
          taskGoalCycleNotDispatched: true,
          taskGoalRecovery: recovered,
        };
      });
      await start();
      assert.notEqual(generation(), disconnected);
      await setCapacity(1, 1, target.provider);
      const recovered = await available(reconciled.promise);
      cycles.retainSource(recovered);
      const restored = await invoke(recoverCommand(recovered));
      assert.equal(
        restored.ok,
        true,
        JSON.stringify(restored) + "\n" + diagnostics(),
      );
      const receipt = taskGoalCycleRecoveryReceiptSchema.parse(restored.result);
      assert.equal(receipt.status, "scheduled");
      assert.equal(receipt.sourceKey, recovered.sourceKey);
      assert.equal(receipt.workerGeneration, generation());
      assert.notEqual(receipt.admission.operationId, recovered.operationId);
      assert.notEqual(
        receipt.admission.runtimeGeneration,
        recovered.runtimeGeneration,
      );
      assert.equal(modelCalls(), before);
      const verifyDestination = async (request) => {
        const endpoint = new URL(target.provider.baseUrl + "/responses");
        assert.equal(
          request.endpoint,
          endpoint.pathname,
          `Unexpected provider request #${request.number} (${request.body.model})`,
        );
        if (request.compaction) {
          assert.ok(!JSON.stringify(request.body.input).includes(promptText));
          const pending = untilProvider();
          request.finish();
          return verifyDestination(await pending);
        }
        assert.equal(request.body.model, target.model);
        return request;
      };
      await cycles.verify({
        firstTurnId: native.turnId,
        recoveredAdmission: receipt.admission,
        untilProvider,
        sampling: verifyDestination,
        available,
        openMessage,
        outcomeDirectory: path.dirname(pending),
        setAnswer,
        start,
        stop,
      });
      console.log(
        interruptFinish
          ? "Recovered the destination Task Goal after interrupting Core's finish response."
          : "Recovered the transferred Task Goal after destination restart and published its original Goal through native cycles.",
      );
      return;
    }
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
