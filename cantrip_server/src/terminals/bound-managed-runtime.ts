import type {
  ChatExecutionContext,
  ServerRepository,
} from "../db/repository.js";

/** Reconnect loads the bound route/account. Quota and model-picker availability
 * do not establish whether an existing native conversation can be observed. */
export async function boundManagedRuntime(
  ownerId: string,
  context: ChatExecutionContext,
  repository: Pick<
    ServerRepository,
    "getModelRuntimeByRoute" | "listModelProviderAccountRuntimes"
  >,
) {
  const runtime = context.modelRouteId
    ? await repository.getModelRuntimeByRoute(ownerId, context.modelRouteId)
    : null;
  if (!runtime) throw new Error("The bound provider route no longer exists.");
  if (runtime.provider.kind !== "chatgpt" && runtime.provider.kind !== "grok") {
    if (context.providerAccountId !== null)
      throw new Error("The bound provider account does not match its route.");
    return runtime;
  }
  const account = (
    await repository.listModelProviderAccountRuntimes(
      ownerId,
      runtime.provider.id,
      context.workerId,
      null,
    )
  ).find((candidate) => candidate.accountId === context.providerAccountId);
  if (!account) throw new Error("The bound provider account no longer exists.");
  return {
    ...runtime,
    provider: {
      ...runtime.provider,
      accountId: account.accountId,
      credentialHomeKey: account.credentialHomeKey,
      credits: account.credits,
    },
  };
}

/** A newly selected destination honors enabled configuration, without using
 * cached quota, authentication, or online observations as execution gates. */
export async function configuredManagedRuntime(
  ownerId: string,
  context: ChatExecutionContext,
  modelId: string,
  repository: Pick<
    ServerRepository,
    "getModelRuntime" | "listModelProviderAccountRuntimes"
  >,
) {
  const runtime = context.modelRouteId
    ? await repository.getModelRuntime(ownerId, modelId, context.modelRouteId)
    : null;
  if (!runtime)
    throw new Error("The selected provider route is no longer enabled.");
  if (runtime.provider.kind !== "chatgpt" && runtime.provider.kind !== "grok") {
    if (context.providerAccountId !== null)
      throw new Error("The selected account does not belong to this provider.");
    return runtime;
  }
  const account = (
    await repository.listModelProviderAccountRuntimes(
      ownerId,
      runtime.provider.id,
      context.workerId,
      null,
    )
  ).find(
    (entry) => entry.enabled && entry.accountId === context.providerAccountId,
  );
  if (!account)
    throw new Error("The selected provider account is no longer enabled.");
  return {
    ...runtime,
    provider: {
      ...runtime.provider,
      accountId: account.accountId,
      credentialHomeKey: account.credentialHomeKey,
      credits: account.credits,
    },
  };
}
