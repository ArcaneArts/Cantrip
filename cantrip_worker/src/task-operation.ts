import { randomUUID } from "node:crypto";

import {
  clearSensitiveBytes,
  createTaskOperationRelayRequest,
  createTaskOperationRelayResult,
  decryptChatMessageProtectedContent,
  decryptTaskMessageProtectedContent,
  decryptTaskProtectedContent,
  decryptTaskGoalObjective,
  encryptTaskGoalObjective,
  encryptTaskMessageProtectedContent,
  encryptTaskPlanningRoundProtectedContent,
  encryptTaskProtectedContent,
  openTaskOperationRelayRequest,
} from "@cantrip/crypto";
import {
  chatMessageContentSchema,
  agentTurnResultSchema,
  chatGoalResponseSchema,
  chatRelocationContextPayloadSchema,
  type AgentActivity,
  type AgentTurnResult,
  type ChatRelocationContextPayload,
} from "@cantrip/protocol";
import type { WorkflowJsonObject } from "@cantrip/protocol/workflows";
import {
  taskFinalizerOutputJsonSchema,
  taskFinalizerResultSchema,
  taskEncryptedOperationStartSchema,
  taskGoalSyncContextSchema,
  taskGoalWorkerResultSchema,
  taskMessageRelayResultSchema,
  taskMessageOpaqueContentSchema,
  taskOperationRelayRequestSchema,
  taskOperationPrepareRequestSchema,
  taskPlannerOutputJsonSchema,
  taskPlannerResultSchema,
  TASK_GOAL_PROMPT_LIMIT,
  type TaskFinalizerResult,
  type TaskEncryptedOperationStart,
  type TaskGoalSyncContext,
  type TaskOperationRelayRequest,
  type TaskOperationPrepareRequest,
  type TaskOperationRelayGoal,
  type TaskMessageProtectedClassification,
  type TaskMessageOpaqueContent,
  type TaskPlanningRoundProtectedContent,
  type TaskProtectedClassification,
  type TaskProtectedContent,
  type TaskStableState,
  type TaskState,
} from "@cantrip/protocol/tasks";

import type { WorkerEncryptionService } from "./worker-encryption.js";
import { protectedAgentRuntimeTelemetry } from "./agent-runtime-telemetry.js";

const PLANNER_RULES = `You are planning a Cantrip Task. Investigate the repository and its effective Policies before proposing architecture. This turn is strictly read-only: do not edit files, mutate Git or GitHub, call side-effecting tools, or implement any part of the plan.

Return one complete replacement Markdown plan through the supplied structured output. Cover product behavior, architecture, persistence, APIs, UI, safety, tests, rollout, and independently mergeable milestones when relevant. Ask only questions whose answers materially change the plan. Give a recommended option when you have a defensible recommendation. Return an empty questions array when clarification is unnecessary. Do not claim to have inspected files or run checks that you did not inspect or run.

Effective Cantrip Policy summaries are supplied as application context. Prefer the managed Cantrip MCP \`policy_list\` and \`policy_read\` tools when available; otherwise run \`cantrip policy list\` and \`cantrip policy read <policy-key>\`. Read every summary that requires its full current body. Policies may constrain the future implementation even though this planning turn cannot write.`;

const FINALIZER_RULES = `You are finalizing a Cantrip Task for implementation. This turn is strictly read-only: do not edit files, mutate Git or GitHub, call side-effecting tools, or implement any part of the plan.

Return a complete final implementation plan and a Goal prompt through the supplied structured output. Incorporate every supplied answer and the additional direction, remove unresolved questions, make acceptance criteria explicit, and direct the Goal Agent to finish the whole plan rather than only its first milestone.

Keep the final plan and Goal prompt concise enough that Cantrip can combine them into one objective of at most ${TASK_GOAL_PROMPT_LIMIT.toLocaleString()} characters.

Effective Cantrip Policy summaries are supplied as application context. Prefer the managed Cantrip MCP \`policy_list\` and \`policy_read\` tools when available; otherwise run \`cantrip policy list\` and \`cantrip policy read <policy-key>\`. Read every summary that requires its full current body. Policies may constrain the implementation, but do not copy policy bodies or revision identifiers into the result.`;

const FALLBACK_TASK_GOAL_PROMPT =
  "Implement the complete final plan, validate the finished result, and continue until every acceptance criterion is satisfied.";

export class EncryptedTaskEventSealer {
  readonly #ids = new Map<string, string>();
  readonly #mode: "default" | "goal" | "plan";
  readonly #service: WorkerEncryptionService;

  constructor(
    service: WorkerEncryptionService,
    mode: "default" | "goal" | "plan" = "goal",
  ) {
    this.#service = service;
    this.#mode = mode;
  }

  #id(key: string): string {
    const existing = this.#ids.get(key);
    if (existing) return existing;
    const created = randomUUID();
    this.#ids.set(key, created);
    return created;
  }

  async activity(activity: AgentActivity) {
    const turnId = activity.correlation?.turnId ?? null;
    const agentRuntime = protectedAgentRuntimeTelemetry(activity);
    const key =
      activity.type === "worktree"
        ? activity.id
        : `activity:${turnId ?? "turn"}:${activity.id}`;
    const message = await this.#protectActivity(this.#id(key), key, activity);
    return {
      type: "agent.protected-task-message" as const,
      message,
      telemetry:
        activity.type === "usage"
          ? {
              kind: "usage" as const,
              usage: activity.last,
              modelContextWindow: activity.modelContextWindow,
              contextUsedPercent: activity.contextUsedPercent,
              turnId,
            }
          : {
              kind: "activity" as const,
              activityType: activity.type,
              turnId,
              ...(agentRuntime ? { agentRuntime } : {}),
            },
    };
  }

  async #protectActivity(
    id: string,
    idempotencyKey: string,
    activity: AgentActivity,
  ): Promise<TaskMessageOpaqueContent> {
    const component = this.#service.componentKey("task-content");
    const ownerId = this.#service.ownerId();
    const classification: TaskMessageProtectedClassification = {
      role: "assistant",
      mode: this.#mode,
      attachmentIds: [],
    };
    try {
      return taskMessageOpaqueContentSchema.parse({
        id,
        classification,
        protectedContent: await encryptTaskMessageProtectedContent({
          ownerId,
          messageId: id,
          keyRevision: component.keyRevision,
          componentKey: component.key,
          content: {
            version: 1,
            classification,
            content: chatMessageContentSchema.parse([
              { type: "activity", activity },
            ]),
          },
        }),
        reasoningEffort: null,
        idempotencyKey,
      });
    } finally {
      clearSensitiveBytes(component.key);
    }
  }
}

function answersMarkdown(content: TaskPlanningRoundProtectedContent): string {
  if (!content.inputAnswers.length) return "No answers were supplied.";
  const questions = new Map(
    content.inputQuestions.map((question) => [question.id, question]),
  );
  return content.inputAnswers
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

export function buildEncryptedTaskOperationPrompt(
  content: TaskPlanningRoundProtectedContent,
): string {
  switch (content.classification.kind) {
    case "direct":
      return content.inputBriefMarkdown;
    case "initial-plan":
      return `${PLANNER_RULES}

## User brief

${content.inputBriefMarkdown}

The attachments supplied with this turn are the exact attachments saved on the Task draft.`;
    case "continue-plan":
      return `${PLANNER_RULES}

Revise the existing plan into one complete replacement plan using the user's answers and additional direction. Do not return a patch or a partial addendum.

## Existing plan

${content.inputPlanMarkdown ?? "No existing plan is available."}

## Answers to the prior questions

${answersMarkdown(content)}

## Additional direction

${content.additionalDirection.trim() || "No additional direction was supplied."}`;
    case "finalize":
      return `${FINALIZER_RULES}

Produce one complete final plan, not a patch or addendum. The Goal prompt may refer to that final plan but must remain useful when wrapped by Cantrip's Task execution objective.

## Current plan

${content.inputPlanMarkdown ?? "No current plan is available."}

## Answers

${answersMarkdown(content)}

## Additional direction

${content.additionalDirection.trim() || "No additional direction was supplied."}`;
  }
}

function parsePlannerResult(value: unknown, fallbackPlanMarkdown: string) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.planMarkdown === "string" &&
      !candidate.planMarkdown.trim() &&
      fallbackPlanMarkdown.trim()
    ) {
      return taskPlannerResultSchema.parse({
        ...candidate,
        planMarkdown: fallbackPlanMarkdown,
      });
    }
  }
  return taskPlannerResultSchema.parse(value);
}

function parseFinalizerResult(
  value: unknown,
  fallbackPlanMarkdown: string,
): TaskFinalizerResult {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    const finalPlanMarkdown =
      typeof candidate.finalPlanMarkdown === "string" &&
      !candidate.finalPlanMarkdown.trim() &&
      fallbackPlanMarkdown.trim()
        ? fallbackPlanMarkdown
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

function goalObjective(result: TaskFinalizerResult): string {
  const objective = `# Cantrip Task implementation objective

Implement the complete Task plan below. Before making changes, inspect the effective Cantrip Policies supplied by the application. Prefer the managed Cantrip MCP \`policy_list\` and \`policy_read\` tools; use \`cantrip policy list\` and \`cantrip policy read <policy-key>\` as the CLI fallback. Read every policy whose summary requires the full body and follow the current policies throughout implementation.

Continue until every acceptance criterion is satisfied or the Goal is genuinely blocked. Keep progress recoverable, validate each completed change, and report the final outcome. Do not stop after only the first milestone.

## Agent-generated implementation direction

${result.goalPrompt}

## Final implementation plan

${result.finalPlanMarkdown}`;
  if (objective.length > TASK_GOAL_PROMPT_LIMIT) {
    throw new Error("The encrypted Task Goal objective is too large.");
  }
  return objective;
}

function plannerMessage(result: ReturnType<typeof parsePlannerResult>): string {
  if (!result.questions.length) return result.planMarkdown;
  const questions = result.questions
    .map((question) => `- **${question.header}:** ${question.question}`)
    .join("\n");
  return `${result.planMarkdown}\n\n## Questions\n\n${questions}`;
}

async function encryptedMessage(input: {
  componentKey: Uint8Array;
  content: string;
  idempotencyKey: string;
  keyRevision: number;
  mode: "default" | "goal" | "plan";
  ownerId: string;
  role: "assistant" | "user";
  id?: string;
}) {
  const id = input.id ?? randomUUID();
  const classification: TaskMessageProtectedClassification = {
    role: input.role,
    mode: input.mode,
    attachmentIds: [],
  };
  return {
    id,
    classification,
    protectedContent: await encryptTaskMessageProtectedContent({
      ownerId: input.ownerId,
      messageId: id,
      keyRevision: input.keyRevision,
      componentKey: input.componentKey,
      content: {
        version: 1,
        classification,
        content: [{ type: "text", text: input.content, phase: "final_answer" }],
      },
    }),
    reasoningEffort: null,
    idempotencyKey: input.idempotencyKey,
  };
}

function taskOperationMessage(
  kind: TaskOperationPrepareRequest["operationKind"],
  content: TaskProtectedContent,
): string {
  if (kind === "direct") return content.briefMarkdown;
  if (kind === "initial-plan") {
    return `Plan this Task from the saved brief.\n\n${content.briefMarkdown}`;
  }
  const action =
    kind === "finalize"
      ? "Finalize this Task plan for implementation."
      : "Continue planning this Task.";
  return `${action}\n\n${content.additionalDirection.trim() || "No additional direction was supplied."}`;
}

export async function prepareEncryptedTaskOperation(input: {
  getComponentKey(): { key: Uint8Array; keyRevision: number };
  ownerId: string;
  request: TaskOperationPrepareRequest;
}): Promise<TaskEncryptedOperationStart> {
  const request = taskOperationPrepareRequestSchema.parse(input.request);
  const component = input.getComponentKey();
  try {
    if (component.keyRevision !== request.task.protectedContent.keyRevision) {
      throw new Error("The Task encryption key revision is unavailable.");
    }
    const current = await decryptTaskProtectedContent({
      ownerId: input.ownerId,
      chatId: request.task.chatId,
      keyRevision: component.keyRevision,
      componentKey: component.key,
      encrypted: request.task.protectedContent,
      publicClassification: {
        state: request.task.state,
        stableStateBeforeFailure: request.task.stableStateBeforeFailure,
        activeOperationKind: request.task.activeOperationKind,
        planAuthorship: request.task.planAuthorship,
        planningRound: request.task.planningRound,
        hasPlan: request.task.hasPlan,
        hasQuestions: request.task.hasQuestions,
        hasFinalPlan: request.task.hasFinalPlan,
        hasGoalPrompt: request.task.hasGoalPrompt,
        lastError: request.task.lastError,
      },
    });
    const kind = request.operationKind;
    const stableState: TaskStableState =
      kind === "direct" || kind === "initial-plan" ? "draft" : "review";
    const runningState: TaskState =
      kind === "direct"
        ? "implementing"
        : kind === "finalize"
          ? "finalizing"
          : "planning";
    const classification = {
      ordinal: request.task.planningRound + 1,
      kind,
      status: "running" as const,
      hasOutputPlan: false,
      hasOutputQuestions: false,
      hasOutputGoalPrompt: false,
      error: null,
    };
    const round: TaskPlanningRoundProtectedContent = {
      version: 1,
      classification,
      inputBriefMarkdown: current.briefMarkdown,
      inputPlanMarkdown: current.planMarkdown,
      inputQuestions: current.currentQuestions,
      inputAnswers: current.currentAnswers,
      additionalDirection: current.additionalDirection,
      outputPlanMarkdown: null,
      outputQuestions: [],
      outputGoalPrompt: null,
      error: null,
    };
    const runningClassification: TaskProtectedClassification = {
      ...current.classification,
      state: runningState,
      stableStateBeforeFailure: stableState,
      activeOperationKind: kind,
      planningRound: classification.ordinal,
      lastError: null,
    };
    const runningTask: TaskProtectedContent = {
      ...current,
      classification: runningClassification,
      lastError: null,
    };
    const userMessage = await encryptedMessage({
      componentKey: component.key,
      content: taskOperationMessage(kind, current),
      idempotencyKey: `task-operation:${request.operationId}`,
      keyRevision: component.keyRevision,
      mode: kind === "direct" ? "default" : "plan",
      ownerId: input.ownerId,
      role: "user",
    });
    const operation = await createTaskOperationRelayRequest({
      ownerId: input.ownerId,
      chatId: request.task.chatId,
      operationId: request.operationId,
      keyRevision: component.keyRevision,
      componentKey: component.key,
      content: round,
      taskContent: runningTask,
      userMessage,
    });

    const occurredAt = new Date().toISOString();
    const error = {
      code: "task-operation-failed",
      message:
        "The encrypted Task operation failed. Retry when the worker is ready.",
      operationKind: kind,
      occurredAt,
    };
    const errorMetadata = {
      code: error.code,
      operationKind: error.operationKind,
      occurredAt: error.occurredAt,
    };
    const failedClassification: TaskProtectedClassification = {
      ...runningClassification,
      state: "failed" as const,
      stableStateBeforeFailure: stableState,
      activeOperationKind: null,
      lastError: errorMetadata,
    };
    const failedRoundClassification = {
      ...classification,
      status: "failed" as const,
      error: errorMetadata,
    };
    return taskEncryptedOperationStartSchema.parse({
      rowVersion: request.task.rowVersion,
      operation,
      failure: {
        task: {
          classification: failedClassification,
          protectedContent: await encryptTaskProtectedContent({
            ownerId: input.ownerId,
            chatId: request.task.chatId,
            keyRevision: component.keyRevision,
            componentKey: component.key,
            content: {
              ...current,
              classification: failedClassification,
              lastError: error,
            },
          }),
        },
        round: {
          classification: failedRoundClassification,
          protectedContent: await encryptTaskPlanningRoundProtectedContent({
            ownerId: input.ownerId,
            roundId: request.operationId,
            keyRevision: component.keyRevision,
            componentKey: component.key,
            content: {
              ...round,
              classification: failedRoundClassification,
              error,
            },
          }),
        },
      },
    });
  } finally {
    clearSensitiveBytes(component.key);
  }
}

export async function encryptTaskTurnResult(input: {
  getComponentKey(): { key: Uint8Array; keyRevision: number };
  idempotencyKey: string;
  messageId: string;
  ownerId: string;
  result: AgentTurnResult;
}): Promise<AgentTurnResult> {
  const result = agentTurnResultSchema.parse(input.result);
  const component = input.getComponentKey();
  try {
    const message = await encryptedMessage({
      componentKey: component.key,
      content: result.text || "The Task Goal completed without a message.",
      id: input.messageId,
      idempotencyKey: input.idempotencyKey,
      keyRevision: component.keyRevision,
      mode: "goal",
      ownerId: input.ownerId,
      role: "assistant",
    });
    return agentTurnResultSchema.parse({
      ...result,
      text: "",
      structuredResult: taskMessageRelayResultSchema.parse({ message }),
    });
  } finally {
    clearSensitiveBytes(component.key);
  }
}

function implementationProjection(input: {
  context: TaskGoalSyncContext;
  goal: ReturnType<typeof chatGoalResponseSchema.parse>["goal"];
}) {
  if (input.context.chatStatus === "failed") {
    return {
      state: "failed" as const,
      code: "implementation-runtime-failed",
      message: "The implementation runtime failed.",
    };
  }
  if (input.context.automationPaused) {
    return { state: "paused" as const, code: null, message: null };
  }
  switch (input.goal?.status) {
    case "active":
      return { state: "implementing" as const, code: null, message: null };
    case "paused":
      return { state: "paused" as const, code: null, message: null };
    case "complete":
      return { state: "complete" as const, code: null, message: null };
    case "blocked":
      return {
        state: "blocked" as const,
        code: "goal-blocked",
        message: "The Goal reported a blocker.",
      };
    case "usageLimited":
      return {
        state: "blocked" as const,
        code: "goal-usage-limited",
        message: "The Goal reached a provider usage limit.",
      };
    case "budgetLimited":
      return {
        state: "blocked" as const,
        code: "goal-budget-limited",
        message: "The Goal reached its token budget.",
      };
    default:
      return null;
  }
}

export async function protectTaskGoalResult(input: {
  chatId: string;
  context: TaskGoalSyncContext;
  getComponentKey(): { key: Uint8Array; keyRevision: number };
  ownerId: string;
  rawResult: unknown;
}) {
  const context = taskGoalSyncContextSchema.parse(input.context);
  const result = chatGoalResponseSchema.parse(input.rawResult);
  const component = input.getComponentKey();
  try {
    if (component.keyRevision !== context.task.protectedContent.keyRevision) {
      throw new Error("The Task encryption key revision is unavailable.");
    }
    const current = await decryptTaskProtectedContent({
      ownerId: input.ownerId,
      chatId: input.chatId,
      keyRevision: component.keyRevision,
      componentKey: component.key,
      encrypted: context.task.protectedContent,
      publicClassification: context.task.classification,
    });
    const projection = implementationProjection({ context, goal: result.goal });
    let task = context.task;
    if (projection) {
      const keepError =
        current.lastError?.code === projection.code &&
        current.lastError.operationKind === "implementation";
      const lastError = projection.code
        ? keepError
          ? current.lastError
          : {
              code: projection.code,
              message: projection.message!,
              operationKind: "implementation" as const,
              occurredAt: new Date().toISOString(),
            }
        : null;
      const classification = {
        ...current.classification,
        state: projection.state,
        stableStateBeforeFailure: null,
        activeOperationKind: null,
        lastError: lastError
          ? {
              code: lastError.code,
              operationKind: lastError.operationKind,
              occurredAt: lastError.occurredAt,
            }
          : null,
      };
      const next = { ...current, classification, lastError };
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        task = {
          classification,
          protectedContent: await encryptTaskProtectedContent({
            ownerId: input.ownerId,
            chatId: input.chatId,
            keyRevision: component.keyRevision,
            componentKey: component.key,
            content: next,
          }),
        };
      }
    }
    const goal = result.goal
      ? {
          chatId: input.chatId,
          threadId: result.goal.threadId,
          status: result.goal.status,
          protectedObjective: await encryptTaskGoalObjective({
            ownerId: input.ownerId,
            chatId: input.chatId,
            threadId: result.goal.threadId,
            keyRevision: component.keyRevision,
            componentKey: component.key,
            content: {
              version: 1,
              classification: {
                chatId: input.chatId,
                threadId: result.goal.threadId,
                status: result.goal.status,
              },
              objective: result.goal.objective,
            },
          }),
          tokenBudget: result.goal.tokenBudget,
          tokensUsed: result.goal.tokensUsed,
          timeUsedSeconds: result.goal.timeUsedSeconds,
          createdAt: result.goal.createdAt,
          updatedAt: result.goal.updatedAt,
        }
      : null;
    const message =
      result.goal && context.message
        ? await encryptedMessage({
            componentKey: component.key,
            content: `${context.message.kind === "resume" ? "Resume" : "Begin"} Task Goal:\n\n${result.goal.objective}`,
            id: context.message.id,
            idempotencyKey: context.message.idempotencyKey,
            keyRevision: component.keyRevision,
            mode: "goal",
            ownerId: input.ownerId,
            role: "user",
          })
        : null;
    return taskGoalWorkerResultSchema.parse({ goal, task, message });
  } finally {
    clearSensitiveBytes(component.key);
  }
}

export async function openTaskRelocationPayload(input: {
  getComponentKey(component: "chat-content" | "task-content"): {
    key: Uint8Array;
    keyRevision: number;
  };
  ownerId: string;
  payload: ChatRelocationContextPayload;
}): Promise<ChatRelocationContextPayload> {
  const payload = chatRelocationContextPayloadSchema.parse(input.payload);
  if (payload.kind === "visible") return payload;
  const component = input.getComponentKey(
    payload.kind === "task-encrypted" ? "task-content" : "chat-content",
  );
  try {
    const messages = await Promise.all(
      payload.messages.map(async (message) => {
        if (message.protectedContent.keyRevision !== component.keyRevision) {
          throw new Error("The chat encryption key revision is unavailable.");
        }
        const publicClassification = {
          role: message.role,
          mode: message.mode,
          attachmentIds: message.attachmentIds,
        };
        const opened =
          payload.kind === "task-encrypted"
            ? await decryptTaskMessageProtectedContent({
                ownerId: input.ownerId,
                messageId: message.id,
                keyRevision: component.keyRevision,
                componentKey: component.key,
                encrypted: message.protectedContent,
                publicClassification,
              })
            : await decryptChatMessageProtectedContent({
                ownerId: input.ownerId,
                messageId: message.id,
                keyRevision: component.keyRevision,
                componentKey: component.key,
                encrypted: message.protectedContent,
                publicClassification,
              });
        return {
          sequence: message.sequence,
          role: message.role,
          mode: message.mode,
          reasoningEffort: message.reasoningEffort,
          content: opened.content,
          createdAt: message.createdAt,
        };
      }),
    );
    return chatRelocationContextPayloadSchema.parse({
      version: 1,
      kind: "visible",
      messages,
      attachments: payload.attachments,
    });
  } finally {
    clearSensitiveBytes(component.key);
  }
}

export async function executeEncryptedTaskOperation(input: {
  getComponentKey(): { key: Uint8Array; keyRevision: number };
  ownerId: string;
  request: TaskOperationRelayRequest;
  run(input: {
    outputSchema?: WorkflowJsonObject;
    prompt: string;
  }): Promise<AgentTurnResult>;
}): Promise<AgentTurnResult> {
  const request = taskOperationRelayRequestSchema.parse(input.request);
  const component = input.getComponentKey();
  try {
    if (component.keyRevision !== request.protectedInput.keyRevision) {
      throw new Error("The Task encryption key revision is unavailable.");
    }
    const opened = await openTaskOperationRelayRequest({
      ownerId: input.ownerId,
      keyRevision: component.keyRevision,
      componentKey: component.key,
      request,
    });
    const protectedInput = opened.round;
    const taskInput = opened.task;
    const direct = protectedInput.classification.kind === "direct";
    const finalizing = protectedInput.classification.kind === "finalize";
    const rawResult = agentTurnResultSchema.parse(
      await input.run({
        prompt: buildEncryptedTaskOperationPrompt(protectedInput),
        ...(direct
          ? {}
          : {
              outputSchema: finalizing
                ? taskFinalizerOutputJsonSchema
                : taskPlannerOutputJsonSchema,
            }),
      }),
    );
    const fallbackPlan =
      protectedInput.inputPlanMarkdown?.trim() ||
      protectedInput.inputBriefMarkdown;
    const plannerResult =
      direct || finalizing
        ? null
        : parsePlannerResult(rawResult.structuredResult, fallbackPlan);
    const finalizerResult = finalizing
      ? parseFinalizerResult(rawResult.structuredResult, fallbackPlan)
      : null;
    const objective = finalizerResult ? goalObjective(finalizerResult) : null;
    const classification = {
      ordinal: protectedInput.classification.ordinal,
      kind: protectedInput.classification.kind,
      status: "completed" as const,
      hasOutputPlan: !direct,
      hasOutputQuestions: Boolean(plannerResult?.questions.length),
      hasOutputGoalPrompt: finalizing,
      error: null,
    };
    const protectedResult: TaskPlanningRoundProtectedContent = {
      ...protectedInput,
      classification,
      outputPlanMarkdown: direct
        ? null
        : (finalizerResult?.finalPlanMarkdown ?? plannerResult!.planMarkdown),
      outputQuestions: plannerResult?.questions ?? [],
      outputGoalPrompt: objective,
    };
    const taskClassification = direct
      ? {
          state: "complete" as const,
          stableStateBeforeFailure: null,
          activeOperationKind: null,
          planAuthorship: taskInput.classification.planAuthorship,
          planningRound: protectedInput.classification.ordinal,
          hasPlan: false,
          hasQuestions: false,
          hasFinalPlan: false,
          hasGoalPrompt: false,
          lastError: null,
        }
      : finalizing
        ? {
            state: "implementing" as const,
            stableStateBeforeFailure: null,
            activeOperationKind: null,
            planAuthorship: taskInput.classification.planAuthorship,
            planningRound: protectedInput.classification.ordinal,
            hasPlan: true,
            hasQuestions: false,
            hasFinalPlan: true,
            hasGoalPrompt: true,
            lastError: null,
          }
        : {
            state: "review" as const,
            stableStateBeforeFailure: null,
            activeOperationKind: null,
            planAuthorship: "agent" as const,
            planningRound: protectedInput.classification.ordinal,
            hasPlan: true,
            hasQuestions: Boolean(plannerResult?.questions.length),
            hasFinalPlan: false,
            hasGoalPrompt: false,
            lastError: null,
          };
    const taskResult: TaskProtectedContent = {
      version: 1,
      classification: taskClassification,
      briefMarkdown: protectedInput.inputBriefMarkdown,
      planMarkdown: direct
        ? null
        : (finalizerResult?.finalPlanMarkdown ?? plannerResult!.planMarkdown),
      currentQuestions: plannerResult?.questions ?? [],
      currentAnswers: finalizing ? protectedInput.inputAnswers : [],
      additionalDirection: finalizing ? protectedInput.additionalDirection : "",
      finalPlanMarkdown: finalizerResult?.finalPlanMarkdown ?? null,
      goalPrompt: objective,
      lastError: null,
    };
    const goalClassification = objective
      ? {
          chatId: request.chatId,
          threadId: rawResult.threadId,
          status: "active" as const,
        }
      : null;
    const assistantMessage = await encryptedMessage({
      componentKey: component.key,
      content: finalizerResult
        ? finalizerResult.finalPlanMarkdown
        : direct
          ? rawResult.text || "The Task completed without a message."
          : plannerMessage(plannerResult!),
      idempotencyKey: `task-result:${request.operationId}`,
      keyRevision: component.keyRevision,
      mode: direct ? "default" : "plan",
      ownerId: input.ownerId,
      role: "assistant",
    });
    const goal =
      objective && goalClassification
        ? {
            classification: goalClassification,
            protectedObjective: await encryptTaskGoalObjective({
              ownerId: input.ownerId,
              chatId: request.chatId,
              threadId: rawResult.threadId,
              keyRevision: component.keyRevision,
              componentKey: component.key,
              content: {
                version: 1,
                classification: goalClassification,
                objective,
              },
            }),
            startMessage: await encryptedMessage({
              componentKey: component.key,
              content: objective,
              idempotencyKey: `task-goal:${request.operationId}`,
              keyRevision: component.keyRevision,
              mode: "goal",
              ownerId: input.ownerId,
              role: "user",
            }),
          }
        : null;
    const relayResult = await createTaskOperationRelayResult({
      ownerId: input.ownerId,
      keyRevision: component.keyRevision,
      componentKey: component.key,
      request,
      content: protectedResult,
      taskContent: taskResult,
      assistantMessage,
      goal,
    });
    return agentTurnResultSchema.parse({
      ...rawResult,
      text: "",
      structuredResult: relayResult,
    });
  } catch {
    throw new Error("Encrypted Task operation failed.");
  } finally {
    clearSensitiveBytes(component.key);
  }
}

export async function openEncryptedTaskGoalObjective(input: {
  chatId: string;
  getComponentKey(): { key: Uint8Array; keyRevision: number };
  goal: TaskOperationRelayGoal;
  ownerId: string;
  threadId: string | null;
}): Promise<string> {
  if (
    !input.threadId ||
    input.goal.classification.chatId !== input.chatId ||
    input.goal.classification.threadId !== input.threadId ||
    input.goal.classification.status !== "active"
  ) {
    throw new Error("Encrypted Task Goal metadata is invalid.");
  }
  const component = input.getComponentKey();
  try {
    if (component.keyRevision !== input.goal.protectedObjective.keyRevision) {
      throw new Error("The Task encryption key revision is unavailable.");
    }
    return (
      await decryptTaskGoalObjective({
        ownerId: input.ownerId,
        chatId: input.chatId,
        threadId: input.threadId,
        keyRevision: component.keyRevision,
        componentKey: component.key,
        encrypted: input.goal.protectedObjective,
        publicClassification: input.goal.classification,
      })
    ).objective;
  } catch {
    throw new Error("Encrypted Task Goal could not be opened.");
  } finally {
    clearSensitiveBytes(component.key);
  }
}
