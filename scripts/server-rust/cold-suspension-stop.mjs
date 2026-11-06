import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { glob, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eventually } from "./full-worker.mjs";

export async function damageColdStopCheckpoint(workerData, active, mode) {
  assert.ok(["missing", "corrupt", "incompatible"].includes(mode));
  const name =
    createHash("sha256").update(active.threadId).digest("hex") + ".json";
  const files = [];
  for await (const relative of glob(`**/turn-suspensions/${name}`, {
    cwd: workerData,
  }))
    files.push(path.join(workerData, relative));
  assert.equal(
    files.length,
    1,
    "Damage the actual acknowledged native checkpoint",
  );
  const file = files[0];
  if (mode === "missing") return rm(file);
  if (mode === "corrupt") return writeFile(file, "{damaged native checkpoint");
  const envelope = JSON.parse(await readFile(file, "utf8"));
  const record = JSON.parse(envelope.recordJson);
  record.runtimeVersion = "unsupported-native-runtime/continuation-v999";
  record.continuation = { futureContinuation: true };
  envelope.recordJson = JSON.stringify(record);
  envelope.sha256 = createHash("sha256")
    .update(envelope.recordJson)
    .digest("hex");
  await writeFile(file, JSON.stringify(envelope));
}

/** Explicit Stop after whole-worker termination, without native Resume. */
export async function coldSuspensionStop({
  page,
  chatId,
  identity,
  workerData,
  active,
  inferences,
  mounted,
}) {
  const before = inferences();
  const stop = () =>
    page.evaluate(async (id) => {
      const { interruptChat } = await import("/src/lib/api/chats.ts");
      return Promise.all([interruptChat(id), interruptChat(id)]);
    }, chatId);
  let stopped;
  if (mounted) {
    const reply = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/chats/${chatId}/interrupt` &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Stop current operation" }).click();
    // Observe rejection immediately so an unsuccessful Stop still reaches the
    // fixture's report and owned-process cleanup instead of escaping the run.
    const duplicates = stop().then(
      (values) => ({ values, error: null }),
      (error) => ({ values: [], error }),
    );
    const response = await reply;
    assert.equal(response.status(), 200, await response.text());
    const repeated = await duplicates;
    if (repeated.error) throw repeated.error;
    stopped = [await response.json(), ...repeated.values];
  } else {
    stopped = await stop();
  }
  assert.ok(stopped.every((value) => value.interrupted));
  const chat = await eventually(identity, (value) => {
    assert.equal(value.nativeSuspension.phase, "stopped");
    assert.equal(value.nativeSuspension.resumable, false);
    assert.equal(value.status, "idle");
  });
  assert.deepEqual(chat.nativeSuspension.active, active);
  const resume = await page.evaluate(async (id) => {
    try {
      return {
        result: await (
          await import("/src/lib/api/chats.ts")
        ).setChatPaused(id, false),
      };
    } catch (error) {
      return { status: error.status };
    }
  }, chatId);
  if (resume.status) assert.equal(resume.status, 409);
  await delay(300);
  assert.equal(
    (await identity()).nativeSuspension.phase,
    "stopped",
    "A late Resume cannot resurrect the stopped turn",
  );
  const rollouts = [];
  for await (const relative of glob("**/rollout-*.jsonl", {
    cwd: workerData,
  }))
    if (path.basename(relative).includes(active.threadId))
      rollouts.push(path.join(workerData, relative));
  assert.equal(rollouts.length, 1);
  const history = (await readFile(rollouts[0], "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const events = history
    .filter((row) => row.type === "event_msg")
    .map((row) => row.payload);
  assert.equal(
    events.filter((event) => event.type === "task_started").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "task_complete").length,
    0,
  );
  const aborted = events.filter((event) => event.type === "turn_aborted");
  assert.equal(aborted.length, 1);
  assert.equal(aborted[0].turn_id, active.turnId);
  const items = history
    .filter((row) => row.type === "response_item")
    .map((row) => row.payload);
  assert.equal(
    items.filter(
      (item) =>
        item.type === "function_call_output" &&
        item.call_id === "task-fixture-response-0-call-0",
    ).length,
    1,
  );
  for (const [text, consumed] of [
    ["DURABLE_ORIGINAL_PROMPT", 1],
    ["DURABLE_ACCEPTED_PENDING_1", 0],
  ])
    assert.equal(
      items.filter(
        (item) =>
          item.type === "message" &&
          item.role === "user" &&
          item.content.some((part) => part.text === text),
      ).length,
      consumed,
    );
  await delay(300);
  assert.equal(inferences(), before, "Cold Stop must not start inference");
  return {
    native: active,
    phase: chat.nativeSuspension.phase,
    requests: before,
    nativeTurnStarts: 1,
    nativeTurnAborts: 1,
    mountedStop: !!mounted,
    lateResumeRejected: true,
  };
}
