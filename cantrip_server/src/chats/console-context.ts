import type { ServerRepository } from "../db/repository.js";

/** Console-first chats need durable placement before tools are materialized.
 * This reserves a lane without pretending that an agent turn has started. */
export async function prepareConsoleExecutionContext(
  repository: Pick<
    ServerRepository,
    "getChatExecutionContext" | "ensureChatConsoleExecutionLane"
  >,
  ownerId: string,
  chatId: string,
) {
  const context = await repository.getChatExecutionContext(
    ownerId,
    chatId,
    true,
  );
  if (
    !context ||
    context.experience === "task" ||
    context.executionLaneId ||
    context.contextKind !== "project"
  )
    return context;
  await repository.ensureChatConsoleExecutionLane(ownerId, chatId);
  return repository.getChatExecutionContext(ownerId, chatId, true);
}
