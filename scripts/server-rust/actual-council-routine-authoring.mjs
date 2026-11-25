import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { projectToolOutput } from "./actual-council-project-creation.mjs";
import { eventually } from "./full-worker.mjs";

export async function actualCouncilRoutineAuthoring({
  page,
  appOrigin,
  chatId,
  model,
  tools,
  submit,
  readChat,
  result,
}) {
  const idle = () =>
    eventually(readChat, (chat) => assert.equal(chat.status, "idle"), 60_000);
  const tool = (name) => {
    const found = tools.find(
      (entry) => entry.name === name || entry.name.endsWith(`__${name}`),
    );
    assert.ok(found, `Expected managed tool ${name}.`);
    return found;
  };
  const call = (responseId, name, args) =>
    model.reply({
      responseId,
      calls: [{ ...tool(name), arguments: args }],
    });
  const approvals = new Set();
  const complete = (plan) =>
    eventually(
      async () => {
        if (plan.request?.completed) return true;
        const requests = await page.evaluate(
          async (id) =>
            (await import("/src/lib/api/chats.ts")).getAgentInteractionRequests(
              {
                chatId: id,
                status: "pending",
              },
            ),
          chatId,
        );
        const pending = requests.find(({ id }) => !approvals.has(id));
        if (pending) {
          assert.equal(pending.payload.kind, "mcpElicitation");
          assert.equal(pending.payload.serverName, "cantrip");
          await page.evaluate(
            async (id) =>
              (
                await import("/src/lib/api/chats.ts")
              ).respondToAgentInteractionRequest(id, {
                idempotencyKey: crypto.randomUUID(),
                response: {
                  kind: "mcpElicitation",
                  action: "accept",
                  content: {},
                  metadata: null,
                },
              }),
            pending.id,
          );
          approvals.add(pending.id);
        }
        return false;
      },
      (value) => assert.equal(value, true, JSON.stringify(model.failures)),
      60_000,
    );
  const name = "Operations briefing 🍃";
  const prompt = "Read the change log and give me the open decisions.";
  const edited = "Include the oldest unanswered decision and its source.";
  const createArgs = {
    operationId: randomUUID(),
    name,
    prompt,
    schedule: {
      kind: "weekly",
      weekdays: [2, 1, 2],
      hour: 9,
      minute: 30,
      timeZone: "America/Chicago",
    },
  };
  await idle();
  call("council-automation-create", "council_automation_create", createArgs);
  const duplicated = call(
    "council-automation-create-retry",
    "council_automation_create",
    createArgs,
  );
  const created = model.reply({ text: "I scheduled the operations briefing." });
  assert.equal(
    (
      await submit(
        "Schedule an operations briefing and verify I only get one routine.",
      )
    ).status,
    "queued",
  );
  await complete(created);
  const receipt = projectToolOutput(
    duplicated,
    "council-automation-create-call-0",
  );
  assert.deepEqual(
    projectToolOutput(created, "council-automation-create-retry-call-0"),
    receipt,
  );
  assert.equal(receipt.chatId, chatId);
  assert.equal(receipt.revision, 1);
  assert.equal(receipt.enabled, true);
  await idle();

  const updateArgs = {
    operationId: randomUUID(),
    automationId: receipt.id,
    expectedRevision: receipt.revision,
    changes: { prompt: edited, enabled: false },
  };
  call("council-automation-edit", "council_automation_update", updateArgs);
  const retried = call(
    "council-automation-edit-retry",
    "council_automation_update",
    updateArgs,
  );
  const list = call("council-automation-list", "council_automation_list", {
    limit: 1,
  });
  const read = call("council-automation-read", "council_automation_read", {
    automationId: receipt.id,
  });
  const updated = model.reply({ text: "I updated and paused the briefing." });
  assert.equal(
    (await submit("Update the briefing prompt and pause the routine.")).status,
    "queued",
  );
  await complete(updated);
  const editedReceipt = projectToolOutput(
    retried,
    "council-automation-edit-call-0",
  );
  assert.deepEqual(
    projectToolOutput(list, "council-automation-edit-retry-call-0"),
    editedReceipt,
  );
  assert.equal(editedReceipt.revision, 2);
  assert.equal(editedReceipt.enabled, false);
  assert.equal(editedReceipt.nextRunAt, null);
  const listed = projectToolOutput(read, "council-automation-list-call-0");
  assert.equal(listed.routines.length, 1);
  assert.equal(listed.routines[0].id, receipt.id);
  assert.equal(listed.routines[0].name, name);
  assert.deepEqual(listed.routines[0].schedule.weekdays, [1, 2]);
  const definition = projectToolOutput(
    updated,
    "council-automation-read-call-0",
  );
  assert.equal(definition.prompt, edited);
  await idle();

  const opaque = await page.evaluate(
    async (agentId) =>
      (
        await import("/src/lib/project-automation-api.ts")
      ).getCouncilAutomations(agentId),
    chatId,
  );
  assert.equal(opaque.length, 1);
  assert.ok(opaque[0].content.protectedPrompt.envelope.ciphertext);
  assert.ok(!JSON.stringify(opaque).includes(edited));

  const url = new URL(appOrigin);
  url.searchParams.set("councilAgent", chatId);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url.href);
  await page.getByRole("button", { name: "Council routines" }).click();
  const panel = () => page.getByRole("dialog");
  await panel().getByText(name, { exact: true }).waitFor();
  await panel()
    .getByRole("button", { name: `Resume ${name}` })
    .click();
  await panel()
    .getByRole("button", { name: `Pause ${name}` })
    .waitFor();
  await panel()
    .getByRole("button", { name: `Edit ${name}` })
    .click();
  assert.equal(
    await panel().getByRole("textbox", { name: "Trigger prompt" }).inputValue(),
    edited,
  );
  await panel()
    .getByRole("textbox", { name: "Routine name" })
    .fill("Release briefing");
  await panel().getByRole("button", { name: "Save routine" }).click();
  await panel().getByText("Release briefing", { exact: true }).waitFor();
  await panel()
    .getByRole("button", { name: "Runs for Release briefing" })
    .click();
  await panel().getByText("No runs yet.", { exact: true }).waitFor();
  await panel().getByRole("button", { name: "Back to routines" }).click();
  await panel().getByRole("button", { name: "New routine" }).click();
  await panel()
    .getByRole("textbox", { name: "Routine name" })
    .fill("Weekly review");
  await panel()
    .getByRole("textbox", { name: "Trigger prompt" })
    .fill("Find remaining review work.");
  await panel()
    .getByRole("combobox", { name: "Schedule type" })
    .selectOption("weekly");
  await panel().getByRole("button", { name: "Save routine" }).click();
  await panel().getByText("Weekly review", { exact: true }).waitFor();
  assert.deepEqual(model.failures, []);
  result.councilRoutineAuthoring = {
    agentId: chatId,
    automationId: receipt.id,
    successfulEditRevision: editedReceipt.revision,
    approvals: approvals.size,
  };
  result.steps.push(
    "Council created, read, listed, and changed an encrypted routine by prompt. Both retries kept their exact receipt. The mobile panel created, edited, and resumed routines.",
  );
}
