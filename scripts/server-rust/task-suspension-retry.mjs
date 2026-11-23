import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { glob, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { damageColdStopCheckpoint } from "./cold-suspension-stop.mjs";

/** Damage the committed native file, attempt the real control, and repair only
 * the fixture's bytes. A failed physical restore must retain the logical Task. */
export async function qualifyTaskRestoreRetry({
  workerData,
  native,
  mode,
  page,
  chatId,
  chat,
  readTask,
  inferences,
  before,
  control,
}) {
  const name =
    createHash("sha256").update(native.threadId).digest("hex") + ".json";
  const files = [];
  for await (const file of glob(`**/turn-suspensions/${name}`, {
    cwd: workerData,
  }))
    files.push(path.join(workerData, file));
  assert.equal(files.length, 1);
  const file = files[0];
  const saved = await readFile(file);
  await damageColdStopCheckpoint(workerData, native, mode);
  const damaged = await readFile(file).catch((error) => {
    assert.equal(error.code, "ENOENT");
    return null;
  });
  const count = inferences();
  control.restoreFailure = await page.evaluate(async (id) => {
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
  const held = (control.failedRestore = {
    chat: await chat(),
    task: await readTask(),
  });
  assert.equal(control.restoreFailure.status, 502);
  assert.equal(held.chat.automationPaused, true);
  assert.equal(held.chat.nativeSuspension.phase, "error");
  assert.equal(held.chat.nativeSuspension.action, "resume");
  assert.equal(held.chat.nativeSuspension.resumable, true);
  assert.deepEqual(held.chat.nativeSuspension.active, native);
  assert.equal(held.task.state, before.task.state);
  assert.equal(held.task.planningRound, before.task.planningRound);
  assert.equal(
    held.task.dispatch.operationId,
    before.task.dispatch.operationId,
  );
  assert.equal(
    held.task.dispatch.attemptCount,
    before.task.dispatch.attemptCount,
  );
  assert.equal(held.task.dispatch.state, "paused");
  assert.equal(
    inferences(),
    count,
    "Failed restoration cannot dispatch inference",
  );
  const retained = await readFile(file).catch((error) => {
    assert.equal(error.code, "ENOENT");
    return null;
  });
  assert.deepEqual(
    retained,
    damaged,
    "Failed restore must retain incompatible or damaged evidence",
  );
  await writeFile(file, saved);
}
