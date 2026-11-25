import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { projectToolOutput } from "./actual-council-project-creation.mjs";
import { eventually } from "./full-worker.mjs";

const timeout = 60_000;
const complete = (plan) =>
  eventually(
    () => plan.request?.completed,
    (done) => assert.equal(done, true),
    timeout,
  );

export async function actualCouncilTaskStarts({
  page,
  model,
  target,
  tool,
  projectId,
  submit,
  idle,
  readTask,
  taskResults,
  result,
}) {
  const starts = [];
  for (const planGoalEnabled of [false, true]) {
    const expectedKind = planGoalEnabled ? "initial-plan" : "direct";
    const brief = `Existing ${expectedKind} Task that the owner asked Council to start 🌲.`;
    const answer = `The project worker finished the ${expectedKind} Task operation 🍄.`;
    const task = await page.evaluate(
      async ({ projectId, planGoalEnabled, brief }) => {
        const api = await import("/src/lib/api/tasks.ts");
        const { chat, task } = await api.createTask(
          projectId,
          `Existing Task ${planGoalEnabled ? "with a plan" : "without a plan"}`,
        );
        const draft = await api.updateTaskDraft(chat.id, {
          rowVersion: task.rowVersion,
          briefMarkdown: brief,
          planGoalEnabled,
        });
        return draft;
      },
      { projectId, planGoalEnabled, brief },
    );
    assert.equal(task.state, "draft");
    const args = { projectId, taskId: task.chatId, operationId: randomUUID() };
    const start = { ...tool, arguments: args };
    const worker = target.reply({
      text: planGoalEnabled
        ? JSON.stringify({ planMarkdown: answer, questions: [] })
        : answer,
      hold: true,
    });
    try {
      await idle();
      const first = `council-existing-task-${expectedKind}`;
      model.reply({ responseId: first, calls: [start] });
      const sent = model.reply({ text: "I queued the existing Task." });
      assert.equal(
        (await submit(`Start the existing Task ${args.taskId}.`)).status,
        "queued",
      );
      await complete(sent);
      const receipt = projectToolOutput(sent, first + "-call-0");
      assert.equal(receipt.taskId, args.taskId);
      assert.equal(receipt.kind, expectedKind);

      await eventually(
        () => worker.entered,
        (entered) => assert.ok(entered, JSON.stringify(target.failures)),
        timeout,
      );
      await idle();
      const wake = model.reply({
        text: "I received the existing Task operation result.",
      });
      worker.release();
      const finished = await eventually(
        () => readTask(task.chatId),
        (current) => {
          assert.equal(current.state, planGoalEnabled ? "review" : "complete");
          assert.equal(current.dispatch.state, "succeeded");
          assert.equal(current.dispatch.id, receipt.dispatchId);
        },
        timeout,
      );
      await complete(wake);
      assert.ok(JSON.stringify(worker.request.input.input).includes(brief));
      assert.ok(JSON.stringify(wake.request.input.input).includes(answer));

      await idle();
      const repeated = first + "-retry";
      model.reply({ responseId: repeated, calls: [start] });
      const retried = model.reply({
        text: "The existing Task has the original dispatch receipt.",
      });
      assert.equal(
        (await submit(`Retry the completed ${expectedKind} Task request.`))
          .status,
        "queued",
      );
      await complete(retried);
      assert.deepEqual(
        projectToolOutput(retried, repeated + "-call-0"),
        receipt,
      );
      await idle();
      const results = (await taskResults()).filter(
        ({ chatId }) => chatId === task.chatId,
      );
      assert.equal(results.length, 1);
      const [source] = results;
      assert.equal(source.status, "completed");
      assert.equal(source.threadId, finished.dispatch.codexThreadId);
      assert.equal(source.turnId, finished.dispatch.turnId);
      assert.ok(source.inputMessageId);
      starts.push({ receipt, source });
    } finally {
      worker.release();
    }
  }
  assert.deepEqual(model.failures, []);
  assert.deepEqual(target.failures, []);
  result.councilExistingTaskStarts = starts;
  result.steps.push(
    "Council scheduled existing direct and Plan + Goal Tasks, received exact callbacks, and replayed completed starts without new dispatches",
  );
}
