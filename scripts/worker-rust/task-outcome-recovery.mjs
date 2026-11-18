import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { taskGoalOutcomeDeliverySchema } from "../../packages/protocol/dist/index.js";
import { TaskGoalOutcomeDelivery } from "../../cantrip_worker/src/task-goal-outcome-delivery.ts";

function namespace(directory, { serverId, ownerId, workerId }) {
  const digest = createHash("sha256")
    .update(JSON.stringify([serverId, ownerId, workerId]))
    .digest("hex");
  return path.join(directory, "task-goal-outcomes", digest);
}

function note(fence) {
  return {
    type: "chat.turn.outcome",
    chatId: randomUUID(),
    clientMessageId: randomUUID(),
    contextKind: "project",
    executionLaneId: "recorded-lane",
    worktreeId: "recorded-placement",
    scratchRootId: null,
    taskInferenceInputOperationId: randomUUID(),
    taskDispatchFence: fence,
    outcome: { ok: false, error: "Saved Task outcome fixture." },
  };
}

async function saved(directory, scope, inputKind, notification, source) {
  const entered = Promise.withResolvers();
  const delivery = new TaskGoalOutcomeDelivery({
    directory,
    scope: () => scope,
    send: (record, signal) => {
      if (record.notification.clientMessageId !== notification.clientMessageId)
        return Promise.reject(
          new Error("The previous fixture record stays pending."),
        );
      entered.resolve(record);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    onError: (error) => entered.reject(error),
  });
  const written = delivery.append(notification, scope, inputKind, source);
  written.catch(entered.reject);
  const record = await entered.promise;
  delivery.close();
  await written.catch(() => {});
  const file = path.join(
    namespace(directory, scope),
    record.deliveryId + ".json",
  );
  return { record, file, bytes: await readFile(file, "utf8") };
}

export async function verifyTaskOutcomeRecovery({
  directory,
  scope,
  run,
  stop,
  attach,
  available,
}) {
  const fence = {
    cycleId: randomUUID(),
    operationId: randomUUID(),
    leaseOwner: "fixture-lease",
    fencingToken: 1,
  };
  const round = await saved(directory, scope, "round", note(fence));
  const goal = await saved(directory, scope, "goal", note(fence));
  // Older version-one Goal records have no input kind. The server still sees
  // the current schema default while the pending bytes remain immutable.
  const { inputKind, ...oldGoal } = goal.record;
  assert.equal(inputKind, "goal");
  goal.bytes = JSON.stringify(oldGoal);
  await writeFile(goal.file, goal.bytes);

  const cycle = {
    cycleId: fence.cycleId,
    goalEpoch: "epoch",
    scopeId: "scope",
    gateAttemptId: "attempt",
    runnerGeneration: "runner",
    modelRouteId: "route",
    providerAccountId: null,
    orderEpoch: 0,
  };
  const autonomous = note(fence);
  delete autonomous.taskInferenceInputOperationId;
  delete autonomous.taskDispatchFence;
  const goalCycle = await saved(directory, scope, "goal-cycle", autonomous, {
    kind: "goal-cycle",
    sourceKey: "e".repeat(64),
    threadId: "thread",
    turnId: "turn",
    cycle,
    operationId: "native-inference:thread:turn:scope:attempt",
    workerGeneration: randomUUID(),
    runtimeGeneration: randomUUID(),
    publication: {
      id: randomUUID(),
      idempotencyKey: "assistant:goal-cycle:fixture",
    },
    parent: {
      kind: "goal",
      operationId: randomUUID(),
      chatId: autonomous.chatId,
      clientMessageId: autonomous.clientMessageId,
      workerId: scope.workerId,
      worktreeId: autonomous.worktreeId,
      executionLaneId: autonomous.executionLaneId,
      executionLaneActivatedAt: new Date().toISOString(),
      providerId: "provider",
      modelRouteId: cycle.modelRouteId,
      providerAccountId: null,
      dispatch: fence,
    },
  });
  const foreign = await saved(
    directory,
    { ...scope, ownerId: "other-owner" },
    "goal",
    note(fence),
  );
  const admitted = new Map(
    [round, goal, goalCycle].map((item) => [item.record.deliveryId, item]),
  );
  const seen = [new Map(), new Map()];
  let start = 0;
  attach((input, send) => {
    const record = taskGoalOutcomeDeliverySchema.parse(input);
    assert.deepEqual(record, admitted.get(record.deliveryId)?.record);
    seen[start].set(record.deliveryId, record);
    const receipt = {
      deliveryId: record.deliveryId,
      taskInferenceInputOperationId:
        record.notification.taskInferenceInputOperationId,
    };
    if (record.deliveryId === goalCycle.record.deliveryId) {
      send({
        deliveryId: record.deliveryId,
        goalCycleSourceKey:
          start === 0 ? "f".repeat(64) : record.goalCycleSource.sourceKey,
        committed: true,
      });
    } else if (record.deliveryId === round.record.deliveryId) {
      send({
        ...receipt,
        committed: false,
        retiredReason: "canonical-input-deleted",
      });
    } else if (start === 0) {
      send({ ...receipt, deliveryId: randomUUID(), committed: true });
    } else {
      send({ ...receipt, committed: true });
    }
  });
  async function until(predicate) {
    for (let i = 0; i < 250; i++) {
      if (await predicate()) return;
      await delay(20);
    }
    throw new Error("Task outcome recovery did not reach the expected state.");
  }
  await run();
  await available(
    until(
      async () =>
        seen[0].size === 3 &&
        (await readdir(path.dirname(goal.file))).length === 2,
    ),
  );
  await stop();
  assert.equal(await readFile(goal.file, "utf8"), goal.bytes);
  assert.equal(await readFile(goalCycle.file, "utf8"), goalCycle.bytes);
  assert.equal(await readFile(foreign.file, "utf8"), foreign.bytes);
  start = 1;
  await run();
  await available(
    until(
      async () =>
        seen[1].has(goal.record.deliveryId) &&
        (await readdir(path.dirname(goal.file))).length === 0,
    ),
  );
  await stop();
  assert.deepEqual(
    new Set(seen[1].keys()),
    new Set([goal.record.deliveryId, goalCycle.record.deliveryId]),
  );
  for (const id of seen[1].keys()) {
    assert.deepEqual(seen[0].get(id), seen[1].get(id));
  }
  assert.equal(await readFile(foreign.file, "utf8"), foreign.bytes);
  attach(undefined);
}
