import { z } from "zod";

const sourceId = z.string().min(1).max(255);

export const councilProjectResultSourceSchema = z
  .object({
    projectId: sourceId,
    chatId: sourceId,
    inputMessageId: sourceId,
    threadId: sourceId.nullable(),
    turnId: sourceId.nullable(),
    status: z.enum(["completed", "failed", "interrupted", "unavailable"]),
  })
  .strict();

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
  return `?${new URLSearchParams({
    councilProject: source.projectId,
    projectChat: source.chatId,
    message: source.inputMessageId,
  })}`;
}

export function councilProjectRequestLink(source: CouncilProjectRequestSource) {
  const query = new URLSearchParams({
    councilProject: source.projectId,
    projectChat: source.chatId,
    request: source.requestId,
  });
  return `?${query}#agent-request-${encodeURIComponent(source.requestId)}`;
}
