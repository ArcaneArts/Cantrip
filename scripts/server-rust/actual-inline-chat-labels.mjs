import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";
import { taskModelProvider } from "./task-model-provider.mjs";

const cases = [
  { kind: "agent", title: "Track orchard deliveries", separateProvider: false },
  {
    kind: "standalone",
    title: "Summarize private notes",
    separateProvider: true,
  },
  { kind: "agent", title: null, separateProvider: false },
];

export async function actualInlineChatLabels({
  fixture,
  page,
  projectId,
  workerId,
  stopWorker,
  diagnostics,
  result,
}) {
  const responseModel = await taskModelProvider();
  const labelModel = await taskModelProvider();
  const observation = (result.inlineChatLabels = { cases: [] });
  const summaries = [];
  const readWire = (kind, chatId) =>
    page.evaluate(
      async ({ kind, projectId, chatId }) => {
        const standalone = kind === "standalone";
        const { chatTitleEncryption } =
          await import("/src/lib/chat-title-encryption.ts");
        const rows = await window.folderRequest(
          standalone
            ? "/api/chats?context=standalone"
            : `/api/projects/${encodeURIComponent(projectId)}/chats`,
        );
        const wire = rows.find((row) => row.id === chatId);
        const opened = standalone
          ? await chatTitleEncryption.openStandalone(wire)
          : await chatTitleEncryption.open(wire);
        return { wire, title: opened.title };
      },
      { kind, projectId, chatId },
    );
  const api = (operation, ...args) =>
    page.evaluate(
      async ({ operation, args }) =>
        (await import("/src/lib/api/chats.ts"))[operation](...args),
      { operation, args },
    );
  const posts = (model) =>
    model.requests.filter(({ method }) => method === "POST");
  try {
    const profileIds = await page.evaluate(
      async ({ models, projectId, workerId }) => {
        const modelApi = await import("/src/lib/api/models.ts");
        const workers = await import("/src/lib/api/worker-wire.ts");
        const profileIds = [];
        for (const [index, model] of models.entries()) {
          const provider = await modelApi.createModelProvider({
            name: `Disposable conversation model ${index}`,
            kind: "openai-compatible",
            baseUrl: model.baseUrl,
            apiKey: null,
          });
          const profile = await modelApi.createModelProfile({
            name: `Disposable conversation route ${index}`,
            routes: [
              { providerId: provider.id, modelName: model.name, enabled: true },
            ],
          });
          profileIds.push(profile.id);
        }
        const settings = await import("/src/lib/api/settings.ts");
        await settings.updateSettings({
          defaultModelId: profileIds[0],
          defaultChatModelId: profileIds[0],
          autoNameChats: true,
          randomAgentNames: false,
        });
        window.folderLive.retainScope({ kind: "project", projectId });
        const worker = (await workers.getWorkers()).find(
          (candidate) => candidate.workerId === workerId,
        );
        const encryption = await (
          await import("/src/lib/chat-worker-encryption.ts")
        ).ensureChatWorkerEncryption({ worker });
        if (
          encryption.grants.some(
            ({ component }) => component === "private-surface-metadata",
          )
        )
          throw new Error(
            "The fresh worker already has the private title key.",
          );
        return profileIds;
      },
      {
        models: [responseModel, labelModel].map(({ baseUrl, model: name }) => ({
          baseUrl,
          name,
        })),
        projectId,
        workerId,
      },
    );
    const configuration = {
      modelId: profileIds[0],
      reasoningEffort: null,
      customSubagentModel: false,
      subagentModelId: null,
      subagentReasoningEffort: null,
    };
    for (const [index, scenario] of cases.entries()) {
      const { kind, title, separateProvider } = scenario;
      const standalone = kind === "standalone";
      const entry = { kind, separateProvider, phase: "creation" };
      observation.cases.push(entry);
      await page.evaluate(
        async (labelingModelId) =>
          (await import("/src/lib/api/settings.ts")).updateSettings({
            labelingModelId,
          }),
        separateProvider ? profileIds[1] : null,
      );
      const placeholder = `Private initial conversation ${index}`;
      const chat = standalone
        ? await api("createStandaloneChat", placeholder, true)
        : await api(
            "createChat",
            projectId,
            placeholder,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            true,
          );
      entry.chatId = chat.id;
      await page.evaluate(
        (chatId) => window.folderLive.retainScope({ kind: "chat", chatId }),
        chat.id,
      );
      if (standalone)
        await eventually(
          () => readWire(kind, chat.id),
          ({ wire }) => assert.ok(wire.activeScratchRootId),
        );
      else
        await eventually(
          () =>
            page.evaluate(
              async (chatId) =>
                (await window.folderRequest(`/api/chats/${chatId}/preparation`))
                  .preparation,
              chat.id,
            ),
          (preparation) =>
            assert.ok(
              ["console", "ready"].includes(preparation?.phase) ||
                (preparation?.phase === "failed" &&
                  preparation.failedPhase === "console"),
              "the Agent thread is usable, including during optional console preparation",
            ),
        );
      const initial = await readWire(kind, chat.id);
      assert.equal(initial.title, placeholder);
      const prompt = `Private first-turn question ${index} 🍐`;
      const answer = `Private first-turn response ${index} 🍊`;
      const activeLabelModel = separateProvider ? labelModel : responseModel;
      const before = [posts(responseModel).length, posts(labelModel).length];
      const label = activeLabelModel.reply({
        text: title
          ? `Title: ${title} later.\nIgnore this second line.`
          : "...",
        hold: true,
      });
      const response = responseModel.reply({ text: answer });
      entry.phase = "first turn";
      const [refresh, admitted] = await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname.endsWith("/encryption/refresh") &&
            response.request().method() === "POST" &&
            response.request().postDataJSON()?.component ===
              "private-surface-metadata",
        ),
        page.evaluate(
          async ({ chatId, prompt, configuration, workerId, standalone }) => {
            const { startTurn } = await import("/src/lib/api/chats.ts");
            const { getWorkers } = await import("/src/lib/api/worker-wire.ts");
            const { CantripApiError } = await import("/src/lib/api-client.ts");
            const worker = (await getWorkers()).find(
              (candidate) => candidate.workerId === workerId,
            );
            if (!worker?.online)
              throw new Error("Expected the online Chat worker.");
            const deadline = Date.now() + 10000;
            for (;;) {
              try {
                return await startTurn(
                  chatId,
                  prompt,
                  configuration,
                  [],
                  "default",
                  worker,
                );
              } catch (error) {
                if (
                  !standalone ||
                  !(error instanceof CantripApiError) ||
                  error.code !== "standalone-scratch-unavailable" ||
                  !error.message.includes("still being prepared") ||
                  Date.now() >= deadline
                )
                  throw error;
                await new Promise((resolve) => setTimeout(resolve, 50));
              }
            }
          },
          { chatId: chat.id, prompt, configuration, workerId, standalone },
        ),
      ]);
      entry.grantStatus = refresh.status();
      assert.equal(entry.grantStatus, 200);
      entry.admittedStatus = admitted.status;
      assert.equal(admitted.status, "queued");
      assert.equal(admitted.prompt.text, prompt);
      await eventually(
        () => label.request,
        (request) => assert.ok(request, diagnostics().slice(-8000)),
      );
      assert.equal(response.entered, false);
      assert.deepEqual(label.request.input.tools, []);
      assert.deepEqual(
        label.request.input.input.map(({ role }) => role),
        ["developer", "user"],
      );
      const [instructions, input] = label.request.input.input;
      assert.match(instructions.content[0].text, /THREE WORDS/u);
      assert.deepEqual(JSON.parse(input.content[0].text), {
        initialRequest: prompt,
      });
      assert.deepEqual(
        (await readWire(kind, chat.id)).wire.titleProtection,
        initial.wire.titleProtection,
      );
      const eventOffset = await page.evaluate(() => window.folderEvents.length);
      label.release();
      entry.phase = "canonical response";
      const messages = await eventually(
        () => api("getMessages", chat.id),
        (rows) => {
          const visible = rows
            .filter(({ role }) => role === "assistant")
            .flatMap(({ content }) => content)
            .filter(({ text }) => text === answer);
          entry.replyEvidence = visible.map(({ correlation, streaming }) => ({
            correlation,
            streaming,
          }));
          assert.equal(visible.length, 1);
          const [{ correlation, streaming }] = visible;
          assert.equal(streaming, standalone ? undefined : false);
          assert.ok(correlation?.threadId && correlation.turnId);
          assert.equal(
            correlation.sourceMethod,
            standalone ? "item/completed" : "native-history",
          );
        },
      );
      assert.ok(JSON.stringify(messages).includes(prompt));
      assert.equal(response.request.completed, true);
      assert.equal(label.request.completed, true);
      assert.deepEqual(
        [
          posts(responseModel).length - before[0],
          posts(labelModel).length - before[1],
        ],
        separateProvider ? [1, 1] : [2, 0],
      );
      entry.phase = "title persistence";
      const saved = await eventually(
        () => readWire(kind, chat.id),
        (row) => {
          assert.equal(row.wire.status, "idle");
          assert.equal(row.title, title ?? placeholder);
        },
        10000,
      );
      assert.equal("title" in saved.wire, false);
      assert.ok(saved.wire.titleProtection.protectedLabel.envelope.ciphertext);
      if (title) {
        assert.notDeepEqual(
          saved.wire.titleProtection,
          initial.wire.titleProtection,
        );
        entry.invalidation = await eventually(
          () =>
            page.evaluate(
              ({ eventOffset, chatId }) =>
                window.folderEvents
                  .slice(eventOffset)
                  .find(
                    (event) =>
                      event.resource === "chat" &&
                      event.action === "invalidated" &&
                      event.entityId === chatId &&
                      event.payload === null,
                  ),
              { eventOffset, chatId: chat.id },
            ),
          (event) => assert.ok(event, "initial title invalidates the chat"),
        );
      } else
        assert.deepEqual(
          saved.wire.titleProtection,
          initial.wire.titleProtection,
        );
      const publicChats = standalone
        ? await api("getStandaloneChats")
        : await api("getChats", projectId);
      assert.equal(
        publicChats.find(({ id }) => id === chat.id).title,
        title ?? placeholder,
      );
      for (const marker of [prompt, answer, title ?? placeholder])
        assert.ok(!diagnostics().includes(marker));
      Object.assign(entry, {
        phase: "complete",
        label: saved.wire.titleProtection,
      });
      summaries.push({
        kind,
        separateProvider,
        title: saved.title,
        responseCompleted: true,
      });
    }
    assert.deepEqual(responseModel.failures, []);
    assert.deepEqual(labelModel.failures, []);
    assert.match(diagnostics(), /operation=chat\.scratch\.provision /u);
    assert.doesNotMatch(diagnostics(), /operation=chat\.scratch\.resolve /u);
    assert.doesNotMatch(diagnostics(), /operation=label\.generate /u);
    await page.evaluate(() => window.folderLive.stop());
    await stopWorker();
    const restart = await fixture.restart();
    assert.notEqual(restart.before.pid, restart.after.pid);
    for (const [
      index,
      { kind, chatId, label },
    ] of observation.cases.entries()) {
      const reopened = await readWire(kind, chatId);
      assert.deepEqual(reopened.wire.titleProtection, label);
      assert.equal(reopened.title, summaries[index].title);
      assert.ok(
        JSON.stringify(await api("getMessages", chatId)).includes(
          `Private first-turn response ${index} 🍊`,
        ),
      );
    }
    Object.assign(observation, { restart, summary: summaries });
    result.steps.push(
      "full worker runs first-turn labels before Agent and standalone Chat replies, preserves an unusable-title fallback, and reopens exact title envelopes",
    );
  } finally {
    observation.modelRequests = [responseModel.requests, labelModel.requests];
    observation.modelFailures = [responseModel.failures, labelModel.failures];
    await responseModel.close();
    await labelModel.close();
  }
}
