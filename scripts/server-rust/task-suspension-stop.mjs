import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { eventually } from "./full-worker.mjs";
import { damageColdStopCheckpoint } from "./cold-suspension-stop.mjs";

export async function qualifyTaskSuspensionStop({
  page,
  chatId,
  workerData,
  native,
  damage,
  chat,
  readTask,
  inferences,
  before,
  events,
  control,
}) {
  if (damage) await damageColdStopCheckpoint(workerData, native, damage);
  const count = inferences();
  control.stopReplies = await page.evaluate(async (id) => {
    const { interruptChat } = await import("/src/lib/api/chats.ts");
    return Promise.all([interruptChat(id), interruptChat(id)]);
  }, chatId);
  assert.ok(control.stopReplies.every((value) => value.interrupted));
  control.stoppedChat = await eventually(chat, (value) => {
    assert.equal(value.nativeSuspension.phase, "stopped");
    assert.equal(value.nativeSuspension.resumable, false);
    assert.equal(value.status, "idle");
    assert.deepEqual(value.nativeSuspension.active, native);
  });
  control.stoppedTask = await readTask();
  assert.equal(control.stoppedTask.planningRound, before.task.planningRound);
  assert.equal(
    control.stoppedTask.dispatch.operationId,
    before.task.dispatch.operationId,
  );
  assert.equal(
    control.stoppedTask.dispatch.attemptCount,
    before.task.dispatch.attemptCount,
  );
  assert.equal(control.stoppedTask.dispatch.state, "paused");
  control.lateResume = await page.evaluate(async (id) => {
    try {
      return {
        result: await (
          await import("/src/lib/api/chats.ts")
        ).setChatPaused(id, false),
      };
    } catch (error) {
      return { status: error.status, message: error.message };
    }
  }, chatId);
  await delay(300);
  assert.equal((await chat()).nativeSuspension.phase, "stopped");
  assert.equal(
    inferences(),
    count,
    "Late Resume cannot resurrect the stopped Task turn",
  );
  const history = await events();
  assert.equal(
    history.filter((event) => event.type === "task_started").length,
    1,
  );
  assert.equal(
    history.filter((event) => event.type === "task_complete").length,
    0,
  );
  const stopped = history.filter((event) => event.type === "turn_aborted");
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].turn_id, native.turnId);
  return { native, stopped: true, requests: count, completedToolExecutions: 1 };
}
