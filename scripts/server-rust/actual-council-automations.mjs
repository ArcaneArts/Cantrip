import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";

export async function actualCouncilAutomations({
  page,
  appOrigin,
  chatId,
  workerId,
  model,
  submit,
  readChat,
  readMessages,
  stopWorker,
  startWorker,
  workers,
  result,
}) {
  const timeout = 60_000;
  const idle = () =>
    eventually(readChat, (chat) => assert.equal(chat.status, "idle"), timeout);
  const read = () =>
    page.evaluate(
      async (agent) =>
        (
          await import("/src/lib/project-automation-api.ts")
        ).getCouncilAutomations(agent),
      chatId,
    );
  const create = (name, prompt, startsAt) =>
    page.evaluate(
      async ({ chatId, name, prompt, startsAt }) =>
        (
          await import("/src/lib/project-automation-api.ts")
        ).createCouncilAutomation(chatId, {
          name,
          prompt,
          enabled: true,
          schedule: {
            kind: "interval",
            every: 1_000_000,
            unit: "minute",
            startsAt,
          },
        }),
      { chatId, name, prompt, startsAt },
    );
  const byText = (messages, text) =>
    messages.filter(({ content }) =>
      content.some((item) => item.text === text),
    );
  const sourceMessages = (messages, automationId) =>
    messages.flatMap((message) =>
      message.content.flatMap((item) =>
        item.automation?.automationId === automationId
          ? [{ message, item }]
          : [],
      ),
    );
  const entered = (plan) =>
    eventually(
      () => plan.entered,
      (value) => assert.equal(value, true),
      timeout,
    );
  const done = (plan) =>
    eventually(
      () => plan.request?.completed,
      (value) => assert.equal(value, true),
      timeout,
    );

  await idle();
  await stopWorker();
  await eventually(workers, (rows) =>
    assert.equal(rows.find((row) => row.workerId === workerId)?.online, false),
  );
  const offlineName = "Private Council morning briefing";
  const offlinePrompt = "Summarize the open work, even if a source is late 🕰.";
  const offlineAnswer = "The routine recovered on its original Worker.";
  const due = Date.now() + 6_000;
  const first = await create(
    offlineName,
    offlinePrompt,
    new Date(due).toISOString(),
  );
  assert.equal(first.workerId, workerId);
  assert.equal(first.lastStatus, "idle");
  assert.equal(first.projectId, null);
  assert.ok(!JSON.stringify(await read()).includes(offlinePrompt));
  const offline = model.reply({ text: offlineAnswer });
  await page.goto("about:blank");
  await eventually(Date.now, (now) => assert.ok(now >= due + 250), timeout);
  assert.equal(offline.entered, false);
  await startWorker();
  await done(offline);
  assert.match(
    JSON.stringify(offline.request.input.input),
    /Summarize the open work/,
  );
  assert.equal(page.url(), "about:blank");

  const conversation = new URL(appOrigin);
  conversation.searchParams.set("councilAgent", chatId);
  await page.goto(conversation.href);
  await page.getByRole("navigation", { name: "Council agents" }).waitFor();
  await eventually(
    readMessages,
    (messages) => assert.equal(byText(messages, offlineAnswer).length, 1),
    timeout,
  );
  await idle();
  const [source] = sourceMessages(await readMessages(), first.id);
  assert.ok(source);
  assert.equal(source.item.automation.name, offlineName);
  assert.equal(source.item.automation.targetKind, "council");
  assert.notEqual(source.item.text, offlinePrompt);
  await page.getByRole("button", { name: `Sent via ${offlineName}` }).click();
  const dialog = page.getByRole("dialog", { name: offlineName });
  await dialog.getByText(offlinePrompt, { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByText(offlinePrompt, { exact: true }).count(), 0);

  const busyPrompt = "Add the pending releases to this briefing 🍃.";
  const busyAnswer = "The scheduled update arrived inside the active turn.";
  const human = "Start a briefing while the next routine becomes due.";
  const held = model.reply({
    text: "The briefing is in progress.",
    hold: true,
  });
  const continued = model.reply({ text: busyAnswer, hold: true });
  try {
    await submit(human);
    await entered(held);
    const second = await create(
      "Release check",
      busyPrompt,
      new Date(Date.now() + 6_000).toISOString(),
    );
    const active = await eventually(
      readMessages,
      (messages) => {
        const [root] = byText(messages, human);
        const inputs = sourceMessages(messages, second.id);
        assert.equal(inputs.length, 1);
        assert.ok(root?.executionLaneId);
        assert.equal(inputs[0].message.executionLaneId, root.executionLaneId);
        assert.equal(held.request.completed, false);
      },
      timeout,
    );
    held.release();
    continued.release();
    await done(continued);
    assert.ok(
      JSON.stringify(continued.request.input.input).includes(busyPrompt),
    );
    await idle();
    assert.equal(sourceMessages(active, second.id).length, 1);
    const paused = await page.evaluate(
      async (id) =>
        (
          await import("/src/lib/project-automation-api.ts")
        ).updateCouncilAutomation(id, { enabled: false }),
      second.id,
    );
    assert.equal(paused.enabled, false);
    assert.equal(paused.nextRunAt, null);
    const [accepted] = (await read()).filter((row) => row.id === first.id);
    assert.equal(accepted.lastStatus, "queued");
    result.councilAutomations = {
      recovered: source.item.automation,
      steered: sourceMessages(active, second.id)[0].item.automation,
    };
  } finally {
    held.release();
    continued.release();
  }
  assert.deepEqual(model.failures, []);
  result.steps.push(
    "The existing scheduler recovered an offline Council routine while the app was closed, exposed its protected trigger in run details, and steered a second routine into the active native turn once.",
  );
}
