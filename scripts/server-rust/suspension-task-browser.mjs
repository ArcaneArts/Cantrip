// Actual Task controls, native history, and whole-worker termination.
import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eventually } from "./full-worker.mjs";
import { suspensionChat } from "./durable-suspension-browser.mjs";
import { qualifyTaskRestoreRetry } from "./task-suspension-retry.mjs";
import { qualifyTaskSuspensionStop } from "./task-suspension-stop.mjs";
import { stopRestoringTask } from "./task-suspension-stop-restoring.mjs";

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
  pauseOnly = false,
  livePause = false,
  rounds = 1,
  duplicateResume = false,
  restoreDamage,
  stopOnly = false,
  stopDamage,
  stopPendingPause = false,
  stopRunning = false,
  stopRestoring = false,
  workerId,
  startBlocker,
  restart,
}) {
  const evidence = (result.taskPauseEvidence = {
    mode: stopRunning
      ? "running-stop"
      : stopRestoring
        ? "restoring-stop"
        : stopPendingPause
          ? "pending-pause-stop"
          : stopOnly
            ? livePause
              ? "live-stop"
              : "cold-stop"
            : completeOnly
              ? "complete"
              : pauseOnly
                ? "cold-pause"
                : livePause
                  ? "live-pause"
                  : "cold-resume",
  });
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
  if (stopRunning) {
    const control = {};
    evidence.rounds = [control];
    return qualifyTaskSuspensionStop({
      page,
      chatId,
      workerData,
      native,
      chat,
      readTask,
      inferences,
      before: evidence.beforePause,
      control,
      events: () => nativeTaskEvents(workerData, native),
    });
  }
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
    assert.ok(Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 4);
    let currentBoundary = boundary;
    evidence.rounds = [];
    for (let round = 1; round <= rounds; round++) {
      const control = {};
      evidence.rounds.push(control);
      const pausing = pause(true);
      void pausing.catch(() => {});
      await eventually(chat, (value) =>
        assert.equal(value.automationPaused, true),
      );
      if (stopPendingPause) {
        const stopped = await qualifyTaskSuspensionStop({
          page,
          chatId,
          workerData,
          native,
          chat,
          readTask,
          inferences,
          before: evidence.beforePause,
          control,
          events: () => nativeTaskEvents(workerData, native),
        });
        control.pendingPauseReply = await pausing.then(
          (result) => ({ result }),
          (error) => ({ error: error.message }),
        );
        assert.equal((await chat()).nativeSuspension.phase, "stopped");
        return { ...stopped, pendingPause: true };
      }
      currentBoundary.calls = [
        {
          ...command,
          arguments: {
            cmd: "printf 'DURABLE_TASK_BOUNDARY\\n'",
            yield_time_ms: 1000,
            max_output_tokens: 1000,
          },
        },
      ];
      currentBoundary.release();
      control.acknowledged = evidence.acknowledged = await pausing;
      assert.equal(control.acknowledged.paused, true);
      const count = inferences();
      const next = stopRestoring
        ? null
        : model.reply({
            text: "DURABLE_TASK_RECOVERED_FINAL",
            hold: true,
          });
      if (!livePause) await restart(native, round);
      control.afterRestart = evidence.afterRestart = {
        chat: await chat(),
        task: await readTask(),
      };
      const held = control.afterRestart;
      assert.equal(held.chat.automationPaused, true);
      assert.equal(held.chat.nativeSuspension.phase, "paused");
      assert.equal(held.chat.nativeSuspension.resumable, true);
      assert.deepEqual(held.chat.nativeSuspension.active, native);
      assert.equal(
        held.task.planningRound,
        evidence.beforePause.task.planningRound,
      );
      assert.equal(
        held.task.dispatch.operationId,
        evidence.beforePause.task.dispatch.operationId,
      );
      assert.equal(held.task.dispatch.state, livePause ? "running" : "paused");
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
      if (pauseOnly) {
        const events = await nativeTaskEvents(workerData, native);
        const starts = events.filter((event) => event.type === "task_started");
        assert.equal(starts.length, 1);
        assert.equal(starts[0].turn_id, native.turnId);
        assert.equal(
          events.filter((event) => event.type === "task_complete").length,
          0,
        );
        assert.equal(
          events.filter((event) => event.type === "turn_aborted").length,
          0,
        );
        return {
          native,
          coldResumed: false,
          durablyPaused: true,
          requests: inferences(),
          completedToolExecutions: 1,
        };
      }
      if (stopRestoring)
        return stopRestoringTask({
          page,
          chatId,
          workerId,
          workerData,
          native,
          chat,
          readTask,
          inferences,
          before: evidence.beforePause,
          control,
          events: () => nativeTaskEvents(workerData, native),
          startBlocker,
        });
      if (stopOnly)
        return qualifyTaskSuspensionStop({
          page,
          chatId,
          workerData,
          native,
          damage: stopDamage,
          chat,
          readTask,
          inferences,
          before: evidence.beforePause,
          control,
          events: () => nativeTaskEvents(workerData, native),
        });
      if (restoreDamage)
        await qualifyTaskRestoreRetry({
          workerData,
          native,
          mode: restoreDamage,
          page,
          chatId,
          chat,
          readTask,
          inferences,
          before: evidence.beforePause,
          control,
        });
      control.resumeReplies = await Promise.all(
        duplicateResume ? [pause(false), pause(false)] : [pause(false)],
      );
      for (const reply of control.resumeReplies)
        assert.equal(reply.paused, false);
      control.resumed = evidence.resumed = control.resumeReplies[0];
      await eventually(
        () => next.entered,
        (value) => assert.equal(value, true),
      );
      assert.ok(
        JSON.stringify(next.request.input.input).includes(
          "DURABLE_TOOL_RESULT",
        ),
      );
      if (duplicateResume) assert.equal((await pause(false)).paused, false);
      if (round < rounds) {
        currentBoundary = next;
      } else {
        next.release();
        evidence.completed = await eventually(readTask, (value) =>
          assert.equal(value.state, "complete"),
        );
      }
    }
    assert.equal(
      evidence.completed.planningRound,
      evidence.beforePause.task.planningRound,
    );
    assert.equal(
      evidence.completed.dispatch.operationId,
      evidence.beforePause.task.dispatch.operationId,
    );
    assert.equal(
      evidence.completed.dispatch.attemptCount,
      evidence.beforePause.task.dispatch.attemptCount,
    );
    evidence.completedChat = await chat();
    assert.equal(evidence.completedChat.nativeSuspension.phase, "completed");
    assert.equal(evidence.completedChat.nativeSuspension.resumable, false);
    assert.equal(inferences(), 2 + rounds);
  }

  const events = await nativeTaskEvents(workerData, native);
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
    coldResumed: !completeOnly && !livePause,
    suspensionRounds: completeOnly ? 0 : rounds,
    requests: inferences(),
    completedToolExecutions: 1,
  };
}

async function nativeTaskEvents(workerData, native) {
  const rollouts = [];
  for await (const relative of glob("**/rollout-*.jsonl", { cwd: workerData }))
    if (path.basename(relative).includes(native.threadId))
      rollouts.push(path.join(workerData, relative));
  assert.equal(rollouts.length, 1);
  const history = (await readFile(rollouts[0], "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return history
    .filter((row) => row.type === "event_msg")
    .map((row) => row.payload);
}
