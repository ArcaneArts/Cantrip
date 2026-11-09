// Browser Task APIs, the complete worker and actual Codex remain in use. Only
// the public model stream is held while one owned production peer is killed.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { loadStoredWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { taskModelProvider } from "./task-model-provider.mjs";
import { captureTaskRuntimeState } from "./task-runtime-snapshot.mjs";
import { eventually } from "./full-worker.mjs";

const postgres = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("postgres");

export async function actualNativeInflightClient({
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
  const sql = postgres(fixture.environment.DATABASE_URL, { max: 1 });
  const report = (result.nativeInflight = {
    workerPid: worker.child.pid,
    phases: [],
  });
  const snapshot = () =>
    captureTaskRuntimeState({
      ownerId: pageOwner,
      projectId,
      query: (statements, queries) =>
        sql.begin(async (transaction) => {
          for (const statement of statements)
            await transaction.unsafe(statement);
          const values = [];
          for (const query of queries) {
            const rows = await transaction.unsafe(query);
            values.push(JSON.parse(rows[0].result));
          }
          return values;
        }),
    });
  const pageOwner = await page.evaluate(() => window.folderIdentity.ownerId);
  const credential = loadStoredWorkerCredential(
    dataDirectory,
    fixture.workerFixture.server.origin,
  );
  const posts = () => model.requests.filter((r) => r.method === "POST");
  const executorOption = process.argv.indexOf("--inflight-executor");
  const executorRole =
    executorOption < 0 ? null : process.argv[executorOption + 1];
  assert.ok(executorRole === null || executorRole === "client");
  const retainedCompletions = [];
  let active;
  try {
    await page.evaluate(() => window.folderLive.start());
    await page.evaluate(
      async ({ baseUrl, nativeModel, workerId }) => {
        const models = await import("/src/lib/api/models.ts");
        const provider = await models.createModelProvider({
          name: "Disposable in-flight provider",
          kind: "openai-compatible",
          baseUrl,
          apiKey: null,
        });
        const profile = await models.createModelProfile({
          name: "Disposable in-flight model",
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
    const option = process.argv.indexOf("--inflight-peer");
    const roles =
      option < 0
        ? ["client", "worker", "admission"]
        : [process.argv[option + 1]];
    const pendingRoles = [...roles];
    let placementWarmups = 0;
    while (pendingRoles.length) {
      const role = pendingRoles[0];
      assert.ok(["client", "worker", "admission"].includes(role));
      const index = role === "worker" ? 1 : 0;
      const brief = "Private in-flight Task brief " + randomUUID() + " 🍄";
      const answer = "Private in-flight Task answer " + randomUUID() + " 🌲";
      const operationId = randomUUID();
      active = { role, operationId, observations: [] };
      report.phases.push(active);
      const created = await page.evaluate(
        async ({ projectId, brief }) => {
          const api = await import("/src/lib/api/tasks.ts");
          const created = await api.createTask(
            projectId,
            "Private active Task",
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
        const task = await page.evaluate(
          async (chatId) =>
            (await import("/src/lib/api/tasks.ts")).getTask(chatId),
          created.chatId,
        );
        const value = {
          state: task.state,
          rowVersion: task.rowVersion,
          activeOperationId: task.activeOperationId,
          dispatch: task.dispatch,
          lastError: task.lastError,
          automaticRetry: task.automaticRetry,
        };
        if (
          JSON.stringify(active.observations.at(-1)?.value) !==
          JSON.stringify(value)
        )
          active.observations.push({ at: Date.now(), value });
        return task;
      };
      const beforePosts = posts().length;
      const reply = model.reply({ text: answer, hold: true });
      const before = await fixture.assertRemoteWorker(workerId);
      const admissionUrl = `**/api/tasks/${created.chatId}/start`;
      let admissionFault;
      if (role === "admission") {
        await page.route(
          admissionUrl,
          async (route) => {
            try {
              const response = await route.fetch();
              const body = await response.json();
              assert.equal(response.status(), 202);
              assert.equal(body.dispatch.operationId, operationId);
              // Keep the actual committed HTTP response withheld while native
              // execution begins. The SDK has received no admission receipt.
              await eventually(
                () => reply.entered,
                (entered) => assert.equal(entered, true),
              );
              active.committedAdmission = {
                status: response.status(),
                requestBody: route.request().postDataJSON(),
                responseBody: body,
                modelStreamEntered: reply.entered,
              };
              active.beforeCrash = await snapshot();
              active.transition = await fixture.replacePeer(
                index,
                fixture.peers[index].kind,
                { crash: true },
              );
            } catch (error) {
              admissionFault = error;
            } finally {
              await route.abort("failed");
            }
          },
          { times: 1 },
        );
      }
      let admitted;
      try {
        const value = await page.evaluate(
          async ({ chatId, task, operationId }) => {
            try {
              return {
                ok: true,
                body: await (
                  await import("/src/lib/api/tasks.ts")
                ).startTaskDirectly(chatId, {
                  rowVersion: task.rowVersion,
                  operationId,
                }),
              };
            } catch (error) {
              return { ok: false, name: error.name, message: error.message };
            }
          },
          { ...created, operationId },
        );
        if (admissionFault) throw admissionFault;
        if (role === "admission") {
          assert.equal(
            value.ok,
            false,
            "the SDK must actually lose its committed admission response",
          );
          active.clientAdmissionError = value;
          admitted = active.committedAdmission.responseBody;
        } else {
          assert.equal(value.ok, true, JSON.stringify(value));
          admitted = value.body;
        }
      } finally {
        if (role === "admission") await page.unroute(admissionUrl);
      }
      assert.equal(admitted.dispatch.state, "queued");
      assert.equal(admitted.dispatch.operationId, operationId);
      await eventually(
        () => reply.entered,
        (entered) => assert.equal(entered, true),
      );
      await eventually(read, (running) => {
        assert.equal(running.activeOperationId, operationId);
        assert.equal(running.dispatch.state, "running");
      });
      assert.equal(reply.request.completed, false);
      assert.equal(reply.request.closed, false);
      assert.equal(posts().length, beforePosts + 1);
      const runningSnapshot = await snapshot();
      if (role === "admission") active.afterAdmissionRestart = runningSnapshot;
      else active.beforeCrash = runningSnapshot;
      const cycles = runningSnapshot.rows.task_dispatch_cycles;
      const dispatch = cycles.find(
        (cycle) => cycle.operation_id === operationId,
      );
      assert.ok(dispatch);
      active.executorPeer = fixture.generations.findLast((generation) =>
        dispatch.lease_owner.endsWith(":" + generation.instanceId),
      )?.peer;
      assert.ok(active.executorPeer >= 0);
      // Both real schedulers race for SQL authority. An optional topology
      // requirement never seeds or changes that authority: complete other
      // placements normally, then admit another independent Task. Only a real
      // matching lease is counted as the requested interruption scenario.
      active.placementWarmup =
        role !== "admission" &&
        executorRole === "client" &&
        active.executorPeer !== 0;
      if (active.placementWarmup) {
        assert.ok(
          ++placementWarmups <= 12,
          "front executor placement was not observed",
        );
      } else {
        active.transition ??= await fixture.replacePeer(
          index,
          fixture.peers[index].kind,
          {
            crash: true,
          },
        );
        await eventually(
          () => fixture.workerClaim(workerId),
          (claim) => {
            assert.equal(
              claim?.instanceId,
              fixture.workerFixture.environment.CANTRIP_SERVER_INSTANCE_ID,
            );
            if (index === 0)
              assert.equal(claim.connectionId, before.connectionId);
            else assert.notEqual(claim.connectionId, before.connectionId);
            assert.deepEqual(
              claim.continuityIdentity,
              before.continuityIdentity,
            );
          },
        );
      }
      assert.equal(worker.child.pid, report.workerPid);
      assert.equal(worker.child.exitCode, null);
      assert.equal(worker.child.signalCode, null);
      assert.equal(reply.request.completed, false);
      assert.equal(
        reply.request.closed,
        false,
        "the original native model stream remains open across server interruption",
      );
      assert.equal(posts().length, beforePosts + 1);
      active.afterReconnect = await snapshot();
      if (
        process.argv.includes("--inflight-expire-lease") &&
        !active.placementWarmup
      ) {
        assert.equal(role, "worker");
        assert.equal(active.executorPeer, 0);
        active.expiredLease = (
          await eventually(
            () => sql`SELECT state, fencing_token, attempt_count FROM task_dispatch_cycles
            WHERE operation_id = ${operationId}`,
            (rows) => {
              assert.equal(rows.length, 1);
              assert.equal(rows[0].state, "expired");
              assert.equal(
                Number(rows[0].fencing_token),
                Number(dispatch.fencing_token) + 1,
              );
              assert.equal(rows[0].attempt_count, 1);
            },
            135_000,
          )
        )[0];
        assert.equal(reply.request.completed, false);
        assert.equal(reply.request.closed, false);
        assert.equal(posts().length, beforePosts + 1);
        active.afterLeaseExpiry = await snapshot();
      }
      const retained = await read();
      assert.equal(retained.state, "implementing");
      assert.equal(retained.activeOperationId, operationId);
      const replayAdmission = async () => {
        const replay = await page.evaluate(
          async ({ chatId, body }) => {
            const api = await import("/src/lib/api-client.ts");
            const response = await api.requestResponse(
              `/api/tasks/${chatId}/start`,
              {
                method: "POST",
                body: JSON.stringify(body),
              },
            );
            return { status: response.status, body: await response.json() };
          },
          {
            chatId: created.chatId,
            body: active.committedAdmission.requestBody,
          },
        );
        assert.equal(replay.status, 202);
        assert.equal(replay.body.dispatch.operationId, operationId);
        (active.admissionReplays ??= []).push({
          status: replay.status,
          operationId: replay.body.dispatch.operationId,
          rowVersion: replay.body.rowVersion,
        });
      };
      if (role === "admission") await replayAdmission();
      reply.release();
      const completed = await eventually(
        read,
        (task) => assert.equal(task.state, "complete"),
        90_000,
      );
      assert.equal(completed.activeOperationId, null);
      assert.equal(completed.briefMarkdown, brief);
      if (role === "admission") {
        await replayAdmission();
        assert.deepEqual(await read(), completed);
      }
      assert.equal(reply.request.completed, true);
      assert.equal(
        posts().length,
        beforePosts + 1,
        "server interruption never repeats native inference",
      );
      assert.deepEqual(model.failures, []);
      const messages = await page.evaluate(
        async (chatId) =>
          (await import("/src/lib/api/chats.ts")).getMessages(chatId),
        created.chatId,
      );
      assert.equal(
        messages
          .flatMap((m) => m.content)
          .filter((i) => i.type === "text" && i.text === answer).length,
        1,
      );
      assert.deepEqual(
        loadStoredWorkerCredential(
          dataDirectory,
          fixture.workerFixture.server.origin,
        ),
        credential,
      );
      for (const marker of [brief, answer]) {
        assert.equal(JSON.stringify(requests).includes(marker), false);
        assert.equal(
          fixture.peers.some((peer) =>
            peer.server.diagnostics().includes(marker),
          ),
          false,
        );
        assert.equal(
          fixture.generations.some((generation) =>
            generation.diagnostics?.includes(marker),
          ),
          false,
        );
      }
      active.completed = {
        state: completed.state,
        postRequests: posts().length - beforePosts,
      };
      active.afterCompletion = await snapshot();
      const completedCycles =
        active.afterCompletion.rows.task_dispatch_cycles.filter(
          (cycle) => cycle.chat_id === created.chatId,
        );
      assert.equal(completedCycles.length, 1);
      assert.equal(completedCycles[0].operation_id, operationId);
      assert.equal(completedCycles[0].state, "succeeded");
      assert.equal(completedCycles[0].attempt_count, 1);
      const completedRounds =
        active.afterCompletion.rows.task_planning_rounds.filter(
          (round) => round.chat_id === created.chatId,
        );
      assert.equal(completedRounds.length, 1);
      assert.equal(completedRounds[0].id, operationId);
      assert.equal(completedRounds[0].status, "completed");
      for (const retained of retainedCompletions) {
        const current = await page.evaluate(
          async (chatId) => ({
            task: await (await import("/src/lib/api/tasks.ts")).getTask(chatId),
            messages: await (
              await import("/src/lib/api/chats.ts")
            ).getMessages(chatId),
          }),
          retained.chatId,
        );
        assert.deepEqual(current.task, retained.task);
        assert.deepEqual(current.messages, retained.messages);
      }
      retainedCompletions.push({
        chatId: created.chatId,
        task: completed,
        messages,
      });
      if (!active.placementWarmup) {
        pendingRoles.shift();
        result.steps.push(
          role === "admission"
            ? "native Task survives admission commit before lost client response and exact receipt replay, with one inference and unchanged earlier Task history"
            : `native Task survives ${role} peer SIGKILL during a real held model stream with the same full worker and no duplicate inference`,
        );
      }
    }
    report.summary = report.phases
      .filter((phase) => !phase.placementWarmup)
      .map((phase) => ({
        role: phase.role,
        completed: phase.completed,
        lostAdmissionResponse: Boolean(phase.clientAdmissionError),
        replayStatuses:
          phase.admissionReplays?.map((replay) => replay.status) ?? [],
      }));
  } catch (error) {
    if (active) active.failure = { message: error.message, stack: error.stack };
    try {
      report.failureSnapshot = await snapshot();
    } catch (cause) {
      report.failureSnapshotError = cause.message;
    }
    throw error;
  } finally {
    report.model = { failures: model.failures, requests: model.requests };
    await model.close();
    await sql.end({ timeout: 5 });
  }
}
