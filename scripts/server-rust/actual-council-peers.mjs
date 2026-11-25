import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { projectToolOutput } from "./actual-council-project-creation.mjs";
import { eventually } from "./full-worker.mjs";
import { taskModelProvider } from "./task-model-provider.mjs";

const timeout = 60_000;
const complete = (plan) =>
  eventually(
    () => plan.request?.completed,
    (done) => assert.equal(done, true),
    timeout,
  );

export async function actualCouncilPeers({
  page,
  chatId,
  configuration,
  appOrigin,
  model,
  tools,
  submit,
  readChat,
  readMessages,
  result,
}) {
  const send = tools.find(
    ({ name }) =>
      name === "council_peer_send" || name.endsWith("__council_peer_send"),
  );
  assert.ok(send, "Council exposes the native peer tool");
  const peer = await taskModelProvider({ observeStreams: true });
  const peerTitle = "Disposable Council Reviewer";
  const primaryTitle = "Disposable Operations Agent";
  const forward = "Council handoff from Operations to Reviewer 🌲";
  const reverse = "Council handoff from Reviewer to Operations 🍄";
  const original = "Keep the reviewer busy when the first handoff arrives.";
  try {
    await eventually(
      readChat,
      (chat) => assert.equal(chat.status, "idle"),
      timeout,
    );
    const receiver = await page.evaluate(
      async ({ baseUrl, modelName, peerTitle, sourceConfiguration }) => {
        const council = await import("/src/lib/api/council.ts");
        const models = await import("/src/lib/api/models.ts");
        const settings = await import("/src/lib/api/settings.ts");
        const provider = await models.createModelProvider({
          name: "Council reviewer fixture",
          kind: "openai-compatible",
          baseUrl,
          apiKey: null,
        });
        const profile = await models.createModelProfile({
          name: "Council reviewer route",
          routes: [{ providerId: provider.id, modelName, enabled: true }],
        });
        await settings.updateSettings({ defaultCouncilModelId: profile.id });
        const agent = await council.createCouncilAgent(
          peerTitle,
          "Review work and address requested handoffs.",
        );
        await settings.updateSettings({
          defaultCouncilModelId: sourceConfiguration.modelId,
        });
        return {
          id: agent.id,
          configuration: { ...sourceConfiguration, modelId: profile.id },
        };
      },
      {
        baseUrl: peer.baseUrl,
        modelName: peer.model,
        peerTitle,
        sourceConfiguration: configuration,
      },
    );

    const readPeer = () =>
      page.evaluate(
        async (id) => (await import("/src/lib/api/chats.ts")).getMessages(id),
        receiver.id,
      );
    const readPeerChat = () =>
      page.evaluate(
        async (id) =>
          (await import("/src/lib/api/council.ts")).getCouncilChat(id),
        receiver.id,
      );
    const submitPeer = (text) =>
      page.evaluate(
        async ({ receiver, text }) =>
          (await import("/src/lib/api/chats.ts")).startTurn(
            receiver.id,
            text,
            receiver.configuration,
          ),
        { receiver, text },
      );

    const held = peer.reply({ hold: true, text: "Review started." });
    const continued = peer.reply({
      text: "The review incorporated the handoff.",
      onlyFor: ({ input }) => JSON.stringify(input).includes(forward),
    });
    assert.equal((await submitPeer(original)).status, "queued");
    await eventually(
      () => held.entered,
      (entered) => assert.equal(entered, true),
      timeout,
    );
    const proposal = {
      recipientAgentId: receiver.id,
      operationId: randomUUID(),
      message: forward,
    };
    const firstCall = { ...send, arguments: proposal };
    model.reply({ responseId: "council-peer-first", calls: [firstCall] });
    const duplicate = model.reply({
      responseId: "council-peer-retry",
      calls: [firstCall],
    });
    const sent = model.reply({ text: "I sent the review handoff." });
    const sendRequest = "Send the handoff and retry it once.";
    assert.equal((await submit(sendRequest)).status, "queued");
    await complete(sent);
    const receipt = projectToolOutput(duplicate, "council-peer-first-call-0");
    assert.equal(receipt.recipientAgentId, receiver.id);
    assert.deepEqual(
      projectToolOutput(sent, "council-peer-retry-call-0"),
      receipt,
    );

    await eventually(
      readPeer,
      (messages) => {
        const root = messages.find(({ content }) =>
          content.some(({ text }) => text === original),
        );
        const inputs = messages.filter(
          ({ id }) => id === receipt.inputMessageId,
        );
        assert.equal(inputs.length, 1);
        assert.ok(root?.executionLaneId);
        assert.equal(inputs[0].executionLaneId, root.executionLaneId);
        assert.equal(
          inputs[0].content[0].councilPeerMessage.operationId,
          proposal.operationId,
        );
        assert.equal(held.request.completed, false);
      },
      timeout,
    );
    held.release();
    await complete(continued);
    assert.ok(
      JSON.stringify(continued.request.input.input).includes(primaryTitle),
    );
    assert.ok(JSON.stringify(continued.request.input.input).includes(forward));
    await eventually(
      readPeerChat,
      (chat) => assert.equal(chat.status, "idle"),
      timeout,
    );
    await eventually(
      readChat,
      (chat) => assert.equal(chat.status, "idle"),
      timeout,
    );
    assert.equal(
      model.requests.filter(({ method }) => method === "POST").length,
      5,
      "The unaddressed review response does not wake Operations",
    );

    const reply = {
      recipientAgentId: chatId,
      operationId: randomUUID(),
      message: reverse,
    };
    peer.reply({
      responseId: "council-peer-reverse",
      calls: [{ ...send, arguments: reply }],
    });
    const replied = peer.reply({
      text: "I sent the review result to Operations.",
    });
    const received = model.reply({
      text: "Operations received the peer result.",
      onlyFor: ({ input }) => JSON.stringify(input).includes(reverse),
    });
    assert.equal(
      (await submitPeer("Address the review result to Operations.")).status,
      "queued",
    );
    await complete(replied);
    await complete(received);
    const replyReceipt = projectToolOutput(
      replied,
      "council-peer-reverse-call-0",
    );
    await eventually(
      readMessages,
      (messages) => {
        const inputs = messages.filter(
          ({ id }) => id === replyReceipt.inputMessageId,
        );
        assert.equal(inputs.length, 1);
        assert.equal(
          inputs[0].content[0].councilPeerMessage.operationId,
          reply.operationId,
        );
        assert.equal(
          messages.filter(({ id }) => id === receipt.messageId).length,
          1,
        );
      },
      timeout,
    );

    const before = await page.evaluate(
      async ({ chatId, peerId }) => {
        const api = await import("/src/lib/api/council-history.ts");
        const path = `/api/council/agents/${chatId}/peers/${peerId}`;
        return {
          one: await api.readCouncilPeerPage(chatId, peerId, null),
          two: await api.readCouncilPeerPage(peerId, chatId, null),
          wire: await window.folderRequest(path),
          invalid: await window
            .folderRequest(path + "?before=" + crypto.randomUUID())
            .then(
              () => false,
              (error) => error.status === 404,
            ),
        };
      },
      { chatId, peerId: receiver.id },
    );
    assert.deepEqual(before.one, before.two);
    assert.deepEqual(
      before.one.messages.map(({ id, text }) => ({ id, text })),
      [
        { id: replyReceipt.messageId, text: reverse },
        { id: receipt.messageId, text: forward },
      ],
    );
    assert.equal(before.invalid, true);
    assert.equal(before.one.incomplete, false);
    assert.equal(before.one.nextBefore, null);
    assert.ok(
      before.wire.messages.every((message) => message.protectedContent),
    );
    assert.ok(!JSON.stringify(before.wire).includes(forward));
    assert.ok(!JSON.stringify(before.wire).includes(reverse));
    const senderInput = (await readMessages()).find(
      ({ role, content }) =>
        role === "user" && content.some(({ text }) => text === sendRequest),
    );
    assert.ok(senderInput?.id);
    const firstEvidence = before.one.messages.find(
      ({ id }) => id === receipt.messageId,
    );
    assert.equal(firstEvidence.senderHistoryId, senderInput.id);
    assert.equal(firstEvidence.recipientHistoryId, receipt.inputMessageId);

    await page.setViewportSize({ width: 1344, height: 900 });
    await page.goto(appOrigin);
    const mode = page
      .getByRole("button", { name: /switch cantrip mode/iu })
      .first();
    await mode.click();
    await page.getByRole("menuitem", { name: "Cantrip Council" }).click();
    const roster = page.getByRole("navigation", { name: "Council agents" });
    await roster
      .getByRole("button", { name: /Disposable Operations Agent/u })
      .click();
    const handoff = page.getByRole("link", {
      name: "Received from Council agent",
    });
    await handoff.waitFor();
    assert.equal(await page.getByText(reverse, { exact: true }).count(), 0);
    await handoff.click();
    const desktop = page.getByRole("dialog", {
      name: `${primaryTitle} and ${peerTitle}`,
    });
    await desktop.getByText(forward, { exact: true }).waitFor();
    await desktop.getByText(reverse, { exact: true }).waitFor();
    const record = desktop.locator(
      `[data-council-peer-message="${receipt.messageId}"]`,
    );
    const sourceLink = async (name) =>
      new URL(
        await record
          .getByRole("link", { name, exact: true })
          .getAttribute("href"),
        page.url(),
      ).searchParams;
    const senderLink = await sourceLink("Sender’s history");
    assert.equal(senderLink.get("councilAgent"), chatId);
    assert.equal(senderLink.get("message"), senderInput.id);
    const recipientLink = await sourceLink("Recipient’s history");
    assert.equal(recipientLink.get("councilAgent"), receiver.id);
    assert.equal(recipientLink.get("message"), receipt.inputMessageId);
    await desktop.getByRole("button", { name: "Close" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Back to Council agents" }).click();
    await roster.getByRole("button", { name: peerTitle }).click();
    await page
      .getByRole("link", { name: "Received from Council agent" })
      .click();
    const mobile = page.getByRole("dialog", {
      name: `${peerTitle} and ${primaryTitle}`,
    });
    await mobile.getByText(forward, { exact: true }).waitFor();
    await mobile.getByText(reverse, { exact: true }).waitFor();
    await mobile.getByRole("button", { name: "Close" }).click();
    assert.deepEqual(model.failures, []);
    assert.deepEqual(peer.failures, []);
    result.councilPeerMessages = { first: receipt, reply: replyReceipt };
    result.steps.push(
      "Council peers address idle and active Codex sessions, retry once, and open the same encrypted pair history at desktop and mobile widths",
    );
    await actualCouncilPeerLineage({
      page,
      model,
      peer,
      tool: send,
      chatId,
      peerId: receiver.id,
      submit,
      readChat,
      readPeerChat,
      result,
    });
  } finally {
    await peer.close();
  }
}

async function actualCouncilPeerLineage({
  page,
  model,
  peer,
  tool,
  chatId,
  peerId,
  submit,
  readChat,
  readPeerChat,
  result,
}) {
  await eventually(
    readChat,
    (chat) => assert.equal(chat.status, "idle"),
    timeout,
  );
  await eventually(
    readPeerChat,
    (chat) => assert.equal(chat.status, "idle"),
    timeout,
  );
  const completed = [];
  for (let hop = 1; hop <= 13; hop += 1) {
    const source = hop % 2 ? model : peer;
    const recipientAgentId = hop % 2 ? peerId : chatId;
    const responseId = `council-peer-chain-${hop}`;
    source.reply({
      responseId,
      calls: [
        {
          ...tool,
          arguments: {
            recipientAgentId,
            operationId: randomUUID(),
            message: `Continue the Council handoff chain at hop ${hop}.`,
          },
        },
      ],
    });
    completed.push(
      source.reply({ text: `Council processed chain hop ${hop}.` }),
    );
  }
  assert.equal(
    (await submit("Start a new Council handoff chain.")).status,
    "queued",
  );
  const stop = completed.at(-1);
  await complete(stop);
  const refusal = stop.request.input.input.find(
    ({ type, call_id }) =>
      type === "function_call_output" &&
      call_id === "council-peer-chain-13-call-0",
  );
  assert.match(
    JSON.stringify(refusal),
    /Council handoff reached its run limit/iu,
  );
  for (const [index, response] of completed.slice(0, 12).entries()) {
    assert.equal(
      projectToolOutput(response, `council-peer-chain-${index + 1}-call-0`)
        .delivery,
      "queued",
    );
  }
  await eventually(
    readChat,
    (chat) => assert.equal(chat.status, "idle"),
    timeout,
  );
  await eventually(
    readPeerChat,
    (chat) => assert.equal(chat.status, "idle"),
    timeout,
  );

  const fresh = "A different request can start a new peer chain.";
  model.reply({
    responseId: "council-peer-chain-reset",
    calls: [
      {
        ...tool,
        arguments: {
          recipientAgentId: peerId,
          operationId: randomUUID(),
          message: fresh,
        },
      },
    ],
  });
  const restarted = model.reply({ text: "I started a new peer chain." });
  const received = peer.reply({ text: "The new peer chain arrived." });
  assert.equal(
    (await submit("Start fresh after the earlier chain limit.")).status,
    "queued",
  );
  await complete(restarted);
  await complete(received);
  assert.equal(
    projectToolOutput(restarted, "council-peer-chain-reset-call-0").delivery,
    "queued",
  );
  assert.ok(JSON.stringify(received.request.input.input).includes(fresh));

  const pageData = await page.evaluate(
    async ({ chatId, peerId }) =>
      (await import("/src/lib/api/council-history.ts")).readCouncilPeerPage(
        chatId,
        peerId,
        null,
      ),
    { chatId, peerId },
  );
  assert.equal(
    pageData.messages.filter(({ text }) =>
      text.startsWith("Continue the Council handoff chain"),
    ).length,
    12,
  );
  assert.equal(
    pageData.messages.filter(({ text }) => text === fresh).length,
    1,
  );
  assert.deepEqual(model.failures, []);
  assert.deepEqual(peer.failures, []);
  result.steps.push(
    "The pair thread linked exact sender and recipient evidence. A real native 12-hop chain rejected hop 13, and a new user turn started a fresh chain.",
  );
}
