import type { NativeCommandSession } from "@cantrip/protocol";
import { and, eq } from "drizzle-orm";
import * as schema from "../schema.js";
import type { ChatExecutionContext } from "./chat-execution-lanes.js";
import { ChatRuntimeContextRepository } from "./chat-runtime-context.js";
import type { RepositoryTransaction } from "./database.js";
import { NativeCommandError } from "./native-command-errors.js";

export function samePlacement(
  context: ChatExecutionContext | null,
  workerId: string,
  session: NativeCommandSession,
): context is ChatExecutionContext {
  return (
    !!context &&
    context.workerId === workerId &&
    context.chatId === session.chatId &&
    context.projectId === session.projectId &&
    context.contextKind === session.contextKind &&
    (context.worktreeId ?? context.scratchRootId) === session.placementId
  );
}

export function sameRuntimeRoute(
  context: ChatExecutionContext,
  session: NativeCommandSession,
): boolean {
  return (
    context.modelRouteId === session.modelRouteId &&
    context.providerAccountId === session.providerAccountId
  );
}

export function nativeCommandContext(
  tx: RepositoryTransaction,
  ownerId: string,
  chatId: string,
) {
  const repository = new ChatRuntimeContextRepository(tx, {
    getChatExecutionContext: async () => {
      throw new Error("Unexpected context recursion");
    },
  });
  return repository.getChatExecutionContext(ownerId, chatId);
}

export async function readNativeCommand(
  tx: RepositoryTransaction,
  ownerId: string,
  workerId: string,
  operationId: string,
  operationGeneration: string,
) {
  const [row] = await tx
    .select()
    .from(schema.nativeCommands)
    .where(
      and(
        eq(schema.nativeCommands.operationId, operationId),
        eq(schema.nativeCommands.ownerId, ownerId),
        eq(schema.nativeCommands.workerId, workerId),
        eq(schema.nativeCommands.operationGeneration, operationGeneration),
      ),
    );
  if (!row)
    throw new NativeCommandError(
      "operation-not-found",
      "Operation not found.",
      404,
    );
  return row;
}
