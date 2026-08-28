import { randomUUID } from "node:crypto";

import {
  chatGoalClearSchema,
  chatGoalCreateSchema,
  chatGoalResponseSchema,
  chatGoalUpdateSchema,
  chatGoalWireResponseSchema,
  type ChatGoalResponse,
  type ChatMessage,
  type ChatTurnCreate,
  type ReasoningEffort,
} from "@cantrip/protocol";
import type { TaskDispatchWorkerLease } from "@cantrip/protocol/task-scheduling";
import {
  taskGoalWorkerResultSchema,
  type TaskGoalSyncContext,
  type TaskGoalWorkerResult,
  type TaskMessageOpaqueContent,
  type TaskOpaqueSummary,
} from "@cantrip/protocol/tasks";
import type { FastifyInstance } from "fastify";

import {
  chatIsExecuting,
  effectivePermissionProfile,
} from "../../chats/execution-helpers.js";
import type {
  ChatExecutionContext,
  ModelRuntime,
  ServerRepository,
} from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { GOAL_RESUME_PROMPT } from "../shared/constants.js";

interface GoalResumeTurnInput {
  customSubagentModel?: boolean;
  idempotencyKey: string;
  mode: "goal";
  modelId: string;
  reasoningEffort?: ReasoningEffort | null;
  subagentModelId?: string | null;
  subagentReasoningEffort?: ReasoningEffort | null;
  text: string;
}

interface GoalResumeTurnOptions {
  afterTurnCompleted?: (input: {
    execution: ChatExecutionContext;
  }) => Promise<void>;
  afterTurnFailed?: (input: {
    execution: ChatExecutionContext;
  }) => Promise<void>;
  encryptedTaskMessages?: {
    userMessage: TaskMessageOpaqueContent;
    response: { id: string; idempotencyKey: string };
  };
  purpose: string;
  runtimes: ModelRuntime[];
  taskDispatchLease?: TaskDispatchWorkerLease;
  workerPrompt: string;
}

type ScheduledTaskGoalTurnOptions = Required<
  Pick<
    GoalResumeTurnOptions,
    "afterTurnCompleted" | "afterTurnFailed" | "taskDispatchLease"
  >
>;

export interface ChatGoalRouteDependencies {
  applicationOwnerId: () => string;
  beginTurn: (
    context: ChatExecutionContext,
    input: GoalResumeTurnInput,
    options: GoalResumeTurnOptions,
  ) => Promise<ChatMessage>;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  readEncryptedTaskGoal: (
    context: ChatExecutionContext,
    task: TaskOpaqueSummary,
  ) => Promise<{ goal: TaskGoalWorkerResult["goal"] }>;
  reconcileTaskGoalDispatch: (
    source: TaskOpaqueSummary,
    state: TaskOpaqueSummary["state"],
  ) => Promise<void>;
  repository: Pick<ServerRepository, "getChatExecutionContext" | "tasks">;
  resolveModelId: (context: ChatExecutionContext) => Promise<string>;
  retainTaskGoalLease: (lease: TaskDispatchWorkerLease) => Promise<void>;
  runtimeForContext: (
    context: ChatExecutionContext,
  ) => Promise<ModelRuntime | null>;
  scheduledTaskGoalTurnOptions: (
    lease: TaskDispatchWorkerLease,
  ) => ScheduledTaskGoalTurnOptions;
  startGoalTurn: (
    context: ChatExecutionContext,
    input: ChatTurnCreate,
    options: { tokenBudget?: number | null },
  ) => Promise<{ goal: ChatGoalResponse; message: ChatMessage }>;
  taskContentFromSummary: (
    task: TaskOpaqueSummary,
  ) => TaskGoalSyncContext["task"];
  taskGoalDispatchLease: (
    task: TaskOpaqueSummary,
  ) => TaskDispatchWorkerLease | null;
}

/** Registers native and encrypted Task Goal lifecycle routes. */
export function installChatGoalRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    beginTurn,
    bridge,
    readEncryptedTaskGoal,
    reconcileTaskGoalDispatch,
    repository,
    resolveModelId,
    retainTaskGoalLease,
    runtimeForContext,
    scheduledTaskGoalTurnOptions,
    startGoalTurn,
    taskContentFromSummary,
    taskGoalDispatchLease,
  }: ChatGoalRouteDependencies,
): void {
  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/goal",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (!context.threadId) {
        return reply.send(
          chatGoalWireResponseSchema.parse(
            context.experience === "task"
              ? { kind: "task-encrypted", goal: null }
              : { goal: null },
          ),
        );
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        if (context.experience === "task") {
          const task = await repository.tasks.get(
            applicationOwnerId(),
            context.chatId,
          );
          if (!task) {
            return reply.code(404).send({ error: "Task not found." });
          }
          const result = await readEncryptedTaskGoal(context, task);
          return reply.send(
            chatGoalWireResponseSchema.parse({
              kind: "task-encrypted",
              goal: result.goal,
            }),
          );
        }
        const runtime = await runtimeForContext(context);
        if (!runtime) {
          return reply
            .code(409)
            .send({ error: "Selected model was not found." });
        }
        const result = chatGoalResponseSchema.parse(
          await bridge.request(context.workerId, {
            type: "chat.goal.get",
            chatId: context.chatId,
            cwd: context.cwd,
            threadId: context.threadId,
            model: runtime.model,
            provider: runtime.provider,
            permissionProfileId:
              effectivePermissionProfile(context).effectiveId,
          }),
        );
        return reply.send(chatGoalWireResponseSchema.parse(result));
      } catch (error) {
        return reply.code(409).send({
          error:
            context.experience === "task"
              ? "Encrypted Goal status is unavailable."
              : errorMessage(error),
        });
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/goal",
    async (request, reply) => {
      const input = chatGoalCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (context.experience === "task") {
        return reply.code(409).send({
          error: "Task Goals are created by encrypted Task finalization.",
        });
      }
      if (chatIsExecuting(context.status)) {
        return reply
          .code(409)
          .send({ error: "Wait for the active turn to finish." });
      }
      if (context.automationPaused) {
        return reply
          .code(409)
          .send({ error: "Resume this chat before starting a goal." });
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        const started = await startGoalTurn(
          context,
          {
            attachmentIds: [],
            text: input.data.objective,
            mode: "goal",
            idempotencyKey: `goal:${randomUUID()}`,
          },
          { tokenBudget: input.data.tokenBudget ?? null },
        );
        return reply
          .code(202)
          .send(chatGoalWireResponseSchema.parse(started.goal));
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/goal",
    async (request, reply) => {
      const input = chatGoalUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (!context.threadId) {
        return reply.code(409).send({ error: "This chat has no goal." });
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        const runtime = await runtimeForContext(context);
        if (!runtime) throw new Error("Selected model was not found.");
        if (context.experience === "task") {
          const task = await repository.tasks.get(
            applicationOwnerId(),
            context.chatId,
          );
          if (!task) {
            return reply.code(404).send({ error: "Task not found." });
          }
          const message =
            input.data.status === "active" &&
            !context.automationPaused &&
            !chatIsExecuting(context.status)
              ? {
                  id: randomUUID(),
                  idempotencyKey: `task-goal-resume:${randomUUID()}`,
                  kind: "resume" as const,
                }
              : null;
          const result = taskGoalWorkerResultSchema.parse(
            await bridge.request(context.workerId, {
              type: "chat.goal.update",
              chatId: context.chatId,
              cwd: context.cwd,
              threadId: context.threadId,
              status: input.data.status,
              model: runtime.model,
              provider: runtime.provider,
              permissionProfileId:
                effectivePermissionProfile(context).effectiveId,
              taskContext: {
                task: taskContentFromSummary(task),
                automationPaused: context.automationPaused,
                chatStatus: context.status,
                message,
              },
            }),
          );
          if (
            result.goal?.chatId !== context.chatId ||
            (message &&
              (result.message?.id !== message.id ||
                result.message.idempotencyKey !== message.idempotencyKey))
          ) {
            throw new Error("Encrypted Goal metadata is invalid.");
          }
          const synchronized = await repository.tasks.syncImplementationState(
            applicationOwnerId(),
            context.chatId,
            { rowVersion: task.rowVersion, task: result.task },
          );
          await reconcileTaskGoalDispatch(task, (synchronized ?? task).state);
          if (result.goal?.status === "active" && result.message) {
            const dispatchLease = taskGoalDispatchLease(task);
            if (dispatchLease) await retainTaskGoalLease(dispatchLease);
            const dispatchConfiguration = task.dispatch?.modelConfiguration;
            const modelId =
              dispatchConfiguration?.modelId ?? (await resolveModelId(context));
            await beginTurn(
              context,
              {
                text: "Resume the active encrypted Task Goal.",
                mode: "goal",
                modelId,
                reasoningEffort: dispatchConfiguration?.reasoningEffort,
                customSubagentModel: dispatchConfiguration?.customSubagentModel,
                subagentModelId: dispatchConfiguration?.subagentModelId,
                subagentReasoningEffort:
                  dispatchConfiguration?.subagentReasoningEffort,
                idempotencyKey: result.message.idempotencyKey,
              },
              {
                encryptedTaskMessages: {
                  userMessage: result.message,
                  response: {
                    id: randomUUID(),
                    idempotencyKey: `assistant:${result.message.id}`,
                  },
                },
                purpose: "Resume encrypted Task Goal",
                runtimes: [runtime],
                workerPrompt: GOAL_RESUME_PROMPT,
                ...(dispatchLease
                  ? scheduledTaskGoalTurnOptions(dispatchLease)
                  : {}),
              },
            );
          }
          return reply.send(
            chatGoalWireResponseSchema.parse({
              kind: "task-encrypted",
              goal: result.goal,
            }),
          );
        }
        const result = chatGoalResponseSchema.parse(
          await bridge.request(context.workerId, {
            type: "chat.goal.update",
            chatId: context.chatId,
            cwd: context.cwd,
            threadId: context.threadId,
            status: input.data.status,
            model: runtime.model,
            provider: runtime.provider,
            permissionProfileId:
              effectivePermissionProfile(context).effectiveId,
          }),
        );
        if (
          input.data.status === "active" &&
          !context.automationPaused &&
          !chatIsExecuting(context.status) &&
          result.goal
        ) {
          const modelId = await resolveModelId(context);
          await beginTurn(
            context,
            {
              text: `Resume goal: ${result.goal.objective}`,
              mode: "goal",
              modelId,
              idempotencyKey: `goal-resume:${result.goal.updatedAt}:${randomUUID()}`,
            },
            {
              purpose: "Resume Codex goal",
              runtimes: [runtime],
              workerPrompt: GOAL_RESUME_PROMPT,
            },
          );
        }
        return reply.send(chatGoalWireResponseSchema.parse(result));
      } catch (error) {
        return reply.code(409).send({
          error:
            context.experience === "task"
              ? "Encrypted Goal update failed."
              : errorMessage(error),
        });
      }
    },
  );

  app.delete<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/goal",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (!context.threadId) {
        return reply.send(chatGoalClearSchema.parse({ cleared: false }));
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        const runtime = await runtimeForContext(context);
        if (!runtime) throw new Error("Selected model was not found.");
        const result = await bridge.request(context.workerId, {
          type: "chat.goal.clear",
          chatId: context.chatId,
          cwd: context.cwd,
          threadId: context.threadId,
          model: runtime.model,
          provider: runtime.provider,
          permissionProfileId: effectivePermissionProfile(context).effectiveId,
        });
        return reply.send(chatGoalClearSchema.parse(result));
      } catch (error) {
        return reply.code(409).send({
          error:
            context.experience === "task"
              ? "Encrypted Goal removal failed."
              : errorMessage(error),
        });
      }
    },
  );
}
