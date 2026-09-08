import {
  modelConfigurationSchema,
  type ManagedSessionContext,
  type WorkerCommand,
} from "@cantrip/protocol";

import type { createModelRoutingRuntime } from "../app/runtime/model-routing-runtime.js";
import { effectivePermissionProfile } from "../chats/execution-helpers.js";
import type {
  ChatExecutionContext,
  ModelRuntime,
  ServerRepository,
} from "../db/repository.js";
import type { WorkerCommandBus } from "../workers/bridge.js";

export type ManagedConsoleRouting = Pick<
  ReturnType<typeof createModelRoutingRuntime>,
  "routePairsForConfiguration"
>;

/** Resolves one exact root/child profile without loading or configuring Codex. */
export async function resolveManagedSessionModelProfile(
  context: ChatExecutionContext,
  runtime: ModelRuntime,
  routePairsForConfiguration: ManagedConsoleRouting["routePairsForConfiguration"],
) {
  const configuration = modelConfigurationSchema.parse({
    ...context.modelConfiguration,
    modelId: runtime.model.id,
    reasoningEffort: context.reasoningEffort,
  });
  const [pair] = await routePairsForConfiguration(context, configuration, [
    runtime,
  ]);
  if (!pair) throw new Error("No provider route is currently available.");
  const child = pair.subagent?.runtime;
  return {
    runtime: pair.root.runtime,
    subagentDefaults: child
      ? { model: child.model, provider: child.provider }
      : null,
  };
}

export function managedConsoleSessionContext(
  context: ChatExecutionContext,
): ManagedSessionContext | undefined {
  if (context.experience !== "agent" || context.contextKind !== "project")
    return undefined;
  const common = {
    chatId: context.chatId,
    computerUseEnabled: context.computerUseEnabled === true,
  };
  return {
    ...common,
    contextKind: "project",
    projectId: context.projectId,
    worktreeId: context.worktreeId,
    rootKind: context.rootKind,
    scratchRootId: null,
  };
}

/** One console configuration path for creation, direct, relay and WorkerLink. */
export async function prepareManagedConsoleLaunch(
  context: ChatExecutionContext,
  runtime: ModelRuntime,
  dependencies: ManagedConsoleRouting & {
    ownerId: string;
    bridge: Pick<WorkerCommandBus, "request">;
    repository: Pick<
      ServerRepository,
      "listEffectiveMcpServers" | "setChatModel" | "updateChatRuntime"
    >;
  },
): Promise<
  Extract<
    Extract<WorkerCommand, { type: "terminal.open" }>["launch"],
    { type: "codex" }
  >
> {
  if (context.contextKind === "standalone") {
    throw new Error("Standalone Chats do not support linked Codex consoles.");
  }
  const { ownerId, bridge, repository, routePairsForConfiguration } =
    dependencies;
  const { runtime: root, subagentDefaults } =
    await resolveManagedSessionModelProfile(
      context,
      runtime,
      routePairsForConfiguration,
    );
  const session = managedConsoleSessionContext(context);
  const configurationFields = {
    model: root.model,
    provider: root.provider,
    subagentDefaults,
    planMode: context.planMode,
    permissionProfileId: effectivePermissionProfile(context).effectiveId,
    mcpServers: await repository.listEffectiveMcpServers(
      ownerId,
      context.projectId,
      context.workerId,
    ),
    ...(session ? { session } : {}),
  };
  let threadId = context.threadId;
  if (!threadId) {
    const result = (await bridge.request(context.workerId, {
      type: "chat.thread.ensure",
      cwd: context.cwd,
      threadId: null,
      ...configurationFields,
    })) as { threadId?: unknown };
    if (typeof result.threadId !== "string" || !result.threadId) {
      throw new Error("Codex did not return a console thread.");
    }
    threadId = result.threadId;
    await repository.setChatModel(ownerId, context.chatId, {
      modelId: root.model.id,
    });
    // No caller may spawn/attach a terminal until canonical binding succeeds.
    await repository.updateChatRuntime(
      context.chatId,
      context.workerId,
      context.worktreeId,
      threadId,
      root.routeId,
      "ready",
      root.provider.accountId,
    );
  }
  return { type: "codex", threadId, ...configurationFields };
}
