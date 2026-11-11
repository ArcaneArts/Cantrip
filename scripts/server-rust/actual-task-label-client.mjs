import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";
import { taskModelProvider } from "./task-model-provider.mjs";

export async function actualTaskLabelClient({
  fixture,
  page,
  projectId,
  workerId,
  startWorker,
  stopWorker,
  diagnostics,
  result,
}) {
  const model = await taskModelProvider();
  const brief = "Private orchard inventory request 🍏";
  const title = "Inventory orchard crates before winter harvest";
  const answer = "Private Task execution finished 🍂";
  const observation = (result.taskLabel = { phase: "configuration" });
  const taskApi = (operation, ...args) =>
    page.evaluate(
      async ({ operation, args }) =>
        (await import("/src/lib/api/tasks.ts"))[operation](...args),
      { operation, args },
    );
  const setProjectPause = (paused) =>
    page.evaluate(
      async ({ projectId, paused }) => {
        const tasks = await import("/src/lib/api/tasks.ts");
        const current = await tasks.getProjectTaskPauseState(projectId);
        return tasks.setProjectTaskPauseState(projectId, {
          paused,
          rowVersion: current.rowVersion,
        });
      },
      { projectId, paused },
    );
  const grantTask = () =>
    page.evaluate(async (workerId) => {
      const workers = await import("/src/lib/api/worker-wire.ts");
      const worker = (await workers.getWorkers()).find(
        (candidate) => candidate.workerId === workerId,
      );
      return (
        await import("/src/lib/task-worker-encryption.ts")
      ).ensureTaskWorkerEncryption({ worker });
    }, workerId);
  const posts = () => model.requests.filter(({ method }) => method === "POST");
  const waitForLabelRefresh = () =>
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith("/encryption/refresh") &&
        response.request().method() === "POST" &&
        response.request().postDataJSON()?.component ===
          "private-surface-metadata",
    );
  const readWorker = () =>
    page.evaluate(async (workerId) => {
      const workers = await import("/src/lib/api/worker-wire.ts");
      return (await workers.getWorkers()).find(
        (candidate) => candidate.workerId === workerId,
      );
    }, workerId);
  try {
    await page.evaluate(
      async ({ projectId, baseUrl, modelName }) => {
        const models = await import("/src/lib/api/models.ts");
        const settings = await import("/src/lib/api/settings.ts");
        const provider = await models.createModelProvider({
          name: "Disposable title inference provider",
          kind: "openai-compatible",
          baseUrl,
          apiKey: null,
        });
        const profile = await models.createModelProfile({
          name: "Disposable title inference model",
          routes: [{ providerId: provider.id, modelName, enabled: true }],
        });
        await settings.updateSettings({
          defaultModelId: profile.id,
          autoNameTasks: false,
        });
        window.folderLive.retainScope({ kind: "project", projectId });
      },
      { projectId, baseUrl: model.baseUrl, modelName: model.model },
    );
    const taskEncryption = await grantTask();
    assert.ok(
      !taskEncryption.grants.some(
        ({ component }) => component === "private-surface-metadata",
      ),
      "the fresh worker has no pre-existing private-label grant",
    );
    assert.equal((await setProjectPause(true)).paused, true);
    const { chat, task } = await taskApi("createTask", projectId, undefined);
    const readLabel = () =>
      page.evaluate(
        async ({ projectId, chatId }) => {
          const { chatTitleEncryption } =
            await import("/src/lib/chat-title-encryption.ts");
          const publicRows = await window.folderRequest(
            `/api/projects/${encodeURIComponent(projectId)}/chats`,
          );
          const wire = publicRows.find((row) => row.id === chatId);
          return { title: (await chatTitleEncryption.open(wire)).title, wire };
        },
        { projectId, chatId: chat.id },
      );
    const initial = await readLabel();
    assert.equal(initial.title, "New task");
    const draft = await taskApi("updateTaskDraft", chat.id, {
      rowVersion: task.rowVersion,
      briefMarkdown: brief,
    });
    assert.equal(draft.briefMarkdown, brief);
    await page.evaluate(async () =>
      (await import("/src/lib/api/settings.ts")).updateSettings({
        autoNameTasks: true,
      }),
    );
    const label = model.reply({
      text: `Title: ${title} immediately.\nNever use the second line.`,
      hold: true,
    });
    observation.phase = "label admission";
    const operationId = await page.evaluate(() => crypto.randomUUID());
    const worker = await readWorker();
    assert.equal(worker.online, true);
    const [grantRefresh, admitted] = await Promise.all([
      waitForLabelRefresh(),
      taskApi(
        "startTaskDirectly",
        chat.id,
        { operationId, rowVersion: draft.rowVersion },
        worker,
      ),
    ]);
    assert.equal(grantRefresh.status(), 200);
    assert.equal(admitted.dispatch.state, "queued");
    assert.equal(admitted.dispatch.operationId, operationId);
    await eventually(
      () => label.request,
      (request) => assert.ok(request, diagnostics()),
    );
    assert.equal(posts().length, 1);
    assert.deepEqual(label.request.input.tools, []);
    assert.equal(label.request.input.store, false);
    assert.deepEqual(
      label.request.input.input.map(({ role }) => role),
      ["developer", "user"],
    );
    const [instructions, input] = label.request.input.input;
    assert.match(instructions.content[0].text, /SIX WORDS/u);
    assert.deepEqual(
      input.content.map(({ text }) => JSON.parse(text)),
      [{ initialRequest: brief }],
    );
    assert.deepEqual(
      (await readLabel()).wire.titleProtection,
      initial.wire.titleProtection,
    );
    assert.equal((await taskApi("getTask", chat.id)).dispatch.state, "queued");
    const eventOffset = await page.evaluate(() => window.folderEvents.length);
    label.release();
    observation.phase = "label persistence";
    const saved = await eventually(readLabel, (current) =>
      assert.equal(current.title, title, diagnostics()),
    );
    assert.equal(label.request.completed, true);
    assert.equal(saved.wire.titleProtection.classification.recordKind, "chat");
    assert.ok(saved.wire.titleProtection.protectedLabel.envelope.ciphertext);
    assert.notDeepEqual(
      saved.wire.titleProtection,
      initial.wire.titleProtection,
    );
    assert.equal("title" in saved.wire, false);
    assert.ok(!JSON.stringify(saved.wire).includes(title));
    assert.equal(
      await page.evaluate(
        async ({ projectId, chatId }) => {
          const { getChats } = await import("/src/lib/api/chats.ts");
          return (await getChats(projectId)).find((row) => row.id === chatId)
            ?.title;
        },
        { projectId, chatId: chat.id },
      ),
      title,
    );
    const invalidation = await eventually(
      () =>
        page.evaluate(
          ({ eventOffset, chatId }) =>
            window.folderEvents
              .slice(eventOffset)
              .find(
                (event) =>
                  event.resource === "chat" &&
                  event.action === "invalidated" &&
                  event.entityId === chatId,
              ),
          { eventOffset, chatId: chat.id },
        ),
      (event) =>
        assert.ok(event, "generated label publishes a chat invalidation"),
    );
    assert.equal(invalidation.payload, null);
    const labelCompletions = (output) =>
      output
        .split("\n")
        .filter(
          (line) =>
            line.includes("event=worker.command.completed ") &&
            line.includes("operation=label.generate ") &&
            line.includes(`chatId=${chat.id} `),
        );
    const completed = await eventually(
      () => labelCompletions(diagnostics()),
      (events) => assert.equal(events.length, 1, diagnostics()),
    );
    for (const marker of [brief, title])
      assert.ok(!diagnostics().includes(marker));
    observation.phase = "retained restart";
    await page.evaluate(() => window.folderLive.stop());
    await stopWorker();
    const restart = await fixture.restart();
    assert.notEqual(restart.before.pid, restart.after.pid);
    const retained = await readLabel();
    assert.equal(retained.title, title);
    assert.deepEqual(retained.wire.titleProtection, saved.wire.titleProtection);
    await startWorker();
    await grantTask();
    const queued = await taskApi("getTask", chat.id);
    assert.equal(queued.dispatch.state, "queued");
    assert.equal(queued.dispatch.operationId, operationId);
    assert.equal(posts().length, 1);
    observation.phase = "Task execution";
    const resumed = model.reply({ text: answer });
    assert.equal((await setProjectPause(false)).paused, false);
    const finished = await eventually(
      () => taskApi("getTask", chat.id),
      (task) => assert.equal(task.state, "complete", diagnostics()),
    );
    assert.equal(finished.briefMarkdown, brief);
    assert.equal(resumed.request.completed, true);
    assert.equal(posts().length, 2);
    assert.deepEqual(model.failures, []);
    assert.deepEqual(
      (await readLabel()).wire.titleProtection,
      saved.wire.titleProtection,
    );
    assert.deepEqual(labelCompletions(diagnostics()), []);
    const messages = await page.evaluate(
      async (chatId) =>
        (await import("/src/lib/api/chats.ts")).getMessages(chatId),
      chat.id,
    );
    assert.ok(JSON.stringify(messages).includes(answer));

    observation.phase = "unavailable label grant";
    assert.equal((await setProjectPause(true)).paused, true);
    const planning = await taskApi(
      "createTask",
      projectId,
      "Manual planning title",
    );
    const planningDraft = await taskApi("updateTaskDraft", planning.chat.id, {
      rowVersion: planning.task.rowVersion,
      briefMarkdown: "Plan a separate orchard inventory.",
      planGoalEnabled: true,
    });
    const cachedWorker = await readWorker();
    assert.equal(cachedWorker.online, true);
    await stopWorker();
    await eventually(readWorker, (current) =>
      assert.equal(current.online, false),
    );
    const planningOperation = await page.evaluate(() => crypto.randomUUID());
    const [unavailable, planned] = await Promise.all([
      waitForLabelRefresh(),
      taskApi(
        "startTaskPlanning",
        planning.chat.id,
        {
          operationId: planningOperation,
          rowVersion: planningDraft.rowVersion,
        },
        cachedWorker,
      ),
    ]);
    assert.ok(unavailable.status() >= 400);
    assert.equal(planned.dispatch.state, "queued");
    assert.equal(planned.dispatch.operationId, planningOperation);
    assert.equal(planned.dispatch.operationKind, "initial-plan");
    assert.equal(posts().length, 2);

    Object.assign(observation, {
      phase: "complete",
      chatId: chat.id,
      operationId,
      label: saved.wire.titleProtection,
      workerCompletion: completed[0],
      invalidation,
      restart,
      grantRefreshStatus: grantRefresh.status(),
      unavailableGrantStatus: unavailable.status(),
      summary: {
        title: retained.title,
        taskState: finished.state,
        modelRequests: posts().length,
        exactLabelRetained: true,
        planningQueuedAfterGrantFailure: true,
      },
    });
    result.steps.push(
      "standalone encrypted Task title completes while execution is paused, survives restart, and the retained Task executes once on resume",
    );
  } finally {
    observation.model = { requests: model.requests, failures: model.failures };
    await model.close();
  }
}
