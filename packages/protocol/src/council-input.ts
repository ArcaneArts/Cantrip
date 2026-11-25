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

export function councilProjectResultLink(source: CouncilProjectResultSource) {
  return `?${new URLSearchParams({
    councilProject: source.projectId,
    projectChat: source.chatId,
    message: source.inputMessageId,
  })}`;
}
