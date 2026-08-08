import { randomUUID } from "node:crypto";

import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import {
  agentWorktreeToolCallSchema,
  agentWorktreeToolResultSchema,
  agentThreadSyncSchema,
  agentTurnResultSchema,
  browserCreateSchema,
  browserListSchema,
  browserSummarySchema,
  browserUpdateSchema,
  codexAuthStatusSchema,
  codexDeviceLoginSchema,
  chatCompactAcceptedSchema,
  chatInterruptAcceptedSchema,
  chatCreateSchema,
  chatExecutionLaneListSchema,
  chatExecutionLaneReleaseSchema,
  chatForkSchema,
  chatListSchema,
  chatMessageCreateSchema,
  chatMessageListSchema,
  chatMessageSchema,
  chatModelUpdateSchema,
  chatPromptSteerResultSchema,
  chatPromptSubmitResultSchema,
  chatSummarySchema,
  chatTurnCreateSchema,
  chatUpdateSchema,
  chatWorktreeUpdateSchema,
  explorerCreateSchema,
  explorerDirectorySchema,
  explorerFileSchema,
  explorerListSchema,
  explorerSummarySchema,
  explorerUpdateSchema,
  githubAuthStatusSchema,
  githubIssueCloseSchema,
  githubIssueCommentCreateSchema,
  githubIssueDetailSchema,
  githubIssueListSchema,
  githubIssueStateSchema,
  githubProjectCreateSchema,
  githubRepositoryListSchema,
  githubWorkerRepositoryListSchema,
  gitActionResultSchema,
  gitActionSchema,
  gitHistorySchema,
  gitStatusSchema,
  modelProfileCreateSchema,
  modelProfileSummarySchema,
  modelProfileUpdateSchema,
  modelProviderCreateSchema,
  modelProviderSummarySchema,
  modelProviderUpdateSchema,
  mentionedSkillNames,
  orderedIdsSchema,
  projectCloneResultSchema,
  projectListSchema,
  projectRemoveSchema,
  projectSummarySchema,
  projectWorktreeCreateSchema,
  projectWorktreeListSchema,
  projectWorktreeLockSchema,
  projectWorktreePolicyUpdateSchema,
  projectWorktreePruneSchema,
  projectWorktreeRemoveSchema,
  projectWorktreeSummarySchema,
  projectViewCreateSchema,
  projectViewListSchema,
  projectViewSummarySchema,
  projectViewUpdateSchema,
  queuedPromptCreateSchema,
  queuedPromptListSchema,
  queuedPromptOrderSchema,
  queuedPromptSchema,
  queuedPromptUpdateSchema,
  remoteDesktopCreateSchema,
  remoteDesktopListSchema,
  remoteDesktopSummarySchema,
  remoteSurfaceAttachResultSchema,
  remoteSurfaceConnectionMessageSchema,
  remoteSurfaceCreateSchema,
  remoteSurfaceListSchema,
  remoteSurfaceSummarySchema,
  remoteSurfaceUpdateSchema,
  remoteSurfaceViewportSchema,
  remoteVncProbeResultSchema,
  remoteVncSecretResultSchema,
  serverBootstrapSchema,
  settingsBundleSchema,
  skillListSchema,
  systemHealthSchema,
  terminalClientMessageSchema,
  terminalCreateSchema,
  terminalListSchema,
  terminalOpenResultSchema,
  terminalServerMessageSchema,
  terminalSummarySchema,
  terminalUpdateSchema,
  userSettingsUpdateSchema,
  workerHeartbeatSchema,
  workerListSchema,
  worktreeCreateResultSchema,
  worktreeInventorySchema,
  worktreeMutationResultSchema,
  worktreePruneResultSchema,
  worktreeRemoveResultSchema,
  worktreeSelectionSchema,
  worktreeStatusResultSchema,
} from "@cantrip/protocol";
import Fastify from "fastify";
import type { ChatMessage, ChatTurnCreate } from "@cantrip/protocol";
import type {
  AgentWorktreeToolCall,
  AgentWorktreeToolResult,
} from "@cantrip/protocol";

import type { ServerConfig } from "./config.js";
import type { DatabaseConnection } from "./db/index.js";
import {
  ExecutionLaneConflictError,
  LOCAL_USER_ID,
  type ChatExecutionContext,
  type ModelRuntime,
} from "./db/repository.js";
import {
  WorkerBridge,
  type WorkerCommandBus,
  WorkerUnavailableError,
} from "./workers/bridge.js";
import { RemoteSurfaceRelay } from "./remote-surfaces/relay.js";
import { createRemoteSurfaceWebRtcConfiguration } from "./remote-surfaces/webrtc.js";

export interface BuildAppOptions {
  config: ServerConfig;
  database: DatabaseConnection;
  logger?: boolean;
  workerBridge?: WorkerCommandBus;
}

function invalidBody(issues: unknown) {
  return { error: "Invalid request body", issues };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredToolString(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required.`);
  }
  return value.trim();
}

function optionalToolString(
  input: Record<string, unknown>,
  key: string,
): string | null {
  const value = input[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${key} must be a string.`);
  return value.trim() || null;
}

const ROUTE_FAILURE_COOLDOWN_MS = 60_000;

function canFailOverRoute(error: unknown): boolean {
  return /(quota|usage limit|rate.?limit|\b429\b|unauthori[sz]ed|\b401\b|forbidden|\b403\b|authentication|credentials|model.+(?:not found|unavailable)|\b404\b|timed? out|timeout|ECONN|connection|network|socket|\b5\d\d\b|service unavailable|overloaded)/i.test(
    errorMessage(error),
  );
}

function continuationPrompt(messages: ChatMessage[], prompt: string): string {
  if (messages.length === 0) return prompt;
  const transcript = messages
    .slice(-100)
    .map((message) => {
      const content = message.content
        .flatMap((item) => {
          if (item.type === "text") return [item.text];
          if (item.activity.type === "command") {
            return [`[command: ${item.activity.command}]`];
          }
          if (item.activity.type === "worktree") {
            return [`[worktree: ${item.activity.summary}]`];
          }
          return [
            `[files: ${item.activity.changes.map((change) => change.path).join(", ")}]`,
          ];
        })
        .join("\n");
      return `${message.role.toUpperCase()}: ${content}`;
    })
    .join("\n\n");
  return `Continue this existing Cantrip conversation. The server-owned history follows:\n\n${transcript}\n\nUSER: ${prompt}`;
}

export async function buildApp({
  config,
  database,
  logger = true,
  workerBridge,
}: BuildAppOptions) {
  const app = Fastify({ logger });
  const bridge = workerBridge ?? new WorkerBridge();
  const surfaceRelay = new RemoteSurfaceRelay(bridge);
  const repository = database.repository;
  const [serverId, currentUser] = await Promise.all([
    repository.getOrCreateServerId(),
    repository.ensureLocalIdentity(),
  ]);
  await repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    config.agentModel,
    config.ollamaBaseUrl,
  );
  await repository.ensureBrowserRemoteSurfaces(LOCAL_USER_ID);
  await repository.resetTransientRemoteSurfaceStatuses();
  await repository.resetInterruptedChatExecutions();

  await app.register(cors, {
    credentials: true,
    origin: config.appOrigins,
  });
  await app.register(websocket);

  const dispatchingChats = new Set<string>();
  const pendingQueueDispatches = new Set<string>();
  const progressingWorktreeTransitions = new Set<string>();
  const projectSetupTasks = new Set<Promise<void>>();
  const routeCooldowns = new Map<string, number>();
  const surfaceAttachmentCounts = new Map<string, number>();
  const worktreeMutationQueues = new Map<string, Promise<void>>();

  const serializeWorktreeMutation = async <T>(
    projectId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const previous = worktreeMutationQueues.get(projectId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    worktreeMutationQueues.set(projectId, settled);
    try {
      return await current;
    } finally {
      if (worktreeMutationQueues.get(projectId) === settled) {
        worktreeMutationQueues.delete(projectId);
      }
    }
  };

  const createAgentWorktree = async (
    projectId: string,
    input: Record<string, unknown>,
  ) => {
    const name = requiredToolString(input, "name");
    const intent = requiredToolString(input, "intent");
    const branch = optionalToolString(input, "branch");
    const baseRevision = optionalToolString(input, "baseRevision");
    const mode =
      intent === "newBranch"
        ? {
            type: "newBranch" as const,
            branch: branch ?? requiredToolString(input, "branch"),
            startPoint: baseRevision,
          }
        : intent === "existingBranch"
          ? {
              type: "existingBranch" as const,
              branch: branch ?? requiredToolString(input, "branch"),
            }
          : intent === "detached"
            ? {
                type: "detached" as const,
                revision:
                  baseRevision ?? requiredToolString(input, "baseRevision"),
              }
            : (() => {
                throw new Error(
                  "intent must be newBranch, existingBranch, or detached.",
                );
              })();
    return serializeWorktreeMutation(projectId, async () => {
      const source = await repository.getProjectSource(
        LOCAL_USER_ID,
        projectId,
      );
      if (!source) throw new Error("Project source not found.");
      const worktreeId = randomUUID();
      const result = worktreeCreateResultSchema.parse(
        await bridge.request(source.workerId, {
          type: "worktree.create",
          sourcePath: source.cwd,
          worktreeId,
          name,
          mode,
        }),
      );
      const reconciled = await repository.reconcileProjectWorktrees(
        LOCAL_USER_ID,
        projectId,
        result.inventory,
        { id: worktreeId, name, origin: "agent", path: result.worktree.path },
      );
      const created = reconciled?.find(({ id }) => id === worktreeId);
      if (!created)
        throw new Error("Created worktree could not be reconciled.");
      return created;
    });
  };

  const executeAgentWorktreeTool = async (
    call: AgentWorktreeToolCall,
  ): Promise<AgentWorktreeToolResult> => {
    const context = await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      call.chatId,
    );
    if (!context) throw new Error("Chat execution context not found.");
    if (
      context.workerId !== call.workerId ||
      context.executionLaneId !== call.executionLaneId ||
      context.status !== "running"
    ) {
      throw new ExecutionLaneConflictError(
        "The worktree tool call did not originate from the active chat lane.",
      );
    }
    const worktrees = () =>
      repository.listProjectWorktrees(LOCAL_USER_ID, context.projectId);
    const worktreeContext = async (worktreeId: string) => {
      const target = await repository.getProjectWorktreeContext(
        LOCAL_USER_ID,
        context.projectId,
        worktreeId,
      );
      if (!target) throw new Error("Worktree not found.");
      return target;
    };
    const schedule = async (
      worktreeId: string,
      transitionKind: "switch" | "release",
      purpose: string,
    ) => {
      const pending = await repository.scheduleChatWorktreeTransition(
        LOCAL_USER_ID,
        context.chatId,
        call.executionLaneId,
        worktreeId,
        transitionKind,
        purpose,
      );
      if (!pending) throw new Error("Target worktree is not ready.");
      return pending;
    };

    switch (call.tool) {
      case "cantrip_worktrees_list": {
        const [items, leases] = await Promise.all([
          worktrees(),
          repository.listProjectExecutionLanes(
            LOCAL_USER_ID,
            context.projectId,
          ),
        ]);
        return agentWorktreeToolResultSchema.parse({
          summary: `Found ${items.length} validated worktree${items.length === 1 ? "" : "s"}.`,
          worktreeId: context.worktreeId,
          data: {
            currentWorktreeId: context.worktreeId,
            worktrees: items,
            leases,
          },
        });
      }
      case "cantrip_worktree_status": {
        const worktreeId =
          optionalToolString(call.arguments, "worktreeId") ??
          context.worktreeId;
        const target = await worktreeContext(worktreeId);
        const status = worktreeStatusResultSchema.parse(
          await bridge.request(target.workerId, {
            type: "worktree.status",
            sourcePath: target.sourcePath,
            worktreePath: target.worktree.path,
          }),
        );
        return agentWorktreeToolResultSchema.parse({
          summary: `${target.worktree.name} is ${status.status.files.length ? "dirty" : "clean"} on ${status.status.branch || "detached HEAD"}.`,
          worktreeId,
          data: status,
        });
      }
      case "cantrip_worktree_create": {
        const created = await createAgentWorktree(
          context.projectId,
          call.arguments,
        );
        return agentWorktreeToolResultSchema.parse({
          summary: `Created ${created.name} on ${created.branch ?? "detached HEAD"}.`,
          worktreeId: created.id,
          data: created,
        });
      }
      case "cantrip_worktree_acquire": {
        if (context.worktreeMode === "pinned") {
          throw new Error(
            "This chat is pinned. Return it to Agent managed before acquiring another worktree.",
          );
        }
        const created = await createAgentWorktree(
          context.projectId,
          call.arguments,
        );
        const pending = await schedule(
          created.id,
          "switch",
          requiredToolString(call.arguments, "purpose"),
        );
        return agentWorktreeToolResultSchema.parse({
          summary: `Created ${created.name}; continuation is scheduled in that worktree. Finish this turn now.`,
          worktreeId: created.id,
          continuationScheduled: true,
          data: { worktree: created, lane: pending.lane },
        });
      }
      case "cantrip_worktree_switch": {
        const worktreeId = requiredToolString(call.arguments, "worktreeId");
        const pending = await schedule(
          worktreeId,
          "switch",
          requiredToolString(call.arguments, "purpose"),
        );
        return agentWorktreeToolResultSchema.parse({
          summary: `Continuation is scheduled in ${pending.worktree.name}. Finish this turn now.`,
          worktreeId,
          continuationScheduled: true,
          data: { lane: pending.lane, worktree: pending.worktree },
        });
      }
      case "cantrip_worktree_release": {
        const currentTarget = await worktreeContext(context.worktreeId);
        if (currentTarget.worktree.isPrimary) {
          throw new Error(
            "Primary does not have a releasable secondary lease.",
          );
        }
        const currentStatus = worktreeStatusResultSchema.parse(
          await bridge.request(currentTarget.workerId, {
            type: "worktree.status",
            sourcePath: currentTarget.sourcePath,
            worktreePath: currentTarget.worktree.path,
          }),
        );
        if (currentStatus.status.files.length > 0) {
          throw new Error(
            "The current worktree is dirty. Commit or restore its changes before releasing it.",
          );
        }
        const primary = (await worktrees()).find(({ isPrimary }) => isPrimary);
        if (!primary) throw new Error("Primary worktree not found.");
        const pending = await schedule(
          primary.id,
          "release",
          requiredToolString(call.arguments, "purpose"),
        );
        return agentWorktreeToolResultSchema.parse({
          summary: `Release is scheduled; continuation will return to ${primary.name}. Finish this turn now.`,
          worktreeId: primary.id,
          continuationScheduled: true,
          data: { lane: pending.lane, worktree: pending.worktree },
        });
      }
      case "cantrip_worktree_remove": {
        const worktreeId = requiredToolString(call.arguments, "worktreeId");
        const target = await worktreeContext(worktreeId);
        if (target.worktree.isPrimary) {
          throw new Error("Primary cannot be removed as a worktree.");
        }
        if (target.worktree.origin !== "agent") {
          throw new Error(
            "Agents may remove only agent-created worktrees; user and external worktrees require explicit user authorization.",
          );
        }
        if (context.worktreeId === worktreeId) {
          throw new Error("Release or switch away from this worktree first.");
        }
        const blockers = await repository.getWorktreeRemovalBlockers(
          LOCAL_USER_ID,
          context.projectId,
          worktreeId,
        );
        if (
          blockers &&
          (blockers.activeChatIds.length ||
            blockers.activeLeaseChatIds.length ||
            blockers.runningTerminalIds.length)
        ) {
          throw new Error(
            "The worktree is still used by a chat, lease, or terminal.",
          );
        }
        const status = worktreeStatusResultSchema.parse(
          await bridge.request(target.workerId, {
            type: "worktree.status",
            sourcePath: target.sourcePath,
            worktreePath: target.worktree.path,
          }),
        );
        if (status.status.files.length > 0) {
          throw new Error("Dirty worktrees cannot be removed by an agent.");
        }
        const removed = await serializeWorktreeMutation(
          context.projectId,
          async () => {
            const result = worktreeRemoveResultSchema.parse(
              await bridge.request(target.workerId, {
                type: "worktree.remove",
                sourcePath: target.sourcePath,
                worktreePath: target.worktree.path,
                force: false,
                allowExternal: false,
              }),
            );
            await repository.reconcileProjectWorktrees(
              LOCAL_USER_ID,
              context.projectId,
              result.inventory,
            );
            return result;
          },
        );
        return agentWorktreeToolResultSchema.parse({
          summary: `Removed ${target.worktree.name}; its Git branch was retained.`,
          worktreeId,
          data: removed,
        });
      }
    }
  };

  const queueProjectSetup = (
    projectId: string,
    input: {
      nameWithOwner: string;
      workerId: string;
    },
  ) => {
    const task = (async () => {
      try {
        const clone = projectCloneResultSchema.parse(
          await bridge.request(
            input.workerId,
            {
              type: "project.clone",
              repository: { nameWithOwner: input.nameWithOwner },
            },
            { timeoutMs: null },
          ),
        );
        await repository.completeGithubProjectSetup(
          LOCAL_USER_ID,
          projectId,
          input.workerId,
          clone,
        );
      } catch (error) {
        const message =
          errorMessage(error).trim().slice(0, 4_000) ||
          "Repository setup failed.";
        try {
          await repository.failGithubProjectSetup(
            LOCAL_USER_ID,
            projectId,
            message,
          );
        } catch (persistenceError) {
          app.log.error(
            { error: persistenceError, projectId },
            "Could not record failed project setup",
          );
        }
      }
    })();
    projectSetupTasks.add(task);
    void task.finally(() => projectSetupTasks.delete(task));
  };

  const resolveModelId = async (
    context: ChatExecutionContext,
    requestedModelId?: string,
  ): Promise<string> => {
    const defaultModelId = context.modelId
      ? null
      : (await repository.getSettings(LOCAL_USER_ID)).preferences
          .defaultModelId;
    const modelId = requestedModelId ?? context.modelId ?? defaultModelId;
    if (!modelId) {
      throw new Error(
        "Choose a model or configure a default model in Settings.",
      );
    }
    return modelId;
  };

  const availableModelRuntimes = async (
    context: ChatExecutionContext,
    modelId: string,
  ): Promise<ModelRuntime[]> => {
    const runtimes = await repository.getModelRuntimes(LOCAL_USER_ID, modelId);
    if (!runtimes.length) {
      throw new Error("The selected model has no enabled provider routes.");
    }
    const now = Date.now();
    const available: ModelRuntime[] = [];
    const unavailable: string[] = [];
    for (const runtime of runtimes) {
      const cooldownUntil = routeCooldowns.get(runtime.routeId) ?? 0;
      if (cooldownUntil > now) {
        unavailable.push(`${runtime.provider.name} is cooling down`);
        continue;
      }
      if (runtime.provider.kind === "chatgpt") {
        try {
          const status = codexAuthStatusSchema.parse(
            await bridge.request(context.workerId, {
              type: "codex.auth.status",
              providerId: runtime.provider.id,
            }),
          );
          if (!status.authenticated || status.authMode !== "chatgpt") {
            unavailable.push(`${runtime.provider.name} is not signed in`);
            continue;
          }
          if ((status.weeklyUsage?.usedPercent ?? 0) >= 100) {
            unavailable.push(
              `${runtime.provider.name} has no weekly usage left`,
            );
            continue;
          }
        } catch (error) {
          app.log.warn(
            { err: error, providerId: runtime.provider.id },
            "Could not preflight ChatGPT route; attempting it directly",
          );
        }
      }
      available.push(runtime);
    }
    if (!available.length) {
      throw new Error(
        `No provider route is currently available${unavailable.length ? `: ${unavailable.join("; ")}` : "."}`,
      );
    }
    return available;
  };

  const runtimeForContext = async (
    context: ChatExecutionContext,
  ): Promise<ModelRuntime | null> => {
    if (context.modelRouteId) {
      const active = await repository.getModelRuntimeByRoute(
        LOCAL_USER_ID,
        context.modelRouteId,
      );
      if (active) return active;
    }
    const modelId = await resolveModelId(context);
    return repository.getModelRuntime(LOCAL_USER_ID, modelId);
  };

  const continuePendingWorktreeTransition = async (
    chatId: string,
  ): Promise<boolean> => {
    if (progressingWorktreeTransitions.has(chatId)) return true;
    progressingWorktreeTransitions.add(chatId);
    try {
      const pending = await repository.getPendingChatWorktreeTransition(
        LOCAL_USER_ID,
        chatId,
      );
      if (!pending) return false;
      const current = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        chatId,
      );
      if (!current || current.status === "running") return true;
      if (!bridge.isConnected(pending.worktree.workerId)) return true;

      try {
        const modelId = await resolveModelId(current);
        await availableModelRuntimes(current, modelId);
      } catch (error) {
        app.log.error(
          { chatId, err: error },
          "Could not prepare a pending worktree continuation",
        );
        return true;
      }

      if (pending.lane.transitionKind === "release") {
        const source = await repository.getProjectWorktreeContext(
          LOCAL_USER_ID,
          current.projectId,
          current.worktreeId,
        );
        if (!source) return true;
        try {
          const status = worktreeStatusResultSchema.parse(
            await bridge.request(source.workerId, {
              type: "worktree.status",
              sourcePath: source.sourcePath,
              worktreePath: source.worktree.path,
            }),
          );
          if (status.status.files.length > 0) {
            await repository.cancelChatWorktreeTransition(
              LOCAL_USER_ID,
              chatId,
              pending.lane.id,
            );
            await repository.appendMessage(LOCAL_USER_ID, chatId, {
              role: "system",
              content: [
                {
                  type: "text",
                  text: "Worktree release was cancelled because new uncommitted changes appeared before the turn finished.",
                },
              ],
              idempotencyKey: `transition-cancelled:${pending.lane.id}`,
            });
            return false;
          }
        } catch (error) {
          app.log.error(
            { chatId, err: error },
            "Could not verify a pending worktree release",
          );
          return true;
        }
      }
      const applied = await repository.applyChatWorktreeTransition(
        LOCAL_USER_ID,
        chatId,
        pending.lane.id,
      );
      if (!applied) return true;
      const next = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        chatId,
      );
      if (!next) return true;
      const transitionText =
        applied.transitionKind === "release"
          ? `Returned to Primary after releasing the previous worktree. Continue the user's request from this checkout.`
          : `Continued in ${applied.worktree.name}${applied.worktree.branch ? ` (${applied.worktree.branch})` : ""}. Continue the user's request from this checkout.`;
      try {
        await beginTurn(
          next,
          {
            text: transitionText,
            idempotencyKey: `worktree-continuation:${pending.lane.id}`,
          },
          {
            acquiringActor: "agent",
            messageRole: "system",
            purpose: `Controlled ${applied.transitionKind} continuation`,
          },
        );
      } catch (error) {
        app.log.error(
          { chatId, err: error },
          "Could not start a worktree continuation",
        );
        await repository.appendMessage(
          LOCAL_USER_ID,
          chatId,
          {
            role: "system",
            content: [
              {
                type: "text",
                text: `The chat moved to ${applied.worktree.name}, but its automatic continuation could not start: ${errorMessage(error)}`,
              },
            ],
            idempotencyKey: `worktree-continuation-error:${pending.lane.id}`,
          },
          {
            executionLaneId: pending.lane.id,
            worktreeId: applied.worktree.id,
          },
        );
      }
      return true;
    } finally {
      progressingWorktreeTransitions.delete(chatId);
    }
  };

  const resumePendingWorktreeTransitionsForWorker = async (
    workerId: string,
  ): Promise<void> => {
    if (!bridge.isConnected(workerId)) return;
    const chatIds = await repository.listPendingWorktreeTransitionChatIds(
      LOCAL_USER_ID,
      workerId,
    );
    await Promise.allSettled(
      chatIds.map(async (chatId) => {
        try {
          await continuePendingWorktreeTransition(chatId);
        } catch (error) {
          app.log.error(
            { chatId, err: error, workerId },
            "Could not recover a pending worktree transition",
          );
        }
      }),
    );
  };

  const dispatchNextQueuedPrompt = async (chatId: string): Promise<void> => {
    if (dispatchingChats.has(chatId)) {
      pendingQueueDispatches.add(chatId);
      return;
    }
    dispatchingChats.add(chatId);
    try {
      let context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        chatId,
      );
      if (!context || context.status === "running") return;
      const prompt = (
        await repository.listQueuedPrompts(LOCAL_USER_ID, chatId)
      ).find((candidate) => !candidate.frozen);
      if (!prompt) return;
      if (prompt.worktreeId && prompt.worktreeId !== context.worktreeId) {
        await repository.updateChatWorktree(LOCAL_USER_ID, chatId, {
          worktreeId: prompt.worktreeId,
          mode: context.worktreeMode,
        });
        context = await repository.getChatExecutionContext(
          LOCAL_USER_ID,
          chatId,
        );
        if (!context) return;
      }
      await beginTurn(context, {
        text: prompt.text,
        modelId: prompt.modelId,
        idempotencyKey: `queue:${prompt.id}`,
      });
      await repository.deleteQueuedPrompt(LOCAL_USER_ID, prompt.id);
    } catch (error) {
      app.log.error({ chatId, err: error }, "Queued prompt dispatch failed");
    } finally {
      dispatchingChats.delete(chatId);
      if (pendingQueueDispatches.delete(chatId)) {
        void dispatchNextQueuedPrompt(chatId);
      }
    }
  };

  async function beginTurn(
    context: ChatExecutionContext,
    input: ChatTurnCreate,
    options: {
      acquiringActor?: "agent" | "user";
      messageRole?: "system" | "user";
      purpose?: string;
    } = {},
  ): Promise<ChatMessage> {
    if (!bridge.isConnected(context.workerId)) {
      throw new Error("Project worker is offline.");
    }
    const modelId = await resolveModelId(context, input.modelId);
    const runtimes = await availableModelRuntimes(context, modelId);
    const execution = await repository.startChatExecutionLane(
      LOCAL_USER_ID,
      context.chatId,
      options.acquiringActor ?? "user",
      options.purpose ?? "Chat turn",
    );
    if (!execution || !execution.executionLaneId) {
      throw new Error("Chat execution lane could not be acquired.");
    }
    const executionLaneId = execution.executionLaneId;
    const attribution = {
      executionLaneId,
      worktreeId: execution.worktreeId,
    };
    let priorMessages: ChatMessage[];
    let userMessage: ChatMessage;
    try {
      priorMessages = await repository.listMessages(
        LOCAL_USER_ID,
        execution.chatId,
      );
      const appended = await repository.appendMessage(
        LOCAL_USER_ID,
        execution.chatId,
        {
          role: options.messageRole ?? "user",
          content: [{ type: "text", text: input.text }],
          idempotencyKey: input.idempotencyKey,
        },
        attribution,
      );
      if (!appended) throw new Error("Chat not found.");
      userMessage = appended;
      await repository.setMessageModelRoute(
        userMessage.id,
        modelId,
        runtimes[0]!,
      );
      await repository.setChatModel(LOCAL_USER_ID, execution.chatId, {
        modelId,
      });
    } catch (error) {
      await repository.finishChatExecutionLane(
        execution.chatId,
        executionLaneId,
        "failed",
      );
      throw error;
    }

    void (async () => {
      let anyActivity = false;
      try {
        for (const [index, runtime] of runtimes.entries()) {
          let attemptActivity = false;
          const canResume = runtime.routeId === execution.modelRouteId;
          const threadId = canResume ? execution.threadId : null;
          const workerPrompt = threadId
            ? input.text
            : continuationPrompt(priorMessages, input.text);
          await repository.setMessageModelRoute(
            userMessage.id,
            modelId,
            runtime,
          );
          await repository.updateChatRuntime(
            execution.chatId,
            execution.workerId,
            execution.worktreeId,
            threadId,
            runtime.routeId,
            "starting",
          );
          try {
            const rawResult = await bridge.request(
              execution.workerId,
              {
                type: "chat.turn",
                chatId: execution.chatId,
                clientMessageId: userMessage.id,
                cwd: execution.cwd,
                executionLaneId,
                worktreeId: execution.worktreeId,
                threadId,
                prompt: workerPrompt,
                skillNames: mentionedSkillNames(input.text),
                model: runtime.model,
                provider: runtime.provider,
              },
              {
                timeoutMs: null,
                onEvent: async (event) => {
                  if (event.type !== "agent.activity") return;
                  attemptActivity = true;
                  anyActivity = true;
                  await repository.upsertMessage(
                    LOCAL_USER_ID,
                    execution.chatId,
                    {
                      role: "assistant",
                      content: [{ type: "activity", activity: event.activity }],
                      idempotencyKey:
                        event.activity.type === "worktree"
                          ? event.activity.id
                          : `activity:${userMessage.id}:${event.activity.id}`,
                    },
                    attribution,
                  );
                },
              },
            );
            const result = agentTurnResultSchema.parse(rawResult);
            routeCooldowns.delete(runtime.routeId);
            await repository.updateChatRuntime(
              execution.chatId,
              execution.workerId,
              execution.worktreeId,
              result.threadId,
              runtime.routeId,
            );
            await repository.appendMessage(
              LOCAL_USER_ID,
              execution.chatId,
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text:
                      result.text || "The agent completed without a message.",
                  },
                ],
                idempotencyKey: `assistant:${userMessage.id}`,
              },
              attribution,
            );
            await repository.finishChatExecutionLane(
              execution.chatId,
              executionLaneId,
              "idle",
            );
            if (!(await continuePendingWorktreeTransition(execution.chatId))) {
              void dispatchNextQueuedPrompt(execution.chatId);
            }
            return;
          } catch (error) {
            const canRetry =
              !attemptActivity &&
              canFailOverRoute(error) &&
              index < runtimes.length - 1;
            if (!canRetry) throw error;
            routeCooldowns.set(
              runtime.routeId,
              Date.now() + ROUTE_FAILURE_COOLDOWN_MS,
            );
            app.log.warn(
              {
                chatId: execution.chatId,
                err: error,
                providerId: runtime.provider.id,
                routeId: runtime.routeId,
              },
              "Provider route failed before activity; trying the next route",
            );
          }
        }
      } catch (error: unknown) {
        if (!anyActivity && execution.modelRouteId) {
          await repository.updateChatRuntime(
            execution.chatId,
            execution.workerId,
            execution.worktreeId,
            execution.threadId,
            execution.modelRouteId,
          );
        }
        const interrupted = /interrupted/i.test(errorMessage(error));
        app.log.error(
          { chatId: execution.chatId, err: error },
          "Agent turn failed",
        );
        await repository.appendMessage(
          LOCAL_USER_ID,
          execution.chatId,
          {
            role: "system",
            content: [
              {
                type: "text",
                text: interrupted
                  ? "Turn interrupted."
                  : `Agent failed: ${errorMessage(error)}`,
              },
            ],
            idempotencyKey: `error:${userMessage.id}`,
          },
          attribution,
        );
        await repository.finishChatExecutionLane(
          execution.chatId,
          executionLaneId,
          interrupted ? "idle" : "failed",
        );
        if (!(await continuePendingWorktreeTransition(execution.chatId))) {
          void dispatchNextQueuedPrompt(execution.chatId);
        }
      }
    })();

    const firstRuntime = runtimes[0]!;
    return {
      ...userMessage,
      modelId,
      modelRouteId: firstRuntime.routeId,
      providerId: firstRuntime.provider.id,
      providerName: firstRuntime.provider.name,
      providerModelName: firstRuntime.model.name,
    };
  }

  app.get("/api", async () => ({
    name: "cantrip_server",
    version: "0.0.0",
  }));

  app.get("/api/bootstrap", async (_request, reply) => {
    return reply.send(
      serverBootstrapSchema.parse({
        protocolVersion: 1,
        server: {
          id: serverId,
          deploymentMode: config.deploymentMode,
          bootstrapMode: config.bootstrapMode,
        },
        auth: {
          mode: config.authMode,
          currentUser,
        },
        routing: {
          workerConnection: "server-only",
          directWorkerConnections: false,
        },
        storage: {
          conversations: "server",
          files: "worker",
        },
        agent: {
          model: config.agentModel,
          modelProvider: config.agentModelProvider,
        },
        capabilities: {
          accounts: false,
          passwordProtection: false,
          linkCodes: false,
          multipleWorkers: false,
          workerSwitching: false,
          gitSync: false,
          worktrees: false,
          remoteSurfaces: {
            enabled: true,
            transports: config.remoteSurfaceWebRtc
              ? ["websocket", "webrtc"]
              : ["websocket"],
            relayOnly: true,
          },
        },
      }),
    );
  });

  app.get("/api/health", { logLevel: "warn" }, async (_request, reply) => {
    await database.ping();
    return reply.send(
      systemHealthSchema.parse({
        status: "ok",
        service: "cantrip_server",
        database: { engine: database.engine, ready: true },
        workers: {
          connected: await repository.onlineWorkerCount(LOCAL_USER_ID),
        },
        timestamp: new Date().toISOString(),
      }),
    );
  });

  app.get("/api/workers", { logLevel: "warn" }, async (_request, reply) => {
    const workers = await repository.listWorkers(LOCAL_USER_ID);
    return reply.send(workerListSchema.parse(workers));
  });

  app.get<{ Querystring: { providerId?: string; workerId?: string } }>(
    "/api/codex/auth/status",
    async (request, reply) => {
      const { providerId, workerId } = request.query;
      if (!workerId || !providerId) {
        return reply
          .code(400)
          .send({ error: "workerId and providerId are required" });
      }
      const provider = await repository.getModelProvider(
        LOCAL_USER_ID,
        providerId,
      );
      if (provider?.kind !== "chatgpt") {
        return reply
          .code(404)
          .send({ error: "ChatGPT account provider not found." });
      }
      try {
        const status = codexAuthStatusSchema.parse(
          await bridge.request(workerId, {
            type: "codex.auth.status",
            providerId,
          }),
        );
        return reply.send(status);
      } catch (error) {
        return reply
          .code(error instanceof WorkerUnavailableError ? 503 : 502)
          .send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Body: { providerId?: string; workerId?: string } }>(
    "/api/codex/auth/device-login",
    async (request, reply) => {
      const { providerId, workerId } = request.body ?? {};
      if (!workerId || !providerId) {
        return reply
          .code(400)
          .send({ error: "workerId and providerId are required" });
      }
      const provider = await repository.getModelProvider(
        LOCAL_USER_ID,
        providerId,
      );
      if (provider?.kind !== "chatgpt") {
        return reply
          .code(404)
          .send({ error: "ChatGPT account provider not found." });
      }
      try {
        return reply.send(
          codexDeviceLoginSchema.parse(
            await bridge.request(workerId, {
              type: "codex.auth.login.start",
              providerId,
            }),
          ),
        );
      } catch (error) {
        return reply
          .code(error instanceof WorkerUnavailableError ? 503 : 502)
          .send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Body: { providerId?: string; workerId?: string } }>(
    "/api/codex/auth/logout",
    async (request, reply) => {
      const { providerId, workerId } = request.body ?? {};
      if (!workerId || !providerId) {
        return reply
          .code(400)
          .send({ error: "workerId and providerId are required" });
      }
      const provider = await repository.getModelProvider(
        LOCAL_USER_ID,
        providerId,
      );
      if (provider?.kind !== "chatgpt") {
        return reply
          .code(404)
          .send({ error: "ChatGPT account provider not found." });
      }
      try {
        await bridge.request(workerId, {
          type: "codex.auth.logout",
          providerId,
        });
        return reply.code(204).send();
      } catch (error) {
        return reply
          .code(error instanceof WorkerUnavailableError ? 503 : 502)
          .send({ error: errorMessage(error) });
      }
    },
  );

  app.get("/api/settings", async (_request, reply) => {
    return reply.send(
      settingsBundleSchema.parse(await repository.getSettings(LOCAL_USER_ID)),
    );
  });

  app.patch("/api/settings", async (request, reply) => {
    const input = userSettingsUpdateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    const settings = await repository.updateSettings(LOCAL_USER_ID, input.data);
    if (!settings) {
      return reply.code(400).send({ error: "Default model was not found." });
    }
    return reply.send(settingsBundleSchema.parse(settings));
  });

  app.post("/api/settings/providers", async (request, reply) => {
    const input = modelProviderCreateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    try {
      const provider = await repository.createModelProvider(
        LOCAL_USER_ID,
        input.data,
      );
      return reply.code(201).send(modelProviderSummarySchema.parse(provider));
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.delete<{ Params: { providerId: string } }>(
    "/api/settings/providers/:providerId",
    async (request, reply) => {
      try {
        const deleted = await repository.deleteModelProvider(
          LOCAL_USER_ID,
          request.params.providerId,
        );
        return deleted
          ? reply.code(204).send()
          : reply.code(404).send({ error: "Provider not found." });
      } catch {
        return reply.code(409).send({
          error: "Delete the provider's models before deleting the provider.",
        });
      }
    },
  );

  app.patch<{ Params: { providerId: string } }>(
    "/api/settings/providers/:providerId",
    async (request, reply) => {
      const input = modelProviderUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const provider = await repository.updateModelProvider(
          LOCAL_USER_ID,
          request.params.providerId,
          input.data,
        );
        return provider
          ? reply.send(modelProviderSummarySchema.parse(provider))
          : reply.code(404).send({ error: "Provider not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.post("/api/settings/models", async (request, reply) => {
    const input = modelProfileCreateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    try {
      const model = await repository.createModelProfile(
        LOCAL_USER_ID,
        input.data,
      );
      if (!model) {
        return reply.code(404).send({ error: "Provider not found." });
      }
      return reply.code(201).send(modelProfileSummarySchema.parse(model));
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.delete<{ Params: { modelId: string } }>(
    "/api/settings/models/:modelId",
    async (request, reply) => {
      try {
        const deleted = await repository.deleteModelProfile(
          LOCAL_USER_ID,
          request.params.modelId,
        );
        return deleted
          ? reply.code(204).send()
          : reply.code(404).send({ error: "Model not found." });
      } catch {
        return reply.code(409).send({
          error: "This model is the default or selected by an existing chat.",
        });
      }
    },
  );

  app.patch<{ Params: { modelId: string } }>(
    "/api/settings/models/:modelId",
    async (request, reply) => {
      const input = modelProfileUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const model = await repository.updateModelProfile(
          LOCAL_USER_ID,
          request.params.modelId,
          input.data,
        );
        return model
          ? reply.send(modelProfileSummarySchema.parse(model))
          : reply.code(404).send({ error: "Model or provider not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.get<{ Querystring: { workerId?: string } }>(
    "/api/github/status",
    async (request, reply) => {
      const workerId = request.query.workerId;
      if (!workerId) {
        return reply.code(400).send({ error: "workerId is required" });
      }
      try {
        const result = await bridge.request(workerId, {
          type: "github.auth.status",
        });
        return reply.send(githubAuthStatusSchema.parse(result));
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.get<{ Querystring: { login?: string; workerId?: string } }>(
    "/api/github/repositories/cache",
    async (request, reply) => {
      const workerId = request.query.workerId;
      const login = request.query.login;
      if (!workerId || !login) {
        return reply
          .code(400)
          .send({ error: "workerId and login are required" });
      }
      try {
        const workerRepositories = githubWorkerRepositoryListSchema.parse(
          await bridge.request(workerId, {
            type: "github.repositories.cached",
            login,
          }),
        );
        const imported =
          await repository.listGithubRepositoryIds(LOCAL_USER_ID);
        return reply.send(
          githubRepositoryListSchema.parse(
            workerRepositories.map((item) => ({
              ...item,
              imported: imported.has(item.id),
            })),
          ),
        );
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.get<{ Querystring: { workerId?: string } }>(
    "/api/github/repositories",
    async (request, reply) => {
      const workerId = request.query.workerId;
      if (!workerId) {
        return reply.code(400).send({ error: "workerId is required" });
      }
      try {
        const workerRepositories = githubWorkerRepositoryListSchema.parse(
          await bridge.request(workerId, {
            type: "github.repositories.list",
          }),
        );
        const imported =
          await repository.listGithubRepositoryIds(LOCAL_USER_ID);
        return reply.send(
          githubRepositoryListSchema.parse(
            workerRepositories.map((item) => ({
              ...item,
              imported: imported.has(item.id),
            })),
          ),
        );
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.get("/api/projects", async (_request, reply) => {
    const projects = await repository.listProjects(LOCAL_USER_ID);
    return reply.send(projectListSchema.parse(projects));
  });

  app.patch<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/worktree-policy",
    async (request, reply) => {
      const input = projectWorktreePolicyUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const project = await repository.updateProjectWorktreePolicy(
        LOCAL_USER_ID,
        request.params.projectId,
        input.data,
      );
      return project
        ? reply.send(projectSummarySchema.parse(project))
        : reply.code(404).send({ error: "Project not found." });
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/worktrees",
    async (request, reply) => {
      const worktrees = await repository.listProjectWorktrees(
        LOCAL_USER_ID,
        request.params.projectId,
      );
      if (worktrees.length === 0) {
        const source = await repository.getProjectSource(
          LOCAL_USER_ID,
          request.params.projectId,
        );
        if (!source) {
          return reply.code(404).send({ error: "Project source not found." });
        }
      }
      return reply.send(projectWorktreeListSchema.parse(worktrees));
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/worktrees/reconcile",
    async (request, reply) => {
      try {
        const worktrees = await serializeWorktreeMutation(
          request.params.projectId,
          async () => {
            const source = await repository.getProjectSource(
              LOCAL_USER_ID,
              request.params.projectId,
            );
            if (!source) return null;
            const inventory = worktreeInventorySchema.parse(
              await bridge.request(source.workerId, {
                type: "worktree.reconcile",
                sourcePath: source.cwd,
              }),
            );
            return repository.reconcileProjectWorktrees(
              LOCAL_USER_ID,
              request.params.projectId,
              inventory,
            );
          },
        );
        return worktrees
          ? reply.send(projectWorktreeListSchema.parse(worktrees))
          : reply.code(404).send({ error: "Project source not found." });
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/worktrees",
    async (request, reply) => {
      const input = projectWorktreeCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const created = await serializeWorktreeMutation(
          request.params.projectId,
          async () => {
            const source = await repository.getProjectSource(
              LOCAL_USER_ID,
              request.params.projectId,
            );
            if (!source) return null;
            const worktreeId = randomUUID();
            const result = worktreeCreateResultSchema.parse(
              await bridge.request(source.workerId, {
                type: "worktree.create",
                sourcePath: source.cwd,
                worktreeId,
                name: input.data.name,
                mode: input.data.mode,
              }),
            );
            const reconciled = await repository.reconcileProjectWorktrees(
              LOCAL_USER_ID,
              request.params.projectId,
              result.inventory,
              {
                id: worktreeId,
                name: input.data.name,
                origin: "user",
                path: result.worktree.path,
              },
            );
            return reconciled?.find((item) => item.id === worktreeId) ?? null;
          },
        );
        return created
          ? reply.code(201).send(projectWorktreeSummarySchema.parse(created))
          : reply.code(404).send({ error: "Project source not found." });
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 409;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/lock",
    async (request, reply) => {
      const input = projectWorktreeLockSchema.safeParse(request.body ?? {});
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const worktree = await serializeWorktreeMutation(
          request.params.projectId,
          async () => {
            const context = await repository.getProjectWorktreeContext(
              LOCAL_USER_ID,
              request.params.projectId,
              request.params.worktreeId,
            );
            if (!context) return null;
            const result = worktreeMutationResultSchema.parse(
              await bridge.request(context.workerId, {
                type: "worktree.lock",
                sourcePath: context.sourcePath,
                worktreePath: context.worktree.path,
                reason: input.data.reason,
              }),
            );
            const reconciled = await repository.reconcileProjectWorktrees(
              LOCAL_USER_ID,
              request.params.projectId,
              result.inventory,
            );
            return (
              reconciled?.find(
                (item) => item.id === request.params.worktreeId,
              ) ?? null
            );
          },
        );
        return worktree
          ? reply.send(projectWorktreeSummarySchema.parse(worktree))
          : reply.code(404).send({ error: "Worktree not found." });
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 409;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/unlock",
    async (request, reply) => {
      try {
        const worktree = await serializeWorktreeMutation(
          request.params.projectId,
          async () => {
            const context = await repository.getProjectWorktreeContext(
              LOCAL_USER_ID,
              request.params.projectId,
              request.params.worktreeId,
            );
            if (!context) return null;
            const result = worktreeMutationResultSchema.parse(
              await bridge.request(context.workerId, {
                type: "worktree.unlock",
                sourcePath: context.sourcePath,
                worktreePath: context.worktree.path,
              }),
            );
            const reconciled = await repository.reconcileProjectWorktrees(
              LOCAL_USER_ID,
              request.params.projectId,
              result.inventory,
            );
            return (
              reconciled?.find(
                (item) => item.id === request.params.worktreeId,
              ) ?? null
            );
          },
        );
        return worktree
          ? reply.send(projectWorktreeSummarySchema.parse(worktree))
          : reply.code(404).send({ error: "Worktree not found." });
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 409;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.delete<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId",
    async (request, reply) => {
      const input = projectWorktreeRemoveSchema.safeParse(request.body ?? {});
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const worktree = await serializeWorktreeMutation(
          request.params.projectId,
          async () => {
            const context = await repository.getProjectWorktreeContext(
              LOCAL_USER_ID,
              request.params.projectId,
              request.params.worktreeId,
            );
            if (!context) return null;
            if (context.worktree.isPrimary) {
              throw new Error("Primary cannot be removed as a worktree.");
            }
            if (
              context.worktree.origin === "external" &&
              !input.data.allowExternal
            ) {
              throw new Error(
                "Removing an external worktree requires explicit authorization.",
              );
            }
            const blockers = await repository.getWorktreeRemovalBlockers(
              LOCAL_USER_ID,
              request.params.projectId,
              request.params.worktreeId,
            );
            if (
              blockers &&
              (blockers.activeChatIds.length > 0 ||
                blockers.activeLeaseChatIds.length > 0 ||
                blockers.runningTerminalIds.length > 0)
            ) {
              throw new Error(
                "Stop active chats and terminals and release the worktree lease before removal.",
              );
            }
            const previousState = context.worktree.lifecycleState;
            await repository.setProjectWorktreeLifecycle(
              LOCAL_USER_ID,
              request.params.projectId,
              request.params.worktreeId,
              "removing",
            );
            try {
              const result = worktreeRemoveResultSchema.parse(
                await bridge.request(context.workerId, {
                  type: "worktree.remove",
                  sourcePath: context.sourcePath,
                  worktreePath: context.worktree.path,
                  force: input.data.force,
                  allowExternal: input.data.allowExternal,
                }),
              );
              const reconciled = await repository.reconcileProjectWorktrees(
                LOCAL_USER_ID,
                request.params.projectId,
                result.inventory,
              );
              return (
                reconciled?.find(
                  (item) => item.id === request.params.worktreeId,
                ) ?? null
              );
            } catch (error) {
              await repository.setProjectWorktreeLifecycle(
                LOCAL_USER_ID,
                request.params.projectId,
                request.params.worktreeId,
                previousState,
              );
              throw error;
            }
          },
        );
        return worktree
          ? reply.send(projectWorktreeSummarySchema.parse(worktree))
          : reply.code(404).send({ error: "Worktree not found." });
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 409;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/worktrees/prune",
    async (request, reply) => {
      const input = projectWorktreePruneSchema.safeParse(request.body ?? {});
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const worktrees = await serializeWorktreeMutation(
          request.params.projectId,
          async () => {
            const source = await repository.getProjectSource(
              LOCAL_USER_ID,
              request.params.projectId,
            );
            if (!source) return null;
            const result = worktreePruneResultSchema.parse(
              await bridge.request(source.workerId, {
                type: "worktree.prune",
                sourcePath: source.cwd,
                allowExternal: input.data.allowExternal,
              }),
            );
            return repository.reconcileProjectWorktrees(
              LOCAL_USER_ID,
              request.params.projectId,
              result.inventory,
            );
          },
        );
        return worktrees
          ? reply.send(projectWorktreeListSchema.parse(worktrees))
          : reply.code(404).send({ error: "Project source not found." });
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 409;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.get<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/status",
    async (request, reply) => {
      const context = await repository.getProjectWorktreeContext(
        LOCAL_USER_ID,
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Worktree not found." });
      }
      try {
        const result = await bridge.request(context.workerId, {
          type: "worktree.status",
          sourcePath: context.sourcePath,
          worktreePath: context.worktree.path,
        });
        return reply.send(worktreeStatusResultSchema.parse(result));
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.get<{
    Params: { projectId: string; worktreeId: string };
    Querystring: { cursor?: string; limit?: string };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/history",
    async (request, reply) => {
      const context = await repository.getProjectWorktreeContext(
        LOCAL_USER_ID,
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Worktree not found." });
      }
      const parsedLimit = Number.parseInt(request.query.limit ?? "100", 10);
      const limit = Number.isFinite(parsedLimit)
        ? Math.min(100, Math.max(1, parsedLimit))
        : 100;
      const parsedCursor = Number.parseInt(request.query.cursor ?? "0", 10);
      const cursor = Number.isFinite(parsedCursor)
        ? Math.max(0, parsedCursor)
        : 0;
      try {
        const history = await bridge.request(context.workerId, {
          type: "git.history",
          cwd: context.worktree.path,
          cursor,
          limit,
        });
        return reply.send(gitHistorySchema.parse(history));
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/actions",
    async (request, reply) => {
      const input = gitActionSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getProjectWorktreeContext(
        LOCAL_USER_ID,
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Worktree not found." });
      }
      try {
        const result = await bridge.request(context.workerId, {
          type: "git.action",
          cwd: context.worktree.path,
          action: input.data,
        });
        return reply.send(gitActionResultSchema.parse(result));
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 409;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { cursor?: string; limit?: string };
  }>("/api/projects/:projectId/git/history", async (request, reply) => {
    const source = await repository.getProjectSource(
      LOCAL_USER_ID,
      request.params.projectId,
    );
    if (!source) {
      return reply.code(404).send({ error: "Project source not found." });
    }
    const parsedLimit = Number.parseInt(request.query.limit ?? "100", 10);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(100, Math.max(1, parsedLimit))
      : 100;
    const parsedCursor = Number.parseInt(request.query.cursor ?? "0", 10);
    const cursor = Number.isFinite(parsedCursor)
      ? Math.max(0, parsedCursor)
      : 0;
    try {
      const history = await bridge.request(source.workerId, {
        type: "git.history",
        cwd: source.cwd,
        cursor,
        limit,
      });
      return reply.send(gitHistorySchema.parse(history));
    } catch (error) {
      const status = error instanceof WorkerUnavailableError ? 503 : 502;
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });

  app.get<{
    Params: { projectId: string };
    Querystring: { state?: string };
  }>("/api/projects/:projectId/github/issues", async (request, reply) => {
    const state = githubIssueStateSchema.safeParse(
      request.query.state ?? "open",
    );
    if (!state.success) {
      return reply.code(400).send({ error: "state must be open or closed" });
    }
    const context = await repository.getGithubProjectExecutionContext(
      LOCAL_USER_ID,
      request.params.projectId,
    );
    if (!context) {
      return reply.code(404).send({ error: "GitHub project not found." });
    }
    try {
      const issues = await bridge.request(context.workerId, {
        type: "github.issues.list",
        repository: context.nameWithOwner,
        state: state.data,
      });
      return reply.send(githubIssueListSchema.parse(issues));
    } catch (error) {
      const status = error instanceof WorkerUnavailableError ? 503 : 502;
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { issueNumber: string; projectId: string } }>(
    "/api/projects/:projectId/github/issues/:issueNumber",
    async (request, reply) => {
      const issueNumber = Number.parseInt(request.params.issueNumber, 10);
      if (!Number.isInteger(issueNumber) || issueNumber < 1) {
        return reply.code(400).send({ error: "Invalid issue number." });
      }
      const context = await repository.getGithubProjectExecutionContext(
        LOCAL_USER_ID,
        request.params.projectId,
      );
      if (!context) {
        return reply.code(404).send({ error: "GitHub project not found." });
      }
      try {
        const issue = await bridge.request(context.workerId, {
          type: "github.issue.get",
          repository: context.nameWithOwner,
          number: issueNumber,
        });
        return reply.send(githubIssueDetailSchema.parse(issue));
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { issueNumber: string; projectId: string } }>(
    "/api/projects/:projectId/github/issues/:issueNumber/comments",
    async (request, reply) => {
      const issueNumber = Number.parseInt(request.params.issueNumber, 10);
      const input = githubIssueCommentCreateSchema.safeParse(request.body);
      if (!Number.isInteger(issueNumber) || issueNumber < 1) {
        return reply.code(400).send({ error: "Invalid issue number." });
      }
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getGithubProjectExecutionContext(
        LOCAL_USER_ID,
        request.params.projectId,
      );
      if (!context) {
        return reply.code(404).send({ error: "GitHub project not found." });
      }
      try {
        const issue = await bridge.request(context.workerId, {
          type: "github.issue.comment",
          repository: context.nameWithOwner,
          number: issueNumber,
          body: input.data.body,
        });
        return reply.send(githubIssueDetailSchema.parse(issue));
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { issueNumber: string; projectId: string } }>(
    "/api/projects/:projectId/github/issues/:issueNumber/close",
    async (request, reply) => {
      const issueNumber = Number.parseInt(request.params.issueNumber, 10);
      const input = githubIssueCloseSchema.safeParse(request.body ?? {});
      if (!Number.isInteger(issueNumber) || issueNumber < 1) {
        return reply.code(400).send({ error: "Invalid issue number." });
      }
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getGithubProjectExecutionContext(
        LOCAL_USER_ID,
        request.params.projectId,
      );
      if (!context) {
        return reply.code(404).send({ error: "GitHub project not found." });
      }
      try {
        const issue = await bridge.request(context.workerId, {
          type: "github.issue.close",
          repository: context.nameWithOwner,
          number: issueNumber,
          comment: input.data.comment,
        });
        return reply.send(githubIssueDetailSchema.parse(issue));
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/git/status",
    async (request, reply) => {
      const source = await repository.getProjectSource(
        LOCAL_USER_ID,
        request.params.projectId,
      );
      if (!source) {
        return reply.code(404).send({ error: "Project source not found." });
      }
      try {
        const status = await bridge.request(source.workerId, {
          type: "git.status",
          cwd: source.cwd,
        });
        return reply.send(gitStatusSchema.parse(status));
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/git/actions",
    async (request, reply) => {
      const input = gitActionSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const source = await repository.getProjectSource(
        LOCAL_USER_ID,
        request.params.projectId,
      );
      if (!source) {
        return reply.code(404).send({ error: "Project source not found." });
      }
      try {
        const result = await bridge.request(source.workerId, {
          type: "git.action",
          cwd: source.cwd,
          action: input.data,
        });
        return reply.send(gitActionResultSchema.parse(result));
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.patch("/api/projects/order", async (request, reply) => {
    const input = orderedIdsSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    return (await repository.reorderProjects(LOCAL_USER_ID, input.data))
      ? reply.code(204).send()
      : reply.code(400).send({ error: "Project order did not match." });
  });

  app.delete<{ Params: { projectId: string } }>(
    "/api/projects/:projectId",
    async (request, reply) => {
      const input = projectRemoveSchema.safeParse(request.body ?? {});
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getProjectRemovalContext(
        LOCAL_USER_ID,
        request.params.projectId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Project not found." });
      }
      if (context.setupStatus === "cloning") {
        return reply
          .code(409)
          .send({ error: "Wait for the repository clone to finish." });
      }
      const { cwd, workerId } = context;

      try {
        if (input.data.deleteLocalFiles && cwd && workerId) {
          await Promise.all(
            context.terminalIds.map((terminalId) =>
              bridge.request(workerId, {
                type: "terminal.close",
                terminalId,
              }),
            ),
          );
          await bridge.request(workerId, {
            type: "project.files.delete",
            path: cwd,
          });
        } else if (workerId && bridge.isConnected(workerId)) {
          for (const terminalId of context.terminalIds) {
            void bridge
              .request(workerId, {
                type: "terminal.close",
                terminalId,
              })
              .catch(() => undefined);
          }
        }
        for (const surface of context.remoteSurfaces) {
          if (!bridge.isConnected(surface.workerId)) continue;
          const commands: Promise<unknown>[] = [
            bridge.request(surface.workerId, {
              type: "surface.close",
              surfaceId: surface.id,
            }),
          ];
          if (
            surface.configuration.kind === "vnc" &&
            surface.configuration.secretRef
          ) {
            commands.push(
              bridge.request(surface.workerId, {
                type: "surface.vnc.secret.delete",
                secretRef: surface.configuration.secretRef,
              }),
            );
          }
          await Promise.allSettled(commands);
        }
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }

      return (await repository.deleteProject(
        LOCAL_USER_ID,
        request.params.projectId,
      ))
        ? reply.code(204).send()
        : reply.code(404).send({ error: "Project not found." });
    },
  );

  app.post("/api/projects/from-github", async (request, reply) => {
    const input = githubProjectCreateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    if (
      await repository.hasGithubProject(LOCAL_USER_ID, input.data.repositoryId)
    ) {
      return reply.code(409).send({
        error: "This GitHub repository already has a Cantrip project.",
      });
    }

    try {
      const project = await repository.createGithubProject(
        LOCAL_USER_ID,
        input.data,
      );
      queueProjectSetup(project.id, input.data);
      return reply.code(202).send(projectSummarySchema.parse(project));
    } catch (error) {
      if (
        await repository.hasGithubProject(
          LOCAL_USER_ID,
          input.data.repositoryId,
        )
      ) {
        return reply.code(409).send({
          error: "This GitHub repository already has a Cantrip project.",
        });
      }
      const status = error instanceof WorkerUnavailableError ? 503 : 502;
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/chats",
    async (request, reply) => {
      const chats = await repository.listChats(
        LOCAL_USER_ID,
        request.params.projectId,
      );
      return reply.send(chatListSchema.parse(chats));
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/chats",
    async (request, reply) => {
      const input = chatCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const chat = await repository.createChat(
          LOCAL_USER_ID,
          request.params.projectId,
          input.data,
        );
        if (!chat) {
          return reply.code(404).send({ error: "Project source not found" });
        }
        return reply.code(201).send(chatSummarySchema.parse(chat));
      } catch (error) {
        if (
          error instanceof ExecutionLaneConflictError ||
          /unique|duplicate/i.test(errorMessage(error))
        ) {
          return reply.code(409).send({
            error: "This worktree is already leased by another chat.",
          });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/console",
    async (request, reply) => {
      const terminal = await repository.getOrCreateChatConsole(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      return terminal
        ? reply.code(201).send(terminalSummarySchema.parse(terminal))
        : reply.code(404).send({ error: "Chat source not found." });
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/terminals",
    async (request, reply) => {
      const terminals = await repository.listTerminals(
        LOCAL_USER_ID,
        request.params.projectId,
      );
      return reply.send(terminalListSchema.parse(terminals));
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/terminals",
    async (request, reply) => {
      const input = terminalCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const terminal = await repository.createTerminal(
        LOCAL_USER_ID,
        request.params.projectId,
        input.data,
      );
      return terminal
        ? reply.code(201).send(terminalSummarySchema.parse(terminal))
        : reply.code(404).send({ error: "Project source not found." });
    },
  );

  app.patch<{ Params: { terminalId: string } }>(
    "/api/terminals/:terminalId",
    async (request, reply) => {
      const input = terminalUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const terminal = await repository.updateTerminal(
        LOCAL_USER_ID,
        request.params.terminalId,
        input.data,
      );
      return terminal
        ? reply.send(terminalSummarySchema.parse(terminal))
        : reply.code(404).send({ error: "Terminal not found." });
    },
  );

  app.patch<{ Params: { terminalId: string } }>(
    "/api/terminals/:terminalId/worktree",
    async (request, reply) => {
      const input = worktreeSelectionSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const terminal = await repository.updateTerminalWorktree(
          LOCAL_USER_ID,
          request.params.terminalId,
          input.data,
        );
        return terminal
          ? reply.send(terminalSummarySchema.parse(terminal))
          : reply.code(404).send({ error: "Terminal or worktree not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.delete<{ Params: { terminalId: string } }>(
    "/api/terminals/:terminalId",
    async (request, reply) => {
      const context = await repository.deleteTerminal(
        LOCAL_USER_ID,
        request.params.terminalId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Terminal not found." });
      }
      if (bridge.isConnected(context.workerId)) {
        void bridge
          .request(context.workerId, {
            type: "terminal.close",
            terminalId: context.terminalId,
          })
          .catch((error: unknown) =>
            app.log.warn(
              { err: error, terminalId: context.terminalId },
              "Could not close deleted terminal",
            ),
          );
      }
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/explorers",
    async (request, reply) => {
      const explorers = await repository.listExplorers(
        LOCAL_USER_ID,
        request.params.projectId,
      );
      return reply.send(explorerListSchema.parse(explorers));
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/browsers",
    async (request, reply) =>
      reply.send(
        browserListSchema.parse(
          await repository.listBrowsers(
            LOCAL_USER_ID,
            request.params.projectId,
          ),
        ),
      ),
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/browsers",
    async (request, reply) => {
      const input = browserCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const source = await repository.getProjectSource(
        LOCAL_USER_ID,
        request.params.projectId,
      );
      if (!source) {
        return reply.code(404).send({ error: "Project source not found." });
      }
      const worker = (await repository.listWorkers(LOCAL_USER_ID)).find(
        ({ workerId }) => workerId === source.workerId,
      );
      if (!worker?.remoteSurfaces.browser) {
        return reply.code(409).send({
          error:
            "The project worker does not have an available Chromium browser.",
        });
      }
      const browser = await repository.createBrowser(
        LOCAL_USER_ID,
        request.params.projectId,
        input.data,
      );
      return browser
        ? reply.code(201).send(browserSummarySchema.parse(browser))
        : reply.code(404).send({ error: "Project source not found." });
    },
  );

  app.patch<{ Params: { browserId: string } }>(
    "/api/browsers/:browserId",
    async (request, reply) => {
      const input = browserUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const browser = await repository.updateBrowser(
        LOCAL_USER_ID,
        request.params.browserId,
        input.data,
      );
      return browser
        ? reply.send(browserSummarySchema.parse(browser))
        : reply.code(404).send({ error: "Browser not found." });
    },
  );

  app.delete<{ Params: { browserId: string } }>(
    "/api/browsers/:browserId",
    async (request, reply) => {
      const context = await repository.getRemoteSurfaceExecutionContext(
        LOCAL_USER_ID,
        request.params.browserId,
      );
      if (
        !(await repository.deleteBrowser(
          LOCAL_USER_ID,
          request.params.browserId,
        ))
      ) {
        return reply.code(404).send({ error: "Browser not found." });
      }
      if (context && bridge.isConnected(context.workerId)) {
        void bridge
          .request(context.workerId, {
            type: "surface.close",
            surfaceId: context.surface.id,
          })
          .catch(() => undefined);
      }
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/remote-desktops",
    async (request, reply) =>
      reply.send(
        remoteDesktopListSchema.parse(
          await repository.listRemoteDesktops(
            LOCAL_USER_ID,
            request.params.projectId,
          ),
        ),
      ),
  );

  app.get<{ Params: { desktopId: string } }>(
    "/api/remote-desktops/:desktopId",
    async (request, reply) => {
      const desktop = await repository.getRemoteDesktop(
        LOCAL_USER_ID,
        request.params.desktopId,
      );
      return desktop
        ? reply.send(remoteDesktopSummarySchema.parse(desktop))
        : reply.code(404).send({ error: "Remote Desktop not found." });
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/remote-desktops",
    async (request, reply) => {
      const input = remoteDesktopCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const worker = (await repository.listWorkers(LOCAL_USER_ID)).find(
        ({ workerId }) => workerId === input.data.workerId,
      );
      if (!worker) return reply.code(404).send({ error: "Worker not found." });
      if (!worker.remoteSurfaces.vnc) {
        return reply.code(409).send({
          error:
            "The selected worker does not support configured VNC endpoints.",
        });
      }
      if (!bridge.isConnected(worker.workerId)) {
        return reply.code(409).send({ error: "Worker is offline." });
      }

      const desktopId = randomUUID();
      let secretRef: string | null = null;
      try {
        if (input.data.password !== null) {
          secretRef = remoteVncSecretResultSchema.parse(
            await bridge.request(worker.workerId, {
              type: "surface.vnc.secret.set",
              surfaceId: desktopId,
              password: input.data.password,
            }),
          ).secretRef;
        }
        const { password: _password, ...configuration } = input.data;
        const desktop = await repository.createRemoteDesktop(
          LOCAL_USER_ID,
          request.params.projectId,
          desktopId,
          configuration,
          secretRef,
        );
        if (!desktop) {
          if (secretRef) {
            void bridge
              .request(worker.workerId, {
                type: "surface.vnc.secret.delete",
                secretRef,
              })
              .catch(() => undefined);
          }
          return reply
            .code(404)
            .send({ error: "Project or worker not found." });
        }
        const probe = remoteVncProbeResultSchema.parse(
          await bridge.request(
            worker.workerId,
            {
              type: "surface.vnc.probe",
              host: input.data.host,
              port: input.data.port,
            },
            { timeoutMs: 10_000 },
          ),
        );
        if (!probe.reachable) {
          await repository.setRemoteSurfaceStatus(
            desktopId,
            "offline",
            probe.message ?? "VNC endpoint is not reachable from the worker.",
          );
        }
        const refreshed = await repository.getRemoteDesktop(
          LOCAL_USER_ID,
          desktopId,
        );
        return reply
          .code(201)
          .send(remoteDesktopSummarySchema.parse(refreshed ?? desktop));
      } catch (error) {
        if (secretRef) {
          void bridge
            .request(worker.workerId, {
              type: "surface.vnc.secret.delete",
              secretRef,
            })
            .catch(() => undefined);
        }
        return reply.code(502).send({ error: errorMessage(error) });
      }
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/remote-surfaces",
    async (request, reply) =>
      reply.send(
        remoteSurfaceListSchema.parse(
          await repository.listRemoteSurfaces(
            LOCAL_USER_ID,
            request.params.projectId,
          ),
        ),
      ),
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/remote-surfaces",
    async (request, reply) => {
      const input = remoteSurfaceCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      if (input.data.configuration.kind === "vnc") {
        return reply.code(400).send({
          error:
            "Create VNC surfaces through the Remote Desktop endpoint so credentials remain worker-owned.",
        });
      }
      const worker = (await repository.listWorkers(LOCAL_USER_ID)).find(
        ({ workerId }) => workerId === input.data.workerId,
      );
      if (!worker) return reply.code(404).send({ error: "Worker not found." });
      if (!worker.remoteSurfaces[input.data.configuration.kind]) {
        return reply.code(409).send({
          error: `Worker does not support ${input.data.configuration.kind} Remote Surfaces.`,
        });
      }
      const surface = await repository.createRemoteSurface(
        LOCAL_USER_ID,
        request.params.projectId,
        input.data,
      );
      return surface
        ? reply.code(201).send(remoteSurfaceSummarySchema.parse(surface))
        : reply.code(404).send({ error: "Project or worker not found." });
    },
  );

  app.patch<{ Params: { surfaceId: string } }>(
    "/api/remote-surfaces/:surfaceId",
    async (request, reply) => {
      const input = remoteSurfaceUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      if (input.data.configuration?.kind === "vnc") {
        return reply.code(400).send({
          error:
            "VNC configuration changes must use the Remote Desktop settings flow.",
        });
      }
      const surface = await repository.updateRemoteSurface(
        LOCAL_USER_ID,
        request.params.surfaceId,
        input.data,
      );
      return surface
        ? reply.send(remoteSurfaceSummarySchema.parse(surface))
        : reply.code(404).send({ error: "Remote Surface not found." });
    },
  );

  for (const action of ["suspend", "resume"] as const) {
    app.post<{ Params: { surfaceId: string } }>(
      `/api/remote-surfaces/:surfaceId/${action}`,
      async (request, reply) => {
        const context = await repository.getRemoteSurfaceExecutionContext(
          LOCAL_USER_ID,
          request.params.surfaceId,
        );
        if (!context) {
          return reply.code(404).send({ error: "Remote Surface not found." });
        }
        if (!bridge.isConnected(context.workerId)) {
          await repository.setRemoteSurfaceStatus(
            context.surface.id,
            "offline",
            "Worker is offline.",
          );
          return reply.code(503).send({ error: "Worker is offline." });
        }
        try {
          await bridge.request(context.workerId, {
            type: action === "suspend" ? "surface.suspend" : "surface.resume",
            surfaceId: context.surface.id,
          });
          await repository.setRemoteSurfaceStatus(
            context.surface.id,
            action === "suspend" ? "suspended" : "active",
          );
          const updated = await repository.getRemoteSurfaceExecutionContext(
            LOCAL_USER_ID,
            context.surface.id,
          );
          return updated
            ? reply.send(remoteSurfaceSummarySchema.parse(updated.surface))
            : reply.code(404).send({
                error: "Remote Surface was removed during the request.",
              });
        } catch (error) {
          return reply.code(502).send({ error: errorMessage(error) });
        }
      },
    );
  }

  app.delete<{ Params: { surfaceId: string } }>(
    "/api/remote-surfaces/:surfaceId",
    async (request, reply) => {
      const context = await repository.deleteRemoteSurface(
        LOCAL_USER_ID,
        request.params.surfaceId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Remote Surface not found." });
      }
      if (bridge.isConnected(context.workerId)) {
        const commands: Promise<unknown>[] = [
          bridge.request(context.workerId, {
            type: "surface.close",
            surfaceId: context.surface.id,
          }),
        ];
        if (
          context.surface.configuration.kind === "vnc" &&
          context.surface.configuration.secretRef
        ) {
          commands.push(
            bridge.request(context.workerId, {
              type: "surface.vnc.secret.delete",
              secretRef: context.surface.configuration.secretRef,
            }),
          );
        }
        void Promise.allSettled(commands).then((results) => {
          for (const result of results) {
            if (result.status !== "rejected") continue;
            app.log.warn(
              { err: result.reason, surfaceId: context.surface.id },
              "Could not close deleted Remote Surface",
            );
          }
        });
      }
      return reply.code(204).send();
    },
  );

  app.get<{
    Params: { surfaceId: string };
    Querystring: { width?: string; height?: string; devicePixelRatio?: string };
  }>(
    "/api/remote-surfaces/:surfaceId/connect",
    { websocket: true },
    (socket, request) => {
      if (
        !request.headers.origin ||
        !config.appOrigins.includes(request.headers.origin)
      ) {
        socket.close(1008, "Origin not allowed");
        return;
      }
      const viewport = remoteSurfaceViewportSchema.safeParse({
        width: Number(request.query.width ?? 1_280),
        height: Number(request.query.height ?? 720),
        devicePixelRatio: Number(request.query.devicePixelRatio ?? 1),
      });
      if (!viewport.success) {
        socket.close(1008, "Invalid viewport");
        return;
      }

      const attachmentId = randomUUID();
      let attached = false;
      let closed = false;
      let surfaceId: string | null = null;
      let workerId: string | null = null;

      const send = (message: unknown) => {
        if (socket.readyState === 1) {
          socket.send(
            JSON.stringify(remoteSurfaceConnectionMessageSchema.parse(message)),
          );
        }
      };

      socket.on("close", () => {
        closed = true;
        if (!attached || !surfaceId || !workerId) return;
        attached = false;
        const remaining = Math.max(
          0,
          (surfaceAttachmentCounts.get(surfaceId) ?? 1) - 1,
        );
        if (remaining === 0) surfaceAttachmentCounts.delete(surfaceId);
        else surfaceAttachmentCounts.set(surfaceId, remaining);
        if (bridge.isConnected(workerId)) {
          void bridge
            .request(workerId, {
              type: "surface.detach",
              surfaceId,
              attachmentId,
            })
            .catch(() => undefined);
        }
        if (remaining === 0) {
          void repository.setRemoteSurfaceStatus(
            surfaceId,
            bridge.isConnected(workerId) ? "idle" : "offline",
            bridge.isConnected(workerId) ? null : "Worker is offline.",
          );
        }
      });

      void (async () => {
        const context = await repository.getRemoteSurfaceExecutionContext(
          LOCAL_USER_ID,
          request.params.surfaceId,
        );
        if (!context) {
          send({
            type: "error",
            message: "Remote Surface not found.",
            recoverable: false,
          });
          socket.close(1008, "Remote Surface not found");
          return;
        }
        surfaceId = context.surface.id;
        workerId = context.workerId;
        if (!bridge.isConnected(workerId)) {
          await repository.setRemoteSurfaceStatus(
            surfaceId,
            "offline",
            "Worker is offline.",
          );
          send({
            type: "error",
            message: "Worker is offline.",
            recoverable: true,
          });
          socket.close(1013, "Worker offline");
          return;
        }

        await repository.setRemoteSurfaceStatus(surfaceId, "connecting");
        const webRtcConfiguration =
          context.surface.preferredTransport === "webrtc" &&
          context.remoteSurfaceCapabilities.transports.includes("webrtc") &&
          config.remoteSurfaceWebRtc
            ? createRemoteSurfaceWebRtcConfiguration(
                config.remoteSurfaceWebRtc,
                LOCAL_USER_ID,
              )
            : null;
        const cleanupRelay = surfaceRelay.bind(socket, {
          surfaceId,
          attachmentId,
          workerId,
        });
        try {
          const result = remoteSurfaceAttachResultSchema.parse(
            await bridge.request(
              workerId,
              {
                type: "surface.attach",
                surfaceId,
                attachmentId,
                projectId: context.surface.projectId,
                configuration: context.surface.configuration,
                preferredTransport: context.surface.preferredTransport,
                webrtc: webRtcConfiguration,
                viewport: viewport.data,
              },
              { timeoutMs: 30_000 },
            ),
          );
          if (closed) {
            cleanupRelay();
            void bridge
              .request(workerId, {
                type: "surface.detach",
                surfaceId,
                attachmentId,
              })
              .catch(() => undefined);
            return;
          }
          attached = true;
          surfaceAttachmentCounts.set(
            surfaceId,
            (surfaceAttachmentCounts.get(surfaceId) ?? 0) + 1,
          );
          await repository.setRemoteSurfaceStatus(surfaceId, "active");
          send({
            type: "ready",
            surfaceId,
            attachmentId,
            transport: result.transport,
            webrtc: result.transport === "webrtc" ? webRtcConfiguration : null,
          });
        } catch (error) {
          cleanupRelay();
          const message = errorMessage(error);
          await repository.setRemoteSurfaceStatus(
            surfaceId,
            error instanceof WorkerUnavailableError ? "offline" : "error",
            message,
          );
          send({ type: "error", message, recoverable: true });
          socket.close(1013, "Remote Surface unavailable");
        }
      })();
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/views",
    async (request, reply) =>
      reply.send(
        projectViewListSchema.parse(
          await repository.listProjectViews(
            LOCAL_USER_ID,
            request.params.projectId,
          ),
        ),
      ),
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/views",
    async (request, reply) => {
      const input = projectViewCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      if (input.data.kind === "remote-desktop") {
        return reply.code(400).send({
          error:
            "Remote Desktop views must be created with endpoint configuration.",
        });
      }
      const view = await repository.createProjectView(
        LOCAL_USER_ID,
        request.params.projectId,
        input.data,
      );
      return view
        ? reply.code(201).send(projectViewSummarySchema.parse(view))
        : reply.code(404).send({ error: "Project source not found." });
    },
  );

  app.patch<{ Params: { viewId: string } }>(
    "/api/project-views/:viewId",
    async (request, reply) => {
      const input = projectViewUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const view = await repository.updateProjectView(
        LOCAL_USER_ID,
        request.params.viewId,
        input.data,
      );
      return view
        ? reply.send(projectViewSummarySchema.parse(view))
        : reply.code(404).send({ error: "Project view not found." });
    },
  );

  app.patch<{ Params: { viewId: string } }>(
    "/api/project-views/:viewId/worktree",
    async (request, reply) => {
      const input = worktreeSelectionSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const view = await repository.updateProjectViewWorktree(
          LOCAL_USER_ID,
          request.params.viewId,
          input.data,
        );
        return view
          ? reply.send(projectViewSummarySchema.parse(view))
          : reply
              .code(404)
              .send({ error: "History view or worktree not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.delete<{ Params: { viewId: string } }>(
    "/api/project-views/:viewId",
    async (request, reply) => {
      const context = await repository.getRemoteSurfaceExecutionContext(
        LOCAL_USER_ID,
        request.params.viewId,
      );
      if (
        !(await repository.deleteProjectView(
          LOCAL_USER_ID,
          request.params.viewId,
        ))
      ) {
        return reply.code(404).send({ error: "Project view not found." });
      }
      if (context && bridge.isConnected(context.workerId)) {
        const commands: Promise<unknown>[] = [
          bridge.request(context.workerId, {
            type: "surface.close",
            surfaceId: context.surface.id,
          }),
        ];
        if (
          context.surface.configuration.kind === "vnc" &&
          context.surface.configuration.secretRef
        ) {
          commands.push(
            bridge.request(context.workerId, {
              type: "surface.vnc.secret.delete",
              secretRef: context.surface.configuration.secretRef,
            }),
          );
        }
        void Promise.allSettled(commands);
      }
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/explorers",
    async (request, reply) => {
      const input = explorerCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const explorer = await repository.createExplorer(
        LOCAL_USER_ID,
        request.params.projectId,
        input.data,
      );
      return explorer
        ? reply.code(201).send(explorerSummarySchema.parse(explorer))
        : reply.code(404).send({ error: "Project source not found." });
    },
  );

  app.patch<{ Params: { explorerId: string } }>(
    "/api/explorers/:explorerId",
    async (request, reply) => {
      const input = explorerUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const explorer = await repository.updateExplorer(
        LOCAL_USER_ID,
        request.params.explorerId,
        input.data,
      );
      return explorer
        ? reply.send(explorerSummarySchema.parse(explorer))
        : reply.code(404).send({ error: "Explorer not found." });
    },
  );

  app.patch<{ Params: { explorerId: string } }>(
    "/api/explorers/:explorerId/worktree",
    async (request, reply) => {
      const input = worktreeSelectionSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const explorer = await repository.updateExplorerWorktree(
        LOCAL_USER_ID,
        request.params.explorerId,
        input.data,
      );
      return explorer
        ? reply.send(explorerSummarySchema.parse(explorer))
        : reply.code(404).send({ error: "Explorer or worktree not found." });
    },
  );

  app.delete<{ Params: { explorerId: string } }>(
    "/api/explorers/:explorerId",
    async (request, reply) =>
      (await repository.deleteExplorer(
        LOCAL_USER_ID,
        request.params.explorerId,
      ))
        ? reply.code(204).send()
        : reply.code(404).send({ error: "Explorer not found." }),
  );

  app.get<{
    Params: { explorerId: string };
    Querystring: { path?: string };
  }>("/api/explorers/:explorerId/directory", async (request, reply) => {
    const context = await repository.getExplorerExecutionContext(
      LOCAL_USER_ID,
      request.params.explorerId,
    );
    if (!context) return reply.code(404).send({ error: "Explorer not found." });
    try {
      const directory = await bridge.request(context.workerId, {
        type: "explorer.directory.list",
        root: context.root,
        path: request.query.path ?? "",
      });
      return reply.send(explorerDirectorySchema.parse(directory));
    } catch (error) {
      const status = error instanceof WorkerUnavailableError ? 503 : 502;
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });

  app.get<{
    Params: { explorerId: string };
    Querystring: { path?: string };
  }>("/api/explorers/:explorerId/file", async (request, reply) => {
    if (!request.query.path) {
      return reply.code(400).send({ error: "A file path is required." });
    }
    const context = await repository.getExplorerExecutionContext(
      LOCAL_USER_ID,
      request.params.explorerId,
    );
    if (!context) return reply.code(404).send({ error: "Explorer not found." });
    try {
      const file = await bridge.request(context.workerId, {
        type: "explorer.file.read",
        root: context.root,
        path: request.query.path,
      });
      return reply.send(explorerFileSchema.parse(file));
    } catch (error) {
      const status = error instanceof WorkerUnavailableError ? 503 : 502;
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { terminalId: string } }>(
    "/api/terminals/:terminalId/connect",
    { websocket: true },
    (socket, request) => {
      if (
        !request.headers.origin ||
        !config.appOrigins.includes(request.headers.origin)
      ) {
        socket.close(1008, "Origin not allowed");
        return;
      }
      const attachmentId = randomUUID();
      let terminalId: string | null = null;
      let workerId: string | null = null;
      let closed = false;
      const send = (message: unknown) => {
        if (socket.readyState === 1) {
          socket.send(
            JSON.stringify(terminalServerMessageSchema.parse(message)),
          );
        }
      };

      socket.on("close", () => {
        closed = true;
        if (!terminalId || !workerId || !bridge.isConnected(workerId)) return;
        void bridge
          .request(workerId, {
            type: "terminal.detach",
            terminalId,
            attachmentId,
          })
          .catch(() => undefined);
      });

      socket.on("message", (raw) => {
        if (!terminalId || !workerId) return;
        let value: unknown;
        try {
          value = JSON.parse(raw.toString());
        } catch {
          send({ type: "error", message: "Invalid terminal message." });
          return;
        }
        const message = terminalClientMessageSchema.safeParse(value);
        if (!message.success) {
          send({ type: "error", message: "Invalid terminal message." });
          return;
        }
        const command =
          message.data.type === "input"
            ? {
                type: "terminal.input" as const,
                terminalId,
                data: message.data.data,
              }
            : {
                type: "terminal.resize" as const,
                terminalId,
                cols: message.data.cols,
                rows: message.data.rows,
              };
        void bridge
          .request(workerId, command, { timeoutMs: 30_000 })
          .catch((error: unknown) => {
            send({ type: "error", message: errorMessage(error) });
          });
      });

      void (async () => {
        const context = await repository.getTerminalExecutionContext(
          LOCAL_USER_ID,
          request.params.terminalId,
        );
        if (!context) {
          send({ type: "error", message: "Terminal not found." });
          socket.close(1008, "Terminal not found");
          return;
        }
        if (closed) return;
        terminalId = context.terminalId;
        workerId = context.workerId;
        if (!bridge.isConnected(workerId)) {
          await repository.setTerminalStatus(terminalId, "offline");
          send({ type: "error", message: "Project worker is offline." });
          socket.close(1013, "Worker offline");
          return;
        }
        if (closed) {
          await repository.setTerminalStatus(terminalId, "idle");
          return;
        }
        try {
          let launch:
            | { type: "shell" }
            | {
                type: "codex";
                threadId: string | null;
                model: ModelRuntime["model"];
                provider: ModelRuntime["provider"];
              } = { type: "shell" };
          if (context.linkedChatId) {
            const chat = await repository.getChatExecutionContext(
              LOCAL_USER_ID,
              context.linkedChatId,
            );
            const runtime = chat ? await runtimeForContext(chat) : null;
            if (!chat || !runtime) {
              throw new Error(
                "Choose a model for this chat before opening its Codex console.",
              );
            }
            launch = {
              type: "codex",
              threadId: chat.threadId,
              model: runtime.model,
              provider: runtime.provider,
            };
          }
          const result = terminalOpenResultSchema.parse(
            await bridge.request(
              workerId,
              {
                type: "terminal.open",
                terminalId,
                attachmentId,
                cwd: context.cwd,
                cols: 80,
                rows: 24,
                launch,
              },
              {
                timeoutMs: null,
                onEvent: async (event) => {
                  if (event.type === "terminal.ready") {
                    if (closed) {
                      await bridge.request(workerId!, {
                        type: "terminal.detach",
                        terminalId: terminalId!,
                        attachmentId,
                      });
                      return;
                    }
                    await repository.setTerminalStatus(terminalId!, "running");
                    send({ type: "ready" });
                  } else if (event.type === "terminal.output") {
                    send({ type: "output", data: event.data });
                  }
                },
              },
            ),
          );
          if (result.status === "exited") {
            await repository.setTerminalStatus(terminalId, "exited");
            if (!closed) send({ type: "exit", ...result });
          }
        } catch (error) {
          await repository.setTerminalStatus(
            terminalId,
            error instanceof WorkerUnavailableError ? "offline" : "failed",
          );
          if (!closed) send({ type: "error", message: errorMessage(error) });
        }
      })();
    },
  );

  app.patch<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/tabs/order",
    async (request, reply) => {
      const input = orderedIdsSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      return (await repository.reorderProjectTabs(
        LOCAL_USER_ID,
        request.params.projectId,
        input.data,
      ))
        ? reply.code(204).send()
        : reply.code(400).send({ error: "Tab order did not match." });
    },
  );

  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId",
    async (request, reply) => {
      const input = chatUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const chat = await repository.updateChat(
        LOCAL_USER_ID,
        request.params.chatId,
        input.data,
      );
      return chat
        ? reply.send(chatSummarySchema.parse(chat))
        : reply.code(404).send({ error: "Chat not found." });
    },
  );

  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/worktree",
    async (request, reply) => {
      const input = chatWorktreeUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const chat = await repository.updateChatWorktree(
          LOCAL_USER_ID,
          request.params.chatId,
          input.data,
        );
        return chat
          ? reply.send(chatSummarySchema.parse(chat))
          : reply.code(404).send({ error: "Chat or worktree not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/execution-lanes",
    async (request, reply) => {
      const lanes = await repository.listChatExecutionLanes(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      return reply.send(chatExecutionLaneListSchema.parse(lanes));
    },
  );

  app.post<{ Params: { chatId: string; laneId: string } }>(
    "/api/chats/:chatId/execution-lanes/:laneId/release",
    async (request, reply) => {
      const input = chatExecutionLaneReleaseSchema.safeParse(
        request.body ?? {},
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionLaneContext(
        LOCAL_USER_ID,
        request.params.chatId,
        request.params.laneId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Execution lane not found." });
      }
      if (context.lane.state === "released") {
        return reply.send({
          chat: context.chat,
          lane: context.lane,
          returnedToPrimary: false,
        });
      }
      try {
        if (!bridge.isConnected(context.worktree.workerId)) {
          throw new WorkerUnavailableError("Project worker is offline.");
        }
        const status = worktreeStatusResultSchema.parse(
          await bridge.request(context.worktree.workerId, {
            type: "worktree.status",
            sourcePath: context.sourcePath,
            worktreePath: context.worktree.path,
          }),
        );
        if (status.status.files.length > 0 && !input.data.allowDirty) {
          return reply.code(409).send({
            error:
              "This worktree has uncommitted changes. Pass allowDirty to release it intentionally.",
          });
        }
        const released = await repository.releaseChatExecutionLane(
          LOCAL_USER_ID,
          request.params.chatId,
          request.params.laneId,
          input.data.returnToPrimary,
        );
        if (!released) {
          return reply.code(404).send({ error: "Execution lane not found." });
        }
        await repository.appendMessage(
          LOCAL_USER_ID,
          request.params.chatId,
          {
            role: "system",
            content: [
              {
                type: "text",
                text: released.returnedToPrimary
                  ? `Released ${context.worktree.name}; execution returned to Primary.`
                  : `Released execution lane for ${context.worktree.name}.`,
              },
            ],
            idempotencyKey: `lane-release:${request.params.laneId}`,
          },
          {
            executionLaneId: request.params.laneId,
            worktreeId: context.worktree.id,
          },
        );
        return reply.send(released);
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 409;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.delete<{ Params: { chatId: string } }>(
    "/api/chats/:chatId",
    async (request, reply) => {
      const result = await repository.deleteChat(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (result === "running") {
        return reply.code(409).send({ error: "Stop the running chat first." });
      }
      return result
        ? reply.code(204).send()
        : reply.code(404).send({ error: "Chat not found." });
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/fork",
    async (request, reply) => {
      const input = chatForkSchema.safeParse(request.body ?? {});
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const chat = await repository.forkChat(
          LOCAL_USER_ID,
          request.params.chatId,
          input.data,
        );
        return chat
          ? reply.code(201).send(chatSummarySchema.parse(chat))
          : reply.code(404).send({ error: "Chat or message not found." });
      } catch (error) {
        if (/unique|duplicate/i.test(errorMessage(error))) {
          return reply.code(409).send({
            error: "This worktree is already leased by another chat.",
          });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/compact",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (context.status === "running") {
        return reply
          .code(409)
          .send({ error: "Wait for the active turn to finish." });
      }
      if (!context.threadId) {
        return reply
          .code(409)
          .send({ error: "Send a message before compacting this chat." });
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      const runtime = await runtimeForContext(context);
      if (!runtime) {
        return reply.code(400).send({ error: "Selected model was not found." });
      }
      const result = await bridge.request(context.workerId, {
        type: "chat.compact",
        chatId: context.chatId,
        cwd: context.cwd,
        threadId: context.threadId,
        model: runtime.model,
        provider: runtime.provider,
      });
      return reply.send(chatCompactAcceptedSchema.parse(result));
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/interrupt",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (!context.threadId || context.status !== "running") {
        return reply.send(
          chatInterruptAcceptedSchema.parse({ interrupted: false }),
        );
      }
      const runtime = await runtimeForContext(context);
      if (!runtime) {
        return reply.code(400).send({ error: "Selected model was not found." });
      }
      const result = await bridge.request(context.workerId, {
        type: "chat.interrupt",
        chatId: context.chatId,
        threadId: context.threadId,
        model: runtime.model,
        provider: runtime.provider,
      });
      return reply.send(chatInterruptAcceptedSchema.parse(result));
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/sync",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (!context.threadId) {
        return reply.send(
          agentThreadSyncSchema.parse({
            threadId: "unavailable",
            status: "idle",
            turns: [],
          }),
        );
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      const runtime = await runtimeForContext(context);
      if (!runtime) {
        return reply.code(400).send({ error: "Selected model was not found." });
      }
      const sync = agentThreadSyncSchema.parse(
        await bridge.request(context.workerId, {
          type: "chat.sync",
          chatId: context.chatId,
          cwd: context.cwd,
          threadId: context.threadId,
          model: runtime.model,
          provider: runtime.provider,
        }),
      );
      let syncExecution = context;
      if (sync.status === "running" && !context.executionLaneId) {
        const acquired = await repository.startChatExecutionLane(
          LOCAL_USER_ID,
          context.chatId,
          "agent",
          "Linked Codex console turn",
        );
        if (acquired) syncExecution = acquired;
      }
      const syncAttribution = syncExecution.executionLaneId
        ? {
            executionLaneId: syncExecution.executionLaneId,
            worktreeId: syncExecution.worktreeId,
          }
        : undefined;
      for (const turn of sync.turns) {
        for (const item of turn.items) {
          if (item.type === "userMessage") {
            await repository.upsertMessage(
              LOCAL_USER_ID,
              context.chatId,
              {
                role: "user",
                content: [{ type: "text", text: item.text }],
                idempotencyKey: `codex-sync:${turn.id}:${item.id}`,
              },
              syncAttribution,
            );
          } else if (
            item.type === "agentMessage" &&
            item.phase !== "commentary"
          ) {
            await repository.upsertMessage(
              LOCAL_USER_ID,
              context.chatId,
              {
                role: "assistant",
                content: [{ type: "text", text: item.text }],
                idempotencyKey: `codex-sync:${turn.id}:${item.id}`,
              },
              syncAttribution,
            );
          } else if (item.type === "activity") {
            await repository.upsertMessage(
              LOCAL_USER_ID,
              context.chatId,
              {
                role: "assistant",
                content: [{ type: "activity", activity: item.activity }],
                idempotencyKey: `codex-sync:${turn.id}:${item.activity.id}`,
              },
              syncAttribution,
            );
          }
        }
        if (turn.status === "failed" || turn.status === "interrupted") {
          await repository.upsertMessage(
            LOCAL_USER_ID,
            context.chatId,
            {
              role: "system",
              content: [
                {
                  type: "text",
                  text:
                    turn.status === "interrupted"
                      ? "Turn interrupted in the Codex console."
                      : "The Codex console turn failed.",
                },
              ],
              idempotencyKey: `codex-sync:${turn.id}:status`,
            },
            syncAttribution,
          );
        }
      }
      if (sync.turns.length > 0) {
        if (syncExecution.executionLaneId && sync.status !== "running") {
          await repository.finishChatExecutionLane(
            context.chatId,
            syncExecution.executionLaneId,
            sync.status,
          );
        } else {
          await repository.setChatStatus(context.chatId, sync.status);
        }
        if (sync.status === "idle") {
          if (!(await continuePendingWorktreeTransition(context.chatId))) {
            void dispatchNextQueuedPrompt(context.chatId);
          }
        }
      }
      return reply.send(sync);
    },
  );

  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/messages",
    async (request, reply) => {
      const messages = await repository.listMessages(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      return reply.send(chatMessageListSchema.parse(messages));
    },
  );

  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/skills",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (!context) return reply.code(404).send({ error: "Chat not found." });
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        const runtime = await runtimeForContext(context);
        if (!runtime) {
          return reply
            .code(409)
            .send({ error: "Choose a model before listing skills." });
        }
        const skills = await bridge.request(context.workerId, {
          type: "skills.list",
          cwd: context.cwd,
          model: runtime.model,
          provider: runtime.provider,
        });
        return reply.send(skillListSchema.parse(skills));
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/messages",
    async (request, reply) => {
      const input = chatMessageCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const message = await repository.appendMessage(
        LOCAL_USER_ID,
        request.params.chatId,
        input.data,
      );
      if (!message) {
        return reply.code(404).send({ error: "Chat not found" });
      }
      return reply.code(201).send(chatMessageSchema.parse(message));
    },
  );

  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/model",
    async (request, reply) => {
      const input = chatModelUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const result = await repository.setChatModel(
        LOCAL_USER_ID,
        request.params.chatId,
        input.data,
      );
      if (!result) {
        return reply.code(404).send({ error: "Chat or model not found." });
      }
      return reply.send(chatSummarySchema.parse(result));
    },
  );

  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/queue",
    async (request, reply) => {
      return reply.send(
        queuedPromptListSchema.parse(
          await repository.listQueuedPrompts(
            LOCAL_USER_ID,
            request.params.chatId,
          ),
        ),
      );
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/queue",
    async (request, reply) => {
      const input = queuedPromptCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (!context) return reply.code(404).send({ error: "Chat not found." });
      let modelId: string;
      try {
        modelId = await resolveModelId(context, input.data.modelId);
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
      const prompt = await repository.createQueuedPrompt(
        LOCAL_USER_ID,
        context.chatId,
        input.data,
        modelId,
      );
      if (!prompt) return reply.code(404).send({ error: "Chat not found." });
      if (!prompt.frozen) void dispatchNextQueuedPrompt(context.chatId);
      return reply.code(201).send(queuedPromptSchema.parse(prompt));
    },
  );

  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/queue/order",
    async (request, reply) => {
      const input = queuedPromptOrderSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const reordered = await repository.reorderQueuedPrompts(
        LOCAL_USER_ID,
        request.params.chatId,
        input.data,
      );
      return reordered
        ? reply.code(204).send()
        : reply.code(400).send({ error: "Queued prompt order is invalid." });
    },
  );

  app.patch<{ Params: { promptId: string } }>(
    "/api/queued-prompts/:promptId",
    async (request, reply) => {
      const input = queuedPromptUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const prompt = await repository.updateQueuedPrompt(
        LOCAL_USER_ID,
        request.params.promptId,
        input.data,
      );
      if (!prompt) {
        return reply.code(404).send({ error: "Queued prompt not found." });
      }
      if (!prompt.frozen) void dispatchNextQueuedPrompt(prompt.chatId);
      return reply.send(queuedPromptSchema.parse(prompt));
    },
  );

  app.delete<{ Params: { promptId: string } }>(
    "/api/queued-prompts/:promptId",
    async (request, reply) => {
      const prompt = await repository.deleteQueuedPrompt(
        LOCAL_USER_ID,
        request.params.promptId,
      );
      return prompt
        ? reply.code(204).send()
        : reply.code(404).send({ error: "Queued prompt not found." });
    },
  );

  app.post<{ Params: { promptId: string } }>(
    "/api/queued-prompts/:promptId/steer",
    async (request, reply) => {
      const queued = await repository.getQueuedPrompt(
        LOCAL_USER_ID,
        request.params.promptId,
      );
      if (!queued) {
        return reply.code(404).send({ error: "Queued prompt not found." });
      }
      let context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        queued.chatId,
      );
      if (!context) return reply.code(404).send({ error: "Chat not found." });

      try {
        let message: ChatMessage;
        if (context.status === "running") {
          if (queued.worktreeId && queued.worktreeId !== context.worktreeId) {
            throw new Error(
              "This prompt is pinned to another worktree and cannot steer the active turn.",
            );
          }
          if (!bridge.isConnected(context.workerId)) {
            throw new Error("The active Codex thread is unavailable.");
          }
          const runtime = await runtimeForContext(context);
          if (!runtime) throw new Error("Selected model was not found.");
          await bridge.request(context.workerId, {
            type: "chat.steer",
            chatId: context.chatId,
            threadId: context.threadId,
            prompt: queued.text,
            model: runtime.model,
            provider: runtime.provider,
          });
          const appended = await repository.appendMessage(
            LOCAL_USER_ID,
            context.chatId,
            {
              role: "user",
              content: [{ type: "text", text: queued.text }],
              idempotencyKey: `steer:${queued.id}`,
            },
            context.executionLaneId
              ? {
                  executionLaneId: context.executionLaneId,
                  worktreeId: context.worktreeId,
                }
              : undefined,
          );
          if (!appended) throw new Error("Chat not found.");
          message = appended;
        } else {
          if (queued.worktreeId && queued.worktreeId !== context.worktreeId) {
            await repository.updateChatWorktree(LOCAL_USER_ID, context.chatId, {
              worktreeId: queued.worktreeId,
              mode: context.worktreeMode,
            });
            const selected = await repository.getChatExecutionContext(
              LOCAL_USER_ID,
              context.chatId,
            );
            if (!selected) throw new Error("Worktree could not be selected.");
            context = selected;
          }
          message = await beginTurn(context, {
            text: queued.text,
            modelId: queued.modelId,
            idempotencyKey: `queue:${queued.id}`,
          });
        }
        await repository.deleteQueuedPrompt(LOCAL_USER_ID, queued.id);
        return reply.send(
          chatPromptSteerResultSchema.parse({ steered: true, message }),
        );
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/turns",
    async (request, reply) => {
      const input = chatTurnCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found" });
      }
      const existing = await repository.getMessageByIdempotencyKey(
        LOCAL_USER_ID,
        context.chatId,
        input.data.idempotencyKey,
      );
      if (existing) {
        return reply.send(
          chatPromptSubmitResultSchema.parse({
            status: "started",
            message: existing,
          }),
        );
      }
      if (context.status === "running") {
        let modelId: string;
        try {
          modelId = await resolveModelId(context, input.data.modelId);
        } catch (error) {
          return reply.code(409).send({ error: errorMessage(error) });
        }
        const prompt = await repository.createQueuedPrompt(
          LOCAL_USER_ID,
          context.chatId,
          { ...input.data, modelId, frozen: false, worktreeId: null },
          modelId,
        );
        return prompt
          ? reply.code(202).send(
              chatPromptSubmitResultSchema.parse({
                status: "queued",
                prompt,
              }),
            )
          : reply.code(404).send({ error: "Chat not found." });
      }

      try {
        const message = await beginTurn(context, input.data);
        return reply.code(202).send(
          chatPromptSubmitResultSchema.parse({
            status: "started",
            message,
          }),
        );
      } catch (error) {
        const message = errorMessage(error);
        const status = message.includes("offline")
          ? 503
          : message.includes("model") || message.includes("Model")
            ? 409
            : 400;
        return reply.code(status).send({ error: message });
      }
    },
  );

  app.post(
    "/api/internal/agent-tools/worktree",
    { logLevel: "warn" },
    async (request, reply) => {
      if (request.headers.authorization !== `Bearer ${config.workerToken}`) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const input = agentWorktreeToolCallSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const attribution = {
        executionLaneId: input.data.executionLaneId,
        worktreeId: "",
      };
      try {
        const context = await repository.getChatExecutionContext(
          LOCAL_USER_ID,
          input.data.chatId,
        );
        if (!context) throw new Error("Chat execution context not found.");
        attribution.worktreeId = context.worktreeId;
        const result = await executeAgentWorktreeTool(input.data);
        await repository.upsertMessage(
          LOCAL_USER_ID,
          input.data.chatId,
          {
            role: "assistant",
            content: [
              {
                type: "activity",
                activity: {
                  type: "worktree",
                  id: `worktree-tool:${input.data.callId}`,
                  operation: input.data.tool,
                  status: "completed",
                  summary: result.summary,
                  worktreeId: result.worktreeId,
                },
              },
            ],
            idempotencyKey: `worktree-tool:${input.data.callId}`,
          },
          attribution,
        );
        return reply.send(agentWorktreeToolResultSchema.parse(result));
      } catch (error) {
        if (attribution.worktreeId) {
          await repository.upsertMessage(
            LOCAL_USER_ID,
            input.data.chatId,
            {
              role: "assistant",
              content: [
                {
                  type: "activity",
                  activity: {
                    type: "worktree",
                    id: `worktree-tool:${input.data.callId}`,
                    operation: input.data.tool,
                    status: "failed",
                    summary: errorMessage(error),
                    worktreeId: null,
                  },
                },
              ],
              idempotencyKey: `worktree-tool:${input.data.callId}`,
            },
            attribution,
          );
        }
        const status =
          error instanceof WorkerUnavailableError
            ? 503
            : error instanceof ExecutionLaneConflictError
              ? 409
              : 400;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.post(
    "/api/internal/workers/heartbeat",
    { logLevel: "warn" },
    async (request, reply) => {
      if (request.headers.authorization !== `Bearer ${config.workerToken}`) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const heartbeat = workerHeartbeatSchema.safeParse(request.body);
      if (!heartbeat.success) {
        return reply.code(400).send({
          error: "Invalid worker heartbeat",
          issues: heartbeat.error.issues,
        });
      }
      const worker = await repository.recordWorker(heartbeat.data);
      void resumePendingWorktreeTransitionsForWorker(heartbeat.data.workerId);
      return reply.code(202).send(worker);
    },
  );

  app.get<{ Querystring: { workerId?: string } }>(
    "/api/internal/workers/connect",
    { websocket: true },
    (socket, request) => {
      if (
        request.headers.authorization !== `Bearer ${config.workerToken}` ||
        !request.query.workerId
      ) {
        socket.close(1008, "Unauthorized");
        return;
      }
      bridge.attach(request.query.workerId, socket);
      void resumePendingWorktreeTransitionsForWorker(request.query.workerId);
    },
  );

  app.addHook("onClose", async () => {
    bridge.close();
    await Promise.allSettled(projectSetupTasks);
    await database.close();
  });

  return app;
}
