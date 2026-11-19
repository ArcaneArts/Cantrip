import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  taskGoalCycleDispatchSchema,
  taskGoalCycleDispatchResultSchema,
  taskGoalOutcomeDeliverySchema,
  taskMessageRelayResultSchema,
  taskPauseRuntimeStateSchema,
} from "../../packages/protocol/dist/index.js";

import { NativeSuspensionStore } from "../../cantrip_worker/src/native-suspension-store.ts";

function checkpointTool(body) {
  const exec = body.tools
    .flatMap((tool) =>
      tool.type === "namespace"
        ? tool.tools.map((entry) => ({ ...entry, namespace: tool.name }))
        : [tool],
    )
    .find((tool) => tool.name === "exec_command");
  assert.ok(exec, "The native Goal exposes the command tool.");
  return {
    name: exec.name,
    ...(exec.namespace ? { namespace: exec.namespace } : {}),
    call_id: "goal-checkpoint-boundary",
    arguments: JSON.stringify({
      cmd: "printf goal-checkpoint-boundary",
      yield_time_ms: 1000,
    }),
  };
}

async function pauseGoal({
  invoke,
  oracle,
  modelCalls,
  directory,
  ownerId,
  projectId,
  prompt,
  diagnostics,
  source,
  model,
  serverId,
  untilProvider,
  setAnswer,
  answer,
  restoreCycle,
}) {
  const { parent, cycle, sourceKey, operationId, threadId, turnId } = source;
  const active = { threadId, turnId };
  const command = {
    type: "chat.pause.set",
    chatId: parent.chatId,
    paused: true,
    task: {
      workerId: parent.workerId,
      projectId,
      worktreeId: parent.worktreeId,
      threadId,
      modelRouteId: cycle.modelRouteId,
      providerAccountId: cycle.providerAccountId,
      cycleId: cycle.cycleId,
      orderEpoch: cycle.orderEpoch,
      revision: 4,
      taskGoalCycle: {
        cycleId: cycle.cycleId,
        sourceKey,
        operationId,
        goalEpoch: cycle.goalEpoch,
        scopeId: cycle.scopeId,
      },
    },
  };
  const check = (reply) => {
    assert.equal(reply.ok, true, JSON.stringify(reply) + "\n" + diagnostics());
    return taskPauseRuntimeStateSchema.parse(reply.result);
  };
  assert.deepEqual(
    check(await invoke({ ...command, waitForBoundary: false })),
    {
      paused: true,
      active: null,
    },
  );
  const paused = invoke(command).then(check);
  setAnswer(answer);
  const commentaryId = "goal-before-checkpoint";
  model.finish([
    {
      type: "message",
      role: "assistant",
      phase: "commentary",
      id: commentaryId,
      content: [
        { type: "output_text", text: "Private Goal commentary before Pause." },
      ],
    },
  ]);
  const state = await paused;
  assert.deepEqual(state.active, active);
  const actor = {
    operationId,
    operationGeneration: operationId,
    workerGeneration: source.workerGeneration,
    runtimeGeneration: source.runtimeGeneration,
  };
  assert.deepEqual(state.execution.actor, actor);
  assert.equal(modelCalls(), model.number);
  const wrong = await invoke({
    ...command,
    task: {
      ...command.task,
      taskGoalCycle: {
        ...command.task.taskGoalCycle,
        sourceKey: "f".repeat(64),
      },
    },
  });
  assert.equal(wrong.ok, false);
  assert.match(
    wrong.error.message,
    /does not match its current native execution/,
  );
  assert.deepEqual(check(await invoke(command)), state);

  const { principalId } = JSON.parse(
    await readFile(path.join(directory, "worker-encryption-key.json"), "utf8"),
  );
  const store = new NativeSuspensionStore(
    directory,
    () => ({ serverId, ownerId, workerId: parent.workerId }),
    { ...oracle, registration: () => ({ principalId }) },
  );
  const saved = await store.open(state.execution.checkpoint.storageId, {
    chatId: parent.chatId,
    contextKind: "project",
    projectId,
    placementId: parent.worktreeId,
    threadId,
    modelRouteId: cycle.modelRouteId,
    providerAccountId: cycle.providerAccountId,
    taskGoalCycle: source,
  });
  assert.deepEqual(saved.evidence, state.execution.checkpoint);
  assert.equal(saved.continuation.turnId, turnId);
  assert.equal(saved.continuation.model.routeId, cycle.modelRouteId);
  assert.deepEqual(saved.taskContinuation.prompt, prompt);
  assert.deepEqual(saved.taskContinuation.publication, source.publication);
  assert.ok(
    saved.taskContinuation.events.ids.some(
      ([key]) => key === `agent-message:root:${turnId}:${commentaryId}`,
    ),
  );

  if (restoreCycle)
    return restoreCycle({
      source,
      evidence: saved.evidence,
      pauseCommand: command,
      check,
      model,
      expectedAnswer: answer,
    });

  const next = untilProvider();
  const resume = invoke({
    ...command,
    paused: false,
    task: { ...command.task, revision: 5 },
  }).then(check);
  const continued = await Promise.race([next, resume.then(() => next)]);
  assert.equal(continued.number, model.number + 1);
  assert.deepEqual(await resume, {
    paused: false,
    active,
    execution: { actor, checkpoint: null },
  });
  console.log(
    "Paused and resumed the autonomous Task Goal with its original checkpoint source and publication.",
  );
  return { continued };
}

export function goalCycles({
  receipt,
  threadId,
  serverId,
  generation,
  orderEpoch = receipt.queueOrderEpoch ?? 0,
}) {
  const cycles = [];
  const observed = Array.from({ length: 2 }, () => ({
    dispatch: Promise.withResolvers(),
    outcome: Promise.withResolvers(),
  }));
  const retry = Promise.withResolvers();
  const restarted = Promise.withResolvers();
  let parentCommitted = false;
  let committed = 0;
  let firstDelivery;
  let finalDelivery;
  let afterRestart = false;
  return {
    authorize(body, reply) {
      assert.ok(
        parentCommitted,
        "The cycle must wait for its explicit parent.",
      );
      const dispatch = taskGoalCycleDispatchSchema.parse(body);
      const index = cycles.length;
      assert.equal(
        index,
        committed,
        "A cycle overtook its predecessor's result.",
      );
      assert.ok(
        observed[index],
        "The completed Goal should not start a new cycle.",
      );
      assert.equal(dispatch.serverId, serverId);
      assert.equal(dispatch.workerId, receipt.workerId);
      assert.equal(dispatch.workerGeneration, generation());
      assert.equal(dispatch.chatId, receipt.chatId);
      assert.equal(dispatch.providerId, receipt.providerId);
      assert.equal(dispatch.threadId, threadId);
      assert.equal(dispatch.cycle.cycleId, receipt.dispatch.cycleId);
      assert.equal(dispatch.cycle.modelRouteId, receipt.modelRouteId);
      assert.equal(dispatch.cycle.orderEpoch, orderEpoch);
      assert.equal(dispatch.cycle.providerAccountId, receipt.providerAccountId);
      assert.equal(
        dispatch.freshRuntimeGeneration,
        dispatch.nativeRuntimeGeneration,
      );
      assert.equal(
        dispatch.sourceKey,
        createHash("sha256")
          .update(
            JSON.stringify([
              dispatch.workerGeneration,
              dispatch.freshRuntimeGeneration,
              dispatch.operationId,
            ]),
          )
          .digest("hex"),
      );
      const source = taskGoalCycleDispatchResultSchema.parse({
        accepted: true,
        suspensionSource: {
          kind: "goal-cycle",
          sourceKey: dispatch.sourceKey,
          operationId: dispatch.operationId,
          workerGeneration: dispatch.workerGeneration,
          runtimeGeneration: dispatch.nativeRuntimeGeneration,
          threadId,
          turnId: dispatch.turnId,
          cycle: dispatch.cycle,
          parent: receipt,
          publication: {
            id: randomUUID(),
            idempotencyKey: "assistant:goal-cycle:" + dispatch.sourceKey,
          },
        },
      });
      cycles.push(source.suspensionSource);
      observed[index].dispatch.resolve(() => reply(source));
    },
    deliver(body, reply) {
      const record = taskGoalOutcomeDeliverySchema.parse(body);
      const index = cycles.findIndex(
        (source) => source.sourceKey === record.goalCycleSource.sourceKey,
      );
      assert.ok(index >= 0);
      assert.deepEqual(record.goalCycleSource, cycles[index]);
      assert.equal(record.serverId, serverId);
      assert.equal(record.workerId, receipt.workerId);
      assert.equal(
        record.notification.taskInferenceInputOperationId,
        undefined,
      );
      assert.equal(
        record.notification.clientMessageId,
        receipt.clientMessageId,
      );
      const authorize = () => {
        committed++;
        reply({
          committed: true,
          deliveryId: record.deliveryId,
          goalCycleSourceKey: record.goalCycleSource.sourceKey,
        });
      };
      if (index === 0 && !firstDelivery) {
        firstDelivery = record;
        reply({
          committed: true,
          deliveryId: record.deliveryId,
          goalCycleSourceKey: "0".repeat(64),
        });
        observed[index].outcome.resolve(record);
      } else if (index === 0) {
        assert.deepEqual(record, firstDelivery);
        retry.resolve(authorize);
      } else if (!afterRestart) {
        // Stop the worker while its scanner is waiting for this exact HTTP
        // receipt. No dispatch or plaintext is needed to replay it.
        finalDelivery = record;
        observed[index].outcome.resolve(record);
      } else {
        assert.deepEqual(record, finalDelivery);
        authorize();
        restarted.resolve();
      }
    },
    commitParent() {
      parentCommitted = true;
    },
    commitRestored() {
      committed++;
    },
    async verify({
      firstTurnId,
      untilProvider,
      available,
      openMessage,
      outcomeDirectory,
      checkpoint,
      setAnswer,
      stop,
      start,
    }) {
      const advance = async (index) => {
        const incoming = untilProvider();
        const acknowledge = await available(
          Promise.race([
            observed[index].dispatch.promise,
            incoming.then(() => {
              throw new Error(
                "Continuation reached the provider before server authorization.",
              );
            }),
          ]),
        );
        acknowledge();
        return incoming;
      };
      const assertResult = async (record, answer) => {
        const source = record.goalCycleSource;
        const { result, ok } = record.notification.outcome;
        assert.equal(ok, true, JSON.stringify(record.notification.outcome));
        assert.equal(result.threadId, threadId);
        assert.equal(result.turnId, source.turnId);
        assert.equal(result.text, "");
        const { message } = taskMessageRelayResultSchema.parse(
          result.structuredResult,
        );
        assert.equal(message.id, source.publication.id);
        assert.equal(message.idempotencyKey, source.publication.idempotencyKey);
        assert.equal((await openMessage(message)).content[0].text, answer);
        assert.ok(!JSON.stringify(record).includes(answer));
      };
      const firstAnswer = "Autonomous Goal result one.";
      setAnswer(checkpoint ? checkpointTool : firstAnswer);
      const first = await advance(0);
      assert.notEqual(cycles[0].turnId, firstTurnId);
      const paused = checkpoint
        ? await pauseGoal({
            ...checkpoint,
            source: cycles[0],
            model: first,
            serverId,
            untilProvider,
            setAnswer,
            answer: firstAnswer,
          })
        : { continued: first };
      let commit = paused.commit;
      if (paused.continued) {
        paused.continued.finish();
        const record = await available(observed[0].outcome.promise);
        await assertResult(record, firstAnswer);
        const filename = path.join(
          outcomeDirectory,
          record.deliveryId + ".json",
        );
        const bytes = await readFile(filename, "utf8");
        assert.deepEqual(JSON.parse(bytes), record);
        commit = await available(retry.promise);
        assert.equal(await readFile(filename, "utf8"), bytes);
      }
      const finalAnswer = "Autonomous Goal result two.";
      setAnswer((body) => {
        if (
          body.input.some(
            (item) =>
              item.type === "function_call_output" &&
              item.call_id === "complete-fixture-goal",
          )
        )
          return finalAnswer;
        const tools = body.tools.flatMap((tool) => tool.tools ?? [tool]);
        const finish = tools.find(
          ({ name }) =>
            name === "update_goal" || name?.endsWith("__update_goal"),
        );
        assert.ok(
          finish,
          "Codex must expose the active Goal's completion tool.",
        );
        return {
          name: finish.name,
          call_id: "complete-fixture-goal",
          arguments: JSON.stringify({ status: "complete" }),
        };
      });
      const next = advance(1);
      const restored = commit();
      if (checkpoint?.restoreCycle) {
        assert.deepEqual(
          (await restored).result,
          paused.record.notification.outcome.result,
        );
      }
      const second = await next;
      const final = untilProvider();
      second.finish();
      (await final).finish();
      const finalRecord = await available(observed[1].outcome.promise);
      await assertResult(finalRecord, finalAnswer);
      assert.notEqual(cycles[1].turnId, cycles[0].turnId);
      assert.equal(cycles[1].cycle.goalEpoch, cycles[0].cycle.goalEpoch);
      const uncommitted = path.join(
        outcomeDirectory,
        finalRecord.deliveryId + ".json",
      );
      const finalBytes = await readFile(uncommitted, "utf8");
      assert.deepEqual(JSON.parse(finalBytes), finalRecord);
      await stop();
      assert.equal(await readFile(uncommitted, "utf8"), finalBytes);
      afterRestart = true;
      await start();
      await available(restarted.promise);
      for (let attempt = 0; attempt < 250; attempt++) {
        try {
          await stat(uncommitted);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          console.log(
            "Ran two autonomous Codex Goal turns, verified their commit barriers, and replayed the final outcome after shutdown.",
          );
          return;
        }
        await delay(20);
      }
      assert.fail("The acknowledged autonomous Goal outcome was not removed.");
    },
  };
}
