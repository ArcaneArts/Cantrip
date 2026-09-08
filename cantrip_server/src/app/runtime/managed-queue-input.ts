import { createHash } from "node:crypto";
import type {
  ManagedQueueMutation,
  ManagedQueueMutate,
} from "@cantrip/protocol";
import type {
  ChatExecutionContext,
  ServerRepository,
} from "../../db/repository.js";
import { NativeCommandError } from "../../db/repository/native-commands.js";
/** GUI requests and virtual native requests use the same transactional queue authority. */
async function prepareGuiQueueMutation(
  repository: Pick<
    ServerRepository,
    "managedQueue" | "nativeCommands" | "getEncryptedQueuedPrompt"
  >,
  ownerId: string,
  context: ChatExecutionContext,
  mutation: ManagedQueueMutation,
  options: {
    operationId: string;
    expectedRevision?: number;
    payloadDigest?: string;
  },
): Promise<ManagedQueueMutate> {
  const state = await repository.managedQueue.snapshot(ownerId, context.chatId);
  const control = await repository.nativeCommands.controlContext(
    ownerId,
    context.chatId,
  );
  const prompt =
    mutation.kind === "add" || mutation.kind === "update"
      ? mutation.prompt
      : (state.items.find(
          (item) => "id" in mutation && item.id === mutation.id,
        ) ??
        state.items[0] ??
        ("id" in mutation && mutation.id
          ? await repository.getEncryptedQueuedPrompt(ownerId, mutation.id)
          : mutation.kind === "reorder" && mutation.ids[0]
            ? await repository.getEncryptedQueuedPrompt(
                ownerId,
                mutation.ids[0],
              )
            : null));
  if (!prompt) throw new NativeCommandError("queue-item-unavailable");
  return {
    expectedRevision: options.expectedRevision ?? state.revision,
    mutation,
    admission: {
      workerId: context.workerId,
      operationId: options.operationId,
      origin: "gui",
      method: `thread/queue/${mutation.kind}`,
      session: {
        chatId: context.chatId,
        threadId: context.threadId,
        contextKind: context.contextKind,
        projectId: context.projectId,
        placementId: context.worktreeId!,
        modelRouteId: context.modelRouteId,
        providerAccountId: context.providerAccountId,
        runtimeGeneration: control.runtimeGeneration,
        connectionId: null,
      },
      payloadDigest:
        options.payloadDigest ??
        createHash("sha256").update(JSON.stringify(mutation)).digest("hex"),
      protectedPayload: prompt.protectedContent.envelope,
      expectedActivationGeneration: control.activationGeneration,
      intent: {
        scope: "thread",
        settingKeys: [],
        expectedTurnId: null,
        ...(["add", "start"].includes(mutation.kind)
          ? { resumeAutonomy: true }
          : {}),
      },
    },
  };
}
export async function mutateManagedGuiQueue(
  ...args: Parameters<typeof prepareGuiQueueMutation>
) {
  const input = await prepareGuiQueueMutation(...args);
  const result = await args[0].managedQueue.mutate(args[1], input);
  if (result.receipt.status === "rejected")
    throw new NativeCommandError(
      result.receipt.rejectionCode ?? "queue-mutation-rejected",
    );
  return result;
}
export async function lookupManagedGuiQueue(
  ...args: Parameters<typeof prepareGuiQueueMutation>
) {
  const input = await prepareGuiQueueMutation(...args);
  const result = await args[0].managedQueue.lookup(args[1], input.admission);
  if (result.found && result.receipt.status === "rejected")
    throw new NativeCommandError(
      result.receipt.rejectionCode ?? "queue-mutation-rejected",
    );
  return result.found ? result : null;
}
