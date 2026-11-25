import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eventually } from "./full-worker.mjs";

export async function actualCouncilProjectApprovals({
  page,
  model,
  target,
  submit,
  idle,
  sender,
  councilId,
  targetChatId,
  projectId,
  targetProfileId,
  send,
  targetTools,
  steer = false,
  result,
}) {
  const api = (operation, ...args) =>
    page.evaluate(
      async ({ operation, args }) =>
        (await import("/src/lib/api/chats.ts"))[operation](...args),
      { operation, args },
    );
  const pending = (filter) =>
    api("getAgentInteractionRequests", { ...filter, status: "pending" });
  const configuration = {
    modelId: targetProfileId,
    reasoningEffort: null,
    customSubagentModel: false,
    subagentModelId: null,
    subagentReasoningEffort: null,
  };
  const command = targetTools.find(({ name }) => name === "exec_command");
  assert.ok(command, "The native project runtime exposes its command tool");
  await page.evaluate(async (chatId) => {
    const { getClientSessionIdentitySnapshot } =
      await import("/src/lib/client-session.ts");
    const { readNativeSettingsState } =
      await import("/src/lib/native-settings-api.ts");
    const { sendNativePermissionUpdate } =
      await import("/src/lib/native-permission-update.ts");
    const { getChatPermissionProfiles } = await import("/src/lib/api/chats.ts");
    const identity = getClientSessionIdentitySnapshot();
    const { binding } = await readNativeSettingsState({
      chatId,
      identity,
      refresh: true,
    });
    const { policyRevision } = await getChatPermissionProfiles(chatId);
    await sendNativePermissionUpdate({
      chatId,
      identity,
      request: {
        id: ":workspace",
        bindingId: binding.bindingId,
        expectedRevision: policyRevision,
        operationId: crypto.randomUUID(),
      },
    });
  }, targetChatId);
  await eventually(
    () => api("getChatPermissionProfiles", targetChatId),
    ({ effectiveId }) => assert.equal(effectiveId, ":workspace"),
    30_000,
  );
  const requestCommand = (marker) =>
    target.reply({
      calls: [
        {
          ...command,
          arguments: {
            cmd: "printf " + marker,
            login: false,
            sandbox_permissions: "require_escalated",
            justification: "Run a harmless project approval probe.",
            max_output_tokens: 300,
          },
        },
      ],
    });
  const originalPrompt =
    "Start an independent turn before the Council approval probe.";
  const delivery = "Run the harmless approval probe in the project chat.";
  const active = steer
    ? target.reply({
        hold: true,
        text: "The original project turn is working.",
      })
    : null;
  if (active) {
    assert.equal(
      (await api("startTurn", targetChatId, originalPrompt, configuration))
        .status,
      "queued",
    );
    await eventually(
      () => active.entered,
      (entered) => assert.equal(entered, true),
      60_000,
    );
  }
  const first = requestCommand("Council-approved-project-output");
  const finished = target.reply({
    text: "The project approval probe finished.",
  });
  model.reply({
    calls: [
      {
        ...send,
        arguments: {
          projectId,
          chatId: targetChatId,
          operationId: randomUUID(),
          message: delivery,
          ...(steer && { steer: true }),
        },
      },
    ],
  });
  model.reply({ text: "I delegated the approval probe." });
  const forwarded = model.reply({
    text: "The project is waiting for your approval.",
  });
  try {
    await submit("Delegate a new approval probe to the project chat.");
    await idle();
    if (active) {
      await eventually(
        () => api("getMessages", targetChatId),
        (messages) => {
          const inputs = messages.filter(({ role }) => role === "user");
          const original = inputs.find(({ content }) =>
            content.some(({ text }) => text === originalPrompt),
          );
          const steering = inputs.find(({ content }) =>
            content.some(({ text }) => text === delivery),
          );
          assert.ok(original?.executionLaneId);
          assert.equal(steering?.executionLaneId, original.executionLaneId);
          assert.equal(active.request.completed, false);
        },
        60_000,
      );
    }
  } finally {
    active?.release();
  }
  const [original] = await eventually(
    () => pending({ chatId: targetChatId }),
    (requests) =>
      assert.equal(requests.length, 1, JSON.stringify(target.failures)),
    60_000,
  );
  assert.ok(first.entered);
  assert.equal(original.payload.kind, "commandExecution");
  const delegated = await eventually(
    () => pending({ councilAgentId: councilId }),
    (requests) => assert.equal(requests.length, 1),
    20_000,
  );
  assert.deepEqual(delegated, [original]);
  await eventually(
    () => forwarded.request?.completed,
    (complete) => assert.equal(complete, true, JSON.stringify(model.failures)),
    60_000,
  );
  const prompt = JSON.stringify(forwarded.request.input.input);
  assert.ok(prompt.includes("Run a harmless project approval probe."));
  assert.match(prompt, /waiting for a human to answer its command approval/u);
  const messages = await eventually(
    () => api("getMessages", councilId),
    (items) =>
      assert.equal(
        items.filter(({ content }) =>
          content.some(
            (item) => item.councilProjectRequest?.chatId === targetChatId,
          ),
        ).length,
        1,
      ),
    20_000,
  );
  const [forwardedInput] = messages.flatMap(({ content }) =>
    content.filter(
      (item) => item.councilProjectRequest?.chatId === targetChatId,
    ),
  );
  assert.equal(forwardedInput.councilProjectRequest.requestId, original.id);
  assert.equal(forwardedInput.text, "Project request");
  assert.equal((await pending({ chatId: targetChatId }))[0].id, original.id);
  const readResult = model.reply({
    text: "I received the result after approval.",
  });

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
  const councilConversation = page.locator(
    '[data-slot="council-conversation"]',
  );
  const forwardedLink = councilConversation.locator(
    `[data-slot="council-project-request"][href*="request=${original.id}"]`,
  );
  await forwardedLink.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(
    new URL(
      await forwardedLink.getAttribute("href"),
      page.url(),
    ).searchParams.get("request"),
    original.id,
  );
  assert.equal(
    await councilConversation
      .getByText("Run a harmless project approval probe.", { exact: true })
      .filter({ visible: true })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "Project requests (1)" }).click();
  const panel = page.getByRole("dialog", { name: "Project requests" });
  const card = panel.locator(`[data-interaction-request-id="${original.id}"]`);
  const href = await card
    .getByRole("link", { name: "Open in project chat" })
    .getAttribute("href");
  const source = new URL(href, page.url());
  assert.equal(source.searchParams.get("request"), original.id);
  assert.equal(source.searchParams.get("projectChat"), targetChatId);
  const response = page.waitForResponse(
    (reply) =>
      reply.request().method() === "POST" &&
      new URL(reply.url()).pathname ===
        `/api/agent-requests/${original.id}/respond`,
  );
  await card.getByRole("button", { name: "Allow once", exact: true }).click();
  const accepted = await response;
  assert.equal(accepted.status(), 200, await accepted.text());
  assert.equal((await accepted.json()).id, original.id);
  await eventually(
    () => finished.request?.completed,
    (complete) => assert.equal(complete, true),
    60_000,
  );
  assert.ok(
    JSON.stringify(finished.request.input.input).includes(
      "Council-approved-project-output",
    ),
  );
  await eventually(
    () => readResult.request?.completed,
    (complete) => assert.equal(complete, true),
    60_000,
  );
  await panel
    .getByText("No pending project requests.")
    .waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await idle();

  const sourceTurns = () =>
    model.requests.filter(({ method }) => method === "POST").length;
  const sourceRequests = sourceTurns();
  requestCommand("Council-unrelated-project-output");
  const next = await api(
    "startTurn",
    targetChatId,
    "Make an independent harmless approval request.",
    configuration,
  );
  assert.equal(next.status, "queued");
  const [unrelated] = await eventually(
    () => pending({ chatId: targetChatId }),
    (requests) => assert.equal(requests.length, 1),
    60_000,
  );
  assert.notEqual(unrelated.id, original.id);
  assert.deepEqual(await pending({ councilAgentId: councilId }), []);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(sourceTurns(), sourceRequests);
  await panel.waitFor({ state: "hidden" });
  assert.equal(
    await page.getByRole("button", { name: /Project requests/u }).count(),
    0,
  );
  result.councilProjectApproval = {
    requestId: original.id,
    turnId: original.provenance.turnId,
    targetChatId,
    unrelatedRequestId: unrelated.id,
    steered: steer,
  };
  result.steps.push(
    steer
      ? "An approval raised after a Council steer on an independently started native turn reached Council once. A later unrelated turn's approval stayed in the project chat."
      : "The original project approval prompted Council once and waited for a human response. An independent turn's approval stayed in the project chat.",
  );
}
