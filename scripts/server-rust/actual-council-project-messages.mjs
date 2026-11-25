import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  councilAgentLink,
  councilProjectResultLink,
  uniqueChatCommunicationMessages,
} from "../../packages/protocol/dist/index.js";
import { eventually } from "./full-worker.mjs";
import { modelFunctions, taskModelProvider } from "./task-model-provider.mjs";
import { actualCouncilProjectApprovals } from "./actual-council-project-approvals.mjs";
import { actualCouncilProjectCreation } from "./actual-council-project-creation.mjs";
import { actualCouncilProjectControls } from "./actual-council-project-controls.mjs";
import { actualCouncilProjectSteering } from "./actual-council-project-steering.mjs";
import { actualCouncilTaskApprovals } from "./actual-council-task-approvals.mjs";

export async function actualCouncilProjectMessages({
  page,
  model,
  tools,
  submit,
  readChat,
  result,
  projectId,
  councilId,
  targetChatId,
  targetWorkerId,
  workerId,
  projectApprovals,
  projectCreation,
  projectControls,
  projectSteering,
  steerRaceMarker,
}) {
  const target = await taskModelProvider({ observeStreams: projectControls });
  const prepareText = "Open the existing project chat on its worker.";
  const delegatedText = "Verify the Council handoff is delivered once 🍄.";
  const answer = "The project worker received the Council handoff.";
  const sender = "Disposable Operations Agent";
  const expectedPermission = ":read-only";
  const idle = () =>
    eventually(readChat, (chat) => assert.equal(chat.status, "idle"), 60_000);
  const readMessages = (chatId) =>
    page.evaluate(
      async (chat) => (await import("/src/lib/api/chats.ts")).getMessages(chat),
      chatId,
    );
  const read = () => readMessages(targetChatId);
  const resultInputs = async () =>
    (await readMessages(councilId)).flatMap((message) =>
      message.content.flatMap((item) =>
        item.type === "text" && item.councilProjectResult
          ? [{ message, text: item.text, source: item.councilProjectResult }]
          : [],
      ),
    );
  try {
    const initial = target.reply({
      text: "The existing project chat is ready.",
    });
    const ready = await page.evaluate(
      async ({
        baseUrl,
        nativeModel,
        targetChatId,
        targetWorkerId,
        prepareText,
        expectedPermission,
      }) => {
        const models = await import("/src/lib/api/models.ts");
        const provider = await models.createModelProvider({
          name: "Disposable project provider",
          kind: "openai-compatible",
          baseUrl,
          apiKey: null,
        });
        const profile = await models.createModelProfile({
          name: "Disposable project model",
          routes: [
            { providerId: provider.id, modelName: nativeModel, enabled: true },
          ],
        });
        await (
          await import("/src/lib/api/settings.ts")
        ).updateSettings({ defaultModelId: profile.id });
        const workers = await (
          await import("/src/lib/api/worker-wire.ts")
        ).getWorkers();
        const worker = workers.find(
          ({ workerId }) => workerId === targetWorkerId,
        );
        await (
          await import("/src/lib/chat-worker-encryption.ts")
        ).ensureChatWorkerEncryption({ worker });
        const api = await import("/src/lib/api/chats.ts");
        await api.updateChatPermissionProfile(targetChatId, expectedPermission);
        const receipt = await api.startTurn(targetChatId, prepareText, {
          modelId: profile.id,
          reasoningEffort: null,
          customSubagentModel: false,
          subagentModelId: null,
          subagentReasoningEffort: null,
        });
        return { receipt, profileId: profile.id };
      },
      {
        baseUrl: target.baseUrl,
        nativeModel: target.model,
        targetChatId,
        targetWorkerId,
        prepareText,
        expectedPermission,
      },
    );
    assert.equal(ready.receipt.status, "queued");
    await eventually(
      () => initial.request?.completed,
      (complete) => assert.equal(complete, true),
      60_000,
    );
    await eventually(
      read,
      (messages) =>
        assert.ok(
          messages.some(({ content }) =>
            content.some(
              ({ text }) => text === "The existing project chat is ready.",
            ),
          ),
        ),
      60_000,
    );

    const send = tools.find(
      ({ name }) =>
        name === "council_project_send" ||
        name.endsWith("__council_project_send"),
    );
    assert.ok(send);
    const operationId = randomUUID();
    const args = {
      operationId,
      projectId,
      chatId: targetChatId,
      message: delegatedText,
    };
    const signal = (key, input = args) =>
      model.reply({
        responseId: `council-project-${key}`,
        calls: [{ ...send, arguments: input }],
      });
    signal("first");
    const duplicate = signal("retry");
    const done = model.reply({ text: "I sent the work to the project chat." });
    const remote = target.reply({ hold: true, text: answer });
    assert.equal(
      (
        await submit(
          "Send this brief to the existing project chat, then retry the same delivery.",
        )
      ).status,
      "queued",
    );
    await eventually(
      () => done.entered,
      (entered) => assert.ok(entered, JSON.stringify(model.failures)),
      60_000,
    );
    const delivery = (plan, key) => {
      const item = plan.request.input.input.find(
        ({ type, call_id }) =>
          type === "function_call_output" &&
          call_id === `council-project-${key}-call-0`,
      );
      assert.ok(item, `Missing Council delivery ${key}`);
      const text =
        typeof item.output === "string"
          ? item.output
          : item.output.map(({ text }) => text).join("\n");
      const parts = text.split("\nOutput:\n");
      assert.equal(parts.length, 2, text);
      const { data } = JSON.parse(parts[1]);
      assert.ok(data, text);
      return data;
    };
    const receipt = delivery(duplicate, "first");
    assert.deepEqual(delivery(done, "retry"), receipt);
    assert.equal(receipt.sourceChatId, councilId);
    assert.equal(receipt.operationId, operationId);
    assert.equal(receipt.chatId, targetChatId);
    await idle();
    const callback = model.reply({ text: "I received the project result." });
    remote.release();
    const messages = await eventually(
      read,
      (messages) =>
        assert.ok(
          messages.some(({ content }) =>
            content.some(({ text }) => text === answer),
          ),
        ),
      60_000,
    );
    const incoming = messages.filter(
      ({ id, role, content }) =>
        id === receipt.inputMessageId &&
        role === "user" &&
        content.some(({ text }) => text === delegatedText),
    );
    assert.equal(incoming.length, 1);
    assert.ok(incoming[0].executionLaneId);
    assert.ok(
      incoming[0].content.some(
        ({ chatCommunication }) =>
          chatCommunication?.senderKind === "council" &&
          chatCommunication.sourceTitle === sender,
      ),
    );
    assert.deepEqual(
      uniqueChatCommunicationMessages(messages)
        .filter(({ content }) =>
          content.some(
            ({ chatCommunication }) =>
              chatCommunication?.deliveryId === operationId,
          ),
        )
        .map(({ id }) => id),
      [receipt.inputMessageId],
    );
    const received = messages.filter(({ id }) => id === receipt.messageId);
    assert.equal(received.length, 1);
    assert.ok(
      received[0].content.some(
        ({ chatCommunication }) =>
          chatCommunication?.senderKind === "council" &&
          chatCommunication.sourceTitle === sender,
      ),
    );
    const prompt = JSON.stringify(remote.request?.input.input);
    assert.ok(prompt.includes(delegatedText) && prompt.includes(sender));
    assert.equal(
      target.requests.filter(({ method }) => method === "POST").length,
      2,
    );
    assert.deepEqual(target.failures, []);
    await idle();
    const permissions = await page.evaluate(
      async (chat) =>
        (await import("/src/lib/api/chats.ts")).getChatPermissionProfiles(chat),
      targetChatId,
    );
    assert.equal(permissions.effectiveId, expectedPermission);
    await eventually(
      () => callback.request?.completed,
      (complete) =>
        assert.equal(complete, true, JSON.stringify(model.failures)),
      60_000,
    );
    const records = await eventually(
      resultInputs,
      (inputs) => assert.equal(inputs.length, 1),
      60_000,
    );
    const { source, text } = records[0];
    assert.equal(source.projectId, projectId);
    assert.equal(source.chatId, targetChatId);
    assert.equal(source.inputMessageId, receipt.inputMessageId);
    assert.equal(source.status, "completed");
    assert.ok(source.threadId && source.turnId);
    assert.equal(text, "Project result");
    assert.ok(JSON.stringify(callback.request.input.input).includes(answer));
    await idle();

    const unrelated = target.reply({ text: "This was a separate human turn." });
    const priorSourceRequests = model.requests.length;
    const independent = await page.evaluate(
      async ({ chat, profileId }) =>
        (await import("/src/lib/api/chats.ts")).startTurn(
          chat,
          "An unrelated human request",
          {
            modelId: profileId,
            reasoningEffort: null,
            customSubagentModel: false,
            subagentModelId: null,
            subagentReasoningEffort: null,
          },
        ),
      { chat: targetChatId, profileId: ready.profileId },
    );
    assert.equal(independent.status, "queued");
    await eventually(
      () => unrelated.request?.completed,
      (complete) => assert.equal(complete, true),
      60_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal((await resultInputs()).length, 1);
    assert.equal(model.requests.length, priorSourceRequests);
    assert.deepEqual(model.failures, []);

    const busyAnswer =
      "The second project result arrived during an active Council turn.";
    const busyRemote = target.reply({ hold: true, text: busyAnswer });
    signal("busy", {
      ...args,
      operationId: randomUUID(),
      message: "Deliver a result while Council is busy.",
    });
    const sentAgain = model.reply({ text: "The second brief is queued." });
    await submit("Send another brief and continue with other work.");
    await eventually(
      () => sentAgain.request?.completed,
      (complete) => assert.equal(complete, true),
      60_000,
    );
    const secondReceipt = delivery(sentAgain, "busy");
    await idle();

    const activePrompt = "Continue an independent Council briefing.";
    const held = model.reply({
      hold: true,
      text: "I am working on the briefing.",
    });
    await submit(activePrompt);
    try {
      await eventually(
        () => held.entered,
        (entered) => assert.ok(entered),
        60_000,
      );
      const continued = model.reply({
        text: "I added the second project result to the briefing.",
      });
      busyRemote.release();
      const callbacks = await eventually(
        resultInputs,
        (inputs) => assert.equal(inputs.length, 2),
        60_000,
      );
      const steered = callbacks.find(
        ({ source }) => source.inputMessageId === secondReceipt.inputMessageId,
      );
      assert.ok(steered);
      const activeInput = (await readMessages(councilId)).find(
        ({ role, content }) =>
          role === "user" && content.some(({ text }) => text === activePrompt),
      );
      assert.ok(activeInput?.executionLaneId);
      assert.equal(
        steered.message.executionLaneId,
        activeInput.executionLaneId,
      );
      assert.equal(held.request.completed, false);
      held.release();
      await eventually(
        () => continued.request?.completed,
        (complete) => assert.equal(complete, true),
        60_000,
      );
      assert.ok(
        JSON.stringify(continued.request.input.input).includes(busyAnswer),
      );
      await idle();
      assert.equal((await resultInputs()).length, 2);
      assert.deepEqual(model.failures, []);
    } finally {
      held.release();
      busyRemote.release();
    }

    await page.setViewportSize({ width: 1344, height: 900 });
    await page.goto(new URL("/", page.url()).href);
    await page
      .getByRole("button", { name: /switch cantrip mode/iu })
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Cantrip Council" }).click();
    await page
      .getByRole("navigation", { name: "Council agents" })
      .getByRole("button", { name: new RegExp(sender, "u") })
      .click();
    const link = page.locator(
      `[data-slot="council-project-result"][href="${councilProjectResultLink(source)}"]`,
    );
    await link.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.getByText(answer, { exact: true }).count(), 0);
    const openSource = async () => {
      await link.click();
      await page
        .locator(`[data-chat-message-id="${receipt.inputMessageId}"]`)
        .first()
        .waitFor({ state: "visible", timeout: 30_000 });
    };
    await openSource();
    const attribution = page
      .getByRole("link", { name: `Sent via ${sender}`, exact: true })
      .first();
    await attribution.waitFor({ state: "visible" });
    assert.equal(
      await attribution.getAttribute("href"),
      councilAgentLink(councilId),
    );

    result.councilProjectMessages = { targetWorkerId, projectId, ...receipt };
    result.councilProjectResult = source;
    result.steps.push(
      "Council retried one stable project delivery and the remote Worker ran one input with Council attribution and the chat's read-only permission",
    );
    result.steps.push(
      "The exact project result woke Council once, hid its internal prompt, and linked to the originating input. An unrelated project turn did not wake Council.",
    );
    result.steps.push(
      "A second project result steered the Council agent's existing native execution lane.",
    );
    if (projectCreation)
      await actualCouncilProjectCreation({
        page,
        model,
        target,
        tools,
        submit,
        idle,
        sender,
        councilId,
        projectId,
        workerId,
        targetWorkerId,
        targetProfileId: ready.profileId,
        result,
      });
    if (projectControls)
      await actualCouncilProjectControls({
        page,
        model,
        target,
        tools,
        submit,
        idle,
        councilId,
        projectId,
        targetChatId,
        targetProfileId: ready.profileId,
        result,
      });
    if (projectSteering)
      await actualCouncilProjectSteering({
        page,
        model,
        target,
        send,
        submit,
        idle,
        resultInputs,
        projectId,
        targetChatId,
        targetProfileId: ready.profileId,
        steerRaceMarker,
        result,
      });
    if (projectApprovals) {
      const targetTools = modelFunctions(initial.request.input.tools);
      if (projectCreation) {
        await actualCouncilTaskApprovals({
          page,
          model,
          target,
          submit,
          idle,
          councilId,
          projectId,
          tools,
          targetTools,
          result,
        });
      }
      await actualCouncilProjectApprovals({
        page,
        model,
        target,
        submit,
        idle,
        sender,
        councilId,
        targetChatId,
        projectId,
        targetProfileId: ready.profileId,
        send,
        targetTools,
        result,
      });
    }
  } finally {
    await target.close();
  }
}
