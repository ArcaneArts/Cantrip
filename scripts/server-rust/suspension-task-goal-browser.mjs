// Real encrypted Task planning/finalization and native Goal execution. These
// controls use the browser SDK and actual worker; no Goal or native IDs are seeded.
import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eventually } from "./full-worker.mjs";
import { suspensionChat } from "./durable-suspension-browser.mjs";
import { qualifyTaskRestoreRetry } from "./task-suspension-retry.mjs";
import { qualifyTaskSuspensionStop } from "./task-suspension-stop.mjs";

async function nativeHistory(workerData, threadId) {
  const files = [];
  for await (const file of glob("**/rollout-*.jsonl", { cwd: workerData }))
    if (path.basename(file).includes(threadId))
      files.push(path.join(workerData, file));
  assert.equal(files.length, 1);
  return (await readFile(files[0], "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
async function nativeEvents(workerData, threadId) {
  return (await nativeHistory(workerData, threadId))
    .filter((row) => row.type === "event_msg")
    .map((row) => row.payload);
}

export function queueTaskGoalPlanning(model) {
  model.reply({
    text: JSON.stringify({
      planMarkdown: "DURABLE_TASK_GOAL_PLAN",
      questions: [],
    }),
  });
  model.reply({
    text: JSON.stringify({
      finalPlanMarkdown: "DURABLE_TASK_GOAL_PLAN",
      goalPrompt: "DURABLE_TASK_GOAL_OBJECTIVE",
    }),
  });
}

export async function startSuspensionTaskGoal(page, chatId, rowVersion) {
  await page.evaluate(
    async ({ chatId, rowVersion }) =>
      (await import("/src/lib/api/tasks.ts")).startTaskPlanning(chatId, {
        rowVersion,
        operationId: crypto.randomUUID(),
      }),
    { chatId, rowVersion },
  );
  const task = await eventually(
    () =>
      page.evaluate(
        async (id) => (await import("/src/lib/api/tasks.ts")).getTask(id),
        chatId,
      ),
    (value) => {
      assert.equal(value.state, "review");
      assert.equal(value.planMarkdown, "DURABLE_TASK_GOAL_PLAN");
    },
  );
  return page.evaluate(
    async ({ chatId, rowVersion }) =>
      (await import("/src/lib/api/tasks.ts")).beginTaskImplementation(chatId, {
        rowVersion,
        operationId: crypto.randomUUID(),
      }),
    { chatId, rowVersion: task.rowVersion },
  );
}

export async function qualifyTaskGoalSuspension({
  page,
  projectId,
  chatId,
  boundary,
  command,
  result,
  model,
  workerData,
  inferences,
  pauseOnly = false,
  livePause = false,
  rounds = 1,
  duplicateResume = false,
  restoreDamage,
  stopOnly = false,
  stopDamage,
  restart,
}) {
  const evidence = (result.taskGoalPauseEvidence = {});
  // The Goal keeps the acknowledged read-only planning policy. Its completed
  // command must succeed under that policy and survive recovery without replay.
  assert.ok(
    JSON.stringify(boundary.request.input.input).includes(
      "DURABLE_TOOL_RESULT",
    ),
  );
  assert.ok(
    boundary.request.input.input.some(
      (item) =>
        item.type === "function_call_output" &&
        String(item.output).includes("DURABLE_TOOL_RESULT") &&
        String(item.output).includes("Process exited with code 0"),
    ),
  );
  const chat = () => suspensionChat(page, projectId, chatId);
  const readGoal = () =>
    page.evaluate(
      async (id) => (await import("/src/lib/api/chats.ts")).getChatGoal(id),
      chatId,
    );
  const readTask = () =>
    page.evaluate(
      async (id) => (await import("/src/lib/api/tasks.ts")).getTask(id),
      chatId,
    );
  evidence.beforePause = await page.evaluate(async (id) => {
    const tasks = await import("/src/lib/api/tasks.ts");
    const chats = await import("/src/lib/api/chats.ts");
    return { task: await tasks.getTask(id), goal: await chats.getChatGoal(id) };
  }, chatId);
  const pausing = page.evaluate(
    async (id) =>
      (await import("/src/lib/api/chats.ts")).setChatPaused(id, true),
    chatId,
  );
  void pausing.catch(() => {});
  await eventually(chat, (value) => assert.equal(value.automationPaused, true));
  boundary.calls = [
    {
      ...command,
      arguments: { cmd: ":", yield_time_ms: 1000, max_output_tokens: 1000 },
    },
  ];
  boundary.release();
  evidence.pauseReply = await pausing;
  evidence.pausedChat = await chat();
  assert.equal(evidence.pauseReply.paused, true);
  assert.equal(evidence.pausedChat.nativeSuspension.phase, "paused");
  assert.equal(evidence.pausedChat.nativeSuspension.resumable, true);
  const native = evidence.pausedChat.nativeSuspension.active;
  evidence.pausedGoal = await readGoal();
  const count = inferences();
  assert.equal(count, 4);
  assert.equal(evidence.pausedGoal.goal.tokensUsed, 240);
  if (pauseOnly) return { native, durable: true, requests: count };
  if (!livePause) await restart(native, 1);
  evidence.reopenedChat = await chat();
  assert.equal(evidence.reopenedChat.nativeSuspension.phase, "paused");
  assert.deepEqual(evidence.reopenedChat.nativeSuspension.active, native);
  evidence.reopenedTask = await eventually(readTask, (value) => {
    assert.ok(["implementing", "paused"].includes(value.state));
    if (!livePause) assert.equal(value.dispatch.state, "paused");
  });
  evidence.reopenedGoal = await readGoal();
  assert.deepEqual(evidence.reopenedGoal.goal, evidence.pausedGoal.goal);
  await delay(200);
  assert.equal(
    inferences(),
    count,
    "Reopening a suspended Goal starts no inference",
  );
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
      control: evidence,
      events: async () =>
        (await nativeEvents(workerData, native.threadId)).filter(
          (event) => event.turn_id === native.turnId,
        ),
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
      before: { ...evidence.beforePause, task: evidence.reopenedTask },
      control: evidence,
    });
  const resume = () =>
    page.evaluate(
      async ({ id, duplicate }) => {
        const { setChatPaused } = await import("/src/lib/api/chats.ts");
        return Promise.all(
          Array.from({ length: duplicate ? 2 : 1 }, () =>
            setChatPaused(id, false),
          ),
        );
      },
      { id: chatId, duplicate: duplicateResume },
    );
  let continued = model.reply({
    text: "DURABLE_GOAL_RESTORED_BOUNDARY",
    hold: true,
  });
  evidence.resumeReplies = await resume();
  assert.ok(evidence.resumeReplies.every((reply) => reply.paused === false));
  await eventually(
    () => continued.entered,
    (value) => assert.equal(value, true),
  );
  evidence.resumedGoal = await readGoal();
  assert.equal(evidence.resumedGoal.goal.tokensUsed, 240);
  assert.equal(
    evidence.resumedGoal.goal.createdAt,
    evidence.pausedGoal.goal.createdAt,
  );
  assert.equal(
    evidence.resumedGoal.goal.objective,
    evidence.pausedGoal.goal.objective,
  );
  evidence.additionalRounds = [];
  for (let round = 2; round <= rounds; round++) {
    const control = {};
    evidence.additionalRounds.push(control);
    const pausing = page.evaluate(
      async (id) =>
        (await import("/src/lib/api/chats.ts")).setChatPaused(id, true),
      chatId,
    );
    void pausing.catch(() => {});
    await eventually(chat, (value) =>
      assert.equal(value.automationPaused, true),
    );
    continued.calls = [
      {
        ...command,
        arguments: { cmd: ":", yield_time_ms: 1000, max_output_tokens: 1000 },
      },
    ];
    continued.release();
    control.pauseReply = await pausing;
    control.pausedChat = await chat();
    assert.equal(control.pausedChat.nativeSuspension.phase, "paused");
    assert.deepEqual(control.pausedChat.nativeSuspension.active, native);
    control.pausedGoal = await readGoal();
    assert.equal(control.pausedGoal.goal.tokensUsed, 240 + (round - 1) * 120);
    const heldCount = inferences();
    if (!livePause) await restart(native, round);
    control.reopenedChat = await chat();
    assert.equal(control.reopenedChat.nativeSuspension.phase, "paused");
    assert.deepEqual(control.reopenedChat.nativeSuspension.active, native);
    assert.deepEqual((await readGoal()).goal, control.pausedGoal.goal);
    await delay(200);
    assert.equal(inferences(), heldCount);
    continued = model.reply({
      text: "DURABLE_GOAL_RESTORED_BOUNDARY",
      hold: true,
    });
    control.resumeReplies = await resume();
    assert.ok(control.resumeReplies.every((reply) => reply.paused === false));
    await eventually(
      () => continued.entered,
      (value) => assert.equal(value, true),
    );
    assert.equal(
      (await readGoal()).goal.tokensUsed,
      control.pausedGoal.goal.tokensUsed,
    );
  }
  const finishGoal = result.tools.find(
    (entry) =>
      entry.name === "update_goal" || entry.name.endsWith("__update_goal"),
  );
  assert.ok(finishGoal, "The actual Goal advertises its completion control");
  const completedWork = model.reply({
    text: "DURABLE_GOAL_WORK_ACCOUNTED",
    hold: true,
  });
  continued.calls = [
    {
      ...command,
      arguments: {
        cmd: "printf 'DURABLE_GOAL_RESUMED_RESULT\\n'",
        yield_time_ms: 1000,
        max_output_tokens: 1000,
      },
    },
  ];
  continued.release();
  await eventually(
    () => completedWork.entered,
    (value) => assert.equal(value, true),
  );
  assert.ok(
    completedWork.request.input.input.some(
      (item) =>
        item.type === "function_call_output" &&
        String(item.output).includes("DURABLE_GOAL_RESUMED_RESULT") &&
        String(item.output).includes("Process exited with code 0"),
    ),
  );
  evidence.accountedGoal = await readGoal();
  const completedWorkTokens = 240 + rounds * 120;
  assert.equal(evidence.accountedGoal.goal.tokensUsed, completedWorkTokens);
  model.reply({ text: "DURABLE_TASK_GOAL_RECOVERED_FINAL" });
  completedWork.calls = [{ ...finishGoal, arguments: { status: "complete" } }];
  completedWork.release();
  evidence.completedTask = await eventually(readTask, (value) =>
    assert.equal(value.state, "complete"),
  );
  evidence.completedChat = await eventually(chat, (value) => {
    assert.equal(value.nativeSuspension.phase, "completed");
    assert.equal(value.nativeSuspension.resumable, false);
  });
  evidence.completedGoal = await readGoal();
  assert.equal(evidence.completedGoal.goal.status, "complete");
  // The completion tool can execute before its streaming response's final
  // usage event. Compare the fully accounted work at the held boundary above;
  // the final control response may contribute its own additional 120 tokens.
  assert.ok(evidence.completedGoal.goal.tokensUsed >= completedWorkTokens);
  assert.ok(
    evidence.completedGoal.goal.tokensUsed <= completedWorkTokens + 120,
  );
  assert.equal(
    evidence.completedTask.planningRound,
    evidence.beforePause.task.planningRound,
  );
  assert.equal(
    evidence.completedTask.dispatch.operationId,
    evidence.beforePause.task.dispatch.operationId,
  );
  assert.equal(
    evidence.completedTask.dispatch.attemptCount,
    evidence.beforePause.task.dispatch.attemptCount,
  );
  assert.equal(inferences(), 6 + rounds);
  const history = await nativeHistory(workerData, native.threadId);
  const userInputs = history.filter(
    (row) =>
      row.type === "response_item" &&
      row.payload.type === "message" &&
      row.payload.role === "user" &&
      row.metadata?.retained_source?.id?.turn_id === native.turnId,
  );
  assert.equal(
    userInputs.length,
    1,
    "The original Goal input appears once across cold recovery",
  );
  assert.ok(
    JSON.stringify(userInputs[0].payload).includes(
      "DURABLE_TASK_GOAL_OBJECTIVE",
    ),
  );
  const events = history
    .filter((row) => row.type === "event_msg")
    .map((row) => row.payload);
  const allCommands = events.filter(
    (event) =>
      event.type === "item_completed" &&
      event.turn_id === native.turnId &&
      event.item.type === "CommandExecution",
  );
  assert.equal(
    allCommands.length,
    rounds + 2,
    "Every original, held-boundary and resumed command completes once",
  );
  assert.equal(
    new Set(allCommands.map((event) => event.item.id)).size,
    allCommands.length,
  );
  const completedCommands = events.filter(
    (event) =>
      event.type === "item_completed" &&
      event.turn_id === native.turnId &&
      event.item.type === "CommandExecution" &&
      event.item.exit_code === 0 &&
      event.item.aggregated_output.includes("DURABLE_TOOL_RESULT"),
  );
  assert.equal(
    completedCommands.length,
    1,
    "The completed Goal command was not executed again",
  );
  assert.equal(
    events.filter(
      (event) =>
        event.type === "task_started" && event.turn_id === native.turnId,
    ).length,
    1,
  );
  assert.equal(
    events.filter(
      (event) =>
        event.type === "task_complete" && event.turn_id === native.turnId,
    ).length,
    1,
  );
  assert.equal(
    events.filter(
      (event) =>
        event.type === "turn_aborted" && event.turn_id === native.turnId,
    ).length,
    0,
  );
  return {
    native,
    requests: inferences(),
    goalTokensUsed: evidence.completedGoal.goal.tokensUsed,
  };
}
