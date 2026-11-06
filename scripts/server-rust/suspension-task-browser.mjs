// Actual Task controls, native history, and whole-worker termination.
import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eventually } from "./full-worker.mjs";
import { suspensionChat } from "./durable-suspension-browser.mjs";

export async function qualifyTaskSuspension({
  page,
  projectId,
  chatId,
  directory,
  workerData,
  model,
  boundary,
  command,
  inferences,
  result,
  completeOnly = false,
  restart,
}) {
  const evidence = (result.taskPauseEvidence = {});
  const readTask = () =>
    page.evaluate(
      async (id) => (await import("/src/lib/api/tasks.ts")).getTask(id),
      chatId,
    );
  const chat = () => suspensionChat(page, projectId, chatId);
  const pause = (paused) =>
    page.evaluate(
      async ({ id, paused }) =>
        (await import("/src/lib/api/chats.ts")).setChatPaused(id, paused),
      { id: chatId, paused },
    );
  assert.equal(
    await readFile(path.join(directory, "durable-cold-marker"), "utf8"),
    "DURABLE_TOOL_RESULT\n",
  );
  assert.ok(
    JSON.stringify(boundary.request.input.input).includes(
      "DURABLE_TOOL_RESULT",
    ),
  );
  evidence.beforePause = { chat: await chat(), task: await readTask() };
  const nativeOwners = new Map();
  for await (const relative of glob("**/admission.json", { cwd: workerData })) {
    const journal = JSON.parse(
      await readFile(path.join(workerData, relative), "utf8"),
    );
    for (const record of Object.values(journal.operations)) {
      if (record.identity.chatId !== chatId || !record.nativeExecution)
        continue;
      const { threadId, turnId } = record.nativeExecution;
      nativeOwners.set(JSON.stringify([threadId, turnId]), {
        threadId,
        turnId,
      });
    }
  }
  assert.equal(
    nativeOwners.size,
    1,
    "The actual Task has one bound native turn",
  );
  const native = [...nativeOwners.values()][0];
  assert.equal(
    evidence.beforePause.task.dispatch.codexThreadId,
    native.threadId,
    "Canonical Task dispatch is bound before model execution",
  );
  assert.equal(
    evidence.beforePause.task.dispatch.turnId,
    native.turnId,
    "Canonical Task dispatch preserves the actual native turn",
  );
  evidence.native = native;
  if (completeOnly) {
    boundary.text = "DURABLE_TASK_RECOVERED_FINAL";
    boundary.release();
    evidence.completed = await eventually(readTask, (value) =>
      assert.equal(value.state, "complete"),
    );
    assert.equal(
      evidence.completed.planningRound,
      evidence.beforePause.task.planningRound,
    );
    assert.equal(inferences(), 2);
  } else {
    const pausing = pause(true);
    void pausing.catch(() => {});
    await eventually(chat, (value) =>
      assert.equal(value.automationPaused, true),
    );
    // Keep the native turn unfinished after this response. The real Task pause
    // must hold its next model boundary, rather than observe normal completion.
    boundary.calls = [
      {
        ...command,
        arguments: {
          cmd: "printf 'DURABLE_TASK_BOUNDARY\\n'",
          yield_time_ms: 1000,
          max_output_tokens: 1000,
        },
      },
    ];
    boundary.release();
    evidence.acknowledged = await pausing;
    assert.equal(evidence.acknowledged.paused, true);
    const count = inferences();
    const next = model.reply({
      text: "DURABLE_TASK_RECOVERED_FINAL",
      hold: true,
    });
    await restart(native);
    evidence.afterRestart = { chat: await chat(), task: await readTask() };
    assert.equal(evidence.afterRestart.chat.automationPaused, true);
    await delay(300);
    assert.equal(
      inferences(),
      count,
      "Task startup and reopening must remain idle",
    );
    assert.equal(
      await readFile(path.join(directory, "durable-cold-marker"), "utf8"),
      "DURABLE_TOOL_RESULT\n",
    );
    evidence.resumed = await pause(false);
    assert.equal(evidence.resumed.paused, false);
    await eventually(
      () => next.entered,
      (value) => assert.equal(value, true),
    );
    assert.ok(
      JSON.stringify(next.request.input.input).includes("DURABLE_TOOL_RESULT"),
    );
    next.release();
    evidence.completed = await eventually(readTask, (value) =>
      assert.equal(value.state, "complete"),
    );
  }
  const rollouts = [];
  for await (const relative of glob("**/rollout-*.jsonl", { cwd: workerData }))
    if (path.basename(relative).includes(native.threadId))
      rollouts.push(path.join(workerData, relative));
  assert.equal(rollouts.length, 1);
  const history = (await readFile(rollouts[0], "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const events = history
    .filter((row) => row.type === "event_msg")
    .map((row) => row.payload);
  const starts = events.filter((event) => event.type === "task_started");
  assert.equal(
    starts.length,
    1,
    "Cold Task Resume cannot create a replacement turn",
  );
  assert.equal(starts[0].turn_id, native.turnId);
  assert.equal(
    events.filter((event) => event.type === "task_complete").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "turn_aborted").length,
    0,
  );
  assert.equal(
    await readFile(path.join(directory, "durable-cold-marker"), "utf8"),
    "DURABLE_TOOL_RESULT\n",
  );
  return {
    native,
    sameTurn: true,
    coldResumed: !completeOnly,
    requests: inferences(),
    completedToolExecutions: 1,
  };
}
