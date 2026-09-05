import { z } from "zod";
import { computerUseRequestSchema, cuaIdSchema } from "./computer-use.js";
import { interactionResponseOpaqueContentSchema } from "./communication-content.js";

/** Server-routed chat authority; never accepts a client-selected target worker. */
export const workerComputerUseCommandSchema = z.strictObject({
  type: z.literal("computer-use.operation"),
  serverId: cuaIdSchema,
  chatId: cuaIdSchema,
  executionLaneId: cuaIdSchema.nullable(),
  request: computerUseRequestSchema,
});
export type WorkerComputerUseCommand = z.infer<
  typeof workerComputerUseCommandSchema
>;

export const workerComputerUseApprovalResponseCommandSchema = z.strictObject({
  type: z.literal("computer-use.approval.respond"),
  ownerId: cuaIdSchema,
  chatId: cuaIdSchema,
  executionLaneId: cuaIdSchema.nullable(),
  requestKey: z.string().uuid(),
  response: interactionResponseOpaqueContentSchema,
});
export type WorkerComputerUseApprovalResponseCommand = z.infer<
  typeof workerComputerUseApprovalResponseCommandSchema
>;
