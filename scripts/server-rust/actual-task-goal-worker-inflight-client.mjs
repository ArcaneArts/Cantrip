// Existing encrypted Task/Goal APIs, full worker and actual native Goal tools.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadStoredWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { taskModelProvider } from "./task-model-provider.mjs";
import { eventually } from "./full-worker.mjs";

export async function actualTaskGoalWorkerInflightClient({
  fixture,
  page,
  projectId,
  workerId,
  dataDirectory,
  getWorker,
  startWorker,
  stopWorker,
  crashWorker,
  requests,
  result,
}) {
  const model = await taskModelProvider({ observeStreams: true });
  const report = (result.taskGoalWorkerInflight = { observations: [] });
  const brief = "Private worker-loss Goal brief " + randomUUID() + " 🌲";
  const plan = "Private retained Goal implementation plan " + randomUUID();
  const objective = "Private retained Goal objective " + randomUUID() + " 🌙";
  const answer = "Private recovered Goal answer " + randomUUID() + " 🍄";
  const operationId = randomUUID();
  const posts = () => model.requests.filter((r) => r.method === "POST");
  const workerOrigin = () => (fixture.workerFixture ?? fixture).server.origin;
  let original,
    resumed,
    allowedPosts = 3;
  try {
    await page.evaluate(() => window.folderLive.start());
    await startWorker();
    await page.evaluate(
      async ({ workerId, baseUrl, nativeModel }) => {
        const models = await import("/src/lib/api/models.ts");
        const provider = await models.createModelProvider({
          name: "Disposable worker-loss Goal provider",
          kind: "openai-compatible",
          baseUrl,
          apiKey: null,
        });
        const profile = await models.createModelProfile({
          name: "Disposable worker-loss Goal model",
          routes: [
            { providerId: provider.id, modelName: nativeModel, enabled: true },
          ],
        });
        await (
          await import("/src/lib/api/settings.ts")
        ).updateSettings({
          defaultModelId: profile.id,
          autoNameChats: false,
          autoNameTasks: false,
        });
        const worker = (await window.folderWorkers.getWorkers()).find(
          (w) => w.workerId === workerId,
        );
        await (
          await import("/src/lib/task-worker-encryption.ts")
        ).ensureTaskWorkerEncryption({ worker });
      },
      { workerId, baseUrl: model.baseUrl, nativeModel: model.model },
    );
    const created = await page.evaluate(
      async ({ projectId, brief }) => {
        const api = await import("/src/lib/api/tasks.ts");
        const created = await api.createTask(
          projectId,
          "Private worker-loss Goal Task",
        );
        const task = await api.updateTaskDraft(created.chat.id, {
          rowVersion: created.task.rowVersion,
          briefMarkdown: brief,
          planGoalEnabled: true,
        });
        window.folderLive.retainScope({
          kind: "chat",
          chatId: created.chat.id,
        });
        return { chatId: created.chat.id, task };
      },
      { projectId, brief },
    );
    report.chatId = created.chatId;
    const task = async () => {
      const value = await page.evaluate(
        async (id) => (await import("/src/lib/api/tasks.ts")).getTask(id),
        created.chatId,
      );
      assert.ok(
        posts().length <= allowedPosts,
        "Goal recovery may not replay Task planning or finalization",
      );
      if (
        JSON.stringify(report.observations.at(-1)?.task) !==
        JSON.stringify(value)
      )
        report.observations.push({ at: Date.now(), task: value });
      return value;
    };
    const goal = () =>
      page.evaluate(
        async (id) => (await import("/src/lib/api/chats.ts")).getChatGoal(id),
        created.chatId,
      );
    const messages = async () => {
      const value = await page.evaluate(
        async (id) => (await import("/src/lib/api/chats.ts")).getMessages(id),
        created.chatId,
      );
      report.lastMessages = value;
      return value;
    };

    model.reply({
      text: JSON.stringify({ planMarkdown: plan, questions: [] }),
    });
    await page.evaluate(
      async ({ chatId, rowVersion }) =>
        (await import("/src/lib/api/tasks.ts")).startTaskPlanning(chatId, {
          rowVersion,
          operationId: crypto.randomUUID(),
        }),
      { chatId: created.chatId, rowVersion: created.task.rowVersion },
    );
    const review = await eventually(task, (value) =>
      assert.equal(value.state, "review"),
    );
    assert.equal(review.planMarkdown, plan);
    model.reply({
      text: JSON.stringify({ finalPlanMarkdown: plan, goalPrompt: objective }),
    });
    original = model.reply({
      text: "Private interrupted Goal output " + randomUUID(),
      hold: true,
    });
    await page.evaluate(
      async ({ chatId, rowVersion, operationId }) =>
        (await import("/src/lib/api/tasks.ts")).beginTaskImplementation(
          chatId,
          { rowVersion, operationId },
        ),
      { chatId: created.chatId, rowVersion: review.rowVersion, operationId },
    );
    await eventually(
      () => original.entered,
      (entered) => assert.equal(entered, true),
    );
    const implementing = await eventually(task, (value) =>
      assert.equal(value.state, "implementing"),
    );
    const activeGoal = await eventually(goal, (value) =>
      assert.equal(value.goal?.status, "active"),
    );
    const oldWorker = getWorker();
    const credential = loadStoredWorkerCredential(
      dataDirectory,
      workerOrigin(),
    );
    report.beforeCrash = {
      workerPid: oldWorker.child.pid,
      task: implementing,
      goal: activeGoal,
      messages: await messages(),
      modelPosts: posts().length,
    };
    const before = report.beforeCrash;
    assert.equal(before.task.state, "implementing");
    assert.equal(before.task.dispatch.operationId, operationId);
    assert.equal(before.task.finalPlanMarkdown, plan);
    assert.ok(before.task.goalPrompt.endsWith(objective));
    assert.equal(before.goal.goal.status, "active");
    assert.ok(before.goal.goal.objective.includes(objective));
    assert.equal(before.modelPosts, 3);
    assert.equal(original.request.completed, false);
    assert.equal(original.request.closed, false);
    await crashWorker();
    await eventually(
      () => original.request.closed,
      (closed) => assert.equal(closed, true),
    );
    assert.equal(original.request.completed, false);
    original.release();

    // An already-authorized native Goal can continue automatically or after
    // the existing explicit Recovery control. Hold that one continuation until
    // the control has returned, preserving the actual Goal tool handshake.
    resumed = model.reply({
      hold: true,
      calls: [{ name: "update_goal", arguments: { status: "complete" } }],
    });
    const finalAnswer = model.reply({ text: answer });
    model.reply({
      text: "Private Goal activation acknowledgment " + randomUUID(),
      onlyFor: (request) => JSON.stringify(request.input).includes(objective),
    });
    allowedPosts = 4;
    await startWorker();
    report.replacementWorkerPid = getWorker().child.pid;
    assert.notEqual(report.replacementWorkerPid, before.workerPid);
    assert.deepEqual(
      loadStoredWorkerCredential(dataDirectory, workerOrigin()),
      credential,
    );
    report.afterReconnect = {
      task: await task(),
      goal: await eventually(
        async () => {
          const observed = await page.evaluate(async (id) => {
            try {
              return {
                value: await (
                  await import("/src/lib/api/chats.ts")
                ).getChatGoal(id),
              };
            } catch (error) {
              if (error.status !== 409) throw error;
              return {
                conflict: { status: error.status, message: error.message },
              };
            }
          }, created.chatId);
          if (observed.conflict)
            (report.goalObservationConflicts ??= []).push({
              at: Date.now(),
              ...observed.conflict,
            });
          return observed.value;
        },
        (value) => assert.ok(value?.goal),
      ),
      modelPosts: posts().length,
    };
    report.recovery = await page.evaluate(async (id) => {
      try {
        return {
          ok: true,
          task: await (
            await import("/src/lib/api/tasks.ts")
          ).recoverTaskImplementation(id),
        };
      } catch (error) {
        return { ok: false, status: error.status, message: error.message };
      }
    }, created.chatId);
    assert.equal(report.recovery.ok, true, JSON.stringify(report.recovery));
    const expiry = Date.parse(before.task.dispatch.leaseExpiresAt);
    await eventually(
      async () => {
        await task();
        return resumed.entered;
      },
      (entered) => assert.equal(entered, true),
      Number.isFinite(expiry)
        ? Math.max(60000, expiry + 30000 - Date.now())
        : 150000,
    );
    report.beforeCompletion = {
      task: await task(),
      goal: await goal(),
      modelPosts: posts().length,
    };
    assert.equal(
      report.beforeCompletion.task.dispatch.operationId,
      operationId,
    );
    assert.equal(report.beforeCompletion.task.finalPlanMarkdown, plan);
    assert.equal(
      report.beforeCompletion.task.goalPrompt,
      before.task.goalPrompt,
    );
    assert.equal(
      report.beforeCompletion.goal.goal.threadId,
      before.goal.goal.threadId,
    );
    assert.equal(
      report.beforeCompletion.goal.goal.objective,
      before.goal.goal.objective,
    );
    assert.ok(JSON.stringify(resumed.request.input).includes(objective));
    allowedPosts = 6;
    resumed.release();
    let completed = await eventually(
      task,
      (value) => {
        assert.equal(value.state, "complete");
        assert.equal(value.dispatch.state, "succeeded");
      },
      90000,
    );
    report.completedCandidate = { task: completed, goal: await goal() };
    const transcript = await eventually(messages, (values) =>
      assert.equal(
        values
          .flatMap((m) => m.content)
          .filter((i) => i.type === "text" && i.text === answer).length,
        1,
      ),
    );
    await eventually(
      () =>
        page.evaluate(
          async (id) => (await import("/src/lib/api/chats.ts")).getChats(id),
          projectId,
        ),
      (chats) =>
        assert.equal(
          chats.find((c) => c.id === created.chatId)?.status,
          "idle",
        ),
    );
    const completedGoal = await goal();
    // Goal reads synchronize its protected Task projection. Snapshot the Task
    // after those actual writes, then require exact persistence over restart.
    completed = await task();
    report.completed = {
      task: completed,
      goal: completedGoal,
      messages: transcript,
      modelPosts: posts().length,
    };
    assert.equal(completed.dispatch.id, before.task.dispatch.id);
    assert.equal(completed.dispatch.operationId, operationId);
    assert.equal(completed.planningRound, before.task.planningRound);
    assert.equal(completed.finalPlanMarkdown, plan);
    assert.equal(completed.goalPrompt, before.task.goalPrompt);
    assert.equal(completedGoal.goal.status, "complete");
    for (const field of ["threadId", "objective", "createdAt", "tokenBudget"])
      assert.deepEqual(
        completedGoal.goal[field],
        before.goal.goal[field],
        field,
      );
    assert.ok(completedGoal.goal.tokensUsed >= before.goal.goal.tokensUsed);
    assert.ok(
      completedGoal.goal.timeUsedSeconds >= before.goal.goal.timeUsedSeconds,
    );
    for (const message of before.messages.filter((m) => m.role === "user"))
      assert.deepEqual(
        transcript.find((m) => m.id === message.id),
        message,
      );
    assert.equal(finalAnswer.request.completed, true);
    const nativeComplete = finalAnswer.request.input.input
      .filter((i) => i.type === "function_call_output")
      .map((i) => JSON.parse(i.output))
      .find((i) => i.goal?.status === "complete");
    assert.ok(
      nativeComplete,
      "the resumed actual native Goal tool establishes completion",
    );
    assert.ok([5, 6].includes(posts().length));
    assert.deepEqual(model.failures, []);
    report.serverDiagnosticsBeforeRestart = fixture.server.diagnostics();
    await stopWorker();
    report.restart = await fixture.restart();
    await startWorker();
    assert.deepEqual(await task(), completed);
    assert.deepEqual(await goal(), completedGoal);
    assert.deepEqual(await messages(), transcript);
    for (const marker of [brief, plan, objective, answer]) {
      assert.equal(JSON.stringify(requests).includes(marker), false);
      assert.equal(
        report.serverDiagnosticsBeforeRestart.includes(marker),
        false,
      );
      assert.equal(fixture.server.diagnostics().includes(marker), false);
    }
    report.summary = {
      workerKilled: true,
      originalStreamClosedWithoutCompletion: true,
      credentialRetained: true,
      explicitRecoveryAccepted: true,
      originalTaskOperationRetained: true,
      nativeGoalCompleted: true,
      originalGoalIdentityRetained: true,
      originalUserMessagesRetained: true,
      singlePublishedAnswer: true,
      boundedModelPosts: true,
      historyRetainedAfterRestart: true,
    };
    result.steps.push(
      "actual worker loss during an active Task Goal preserves its original operation, objective and messages, recovers through the existing control and native Goal tool, and retains exact completed history after restart",
    );
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    original?.release();
    resumed?.release();
    report.model = { requests: model.requests, failures: model.failures };
    try {
      await stopWorker();
    } finally {
      await model.close();
    }
  }
}
