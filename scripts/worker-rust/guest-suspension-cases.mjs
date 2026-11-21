import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { modelFunctions } from "../server-rust/task-model-provider.mjs";
import { createPreparedProjectChat } from "./console-interaction-cases.mjs";
import {
  pauseHeldTurn,
  recoverHeldTurn,
} from "./deferred-receipt-smoke-cases.mjs";

export async function verifyGuestSuspension({
  call,
  eventually,
  createModel,
  encryptedTurn,
  openMessage,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  repositoryKey,
  guest,
  marker,
  startWorker,
  stopWorker,
  prepared,
}) {
  const { model, profile } =
    prepared ?? (await createModel("Guest suspension fixture"));
  if (!prepared) {
    await call("PATCH", "/api/settings", 200, {
      defaultModelId: profile.id,
      autoNameChats: false,
    });
  }
  const { chatUrl, placement } =
    prepared?.chat ??
    (await createPreparedProjectChat({
      call,
      eventually,
      ownerId,
      workerId,
      keyRevision,
      labelKey,
      title: "Cantrip OS suspension",
      beforeChat: ({ projectId }) =>
        guest.placeProject({
          call,
          ownerId,
          workerId,
          keyRevision,
          projectId,
          repositoryKey,
        }),
    }));
  const { threadId } = await call("POST", chatUrl + "/sync", 200, {});
  const suspensionFixture = { call, eventually, chatUrl, marker };
  const beforePause = model.reply({ hold: true });
  const afterResume = model.reply({ hold: true });
  const answer = model.reply({ text: "The Linux Chat resumed its work." });
  const prompt = "Resume this private turn after restarting the worker.";
  try {
    await call(
      "POST",
      chatUrl + "/turns",
      202,
      await encryptedTurn(prompt, profile.id),
    );
    const held = await recoverHeldTurn({
      ...suspensionFixture,
      beforePause,
      afterResume,
      stopWorker,
      startWorker,
    });
    assert.equal(held.threadId, threadId);
    assert.deepEqual(
      JSON.parse(await readFile(marker + ".resume", "utf8")),
      held,
    );
    await eventually(
      () => afterResume.request,
      (request) =>
        assert.ok(request, "The restored turn did not reach the model."),
    );
    const exec = modelFunctions(afterResume.request.input.tools).find(
      ({ name }) => name === "exec_command" || name.endsWith("__exec_command"),
    );
    assert.ok(exec, "The resumed turn must expose its guest shell.");
    afterResume.calls = [
      { ...exec, arguments: { cmd: "uname -s && pwd", yield_time_ms: 1000 } },
    ];
    afterResume.release();
    await eventually(
      () => answer.request,
      (request) => assert.equal(request?.completed, true),
    );
    const output = answer.request.input.input
      .filter(({ type }) => type === "function_call_output")
      .map(({ output }) => output)
      .join("\n");
    assert.ok(output.includes(`Linux\n${placement.guestPath}`), output);
    await eventually(
      async () => {
        const { messages } = await call("GET", chatUrl + "/messages", 200);
        return Promise.all(messages.map(openMessage));
      },
      (messages) => {
        for (const text of [prompt, answer.text]) {
          assert.equal(
            messages.filter(({ content }) =>
              content.some((item) => item.text === text),
            ).length,
            1,
          );
        }
      },
    );
    await eventually(
      () => call("POST", chatUrl + "/sync", 200, {}),
      (thread) => {
        assert.equal(thread.threadId, threadId);
        assert.equal(thread.status, "idle");
      },
    );
  } finally {
    beforePause.release();
    afterResume.release();
  }

  await unlink(marker + ".pause");
  const beforeStop = model.reply({ hold: true });
  try {
    await call(
      "POST",
      chatUrl + "/turns",
      202,
      await encryptedTurn("Stop this saved guest turn.", profile.id),
    );
    const held = await pauseHeldTurn({
      ...suspensionFixture,
      beforePause: beforeStop,
    });
    assert.equal(held.threadId, threadId);
    const modelCalls = () =>
      model.requests.filter(({ method }) => method === "POST").length;
    const requestsBeforeStop = modelCalls();
    assert.deepEqual(await stopWorker(), { code: 0, signal: null });
    await startWorker();
    assert.deepEqual(await call("POST", chatUrl + "/interrupt", 200, {}), {
      interrupted: true,
    });
    assert.deepEqual(
      JSON.parse(await readFile(marker + ".stop", "utf8")),
      held,
    );
    assert.equal(modelCalls(), requestsBeforeStop);
  } finally {
    beforeStop.release();
  }
  assert.deepEqual(model.failures, []);
  console.log(
    JSON.stringify({ suite: "native-guest-suspension", passed: true }),
  );
}
