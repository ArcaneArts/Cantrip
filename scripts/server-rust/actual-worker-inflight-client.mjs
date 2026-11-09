// Existing encrypted Task APIs and full worker/native runtime at process loss.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { loadStoredWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { taskModelProvider } from "./task-model-provider.mjs";
import { eventually } from "./full-worker.mjs";

export async function actualWorkerInflightClient({
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
  operationKind = "direct",
}) {
  assert.ok(["direct", "initial-plan"].includes(operationKind));
  const planning = operationKind === "initial-plan";
  const activeState = planning ? "planning" : "implementing";
  const completedState = planning ? "review" : "complete";
  const model = await taskModelProvider({ observeStreams: true });
  const report = (result.workerInflight = { operationKind, observations: [] });
  const responseReads = [];
  const observeResponse = (response) => {
    if (
      response.status() < 400 ||
      !new URL(response.url()).pathname.startsWith("/api/tasks/")
    )
      return;
    responseReads.push(
      (async () => {
        const body = await response.text().catch((error) => error.message);
        (report.httpErrors ??= []).push({
          url: response.url(),
          status: response.status(),
          body,
        });
      })(),
    );
  };
  page.on("response", observeResponse);
  const brief = "Private worker-crash Task brief " + randomUUID() + " 🌲";
  const answer =
    "Private explicit worker-crash recovery " + randomUUID() + " 🍄";
  const operationId = randomUUID();
  const workerOrigin = () => (fixture.workerFixture ?? fixture).server.origin;
  const posts = () =>
    model.requests.filter((request) => request.method === "POST");
  let expectedPosts = 1;
  let held;
  try {
    await page.evaluate(() => window.folderLive.start());
    await startWorker();
    await page.evaluate(
      async ({ workerId, baseUrl, nativeModel }) => {
        const api = await import("/src/lib/api/models.ts");
        const provider = await api.createModelProvider({
          name: "Disposable worker-crash provider",
          kind: "openai-compatible",
          baseUrl,
          apiKey: null,
        });
        const profile = await api.createModelProfile({
          name: "Disposable worker-crash model",
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
      async ({ projectId, brief, operationKind }) => {
        const api = await import("/src/lib/api/tasks.ts");
        const value = await api.createTask(
          projectId,
          "Private worker-crash Task",
        );
        const task = await api.updateTaskDraft(value.chat.id, {
          rowVersion: value.task.rowVersion,
          briefMarkdown: brief,
          planGoalEnabled: operationKind === "initial-plan",
        });
        window.folderLive.retainScope({ kind: "chat", chatId: value.chat.id });
        return { chatId: value.chat.id, task };
      },
      { projectId, brief, operationKind },
    );
    report.chatId = created.chatId;
    const read = async () => {
      const task = await page.evaluate(
        async (id) => (await import("/src/lib/api/tasks.ts")).getTask(id),
        created.chatId,
      );
      assert.ok(
        posts().length <= expectedPosts,
        "worker restart cannot automatically duplicate uncertain native inference",
      );
      if (
        JSON.stringify(report.observations.at(-1)?.task) !==
        JSON.stringify(task)
      )
        report.observations.push({ at: Date.now(), task });
      if (task.dispatch?.state === "expired" && !report.explicitRecovery) {
        assert.equal(task.state, activeState);
        assert.equal(task.activeOperationId, operationId);
        assert.equal(task.dispatch.operationId, operationId);
        assert.equal(
          task.dispatch.attemptCount,
          report.beforeCrash.task.dispatch.attemptCount,
        );
        assert.equal(
          task.dispatch.fencingToken,
          report.beforeCrash.task.dispatch.fencingToken + 1,
        );
        assert.equal(task.dispatch.eligibilityCode, "reconciliation-required");
        assert.equal(task.automaticRetry, null);
        report.explicitRecovery = await page.evaluate(async (id) => {
          try {
            return {
              ok: true,
              task: await (
                await import("/src/lib/api/tasks.ts")
              ).recoverTaskImplementation(id),
            };
          } catch (error) {
            return { ok: false, error: String(error) };
          }
        }, created.chatId);
        assert.ok(
          posts().length <= expectedPosts,
          "recovery observes the original native input without submitting another",
        );
      }
      return task;
    };
    const messages = () =>
      page.evaluate(
        async (id) => (await import("/src/lib/api/chats.ts")).getMessages(id),
        created.chatId,
      );
    held = model.reply({
      text: "Private uncompleted worker-crash answer " + randomUUID(),
      hold: true,
    });
    const admitted = await page.evaluate(
      async ({ chatId, rowVersion, operationId, operationKind }) => {
        const api = await import("/src/lib/api/tasks.ts");
        return api[
          operationKind === "initial-plan"
            ? "startTaskPlanning"
            : "startTaskDirectly"
        ](chatId, { rowVersion, operationId });
      },
      {
        chatId: created.chatId,
        rowVersion: created.task.rowVersion,
        operationId,
        operationKind,
      },
    );
    assert.equal(admitted.dispatch.operationId, operationId);
    assert.equal(admitted.dispatch.operationKind, operationKind);
    await eventually(
      () => held.entered,
      (entered) => assert.equal(entered, true),
    );
    const oldWorker = getWorker();
    const credential = loadStoredWorkerCredential(
      dataDirectory,
      workerOrigin(),
    );
    report.beforeCrash = {
      workerPid: oldWorker.child.pid,
      task: await read(),
      messages: await messages(),
      modelPosts: posts().length,
    };
    assert.equal(report.beforeCrash.task.state, activeState);
    assert.equal(report.beforeCrash.task.activeOperationId, operationId);
    assert.equal(held.request.completed, false);
    assert.equal(held.request.closed, false);
    await crashWorker();
    await eventually(
      () => held.request.closed,
      (closed) => assert.equal(closed, true),
    );
    assert.equal(
      held.request.completed,
      false,
      "native owner death cannot manufacture a model completion",
    );
    held.release();
    await startWorker();
    const replacement = getWorker();
    assert.notEqual(replacement.child.pid, oldWorker.child.pid);
    assert.deepEqual(
      loadStoredWorkerCredential(dataDirectory, workerOrigin()),
      credential,
    );
    report.replacementWorkerPid = replacement.child.pid;
    const originalLeaseExpiry = Date.parse(
      report.beforeCrash.task.dispatch.leaseExpiresAt,
    );
    assert.ok(Number.isFinite(originalLeaseExpiry));
    report.recoveryDeadline = new Date(
      originalLeaseExpiry + 30_000,
    ).toISOString();
    report.afterReconnect = await eventually(
      read,
      (task) => {
        assert.ok(
          ["failed", "paused"].includes(task.state),
          JSON.stringify(task),
        );
      },
      Math.max(30_000, originalLeaseExpiry + 30_000 - Date.now()),
    );
    assert.equal(posts().length, 1);
    assert.equal(report.afterReconnect.briefMarkdown, brief);
    assert.equal(
      report.afterReconnect.state,
      "failed",
      "an interrupted Task round remains available for explicit retry",
    );
    assert.equal(report.explicitRecovery.ok, true);
    assert.equal(report.afterReconnect.automaticRetry, null);
    assert.deepEqual(await messages(), report.beforeCrash.messages);
    report.repeatedRecovery = await page.evaluate(async (id) => {
      try {
        return {
          task: await (
            await import("/src/lib/api/tasks.ts")
          ).recoverTaskImplementation(id),
        };
      } catch (error) {
        return { status: error.status, message: error.message };
      }
    }, created.chatId);
    assert.equal(report.repeatedRecovery.status, 409);
    // Exercise the actual five-second legacy-failure adopter after a repeated
    // control request; its idle marker must survive on every shared peer.
    await delay(6500);
    assert.deepEqual(await read(), report.afterReconnect);
    assert.equal(posts().length, 1);
    expectedPosts = 2;
    const modelAnswer = planning
      ? JSON.stringify({ planMarkdown: answer, questions: [] })
      : answer;
    model.reply({ text: modelAnswer });
    const retried = await page.evaluate(
      async ({ chatId, rowVersion }) =>
        (await import("/src/lib/api/tasks.ts")).retryTaskPlanning(chatId, {
          rowVersion,
          operationId: crypto.randomUUID(),
        }),
      { chatId: created.chatId, rowVersion: report.afterReconnect.rowVersion },
    );
    assert.notEqual(retried.dispatch.operationId, operationId);
    const completed = await eventually(
      read,
      (task) => assert.equal(task.state, completedState),
      90_000,
    );
    const transcript = await messages();
    report.completed = completed;
    report.transcript = transcript;
    assert.equal(
      transcript
        .flatMap((m) => m.content)
        .filter((i) => i.type === "text" && i.text === answer).length,
      1,
    );
    if (planning) {
      assert.equal(completed.planMarkdown, answer);
      assert.deepEqual(completed.currentQuestions, []);
    }
    assert.equal(posts().length, 2);
    assert.deepEqual(model.failures, []);
    await stopWorker();
    report.restart = await fixture.restart();
    await startWorker();
    assert.deepEqual(await read(), completed);
    assert.deepEqual(await messages(), transcript);
    assert.equal(posts().length, 2);
    for (const marker of [brief, answer]) {
      assert.equal(JSON.stringify(requests).includes(marker), false);
      assert.equal(fixture.server.diagnostics().includes(marker), false);
    }
    report.summary = {
      operationKind,
      workerKilled: true,
      originalStreamClosedWithoutCompletion: true,
      credentialRetained: true,
      automaticDuplicateInference: false,
      explicitRetryCompleted: true,
      modelPosts: 2,
      historyRetainedAfterRestart: true,
    };
    result.steps.push(
      "actual worker SIGKILL stops its native stream, retains uncertain input without automatic duplicate inference, and preserves explicit retry and completed history after restart",
    );
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    page.off("response", observeResponse);
    await Promise.allSettled(responseReads);
    held?.release();
    report.model = { requests: model.requests, failures: model.failures };
    try {
      await stopWorker();
    } finally {
      await model.close();
    }
  }
}
