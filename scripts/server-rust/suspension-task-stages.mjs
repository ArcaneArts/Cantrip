import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";

export const stagePlan = { planMarkdown: "DURABLE_STAGE_PLAN", questions: [] };
export const stageFinalization = {
  finalPlanMarkdown: "DURABLE_STAGE_FINAL_PLAN",
  goalPrompt: "DURABLE_STAGE_IMPLEMENTATION_GOAL",
};

export function stageCompletion(stage) {
  assert.ok(["direct", "plan", "finalize"].includes(stage));
  return {
    state:
      stage === "plan"
        ? "review"
        : stage === "finalize"
          ? "implementing"
          : "complete",
    text:
      stage === "plan"
        ? JSON.stringify(stagePlan)
        : stage === "finalize"
          ? JSON.stringify(stageFinalization)
          : "DURABLE_TASK_RECOVERED_FINAL",
    initialRequests: stage === "finalize" ? 3 : 2,
  };
}

export async function startTaskStage(page, chatId, rowVersion, stage) {
  const admitted = await page.evaluate(
    async ({ chatId, rowVersion }) =>
      (await import("/src/lib/api/tasks.ts")).startTaskPlanning(chatId, {
        rowVersion,
        operationId: crypto.randomUUID(),
      }),
    { chatId, rowVersion },
  );
  if (stage === "plan") return admitted;
  const planned = await eventually(
    () =>
      page.evaluate(
        async (id) => (await import("/src/lib/api/tasks.ts")).getTask(id),
        chatId,
      ),
    (task) => {
      assert.equal(task.state, "review");
      assert.equal(task.planMarkdown, stagePlan.planMarkdown);
    },
  );
  return page.evaluate(
    async ({ chatId, rowVersion }) =>
      (await import("/src/lib/api/tasks.ts")).beginTaskImplementation(chatId, {
        rowVersion,
        operationId: crypto.randomUUID(),
      }),
    { chatId, rowVersion: planned.rowVersion },
  );
}

function functions(tools, namespace) {
  return (tools ?? []).flatMap((tool) =>
    tool.type === "namespace"
      ? functions(tool.tools, tool.name)
      : tool.type === "function"
        ? [{ name: tool.name, namespace }]
        : [],
  );
}

/** A resumed finalizer must still deliver its protected plan and launch the
 * normal implementation Goal. This is a subsequent turn, never its replacement. */
export async function finishTaskStageGoal(page, chatId, model, reply) {
  await eventually(
    () => reply.entered,
    (value) => assert.equal(value, true),
  );
  assert.ok(
    JSON.stringify(reply.request.input.input).includes(
      stageFinalization.goalPrompt,
    ),
  );
  const finish = functions(reply.request.input.tools).find(
    (tool) =>
      tool.name === "update_goal" || tool.name.endsWith("__update_goal"),
  );
  assert.ok(finish, "The actual implementation Goal advertises completion");
  model.reply({ text: "DURABLE_STAGE_IMPLEMENTATION_COMPLETE" });
  reply.calls = [{ ...finish, arguments: { status: "complete" } }];
  reply.release();
  return eventually(
    () =>
      page.evaluate(
        async (id) => (await import("/src/lib/api/tasks.ts")).getTask(id),
        chatId,
      ),
    (task) => {
      assert.equal(task.state, "complete");
      assert.equal(task.finalPlanMarkdown, stageFinalization.finalPlanMarkdown);
      assert.ok(task.goalPrompt.includes(stageFinalization.goalPrompt));
    },
  );
}
