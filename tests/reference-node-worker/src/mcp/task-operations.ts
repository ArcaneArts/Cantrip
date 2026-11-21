import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  clearSensitiveBytes,
  encryptTaskProtectedContent,
} from "@cantrip/crypto";
import {
  agentTaskCreateWireSchema,
  agentTaskStatusWireSchema,
  cantripMcpTaskCreateInputSchema,
  cantripMcpTaskListInputSchema,
  cantripMcpTaskStatusInputSchema,
  cantripMcpTaskWaitInputSchema,
  type CantripAgentOperationResult,
} from "@cantrip/protocol";
import type { TaskProtectedContent } from "@cantrip/protocol/tasks";
import {
  decodePrivateDisplayLabelForWorker,
  encodePrivateDisplayLabelForWorker,
  PrivateDisplayLabelWorkerError,
} from "../private-label-encryption.js";
import type { CantripMcpOperationOptions } from "./read-operations.js";

export async function executeCantripMcpTaskOperation(
  options: CantripMcpOperationOptions,
): Promise<CantripAgentOperationResult> {
  const { binding, service } = options;
  if (
    binding.contextKind !== "project" ||
    service.ownerId() !== binding.ownerId
  )
    throw new Error(
      "Task tools require the current project's authorized worker.",
    );
  const relay = (
    operation: "task.create" | "task.list" | "task.status",
    arguments_: Record<string, unknown>,
  ) =>
    options.execute(
      binding,
      { operation, arguments: arguments_ },
      options.requestId,
    );
  const result = (
    summary: string,
    data: unknown,
    mutated = false,
  ): CantripAgentOperationResult => ({
    summary,
    data,
    mutated,
    target: null,
    worktreeId: binding.worktreeId,
    continuationScheduled: false,
  });
  const openStatus = async (
    wire: ReturnType<typeof agentTaskStatusWireSchema.parse>,
  ) => ({
    ...wire,
    tasks: await Promise.all(
      wire.tasks.map(async ({ titleProtection, ...task }) => {
        let title: string;
        try {
          title = await decodePrivateDisplayLabelForWorker({
            opaque: titleProtection,
            ownerId: binding.ownerId,
            recordKind: "chat",
            rowId: task.id,
            service,
          });
        } catch (error) {
          if (!(error instanceof PrivateDisplayLabelWorkerError)) throw error;
          title = `Task ${task.id}`;
        }
        return { ...task, title };
      }),
    ),
  });
  if (options.request.operation === "task.create") {
    const input = cantripMcpTaskCreateInputSchema.parse(
      options.request.arguments,
    );
    const operationId = input.operationId;
    const hex = createHash("sha256")
      .update(`agent-task:${binding.chatId}:${operationId}`)
      .digest("hex");
    const chatId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    const content: TaskProtectedContent = {
      version: 1,
      classification: {
        state: "draft",
        stableStateBeforeFailure: null,
        activeOperationKind: null,
        planAuthorship: "agent",
        planningRound: 0,
        hasPlan: false,
        hasQuestions: false,
        hasFinalPlan: false,
        hasGoalPrompt: false,
        lastError: null,
      },
      briefMarkdown: input.description,
      planMarkdown: null,
      currentQuestions: [],
      currentAnswers: [],
      additionalDirection: "",
      finalPlanMarkdown: null,
      goalPrompt: null,
      lastError: null,
    };
    const component = service.componentKey("task-content");
    try {
      const wire = agentTaskCreateWireSchema.parse({
        operationId,
        task: {
          chatId,
          planGoalEnabled: false,
          autoTitle: false,
          titleProtection: await encodePrivateDisplayLabelForWorker({
            label:
              input.title ??
              input.description.split(/\r?\n/u)[0]!.slice(0, 100),
            ownerId: binding.ownerId,
            recordKind: "chat",
            rowId: chatId,
            service,
          }),
          task: {
            classification: content.classification,
            protectedContent: await encryptTaskProtectedContent({
              ownerId: binding.ownerId,
              chatId,
              keyRevision: component.keyRevision,
              componentKey: component.key,
              content,
            }),
          },
        },
      });
      const created = await relay("task.create", wire);
      return result(
        created.summary,
        {
          ...(await openStatus(agentTaskStatusWireSchema.parse(created.data))),
          taskId: chatId,
          operationId,
        },
        true,
      );
    } finally {
      clearSensitiveBytes(component.key);
    }
  }
  if (options.request.operation === "task.list") {
    const input = cantripMcpTaskListInputSchema.parse(
      options.request.arguments,
    );
    const listed = await relay("task.list", input);
    return result(
      listed.summary,
      await openStatus(agentTaskStatusWireSchema.parse(listed.data)),
    );
  }
  const waiting = options.request.operation === "task.wait";
  const wait = waiting
    ? cantripMcpTaskWaitInputSchema.parse(options.request.arguments)
    : null;
  const input =
    wait ?? cantripMcpTaskStatusInputSchema.parse(options.request.arguments);
  const taskIds = [...new Set(input.taskIds)];
  if (wait && taskIds.includes(binding.chatId))
    throw new Error("A task cannot wait for itself.");
  const deadline = wait?.timeoutMs
    ? performance.now() + wait.timeoutMs
    : Infinity;
  while (true) {
    options.signal?.throwIfAborted();
    if (Date.now() >= Date.parse(binding.expiresAt))
      throw new Error("Cantrip MCP binding has expired.");
    const response = await relay("task.status", { taskIds });
    options.signal?.throwIfAborted();
    const wire = agentTaskStatusWireSchema.parse(response.data);
    const finishedTaskIds = wire.tasks
      .filter((task) => task.terminal)
      .map((task) => task.id);
    const satisfied =
      wait?.mode === "any"
        ? finishedTaskIds.length > 0
        : finishedTaskIds.length === taskIds.length;
    const timedOut = Boolean(
      wait && !satisfied && performance.now() >= deadline,
    );
    if (!wait || satisfied || timedOut || wire.missingTaskIds.length) {
      return result(
        wait
          ? satisfied
            ? "Task wait finished."
            : timedOut
              ? "Task wait timed out."
              : "A requested task is unavailable."
          : response.summary,
        {
          ...(await openStatus(wire)),
          ...(wait
            ? { mode: wait.mode, satisfied, timedOut, finishedTaskIds }
            : {}),
        },
      );
    }
    await delay(Math.min(1_000, deadline - performance.now()), undefined, {
      signal: options.signal,
    });
  }
}
