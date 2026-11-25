// Browser SDK, native server, full worker, and bundled Codex App Server.
// Only the HTTP model response is held to guarantee an active native turn.
import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";
import { taskModelProvider } from "./task-model-provider.mjs";

export async function actualCouncilSteering({ page, workerId, result }) {
  const model = await taskModelProvider({ observeStreams: true });
  const role = "Preserve this Council role marker 🌲";
  const original = "Read the durable Council queue";
  const followUp = "Steer the same Council turn 🍄";
  const answer = "The Council steer reached the active turn";
  const timeout = 60_000;
  try {
    const { chatId, configuration } = await page.evaluate(
      async ({ workerId, baseUrl, nativeModel, role }) => {
        const models = await import("/src/lib/api/models.ts");
        const provider = await models.createModelProvider({
          name: "Disposable Council provider",
          kind: "openai-compatible",
          baseUrl,
          apiKey: null,
        });
        const profile = await models.createModelProfile({
          name: "Disposable Council model",
          routes: [
            { providerId: provider.id, modelName: nativeModel, enabled: true },
          ],
        });
        await (
          await import("/src/lib/api/settings.ts")
        ).updateSettings({
          defaultCouncilModelId: profile.id,
          autoNameChats: false,
        });
        const workers = await (
          await import("/src/lib/api/worker-wire.ts")
        ).getWorkers();
        await (
          await import("/src/lib/chat-worker-encryption.ts")
        ).ensureChatWorkerEncryption({
          worker: workers.find((worker) => worker.workerId === workerId),
        });
        const agent = await (
          await import("/src/lib/api/council.ts")
        ).createCouncilAgent("Disposable Operations Agent", role);
        window.folderLive.retainScope({ kind: "chat", chatId: agent.id });
        return {
          chatId: agent.id,
          configuration: {
            modelId: profile.id,
            reasoningEffort: null,
            customSubagentModel: false,
            subagentModelId: null,
            subagentReasoningEffort: null,
          },
        };
      },
      { workerId, baseUrl: model.baseUrl, nativeModel: model.model, role },
    );
    await eventually(
      () =>
        page.evaluate(
          (id) =>
            window
              .folderRequest("/api/council/agents")
              .then((agents) => agents.find((agent) => agent.id === id)),
          chatId,
        ),
      (agent) => {
        assert.equal(agent.primary, true);
        assert.equal(agent.scratchStatus, "ready");
      },
      timeout,
    );

    const submit = (text) =>
      page.evaluate(
        async ({ chatId, configuration, text }) =>
          (await import("/src/lib/api/chats.ts")).startTurn(
            chatId,
            text,
            configuration,
          ),
        { chatId, configuration, text },
      );
    const readQueue = () =>
      page.evaluate(
        (id) => window.folderRequest(`/api/chats/${id}/queue`),
        chatId,
      );
    const readMessages = () =>
      page.evaluate(
        async (id) => (await import("/src/lib/api/chats.ts")).getMessages(id),
        chatId,
      );
    const withText = (messages, text) =>
      messages.filter((message) =>
        message.content.some(
          (item) => item.type === "text" && item.text === text,
        ),
      );
    const held = model.reply({
      hold: true,
      text: "The first Council inference is active",
    });
    model.reply({ text: answer });
    const first = await submit(original);
    assert.equal(first.status, "queued");
    await eventually(
      () => held.entered,
      (entered) => assert.equal(entered, true),
      timeout,
    );
    assert.ok(
      JSON.stringify(held.request.input).includes(role),
      "Codex received the browser-encrypted role",
    );
    assert.ok(
      JSON.stringify(held.request.input).includes("primary Council agent"),
      "Codex received the primary instruction",
    );

    const second = await submit(followUp);
    assert.equal(second.status, "queued");
    const active = await eventually(
      readMessages,
      (messages) => {
        const [root] = withText(messages, original);
        const matches = withText(messages, followUp);
        assert.equal(matches.length, 1);
        assert.ok(root?.executionLaneId);
        assert.equal(matches[0].executionLaneId, root.executionLaneId);
        assert.equal(
          held.request.completed,
          false,
          "Steering finished while the first inference was active",
        );
      },
      timeout,
    );
    const queue = await readQueue();
    assert.ok(!queue.items.some((item) => item.id === second.prompt.id));
    assert.ok(
      !queue.claims.some((claim) => claim.promptId === second.prompt.id),
    );
    held.release();

    const messages = await eventually(
      readMessages,
      (messages) => {
        assert.equal(withText(messages, followUp).length, 1);
        assert.equal(withText(messages, answer).length, 1);
      },
      timeout,
    );
    const requests = model.requests.filter(({ method }) => method === "POST");
    assert.ok(
      requests.some(({ input }) => JSON.stringify(input).includes(followUp)),
    );
    assert.deepEqual(model.failures, []);
    result.councilSteering = {
      chatId,
      firstPromptId: first.prompt.id,
      steeredPromptId: second.prompt.id,
      executionLaneId: withText(active, followUp)[0].executionLaneId,
      messageCount: messages.length,
    };
    result.steps.push(
      "Council steers an active native turn through its durable queue",
    );
  } finally {
    await model.close();
  }
}
