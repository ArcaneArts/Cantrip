import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { projectToolOutput } from "./actual-council-project-creation.mjs";
import { eventually } from "./full-worker.mjs";
import { modelFunctions } from "./task-model-provider.mjs";

export async function actualCouncilProviderRecovery({
  page,
  appOrigin,
  initiallyBlocked,
  stopBlockedRecovery,
  exhaustAlternate,
  enableAlternate,
  chatId,
  model,
  alternate,
  submit,
  readMessages,
  readChat,
  result,
}) {
  const original = "Check the release decision and post a short briefing.";
  const checkpoint = "The release decision is recorded as R-420.";
  const finished = "The briefing is complete on the alternate route.";
  const calls = [];
  const first = model.reply({
    responseId: "council-quota-progress",
    calls,
    hold: true,
  });
  const rejected = model.reply({
    status: 429,
    error: "The provider quota has been exceeded.",
    repeat: true,
  });
  const replacement = alternate.reply(
    exhaustAlternate
      ? {
          status: 429,
          error: "The backup provider quota has been exceeded.",
          repeat: true,
        }
      : { text: finished },
  );
  const observation = (result.councilProviderRecovery = { chatId });
  try {
    const start = await submit(original);
    assert.equal(start.status, "queued");
    await eventually(
      () => first.request,
      (request) => assert.ok(request),
      60_000,
    );
    const tool = modelFunctions(first.request.input.tools).find(
      ({ name }) =>
        name === "council_message_post" ||
        name.endsWith("__council_message_post"),
    );
    assert.ok(tool, "Council can record progress before the provider limit.");
    calls.push({
      ...tool,
      arguments: {
        operationId: randomUUID(),
        text: checkpoint,
        kind: "progress",
        notify: false,
      },
    });
    first.release();
    await eventually(
      () => rejected.request,
      (request) => assert.ok(request?.completed),
      60_000,
    );
    const posted = projectToolOutput(rejected, "council-quota-progress-call-0");
    assert.ok(posted.messageId);
    const url = new URL(appOrigin);
    url.searchParams.set("councilAgent", chatId);
    if (initiallyBlocked) {
      await eventually(
        readChat,
        (chat) => {
          observation.blocked = chat.providerRecovery;
          assert.equal(chat.providerRecovery?.phase, "blocked");
        },
        60_000,
      );
      assert.equal(replacement.entered, false);
      await page.goto(url.href);
      await page
        .getByText(
          "Disposable Council provider reached its quota. Council is waiting for an available route.",
          { exact: true },
        )
        .waitFor();
      if (stopBlockedRecovery) {
        await page.getByRole("button", { name: "Stop recovery" }).click();
        await eventually(readChat, (chat) =>
          assert.equal(chat.providerRecovery, null),
        );
        await enableAlternate();
        rejected.discard();
        const answer = "Here is the answer to the new request.";
        model.reply({ text: answer });
        const started = await submit("Answer this new request independently.");
        assert.equal(started.status, "queued");
        const messages = await eventually(
          readMessages,
          (messages) =>
            assert.ok(
              messages.some(({ content }) =>
                content.some(({ text }) => text === answer),
              ),
            ),
          60_000,
        );
        assert.equal((await readChat()).providerRecovery, null);
        assert.equal(replacement.entered, false);
        assert.ok(
          !messages.some(({ content }) =>
            content.some((item) => item.councilProviderRecovery),
          ),
        );
        result.steps.push(
          "Stopping a blocked recovery kept it cancelled after a new route and request.",
        );
        return;
      }
      await enableAlternate();
    }
    await eventually(
      readChat,
      (chat) => {
        observation.chatState = {
          status: chat.status,
          codexThreadId: chat.codexThreadId,
          modelRouteId: chat.modelRouteId,
          providerRecovery: chat.providerRecovery,
        };
        assert.ok(
          replacement.entered,
          "The alternate has received the continuation.",
        );
      },
      60_000,
    );
    observation.sourcePosts = model.requests.filter(
      ({ method }) => method === "POST",
    ).length;
    observation.targetPosts = alternate.requests.filter(
      ({ method }) => method === "POST",
    ).length;
    observation.protectedMessages = (await readMessages()).map(
      ({ id, role, content }) => ({ id, role, content }),
    );
    assert.ok(
      replacement.entered,
      "A quota failure after progress should continue through the configured alternate.",
    );
    assert.match(JSON.stringify(replacement.request.input.input), /R-420/u);
    assert.match(
      JSON.stringify(replacement.request.input.input),
      /The model provider changed after quota/u,
    );
    if (exhaustAlternate) {
      await eventually(
        readChat,
        (chat) =>
          assert.deepEqual(chat.providerRecovery, {
            from: "Disposable Council backup provider",
            phase: "blocked",
            to: null,
          }),
        60_000,
      );
      const messages = await readMessages();
      assert.equal(
        messages.flatMap(({ content }) =>
          content.filter((item) => item.councilProviderRecovery),
        ).length,
        1,
      );
      assert.equal(
        model.requests.filter(({ method }) => method === "POST").length,
        observation.sourcePosts,
      );
      result.steps.push(
        "A second quota failure held the same Council run without switching back.",
      );
      return;
    }
    const withText = (messages, text) =>
      messages.filter(({ content }) =>
        content.some((item) => item.text === text),
      );
    const retained = await eventually(
      readMessages,
      (messages) => assert.equal(withText(messages, finished).length, 1),
      60_000,
    );
    assert.equal(withText(retained, original).length, 1);
    assert.equal(withText(retained, checkpoint).length, 1);
    assert.equal(withText(retained, checkpoint)[0].id, posted.messageId);
    const continuations = retained.flatMap(({ content }) =>
      content.filter((item) => item.councilProviderRecovery),
    );
    assert.equal(continuations.length, 1);
    assert.equal(
      continuations[0].councilProviderRecovery.messageId,
      withText(retained, original)[0].id,
    );
    await page.goto(url.href);
    await page
      .getByText(
        "Switched from Disposable Council provider to Disposable Council backup provider.",
        { exact: true },
      )
      .waitFor();
    await page
      .getByRole("link", { name: /Continued after provider switch/u })
      .waitFor();
    observation.continuation = continuations[0].councilProviderRecovery;
    if (!initiallyBlocked) {
      await eventually(readChat, (chat) => assert.equal(chat.status, "idle"));
      await page.evaluate(
        async ({ chatId, messageId }) =>
          (
            await import("/src/lib/api/council-history.ts")
          ).deleteCouncilHistoryMessage(chatId, messageId),
        { chatId, messageId: observation.continuation.messageId },
      );
      const redacted = await readMessages();
      assert.equal(withText(redacted, original).length, 0);
      assert.equal(withText(redacted, checkpoint).length, 1);
      assert.equal(withText(redacted, finished).length, 1);
      assert.ok(
        !redacted.some(({ content }) =>
          content.some((item) => item.councilProviderRecovery),
        ),
      );
      result.steps.push(
        "History redaction removed the dependent protected continuation snapshot.",
      );
    }
    assert.deepEqual(model.failures, []);
    assert.deepEqual(alternate.failures, []);
    result.steps.push(
      "Council continued after the configured source provider reached quota.",
    );
  } finally {
    first.release();
    rejected.discard();
    replacement.discard?.();
  }
}
