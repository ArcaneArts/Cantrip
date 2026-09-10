import { createHash } from "node:crypto";
import type { ChatMessageOpaqueContent } from "@cantrip/protocol";
import type { TaskMessageOpaqueContent } from "@cantrip/protocol/tasks";
import type {
  ChatExecutionContext,
  ServerRepository,
} from "../../db/repository.js";
import { NativeCommandError } from "../../db/repository/native-command-errors.js";
import { effectivePermissionProfile } from "../../chats/execution-helpers.js";
import { managedConsoleSessionContext } from "../../terminals/managed-session.js";
import type { ChatTurnOptions } from "./chat-turn-types.js";
import type { TaskTurnBootstrapObserver } from "./task-turn-bootstrap-observer.js";

/** Preserve the canonical admission/replay checks for managed and legacy turns. */
export async function acquireChatTurnExecution({
  repository,
  ownerId,
  context,
  options,
  protectedAdmissionInput,
  observeTaskTurnBootstrapStage,
}: {
  repository: ServerRepository;
  ownerId: string;
  context: ChatExecutionContext;
  options: ChatTurnOptions;
  protectedAdmissionInput:
    ChatMessageOpaqueContent | TaskMessageOpaqueContent | undefined;
  observeTaskTurnBootstrapStage: TaskTurnBootstrapObserver;
}) {
  const managedNativeCommands =
    managedConsoleSessionContext(context) !== undefined;
  if (managedNativeCommands && !protectedAdmissionInput)
    throw new Error("Chat turn content was not encrypted.");
  const nativeAdmission = managedNativeCommands
    ? await observeTaskTurnBootstrapStage("acquire-execution-lane", () =>
        repository.nativeCommands.admit(
          ownerId,
          {
            workerId: context.workerId,
            operationId: `gui:${createHash("sha256")
              .update(
                JSON.stringify([
                  ownerId,
                  context.chatId,
                  protectedAdmissionInput!.idempotencyKey,
                  ...(options.managedQueueClaim
                    ? [options.managedQueueClaim.id]
                    : []),
                ]),
              )
              .digest("hex")}`,
            origin: "gui",
            method: "turn/start",
            session: {
              chatId: context.chatId,
              threadId: context.threadId,
              contextKind: context.contextKind,
              projectId: context.projectId,
              placementId: context.worktreeId ?? context.scratchRootId,
              modelRouteId: context.modelRouteId,
              providerAccountId: context.providerAccountId,
              runtimeGeneration: null,
              connectionId: null,
            },
            payloadDigest: createHash("sha256")
              .update(JSON.stringify(protectedAdmissionInput))
              .digest("hex"),
            protectedPayload:
              protectedAdmissionInput!.protectedContent.envelope,
            expectedActivationGeneration: null,
            intent: {
              scope: "thread",
              settingKeys: [],
              expectedTurnId: null,
              permissionProfileId:
                effectivePermissionProfile(context).effectiveId,
            },
          },
          {
            acquiringActor: options.acquiringActor,
            purpose: options.purpose,
            queueClaim: options.managedQueueClaim,
            clientMessageId: protectedAdmissionInput!.id,
            expectedInputRevision:
              options.expectedInputRevision ?? context.managedInputRevision,
          },
        ),
      )
    : null;
  if (nativeAdmission?.replayed)
    throw new Error("This chat input already has a native operation receipt.");
  const execution = nativeAdmission
    ? nativeAdmission.execution
    : await observeTaskTurnBootstrapStage("acquire-execution-lane", () =>
        repository.startChatExecutionLane(
          ownerId,
          context.chatId,
          options.acquiringActor ?? "user",
          options.purpose ?? "Chat turn",
        ),
      );
  const nativeCommandReceipt = nativeAdmission?.receipt;
  if (
    (nativeCommandReceipt && nativeCommandReceipt.status !== "accepted") ||
    !execution?.executionLaneId
  ) {
    throw new NativeCommandError(
      nativeCommandReceipt?.rejectionCode ??
        "Chat execution lane could not be acquired.",
    );
  }
  return {
    // The admission check above guarantees a lane for every accepted turn.
    execution: execution as typeof execution & { executionLaneId: string },
    nativeCommandReceipt,
  };
}
