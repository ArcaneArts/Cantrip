import assert from "node:assert/strict";

export async function actualCouncilHistoryRedaction({
  page,
  appOrigin,
  chatId,
  source,
  retainedId,
  priorSummary,
  priorThreadId,
  model,
  submit,
  observe,
  idle,
  readMessages,
  recall,
  thread,
  result,
}) {
  const memoryNote = "Retain this fast memory independently of history.";
  await page.evaluate(
    async ({ chatId, memoryNote }) => {
      const { getCouncilMemory, updateCouncilMemory } =
        await import("/src/lib/api/council.ts");
      const memory = await getCouncilMemory(chatId);
      await updateCouncilMemory(chatId, memory.revision, memoryNote);
    },
    { chatId, memoryNote },
  );

  const urls = new URLSearchParams({
    councilAgent: chatId,
    message: source.id,
  });
  const link = new URL(`/?${urls}`, appOrigin).href;
  await page.goto(link);
  const history = page.getByRole("dialog", { name: "Council history" });
  await history
    .getByRole("article", { name: "Selected message" })
    .getByText(source.text, { exact: true })
    .waitFor();
  const viewer = await page.context().newPage();
  try {
    await viewer.goto(link);
    const viewerHistory = viewer.getByRole("dialog", {
      name: "Council history",
    });
    await viewerHistory
      .getByRole("article", { name: "Selected message" })
      .getByText(source.text, { exact: true })
      .waitFor();
    await history.getByRole("button", { name: "Delete message" }).click();
    const confirm = page.getByRole("dialog", {
      name: "Delete Council message?",
    });
    const response = page.waitForResponse(
      (reply) =>
        reply.request().method() === "DELETE" &&
        new URL(reply.url()).pathname ===
          `/api/council/agents/${chatId}/history/${source.id}`,
    );
    await confirm.getByRole("button", { name: "Delete message" }).click();
    const deleted = await response;
    assert.equal(
      deleted.status(),
      204,
      deleted.status() === 204 ? undefined : await deleted.text(),
    );
    await Promise.all(
      [history, viewerHistory].map((dialog) =>
        dialog.getByText("This message is unavailable.").waitFor(),
      ),
    );
  } finally {
    await viewer.close();
  }
  const evidence = await recall();
  assert.equal(evidence.nearby.available, false);
  assert.deepEqual(evidence.search.matches, []);
  assert.ok((await readMessages()).some(({ id }) => id === retainedId));
  assert.equal(await thread(), null);

  const after = model.reply({
    text: "I still have the rest of the Council conversation.",
  });
  assert.equal(
    (await submit("Continue after the history change.")).status,
    "queued",
  );
  const context = JSON.stringify((await observe(after)).input);
  await idle();
  const threadId = await thread();
  assert.ok(threadId);
  assert.notEqual(
    threadId,
    priorThreadId,
    "The retired native thread cannot be selected again",
  );
  assert.ok(context.includes(memoryNote));
  assert.ok(context.includes("Preserve this Council role marker"));
  assert.ok(
    !context.includes(source.text),
    "Deleted source was absent from the fresh turn",
  );
  assert.ok(
    !context.includes(priorSummary),
    "Compaction could not restore the deleted source",
  );
  assert.deepEqual(model.failures, []);

  result.councilHistoryRedaction = {
    chatId,
    sourceId: source.id,
    retainedId,
    priorThreadId,
    threadId,
  };
  result.steps.push(
    "Council deleted the selected retained message, invalidated the warm index and compacted runtime context, and preserved fast memory and other history",
  );
}
