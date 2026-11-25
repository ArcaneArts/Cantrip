import { z } from "zod";

const sourceId = z.string().min(1).max(255);

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
  })
  .strict();

export type CouncilProjectRequestSource = z.infer<
  typeof councilProjectRequestSourceSchema
>;

export function councilProjectResultLink(source: CouncilProjectResultSource) {
  const query = new URLSearchParams({
    councilProject: source.projectId,
    projectChat: source.chatId,
  });
  if (source.inputMessageId) query.set("message", source.inputMessageId);
  if (source.targetKind === "task") query.set("task", "true");
  return `?${query}`;
}

export function councilProjectRequestLink(source: CouncilProjectRequestSource) {
  const query = new URLSearchParams({
    councilProject: source.projectId,
    projectChat: source.chatId,
    request: source.requestId,
  });
  return `?${query}#agent-request-${encodeURIComponent(source.requestId)}`;
}
