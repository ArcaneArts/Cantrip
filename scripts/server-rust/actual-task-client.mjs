// Browser SDK -> server -> full worker -> bundled Codex -> local model HTTP.
// No worker handler, native RPC, encrypted operation or repository is replaced.
import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";
import { taskModelProvider } from "./task-model-provider.mjs";

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
    await startWorker();
    await page.evaluate(
      async ({ workerId, baseUrl, nativeModel }) => {
        const models = await import("/src/lib/api/models.ts");
        const settings = await import("/src/lib/api/settings.ts");
        const workers = await import("/src/lib/api/workers.ts");
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
    assert.ok(["implementing", "complete"].includes(admitted.state));
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
    await stopWorker();
    const port = Number(new URL(fixture.server.origin).port);
    await fixture.close();
    await fixture.start({ port });
    assert.equal((await readTask()).state, "complete");
    assert.deepEqual(await readMessages(), messages);
    await startWorker();
    assert.equal((await readTask()).briefMarkdown, brief);
    assert.deepEqual(await readMessages(), messages);
    assert.equal(
      model.requests.filter((request) => request.method === "POST").length,
      1,
      "restart does not repeat completed Task inference",
    );
    for (const marker of [brief, answer]) {
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
      modelRequests: model.requests.filter(
        (request) => request.method === "POST",
      ).length,
      modelFailures: model.failures,
      chatId: created.chat.id,
    };
  } finally {
    await stopWorker();
    await model.close();
  }
}
