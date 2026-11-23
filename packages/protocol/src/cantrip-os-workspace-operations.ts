import { z } from "zod";
import { cantripOsOperationResultSchema } from "./worker-command-cantrip-os.js";

/** Public history omits the immutable command's private transport. */
export const cantripOsWorkspaceOperationSummarySchema = z.strictObject({
  operationId: z.uuid(),
  instanceId: z.uuid(),
  workerId: z.string().min(1),
  guestWorkspaceId: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/),
  attachmentGeneration: z.uuid(),
  runtimeGeneration: z.uuid(),
  state: z.enum(["admitted", "running", "ready", "failed", "unknown"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  result: cantripOsOperationResultSchema.nullable(),
});
export const cantripOsWorkspaceOperationListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.uuid().optional(),
});
export const cantripOsWorkspaceOperationPageSchema = z.strictObject({
  items: z.array(cantripOsWorkspaceOperationSummarySchema),
  nextCursor: z.uuid().nullable(),
});
