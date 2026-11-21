import {
  computerUseActivityEventSchema,
  type ComputerUseActivityEvent,
} from "@cantrip/protocol";
import { EncryptedChatEventSealer } from "../chat-message-encryption.js";
import { EncryptedTaskEventSealer } from "../task-operation.js";
import type { WorkerEncryptionService } from "../worker-encryption.js";
import type { CuaActivity } from "./activity.js";

/** Use the same protected chat/task activity format as ordinary Trajectory.
 * The wrapper contains correlation only; all operation metadata is encrypted. */
export async function publishCuaPreviewActivity(input: {
  encryption: WorkerEncryptionService;
  contentDomain: "chat" | "task";
  activity: CuaActivity;
  emit(event: ComputerUseActivityEvent): Promise<void>;
}): Promise<void> {
  const sealer =
    input.contentDomain === "chat"
      ? new EncryptedChatEventSealer(
          input.encryption,
          input.activity.binding.chatId,
          { explanation: null, steps: [], question: null },
        )
      : new EncryptedTaskEventSealer(input.encryption, "default");
  const event = await sealer.activity(input.activity);
  await input.emit(
    computerUseActivityEventSchema.parse({
      type: "computer-use.activity",
      operationId: input.activity.operationId,
      event,
    }),
  );
}
