import { z } from "zod";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";

const sourceId = z.string().min(1).max(255);

const councilOrigin = { agentId: z.uuid() };

export const councilOriginSchema = z
  .object({
    ...councilOrigin,
    title: z.string().min(1).max(200),
  })
  .strict();

export const councilOriginWireSchema = z
  .object({
    ...councilOrigin,
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .strict();

export const councilLinkedWorkWireListSchema = z
  .array(
    z
      .object({
        projectId: sourceId,
        chatId: sourceId,
        targetKind: z.enum(["chat", "task"]),
        messageId: sourceId.nullable(),
        status: z.enum([
          "created",
          "draft",
          "delegated",
          "queued",
          "running",
          "paused",
          "completed",
          "failed",
          "interrupted",
          "unavailable",
        ]),
        titleProtection: privateDisplayLabelOpaqueSchema.nullable(),
      })
      .strict(),
  )
  .max(40);

export function councilAgentLink(agentId: string) {
  return `?${new URLSearchParams({ councilAgent: agentId })}`;
}

export const councilPeerMessageSourceSchema = z
  .object({
    senderAgentId: z.uuid(),
    recipientAgentId: z.uuid(),
    operationId: z.uuid(),
  })
  .strict();

export type CouncilPeerMessageSource = z.infer<
  typeof councilPeerMessageSourceSchema
>;

export const councilProviderRecoverySourceSchema = z
  .object({
    runId: sourceId,
    turnId: sourceId,
    messageId: sourceId.nullable(),
  })
  .strict();

const councilProjectSource = z
  .object({
    projectId: sourceId,
    chatId: sourceId,
    threadId: sourceId.nullable(),
    turnId: sourceId.nullable(),
    status: z.enum(["completed", "failed", "interrupted", "unavailable"]),
  })
  .strict();

export const councilProjectResultSourceSchema = z.union([
  councilProjectSource.extend({
    targetKind: z.literal("chat").optional(),
    inputMessageId: sourceId,
  }),
  councilProjectSource.extend({
    targetKind: z.literal("task"),
    inputMessageId: sourceId.nullable(),
  }),
]);

export type CouncilProjectResultSource = z.infer<
  typeof councilProjectResultSourceSchema
>;

export const councilProjectRequestSourceSchema = z
  .object({
    projectId: sourceId,
    chatId: sourceId,
    requestId: sourceId,
    targetKind: z.literal("task").optional(),
  })
  .strict();

export type CouncilProjectRequestSource = z.infer<
  typeof councilProjectRequestSourceSchema
>;

export function councilProjectResultLink(source: CouncilProjectResultSource) {
  return councilLinkedWorkLink({
    projectId: source.projectId,
    chatId: source.chatId,
    messageId: source.inputMessageId,
    targetKind: source.targetKind ?? "chat",
  });
}

export function councilLinkedWorkLink(
  source: Pick<
    z.infer<typeof councilLinkedWorkWireListSchema>[number],
    "projectId" | "chatId" | "messageId" | "targetKind"
  >,
) {
  const query = new URLSearchParams({
    councilProject: source.projectId,
    projectChat: source.chatId,
  });
  if (source.messageId) query.set("message", source.messageId);
  if (source.targetKind === "task") query.set("task", "true");
  return `?${query}`;
}

export function councilProjectRequestLink(source: CouncilProjectRequestSource) {
  const query = new URLSearchParams({
    councilProject: source.projectId,
    projectChat: source.chatId,
    request: source.requestId,
  });
  if (source.targetKind === "task") query.set("task", "true");
  return `?${query}#agent-request-${encodeURIComponent(source.requestId)}`;
}
