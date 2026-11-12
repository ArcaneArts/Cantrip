import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { glob, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { eventually } from "./full-worker.mjs";
import {
  startSuspensionCapacityBlocker,
  suspensionCapacityStatus,
} from "./suspension-capacity-browser.mjs";

export async function transferQueuedTaskGoal({
  page,
  projectId,
  chatId,
  workerId,
  workerData,
  source,
  sourceModel,
  destination,
  finalizer,
  firstTurn,
  objective,
  result,
}) {
  const observation = (result.taskGoalProviderTransfer = {});
  const pool = async () =>
    (await suspensionCapacityStatus(page, workerId)).pools.find(
      ({ providerId }) => providerId === sourceModel.providerId,
    );
  const waitForQueued = (id) =>
    eventually(
      pool,
      (value) => {
        assert.equal(value?.maxConcurrentInference, 1);
        assert.equal(value.activeCount, 1);
        const operation = value.operations.find((entry) => entry.chatId === id);
        assert.equal(operation?.state, "waiting", JSON.stringify(value));
        assert.equal(operation.startedAt, null);
      },
      60_000,
    );
  const modelCalls = () =>
    source.requests.filter((request) => request.method === "POST").length;
  const target = await page.evaluate(
    async ({ baseUrl, nativeModel }) => {
      const models = await import("/src/lib/api/models.ts");
      const provider = await models.createModelProvider({
        name: "Disposable destination provider",
        kind: "openai-compatible",
        baseUrl,
        apiKey: null,
      });
      const profile = await models.createModelProfile({
        name: "Disposable destination model",
        routes: [
          { providerId: provider.id, modelName: nativeModel, enabled: true },
        ],
      });
      return { providerId: provider.id, routeId: profile.routes[0].id };
    },
    { baseUrl: destination.baseUrl, nativeModel: destination.model },
  );
  observation.target = target;
  await eventually(
    () => finalizer.entered,
    (entered) =>
      assert.equal(entered, true, "source finalization reached the model"),
    60_000,
  );
  const blocker = await startSuspensionCapacityBlocker({
    page,
    model: source,
    projectId,
    providerId: sourceModel.providerId,
    workerId,
    configuration: {
      modelId: sourceModel.modelId,
      reasoningEffort: null,
      customSubagentModel: false,
      subagentModelId: null,
      subagentReasoningEffort: null,
    },
    waitForAdmission: false,
  });
  try {
    await waitForQueued(blocker.chatId);
    finalizer.release();
    await eventually(
      () => blocker.reply.entered,
      (entered) => assert.equal(entered, true),
      60_000,
    );
    const waiting = await waitForQueued(chatId);
    observation.waiting = waiting.operations.find(
      (entry) => entry.chatId === chatId,
    );
    // The capacity view can publish before the keeper commits the queue entry.
    observation.keeper = await eventually(
      async () => {
        for await (const file of glob("inference-ownership/*/admission.json", {
          cwd: workerData,
        })) {
          const journal = JSON.parse(
            await readFile(path.join(workerData, file), "utf8"),
          );
          const record = Object.values(journal.operations).find(
            ({ identity }) =>
              identity.chatId === chatId &&
              identity.operationId === observation.waiting.operationId &&
              identity.runtimeGeneration ===
                observation.waiting.runtimeGeneration,
          );
          if (record) return record;
        }
      },
      (record) => {
        assert.equal(record?.state, "waiting");
        assert.equal(record.everGranted, false);
        assert.equal(record.identity.recovery.taskInput.kind, "goal");
      },
      60_000,
    );
    const sourceCalls = modelCalls();
    const captured = await page.evaluate(async (chatId) => {
      const { getClientSessionIdentitySnapshot } =
        await import("/src/lib/client-session.ts");
      const { readTaskGoalRuntimeSource } =
        await import("/src/lib/native-runtime-handoff.ts");
      const { binding } = await readTaskGoalRuntimeSource({
        chatId,
        identity: getClientSessionIdentitySnapshot(),
      });
      return binding;
    }, chatId);
    observation.captured = captured;
    assert.equal(captured?.chatId, chatId);
    assert.equal(captured.workerId, workerId);
    const begun = await page.evaluate(
      async ({ chatId, bindingId, targetModelRouteId }) => {
        const { getClientSessionIdentitySnapshot } =
          await import("/src/lib/client-session.ts");
        const { startRuntimeHandoff } =
          await import("/src/lib/native-runtime-handoff.ts");
        return startRuntimeHandoff(
          { chatId, identity: getClientSessionIdentitySnapshot() },
          {
            operationId: crypto.randomUUID(),
            bindingId,
            targetModelRouteId,
            targetProviderAccountId: null,
          },
        );
      },
      {
        chatId,
        bindingId: captured.bindingId,
        targetModelRouteId: target.routeId,
      },
    );
    observation.reservation = begun;
    assert.ok(
      begun.queuedSource?.taskGoalInput,
      "the original Task Goal input is reserved",
    );
    assert.deepEqual(
      begun.queuedSource.taskGoal.identity,
      observation.keeper.identity,
    );
    const readTransfer = () =>
      page.evaluate(async (chatId) => {
        const { getClientSessionIdentitySnapshot } =
          await import("/src/lib/client-session.ts");
        return (
          await (
            await import("/src/lib/native-runtime-handoff.ts")
          ).readRuntimeHandoffs({
            chatId,
            identity: getClientSessionIdentitySnapshot(),
          })
        ).latest;
      }, chatId);
    const finished = await eventually(
      async () => {
        const state = (observation.latest = await readTransfer());
        if (state?.errorCode)
          throw new Error(
            `Provider transfer failed in ${state.phase}: ${state.errorCode}`,
          );
        return state;
      },
      (state) => {
        assert.equal(state?.phase, "completed", JSON.stringify(state));
      },
      60_000,
    );
    assert.equal(finished.operationId, begun.operationId);
    assert.equal(finished.queuedSource.withdrawn, true);
    assert.equal(finished.binding.threadId, captured.threadId);
    assert.equal(finished.binding.modelRouteId, target.routeId);
    assert.notEqual(
      finished.binding.runtimeGeneration,
      captured.runtimeGeneration,
    );
    await eventually(
      () => firstTurn.entered,
      (entered) =>
        assert.equal(entered, true, "the queued input reached the destination"),
      60_000,
    );
    assert.equal(
      modelCalls(),
      sourceCalls,
      "the source provider never starts the queued Goal",
    );
    assert.equal(blocker.reply.request.completed, false);
    assert.ok(JSON.stringify(firstTurn.request.input).includes(objective));
    observation.sourceCalls = sourceCalls;
    observation.destinationStartedWhileSourceBusy = true;
    observation.files = await readTransferFiles(
      workerData,
      finished,
      target.providerId,
    );
    result.steps.push(
      "the browser transfers an unused encrypted Task Goal input to another provider through the full worker and native history import",
    );
  } finally {
    finalizer.release();
    blocker.reply.release();
  }
  await eventually(
    () => blocker.reply.request?.completed,
    (completed) => assert.equal(completed, true),
  );
}

async function readTransferFiles(directory, state, providerId) {
  const { operationId, chatId } = state;
  const { threadId } = state.source;
  const journals = await Array.fromAsync(
    glob(`managed-runtime-handoffs/*/${operationId}/export.json`, {
      cwd: directory,
    }),
  );
  assert.equal(journals.length, 1);
  const exportReceipt = JSON.parse(
    await readFile(path.join(directory, journals[0]), "utf8"),
  );
  const plan = JSON.parse(
    await readFile(
      path.join(directory, path.dirname(journals[0]), "plan.json"),
      "utf8",
    ),
  );
  assert.equal(plan.chatId, chatId);
  assert.equal(plan.operationId, operationId);
  assert.equal(plan.threadId, threadId);
  assert.ok(plan.expectedLastTurnId);
  assert.equal(
    plan.expectedGoalEpoch,
    state.queuedSource.taskGoalInput.goalEpoch,
  );
  assert.equal(exportReceipt.threadId, threadId);
  assert.equal(exportReceipt.transferId, operationId);
  const exportPath = await realpath(exportReceipt.path);
  assert.ok(exportPath.startsWith((await realpath(directory)) + path.sep));
  const bytes = await readFile(exportPath);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    exportReceipt.sha256,
  );

  const selections = await Array.fromAsync(
    glob(`managed-native-namespaces/*/*/selections/${operationId}.json`, {
      cwd: directory,
    }),
  );
  assert.equal(selections.length, 1);
  const selection = JSON.parse(
    await readFile(path.join(directory, selections[0]), "utf8"),
  );
  assert.equal(selection.chatId, chatId);
  assert.equal(selection.threadId, threadId);
  assert.equal(selection.provider.id, providerId);
  const home = path.join(
    directory,
    path.dirname(path.dirname(selections[0])),
    "homes",
    operationId,
  );
  const rollouts = await Array.fromAsync(
    glob(`**/rollout-*-${threadId}.jsonl`, { cwd: home }),
  );
  assert.equal(rollouts.length, 1);
  const rollout = await readFile(path.join(home, rollouts[0]), "utf8");
  assert.ok(
    rollout.includes(plan.expectedLastTurnId),
    "the imported rollout retains the original boundary",
  );
  return {
    exportBytes: bytes.length,
    exportSha256: exportReceipt.sha256,
    originalLastTurnId: plan.expectedLastTurnId,
    originalGoalEpoch: plan.expectedGoalEpoch,
    destinationRollout: path.join(path.relative(directory, home), rollouts[0]),
    destinationSelection: selections[0],
  };
}
