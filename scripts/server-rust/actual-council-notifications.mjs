import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { projectToolOutput } from "./actual-council-project-creation.mjs";
import { eventually } from "./full-worker.mjs";

export async function actualCouncilNotifications({
  page,
  appOrigin,
  chatId,
  model,
  tools,
  submit,
  readMessages,
  result,
}) {
  const tool = tools.find(
    ({ name }) =>
      name === "council_message_post" ||
      name.endsWith("__council_message_post"),
  );
  assert.ok(
    tool,
    "Council can post to its own conversation in read-only mode.",
  );
  const progress = "I’m checking the retained project decisions.";
  const report =
    "The briefing is ready. The deployment decision still needs a reviewer.";
  const notification = {
    operationId: randomUUID(),
    text: report,
    notify: true,
  };
  const post = (responseId, arguments_, hold = false) =>
    model.reply({
      responseId,
      hold,
      calls: [{ ...tool, arguments: arguments_ }],
    });
  const pending = () =>
    page.evaluate(async () =>
      (
        await import("/src/lib/api/council-notifications.ts")
      ).getCouncilPendingNotifications(),
    );
  const preference = (enabled) =>
    page.evaluate(
      async (value) =>
        (
          await import("/src/lib/council-notification-preference.ts")
        ).setCouncilNotificationsEnabled(value),
      enabled,
    );
  const messagesWith = (messages, text) =>
    messages.filter(({ content }) =>
      content.some((item) => item.text === text),
    );
  post("council-quiet-post", {
    operationId: randomUUID(),
    text: progress,
    kind: "progress",
    notify: false,
  });
  const held = post("council-notify-post", notification, true);
  const repeated = post("council-notify-post-repeated", notification);
  const finished = model.reply({ text: "The report has been posted." });
  try {
    await preference(false);
    assert.equal(
      (
        await submit(
          "Prepare a briefing, send quiet progress and then notify me.",
        )
      ).status,
      "queued",
    );
    await eventually(
      () => held.entered,
      (entered) => assert.equal(entered, true),
      60_000,
    );
    const quiet = projectToolOutput(held, "council-quiet-post-call-0");
    assert.equal(quiet.notify, false);
    const visible = await eventually(readMessages, (messages) =>
      assert.equal(messagesWith(messages, progress).length, 1),
    );
    const [progressMessage] = messagesWith(visible, progress);
    assert.equal(progressMessage.id, quiet.messageId);
    assert.equal(progressMessage.content[0].phase, "commentary");
    assert.deepEqual(await pending(), []);
    await page.goto("about:blank");
    held.release();
    await eventually(
      () => finished.request?.completed,
      (done) => assert.equal(done, true),
      60_000,
    );
    assert.equal(page.url(), "about:blank");
    const receipt = projectToolOutput(repeated, "council-notify-post-call-0");
    assert.equal(receipt.notify, true);
    assert.deepEqual(
      projectToolOutput(finished, "council-notify-post-repeated-call-0"),
      receipt,
    );

    const url = new URL(appOrigin);
    url.searchParams.set("councilAgent", chatId);
    await page.goto(url.href);
    await page.getByRole("navigation", { name: "Council agents" }).waitFor();
    const opaque = await pending();
    assert.equal(opaque.length, 1);
    assert.equal(opaque[0].id, receipt.messageId);
    assert.ok(!JSON.stringify(opaque).includes(report));
    assert.equal(
      await page.locator('[data-slot="app-toast"]').getByText(report).count(),
      0,
    );
    const transcript = await readMessages();
    assert.equal(messagesWith(transcript, report).length, 1);
    assert.equal(messagesWith(transcript, progress).length, 1);

    await preference(true);
    const toast = page
      .locator('[data-slot="app-toast"]')
      .filter({ hasText: report });
    await toast.getByText(report, { exact: true }).waitFor();
    await toast.getByRole("link", { name: "Open conversation" }).waitFor();
    assert.equal(await toast.count(), 1);
    assert.deepEqual(await pending(), []);
    const alreadyDelivered = await page.evaluate(
      async (id) =>
        (
          await import("/src/lib/api/council-notifications.ts")
        ).claimCouncilNotification(id),
      receipt.messageId,
    );
    assert.equal(alreadyDelivered, false);
    await page.reload();
    await page.getByRole("navigation", { name: "Council agents" }).waitFor();
    assert.deepEqual(await pending(), []);
    assert.equal(await toast.count(), 0);
    assert.deepEqual(model.failures, []);
    result.councilNotifications = {
      agentId: chatId,
      quietMessageId: quiet.messageId,
      notificationMessageId: receipt.messageId,
      quietWhileActive: true,
      postedWhileClosed: true,
      devicePreference: true,
      deliveredOnce: true,
    };
    result.steps.push(
      "Council posted quiet progress during a native turn, persisted one encrypted notification while the app was closed, respected the device preference, and delivered the notice once after it was enabled.",
    );
  } finally {
    held.release();
  }
}
