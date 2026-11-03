// Existing browser controls and full worker execution at real failure boundaries.
import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";

export async function actualTaskRecovery({
  page,
  fixture,
  projectId,
  workerId,
  startWorker,
  stopWorker,
  model,
  result,
}) {
  const privateError = "Private quota exceeded for Task recovery 🌧";
  const privateAnswer = "Private explicit Task retry completed 🌈";
  const create = (title) =>
    page.evaluate(
      async ({ projectId, title }) => {
        const api = await import("/src/lib/api/tasks.ts");
        const created = await api.createTask(projectId, title);
        const task = await api.updateTaskDraft(created.chat.id, {
          rowVersion: created.task.rowVersion,
          briefMarkdown: title,
        });
        window.folderLive.retainScope({
          kind: "chat",
          chatId: created.chat.id,
        });
        return { chat: created.chat, task };
      },
      { projectId, title },
    );
  const observations = (result.taskRecoveryObservations = []);
  let previousSnapshot;
  const read = async (chatId) => {
    const task = await page.evaluate(
      async (chatId) => (await import("/src/lib/api/tasks.ts")).getTask(chatId),
      chatId,
    );
    // Retain public state transitions even when the existing assertion times
    // out. Never include decrypted briefs, plans, transcripts or error text.
    const snapshot = {
      chatId,
      state: task.state,
      rowVersion: task.rowVersion,
      activeOperationId: task.activeOperationId,
      dispatch: task.dispatch
        ? {
            state: task.dispatch.state,
            operationKind: task.dispatch.operationKind,
          }
        : null,
      automaticRetry: task.automaticRetry,
      lastError: task.lastError
        ? {
            code: task.lastError.code,
            operationKind: task.lastError.operationKind,
            occurredAt: task.lastError.occurredAt,
          }
        : null,
    };
    const signature = JSON.stringify(snapshot);
    const observedAt = Date.now();
    if (signature === previousSnapshot) {
      const previous = observations.at(-1);
      previous.reads++;
      previous.lastObservedAt = observedAt;
    } else {
      observations.push({
        ...snapshot,
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
        reads: 1,
      });
      previousSnapshot = signature;
    }
    return task;
  };
  const start = (created) =>
    page.evaluate(
      async ({ chat, task }) =>
        (await import("/src/lib/api/tasks.ts")).startTaskDirectly(chat.id, {
          rowVersion: task.rowVersion,
          operationId: crypto.randomUUID(),
        }),
      created,
    );
  const posts = () => model.requests.filter((r) => r.method === "POST").length;
  const before = posts();
  const failedTask = await create("Private failed Task brief 🌧");
  const rejected = model.reply({
    failure: { code: "insufficient_quota", message: privateError },
  });
  await start(failedTask);
  const failure = await eventually(
    () => read(failedTask.chat.id),
    (task) => {
      assert.equal(task.state, "failed");
      assert.equal(task.dispatch.state, "failed");
      assert.equal(task.automaticRetry?.status, "manual");
    },
  );
  assert.equal(rejected.entered, true);
  assert.equal(rejected.request.completed, true);
  assert.equal(failure.lastError.operationKind, "direct");
  assert.equal(failure.automaticRetry.failureKind, "usage-limit");
  assert.equal(JSON.stringify(failure).includes(privateError), false);
  const retried = model.reply({ text: privateAnswer });
  await page.evaluate(
    async ({ chatId, rowVersion }) =>
      (await import("/src/lib/api/tasks.ts")).retryTaskPlanning(chatId, {
        rowVersion,
        operationId: crypto.randomUUID(),
      }),
    { chatId: failedTask.chat.id, rowVersion: failure.rowVersion },
  );
  const recovered = await eventually(
    () => read(failedTask.chat.id),
    (task) => assert.equal(task.state, "complete"),
  );
  assert.equal(retried.request.completed, true);
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.briefMarkdown, failure.briefMarkdown);
  const transcript = await page.evaluate(
    async (chatId) =>
      (await import("/src/lib/api/chats.ts")).getMessages(chatId),
    failedTask.chat.id,
  );
  assert.ok(JSON.stringify(transcript).includes(privateAnswer));
  assert.equal(
    posts(),
    before + 2,
    "one failed request and one explicit retry",
  );
  result.steps.push(
    "a real model quota failure remains opaque and requires manual retry; the existing browser retries the same Task and decrypts its completed result",
  );

  const setPause = (paused) =>
    page.evaluate(
      async ({ projectId, paused }) => {
        const api = await import("/src/lib/api/tasks.ts");
        const current = await api.getProjectTaskPauseState(projectId);
        return api.setProjectTaskPauseState(projectId, {
          paused,
          rowVersion: current.rowVersion,
        });
      },
      { projectId, paused },
    );
  assert.equal((await setPause(true)).paused, true);
  const queuedTask = await create("Private paused queued Task brief ❄");
  const admission = await start(queuedTask);
  assert.equal(admission.dispatch.state, "queued");
  const queued = await read(queuedTask.chat.id);
  assert.equal(queued.dispatch.state, "queued");
  assert.equal(posts(), before + 2);
  await stopWorker();
  const port = Number(new URL(fixture.server.origin).port);
  await fixture.close();
  await fixture.start({ port });
  await startWorker();
  await page.evaluate(async (workerId) => {
    const workers = await import("/src/lib/api/worker-wire.ts");
    await (
      await import("/src/lib/task-worker-encryption.ts")
    ).ensureTaskWorkerEncryption({
      worker: (await workers.getWorkers()).find((w) => w.workerId === workerId),
    });
  }, workerId);
  const retained = await read(queuedTask.chat.id);
  assert.equal(retained.dispatch.state, "queued");
  assert.equal(retained.dispatch.operationId, queued.dispatch.operationId);
  assert.equal(
    (
      await page.evaluate(
        async (projectId) =>
          (await import("/src/lib/api/tasks.ts")).getProjectTaskPauseState(
            projectId,
          ),
        projectId,
      )
    ).paused,
    true,
  );
  assert.equal(
    posts(),
    before + 2,
    "paused work stays unexecuted across restart",
  );
  const resumed = model.reply({ text: "Private queued Task resumed ☀" });
  assert.equal((await setPause(false)).paused, false);
  await eventually(
    () => read(queuedTask.chat.id),
    (task) => assert.equal(task.state, "complete"),
  );
  assert.equal(resumed.request.completed, true);
  assert.equal(
    posts(),
    before + 3,
    "unpause executes the saved admission once",
  );
  assert.equal((await read(failedTask.chat.id)).state, "complete");
  assert.deepEqual(
    await page.evaluate(
      async (chatId) =>
        (await import("/src/lib/api/chats.ts")).getMessages(chatId),
      failedTask.chat.id,
    ),
    transcript,
  );
  assert.deepEqual(model.failures, []);
  result.steps.push(
    "project pause retains an admitted Task across both server and worker restart; unpause executes it once and preserves the earlier retried Task transcript",
  );
  return {
    privateMarkers: [
      privateError,
      privateAnswer,
      queuedTask.task.briefMarkdown,
    ],
    failedOperationRetried: true,
    pausedAdmissionRecovered: true,
  };
}
