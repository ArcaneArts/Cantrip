// Browser SDK -> server -> full worker -> bundled Codex -> local model HTTP.
// No worker handler, native RPC, encrypted operation or repository is replaced.
import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";
import { taskModelProvider } from "./task-model-provider.mjs";
import { actualTaskRecovery } from "./actual-task-recovery.mjs";
import { captureTaskRuntimeState } from "./task-runtime-snapshot.mjs";

export async function actualTaskClient({
  page,
  fixture,
  projectId,
  workerId,
  startWorker,
  stopWorker,
  result,
  requests,
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
    const reply = model.reply({ text: answer });
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
    const readMessages = () =>
      page.evaluate(
        async (chat) =>
          (await import("/src/lib/api/chats.ts")).getMessages(chat),
        created.chat.id,
      );
    const messages = await readMessages();
    assert.ok(
      JSON.stringify(messages).includes(answer),
      "the existing browser decrypts the actual native Task response",
    );
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
    model.reply({
      calls: [{ name: "update_goal", arguments: { status: "complete" } }],
    });
    const implementation = model.reply({
      text: "Private full-worker implementation result 🌤",
    });
    // Goal activation attempts an idle turn. The saved encrypted Task control
    // can arrive first and make that automatic turn unnecessary.
    model.reply({ text: "Private full-worker implementation result 🌤" });
    await page.evaluate(
      async ({ chatId, rowVersion }) =>
        (await import("/src/lib/api/tasks.ts")).beginTaskImplementation(
          chatId,
          { rowVersion, operationId: crypto.randomUUID() },
        ),
      { chatId: planned.chat.id, rowVersion: review.rowVersion },
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
    assert.equal(implementation.request.completed, true);
    const nativeGoal = implementation.request.input.input
      .filter((item) => item.type === "function_call_output")
      .map((item) => JSON.parse(item.output))
      .find((item) => item.goal?.status === "complete");
    assert.ok(
      nativeGoal,
      "the actual Codex Goal tool completes the implementation Goal",
    );
    const openedGoal = await page.evaluate(
      async (chat) => (await import("/src/lib/api/chats.ts")).getChatGoal(chat),
      planned.chat.id,
    );
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
    assert.ok(
      JSON.stringify(goalMessages).includes(
        "Private full-worker implementation result 🌤",
      ),
    );
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
            page.evaluate(
              async ({ statements, queries }) => {
                const response = await window.folderRequest("/__fixture/sql", {
                  method: "POST",
                  body: JSON.stringify({ statements, queries }),
                  signal: AbortSignal.timeout(15000),
                });
                if (response.ok !== true)
                  throw new Error("Live Task snapshot query failed");
                return response.values;
              },
              { statements, queries },
            ),
        });
      } catch (snapshotError) {
        result.taskRuntimeSnapshotFailure = {
          message: snapshotError.message,
          stack: snapshotError.stack,
        };
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
