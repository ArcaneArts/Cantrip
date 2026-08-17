import {
  taskFinalizerResultSchema,
  taskPlannerResultSchema,
  type TaskDetail,
  type TaskFinalizerResult,
  type TaskOperationKind,
  type TaskPlannerResult,
} from "@cantrip/protocol/tasks";

const PLANNER_RULES = `You are planning a Cantrip Task. Investigate the repository and its effective Policies before proposing architecture. This turn is strictly read-only: do not edit files, mutate Git or GitHub, call side-effecting tools, or implement any part of the plan.

Return one complete replacement Markdown plan through the supplied structured output. Cover product behavior, architecture, persistence, APIs, UI, safety, tests, rollout, and independently mergeable milestones when relevant. Ask only questions whose answers materially change the plan. Give a recommended option when you have a defensible recommendation. Return an empty questions array when clarification is unnecessary. Do not claim to have inspected files or run checks that you did not inspect or run.

Effective Cantrip Policy summaries are supplied as application context. Run \`cantrip policy list\` and \`cantrip policy read <policy-key>\` for every summary that requires its full current body. Policies may constrain the future implementation even though this planning turn cannot write.`;

function answersMarkdown(task: TaskDetail): string {
  if (!task.currentAnswers.length) return "No answers were supplied.";
  const questions = new Map(
    task.currentQuestions.map((question) => [question.id, question]),
  );
  return task.currentAnswers
    .map((answer) => {
      const question = questions.get(answer.questionId);
      const option = question?.options.find(
        (candidate) => candidate.id === answer.optionId,
      );
      const values = [option?.label, answer.freeform?.trim()].filter(Boolean);
      return `- ${question?.header ?? answer.questionId}: ${values.join(" — ")}`;
    })
    .join("\n");
}

export function buildTaskPlannerPrompt(
  task: TaskDetail,
  kind: Extract<TaskOperationKind, "initial-plan" | "continue-plan">,
): string {
  if (kind === "initial-plan") {
    return `${PLANNER_RULES}

## User brief

${task.briefMarkdown}

The attachments supplied with this turn are the exact attachments saved on the Task draft.`;
  }
  return `${PLANNER_RULES}

Revise the existing plan into one complete replacement plan using the user's answers and additional direction. Do not return a patch or a partial addendum.

## Existing plan

${task.planMarkdown ?? "No existing plan is available."}

## Answers to the prior questions

${answersMarkdown(task)}

## Additional direction

${task.additionalDirection.trim() || "No additional direction was supplied."}`;
}

export function buildTaskFinalizerPrompt(task: TaskDetail): string {
  return `${PLANNER_RULES}

Finalize the plan for implementation. Incorporate every supplied answer and the additional direction, remove unresolved questions, make acceptance criteria explicit, and produce a Goal prompt that directs the Agent to finish the whole plan rather than only its first milestone.

## Current plan

${task.planMarkdown ?? "No current plan is available."}

## Answers

${answersMarkdown(task)}

## Additional direction

${task.additionalDirection.trim() || "No additional direction was supplied."}`;
}

export function parseTaskPlannerResult(value: unknown): TaskPlannerResult {
  return taskPlannerResultSchema.parse(value);
}

export function parseTaskFinalizerResult(value: unknown): TaskFinalizerResult {
  return taskFinalizerResultSchema.parse(value);
}

export function normalizedTaskPlanMessage(result: TaskPlannerResult): string {
  if (!result.questions.length) {
    return `${result.planMarkdown}\n\n---\n\nNo open planning questions.`;
  }
  const summaries = result.questions
    .map((question) => `- **${question.header}:** ${question.question}`)
    .join("\n");
  return `${result.planMarkdown}\n\n---\n\n### Open planning questions\n\n${summaries}`;
}
