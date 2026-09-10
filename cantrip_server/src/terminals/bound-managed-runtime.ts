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
    },
  };
}
