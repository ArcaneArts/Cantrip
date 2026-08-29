import { z } from "zod";
import {
  customizationContentScopeSchema,
  protectedCustomizationRequestSchema,
} from "./customization-content.js";
import {
  standaloneChatFileOperationIntentSchema,
  surfaceStreamWireRequestSchema,
} from "./surface-stream.js";
import { repositoryRoutingHandleSchema } from "./repository-operation.js";
import { githubRepositorySchema } from "./github.js";
import {
  standaloneChatIdentitySchema,
  standaloneChatScratchReconciliationTargetSchema,
} from "./chats.js";

export const workerRepositoryNameSchema = z.union([
  githubRepositorySchema.shape.nameWithOwner,
  repositoryRoutingHandleSchema,
]);

export const customizationWorkerContentFields = {
  operationId: z.string().uuid(),
  serverId: z.string().min(1).max(2_000),
  scope: customizationContentScopeSchema,
};

export const protectedCustomizationWorkerRequestFields = {
  ...customizationWorkerContentFields,
  protectedRequest: protectedCustomizationRequestSchema.shape.protectedRequest,
};

export const standaloneChatScratchProvisionCommandSchema = z
  .object({
    type: z.literal("chat.scratch.provision"),
    jobId: standaloneChatIdentitySchema,
    attempt: z.number().int().positive(),
    rootId: standaloneChatIdentitySchema,
    chatId: standaloneChatIdentitySchema,
  })
  .strict();

export const standaloneChatScratchResolveCommandSchema = z
  .object({
    type: z.literal("chat.scratch.resolve"),
    rootId: standaloneChatIdentitySchema,
    chatId: standaloneChatIdentitySchema,
  })
  .strict();

export const standaloneChatScratchArchiveCommandSchema = z
  .object({
    type: z.literal("chat.scratch.archive"),
    rootId: standaloneChatIdentitySchema,
    chatId: standaloneChatIdentitySchema,
    archivedAt: z.string().datetime(),
    archiveExpiresAt: z.string().datetime(),
  })
  .strict()
  .refine(
    (command) =>
      Date.parse(command.archiveExpiresAt) > Date.parse(command.archivedAt),
    { message: "Archive expiry must be later than the archive timestamp." },
  );

export const standaloneChatScratchRestoreCommandSchema = z
  .object({
    type: z.literal("chat.scratch.restore"),
    rootId: standaloneChatIdentitySchema,
    chatId: standaloneChatIdentitySchema,
  })
  .strict();

export const standaloneChatScratchDeleteCommandSchema = z
  .object({
    type: z.literal("chat.scratch.delete"),
    jobId: standaloneChatIdentitySchema,
    attempt: z.number().int().positive(),
    rootId: standaloneChatIdentitySchema,
    chatId: standaloneChatIdentitySchema,
  })
  .strict();

export const standaloneChatScratchReconcileCommandSchema = z
  .object({
    type: z.literal("chat.scratch.reconcile"),
    roots: z.array(standaloneChatScratchReconciliationTargetSchema).max(10_000),
  })
  .strict();

export const standaloneChatFileOperationCommandSchema = z
  .object({
    type: z.literal("chat.scratch.files.operation"),
    rootId: standaloneChatIdentitySchema,
    chatId: standaloneChatIdentitySchema,
    serverId: z.string().min(1).max(2_000),
    root: z.string().min(1).max(32_768),
    intent: standaloneChatFileOperationIntentSchema,
  })
  .extend(surfaceStreamWireRequestSchema.shape)
  .strict();
