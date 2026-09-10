import type { WorkerEvent } from "@cantrip/protocol";
import type { ServerRepository } from "../../db/repository.js";

/** Both input origins retain accepted answers; cancellation has no answer. */
export async function clearAgentInteraction(
  event: WorkerEvent,
  context: { chatId: string; workerId: string },
  terminalize: ServerRepository["terminalizeAgentInteractionRequestFromWorker"],
): Promise<boolean> {
  if (
    event.type !== "agent.interaction.cleared" &&
    event.type !== "agent.interaction.expired"
  )
    return false;
  await terminalize(
    event.requestKey,
    context.chatId,
    context.workerId,
    event.type === "agent.interaction.expired" ? "expired" : "interrupted",
    event.type === "agent.interaction.cleared" ? event.resolution : undefined,
  );
  return true;
}
