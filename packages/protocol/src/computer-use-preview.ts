import { z } from "zod";
import { cuaIdSchema } from "./computer-use.js";
import { encryptedAgentInteractionRequestCreateSchema } from "./agent-interactions.js";

/** Server-owned authorization state, never copied from a browser request. */
export const cuaPreviewAuthoritySchema = z.strictObject({
  ownerId: cuaIdSchema,
  serverId: cuaIdSchema,
  workerId: cuaIdSchema,
  chatId: cuaIdSchema,
  projectId: cuaIdSchema.nullable(),
  contextKind: z.enum(["project", "standalone"]),
  placementId: cuaIdSchema,
  generation: z.number().int().min(1).max(2_147_483_647),
  profile: z.strictObject({
    selectedId: cuaIdSchema,
    effectiveId: cuaIdSchema,
    forcedByWorktreePolicy: z.boolean(),
    usesDefault: z.boolean(),
  }),
});
export const cuaPreviewLeaseSchema = z.strictObject({
  leaseId: z.string().uuid(),
  workerId: cuaIdSchema,
  chatId: cuaIdSchema,
  generation: z.number().int().min(1).max(2_147_483_647),
});
export const cuaPreviewStopSchema = z.strictObject({
  leaseId: z.string().uuid(),
  workerId: cuaIdSchema,
});
/** Worker result: Stop has completed even if its subsequent history write fails.
 * The server keeps this diagnostic out of the public Stop response. */
export const cuaPreviewStoppedSchema = z.strictObject({
  closed: z.literal(true),
  activityPublicationFailed: z.literal(true).optional(),
});
export const cuaPreviewBindingSchema = z.strictObject({
  leaseId: z.string().uuid(),
  authority: cuaPreviewAuthoritySchema,
});
export const cuaApprovalRequestEventSchema = z.strictObject({
  type: z.literal("computer-use.approval.request"),
  operationId: z.string().uuid(),
  request: encryptedAgentInteractionRequestCreateSchema,
});
export const cuaApprovalTerminalSchema = z.strictObject({
  type: z.literal("computer-use.approval.terminal"),
  chatId: cuaIdSchema,
  requestKey: z.string().uuid(),
  status: z.enum(["expired", "interrupted"]),
});
export const cuaPreviewRevocationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("chat"), chatId: cuaIdSchema }),
  z.strictObject({ kind: z.literal("project"), projectId: cuaIdSchema }),
  z.strictObject({
    kind: z.literal("inherited-default"),
    contextKind: z.enum(["project", "standalone"]),
  }),
]);
export type CuaPreviewAuthority = z.infer<typeof cuaPreviewAuthoritySchema>;
export type CuaPreviewLease = z.infer<typeof cuaPreviewLeaseSchema>;
export type CuaPreviewStopped = z.infer<typeof cuaPreviewStoppedSchema>;
export type CuaPreviewBinding = z.infer<typeof cuaPreviewBindingSchema>;
export type CuaApprovalRequestEvent = z.infer<
  typeof cuaApprovalRequestEventSchema
>;
export type CuaApprovalTerminal = z.infer<typeof cuaApprovalTerminalSchema>;
export type CuaPreviewRevocation = z.infer<typeof cuaPreviewRevocationSchema>;
