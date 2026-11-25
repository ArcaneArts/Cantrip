import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { projectToolOutput } from "./actual-council-project-creation.mjs";
import { eventually } from "./full-worker.mjs";

export async function actualCouncilProjectControls({
  page,
  model,
  target,
  tools,
  submit,
  idle,
  councilId,
  projectId,
  targetChatId,
  targetProfileId,
  result,
}) {
  const findTool = (name) => {
    const tool = tools.find(
      (entry) => entry.name === name || entry.name.endsWith("__" + name),
    );
    assert.ok(tool, `Missing ${name}`);
    return tool;
  };
  const interrupt = findTool("council_project_interrupt");
  const taskTool = findTool("council_project_task_create");
  const opened = (plan) =>
    eventually(
      () => plan.entered,
      (entered) => assert.equal(entered, true),
      60_000,
    );
  const closed = (plan) =>
    eventually(
      () => plan.request?.closedBeforeCompletion,
      (ended) => assert.equal(ended, true),
      60_000,
    );
  const complete = (plan) =>
    eventually(
      () => plan.request?.completed,
      (ended) => assert.equal(ended, true, JSON.stringify(model.failures)),
      60_000,
    );
  const startProjectTurn = (text) =>
    page.evaluate(
      async ({ targetChatId, targetProfileId, text }) =>
        (await import("/src/lib/api/chats.ts")).startTurn(targetChatId, text, {
          modelId: targetProfileId,
          reasoningEffort: null,
          customSubagentModel: false,
          subagentModelId: null,
          subagentReasoningEffort: null,
        }),
      { targetChatId, targetProfileId, text },
    );
  const invoke = async (tool, args, id, text) => {
    model.reply({ responseId: id, calls: [{ ...tool, arguments: args }] });
    const confirmation = model.reply({
      text: "I received the project control receipt.",
    });
    assert.equal((await submit(text)).status, "queued");
    await complete(confirmation);
    return projectToolOutput(confirmation, id + "-call-0");
  };

  const projectTurn = target.reply({
    text: "The first project response must be interrupted.",
    hold: true,
  });
  try {
    assert.equal(
      (await startProjectTurn("Start a project turn that will be interrupted."))
        .status,
      "queued",
    );
    await opened(projectTurn);
    const args = {
      projectId,
      chatId: targetChatId,
      targetKind: "agent",
      operationId: randomUUID(),
    };
    const receipt = await invoke(
      interrupt,
      args,
      "council-interrupt-agent",
      "Interrupt the active remote project Agent turn.",
    );
    assert.deepEqual(receipt, { ...args, status: "interrupted" });
    await closed(projectTurn);
    await idle();

    const later = target.reply({
      text: "The later project turn completed.",
      hold: true,
    });
    try {
      assert.equal(
        (await startProjectTurn("Start an independent later project turn."))
          .status,
        "queued",
      );
      await opened(later);
      assert.deepEqual(
        await invoke(
          interrupt,
          args,
          "council-interrupt-retry",
          "Check the original interruption receipt.",
        ),
        receipt,
      );
      assert.equal(later.request.closed, false);
      later.release();
      await complete(later);
    } finally {
      later.release();
    }
    result.councilProjectInterrupt = receipt;
  } finally {
    projectTurn.release();
  }

  await idle();
  const heldTask = target.reply({
    text: "This Task should stop before completing.",
    hold: true,
  });
  try {
    const task = await invoke(
      taskTool,
      {
        projectId,
        operationId: randomUUID(),
        title: "Council Task stop probe",
        description: "Wait for the explicit project stop test.",
      },
      "council-interrupt-task-create",
      "Start a Task that will be stopped later.",
    );
    await opened(heldTask);
    await idle();
    const parent = model.reply({
      text: "This Council turn will be stopped independently.",
      hold: true,
    });
    try {
      assert.equal(
        (await submit("Start an unrelated Council turn while the Task runs."))
          .status,
        "queued",
      );
      await opened(parent);
      const stopped = await page.evaluate(
        async (id) => (await import("/src/lib/api/chats.ts")).interruptChat(id),
        councilId,
      );
      assert.equal(stopped.interrupted, true);
      await closed(parent);
      assert.equal(heldTask.request.closed, false);
    } finally {
      parent.release();
    }
    await idle();
    const taskStop = await invoke(
      interrupt,
      {
        projectId,
        chatId: task.taskId,
        targetKind: "task",
        operationId: randomUUID(),
      },
      "council-interrupt-task",
      "Stop the delegated project Task explicitly.",
    );
    assert.equal(taskStop.status, "interrupted");
    await closed(heldTask);
    const readTask = () =>
      page.evaluate(
        async (id) => (await import("/src/lib/api/tasks.ts")).getTask(id),
        task.taskId,
      );
    await eventually(
      readTask,
      (value) => assert.equal(value.dispatch.state, "paused"),
      60_000,
    );
    result.councilProjectTaskInterrupt = taskStop;
  } finally {
    heldTask.release();
  }
  await idle();
  assert.deepEqual(model.failures, []);
  assert.deepEqual(target.failures, []);
  result.steps.push(
    "Council interrupted a real remote Agent turn, replayed its receipt safely, and stopped a delegated Task explicitly. Stopping the parent Council turn left the Task running.",
  );
}
