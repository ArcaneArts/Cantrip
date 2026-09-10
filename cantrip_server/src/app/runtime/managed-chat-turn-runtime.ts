import {
  createChatTurnRuntime,
  type ChatTurnRuntimeDependencies,
} from "./chat-turn-runtime.js";
import { createManagedChatPreparation } from "./managed-chat-preparation.js";
import { installManagedChatPreparationRoutes } from "../routes/managed-chat-preparation.js";
import type { createModelRoutingRuntime } from "./model-routing-runtime.js";
import type { FastifyInstance } from "fastify";

/** Production composition shares the same native preparation with first GUI
 * input. CLI boot has its own failure state and cannot strand a prepared turn. */
export function createManagedChatTurnRuntime(
  deps: ChatTurnRuntimeDependencies &
    Pick<ReturnType<typeof createModelRoutingRuntime>, "runtimeForContext"> & {
      app: FastifyInstance;
      publishChatInvalidation(chatId: string, kind: "chat"): void;
    },
) {
  const preparation = createManagedChatPreparation({
    ...deps,
    publish: (ownerId, chatId) => {
      void deps.runAsOwner(ownerId, async () =>
        deps.publishChatInvalidation(chatId, "chat"),
      );
    },
  });
  installManagedChatPreparationRoutes(deps.app, { ...deps, preparation });
  const runtime = createChatTurnRuntime(deps);
  const beginTurn: typeof runtime.beginTurn = async (
    context,
    input,
    options,
  ) => {
    const expectedInputRevision =
      options?.expectedInputRevision ?? context.managedInputRevision;
    if (context.contextKind === "project" && context.experience === "agent") {
      const ownerId = deps.applicationOwnerId();
      await preparation.join(ownerId, context.chatId);
      const prepared = await deps.repository.getChatExecutionContext(
        ownerId,
        context.chatId,
      );
      if (!prepared)
        throw new Error("The prepared chat is no longer available.");
      context = prepared;
    }
    return runtime.beginTurn(context, input, {
      ...options,
      expectedInputRevision,
    });
  };
  return {
    ...runtime,
    beginTurn,
    managedChatPreparation: {
      ...preparation,
      afterWorkerRecovery:
        (
          recover: (
            ownerId: string,
            workerId: string,
          ) => Promise<ReadonlyMap<string, Promise<void>>>,
        ) =>
        async (ownerId: string, workerId: string) => {
          const recoveries = await recover(ownerId, workerId);
          await preparation.workerConnected(ownerId, workerId, recoveries);
        },
    },
  };
}
