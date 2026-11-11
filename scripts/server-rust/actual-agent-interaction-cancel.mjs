import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import path from "node:path";
import { actualAgentInteractionsClient } from "./actual-agent-interactions-client.mjs";
import { eventually } from "./full-worker.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { taskModelProvider } from "./task-model-provider.mjs";

const faultName = "fixture_reject_canceled_chat_approval";

export async function actualAgentInteractionCancel({
  fixture,
  repositoryBinary,
  page,
  projectId,
  projectRoot,
  workerId,
  startWorker,
  stopWorker,
  diagnostics,
  result,
  requests,
}) {
  const model = await taskModelProvider();
  const evidence = (result.approvalCancellation = { phase: "configuration" });
  const api = (operation, ...args) =>
    page.evaluate(
      async ({ operation, args }) =>
        (await import("/src/lib/api/chats.ts"))[operation](...args),
      { operation, args },
    );
  const status = async (chatId) =>
    (await api("getChats", projectId)).find(({ id }) => id === chatId)?.status;
  const prepareWorker = () =>
    page.evaluate(async (workerId) => {
      const workers = await import("/src/lib/api/worker-wire.ts");
      const { ensureChatWorkerEncryption } =
        await import("/src/lib/chat-worker-encryption.ts");
      const { ensureSurfacePrivateStateWorkerEncryption } =
        await import("/src/lib/surface-private-state-worker-encryption.ts");
      const get = async () =>
        (await workers.getWorkers()).find(
          (worker) => worker.workerId === workerId,
        );
      await ensureChatWorkerEncryption({ worker: await get() });
      await ensureSurfacePrivateStateWorkerEncryption({ worker: await get() });
    }, workerId);
  const create = async (title) => {
    const chat = await api("createChat", projectId, title);
    await page.evaluate(
      (id) => window.folderLive.retainScope({ kind: "chat", chatId: id }),
      chat.id,
    );
    await eventually(
      () =>
        page.evaluate(
          async (chatId) =>
            (await window.folderRequest(`/api/chats/${chatId}/preparation`))
              .preparation,
          chat.id,
        ),
      (preparation) =>
        assert.equal(preparation?.phase, "ready", diagnostics().slice(-7000)),
    );
    return chat;
  };
  try {
    const modelId = await page.evaluate(
      async ({ baseUrl, model }) => {
        const models = await import("/src/lib/api/models.ts");
        const settings = await import("/src/lib/api/settings.ts");
        const provider = await models.createModelProvider({
          name: "Disposable approval provider",
          kind: "openai-compatible",
          baseUrl,
          apiKey: null,
        });
        const profile = await models.createModelProfile({
          name: "Disposable approval model",
          routes: [
            { providerId: provider.id, modelName: model, enabled: true },
          ],
        });
        await settings.updateSettings({
          defaultModelId: profile.id,
          autoNameChats: false,
        });
        return profile.id;
      },
      { baseUrl: model.baseUrl, model: model.model },
    );
    const configuration = {
      modelId,
      reasoningEffort: null,
      customSubagentModel: false,
      subagentModelId: null,
      subagentReasoningEffort: null,
    };
    await prepareWorker();
    const canceled = await create("Disposable approval write failure");
    const control = await create("Disposable approval control");
    assert.match(canceled.id, /^[a-f0-9-]{36}$/u);
    Object.assign(evidence, {
      canceledChatId: canceled.id,
      controlChatId: control.id,
    });
    const warmup = "Private approval warm-up response 🍐";
    const initial = model.reply({ text: warmup });
    await api(
      "startTurn",
      canceled.id,
      "Open the approval test conversation",
      configuration,
    );
    await eventually(
      () => api("getMessages", canceled.id),
      (messages) => assert.ok(JSON.stringify(messages).includes(warmup)),
    );
    await eventually(
      () => status(canceled.id),
      (value) => assert.equal(value, "idle"),
    );
    const exec = initial.request.input.tools
      .flatMap((tool) =>
        tool.type === "namespace"
          ? tool.tools.map((entry) => ({ ...entry, namespace: tool.name }))
          : [tool],
      )
      .find((tool) => tool.name === "exec_command");
    assert.ok(exec, "actual native runtime advertises its command tool");

    evidence.phase = "installing the disposable database fault";
    await page.evaluate(() => window.folderLive.stop());
    await stopWorker();
    const origin = new URL(fixture.server.origin);
    await fixture.close();
    const repository = await repositoryFixture({
      kind: fixture.kind,
      root: path.dirname(fixture.environment.CANTRIP_DATA_DIR),
      databaseMode: fixture.databaseMode,
      databaseUrl: fixture.environment.DATABASE_URL,
      executable: repositoryBinary,
    });
    try {
      await repository.seed(
        `ALTER TABLE agent_interaction_requests ADD CONSTRAINT ${faultName} CHECK (chat_id IS DISTINCT FROM '${canceled.id}' OR kind <> 'commandExecution') NOT VALID`,
      );
    } finally {
      await repository.close();
    }
    await fixture.start({ port: Number(origin.port) });
    await startWorker();
    await prepareWorker();
    await page.evaluate(() => window.folderLive.start());
    evidence.phase = "actual approval cancellation";
    const markerFile = ".cantrip-approval-cancellation-probe";
    const markerPath = path.join(projectRoot, markerFile);
    const privateReason = "Private rejected approval reason 🍋";
    const privatePrompt = "Private rejected approval prompt 🍇";
    await assert.rejects(stat(markerPath), { code: "ENOENT" });
    const before = model.requests.filter(
      ({ method }) => method === "POST",
    ).length;
    const denied = model.reply({
      calls: [
        {
          name: exec.name,
          namespace: exec.namespace,
          arguments: {
            cmd: `touch ${markerFile}`,
            login: false,
            sandbox_permissions: "require_escalated",
            justification: privateReason,
            max_output_tokens: 300,
          },
        },
      ],
    });
    const admitted = await api(
      "startTurn",
      canceled.id,
      privatePrompt,
      configuration,
    );
    assert.equal(admitted.status, "queued");
    const cancelCommands = () =>
      diagnostics()
        .split("\n")
        .filter(
          (line) =>
            line.includes("operation=agent.interaction.cancel ") &&
            line.includes(`chatId=${canceled.id}`),
        );
    evidence.cancelCommands = await eventually(cancelCommands, (lines) =>
      assert.ok(
        lines.some((line) => line.includes("event=worker.command.completed ")),
        diagnostics().slice(-10000),
      ),
    );
    await eventually(
      () => status(canceled.id),
      (value) => assert.equal(value, "failed"),
    );
    const nativeEvents = () =>
      diagnostics()
        .split("\n")
        .filter(
          (line) =>
            line.includes("event=codex.turn.lifecycle ") &&
            line.includes(`chatId=${canceled.id} `),
        );
    evidence.nativeInterruption = await eventually(nativeEvents, (lines) => {
      assert.equal(lines.length, 2);
      assert.match(lines[0], /status=started /u);
      assert.match(lines[1], /status=failed .*Codex turn was interrupted\./u);
      const identity = /threadId=(\S+) turnId=(\S+)/u;
      assert.deepEqual(
        lines[0].match(identity)?.slice(1),
        lines[1].match(identity)?.slice(1),
      );
      assert.ok(lines[1].match(identity));
    });
    assert.equal(denied.request.completed, true);
    assert.equal(
      model.requests.filter(({ method }) => method === "POST").length,
      before + 1,
    );
    assert.deepEqual(
      await api("getAgentInteractionRequests", { chatId: canceled.id }),
      [],
    );
    await assert.rejects(stat(markerPath), { code: "ENOENT" });
    const commands = cancelCommands();
    assert.equal(commands.length, 2);
    assert.match(commands[0], /event=worker\.command\.dispatched /u);
    assert.match(commands[1], /event=worker\.command\.completed /u);
    const requestId = /requestId=(\S+)/u;
    assert.ok(commands[0].match(requestId));
    assert.equal(
      commands[0].match(requestId)?.[1],
      commands[1].match(requestId)?.[1],
    );
    assert.ok(
      JSON.stringify(await api("getMessages", canceled.id)).includes(
        privatePrompt,
      ),
    );
    for (const observed of [
      requests,
      fixture.server.diagnostics(),
      diagnostics(),
    ])
      for (const text of [privateReason, privatePrompt])
        assert.ok(!JSON.stringify(observed).includes(text));
    evidence.phase = "normal approval control";
    await actualAgentInteractionsClient({
      page,
      fixture,
      projectId,
      chatId: control.id,
      configuration,
      model,
      result,
      requests,
    });
    const controlRows = await api("getAgentInteractionRequests", {
      chatId: control.id,
    });
    assert.equal(controlRows.length, 1);
    assert.equal(controlRows[0].status, "resolved");
    assert.equal(controlRows[0].response.decision, "accept");
    evidence.phase = "same-worker follow-up";
    const recoveredAnswer = "Private approval recovery response 🍎";
    const recovered = model.reply({ text: recoveredAnswer });
    const interruptedTurn =
      evidence.nativeInterruption[1].match(/turnId=(\S+)/u)?.[1];
    assert.ok(interruptedTurn);
    assert.equal(
      (
        await api(
          "startTurn",
          canceled.id,
          "Check the canceled native session",
          configuration,
        )
      ).status,
      "queued",
    );
    evidence.sameWorkerFollowup = await eventually(
      () =>
        nativeEvents().find(
          (line) =>
            !line.includes(`turnId=${interruptedTurn} `) &&
            line.includes("status=failed ") &&
            line.includes("Codex turn was interrupted."),
        ),
      (line) => assert.ok(line, diagnostics().slice(-8000)),
    );
    assert.equal(recovered.entered, false);
    assert.equal(
      model.requests.filter(({ method }) => method === "POST").length,
      before + 3,
    );

    evidence.phase = "recovering the canceled Agent after worker restart";
    await stopWorker();
    await startWorker();
    await prepareWorker();
    assert.equal(
      (
        await api(
          "startTurn",
          canceled.id,
          "Continue with a normal reply",
          configuration,
        )
      ).status,
      "queued",
    );
    await eventually(
      () => api("getMessages", canceled.id),
      (messages) =>
        assert.ok(JSON.stringify(messages).includes(recoveredAnswer)),
    );
    await eventually(
      () => status(canceled.id),
      (value) => assert.equal(value, "idle"),
    );
    assert.equal(recovered.request.completed, true);
    assert.equal(
      model.requests.filter(({ method }) => method === "POST").length,
      before + 4,
    );
    assert.deepEqual(model.failures, []);

    evidence.phase = "retained restart";
    await page.evaluate(() => window.folderLive.stop());
    await stopWorker();
    const restart = await fixture.restart();
    assert.notEqual(restart.before.pid, restart.after.pid);
    assert.deepEqual(
      await api("getAgentInteractionRequests", { chatId: canceled.id }),
      [],
    );
    assert.deepEqual(
      await api("getAgentInteractionRequests", { chatId: control.id }),
      controlRows,
    );
    assert.ok(
      JSON.stringify(await api("getMessages", canceled.id)).includes(
        recoveredAnswer,
      ),
    );
    await assert.rejects(stat(markerPath), { code: "ENOENT" });
    Object.assign(evidence, {
      phase: "complete",
      restart,
      summary: {
        canceledChatStatus: "failed",
        canceledWithoutRunning: true,
        failedApprovalAbsent: true,
        normalApprovalCompleted: true,
        sameWorkerFollowupInterrupted: true,
        sameChatRecoveredAfterWorkerRestart: true,
        resultsRetained: true,
      },
    });
    result.steps.push(
      "a failed protected approval write sends one real worker cancellation, leaves no approval or command side effect, and another Agent can complete a normal approval",
    );
  } finally {
    evidence.modelRequests = model.requests;
    evidence.modelFailures = model.failures;
    await model.close();
  }
}
