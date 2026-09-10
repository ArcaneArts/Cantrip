import {
  nativeRuntimeHandoffConfigurationSchema,
  type NativeRuntimeHandoffState,
} from "@cantrip/protocol";
import type { ServerRepository } from "../db/repository.js";
import { NativeCommandError } from "../db/repository/native-command-errors.js";
import { effectivePermissionProfile } from "../chats/execution-helpers.js";
import {
  managedConsoleSessionContext,
  resolveManagedSessionModelProfile,
  type ManagedConsoleRouting,
} from "./managed-session.js";

type Dependencies = ManagedConsoleRouting & {
  repository: Pick<
    ServerRepository,
    | "getChatExecutionContext"
    | "getModelRuntimeByRoute"
    | "listModelProviderAccountRuntimes"
    | "listEffectiveMcpServers"
  >;
};

/** The worker asks again on recovery. Only configured identity is required here;
 * native initialization, not cached availability/quota flags, decides usability. */
export async function runtimeHandoffConfiguration(
  ownerId: string,
  state: NativeRuntimeHandoffState,
  side: "source" | "destination",
  dependencies: Dependencies,
) {
  const { repository } = dependencies;
  if (
    ["completed", "cancelled"].includes(state.phase) ||
    (side === "source" && state.phase === "committed")
  )
    throw new NativeCommandError("handoff-phase-conflict");
  const context = await repository.getChatExecutionContext(
    ownerId,
    state.chatId,
  );
  if (
    !context ||
    context.contextKind !== "project" ||
    context.experience !== "agent" ||
    context.workerId !== state.workerId ||
    context.threadId !== state.source.threadId ||
    context.projectId !== state.source.projectId ||
    context.worktreeId !== state.source.placementId
  )
    throw new NativeCommandError("handoff-source-replaced");
  const routeId =
    side === "source" ? state.source.modelRouteId : state.targetModelRouteId;
  const accountId =
    side === "source"
      ? state.source.providerAccountId
      : state.targetProviderAccountId;
  let runtime = routeId
    ? await repository.getModelRuntimeByRoute(ownerId, routeId)
    : null;
  if (!runtime) throw new NativeCommandError("handoff-route-unavailable");
  if (runtime.provider.kind === "chatgpt" || runtime.provider.kind === "grok") {
    const account = (
      await repository.listModelProviderAccountRuntimes(
        ownerId,
        runtime.provider.id,
        state.workerId,
        null,
      )
    ).find((candidate) => candidate.accountId === accountId);
    if (!account || !account.enabled)
      throw new NativeCommandError("handoff-target-account-mismatch");
    runtime = {
      ...runtime,
      provider: {
        ...runtime.provider,
        accountId: account.accountId,
        credentialHomeKey: account.credentialHomeKey,
      },
    };
  } else if (accountId !== null) {
    throw new NativeCommandError("handoff-target-account-mismatch");
  }
  const { runtime: root, subagentDefaults } =
    await resolveManagedSessionModelProfile(
      context,
      runtime,
      dependencies.routePairsForConfiguration,
    );
  // The general child-profile resolver must not substitute the requested root account.
  if (
    root.routeId !== routeId ||
    root.provider.id !== runtime.provider.id ||
    (root.provider.accountId ?? null) !== accountId
  )
    throw new NativeCommandError("handoff-route-replaced");
  return nativeRuntimeHandoffConfigurationSchema.parse({
    state,
    side,
    configuration: {
      session: managedConsoleSessionContext(context),
      threadId: state.source.threadId,
      cwd: context.cwd,
      model: root.model,
      provider: root.provider,
      subagentDefaults,
      permissionProfileId: effectivePermissionProfile(context).effectiveId,
      planMode: context.planMode,
      mcpServers: await repository.listEffectiveMcpServers(
        ownerId,
        context.projectId,
        context.workerId,
      ),
    },
  });
}
