import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { LiveProbe } from "../server-rust/live-sockets.mjs";
import {
  createPreparedProjectChat,
  openConsoleView,
} from "./console-interaction-cases.mjs";

export async function verifyConsoleSteering({
  call,
  eventually,
  createModel,
  openMessage,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  socketFile,
  server,
}) {
  const { model, profile } = await createModel("Native console steering");
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: profile.id,
    autoNameChats: false,
  });
  const { chatId, chatUrl } = await createPreparedProjectChat({
    call,
    eventually,
    ownerId,
    workerId,
    keyRevision,
    labelKey,
    title: "Console steering",
  });
  const url = await eventually(
    () => readFile(socketFile, "utf8"),
    (value) => assert.ok(value.startsWith("ws://127.0.0.1:")),
  );
  const view = await openConsoleView(url, eventually);
  const live = new LiveProbe({ server, client: () => ({ cookies: [] }) });
  const { threadId } = view;
  const first = model.reply({ hold: true });
  const answer = "The same native turn completed after console steering.";
  const final = model.reply({ text: answer });
  const prompt = "Steer from the attached console 🌲";
  const start = "Begin a managed turn from the console.";
  const textInput = (text) => [{ type: "text", text, text_elements: [] }];
  try {
    assert.equal(
      (await view.request(2, "thread/resume", { threadId })).result.thread.id,
      threadId,
    );
    await live.open();
    await live.initialized();
    await live.subscribed("console-thread-changes", [{ kind: "chat", chatId }]);
    const settings = await view.request(20, "thread/settings/update", {
      threadId,
      effort: "low",
    });
    assert.ok(settings.result?.submissionId, JSON.stringify(settings));
    await live.message(
      (frame) =>
        frame.type === "event" &&
        frame.resource === "chat-plan" &&
        frame.action === "invalidated" &&
        frame.scope.kind === "chat" &&
        frame.scope.chatId === chatId,
    );
    const started = await view.request(3, "turn/start", {
      threadId,
      input: textInput(start),
    });
    const turnId = started.result?.turn?.id;
    assert.ok(turnId, JSON.stringify(started));
    await eventually(
      () => first.request,
      (request) =>
        assert.ok(JSON.stringify(request?.input?.input ?? []).includes(start)),
    );
    const params = {
      threadId,
      expectedTurnId: turnId,
      input: textInput(prompt),
      clientUserMessageId: "terminal-steer:" + randomUUID(),
    };
    for (const [index, override] of [
      { expectedTurnId: "replaced-turn" },
      { threadId: "foreign-thread" },
      { approvalPolicy: "never" },
    ].entries()) {
      const rejected = await view.request(4 + index, "turn/steer", {
        ...params,
        ...override,
      });
      assert.ok(rejected.error, JSON.stringify(rejected));
      assert.equal(final.entered, false);
    }
    const steered = await view.request(7, "turn/steer", params);
    assert.equal(steered.result?.turnId, turnId, JSON.stringify(steered));
    await eventually(
      () => final.request,
      (request) => {
        assert.equal(request?.completed, true);
        assert.ok(JSON.stringify(request.input.input).includes(prompt));
      },
    );
    await view.read(
      (frame) =>
        frame.method === "turn/completed" && frame.params.turn.id === turnId,
    );
    await eventually(
      async () => {
        const { messages } = await call("GET", chatUrl + "/messages", 200);
        assert.ok(!JSON.stringify(messages).includes(prompt));
        return Promise.all(messages.map(openMessage));
      },
      (messages) => {
        for (const expected of [start, prompt, answer]) {
          assert.equal(
            messages.filter(({ content }) =>
              content.some(({ text }) => text === expected),
            ).length,
            1,
          );
        }
      },
    );
    assert.deepEqual(model.failures, []);
    console.log(
      JSON.stringify({
        suite: "native-console-steering",
        passed: true,
        planInvalidated: true,
      }),
    );
  } finally {
    first.release();
    view.close();
    await live.close();
  }
}
