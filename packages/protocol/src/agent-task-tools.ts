import { z } from "zod";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";
import { modelConfigurationSchema } from "./model-configuration.js";
import { encryptedTaskCreateSchema } from "./chats.js";
import { taskStateSchema } from "./tasks.js";

const taskId = z.string().uuid();
const taskIds = z.array(taskId).min(1).max(50);
export const cantripMcpTaskCreateInputSchema = z
  .object({
    description: z.string().trim().min(1).max(50_000),
    title: z.string().trim().min(1).max(200).optional(),
    operationId: z.string().uuid(),
  })
  .strict();
export const cantripMcpTaskListInputSchema = z
  .object({
    cursor: z.number().int().min(0).max(100_000).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export const cantripMcpTaskStatusInputSchema = z.object({ taskIds }).strict();
export const cantripMcpTaskWaitInputSchema = z
  .object({
    taskIds,
    mode: z.enum(["all", "any"]).default("all"),
    // Zero means wait until finished, cancelled, or the active binding expires.
    timeoutMs: z.number().int().min(0).max(21_600_000).default(0),
  })
  .strict();

// Only the worker sees the task brief/title. Server admission forces direct
// execution and inherits the authoritative caller configuration.
export const agentTaskCreateWireSchema = z
  .object({
    operationId: z.string().uuid(),
    task: encryptedTaskCreateSchema,
  })
  .strict();
export const agentTaskWireDescriptorSchema = z
  .object({
    id: taskId,
    titleProtection: privateDisplayLabelOpaqueSchema,
    state: taskStateSchema,
    dispatchState: z.string().max(100).nullable(),
    eligibilityCode: z.string().max(200).nullable(),
    configuration: modelConfigurationSchema,
    terminal: z.boolean(),
    completedAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const agentTaskStatusWireSchema = z
  .object({
    tasks: z.array(agentTaskWireDescriptorSchema).max(100),
    missingTaskIds: z.array(taskId).max(50),
    nextCursor: z.number().int().nonnegative().nullable(),
  })
  .strict();
