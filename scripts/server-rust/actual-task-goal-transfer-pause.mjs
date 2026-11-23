import assert from "node:assert/strict";
import { suspensionChat } from "./durable-suspension-browser.mjs";
import { eventually } from "./full-worker.mjs";
import { modelFunctions } from "./task-model-provider.mjs";

export async function pauseTransferredTaskGoal({
  page,
  projectId,
  chatId,
  model,
  tool,
  boundary,
  continued,
  startWorker,
  stopWorker,
  result,
}) {
  const saved = (result.transferredGoalPause = {});
  const command = modelFunctions(tool.request.input.tools).find(
    ({ name }) => name === "exec_command" || name.endsWith("__exec_command"),
  );
  assert.ok(command, "the transferred native turn advertises shell execution");
  const call = (cmd) => ({
    ...command,
    arguments: { cmd, yield_time_ms: 1000, max_output_tokens: 1000 },
  });
  const marker = "TRANSFERRED_TASK_GOAL_TOOL_RESULT";
  const hasToolResult = (request) =>
    request.input.input.some(
      (item) =>
        item.type === "function_call_output" &&
        String(item.output).includes(marker) &&
        String(item.output).includes("Process exited with code 0"),
    );
  tool.calls = [call(`printf '${marker}\\n'`)];
  tool.release();
  await eventually(
    () => boundary.entered,
    (entered) => assert.equal(entered, true),
    60_000,
  );
  assert.ok(hasToolResult(boundary.request));
  const chat = () => suspensionChat(page, projectId, chatId);
  const pause = (paused) =>
    page.evaluate(
      async ({ chatId, paused }) =>
        (await import("/src/lib/api/chats.ts")).setChatPaused(chatId, paused),
      { chatId, paused },
    );
  const pausing = pause(true);
  void pausing.catch(() => {});
  await eventually(chat, (value) => assert.equal(value.automationPaused, true));
  boundary.calls = [call(":")];
  boundary.release();
  saved.pauseReply = await pausing;
  assert.equal(saved.pauseReply.paused, true);
  saved.paused = (
    await eventually(chat, (value) => {
      assert.equal(value.nativeSuspension?.phase, "paused");
      assert.equal(value.nativeSuspension.resumable, true);
    })
  ).nativeSuspension;
  assert.equal(
    saved.paused.active.threadId,
    result.taskGoalProviderTransfer.latest.binding.threadId,
  );
  assert.notEqual(
    saved.paused.active.turnId,
    result.taskGoalProviderTransfer.keeper.identity.recovery.turnId,
  );
  const calls = () =>
    model.requests.filter((request) => request.method === "POST");
  const before = structuredClone(calls());
  await stopWorker();
  await startWorker();
  saved.reopened = (await chat()).nativeSuspension;
  assert.equal(saved.reopened.phase, "paused");
  assert.deepEqual(saved.reopened.active, saved.paused.active);
  assert.deepEqual(
    calls(),
    before,
    "a paused transfer starts no inference on worker restart",
  );
  saved.resumeReply = await pause(false);
  assert.equal(saved.resumeReply.paused, false);
  await eventually(
    () => continued.entered,
    (entered) => assert.equal(entered, true),
    60_000,
  );
  assert.ok(hasToolResult(continued.request));
}
