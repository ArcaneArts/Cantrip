import { computerUseActivityEventSchema } from "@cantrip/protocol";
import type { ServerRepository } from "../../db/repository.js";

export interface ComputerUseActivityDependencies {
  upsertLiveEncryptedChatMessage?: (
    ...input: Parameters<ServerRepository["upsertEncryptedMessage"]>
  ) => Promise<unknown | null>;
  upsertLiveTaskMessage?: (
    ...input: Parameters<ServerRepository["upsertTaskMessage"]>
  ) => Promise<unknown | null>;
  runAsOwner?: <T>(ownerId: string, operation: () => T) => T;
}

/** One terminal, opaque activity on the already-authenticated operation stream.
 * Neither target metadata nor native errors are opened by the server. Stop may
 * use its worker-owned lease's domain after placement or archival changed. */
export function createComputerUseActivityPublisher(
  input: ComputerUseActivityDependencies & {
    ownerId: string;
    chatId: string;
    operationId: string;
    contentDomain?: "chat" | "task";
  },
) {
  let published = false;
  return async (event: unknown): Promise<void> => {
    const activity = computerUseActivityEventSchema.parse(event);
    const nested = activity.event;
    const domain =
      nested.type === "agent.protected-task-message" ? "task" : "chat";
    if (
      published ||
      activity.operationId !== input.operationId ||
      (input.contentDomain && domain !== input.contentDomain) ||
      nested.telemetry.kind !== "activity" ||
      nested.telemetry.activityType !== "computerUse" ||
      nested.telemetry.turnId !== null ||
      nested.message.classification.role !== "assistant" ||
      nested.message.classification.attachmentIds.length !== 0
    )
      throw new Error("Invalid computer-use activity publication.");
    published = true;
    const runAsOwner =
      input.runAsOwner ?? ((_ownerId, operation) => operation());
    const saved = await runAsOwner(input.ownerId, () => {
      if (nested.type === "agent.protected-task-message") {
        if (!input.upsertLiveTaskMessage)
          throw new Error("Computer-use activity publication is unavailable.");
        return input.upsertLiveTaskMessage(
          input.ownerId,
          input.chatId,
          nested.message,
        );
      }
      if (!input.upsertLiveEncryptedChatMessage)
        throw new Error("Computer-use activity publication is unavailable.");
      return input.upsertLiveEncryptedChatMessage(
        input.ownerId,
        input.chatId,
        nested.message,
      );
    });
    if (!saved)
      throw new Error("Computer-use activity publication was rejected.");
  };
}
