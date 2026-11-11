// Browser SDK -> server -> full worker -> bundled Codex -> local model HTTP.
// No worker handler, native RPC, encrypted operation or repository is replaced.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { eventually } from "./full-worker.mjs";
import { taskModelProvider } from "./task-model-provider.mjs";
import { actualTaskRecovery } from "./actual-task-recovery.mjs";
import { captureTaskRuntimeState } from "./task-runtime-snapshot.mjs";
import { browserFixtureSql } from "./browser-fixture-sql.mjs";

async function verifyOutcomeOrdering(
  readMessages,
  reply,
  answer,
  file,
  result,
  field,
) {
  try {
    await eventually(readMessages, (messages) =>
      assert.ok(
        messages.some((message) =>
          message.content.some(
            (item) =>
              item.type === "text" &&
              item.text === answer &&
              item.streaming === true,
          ),
        ),
      ),
    );
  } finally {
    reply.release();
  }
  const order = await eventually(
    () =>
      readFile(file, "utf8").then(JSON.parse, (error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }),
    (observation) =>
      assert.ok(observation, "the worker observed the HTTP outcome"),
  );
  result[field] = order;
  assert.equal(order.status, 200);
  assert.equal(order.committed, true);
  assert.equal(order.finalEventHeld, true);
  assert.equal(order.receiptMatchesFinalEvent, true);
  assert.equal(order.differsFromProvisionalEvent, true);
  assert.equal(order.replayedProvisionalEvent, true);
  assert.equal(order.exactReplay, true);
  assert.equal(order.changedReplayStatus, 409);
  assertFinalAnswer(await readMessages(), order, answer);
}

function assertFinalAnswer(messages, order, answer) {
  const saved = messages.filter((message) => message.id === order.messageId);
  assert.equal(saved.length, 1);
  assert.ok(
    saved[0].content.some(
      (item) =>
        item.type === "text" && item.text === answer && item.streaming !== true,
    ),
  );
}

export async function actualTaskClient({
  page,
  fixture,
  projectId,
  workerId,
  startWorker,
  stopWorker,
  result,
  requests,
  taskOutcomeOrder,
}) {
  const model = await taskModelProvider();
  const brief = "Private full-worker direct Task brief 🍄";
  const answer = "Private full-worker direct Task answer 🌲";
  try {
    await page.evaluate(() => window.folderLive.start());
    await startWorker();
    await page.evaluate(
      async ({ workerId, baseUrl, nativeModel }) => {
        const models = await import("/src/lib/api/models.ts");
        const settings = await import("/src/lib/api/settings.ts");
        const workers = await import("/src/lib/api/worker-wire.ts");
        const encryption = await import("/src/lib/task-worker-encryption.ts");
        const provider = await models.createModelProvider({
          name: "Disposable Task provider",
          kind: "openai-compatible",
          baseUrl,
          apiKey: null,
        });
        const profile = await models.createModelProfile({
          name: "Disposable Task model",
          routes: [
            { providerId: provider.id, modelName: nativeModel, enabled: true },
          ],
        });
        await settings.updateSettings({
          defaultModelId: profile.id,
          autoNameTasks: false,
          autoNameChats: false,
        });
        await encryption.ensureTaskWorkerEncryption({
          worker: (await workers.getWorkers()).find(
            (worker) => worker.workerId === workerId,
          ),
        });
      },
      { workerId, baseUrl: model.baseUrl, nativeModel: model.model },
    );
    const created = await page.evaluate(
      async ({ projectId, brief }) => {
        const api = await import("/src/lib/api/tasks.ts");
        const created = await api.createTask(
          projectId,
          "Private actual direct Task",
        );
        const task = await api.updateTaskDraft(created.chat.id, {
          rowVersion: created.task.rowVersion,
          briefMarkdown: brief,
        });
        window.folderLive.retainScope({
          kind: "chat",
          chatId: created.chat.id,
        });
        return { chat: created.chat, task };
      },
      { projectId, brief },
    );
    assert.equal(created.task.briefMarkdown, brief);
    assert.equal(created.task.state, "draft");
    const readChatMessages = (chatId) =>
      page.evaluate(
        async (chat) =>
          (await import("/src/lib/api/chats.ts")).getMessages(chat),
        chatId,
      );
    const readMessages = () => readChatMessages(created.chat.id);
    const forceRoundOrder = taskOutcomeOrder?.kind === "round";
    const forceGoalOrder = taskOutcomeOrder?.kind === "goal";
    const reply = model.reply({ text: answer, hold: forceRoundOrder });
    const admitted = await page.evaluate(
      async ({ chatId, rowVersion }) => {
        return (await import("/src/lib/api/tasks.ts")).startTaskDirectly(
          chatId,
          { rowVersion, operationId: crypto.randomUUID() },
        );
      },
      { chatId: created.chat.id, rowVersion: created.task.rowVersion },
    );
    assert.equal(admitted.dispatch.state, "queued");
    assert.equal(admitted.dispatch.operationKind, "direct");
    assert.equal(admitted.state, created.task.state);
    assert.equal(admitted.rowVersion, created.task.rowVersion);
    if (forceRoundOrder)
      await verifyOutcomeOrdering(
        () => readMessages(),
        reply,
        answer,
        taskOutcomeOrder.file,
        result,
        "taskRoundOutcomeOrder",
      );
    const readTask = () =>
      page.evaluate(
        async (chat) => (await import("/src/lib/api/tasks.ts")).getTask(chat),
        created.chat.id,
      );
    const completed = await eventually(readTask, (task) =>
      assert.equal(task.state, "complete"),
    );
    assert.equal(completed.briefMarkdown, brief);
    assert.equal(completed.activeOperationId, null);
    assert.equal(reply.entered, true);
    assert.equal(reply.request.completed, true);
    assert.deepEqual(model.failures, []);
    const messages = await readMessages();
    assert.ok(
      JSON.stringify(messages).includes(answer),
      "the existing browser decrypts the actual native Task response",
    );
    if (forceRoundOrder) {
      assertFinalAnswer(messages, result.taskRoundOutcomeOrder, answer);
      result.steps.push(
        "the durable round outcome commits ahead of the final stream event and preserves the finished response after the provisional event is replayed",
      );
    }
    const dashboard = await page.evaluate(
      async (chat) =>
        (await import("/src/lib/api/tasks.ts")).getTaskImplementationDashboard(
          chat,
        ),
      created.chat.id,
    );
    assert.equal(dashboard.task.state, "complete");
    assert.equal(dashboard.placement.kind, "folder");
    assert.equal(dashboard.goal, null);
    result.steps.push(
      "existing browser creates and encrypts a Task, the full worker executes it through real Codex, and browser APIs decrypt its result and dashboard",
    );
    const planned = await page.evaluate(async (projectId) => {
      const api = await import("/src/lib/api/tasks.ts");
      const created = await api.createTask(
        projectId,
        "Private actual Goal Task",
      );
      const task = await api.updateTaskDraft(created.chat.id, {
        rowVersion: created.task.rowVersion,
        briefMarkdown: "Private full-worker planning brief 🍄",
        planGoalEnabled: true,
      });
      window.folderLive.retainScope({ kind: "chat", chatId: created.chat.id });
      return { chat: created.chat, task };
    }, projectId);
    const planText = "Private full-worker implementation plan 🌲";
    model.reply({
      text: JSON.stringify({ planMarkdown: planText, questions: [] }),
    });
    await page.evaluate(
      async ({ chatId, rowVersion }) =>
        (await import("/src/lib/api/tasks.ts")).startTaskPlanning(chatId, {
          rowVersion,
          operationId: crypto.randomUUID(),
        }),
      { chatId: planned.chat.id, rowVersion: planned.task.rowVersion },
    );
    const review = await eventually(
      () =>
        page.evaluate(
          async (chat) => (await import("/src/lib/api/tasks.ts")).getTask(chat),
          planned.chat.id,
        ),
      (task) => {
        assert.equal(task.state, "review");
        assert.equal(task.dispatch?.state, "succeeded");
      },
    );
    assert.equal(review.planMarkdown, planText);
    assert.equal(review.planningRound, 1);
    const objective = "Private full-worker implementation objective 🌙";
    model.reply({
      text: JSON.stringify({
        finalPlanMarkdown: planText,
        goalPrompt: objective,
      }),
    });
    const initialGoalAnswer = "Private initial Task Goal turn 🍄";
    const implementationAnswer = "Private full-worker implementation result 🌤";
    const firstTurn =
      forceGoalOrder || process.argv.includes("--task-goal-autonomous")
        ? model.reply({ text: initialGoalAnswer, hold: forceGoalOrder })
        : null;
    model.reply({
      calls: [{ name: "update_goal", arguments: { status: "complete" } }],
    });
    const implementation = model.reply({
      text: implementationAnswer,
    });
    // Goal activation attempts an idle turn. The saved encrypted Task control
    // can arrive first and make that automatic turn unnecessary.
    model.reply({
      text: implementationAnswer,
      onlyFor: (request) => JSON.stringify(request.input).includes(objective),
    });
    await page.evaluate(
      async ({ chatId, rowVersion }) =>
        (await import("/src/lib/api/tasks.ts")).beginTaskImplementation(
          chatId,
          { rowVersion, operationId: crypto.randomUUID() },
        ),
      { chatId: planned.chat.id, rowVersion: review.rowVersion },
    );
    if (forceGoalOrder)
      await verifyOutcomeOrdering(
        () => readChatMessages(planned.chat.id),
        firstTurn,
        initialGoalAnswer,
        taskOutcomeOrder.file,
        result,
        "taskGoalOutcomeOrder",
      );
    const goalTask = await eventually(
      () =>
        page.evaluate(
          async (chat) => (await import("/src/lib/api/tasks.ts")).getTask(chat),
          planned.chat.id,
        ),
      (task) => assert.equal(task.state, "complete"),
    );
    await eventually(
      () =>
        page.evaluate(
          async (project) =>
            (await import("/src/lib/api/chats.ts")).getChats(project),
          projectId,
        ),
      (chats) =>
        assert.equal(
          chats.find((chat) => chat.id === planned.chat.id)?.status,
          "idle",
        ),
    );
    assert.equal(goalTask.finalPlanMarkdown, planText);
    assert.ok(
      goalTask.goalPrompt.startsWith(
        "# Cantrip Task implementation objective\n",
      ),
    );
    assert.ok(goalTask.goalPrompt.endsWith(objective));
    if (firstTurn) assert.equal(firstTurn.request?.completed, true);
    assert.equal(implementation.request.completed, true);
    const nativeGoal = implementation.request.input.input
      .filter((item) => item.type === "function_call_output")
      .map((item) => JSON.parse(item.output))
      .find((item) => item.goal?.status === "complete");
    assert.ok(
      nativeGoal,
      "the actual Codex Goal tool completes the implementation Goal",
    );
    const { openedGoal, lookupConflicts } = await page.evaluate(
      async ({ chat, ordered }) => {
        const { getChatGoal } = await import("/src/lib/api/chats.ts");
        if (!ordered)
          return { openedGoal: await getChatGoal(chat), lookupConflicts: 0 };
        // The normal browser Goal query retries twice. The forced receipt
        // replay can overlap its passive native observation.
        const { chatGoalQueryOptions } =
          await import("/src/lib/chat-goal-query.ts");
        const { retry } = chatGoalQueryOptions(chat, "idle");
        let lookupConflicts = 0;
        for (;;) {
          try {
            return { openedGoal: await getChatGoal(chat), lookupConflicts };
          } catch (error) {
            if (error.status !== 409 || lookupConflicts >= retry) throw error;
            const delay = 1000 * 2 ** lookupConflicts++;
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      },
      { chat: planned.chat.id, ordered: forceGoalOrder },
    );
    if (forceGoalOrder) result.taskGoalLookupConflicts = lookupConflicts;
    assert.equal(openedGoal.goal.status, "complete");
    assert.ok(nativeGoal.goal.objective.startsWith(goalTask.goalPrompt));
    assert.equal(openedGoal.goal.objective, nativeGoal.goal.objective);
    assert.ok(openedGoal.goal.objective.includes(objective));
    assert.ok(openedGoal.goal.objective.includes("implementation-plan.md"));
    const goalDashboard = await page.evaluate(
      async (chat) =>
        (await import("/src/lib/api/tasks.ts")).getTaskImplementationDashboard(
          chat,
        ),
      planned.chat.id,
    );
    assert.equal(goalDashboard.task.state, "complete");
    assert.equal(goalDashboard.goal.status, "complete");
    assert.equal(goalDashboard.goal.objective, openedGoal.goal.objective);
    assert.equal(goalDashboard.placement.kind, "folder");
    const goalMessages = await page.evaluate(
      async (chat) => (await import("/src/lib/api/chats.ts")).getMessages(chat),
      planned.chat.id,
    );
    assert.ok(JSON.stringify(goalMessages).includes(implementationAnswer));
    if (forceGoalOrder) {
      assertFinalAnswer(
        goalMessages,
        result.taskGoalOutcomeOrder,
        initialGoalAnswer,
      );
      result.steps.push(
        "the durable Goal input outcome commits ahead of the final stream event and retains the finished answer",
      );
    }
    if (firstTurn) {
      for (const text of [initialGoalAnswer, implementationAnswer])
        assert.equal(
          goalMessages.filter((message) =>
            JSON.stringify(message).includes(text),
          ).length,
          1,
        );
      result.steps.push(
        "an autonomous continuation completes the active Task and preserves each encrypted turn exactly once",
      );
    }
    assert.deepEqual(model.failures, []);
    result.steps.push(
      "the existing Task APIs plan, review and finalize through real Codex; its native Goal tool completes implementation and the browser decrypts the objective and transcript",
    );
    await stopWorker();
    const inferenceBeforeRestart = structuredClone(
      model.requests.filter((request) => request.method === "POST"),
    );
    assert.ok(
      inferenceBeforeRestart.every((request) => request.completed),
      "Task inference completes before restarting its server and worker",
    );
    result.taskInferenceBeforeRestart = {
      postRequests: inferenceBeforeRestart.length,
    };
    const port = Number(new URL(fixture.server.origin).port);
    await fixture.close();
    await fixture.start({ port });
    assert.equal((await readTask()).state, "complete");
    assert.deepEqual(await readMessages(), messages);
    await startWorker();
    assert.equal((await readTask()).briefMarkdown, brief);
    assert.deepEqual(await readMessages(), messages);
    assert.deepEqual(
      model.requests.filter((request) => request.method === "POST"),
      inferenceBeforeRestart,
      "restart does not repeat completed Task inference",
    );
    await page.evaluate(async (workerId) => {
      const workers = await import("/src/lib/api/worker-wire.ts");
      await (
        await import("/src/lib/task-worker-encryption.ts")
      ).ensureTaskWorkerEncryption({
        worker: (await workers.getWorkers()).find(
          (worker) => worker.workerId === workerId,
        ),
      });
    }, workerId);
    const retainedGoal = await page.evaluate(
      async (chat) => (await import("/src/lib/api/chats.ts")).getChatGoal(chat),
      planned.chat.id,
    );
    assert.equal(retainedGoal.goal.status, "complete");
    assert.equal(retainedGoal.goal.objective, openedGoal.goal.objective);
    assert.equal(retainedGoal.goal.threadId, openedGoal.goal.threadId);
    assert.deepEqual(
      await page.evaluate(
        async (chat) =>
          (await import("/src/lib/api/chats.ts")).getMessages(chat),
        planned.chat.id,
      ),
      goalMessages,
    );
    const recovery = await actualTaskRecovery({
      page,
      fixture,
      projectId,
      workerId,
      startWorker,
      stopWorker,
      model,
      result,
    });
    for (const marker of [
      brief,
      answer,
      planText,
      objective,
      initialGoalAnswer,
      implementationAnswer,
      ...recovery.privateMarkers,
    ]) {
      assert.equal(
        JSON.stringify(requests).includes(marker),
        false,
        "private Task content stays out of browser-to-server requests",
      );
      assert.equal(
        fixture.server.diagnostics().includes(marker),
        false,
        "private Task content stays out of server diagnostics",
      );
    }
    result.steps.push(
      "completed encrypted Task and transcript survive both server and full-worker restart without duplicate inference",
    );
    result.taskExecution = {
      completed: true,
      plannedGoalCompleted: true,
      failedOperationRetried: recovery.failedOperationRetried,
      pausedAdmissionRecovered: recovery.pausedAdmissionRecovered,
      modelRequests: model.requests.filter(
        (request) => request.method === "POST",
      ).length,
      modelFailures: model.failures,
      chatId: created.chat.id,
    };
  } catch (error) {
    result.taskFailure = { message: error.message, stack: error.stack };
    if (fixture.liveSqlFixture) {
      try {
        result.taskRuntimeSnapshot = await captureTaskRuntimeState({
          ownerId: await page.evaluate(() => window.folderIdentity.ownerId),
          projectId,
          query: (statements, queries) =>
            browserFixtureSql(fixture, page, statements, queries),
        });
      } catch (snapshotError) {
        result.taskRuntimeSnapshotFailure = {
          message: snapshotError.message,
          stack: snapshotError.stack,
        };
      }
      if (result.taskRuntimeSnapshot) {
        try {
          // Only predefined disposable Task content is decrypted here. Keep
          // the original failure and database snapshot before observing the
          // existing browser's view of each retained Task error/transcript.
          result.taskFailureMessages = await page.evaluate(
            async (chatIds) => {
              const { getMessages } = await import("/src/lib/api/chats.ts");
              return Promise.all(
                chatIds.map(async (chatId) => ({
                  chatId,
                  messages: await getMessages(chatId),
                })),
              );
            },
            result.taskRuntimeSnapshot.rows.tasks.map((task) => task.chat_id),
          );
        } catch (cause) {
          result.taskFailureMessagesError = cause.message;
        }
      }
    }
    throw error;
  } finally {
    result.taskModel = {
      failures: model.failures,
      requests: model.requests.map(({ method, path, completed, input }) => ({
        method,
        path,
        completed,
        model: input?.model,
        format: input?.text?.format,
        toolResults: input?.input?.filter(
          (item) => item.type === "function_call_output",
        ),
      })),
    };
    await stopWorker();
    await model.close();
  }
}
