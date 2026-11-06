import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";
import { suspensionCapacityStatus } from "./suspension-capacity-browser.mjs";
import { qualifyTaskSuspensionStop } from "./task-suspension-stop.mjs";

export async function stopRestoringTask({
  page,
  chatId,
  workerId,
  workerData,
  native,
  chat,
  readTask,
  inferences,
  before,
  control,
  events,
  startBlocker,
}) {
  const blocker = await startBlocker();
  const count = inferences();
  const pending = page.evaluate(async (id) => {
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
  void pending.catch(() => {});
  control.restoringCapacity = await eventually(
    () => suspensionCapacityStatus(page, workerId),
    (status) => {
      const operation = status.pools
        .flatMap((pool) => pool.operations)
        .find((operation) => operation.chatId === chatId);
      assert.equal(operation?.state, "waiting");
      assert.equal(operation.startedAt, null);
      assert.equal(
        status.pools.reduce((n, pool) => n + pool.activeCount, 0),
        1,
      );
    },
  );
  assert.equal((await chat()).nativeSuspension.phase, "resuming");
  const stopped = await qualifyTaskSuspensionStop({
    page,
    chatId,
    workerData,
    native,
    chat,
    readTask,
    inferences,
    before,
    control,
    events,
  });
  control.cancelledResume = await pending;
  assert.equal(control.cancelledResume.status, 502);
  const released = await page.evaluate(
    async (id) => (await import("/src/lib/api/chats.ts")).interruptChat(id),
    blocker.chatId,
  );
  assert.equal(released.interrupted, true);
  control.capacityAfterStop = await eventually(
    () => suspensionCapacityStatus(page, workerId),
    (status) => {
      assert.equal(
        status.pools.reduce((n, pool) => n + pool.activeCount, 0),
        0,
      );
      assert.ok(
        status.pools
          .flatMap((pool) => pool.operations)
          .every((operation) => operation.chatId !== chatId),
      );
    },
  );
  assert.equal(
    inferences(),
    count,
    "Freeing capacity cannot restart the stopped Task",
  );
  return { ...stopped, pendingRestoration: true, unusedCapacityReleased: true };
}
