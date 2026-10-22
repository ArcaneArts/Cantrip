import {
  taskWorkerListSchema,
  type TaskWorkerCreate,
  taskWorkerSummarySchema,
  taskWorkerCreateSchema,
  type TaskWorkerUpdate,
  taskWorkerUpdateSchema,
  taskWorkerDeleteSchema,
  type TaskWorkerOrderUpdate,
  taskWorkerOrderUpdateSchema,
  projectTaskPauseStateSchema,
  type ProjectTaskPauseUpdate,
  projectTaskPauseUpdateSchema,
} from "@cantrip/protocol/task-scheduling";
import { request, post, CantripApiError } from "@/lib/api-client";
import {
  projectTaskWorkloadOpaqueSchema,
  chatMessageListSchema,
  taskWireCreateResultSchema,
  taskImplementationOpaqueDashboardSchema,
  taskImplementationDashboardSchema,
} from "@cantrip/protocol";
import {
  mapWithConcurrency,
  CHAT_MESSAGE_DECRYPT_CONCURRENCY,
} from "@/lib/chat-message-history";
import {
  openTaskOpaqueSummary,
  createInitialTaskOpaqueContent,
  prepareTaskDraftPersistence,
  prepareTaskPlanPersistence,
} from "@/lib/task-persistence-encryption";
import { openEncryptedChatPlanWireState } from "@/lib/chat-plan-encryption";
import {
  openTaskMessageOpaqueSummary,
  openTaskGoalOpaqueSnapshot,
} from "@/lib/task-message-encryption";
import type {
  ExecutionTarget,
  TaskDraftUpdate,
  TaskOperationStart,
  TaskPlanUpdate,
  TaskContinuationStart,
} from "@cantrip/protocol";
import { chatTitleEncryption } from "@/lib/chat-title-encryption";
import { openAttachmentOpaqueList } from "@/lib/attachment-encryption";
import { chatAttachmentOpaqueListSchema } from "@cantrip/protocol/attachment-content";

export async function getTaskWorkers() {
  return taskWorkerListSchema.parse(
    await request("/api/settings/task-workers"),
  );
}

export async function createTaskWorker(input: TaskWorkerCreate) {
  return taskWorkerSummarySchema.parse(
    await request("/api/settings/task-workers", {
      method: "POST",
      body: JSON.stringify(taskWorkerCreateSchema.parse(input)),
    }),
  );
}

export async function updateTaskWorker(
  taskWorkerId: string,
  input: TaskWorkerUpdate,
) {
  return taskWorkerSummarySchema.parse(
    await request(
      `/api/settings/task-workers/${encodeURIComponent(taskWorkerId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(taskWorkerUpdateSchema.parse(input)),
      },
    ),
  );
}

export async function deleteTaskWorker(
  taskWorkerId: string,
  rowVersion: number,
): Promise<void> {
  await request(
    `/api/settings/task-workers/${encodeURIComponent(taskWorkerId)}`,
    {
      method: "DELETE",
      body: JSON.stringify(taskWorkerDeleteSchema.parse({ rowVersion })),
    },
  );
}

export async function reorderTaskWorkers(input: TaskWorkerOrderUpdate) {
  return taskWorkerListSchema.parse(
    await request("/api/settings/task-workers/order", {
      method: "PUT",
      body: JSON.stringify(taskWorkerOrderUpdateSchema.parse(input)),
    }),
  );
}

export async function getProjectTaskPauseState(projectId: string) {
  return projectTaskPauseStateSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/tasks/pause`),
  );
}

export async function getProjectTaskWorkload(projectId: string) {
  const opaque = projectTaskWorkloadOpaqueSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/workload`,
    ),
  );
  const items = await mapWithConcurrency(opaque.items, 6, async (item) => ({
    task: await openTaskOpaqueSummary(item.task),
    plan: await openEncryptedChatPlanWireState(item.task.chatId, item.plan),
    messages: chatMessageListSchema.parse(
      await mapWithConcurrency(
        item.messages,
        CHAT_MESSAGE_DECRYPT_CONCURRENCY,
        (message) => openTaskMessageOpaqueSummary(message),
      ),
    ),
  }));
  return { projectId: opaque.projectId, items };
}

export async function setProjectTaskPauseState(
  projectId: string,
  input: ProjectTaskPauseUpdate,
) {
  return projectTaskPauseStateSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/pause`,
      {
        method: "PATCH",
        body: JSON.stringify(projectTaskPauseUpdateSchema.parse(input)),
      },
    ),
  );
}

export async function createTask(
  projectId: string,
  title: string | undefined,
  worktreeId?: string,
  worktreeMode?: "agent-managed" | "pinned",
  paneId?: string,
  target?: ExecutionTarget,
) {
  const chatId = crypto.randomUUID();
  const task = await createInitialTaskOpaqueContent(chatId);
  const created = taskWireCreateResultSchema.parse(
    await post(`/api/projects/${encodeURIComponent(projectId)}/tasks`, {
      chatId,
      planGoalEnabled: false,
      task,
      titleProtection: await chatTitleEncryption.protect(
        chatId,
        title ?? "New task",
      ),
      autoTitle: title === undefined,
      ...(worktreeId ? { worktreeId } : {}),
      ...(worktreeMode ? { worktreeMode } : {}),
      ...(paneId ? { paneId } : {}),
      ...(target ? { target } : {}),
    }),
  );
  return {
    chat: await chatTitleEncryption.open(created.chat),
    task: await openTaskOpaqueSummary(created.task),
  };
}

export async function getTask(chatId: string) {
  return openTaskOpaqueSummary(
    await request(`/api/tasks/${encodeURIComponent(chatId)}`),
  );
}

export async function recoverTaskImplementation(chatId: string) {
  return openTaskOpaqueSummary(
    await post(`/api/tasks/${encodeURIComponent(chatId)}/recover`, {}),
  );
}

export async function deleteTask(chatId: string) {
  await request(`/api/tasks/${encodeURIComponent(chatId)}`, {
    method: "DELETE",
  });
}

export async function getTaskImplementationDashboard(chatId: string) {
  const opaque = taskImplementationOpaqueDashboardSchema.parse(
    await request(`/api/tasks/${encodeURIComponent(chatId)}/dashboard`),
  );
  return taskImplementationDashboardSchema.parse({
    ...opaque,
    task: await openTaskOpaqueSummary(opaque.task),
    goal: opaque.goal ? await openTaskGoalOpaqueSnapshot(opaque.goal) : null,
  });
}

export async function getTaskAttachments(chatId: string) {
  return openAttachmentOpaqueList(
    chatAttachmentOpaqueListSchema.parse(
      await request(`/api/tasks/${encodeURIComponent(chatId)}/attachments`),
    ),
  );
}

function assertCurrentTaskVersion(
  currentVersion: number,
  expectedVersion: number,
) {
  if (currentVersion !== expectedVersion) {
    throw new CantripApiError(
      "The Task changed before this update was saved.",
      409,
    );
  }
}

export async function updateTaskDraft(chatId: string, input: TaskDraftUpdate) {
  const current = await getTask(chatId);
  assertCurrentTaskVersion(current.rowVersion, input.rowVersion);
  const mutation = await prepareTaskDraftPersistence(current, input);
  return openTaskOpaqueSummary(
    await request(`/api/tasks/${encodeURIComponent(chatId)}/draft`, {
      method: "PATCH",
      body: JSON.stringify(mutation),
    }),
  );
}

async function queueTaskOperation(
  chatId: string,
  path: "start" | "plan" | "continue" | "begin-implementation" | "retry",
  input: TaskOperationStart,
) {
  const current = await getTask(chatId);
  assertCurrentTaskVersion(current.rowVersion, input.rowVersion);
  return openTaskOpaqueSummary(
    await post(`/api/tasks/${encodeURIComponent(chatId)}/${path}`, {
      operationId: input.operationId,
      rowVersion: input.rowVersion,
    }),
  );
}

export async function startTaskPlanning(
  chatId: string,
  input: TaskOperationStart,
) {
  return queueTaskOperation(chatId, "plan", input);
}

export async function startTaskDirectly(
  chatId: string,
  input: TaskOperationStart,
) {
  return queueTaskOperation(chatId, "start", input);
}

export async function updateTaskPlan(chatId: string, input: TaskPlanUpdate) {
  const current = await getTask(chatId);
  assertCurrentTaskVersion(current.rowVersion, input.rowVersion);
  const mutation = await prepareTaskPlanPersistence(current, input);
  return openTaskOpaqueSummary(
    await request(`/api/tasks/${encodeURIComponent(chatId)}/plan`, {
      method: "PATCH",
      body: JSON.stringify(mutation),
    }),
  );
}

export async function continueTaskPlanning(
  chatId: string,
  input: TaskContinuationStart,
) {
  return queueTaskOperation(chatId, "continue", input);
}

export async function beginTaskImplementation(
  chatId: string,
  input: TaskContinuationStart,
) {
  return queueTaskOperation(chatId, "begin-implementation", input);
}

export async function retryTaskPlanning(
  chatId: string,
  input: TaskOperationStart,
) {
  return queueTaskOperation(chatId, "retry", input);
}
