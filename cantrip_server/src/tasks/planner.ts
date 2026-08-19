import {
  taskFinalizerResultSchema,
  taskPlannerResultSchema,
  TASK_GOAL_PROMPT_LIMIT,
  type TaskDetail,
  type TaskFinalizerResult,
  type TaskOperationKind,
  type TaskPlannerResult,
} from "@cantrip/protocol/tasks";

const PLANNER_RULES = `You are planning a Cantrip Task. Investigate the repository and its effective Policies before proposing architecture. This turn is strictly read-only: do not edit files, mutate Git or GitHub, call side-effecting tools, or implement any part of the plan.

Return one complete replacement Markdown plan through the supplied structured output. Cover product behavior, architecture, persistence, APIs, UI, safety, tests, rollout, and independently mergeable milestones when relevant. Ask only questions whose answers materially change the plan. Give a recommended option when you have a defensible recommendation. Return an empty questions array when clarification is unnecessary. Do not claim to have inspected files or run checks that you did not inspect or run.

Effective Cantrip Policy summaries are supplied as application context. Run \`cantrip policy list\` and \`cantrip policy read <policy-key>\` for every summary that requires its full current body. Policies may constrain the future implementation even though this planning turn cannot write.`;

const FINALIZER_RULES = `You are finalizing a Cantrip Task for implementation. This turn is strictly read-only: do not edit files, mutate Git or GitHub, call side-effecting tools, or implement any part of the plan.

Return a complete final implementation plan and a Goal prompt through the supplied structured output. Incorporate every supplied answer and the additional direction, remove unresolved questions, make acceptance criteria explicit, and direct the Goal Agent to finish the whole plan rather than only its first milestone.

Keep the final plan and Goal prompt concise enough that Cantrip can combine them into one objective of at most ${TASK_GOAL_PROMPT_LIMIT.toLocaleString()} characters.

Effective Cantrip Policy summaries are supplied as application context. Run \`cantrip policy list\` and \`cantrip policy read <policy-key>\` for every summary that requires its full current body. Policies may constrain the implementation, but do not copy policy bodies or revision identifiers into the result.`;

const FALLBACK_TASK_GOAL_PROMPT =
  "Implement the complete final plan, validate the finished result, and continue until every acceptance criterion is satisfied.";

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
  return `${FINALIZER_RULES}

Produce one complete final plan, not a patch or addendum. The Goal prompt may refer to that final plan but must remain useful when wrapped by Cantrip's Task execution objective.

## Current plan

${task.planMarkdown ?? "No current plan is available."}

## Answers

${answersMarkdown(task)}

## Additional direction

${task.additionalDirection.trim() || "No additional direction was supplied."}`;
}

export function buildTaskGoalObjective(result: TaskFinalizerResult): string {
  const objective = `# Cantrip Task implementation objective

Implement the complete Task plan below. Before making changes, inspect the effective Cantrip Policies supplied by the application, run \`cantrip policy list\`, and use \`cantrip policy read <policy-key>\` for every policy whose summary requires the full body. Follow the current policies throughout implementation.

Continue until every acceptance criterion is satisfied or the Goal is genuinely blocked. Keep progress recoverable, validate each completed change, and report the final outcome. Do not stop after only the first milestone.

## Agent-generated implementation direction

${result.goalPrompt}

## Final implementation plan

${result.finalPlanMarkdown}`;
  if (objective.length > TASK_GOAL_PROMPT_LIMIT) {
    throw new Error(
      `The combined Task Goal objective exceeds ${TASK_GOAL_PROMPT_LIMIT.toLocaleString()} characters. Finalize a more concise plan or Goal prompt.`,
    );
  }
  return objective;
}

export function parseTaskPlannerResult(
  value: unknown,
  fallbackPlanMarkdown?: string,
): TaskPlannerResult {
  if (
    fallbackPlanMarkdown?.trim() &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.planMarkdown === "string" &&
      !candidate.planMarkdown.trim()
    ) {
      return taskPlannerResultSchema.parse({
        ...candidate,
        planMarkdown: fallbackPlanMarkdown,
      });
    }
  }
  return taskPlannerResultSchema.parse(value);
}

export function parseTaskFinalizerResult(
  value: unknown,
  fallbackFinalPlanMarkdown?: string,
): TaskFinalizerResult {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    const finalPlanMarkdown =
      typeof candidate.finalPlanMarkdown === "string" &&
      !candidate.finalPlanMarkdown.trim() &&
      fallbackFinalPlanMarkdown?.trim()
        ? fallbackFinalPlanMarkdown
        : candidate.finalPlanMarkdown;
    const goalPrompt =
      typeof candidate.goalPrompt === "string" &&
      !candidate.goalPrompt.trim() &&
      typeof finalPlanMarkdown === "string" &&
      finalPlanMarkdown.trim()
        ? FALLBACK_TASK_GOAL_PROMPT
        : candidate.goalPrompt;
    return taskFinalizerResultSchema.parse({
      ...candidate,
      finalPlanMarkdown,
      goalPrompt,
    });
  }
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

export function normalizedTaskFinalizationMessage(
  result: TaskFinalizerResult,
): string {
  return `${result.finalPlanMarkdown}\n\n---\n\nThe implementation Goal has been prepared from this final plan.`;
}
