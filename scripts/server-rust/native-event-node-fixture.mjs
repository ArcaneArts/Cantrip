import { NativeCommandError } from "../../cantrip_server/src/db/repository/native-commands.ts";
export async function nativeEventFixture(repository, input) {
  const { owner, worker, operation, generation } = input;
  return repository.nativeCommands.withEventContext(
    owner,
    worker,
    operation,
    generation,
    async (context, transaction) => {
      if (input.action === "context") return context;
      if (input.action.startsWith("interaction")) {
        const saved =
          input.action === "interaction-terminal"
            ? await transaction.terminalizeAgentInteractionRequestFromWorker(
                input.key,
                context.chatId,
                worker,
                input.status,
                input.resolution,
              )
            : await transaction.recordEncryptedAgentInteractionRequest(
                input.interaction,
              );
        if (input.plan)
          await transaction.updateEncryptedChatPlanState(
            context.chatId,
            input.plan,
          );
        if (input.action === "interaction-rollback")
          throw new NativeCommandError("fixture-native-event-rollback");
        return { context, saved };
      }
      const attribution =
        context.contextKind === "standalone"
          ? {
              contextKind: "standalone",
              executionLaneId: context.executionLaneId,
              scratchRootId: context.scratchRootId,
              worktreeId: null,
            }
          : {
              contextKind: "project",
              executionLaneId: context.executionLaneId,
              worktreeId: context.worktreeId,
              scratchRootId: null,
            };
      let saved = null,
        nestedRejected = false;
      if (input.action === "task")
        saved = await transaction.upsertTaskMessage(
          owner,
          context.chatId,
          input.message,
          attribution,
        );
      else if (input.action === "nested-error") {
        try {
          await transaction.upsertEncryptedMessage(
            owner,
            context.chatId,
            input.message,
            attribution,
          );
        } catch {
          nestedRejected = true;
        }
      } else
        saved = await transaction.upsertEncryptedMessage(
          owner,
          context.chatId,
          input.message,
          attribution,
        );
      if (input.plan)
        await transaction.updateEncryptedChatPlanState(
          context.chatId,
          input.plan,
        );
      if (input.action === "rollback")
        throw new NativeCommandError("fixture-native-event-rollback");
      return { context, saved, nestedRejected };
    },
  );
}
