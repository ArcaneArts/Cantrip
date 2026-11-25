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
  const command = targetTools.find(({ name }) => name === "exec_command");
  assert.ok(command, "The native project runtime exposes its command tool");
  await page.getByRole("button", { name: /Agent permissions:/u }).click();
  await page.getByRole("menuitem", { name: /^Workspace\b/u }).click();
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
          message: "Run the harmless approval probe in the project chat.",
        },
      },
    ],
  });
  model.reply({ text: "I delegated the approval probe." });
  await submit("Delegate a new approval probe to the project chat.");
  await idle();
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

  requestCommand("Council-unrelated-project-output");
  const next = await api(
    "startTurn",
    targetChatId,
    "Make an independent harmless approval request.",
    {
      modelId: targetProfileId,
      reasoningEffort: null,
      customSubagentModel: false,
      subagentModelId: null,
      subagentReasoningEffort: null,
    },
  );
  assert.equal(next.status, "queued");
  const [unrelated] = await eventually(
    () => pending({ chatId: targetChatId }),
    (requests) => assert.equal(requests.length, 1),
    60_000,
  );
  assert.notEqual(unrelated.id, original.id);
  assert.deepEqual(await pending({ councilAgentId: councilId }), []);
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
  };
  result.steps.push(
    "A human resolved the original project approval from Council, and an independent turn's approval stayed in the project chat.",
  );
}
