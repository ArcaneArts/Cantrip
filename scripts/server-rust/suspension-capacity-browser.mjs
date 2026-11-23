import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import path from "node:path";
import { eventually } from "./full-worker.mjs";

export async function startSuspensionCapacityBlocker({
  page,
  model,
  projectId,
  providerId,
  workerId,
  configuration,
  waitForAdmission = true,
}) {
  const blocker = await page.evaluate(
    async ({ projectId }) =>
      (
        await (
          await import("/src/lib/api/conversations.ts")
        ).prepareConversationCreation(projectId, "Capacity blocker", false)
      )(),
    { projectId },
  );
  const reply = model.reply({
    text: "DURABLE_CAPACITY_BLOCKER",
    hold: true,
    responseId: "capacity-blocker-response",
  });
  await eventually(
    () =>
      page.evaluate(
        async (id) =>
          (await import("/src/lib/api-client.ts")).request(
            `/api/chats/${id}/preparation`,
          ),
        blocker.id,
      ),
    (value) => assert.equal(value.preparation?.phase, "ready"),
    60_000,
  );
  await page.evaluate(
    async ({ chatId, configuration }) => {
      return (await import("/src/lib/api/chats.ts")).startTurn(
        chatId,
        "DURABLE_CAPACITY_BLOCKER",
        configuration,
      );
    },
    { chatId: blocker.id, configuration },
  );
  if (!waitForAdmission) return { chatId: blocker.id, reply };
  await eventually(
    () => reply.entered,
    (value) => assert.equal(value, true),
  );
  const status = await eventually(
    () => suspensionCapacityStatus(page, workerId),
    (value) => {
      const pool = value.pools.find((pool) => pool.providerId === providerId);
      assert.equal(pool?.maxConcurrentInference, 1);
      assert.equal(pool.activeCount, 1);
    },
  );
  return { chatId: blocker.id, status };
}

export function suspensionCapacityStatus(page, workerId) {
  return page.evaluate(
    async (workerId) =>
      (await import("/src/lib/api/workers.ts")).getWorkerInferenceStatus(
        workerId,
      ),
    workerId,
  );
}

export async function pauseWaitingSuspension({
  page,
  chatId,
  workerId,
  workerData,
  model,
  blocker,
  expectedState = "waiting",
}) {
  const status = await eventually(
    () => suspensionCapacityStatus(page, workerId),
    (value) => {
      const waiting = value.pools
        .flatMap((pool) => pool.operations)
        .find((operation) => operation.chatId === chatId);
      assert.equal(waiting?.state, expectedState);
      assert.equal(waiting.startedAt, null);
    },
  );
  const count = model.requests.filter(
    (request) => request.method === "POST",
  ).length;
  const history = [];
  const threadId = await page.evaluate(async (chatId) => {
    const identity = (
      await import("/src/lib/client-session.ts")
    ).getClientSessionIdentitySnapshot();
    return (
      await (
        await import("/src/lib/native-settings-api.ts")
      ).readNativeSettingsState({ chatId, identity })
    ).binding.threadId;
  }, chatId);
  for await (const relative of glob("**/rollout-*.jsonl", {
    cwd: workerData,
  })) {
    const rows = (await readFile(path.join(workerData, relative), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    history.push({
      relative,
      events: rows
        .filter((row) => row.type === "event_msg")
        .map((row) => ({
          type: row.payload.type,
          turnId: row.payload.turn_id,
        })),
    });
  }
  assert.equal(
    history
      .filter((row) => row.relative.includes(threadId))
      .flatMap((row) => row.events)
      .filter((event) => event.type === "task_started").length,
    0,
    JSON.stringify({ threadId, history }),
  );
  const paused = await page.evaluate(
    async (id) =>
      (await import("/src/lib/api/chats.ts")).setChatPaused(id, true),
    chatId,
  );
  assert.equal(paused.paused, true, JSON.stringify(paused));
  assert.equal(
    paused.active ?? null,
    null,
    "A request with no native turn cannot receive a fabricated active turn identity",
  );
  const stopped = blocker
    ? await page.evaluate(
        async (id) => (await import("/src/lib/api/chats.ts")).interruptChat(id),
        blocker.chatId,
      )
    : null;
  if (stopped) assert.equal(stopped.interrupted, true);
  if (blocker)
    await eventually(
      () => suspensionCapacityStatus(page, workerId),
      (value) => {
        assert.equal(
          value.pools.reduce((total, pool) => total + pool.activeCount, 0),
          0,
        );
      },
    );
  assert.equal(
    model.requests.filter((request) => request.method === "POST").length,
    count,
    "Freeing capacity cannot start the paused request",
  );
  const capacityAfterPause = await suspensionCapacityStatus(page, workerId);
  if (expectedState === "granted") {
    assert.equal(
      capacityAfterPause.pools.reduce(
        (total, pool) => total + pool.activeCount,
        0,
      ),
      0,
      "An acknowledged hold releases unused provider capacity",
    );
  }
  return { status, threadId, history, paused, stopped, capacityAfterPause };
}
