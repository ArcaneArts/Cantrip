import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";

export async function importRestarts({ state, runCase, restart, result }) {
  let releaseRead;
  state.readBarrier = new Promise((resolve) => {
    releaseRead = resolve;
  });
  try {
    await runCase("read-crash-recovery", {
      intercept: async (job) => {
        await eventually(
          () => state.commands,
          (calls) =>
            assert.ok(
              calls.some(
                (c) =>
                  c.command.type === "external.chat-history.read" &&
                  c.command.chatId === job.id,
              ),
            ),
        );
        await restart("reading", job, async () => {
          releaseRead();
          state.readBarrier = undefined;
        });
      },
    });
  } finally {
    releaseRead();
    state.readBarrier = undefined;
  }
  let releaseHydration;
  state.hydrationBarrier = new Promise((resolve) => {
    releaseHydration = resolve;
  });
  let before;
  try {
    const recovered = await runCase("hydration-crash-recovery", {
      intercept: async (job) => {
        await eventually(
          () => state.commands,
          (calls) =>
            assert.ok(
              calls.some(
                (c) =>
                  c.command.type === "chat.relocation.hydration.complete" &&
                  c.command.snapshotId === job.id,
              ),
            ),
        );
        before = await restart("hydrating", job, async () => {
          releaseHydration();
          state.hydrationBarrier = undefined;
          await eventually(
            () => state.snapshots.get(job.id),
            (snapshot) => assert.ok(snapshot?.threadId),
          );
        });
      },
    });
    assert.deepEqual(
      recovered.raw.messages.filter((m) => m.chat_id === recovered.job.id),
      before.messages.filter((m) => m.chat_id === recovered.job.id),
      "Server crash preserves exact canonical messages written before hydration acknowledgment",
    );
    assert.equal(
      state.uploads.filter((u) => u.snapshotId === recovered.job.id).length,
      1,
      "Server restart reuses the existing worker thread and immutable upload",
    );
    result.restarts.at(-1).immutableMessagesPreserved = true;
  } finally {
    releaseHydration();
    state.hydrationBarrier = undefined;
  }
}
