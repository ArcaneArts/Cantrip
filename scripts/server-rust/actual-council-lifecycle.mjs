import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { eventually } from "./full-worker.mjs";

const timeout = 60_000;

export async function actualCouncilLifecycle({
  page,
  appOrigin,
  workerDirectory,
  chatId,
  model,
  submit,
  readChat,
  readMessages,
  result,
}) {
  const root = path.join(workerDirectory, "chat-scratch", chatId);
  const listed = () =>
    page.evaluate(async () =>
      (await import("/src/lib/api/council.ts")).listCouncilAgents(),
    );
  const findAgent = async () =>
    (await listed()).find(({ id }) => id === chatId);
  const idle = () =>
    eventually(readChat, (chat) => assert.equal(chat.status, "idle"), timeout);
  const complete = (plan) =>
    eventually(
      () => plan.request?.completed,
      (done) => assert.equal(done, true, JSON.stringify(model.failures)),
      timeout,
    );
  const title = (await findAgent()).title;
  const preserved = (await readMessages()).map(({ id }) => id);
  assert.ok(preserved.length > 0);
  await writeFile(path.join(root, "lifecycle-cleanup.txt"), "disposable data");
  const durable = new URL(appOrigin);
  durable.searchParams.set("councilAgent", chatId);
  const app = await page.context().newPage();
  try {
    await app.setViewportSize({ width: 390, height: 844 });
    await app.goto(durable.href);
    await app.getByRole("heading", { name: title }).waitFor();
    const roster = app.getByRole("navigation", { name: "Council agents" });
    const agentRow = () =>
      roster.getByRole("button", { name: new RegExp(title) });
    const edit = async (action) => {
      await app.getByRole("button", { name: "Edit Council agent" }).click();
      const dialog = app.getByRole("dialog", { name: "Edit Council agent" });
      await dialog.getByRole("button", { name: action, exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
    };
    await edit("Hide from roster");
    await roster.waitFor();
    await agentRow().waitFor({ state: "hidden" });
    assert.equal((await findAgent()).hidden, true);
    await roster.getByText("Hidden agents", { exact: true }).click();
    await agentRow().click();
    await edit("Show in roster");
    assert.equal((await findAgent()).hidden, false);

    await edit("Pause agent");
    await app
      .getByText("Agent paused. Messages queue until you resume it.")
      .waitFor();
    const pausedPrompt = "Remember the release stays on track while paused.";
    const resumed = model.reply({
      text: "I received the queued input after resuming.",
    });
    const submitted = await submit(pausedPrompt);
    assert.equal(submitted.status, "queued");
    await idle();
    assert.equal(resumed.entered, false);
    await edit("Resume agent");
    await complete(resumed);
    assert.match(
      JSON.stringify(resumed.request.input.input),
      /release stays on track/u,
    );
    await idle();

    const due = Date.now() + 7_000;
    const routine = await page.evaluate(
      async ({ id, due }) =>
        (
          await import("/src/lib/project-automation-api.ts")
        ).createCouncilAutomation(id, {
          name: "Lifecycle test routine",
          prompt: "Export the routine status after archive restoration.",
          enabled: true,
          schedule: {
            kind: "interval",
            every: 1_000_000,
            unit: "minute",
            startsAt: new Date(due).toISOString(),
          },
        }),
      { id: chatId, due },
    );
    const fired = model.reply({
      text: "The archived routine resumed after restoration.",
    });
    await edit("Archive agent");
    assert.equal((await findAgent()).archived, true);
    assert.ok((await stat(root)).isDirectory());
    await eventually(Date.now, (now) => assert.ok(now > due + 600), timeout);
    assert.equal(fired.entered, false);
    await roster.getByText("Archived agents", { exact: true }).click();
    await agentRow().click();
    await app.getByRole("button", { name: "Restore agent" }).click();
    await app.getByRole("button", { name: "Edit Council agent" }).waitFor();
    await complete(fired);
    assert.match(
      JSON.stringify(fired.request.input.input),
      /routine status after archive restoration/u,
    );
    await idle();
    const activeRoutine = await page.evaluate(
      async (id) =>
        (
          await import("/src/lib/project-automation-api.ts")
        ).getCouncilAutomations(id),
      chatId,
    );
    assert.deepEqual(
      activeRoutine.map(({ id, enabled }) => ({ id, enabled })),
      [{ id: routine.id, enabled: true }],
    );
    const retained = new Set((await readMessages()).map(({ id }) => id));
    assert.ok(preserved.every((id) => retained.has(id)));

    await edit("Archive agent");
    await roster.getByText("Archived agents", { exact: true }).click();
    await agentRow().click();
    await app.getByRole("button", { name: "Delete permanently" }).click();
    const confirmation = app.getByRole("dialog", {
      name: "Permanently delete this Council agent?",
    });
    await confirmation
      .getByRole("button", { name: "Delete permanently" })
      .click();
    await confirmation.waitFor({ state: "hidden" });
    await eventually(findAgent, (row) => assert.equal(row, undefined), timeout);
    await eventually(
      () =>
        stat(root).then(
          () => true,
          (error) => {
            assert.equal(error.code, "ENOENT");
            return false;
          },
        ),
      (exists) => assert.equal(exists, false),
      timeout,
    );
    assert.deepEqual(model.failures, []);
    result.councilLifecycle = {
      chatId,
      routineId: routine.id,
      retainedCount: preserved.length,
    };
    result.steps.push(
      "Council roster hide, queue pause, archive and restore, held routine, retained history and Worker scratch deletion passed through the responsive browser app",
    );
  } finally {
    await app.close();
  }
}
