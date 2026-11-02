// Existing Agent conversation SDK -> server -> full worker -> actual Codex.
import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";
import { taskModelProvider } from "./task-model-provider.mjs";

export async function actualProjectChatClient({
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
  const prompt = "Private actual Agent prompt 🌲",
    answer = "Private actual Agent answer 🍄",
    objective = "Private actual Agent Goal objective 🌙",
    goalAnswer = "Private actual Agent Goal completed ☀";
  try {
    await page.evaluate(() => window.folderLive.start());
    await startWorker();
    const configuration = await page.evaluate(
      async ({ baseUrl, nativeModel, workerId }) => {
        const models = await import("/src/lib/api/models.ts"),
          settings = await import("/src/lib/api/settings.ts");
        const provider = await models.createModelProvider({
          name: "Disposable Agent provider",
          kind: "openai-compatible",
          baseUrl,
          apiKey: null,
        });
        const profile = await models.createModelProfile({
          name: "Disposable Agent model",
          routes: [
            { providerId: provider.id, modelName: nativeModel, enabled: true },
          ],
        });
        await settings.updateSettings({
          defaultModelId: profile.id,
          autoNameChats: false,
          autoNameTasks: false,
        });
        const workers = await import("/src/lib/api/worker-wire.ts");
        await (
          await import("/src/lib/chat-worker-encryption.ts")
        ).ensureChatWorkerEncryption({
          worker: (await workers.getWorkers()).find(
            (w) => w.workerId === workerId,
          ),
        });
        await (
          await import("/src/lib/private-label-worker-encryption.ts")
        ).ensurePrivateLabelWorkerEncryption({
          worker: (await workers.getWorkers()).find(
            (w) => w.workerId === workerId,
          ),
        });
        await (
          await import("/src/lib/surface-private-state-worker-encryption.ts")
        ).ensureSurfacePrivateStateWorkerEncryption({
          worker: (await workers.getWorkers()).find(
            (w) => w.workerId === workerId,
          ),
        });
        return {
          modelId: profile.id,
          reasoningEffort: null,
          customSubagentModel: false,
          subagentModelId: null,
          subagentReasoningEffort: null,
        };
      },
      { baseUrl: model.baseUrl, nativeModel: model.model, workerId },
    );
    const chat = await page.evaluate(async (projectId) => {
      const api = await import("/src/lib/api/conversations.ts");
      window.agentProjectId = projectId;
      window.agentCreation = await api.prepareConversationCreation(
        projectId,
        "Private actual Agent title",
        false,
      );
      const created = await window.agentCreation();
      window.folderLive.retainScope({ kind: "chat", chatId: created.id });
      return created;
    }, projectId);
    const replay = await page.evaluate(() => window.agentCreation());
    assert.equal(replay.id, chat.id);
    assert.equal(replay.title, chat.title);
    assert.equal(chat.experience, "agent");
    await eventually(
      () =>
        page.evaluate(
          async (chatId) =>
            (
              await (
                await import("/src/lib/api-client.ts")
              ).request(`/api/chats/${chatId}/preparation`)
            ).preparation,
          chat.id,
        ),
      (preparation) => assert.equal(preparation?.phase, "ready"),
    );
    const usage = await page.evaluate(async (chatId) => {
      const api = await import("/src/lib/api/conversations.ts");
      window.agentUsage = {
        clientId: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        sequence: 1,
      };
      const used = await api.recordConversationUsage(chatId, window.agentUsage);
      const page = await api.getConversationCatalog(window.agentProjectId);
      return { used, page };
    }, chat.id);
    assert.equal(usage.used.applied, true);
    assert.equal(usage.page.items[0].id, chat.id);
    const reply = model.reply({ text: answer });
    const admitted = await page.evaluate(
      async ({ chatId, prompt, configuration }) =>
        (await import("/src/lib/api/chats.ts")).startTurn(
          chatId,
          prompt,
          configuration,
        ),
      { chatId: chat.id, prompt, configuration },
    );
    assert.equal(admitted.status, "started");
    const readMessages = () =>
      page.evaluate(
        async (chatId) =>
          (await import("/src/lib/api/chats.ts")).getMessages(chatId),
        chat.id,
      );
    await eventually(readMessages, (messages) =>
      assert.ok(JSON.stringify(messages).includes(answer)),
    );
    const idle = () =>
      eventually(
        () =>
          page.evaluate(
            async (project) =>
              (await import("/src/lib/api/chats.ts")).getChats(project),
            projectId,
          ),
        (chats) =>
          assert.equal(chats.find((c) => c.id === chat.id)?.status, "idle"),
      );
    await idle();
    assert.equal(reply.request.completed, true);
    result.steps.push(
      "the existing Agent conversation SDK replays one creation identity, prepares the real native CLI, records usage and decrypts a full-worker native response",
    );

    model.reply({
      calls: [
        { name: "create_goal", arguments: { objective, token_budget: 1000 } },
      ],
    });
    model.reply({
      calls: [{ name: "update_goal", arguments: { status: "complete" } }],
    });
    const final = model.reply({ text: goalAnswer });
    const goalTurn = await page.evaluate(
      async ({ chatId, configuration }) =>
        (await import("/src/lib/api/chats.ts")).startTurn(
          chatId,
          "Private actual Agent Goal request 🌙",
          configuration,
        ),
      { chatId: chat.id, configuration },
    );
    assert.equal(goalTurn.status, "started");
    await eventually(readMessages, (messages) =>
      assert.ok(JSON.stringify(messages).includes(goalAnswer)),
    );
    await idle();
    const goal = await page.evaluate(
      async (chatId) =>
        (await import("/src/lib/api/chats.ts")).getChatGoal(chatId),
      chat.id,
    );
    assert.equal(goal.goal.status, "complete");
    assert.equal(goal.goal.objective, objective);
    assert.equal(goal.goal.tokenBudget, 1000);
    const native = final.request.input.input
      .filter((i) => i.type === "function_call_output")
      .map((i) => JSON.parse(i.output))
      .find((i) => i.goal?.status === "complete");
    assert.ok(native, "actual native Goal completion tool result");
    assert.equal(native.goal.objective, goal.goal.objective);
    assert.equal(native.goal.threadId, goal.goal.threadId);
    assert.equal(model.requests.filter((r) => r.method === "POST").length, 4);
    assert.deepEqual(model.failures, []);
    const completedTurns = await page.evaluate(
      async ({ chatId, answers }) => {
        const api = await import("/src/lib/api/chats.ts");
        const messages = await api.getMessages(chatId);
        return answers.map((answer) => {
          const item = messages
            .flatMap((m) => m.content)
            .find((item) => item.type === "text" && item.text === answer);
          return {
            threadId: item.correlation.threadId,
            turnId: item.correlation.turnId,
          };
        });
      },
      { chatId: chat.id, answers: [answer, goalAnswer] },
    );
    const canonical = await eventually(
      () =>
        page.evaluate(
          async ({ chatId, turns }) =>
            (await import("/src/lib/api-client.ts")).request(
              `/api/chats/${chatId}/native-history/turns/read`,
              {
                method: "POST",
                body: JSON.stringify({ turns }),
              },
            ),
          { chatId: chat.id, turns: completedTurns },
        ),
      (archive) => {
        assert.equal(
          archive.turns.length,
          2,
          "both real native turns are durably archived before restart",
        );
        for (const entry of archive.turns)
          assert.equal(entry.turn.status, "completed");
      },
    );
    await eventually(readMessages, (messages) => {
      for (const text of [answer, goalAnswer]) {
        const message = messages.find((m) =>
          m.content.some((i) => i.type === "text" && i.text === text),
        );
        assert.equal(
          message.modelId,
          configuration.modelId,
          "canonical native attribution resolves the original model",
        );
        const item = message.content.find(
          (i) => i.type === "text" && i.text === text,
        );
        assert.equal(item.correlation.sourceMethod, "native-history");
        assert.equal(item.streaming, false);
      }
    });
    result.projectChatCanonicalTurns = canonical.turns.map(({ turn }) => ({
      threadId: turn.threadId,
      turnId: turn.turnId,
      status: turn.status,
    }));
    result.steps.push(
      "the actual Agent native Goal tools create and complete a persistent Goal; the browser decrypts exactly the native objective and history",
    );

    await stopWorker();
    // Graceful worker shutdown drains canonical history writes. Capture that
    // committed transcript before restarting the server, then require exact
    // retention both before and after the worker reconnects.
    const messages = await readMessages();
    const port = Number(new URL(fixture.server.origin).port);
    await fixture.close();
    await fixture.start({ port });
    assert.deepEqual(await readMessages(), messages);
    await startWorker();
    await page.evaluate(async (workerId) => {
      const api = await import("/src/lib/api/worker-wire.ts");
      await (
        await import("/src/lib/chat-worker-encryption.ts")
      ).ensureChatWorkerEncryption({
        worker: (await api.getWorkers()).find((w) => w.workerId === workerId),
      });
      await (
        await import("/src/lib/private-label-worker-encryption.ts")
      ).ensurePrivateLabelWorkerEncryption({
        worker: (await api.getWorkers()).find((w) => w.workerId === workerId),
      });
      await (
        await import("/src/lib/surface-private-state-worker-encryption.ts")
      ).ensureSurfacePrivateStateWorkerEncryption({
        worker: (await api.getWorkers()).find((w) => w.workerId === workerId),
      });
    }, workerId);
    assert.deepEqual(await readMessages(), messages);
    const retained = await page.evaluate(async (chatId) => {
      const conversations = await import("/src/lib/api/conversations.ts");
      return {
        chat: await window.agentCreation(),
        usage: await conversations.recordConversationUsage(
          chatId,
          window.agentUsage,
        ),
        page: await conversations.getConversationCatalog(window.agentProjectId),
        goal: await (await import("/src/lib/api/chats.ts")).getChatGoal(chatId),
      };
    }, chat.id);
    assert.equal(retained.chat.id, chat.id);
    assert.equal(retained.chat.title, chat.title);
    assert.deepEqual(retained.usage, usage.used);
    assert.equal(retained.page.items[0].id, chat.id);
    assert.equal(retained.goal.goal.status, "complete");
    assert.equal(retained.goal.goal.threadId, goal.goal.threadId);
    assert.equal(retained.goal.goal.objective, objective);
    const cleared = await page.evaluate(async (chatId) => {
      const api = await import("/src/lib/api/chats.ts");
      return {
        cleared: await api.clearChatGoal(chatId),
        goal: await api.getChatGoal(chatId),
      };
    }, chat.id);
    assert.equal(cleared.cleared.cleared, true);
    assert.equal(cleared.goal.goal, null);
    assert.equal(
      model.requests.filter((r) => r.method === "POST").length,
      4,
      "restarts, receipt replay and Goal clear do not repeat inference",
    );
    for (const marker of [
      prompt,
      answer,
      objective,
      goalAnswer,
      "Private actual Agent title",
      "Private actual Agent Goal request 🌙",
    ]) {
      assert.equal(
        JSON.stringify(requests).includes(marker),
        false,
        "private Agent content stays out of browser-to-server requests",
      );
      assert.equal(
        fixture.server.diagnostics().includes(marker),
        false,
        "private Agent content stays out of server diagnostics",
      );
    }
    assert.deepEqual(model.failures, []);
    result.projectChatExecution = {
      completed: true,
      nativeGoalCompleted: true,
      retainedAfterRestart: true,
      modelRequests: 4,
      modelFailures: [],
      chatId: chat.id,
    };
    result.steps.push(
      "Agent creation and usage receipts, encrypted history and native Goal survive server/worker restart; public Goal clear succeeds without duplicate inference",
    );
  } catch (error) {
    result.projectChatFailure = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    result.projectChatModel = {
      failures: model.failures,
      requests: model.requests.map(({ method, path, completed, input }) => ({
        method,
        path,
        completed,
        model: input?.model,
        toolResults: input?.input?.filter(
          (i) => i.type === "function_call_output",
        ),
      })),
    };
    await stopWorker();
    await model.close();
  }
}
