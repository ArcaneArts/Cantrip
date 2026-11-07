// Existing browser SDK, full production worker, and real Codex model stream.
// Read production HTTP state while the embedded database is open; never open a
// second PGlite instance or install a SQL fixture route to inspect it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadStoredWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { taskModelProvider } from "./task-model-provider.mjs";
import { eventually } from "./full-worker.mjs";

export async function actualSingleInflightClient({
  fixture,
  page,
  projectId,
  workerId,
  worker,
  dataDirectory,
  requests,
  result,
}) {
  const model = await taskModelProvider({ observeStreams: true });
  const report = (result.singleInflight = {
    phases: [],
    workerPid: worker.child.pid,
  });
  const credential = loadStoredWorkerCredential(
    dataDirectory,
    fixture.server.origin,
  );
  const posts = () => model.requests.filter((r) => r.method === "POST");
  const retained = [];
  const connected = () =>
    eventually(
      () => page.evaluate(() => window.folderWorkers.getWorkers()),
      (workers) =>
        assert.equal(
          workers.find((w) => w.workerId === workerId)?.online,
          true,
        ),
    );
  let active;
  try {
    await page.evaluate(() => window.folderLive.start());
    await page.evaluate(
      async ({ baseUrl, nativeModel, workerId }) => {
        const models = await import("/src/lib/api/models.ts");
        const provider = await models.createModelProvider({
          name: "Disposable interrupted provider",
          kind: "openai-compatible",
          baseUrl,
          apiKey: null,
        });
        const profile = await models.createModelProfile({
          name: "Disposable interrupted model",
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
      { baseUrl: model.baseUrl, nativeModel: model.model, workerId },
    );
    const phaseOption = process.argv.indexOf("--single-phase");
    const phases =
      phaseOption < 0
        ? ["server", "admission"]
        : [process.argv[phaseOption + 1]];
    const readTask = (chatId) =>
      page.evaluate(
        async (id) => (await import("/src/lib/api/tasks.ts")).getTask(id),
        chatId,
      );
    const readMessages = (chatId) =>
      page.evaluate(
        async (id) => (await import("/src/lib/api/chats.ts")).getMessages(id),
        chatId,
      );
    for (const phase of phases) {
      assert.ok(["server", "admission"].includes(phase));
      const brief = "Private interrupted Task brief " + randomUUID() + " 🍄";
      const answer = "Private interrupted Task answer " + randomUUID() + " 🌲";
      const operationId = randomUUID();
      active = { phase, operationId, observations: [] };
      report.phases.push(active);
      const created = await page.evaluate(
        async ({ projectId, brief }) => {
          const api = await import("/src/lib/api/tasks.ts");
          const created = await api.createTask(
            projectId,
            "Private interrupted Task",
          );
          const task = await api.updateTaskDraft(created.chat.id, {
            rowVersion: created.task.rowVersion,
            briefMarkdown: brief,
          });
          window.folderLive.retainScope({
            kind: "chat",
            chatId: created.chat.id,
          });
          return { chatId: created.chat.id, task };
        },
        { projectId, brief },
      );
      active.chatId = created.chatId;
      const read = async () => {
        const task = await readTask(created.chatId);
        if (
          JSON.stringify(active.observations.at(-1)?.task) !==
          JSON.stringify(task)
        )
          active.observations.push({ at: Date.now(), task });
        return task;
      };
      const beforePosts = posts().length;
      const reply = model.reply({ text: answer, hold: true });
      const admissionUrl = `**/api/tasks/${created.chatId}/start`;
      let routeError;
      if (phase === "admission")
        await page.route(
          admissionUrl,
          async (route) => {
            try {
              const response = await route.fetch();
              const body = await response.json();
              assert.equal(response.status(), 202);
              assert.equal(body.dispatch.operationId, operationId);
              await eventually(
                () => reply.entered,
                (entered) => assert.equal(entered, true),
              );
              active.committedAdmission = {
                status: response.status(),
                requestBody: route.request().postDataJSON(),
              };
              active.beforeCrash = {
                task: await read(),
                messages: await readMessages(created.chatId),
              };
              active.restart = await fixture.restart({ crash: true });
            } catch (error) {
              routeError = error;
            } finally {
              await route.abort("failed");
            }
          },
          { times: 1 },
        );
      try {
        const admission = await page.evaluate(
          async ({ chatId, rowVersion, operationId }) => {
            try {
              return {
                ok: true,
                body: await (
                  await import("/src/lib/api/tasks.ts")
                ).startTaskDirectly(chatId, { rowVersion, operationId }),
              };
            } catch (error) {
              return { ok: false, name: error.name, message: error.message };
            }
          },
          {
            chatId: created.chatId,
            rowVersion: created.task.rowVersion,
            operationId,
          },
        );
        if (routeError) throw routeError;
        if (phase === "admission") {
          assert.equal(admission.ok, false);
          active.clientAdmissionError = admission;
        } else {
          assert.equal(admission.ok, true, JSON.stringify(admission));
          assert.equal(admission.body.dispatch.state, "queued");
          assert.equal(admission.body.dispatch.operationId, operationId);
        }
      } finally {
        if (phase === "admission") await page.unroute(admissionUrl);
      }
      await eventually(
        () => reply.entered,
        (entered) => assert.equal(entered, true),
      );
      if (phase === "server") {
        await eventually(read, (task) => {
          assert.equal(task.state, "implementing");
          assert.equal(task.activeOperationId, operationId);
          assert.equal(task.dispatch.state, "running");
        });
        active.beforeCrash = {
          task: await read(),
          messages: await readMessages(created.chatId),
        };
        active.restart = await fixture.restart({ crash: true });
      }
      await connected();
      const identity = await page.evaluate(async () => ({
        serverId: (
          await (await import("/src/lib/api/account.ts")).getServerBootstrap()
        ).server.id,
        ownerId: (
          await (await import("/src/lib/api/account.ts")).getAuthSession()
        ).currentUser.id,
      }));
      assert.deepEqual(
        identity,
        await page.evaluate(() => window.folderIdentity),
      );
      assert.equal(worker.child.pid, report.workerPid);
      assert.equal(worker.child.exitCode, null);
      assert.equal(worker.child.signalCode, null);
      assert.equal(reply.request.completed, false);
      assert.equal(reply.request.closed, false);
      assert.equal(posts().length, beforePosts + 1);
      active.afterRestart = {
        task: await read(),
        messages: await readMessages(created.chatId),
      };
      assert.equal(active.afterRestart.task.state, "implementing");
      assert.equal(active.afterRestart.task.activeOperationId, operationId);
      const replay = async () => {
        const value = await page.evaluate(
          async ({ chatId, body }) => {
            const response = await (
              await import("/src/lib/api-client.ts")
            ).requestResponse(`/api/tasks/${chatId}/start`, {
              method: "POST",
              body: JSON.stringify(body),
            });
            return { status: response.status, body: await response.json() };
          },
          {
            chatId: created.chatId,
            body: active.committedAdmission.requestBody,
          },
        );
        assert.equal(value.status, 202);
        assert.equal(value.body.dispatch.operationId, operationId);
        (active.replays ??= []).push({
          status: value.status,
          operationId: value.body.dispatch.operationId,
        });
      };
      if (phase === "admission") await replay();
      reply.release();
      const completed = await eventually(
        read,
        (task) => assert.equal(task.state, "complete"),
        90_000,
      );
      assert.equal(completed.activeOperationId, null);
      assert.equal(completed.briefMarkdown, brief);
      assert.equal(completed.dispatch.operationId, operationId);
      assert.equal(completed.dispatch.attemptCount, 1);
      assert.equal(posts().length, beforePosts + 1);
      assert.equal(reply.request.completed, true);
      assert.deepEqual(model.failures, []);
      if (phase === "admission") {
        await replay();
        assert.deepEqual(await read(), completed);
      }
      const messages = await readMessages(created.chatId);
      assert.equal(
        messages
          .flatMap((m) => m.content)
          .filter((i) => i.type === "text" && i.text === answer).length,
        1,
      );
      assert.deepEqual(
        loadStoredWorkerCredential(dataDirectory, fixture.server.origin),
        credential,
      );
      for (const marker of [brief, answer]) {
        assert.equal(JSON.stringify(requests).includes(marker), false);
        assert.equal(fixture.server.diagnostics().includes(marker), false);
        assert.equal(
          fixture.generations.some((g) => g.diagnostics?.includes(marker)),
          false,
        );
      }
      retained.push({ chatId: created.chatId, task: completed, messages });
      active.completed = {
        state: completed.state,
        postRequests: posts().length - beforePosts,
        attemptCount: completed.dispatch.attemptCount,
      };
      active.cleanRestart = await fixture.restart();
      await connected();
      await eventually(
        () => page.evaluate(() => window.folderLive.snapshot()),
        (live) => {
          assert.equal(live.status, "live");
          assert.equal(live.activeScopeCount, live.desiredScopeCount);
        },
      );
      for (const value of retained) {
        assert.deepEqual(await readTask(value.chatId), value.task);
        assert.deepEqual(await readMessages(value.chatId), value.messages);
      }
      result.steps.push(
        `single server native Task survives ${phase} SIGKILL boundary, original inference and exact completed-history restart`,
      );
    }
    report.summary = report.phases.map((p) => ({
      phase: p.phase,
      completed: p.completed,
      lostAdmissionResponse: Boolean(p.clientAdmissionError),
      replayStatuses: p.replays?.map((r) => r.status) ?? [],
    }));
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    report.model = { requests: model.requests, failures: model.failures };
    await model.close();
  }
}
