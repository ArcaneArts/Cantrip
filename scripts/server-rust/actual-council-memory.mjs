import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";

export async function actualCouncilMemory({
  page,
  appOrigin,
  chatId,
  model,
  tools,
  submit,
  readChat,
  readMessages,
  result,
}) {
  const timeout = 60_000;
  const browserNote =
    "Use short briefings 📓 and open the detailed notes in Drive.";
  const agentNote = "Move the detailed notes pointer to Obsidian 🗃️.";
  const readMemory = () =>
    page.evaluate(
      async (id) =>
        (await import("/src/lib/api/council.ts")).getCouncilMemory(id),
      chatId,
    );
  const approveNothing = async () => {
    const requests = await page.evaluate(
      async (id) =>
        (await import("/src/lib/api/chats.ts")).getAgentInteractionRequests({
          chatId: id,
          status: "pending",
        }),
      chatId,
    );
    assert.deepEqual(
      requests,
      [],
      "Own fast memory needs no approval interaction",
    );
  };
  const waitForModel = (plan) =>
    eventually(
      async () => {
        await approveNothing();
        return plan.entered;
      },
      (entered) => assert.equal(entered, true),
      timeout,
    );
  const idle = () =>
    eventually(readChat, (chat) => assert.equal(chat.status, "idle"), timeout);
  const findTool = (name) => {
    const tool = tools.find(
      (tool) => tool.name === name || tool.name.endsWith(`__${name}`),
    );
    assert.ok(tool, `Codex advertises ${name}`);
    return tool;
  };
  const readTool = findTool("council_memory_read");
  const writeTool = findTool("council_memory_write");
  const originalMessages = await readMessages();
  await idle();
  assert.deepEqual(await readMemory(), { revision: 1, text: "" });

  await page.setViewportSize({ width: 1344, height: 900 });
  await page.goto(appOrigin);
  await page
    .getByRole("button", { name: /switch cantrip mode/iu })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "Cantrip Council" }).click();
  await page
    .getByRole("navigation", { name: "Council agents" })
    .getByRole("button", { name: /Disposable Operations Agent/u })
    .click();
  const openEditor = async () => {
    await page.getByRole("button", { name: "Edit fast memory" }).click();
    const notes = page.getByLabel("Fast memory notes");
    await notes.waitFor();
    return notes;
  };
  await (await openEditor()).fill(browserNote);
  const browserWrite = page.waitForRequest(
    (request) =>
      request.method() === "PUT" &&
      new URL(request.url()).pathname ===
        `/api/council/agents/${chatId}/memory`,
  );
  await page.getByRole("button", { name: "Save memory" }).click();
  await page
    .getByRole("dialog", { name: "Fast memory" })
    .waitFor({ state: "hidden" });
  const memoryBody = (await browserWrite).postDataJSON();
  assert.equal(memoryBody.expectedRevision, 1);
  assert.ok(memoryBody.protectedMemory.ciphertext);
  assert.ok(!JSON.stringify(memoryBody).includes(browserNote));

  const read = model.reply({ calls: [{ ...readTool, arguments: {} }] });
  const write = model.reply({
    calls: [
      { ...writeTool, arguments: { expectedRevision: 2, text: agentNote } },
    ],
  });
  const saved = model.reply({ text: "I updated the saved preferences." });
  assert.equal(
    (await submit("Read and update your fast memory")).status,
    "queued",
  );
  await waitForModel(saved);
  assert.ok(JSON.stringify(read.request.input).includes(browserNote));
  const readOutputs = write.request.input.input.filter(
    ({ type }) => type === "function_call_output",
  );
  assert.ok(JSON.stringify(readOutputs).includes(browserNote));
  assert.ok(
    JSON.stringify(readOutputs).includes("Loaded your Council memory."),
  );
  assert.ok(JSON.stringify(saved.request.input).includes(agentNote));
  await idle();
  assert.deepEqual(await readMemory(), { revision: 3, text: agentNote });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await (await openEditor()).inputValue(), agentNote);
  await page.keyboard.press("Escape");
  const stale = await page.evaluate(async (id) => {
    try {
      await (
        await import("/src/lib/api/council.ts")
      ).updateCouncilMemory(id, 2, "stale editor");
      return null;
    } catch (error) {
      return error.status;
    }
  }, chatId);
  assert.equal(stale, 409);

  model.reply({
    calls: [{ ...writeTool, arguments: { expectedRevision: 3, text: "" } }],
  });
  const cleared = model.reply({ text: "I cleared fast memory." });
  assert.equal((await submit("Clear your fast memory")).status, "queued");
  await waitForModel(cleared);
  await idle();
  assert.deepEqual(await readMemory(), { revision: 4, text: "" });

  const empty = model.reply({ text: "Fast memory is empty." });
  assert.equal(
    (await submit("Check the current saved notes")).status,
    "queued",
  );
  await waitForModel(empty);
  await idle();
  assert.match(
    JSON.stringify(empty.request.input),
    /Current fast memory:\\n\(empty\)/u,
  );
  const retained = new Set((await readMessages()).map(({ id }) => id));
  assert.ok(originalMessages.every(({ id }) => retained.has(id)));
  assert.deepEqual(model.failures, []);
  result.councilFastMemory = {
    chatId,
    revision: 4,
    retainedMessages: originalMessages.length,
  };
  result.steps.push(
    "Browser and Codex read, update, and clear protected Council fast memory without changing earlier messages",
  );
}
