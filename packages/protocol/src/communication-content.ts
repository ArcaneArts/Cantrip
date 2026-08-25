import { z } from "zod";

import {
  encryptedPayloadEnvelopeSchema,
  encryptionBytesSchema,
  encryptionKeyRevisionSchema,
} from "./encryption.js";

export const CHAT_MESSAGE_PROTECTED_CONTENT_BYTES_LIMIT = 2 * 1_024 * 1_024;
export const QUEUED_PROMPT_PROTECTED_CONTENT_BYTES_LIMIT = 512 * 1_024;
export const CHAT_COMPOSER_DRAFT_PROTECTED_CONTENT_BYTES_LIMIT = 512 * 1_024;
export const CHAT_PLAN_PROTECTED_CONTENT_BYTES_LIMIT = 1 * 1_024 * 1_024;
export const INTERACTION_PROTECTED_CONTENT_BYTES_LIMIT = 1 * 1_024 * 1_024;

const communicationMessageRoleSchema = z.enum(["user", "assistant", "system"]);
const communicationTurnModeSchema = z.enum(["default", "plan", "goal"]);
const interactionKindSchema = z.enum([
  "commandExecution",
  "fileChange",
  "permissions",
  "userInput",
  "mcpElicitation",
]);

function boundedCommunicationEnvelopeSchema(maximumPlaintextBytes: number) {
  const maximumCiphertextCharacters = Math.ceil(
    ((maximumPlaintextBytes + 16) * 4) / 3,
  );
  return z
    .object({
      formatVersion: z.literal(1),
      keyRevision: encryptionKeyRevisionSchema,
      envelope: encryptedPayloadEnvelopeSchema.extend({
        ciphertext: encryptionBytesSchema
          .min(22)
          .max(maximumCiphertextCharacters),
      }),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.envelope.version !== value.formatVersion ||
        value.envelope.keyRevision !== value.keyRevision
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Protected communication envelope metadata must match its outer metadata.",
          path: ["envelope"],
        });
      }
    });
}

function messageAttachmentIds(content: readonly unknown[]): string[] {
  return content.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    if (
      candidate.type !== "attachment" ||
      !candidate.attachment ||
      typeof candidate.attachment !== "object" ||
      Array.isArray(candidate.attachment)
    ) {
      return [];
    }
    const id = (candidate.attachment as Record<string, unknown>).id;
    return typeof id === "string" && id ? [id] : [];
  });
}

export const encryptedChatMessageProtectedContentSchema =
  boundedCommunicationEnvelopeSchema(
    CHAT_MESSAGE_PROTECTED_CONTENT_BYTES_LIMIT,
  );
export const encryptedQueuedPromptProtectedContentSchema =
  boundedCommunicationEnvelopeSchema(
    QUEUED_PROMPT_PROTECTED_CONTENT_BYTES_LIMIT,
  );
export const encryptedChatComposerDraftProtectedContentSchema =
  boundedCommunicationEnvelopeSchema(
    CHAT_COMPOSER_DRAFT_PROTECTED_CONTENT_BYTES_LIMIT,
  );
export const encryptedChatPlanProtectedContentSchema =
  boundedCommunicationEnvelopeSchema(CHAT_PLAN_PROTECTED_CONTENT_BYTES_LIMIT);
export const encryptedInteractionRequestContentSchema =
  boundedCommunicationEnvelopeSchema(INTERACTION_PROTECTED_CONTENT_BYTES_LIMIT);
export const encryptedInteractionResponseContentSchema =
  boundedCommunicationEnvelopeSchema(INTERACTION_PROTECTED_CONTENT_BYTES_LIMIT);

export const chatMessageProtectedClassificationSchema = z
  .object({
    role: communicationMessageRoleSchema,
    mode: communicationTurnModeSchema,
    attachmentIds: z.array(z.string().min(1).max(200)).max(20),
  })
  .strict();

export const chatMessageProtectedContentSchema = z
  .object({
    version: z.literal(1),
    classification: chatMessageProtectedClassificationSchema,
    content: z.array(z.json()).min(1).max(1_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      JSON.stringify(value.classification.attachmentIds) !==
      JSON.stringify(messageAttachmentIds(value.content))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Protected chat message attachment classification does not match its content.",
        path: ["classification", "attachmentIds"],
      });
    }
  });

export const chatMessageOpaqueContentSchema = z
  .object({
    id: z.string().uuid(),
    classification: chatMessageProtectedClassificationSchema,
    protectedContent: encryptedChatMessageProtectedContentSchema,
    reasoningEffort: z.string().min(1).max(100).nullable().default(null),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();

export const chatMessageOpaqueSummarySchema =
  chatMessageProtectedClassificationSchema
    .extend({
      id: z.string().min(1).max(200),
      chatId: z.string().min(1).max(200),
      contextKind: z.enum(["project", "standalone"]).default("project"),
      worktreeId: z.string().min(1).max(200).nullable(),
      scratchRootId: z.string().min(1).max(200).nullable().default(null),
      executionLaneId: z.string().min(1).max(200).nullable(),
      sequence: z.number().int().positive(),
      protectedContent: encryptedChatMessageProtectedContentSchema,
      modelId: z.string().min(1).max(200).nullable(),
      modelRouteId: z.string().min(1).max(200).nullable(),
      providerId: z.string().min(1).max(200).nullable(),
      providerName: z.string().min(1).max(500).nullable(),
      providerModelName: z.string().min(1).max(500).nullable(),
      reasoningEffort: z.string().min(1).max(100).nullable(),
      appliedReasoningEffort: z.string().min(1).max(100).nullable(),
      reasoningAdjusted: z.boolean(),
      idempotencyKey: z.string().min(1).max(200).nullable(),
      createdAt: z.iso.datetime(),
    })
    .strict()
    .superRefine((message, context) => {
      if (
        (message.contextKind === "project" &&
          message.worktreeId !== null &&
          message.scratchRootId === null) ||
        (message.contextKind === "standalone" &&
          message.worktreeId === null &&
          message.scratchRootId !== null)
      ) {
        return;
      }
      context.addIssue({
        code: "custom",
        message: "Chat message execution root is invalid.",
        path: ["contextKind"],
      });
    });

export const chatMessageOpaqueContentListSchema = z
  .array(chatMessageOpaqueContentSchema)
  .max(100_000);

export const chatPlanProtectedClassificationSchema = z
  .object({ hasQuestion: z.boolean() })
  .strict();

const protectedPlanStepSchema = z
  .object({
    step: z.string().min(1).max(10_000),
    status: z.enum(["pending", "inProgress", "completed"]),
  })
  .strict();

const protectedPlanQuestionSchema = z
  .object({
    id: z.string().min(1).max(200),
    header: z.string().min(1).max(1_000),
    question: z.string().min(1).max(10_000),
    isOther: z.boolean(),
    isSecret: z.boolean(),
    options: z
      .array(
        z
          .object({
            label: z.string().min(1).max(1_000),
            description: z.string().max(10_000),
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .nullable(),
  })
  .strict();

const protectedPendingPlanQuestionSchema = z
  .object({
    id: z.string().min(1).max(200),
    threadId: z.string().min(1).max(200),
    turnId: z.string().min(1).max(200),
    itemId: z.string().min(1).max(200),
    questions: z.array(protectedPlanQuestionSchema).min(1).max(3),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const chatPlanProtectedContentSchema = z
  .object({
    version: z.literal(1),
    classification: chatPlanProtectedClassificationSchema,
    explanation: z.string().max(100_000).nullable(),
    steps: z.array(protectedPlanStepSchema).max(1_000),
    question: protectedPendingPlanQuestionSchema.nullable(),
  })
  .strict()
  .refine(
    ({ classification, question }) =>
      classification.hasQuestion === Boolean(question),
    {
      message: "Protected plan question classification does not match content.",
      path: ["classification", "hasQuestion"],
    },
  );

export const chatPlanOpaqueStateSchema = z
  .object({
    classification: chatPlanProtectedClassificationSchema,
    protectedContent: encryptedChatPlanProtectedContentSchema,
  })
  .strict();

export const queuedPromptProtectedClassificationSchema = z
  .object({
    mode: communicationTurnModeSchema,
    attachmentIds: z.array(z.string().min(1).max(200)).max(20),
  })
  .strict();

export const queuedPromptProtectedContentSchema = z
  .object({
    version: z.literal(1),
    classification: queuedPromptProtectedClassificationSchema,
    text: z.string().trim().max(100_000),
  })
  .strict()
  .refine(
    ({ classification, text }) =>
      text.length > 0 || classification.attachmentIds.length > 0,
    { message: "A protected queued prompt needs text or an attachment." },
  );

export const queuedPromptOpaqueContentSchema = z
  .object({
    id: z.string().uuid(),
    classification: queuedPromptProtectedClassificationSchema,
    protectedContent: encryptedQueuedPromptProtectedContentSchema,
    modelId: z.string().min(1).max(200),
    reasoningEffort: z.string().min(1).max(100).nullable().default(null),
    customSubagentModel: z.boolean().default(false),
    subagentModelId: z.string().min(1).max(200).nullable().default(null),
    subagentReasoningEffort: z
      .string()
      .min(1)
      .max(100)
      .nullable()
      .default(null),
    worktreeId: z.string().min(1).max(200).nullable().default(null),
    frozen: z.boolean().default(false),
    idempotencyKey: z.string().min(1).max(200),
    pendingMessage: chatMessageOpaqueContentSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.customSubagentModel && !value.subagentModelId) {
      context.addIssue({
        code: "custom",
        message: "A custom queued subagent model must be selected.",
        path: ["subagentModelId"],
      });
    }
    if (
      value.pendingMessage.classification.mode !== value.classification.mode ||
      JSON.stringify(value.pendingMessage.classification.attachmentIds) !==
        JSON.stringify(value.classification.attachmentIds) ||
      value.pendingMessage.reasoningEffort !== value.reasoningEffort
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Queued prompt metadata must match its future encrypted chat message.",
        path: ["pendingMessage"],
      });
    }
  });

export const chatComposerDraftProtectedContentSchema = z
  .object({
    version: z.literal(1),
    text: z.string().max(100_000),
    mode: communicationTurnModeSchema,
    reasoningEffort: z.string().min(1).max(100).nullable(),
  })
  .strict();

export const chatComposerDraftOpaqueStateSchema = z
  .object({
    protectedContent: encryptedChatComposerDraftProtectedContentSchema,
  })
  .strict();

export const encryptedChatComposerDraftWireStateSchema = z
  .object({
    chatId: z.string().min(1).max(200),
    state: chatComposerDraftOpaqueStateSchema.nullable(),
    updatedAt: z.iso.datetime().nullable(),
  })
  .strict();

export const encryptedChatComposerDraftUpdateSchema = z
  .object({ state: chatComposerDraftOpaqueStateSchema.nullable() })
  .strict();

export const interactionProtectedClassificationSchema = z
  .object({ kind: interactionKindSchema })
  .strict();

export const interactionRequestProtectedContentSchema = z
  .object({
    version: z.literal(1),
    classification: interactionProtectedClassificationSchema,
    payload: z.json(),
  })
  .strict();

export const interactionResponseProtectedContentSchema = z
  .object({
    version: z.literal(1),
    classification: interactionProtectedClassificationSchema,
    response: z.json(),
  })
  .strict();

export const interactionRequestOpaqueContentSchema = z
  .object({
    classification: interactionProtectedClassificationSchema,
    protectedPayload: encryptedInteractionRequestContentSchema,
  })
  .strict();

export const interactionResponseOpaqueContentSchema = z
  .object({
    classification: interactionProtectedClassificationSchema,
    protectedResponse: encryptedInteractionResponseContentSchema,
  })
  .strict();

export type EncryptedChatMessageProtectedContent = z.infer<
  typeof encryptedChatMessageProtectedContentSchema
>;
export type EncryptedQueuedPromptProtectedContent = z.infer<
  typeof encryptedQueuedPromptProtectedContentSchema
>;
export type EncryptedChatComposerDraftProtectedContent = z.infer<
  typeof encryptedChatComposerDraftProtectedContentSchema
>;
export type EncryptedChatPlanProtectedContent = z.infer<
  typeof encryptedChatPlanProtectedContentSchema
>;
export type EncryptedInteractionRequestContent = z.infer<
  typeof encryptedInteractionRequestContentSchema
>;
export type EncryptedInteractionResponseContent = z.infer<
  typeof encryptedInteractionResponseContentSchema
>;
export type ChatMessageProtectedClassification = z.infer<
  typeof chatMessageProtectedClassificationSchema
>;
export type ChatMessageProtectedContent = z.infer<
  typeof chatMessageProtectedContentSchema
>;
export type ChatMessageOpaqueContent = z.infer<
  typeof chatMessageOpaqueContentSchema
>;
export type ChatMessageOpaqueSummary = z.infer<
  typeof chatMessageOpaqueSummarySchema
>;
export type ChatPlanProtectedClassification = z.infer<
  typeof chatPlanProtectedClassificationSchema
>;
export type ChatPlanProtectedContent = z.infer<
  typeof chatPlanProtectedContentSchema
>;
export type ChatPlanOpaqueState = z.infer<typeof chatPlanOpaqueStateSchema>;
export type QueuedPromptProtectedClassification = z.infer<
  typeof queuedPromptProtectedClassificationSchema
>;
export type QueuedPromptProtectedContent = z.infer<
  typeof queuedPromptProtectedContentSchema
>;
export type QueuedPromptOpaqueContent = z.infer<
  typeof queuedPromptOpaqueContentSchema
>;
export type ChatComposerDraftProtectedContent = z.infer<
  typeof chatComposerDraftProtectedContentSchema
>;
export type ChatComposerDraftOpaqueState = z.infer<
  typeof chatComposerDraftOpaqueStateSchema
>;
export type EncryptedChatComposerDraftWireState = z.infer<
  typeof encryptedChatComposerDraftWireStateSchema
>;
export type EncryptedChatComposerDraftUpdate = z.infer<
  typeof encryptedChatComposerDraftUpdateSchema
>;
export type InteractionProtectedClassification = z.infer<
  typeof interactionProtectedClassificationSchema
>;
export type InteractionRequestProtectedContent = z.infer<
  typeof interactionRequestProtectedContentSchema
>;
export type InteractionResponseProtectedContent = z.infer<
  typeof interactionResponseProtectedContentSchema
>;
export type InteractionRequestOpaqueContent = z.infer<
  typeof interactionRequestOpaqueContentSchema
>;
export type InteractionResponseOpaqueContent = z.infer<
  typeof interactionResponseOpaqueContentSchema
>;
