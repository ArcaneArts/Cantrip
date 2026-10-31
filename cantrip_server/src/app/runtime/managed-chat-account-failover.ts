import { randomUUID } from "node:crypto";
import {
  shouldUseChatGptCredits,
  type NativeRuntimeHandoffRequest,
} from "@cantrip/protocol";
import type {
  ChatExecutionContext,
  ServerRepository,
} from "../../db/repository.js";
import { resolveAccountProviderRuntimes } from "../../models/chatgpt-account-routing.js";

export interface ManagedChatAccountFailoverDependencies {
  repository: Pick<
    ServerRepository,
    | "getChatExecutionContext"
    | "getModelRuntimeByRoute"
    | "listModelProviderAccountRuntimes"
    | "nativeCommands"
  >;
  handoffRuntime(
    ownerId: string,
    chatId: string,
    input: NativeRuntimeHandoffRequest,
  ): Promise<unknown>;
}

/** Change native ownership before admitting the next input, never by replacing
 * its route after admission. The existing handoff retains the thread and history.
 * Quota observations select a better account; they never block a turn when no
 * alternative is available. */
export function createManagedChatAccountFailover(
  deps: ManagedChatAccountFailoverDependencies,
) {
  const active = new Map<string, Promise<ChatExecutionContext>>();
  const switchAccount = async (
    ownerId: string,
    original: ChatExecutionContext,
    expectedInputRevision: number | undefined,
  ) => {
    const context =
      (await deps.repository.getChatExecutionContext(
        ownerId,
        original.chatId,
      )) ?? original;
    if (
      context.contextKind !== "project" ||
      context.experience !== "agent" ||
      !context.threadId ||
      !context.modelRouteId ||
      !context.providerAccountId ||
      context.executionLaneId ||
      context.managedInputRevision !== expectedInputRevision
    )
      return context;
    const runtime = await deps.repository.getModelRuntimeByRoute(
      ownerId,
      context.modelRouteId,
    );
    if (runtime?.provider.kind !== "chatgpt") return context;
    const accounts = await deps.repository.listModelProviderAccountRuntimes(
      ownerId,
      runtime.provider.id,
      context.workerId,
      runtime.model.providerModelId,
    );
    const current = accounts.find(
      (account) => account.accountId === context.providerAccountId,
    );
    if (
      !current ||
      current.weeklyUsageUsedPercent === null ||
      current.weeklyUsageUsedPercent < 100 ||
      shouldUseChatGptCredits(current.credits)
    )
      return context;
    const { runtimes } = await resolveAccountProviderRuntimes({
      ownerId,
      workerId: context.workerId,
      runtime,
      repository: { listModelProviderAccountRuntimes: async () => accounts },
    });
    const target = runtimes.find(
      ({ provider }) =>
        provider.accountId && provider.accountId !== context.providerAccountId,
    );
    if (!target?.provider.accountId) return context;
    const settings = await deps.repository.nativeCommands.settingsState(
      ownerId,
      context.chatId,
    );
    if (!settings?.binding) return context;
    if (
      settings.binding.threadId !== context.threadId ||
      settings.binding.workerId !== context.workerId ||
      settings.binding.modelRouteId !== context.modelRouteId ||
      settings.binding.providerAccountId !== context.providerAccountId
    )
      return (
        (await deps.repository.getChatExecutionContext(
          ownerId,
          context.chatId,
        )) ?? context
      );
    await deps.handoffRuntime(ownerId, context.chatId, {
      operationId: randomUUID(),
      bindingId: settings.binding.bindingId,
      targetModelRouteId: context.modelRouteId,
      targetProviderAccountId: target.provider.accountId,
    });
    const updated = await deps.repository.getChatExecutionContext(
      ownerId,
      context.chatId,
    );
    if (!updated)
      throw new Error("The transferred chat is no longer available.");
    return updated;
  };
  return (
    ownerId: string,
    context: ChatExecutionContext,
    expectedInputRevision: number | undefined,
  ) => {
    const key = `${ownerId}:${context.chatId}`;
    const existing = active.get(key);
    if (existing) return existing;
    const operation = switchAccount(
      ownerId,
      context,
      expectedInputRevision,
    ).finally(() => {
      if (active.get(key) === operation) active.delete(key);
    });
    active.set(key, operation);
    return operation;
  };
}
