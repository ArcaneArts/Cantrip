import { z } from "zod";
import { computerUseRequestSchema, cuaIdSchema } from "./computer-use.js";
import { cuaAgentAuthoritySchema } from "./computer-use-agent.js";
import { interactionResponseOpaqueContentSchema } from "./communication-content.js";
import {
  cuaPreviewAuthoritySchema,
  cuaPreviewBindingSchema,
  cuaPreviewRevocationSchema,
} from "./computer-use-preview.js";

/** Server-routed chat authority; never accepts a client-selected target worker. */
export const workerComputerUseCommandSchema = z.strictObject({
  type: z.literal("computer-use.operation"),
  serverId: cuaIdSchema,
  chatId: cuaIdSchema,
  executionLaneId: cuaIdSchema.nullable(),
  request: computerUseRequestSchema,
  preview: cuaPreviewBindingSchema.optional(),
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
  previewAuthority: cuaPreviewAuthoritySchema.optional(),
  agentAuthority: cuaAgentAuthoritySchema.optional(),
});
export type WorkerComputerUseApprovalResponseCommand = z.infer<
  typeof workerComputerUseApprovalResponseCommandSchema
>;

export const workerComputerUsePreviewOpenCommandSchema = z.strictObject({
  type: z.literal("computer-use.preview.open"),
  authority: cuaPreviewAuthoritySchema,
});
export const workerComputerUsePreviewStopCommandSchema = z.strictObject({
  type: z.literal("computer-use.preview.stop"),
  ownerId: cuaIdSchema,
  serverId: cuaIdSchema,
  chatId: cuaIdSchema,
  leaseId: z.string().uuid(),
});
export const workerComputerUsePreviewRevokeCommandSchema = z.strictObject({
  type: z.literal("computer-use.preview.revoke"),
  ownerId: cuaIdSchema,
  serverId: cuaIdSchema,
  scope: cuaPreviewRevocationSchema,
});
