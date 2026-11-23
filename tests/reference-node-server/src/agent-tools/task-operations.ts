import { createHash } from "node:crypto";
import {
  agentTaskCreateWireSchema,
  agentTaskStatusWireSchema,
  cantripMcpTaskListInputSchema,
  cantripMcpTaskStatusInputSchema,
  type CantripAgentOperationRequest,
  type CantripAgentOperationResult,
} from "@cantrip/protocol";
import type { TaskOpaqueSummary } from "@cantrip/protocol/tasks";
import type {
  ChatExecutionContext,
  ServerRepository,
} from "../db/repository.js";
import { CliCommandRequestError } from "./errors.js";

export function createAgentTaskOperations(deps: {
  applicationOwnerId(): string;
  repository: ServerRepository;
  isWorkerConnected(workerId: string): boolean;
  publishTask(chatId: string, projectId: string): void;
  queueTaskScheduleTick(): void;
}) {
  return async (
    source: ChatExecutionContext,
    call: CantripAgentOperationRequest,
  ): Promise<CantripAgentOperationResult> => {
    if (source.contextKind !== "project")
      throw new CliCommandRequestError(
        "invalid",
        403,
        "Task tools require a project chat.",
      );
    const owner = deps.applicationOwnerId();
    const result = async (
      tasks: TaskOpaqueSummary[],
      missingTaskIds: string[] = [],
      nextCursor: number | null = null,
      mutated = false,
    ): Promise<CantripAgentOperationResult> => {
      const chats = await deps.repository.listChats(owner, source.projectId);
      const data = agentTaskStatusWireSchema.parse({
        tasks: tasks.map((task) => {
          const chat = chats.find((chat) => chat.id === task.chatId);
          if (!chat)
            throw new CliCommandRequestError(
              "not-found",
              404,
              "Task chat is unavailable.",
            );
          return {
            id: task.chatId,
            titleProtection: chat.titleProtection,
            state: task.state,
            dispatchState: task.dispatch?.state ?? null,
            eligibilityCode: task.dispatch?.eligibilityCode ?? null,
            configuration: task.modelConfiguration,
            terminal:
              !["queued", "claimed", "running", "paused"].includes(
                task.dispatch?.state ?? "",
              ) &&
              (task.state === "complete" ||
                (task.state === "failed" &&
                  !["scheduled", "retrying"].includes(
                    task.automaticRetry?.status ?? "",
                  ))),
            completedAt: task.completedAt,
            updatedAt: task.updatedAt,
          };
        }),
        missingTaskIds,
        nextCursor,
      });
      return {
        summary: mutated
          ? "Task queued for direct execution with the caller's model; goal mode is off."
          : `Read ${tasks.length} project Task statuses.`,
        data,
        mutated,
        target: null,
        worktreeId: source.worktreeId,
        continuationScheduled: false,
      };
    };
    if (call.operation === "task.create") {
      const input = agentTaskCreateWireSchema.parse(call.arguments);
      const hex = createHash("sha256")
        .update(`agent-task:${source.chatId}:${input.operationId}`)
        .digest("hex");
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      if (input.task.chatId !== id)
        throw new CliCommandRequestError(
          "invalid",
          403,
          "Task identity does not match the caller and operation.",
        );
      // Never accept a caller-supplied model, Goal mode, placement, or tab mutation.
      const callerTask =
        source.experience === "task"
          ? await deps.repository.tasks.get(owner, source.chatId)
          : null;
      const configuration = {
        ...(callerTask?.dispatch?.modelConfiguration ??
          callerTask?.modelConfiguration ??
          source.modelConfiguration),
      };
      configuration.modelId ??= (
        await deps.repository.getUserSettings(owner)
      ).defaultModelId;
      if (!configuration.modelId)
        throw new CliCommandRequestError(
          "conflict",
          409,
          "The calling chat has no selected model.",
        );
      let current = (
        await deps.repository.tasks.list(owner, source.projectId)
      ).find((task) => task.chatId === id);
      if (!current) {
        try {
          const created = await deps.repository.createTask(
            owner,
            source.projectId,
            {
              chatId: id,
              worktreeMode: "agent-managed",
              titleProtection: input.task.titleProtection,
              autoTitle: false,
              planGoalEnabled: false,
              priority: 0,
              modelConfiguration: configuration,
              task: input.task.task,
            },
            deps.isWorkerConnected,
          );
          if (!created)
            throw new CliCommandRequestError(
              "not-found",
              404,
              "Project source not found.",
            );
          current = created.task;
        } catch (error) {
          // Concurrent retries converge on the source-scoped Task identity.
          current = (
            await deps.repository.tasks.list(owner, source.projectId)
          ).find((task) => task.chatId === id);
          if (!current) throw error;
        }
      }
      if (current.state === "draft" && !current.dispatch) {
        await deps.repository.taskDispatch.enqueue(
          owner,
          id,
          input.operationId,
          "direct",
          current.rowVersion,
        );
        current = (await deps.repository.tasks.get(owner, id))!;
      }
      deps.publishTask(id, source.projectId);
      deps.queueTaskScheduleTick();
      return result([current!], [], null, true);
    }
    const tasks = await deps.repository.tasks.list(owner, source.projectId);
    if (call.operation === "task.list") {
      const input = cantripMcpTaskListInputSchema.parse(call.arguments);
      const selected = tasks.slice(input.cursor, input.cursor + input.limit);
      return result(
        selected,
        [],
        input.cursor + selected.length < tasks.length
          ? input.cursor + selected.length
          : null,
      );
    }
    const input = cantripMcpTaskStatusInputSchema.parse(call.arguments);
    const ids = [...new Set(input.taskIds)];
    const selected = ids.flatMap((id) =>
      tasks.filter((task) => task.chatId === id),
    );
    return result(
      selected,
      ids.filter((id) => !selected.some((task) => task.chatId === id)),
    );
  };
}
