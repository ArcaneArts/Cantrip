import { randomUUID } from "node:crypto";

import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import {
  agentWorktreeToolCallSchema,
  agentWorktreeToolResultSchema,
  agentThreadSyncSchema,
  agentTurnResultSchema,
  agentInteractionAcceptedSchema,
  agentInteractionRequestListSchema,
  agentInteractionRequestQuerySchema,
  agentInteractionRequestSchema,
  agentInteractionResolutionCreateSchema,
  browserCreateSchema,
  browserListSchema,
  browserSummarySchema,
  browserUpdateSchema,
  codexAuthStatusSchema,
  codexDeviceLoginSchema,
  chatCompactAcceptedSchema,
  chatAttachmentKindSchema,
  chatAttachmentSourceSchema,
  chatAttachmentSummarySchema,
  chatGoalClearSchema,
  chatGoalCreateSchema,
  chatGoalResponseSchema,
  chatGoalUpdateSchema,
  chatInterruptAcceptedSchema,
  chatPlanAcceptedSchema,
  chatPlanAnswerSchema,
  chatPlanStateSchema,
  chatPlanUpdateSchema,
  chatPermissionProfileStateSchema,
  chatPermissionProfileUpdateSchema,
  chatPauseStateSchema,
  chatPauseUpdateSchema,
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
  permissionProfileCapabilitySchema,
  queuedPromptCreateSchema,
  queuedPromptListSchema,
  queuedPromptOrderSchema,
  queuedPromptSchema,
  queuedPromptUpdateSchema,
  remoteDesktopCreateSchema,
  remoteDesktopProbeResultSchema,
  remoteDesktopListSchema,
  remoteDesktopSummarySchema,
  remoteSurfaceAttachResultSchema,
  remoteSurfaceConnectionMessageSchema,
  remoteSurfaceCreateSchema,
  remoteSurfaceListSchema,
  remoteSurfaceSummarySchema,
  remoteSurfaceUpdateSchema,
  remoteSurfaceViewportSchema,
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
  workerAttachmentReadResultSchema,
  workerAttachmentUploadResultSchema,
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
import type {
  AgentActivity,
  ChatMessage,
  ChatSummary,
  ChatTurnCreate,
} from "@cantrip/protocol";
import type {
  AgentWorktreeToolCall,
  AgentWorktreeToolResult,
} from "@cantrip/protocol";

import type { ServerConfig } from "./config.js";
import type { DatabaseConnection } from "./db/index.js";
import {
  AgentInteractionConflictError,
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

function chatIsExecuting(status: ChatSummary["status"]): boolean {
  return status === "running" || status === "waiting-for-approval";
}

const DEFAULT_PERMISSION_PROFILE_ID = ":workspace";

function effectivePermissionProfile(context: ChatExecutionContext) {
  const selectedId =
    context.permissionProfileId ?? DEFAULT_PERMISSION_PROFILE_ID;
  const forcedByWorktreePolicy =
    context.isPrimary && context.worktreePolicy === "required-for-writes";
  return {
    selectedId,
    effectiveId: forcedByWorktreePolicy ? ":read-only" : selectedId,
    forcedByWorktreePolicy,
  };
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
const MAX_ATTACHMENT_BYTES = 25 * 1_024 * 1_024;
const ATTACHMENT_CHUNK_BYTES = 256 * 1_024;
const AGENT_INTERACTION_EXPIRY_SWEEP_MS = 1_000;
const GOAL_RESUME_PROMPT =
  "Continue working toward the active goal. Reassess progress, make the next useful scoped change, validate it, and update the goal status when it is complete or genuinely blocked.";

function canFailOverRoute(error: unknown): boolean {
  return /(quota|usage limit|rate.?limit|\b429\b|unauthori[sz]ed|\b401\b|forbidden|\b403\b|authentication|credentials|model.+(?:not found|unavailable)|\b404\b|timed? out|timeout|ECONN|connection|network|socket|\b5\d\d\b|service unavailable|overloaded)/i.test(
    errorMessage(error),
  );
}

function activityContinuationSummary(activity: AgentActivity): string {
  switch (activity.type) {
    case "command":
      return `[command: ${activity.command}]`;
    case "fileChange":
      return `[files: ${activity.changes.map((change) => change.path).join(", ")}]`;
    case "worktree":
      return `[worktree: ${activity.summary}]`;
    case "plan":
      return `[plan: ${activity.text || activity.explanation || `${activity.steps.length} steps`}]`;
    case "reasoning":
      return `[reasoning summary: ${activity.summary.join(" ")}]`;
    case "mcpToolCall":
      return `[MCP tool: ${activity.server}/${activity.tool} ${activity.status}]`;
    case "dynamicToolCall":
      return `[tool: ${activity.namespace ? `${activity.namespace}/` : ""}${activity.tool} ${activity.status}]`;
    case "collabToolCall":
      return `[collaboration: ${activity.tool} ${activity.status}]`;
    case "subAgent":
      return `[subagent: ${activity.agentPath} ${activity.kind}]`;
    case "webSearch":
      return `[web search: ${activity.query}]`;
    case "imageView":
      return `[viewed image: ${activity.path}]`;
    case "reviewMode":
      return `[review mode ${activity.state}]`;
    case "contextCompaction":
      return "[context compacted]";
    case "notice":
      return `[${activity.level}: ${activity.message}]`;
    case "usage":
      return `[usage: ${activity.last.totalTokens} tokens]`;
    case "rateLimit":
      return `[rate limit: ${activity.primary?.usedPercent ?? "unknown"}% used]`;
    case "turnSummary":
      return `[turn ${activity.status}${activity.durationMs === null ? "" : ` in ${activity.durationMs}ms`}]`;
  }
}

function continuationPrompt(messages: ChatMessage[], prompt: string): string {
  if (messages.length === 0) return prompt;
  const transcript = messages
    .slice(-100)
    .map((message) => {
      const content = message.content
        .flatMap((item) => {
          if (item.type === "text") return [item.text];
          if (item.type === "attachment") {
            return [
              `[attachment: ${item.attachment.fileName} (${item.attachment.mimeType})]`,
            ];
          }
          return [activityContinuationSummary(item.activity)];
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
  app.addContentTypeParser(
    "application/octet-stream",
    { bodyLimit: MAX_ATTACHMENT_BYTES, parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
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
  const agentInteractionExpiryTimer = setInterval(() => {
    void repository.expireAgentInteractionRequests().catch((error) => {
      app.log.error(
        { err: error },
        "Failed to expire pending agent interaction requests",
      );
    });
  }, AGENT_INTERACTION_EXPIRY_SWEEP_MS);
  agentInteractionExpiryTimer.unref();

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
      !chatIsExecuting(context.status)
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

  const permissionProfileState = async (context: ChatExecutionContext) => {
    const selection = effectivePermissionProfile(context);
    if (!bridge.isConnected(context.workerId)) {
      return chatPermissionProfileStateSchema.parse({
        ...selection,
        available: false,
        profiles: [],
        reason:
          "Project worker is offline; the legacy sandbox policy remains active.",
      });
    }
    try {
      const runtime = await runtimeForContext(context);
      if (!runtime) {
        throw new Error("Choose a model before listing permission profiles.");
      }
      const capability = permissionProfileCapabilitySchema.parse(
        await bridge.request(context.workerId, {
          type: "permission-profiles.list",
          cwd: context.cwd,
          model: runtime.model,
          provider: runtime.provider,
        }),
      );
      return chatPermissionProfileStateSchema.parse({
        ...selection,
        ...capability,
      });
    } catch (error) {
      return chatPermissionProfileStateSchema.parse({
        ...selection,
        available: false,
        profiles: [],
        reason: `Permission profiles are unavailable: ${errorMessage(error)}`,
      });
    }
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
      if (!current || chatIsExecuting(current.status)) return true;
      if (current.automationPaused) return true;
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

  const resolvePromptAttachments = async (
    context: ChatExecutionContext,
    attachmentIds: string[],
  ) => {
    const attachments = await repository.getChatAttachments(
      LOCAL_USER_ID,
      context.chatId,
      attachmentIds,
    );
    if (attachments.length !== attachmentIds.length) {
      throw new Error("One or more attachments are unavailable.");
    }
    if (attachments.some(({ workerId }) => workerId !== context.workerId)) {
      throw new Error("Attachments belong to another worker.");
    }
    return attachments;
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
      if (
        !context ||
        context.automationPaused ||
        chatIsExecuting(context.status)
      )
        return;
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
      await beginPromptTurn(context, {
        text: prompt.text,
        attachmentIds: prompt.attachments.map(({ id }) => id),
        mode: prompt.mode,
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
    input: Omit<ChatTurnCreate, "attachmentIds" | "mode"> & {
      attachmentIds?: string[];
      mode?: ChatTurnCreate["mode"];
    },
    options: {
      acquiringActor?: "agent" | "user";
      messageRole?: "system" | "user";
      purpose?: string;
      runtimes?: ModelRuntime[];
      workerPrompt?: string;
    } = {},
  ): Promise<ChatMessage> {
    if (!bridge.isConnected(context.workerId)) {
      throw new Error("Project worker is offline.");
    }
    const modelId = await resolveModelId(context, input.modelId);
    const runtimes =
      options.runtimes ?? (await availableModelRuntimes(context, modelId));
    const attachments = await resolvePromptAttachments(
      context,
      input.attachmentIds ?? [],
    );
    const turnMode = input.mode ?? "default";
    const turnPlanMode = turnMode === "plan" ? "plan" : "default";
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
      await repository.updateChatPlanMode(
        LOCAL_USER_ID,
        execution.chatId,
        turnPlanMode,
      );
      priorMessages = await repository.listMessages(
        LOCAL_USER_ID,
        execution.chatId,
      );
      const appended = await repository.appendMessage(
        LOCAL_USER_ID,
        execution.chatId,
        {
          role: options.messageRole ?? "user",
          mode: options.messageRole === "system" ? undefined : turnMode,
          content: [
            ...(input.text
              ? [{ type: "text" as const, text: input.text }]
              : []),
            ...attachments.map((attachment) => ({
              type: "attachment" as const,
              attachment: chatAttachmentSummarySchema.parse(attachment),
            })),
          ],
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
          const finalAgentTurns = new Set<string>();
          const requestedPrompt =
            options.workerPrompt ??
            (input.text ||
              "Review the attached files and respond to the user.");
          const workerPrompt = threadId
            ? requestedPrompt
            : continuationPrompt(priorMessages, requestedPrompt);
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
                isPrimary: execution.isPrimary,
                worktreeMode: execution.worktreeMode,
                worktreePolicy: execution.worktreePolicy,
                prompt: workerPrompt,
                attachments: attachments.map((attachment) => ({
                  id: attachment.id,
                  fileName: attachment.fileName,
                  mimeType: attachment.mimeType,
                  sizeBytes: attachment.sizeBytes,
                  kind: attachment.kind,
                })),
                skillNames: mentionedSkillNames(input.text),
                model: runtime.model,
                provider: runtime.provider,
                permissionProfileId:
                  effectivePermissionProfile(execution).effectiveId,
                planMode: turnPlanMode,
                automationPaused: execution.automationPaused,
              },
              {
                timeoutMs: null,
                onEvent: async (event) => {
                  attemptActivity = true;
                  anyActivity = true;
                  if (event.type === "agent.interaction.requested") {
                    try {
                      await repository.recordAgentInteractionRequest({
                        requestKey: event.request.requestKey,
                        projectId: execution.projectId,
                        provenance: {
                          chatId: execution.chatId,
                          threadId: event.request.threadId,
                          turnId: event.request.turnId,
                          itemId: event.request.itemId,
                          executionLaneId,
                          workflowRunId: null,
                          workflowNodeId: null,
                          workerId: execution.workerId,
                        },
                        payload: event.request.payload,
                        expiresAt: event.request.expiresAt,
                      });
                    } catch (error) {
                      try {
                        await bridge.request(execution.workerId, {
                          type: "agent.interaction.cancel",
                          requestKey: event.request.requestKey,
                          reason:
                            "Cantrip could not persist the interaction safely.",
                          model: runtime.model,
                          provider: runtime.provider,
                        });
                      } catch {
                        // The turn failure below remains fail closed.
                      }
                      throw error;
                    }
                    return;
                  }
                  if (
                    event.type === "agent.interaction.cleared" ||
                    event.type === "agent.interaction.expired"
                  ) {
                    await repository.terminalizeAgentInteractionRequestFromWorker(
                      event.requestKey,
                      execution.chatId,
                      execution.workerId,
                      event.type === "agent.interaction.expired"
                        ? "expired"
                        : "interrupted",
                    );
                    return;
                  }
                  if (event.type === "agent.message") {
                    const turnId = event.message.correlation?.turnId;
                    await repository.upsertMessage(
                      LOCAL_USER_ID,
                      execution.chatId,
                      {
                        role: "assistant",
                        content: [
                          {
                            type: "text",
                            text: event.message.text,
                            phase: event.message.phase,
                            correlation: event.message.correlation,
                          },
                        ],
                        idempotencyKey: `agent-message:${turnId ?? userMessage.id}:${event.message.id}`,
                      },
                      attribution,
                    );
                    if (event.message.phase !== "commentary" && turnId) {
                      finalAgentTurns.add(turnId);
                    }
                    return;
                  }
                  if (event.type === "agent.checkpoint") {
                    if (!event.text.trim()) return;
                    if (finalAgentTurns.has(event.turnId)) return;
                    await repository.upsertMessage(
                      LOCAL_USER_ID,
                      execution.chatId,
                      {
                        role: "assistant",
                        content: [
                          {
                            type: "text",
                            text: event.text,
                            phase: "final_answer",
                          },
                        ],
                        idempotencyKey: `goal-checkpoint:${userMessage.id}:${event.turnId}`,
                      },
                      attribution,
                    );
                    return;
                  }
                  if (event.type === "agent.plan.updated") {
                    await repository.updateChatPlanSnapshot(
                      execution.chatId,
                      event.explanation,
                      event.steps,
                    );
                    return;
                  }
                  if (event.type === "agent.plan.question") {
                    await repository.setPendingPlanQuestion(
                      execution.chatId,
                      event.question,
                    );
                    return;
                  }
                  if (event.type === "agent.plan.question-resolved") {
                    const state = await repository.getChatPlanState(
                      LOCAL_USER_ID,
                      execution.chatId,
                    );
                    if (state?.question?.id === event.questionId) {
                      await repository.setPendingPlanQuestion(
                        execution.chatId,
                        null,
                      );
                    }
                    return;
                  }
                  if (event.type !== "agent.activity") return;
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
            if (!result.turnId || !finalAgentTurns.has(result.turnId)) {
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
                      phase: "final_answer",
                    },
                  ],
                  idempotencyKey: `assistant:${userMessage.id}`,
                },
                attribution,
              );
            }
            await repository.interruptAgentInteractionRequests(
              execution.chatId,
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
        await repository.interruptAgentInteractionRequests(execution.chatId);
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

  async function beginGoalTurn(
    context: ChatExecutionContext,
    input: ChatTurnCreate,
  ): Promise<ChatMessage> {
    if (!input.text) throw new Error("Goal mode needs a text objective.");
    if (!bridge.isConnected(context.workerId)) {
      throw new Error("Project worker is offline.");
    }
    await resolvePromptAttachments(context, input.attachmentIds);
    const modelId = await resolveModelId(context, input.modelId);
    const runtime = (await availableModelRuntimes(context, modelId))[0]!;
    const result = chatGoalResponseSchema.parse(
      await bridge.request(context.workerId, {
        type: "chat.goal.create",
        chatId: context.chatId,
        cwd: context.cwd,
        threadId: context.threadId,
        objective: input.text,
        tokenBudget: null,
        model: runtime.model,
        provider: runtime.provider,
        permissionProfileId: effectivePermissionProfile(context).effectiveId,
      }),
    );
    if (!result.goal) throw new Error("Codex did not create the goal.");
    await repository.updateChatRuntime(
      context.chatId,
      context.workerId,
      context.worktreeId,
      result.goal.threadId,
      runtime.routeId,
    );
    const updatedContext = await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      context.chatId,
    );
    if (!updatedContext) throw new Error("Chat source not found.");
    return beginTurn(
      updatedContext,
      { ...input, modelId, mode: "goal" },
      { purpose: "Codex goal", runtimes: [runtime] },
    );
  }

  function beginPromptTurn(
    context: ChatExecutionContext,
    input: ChatTurnCreate,
  ): Promise<ChatMessage> {
    return input.mode === "goal"
      ? beginGoalTurn(context, input)
      : beginTurn(context, input);
  }

  const resumeChatAutomation = async (chatId: string): Promise<void> => {
    let context = await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    );
    if (
      !context ||
      context.automationPaused ||
      chatIsExecuting(context.status) ||
      !bridge.isConnected(context.workerId)
    ) {
      return;
    }
    if (await continuePendingWorktreeTransition(chatId)) return;
    context = await repository.getChatExecutionContext(LOCAL_USER_ID, chatId);
    if (
      !context ||
      context.automationPaused ||
      chatIsExecuting(context.status)
    ) {
      return;
    }
    if (context.threadId) {
      const runtime = await runtimeForContext(context);
      if (!runtime) throw new Error("Selected model was not found.");
      const result = chatGoalResponseSchema.parse(
        await bridge.request(context.workerId, {
          type: "chat.goal.get",
          chatId: context.chatId,
          cwd: context.cwd,
          threadId: context.threadId,
          model: runtime.model,
          provider: runtime.provider,
          permissionProfileId: effectivePermissionProfile(context).effectiveId,
        }),
      );
      if (result.goal?.status === "active") {
        const modelId = await resolveModelId(context);
        await beginTurn(
          context,
          {
            text: `Resume goal: ${result.goal.objective}`,
            mode: "goal",
            modelId,
            idempotencyKey: `chat-resume:${result.goal.updatedAt}:${randomUUID()}`,
          },
          {
            acquiringActor: "agent",
            purpose: "Resume paused Codex goal",
            runtimes: [runtime],
            workerPrompt: GOAL_RESUME_PROMPT,
          },
        );
        return;
      }
    }
    await dispatchNextQueuedPrompt(chatId);
  };

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
          worktrees: true,
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

  app.get<{
    Querystring: { chatId?: string; limit?: string; status?: string };
  }>("/api/agent-requests", async (request, reply) => {
    const query = agentInteractionRequestQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send(invalidBody(query.error.issues));
    }
    const requests = await repository.listAgentInteractionRequests(
      LOCAL_USER_ID,
      query.data,
    );
    return reply.send(agentInteractionRequestListSchema.parse(requests));
  });

  app.get<{ Params: { requestId: string } }>(
    "/api/agent-requests/:requestId",
    async (request, reply) => {
      const interaction = await repository.getAgentInteractionRequest(
        LOCAL_USER_ID,
        request.params.requestId,
      );
      if (!interaction) {
        return reply.code(404).send({ error: "Agent request not found." });
      }
      return reply.send(agentInteractionRequestSchema.parse(interaction));
    },
  );

  app.post<{ Params: { requestId: string } }>(
    "/api/agent-requests/:requestId/respond",
    async (request, reply) => {
      const input = agentInteractionResolutionCreateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const existing = await repository.validateAgentInteractionResolution(
          LOCAL_USER_ID,
          request.params.requestId,
          input.data,
        );
        if (!existing) {
          return reply.code(404).send({ error: "Agent request not found." });
        }
        if (existing.status !== "pending") {
          const replay = await repository.resolveAgentInteractionRequest(
            LOCAL_USER_ID,
            request.params.requestId,
            input.data,
          );
          return reply.send(agentInteractionRequestSchema.parse(replay));
        }
        if (!existing.provenance.chatId) {
          return reply.code(409).send({
            error: "Workflow interaction delivery is not available yet.",
          });
        }
        const context = await repository.getChatExecutionContext(
          LOCAL_USER_ID,
          existing.provenance.chatId,
        );
        if (
          !context ||
          context.workerId !== existing.provenance.workerId ||
          context.executionLaneId !== existing.provenance.executionLaneId
        ) {
          return reply.code(409).send({
            error: "The interaction execution lane is no longer active.",
          });
        }
        if (!bridge.isConnected(context.workerId)) {
          return reply.code(503).send({ error: "Project worker is offline." });
        }
        const runtime = await runtimeForContext(context);
        if (!runtime) {
          return reply
            .code(409)
            .send({ error: "Selected model was not found." });
        }
        try {
          agentInteractionAcceptedSchema.parse(
            await bridge.request(
              context.workerId,
              {
                type: "agent.interaction.respond",
                requestKey: existing.requestKey,
                response: input.data.response,
                model: runtime.model,
                provider: runtime.provider,
              },
              { timeoutMs: 30_000 },
            ),
          );
        } catch (error) {
          const status = error instanceof WorkerUnavailableError ? 503 : 409;
          return reply.code(status).send({
            error: `The runtime no longer accepts this interaction: ${errorMessage(error)}`,
          });
        }
        const interaction = await repository.resolveAgentInteractionRequest(
          LOCAL_USER_ID,
          request.params.requestId,
          input.data,
        );
        return reply.send(agentInteractionRequestSchema.parse(interaction));
      } catch (error) {
        if (error instanceof WorkerUnavailableError) {
          return reply.code(503).send({ error: error.message });
        }
        if (error instanceof AgentInteractionConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

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
        const result = worktreeStatusResultSchema.parse(
          await bridge.request(context.workerId, {
            type: "worktree.status",
            sourcePath: context.sourcePath,
            worktreePath: context.worktree.path,
          }),
        );
        await repository.observeProjectWorktree(
          LOCAL_USER_ID,
          request.params.projectId,
          request.params.worktreeId,
          result.worktree,
        );
        return reply.send(result);
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
        const revisions = (
          await repository.listProjectWorktrees(
            LOCAL_USER_ID,
            request.params.projectId,
          )
        )
          .map(({ head }) => head)
          .filter(
            (head): head is string =>
              typeof head === "string" && /^[0-9a-f]{40,64}$/u.test(head),
          );
        const history = await bridge.request(context.workerId, {
          type: "git.history",
          cwd: context.worktree.path,
          cursor,
          limit,
          revisions,
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
        revisions: [],
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
          await bridge
            .request(surface.workerId, {
              type: "surface.close",
              surfaceId: surface.id,
            })
            .catch(() => undefined);
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
      const source = await repository.getProjectSource(
        LOCAL_USER_ID,
        request.params.projectId,
      );
      if (!source) return reply.code(404).send({ error: "Project not found." });
      const worker = (await repository.listWorkers(LOCAL_USER_ID)).find(
        ({ workerId }) => workerId === source.workerId,
      );
      if (!worker) return reply.code(404).send({ error: "Worker not found." });
      if (!worker.remoteSurfaces.desktop) {
        return reply.code(409).send({
          error: "The project worker does not support managed Remote Desktop.",
        });
      }
      if (!bridge.isConnected(worker.workerId)) {
        return reply.code(409).send({ error: "Worker is offline." });
      }

      const desktopId = randomUUID();
      try {
        const probe = remoteDesktopProbeResultSchema.parse(
          await bridge.request(
            worker.workerId,
            { type: "surface.desktop.probe" },
            { timeoutMs: 20_000 },
          ),
        );
        if (!probe.available) {
          return reply.code(409).send({
            error:
              probe.message ??
              "The project worker could not start managed Remote Desktop.",
          });
        }
        const desktop = await repository.createRemoteDesktop(
          LOCAL_USER_ID,
          request.params.projectId,
          desktopId,
          worker.workerId,
        );
        if (!desktop) {
          return reply
            .code(404)
            .send({ error: "Project or worker not found." });
        }
        return reply.code(201).send(remoteDesktopSummarySchema.parse(desktop));
      } catch (error) {
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
      if (input.data.configuration.kind === "desktop") {
        return reply.code(400).send({
          error:
            "Create desktop surfaces through the managed Remote Desktop endpoint.",
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
      if (input.data.configuration?.kind === "desktop") {
        return reply.code(400).send({
          error:
            "Desktop surface configuration is managed by the project worker.",
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
        void bridge
          .request(context.workerId, {
            type: "surface.close",
            surfaceId: context.surface.id,
          })
          .catch((error) => {
            app.log.warn(
              { err: error, surfaceId: context.surface.id },
              "Could not close deleted Remote Surface",
            );
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
        const desktopStream =
          context.surface.kind === "desktop"
            ? await repository
                .getUserSettings(LOCAL_USER_ID)
                .then((preferences) => ({
                  targetFps: preferences.desktopFrameRate,
                  quality: preferences.desktopStreamQuality,
                }))
            : null;
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
                desktopStream,
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
      if (chatIsExecuting(context.status)) {
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
        permissionProfileId: effectivePermissionProfile(context).effectiveId,
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
      if (
        !context.threadId ||
        !["running", "waiting-for-approval"].includes(context.status)
      ) {
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
      const parsedResult = chatInterruptAcceptedSchema.parse(result);
      if (
        parsedResult.interrupted &&
        context.status === "waiting-for-approval"
      ) {
        await repository.interruptAgentInteractionRequests(context.chatId);
      }
      return reply.send(parsedResult);
    },
  );

  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/pause",
    async (request, reply) => {
      const input = chatPauseUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }

      if (
        !input.data.paused &&
        !bridge.isConnected(context.workerId) &&
        (context.threadId ||
          (await repository.listQueuedPrompts(LOCAL_USER_ID, context.chatId))
            .length > 0)
      ) {
        return reply.code(503).send({
          error:
            "The project worker is offline. This chat remains paused so its next action is not lost.",
        });
      }

      if (!input.data.paused && bridge.isConnected(context.workerId)) {
        try {
          await bridge.request(context.workerId, {
            type: "chat.pause.set",
            chatId: context.chatId,
            paused: false,
          });
        } catch (error) {
          return reply.code(502).send({
            error: `The worker could not resume this chat: ${errorMessage(error)}`,
          });
        }
      }

      const updated = await repository.setChatAutomationPaused(
        LOCAL_USER_ID,
        context.chatId,
        input.data.paused,
      );
      if (!updated) {
        return reply.code(404).send({ error: "Chat source not found." });
      }

      if (input.data.paused && bridge.isConnected(context.workerId)) {
        try {
          await bridge.request(context.workerId, {
            type: "chat.pause.set",
            chatId: context.chatId,
            paused: true,
          });
        } catch (error) {
          return reply.code(502).send({
            error: `Automatic dispatch is paused, but the active worker could not be notified: ${errorMessage(error)}`,
          });
        }
      }

      if (!input.data.paused) {
        try {
          await resumeChatAutomation(context.chatId);
        } catch (error) {
          await repository.setChatAutomationPaused(
            LOCAL_USER_ID,
            context.chatId,
            true,
          );
          if (bridge.isConnected(context.workerId)) {
            await bridge
              .request(context.workerId, {
                type: "chat.pause.set",
                chatId: context.chatId,
                paused: true,
              })
              .catch(() => undefined);
          }
          return reply.code(409).send({
            error: `This chat remains paused because its next action could not start: ${errorMessage(error)}`,
          });
        }
      }

      return reply.send(
        chatPauseStateSchema.parse({ paused: input.data.paused }),
      );
    },
  );

  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/plan",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (context.threadId && bridge.isConnected(context.workerId)) {
        try {
          const runtime = await runtimeForContext(context);
          if (runtime) {
            const result = (await bridge.request(context.workerId, {
              type: "chat.plan.get",
              cwd: context.cwd,
              threadId: context.threadId,
              fallbackMode: context.planMode,
              model: runtime.model,
              provider: runtime.provider,
              permissionProfileId:
                effectivePermissionProfile(context).effectiveId,
            })) as { mode?: unknown };
            const mode = chatPlanUpdateSchema.safeParse({ mode: result.mode });
            if (mode.success && mode.data.mode !== context.planMode) {
              await repository.updateChatPlanMode(
                LOCAL_USER_ID,
                context.chatId,
                mode.data.mode,
              );
            }
          }
        } catch (error) {
          app.log.warn(
            { chatId: context.chatId, err: error },
            "Could not refresh native Plan Mode state",
          );
        }
      }
      const state = await repository.getChatPlanState(
        LOCAL_USER_ID,
        context.chatId,
      );
      return reply.send(chatPlanStateSchema.parse(state));
    },
  );

  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/plan",
    async (request, reply) => {
      const input = chatPlanUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
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
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        const modelId = await resolveModelId(context);
        const runtime =
          (await runtimeForContext(context)) ??
          (await availableModelRuntimes(context, modelId))[0]!;
        const result = (await bridge.request(context.workerId, {
          type: "chat.plan.set",
          cwd: context.cwd,
          threadId: context.threadId,
          mode: input.data.mode,
          model: runtime.model,
          provider: runtime.provider,
          permissionProfileId: effectivePermissionProfile(context).effectiveId,
        })) as { mode: unknown; threadId: unknown };
        const nativeMode = chatPlanUpdateSchema.parse({ mode: result.mode });
        if (typeof result.threadId !== "string" || !result.threadId) {
          throw new Error("Codex did not return a Plan Mode thread.");
        }
        await repository.updateChatRuntime(
          context.chatId,
          context.workerId,
          context.worktreeId,
          result.threadId,
          runtime.routeId,
        );
        const state = await repository.updateChatPlanMode(
          LOCAL_USER_ID,
          context.chatId,
          nativeMode.mode,
        );
        return reply.send(chatPlanStateSchema.parse(state));
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/plan/answer",
    async (request, reply) => {
      const input = chatPlanAnswerSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      const state = await repository.getChatPlanState(
        LOCAL_USER_ID,
        context.chatId,
      );
      if (!state?.question) {
        return reply
          .code(409)
          .send({ error: "This chat has no pending Plan Mode question." });
      }
      const expectedIds = new Set(
        state.question.questions.map((question) => question.id),
      );
      const answerIds = Object.keys(input.data.answers);
      if (
        answerIds.length !== expectedIds.size ||
        answerIds.some((id) => !expectedIds.has(id))
      ) {
        return reply
          .code(400)
          .send({ error: "Answer every pending Plan Mode question once." });
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        const runtime = await runtimeForContext(context);
        if (!runtime) throw new Error("Selected model was not found.");
        const result = await bridge.request(context.workerId, {
          type: "chat.plan.answer",
          questionId: state.question.id,
          answers: input.data.answers,
          model: runtime.model,
          provider: runtime.provider,
        });
        const accepted = chatPlanAcceptedSchema.parse(result);
        if (accepted.requestKey) {
          const interaction = await repository.getAgentInteractionRequestByKey(
            LOCAL_USER_ID,
            accepted.requestKey,
          );
          if (interaction?.status === "pending") {
            await repository.resolveAgentInteractionRequest(
              LOCAL_USER_ID,
              interaction.id,
              {
                idempotencyKey: `plan-answer:${accepted.requestKey}`,
                response: {
                  kind: "userInput",
                  answers: Object.fromEntries(
                    Object.entries(input.data.answers).map(([id, answers]) => [
                      id,
                      { answers },
                    ]),
                  ),
                },
              },
            );
          }
        }
        const latest = await repository.getChatPlanState(
          LOCAL_USER_ID,
          context.chatId,
        );
        if (latest?.question?.id === state.question.id) {
          await repository.setPendingPlanQuestion(context.chatId, null);
        }
        return reply.send(chatPlanAcceptedSchema.parse({ accepted: true }));
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/goal",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (!context.threadId) {
        return reply.send(chatGoalResponseSchema.parse({ goal: null }));
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        const runtime = await runtimeForContext(context);
        if (!runtime) {
          return reply
            .code(409)
            .send({ error: "Selected model was not found." });
        }
        const result = await bridge.request(context.workerId, {
          type: "chat.goal.get",
          chatId: context.chatId,
          cwd: context.cwd,
          threadId: context.threadId,
          model: runtime.model,
          provider: runtime.provider,
          permissionProfileId: effectivePermissionProfile(context).effectiveId,
        });
        return reply.send(chatGoalResponseSchema.parse(result));
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/goal",
    async (request, reply) => {
      const input = chatGoalCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (chatIsExecuting(context.status)) {
        return reply
          .code(409)
          .send({ error: "Wait for the active turn to finish." });
      }
      if (context.automationPaused) {
        return reply
          .code(409)
          .send({ error: "Resume this chat before starting a goal." });
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        const modelId = await resolveModelId(context);
        const runtime = (await availableModelRuntimes(context, modelId))[0]!;
        const result = chatGoalResponseSchema.parse(
          await bridge.request(context.workerId, {
            type: "chat.goal.create",
            chatId: context.chatId,
            cwd: context.cwd,
            threadId: context.threadId,
            objective: input.data.objective,
            tokenBudget: input.data.tokenBudget ?? null,
            model: runtime.model,
            provider: runtime.provider,
            permissionProfileId:
              effectivePermissionProfile(context).effectiveId,
          }),
        );
        if (!result.goal) {
          throw new Error("Codex did not create the goal.");
        }
        await repository.updateChatRuntime(
          context.chatId,
          context.workerId,
          context.worktreeId,
          result.goal.threadId,
          runtime.routeId,
        );
        const updatedContext = await repository.getChatExecutionContext(
          LOCAL_USER_ID,
          context.chatId,
        );
        if (!updatedContext) throw new Error("Chat source not found.");
        await beginTurn(
          updatedContext,
          {
            text: input.data.objective,
            mode: "goal",
            modelId,
            idempotencyKey: `goal:${result.goal.createdAt}:${randomUUID()}`,
          },
          { purpose: "Codex goal", runtimes: [runtime] },
        );
        return reply.code(202).send(result);
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/goal",
    async (request, reply) => {
      const input = chatGoalUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (!context.threadId) {
        return reply.code(409).send({ error: "This chat has no goal." });
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        const runtime = await runtimeForContext(context);
        if (!runtime) throw new Error("Selected model was not found.");
        const result = chatGoalResponseSchema.parse(
          await bridge.request(context.workerId, {
            type: "chat.goal.update",
            chatId: context.chatId,
            cwd: context.cwd,
            threadId: context.threadId,
            status: input.data.status,
            model: runtime.model,
            provider: runtime.provider,
            permissionProfileId:
              effectivePermissionProfile(context).effectiveId,
          }),
        );
        if (
          input.data.status === "active" &&
          !context.automationPaused &&
          !chatIsExecuting(context.status) &&
          result.goal
        ) {
          const modelId = await resolveModelId(context);
          await beginTurn(
            context,
            {
              text: `Resume goal: ${result.goal.objective}`,
              mode: "goal",
              modelId,
              idempotencyKey: `goal-resume:${result.goal.updatedAt}:${randomUUID()}`,
            },
            {
              purpose: "Resume Codex goal",
              runtimes: [runtime],
              workerPrompt: GOAL_RESUME_PROMPT,
            },
          );
        }
        return reply.send(result);
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.delete<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/goal",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (!context.threadId) {
        return reply.send(chatGoalClearSchema.parse({ cleared: false }));
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        const runtime = await runtimeForContext(context);
        if (!runtime) throw new Error("Selected model was not found.");
        const result = await bridge.request(context.workerId, {
          type: "chat.goal.clear",
          chatId: context.chatId,
          cwd: context.cwd,
          threadId: context.threadId,
          model: runtime.model,
          provider: runtime.provider,
          permissionProfileId: effectivePermissionProfile(context).effectiveId,
        });
        return reply.send(chatGoalClearSchema.parse(result));
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
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
          } else if (item.type === "agentMessage") {
            await repository.upsertMessage(
              LOCAL_USER_ID,
              context.chatId,
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: item.text,
                    phase: item.phase,
                    correlation: item.correlation,
                  },
                ],
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

  app.post<{ Body: Buffer; Params: { chatId: string } }>(
    "/api/chats/:chatId/attachments",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (!context) return reply.code(404).send({ error: "Chat not found." });
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      const encodedFileName = request.headers["x-cantrip-file-name"];
      let fileName: string;
      try {
        fileName = decodeURIComponent(
          typeof encodedFileName === "string" ? encodedFileName : "",
        ).trim();
      } catch {
        fileName = "";
      }
      const mimeHeader = request.headers["x-cantrip-mime-type"];
      const mimeType =
        typeof mimeHeader === "string" &&
        /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(mimeHeader)
          ? mimeHeader
          : "application/octet-stream";
      const kind = chatAttachmentKindSchema.safeParse(
        request.headers["x-cantrip-attachment-kind"],
      );
      const source = chatAttachmentSourceSchema.safeParse(
        request.headers["x-cantrip-attachment-source"],
      );
      if (
        !fileName ||
        fileName.length > 200 ||
        !kind.success ||
        !source.success ||
        !Buffer.isBuffer(request.body) ||
        request.body.byteLength > MAX_ATTACHMENT_BYTES
      ) {
        return reply.code(400).send({ error: "Invalid attachment upload." });
      }

      const attachmentId = randomUUID();
      try {
        await bridge.request(context.workerId, {
          type: "attachment.upload.begin",
          chatId: context.chatId,
          attachmentId,
          fileName,
          sizeBytes: request.body.byteLength,
        });
        for (
          let offset = 0, chunkIndex = 0;
          offset < request.body.byteLength;
          offset += ATTACHMENT_CHUNK_BYTES, chunkIndex += 1
        ) {
          await bridge.request(context.workerId, {
            type: "attachment.upload.chunk",
            chatId: context.chatId,
            attachmentId,
            chunkIndex,
            data: request.body
              .subarray(offset, offset + ATTACHMENT_CHUNK_BYTES)
              .toString("base64"),
          });
        }
        const uploaded = workerAttachmentUploadResultSchema.parse(
          await bridge.request(context.workerId, {
            type: "attachment.upload.complete",
            chatId: context.chatId,
            attachmentId,
          }),
        );
        const previewText =
          kind.data === "text"
            ? request.body.toString("utf8", 0, 16_000).slice(0, 8_000)
            : null;
        const attachment = await repository.createChatAttachment(
          LOCAL_USER_ID,
          context.chatId,
          {
            id: attachmentId,
            workerId: context.workerId,
            fileName,
            mimeType,
            sizeBytes: uploaded.sizeBytes,
            kind: kind.data,
            source: source.data,
            previewText,
            sha256: uploaded.sha256,
          },
        );
        if (!attachment) throw new Error("Chat not found.");
        return reply
          .code(201)
          .send(chatAttachmentSummarySchema.parse(attachment));
      } catch (error) {
        try {
          await bridge.request(context.workerId, {
            type: "attachment.delete",
            chatId: context.chatId,
            attachmentId,
          });
        } catch {
          // Cleanup is best effort if the worker disconnected mid-upload.
        }
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.get<{ Params: { attachmentId: string } }>(
    "/api/attachments/:attachmentId/content",
    async (request, reply) => {
      const attachment = await repository.getChatAttachment(
        LOCAL_USER_ID,
        request.params.attachmentId,
      );
      if (!attachment) {
        return reply.code(404).send({ error: "Attachment not found." });
      }
      if (!bridge.isConnected(attachment.workerId)) {
        return reply.code(503).send({ error: "Attachment worker is offline." });
      }
      try {
        const chunks: Buffer[] = [];
        let offset = 0;
        let expectedSize = attachment.sizeBytes;
        while (offset < expectedSize || (expectedSize === 0 && offset === 0)) {
          const chunk = workerAttachmentReadResultSchema.parse(
            await bridge.request(attachment.workerId, {
              type: "attachment.read",
              chatId: attachment.chatId,
              attachmentId: attachment.id,
              fileName: attachment.fileName,
              offset,
              limit: ATTACHMENT_CHUNK_BYTES,
            }),
          );
          expectedSize = chunk.sizeBytes;
          const bytes = Buffer.from(chunk.data, "base64");
          chunks.push(bytes);
          offset += bytes.byteLength;
          if (chunk.eof) break;
          if (bytes.byteLength === 0) {
            throw new Error("Attachment worker returned an empty chunk.");
          }
        }
        const content = Buffer.concat(chunks);
        if (content.byteLength !== expectedSize) {
          throw new Error("Attachment content was truncated.");
        }
        return reply
          .header("cache-control", "private, max-age=60")
          .header(
            "content-disposition",
            `inline; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
          )
          .type(attachment.mimeType)
          .send(content);
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.delete<{ Params: { attachmentId: string } }>(
    "/api/attachments/:attachmentId",
    async (request, reply) => {
      const attachment = await repository.getChatAttachment(
        LOCAL_USER_ID,
        request.params.attachmentId,
      );
      if (!attachment) {
        return reply.code(404).send({ error: "Attachment not found." });
      }
      if (bridge.isConnected(attachment.workerId)) {
        await bridge.request(attachment.workerId, {
          type: "attachment.delete",
          chatId: attachment.chatId,
          attachmentId: attachment.id,
        });
      }
      await repository.deleteChatAttachment(LOCAL_USER_ID, attachment.id);
      return reply.code(204).send();
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
    "/api/chats/:chatId/permission-profiles",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      return reply.send(await permissionProfileState(context));
    },
  );

  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/permission-profile",
    async (request, reply) => {
      const input = chatPermissionProfileUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (chatIsExecuting(context.status)) {
        return reply
          .code(409)
          .send({ error: "Wait for the active turn or approval to finish." });
      }
      const capability = await permissionProfileState(context);
      if (!capability.available) {
        return reply.code(409).send({
          error: capability.reason ?? "Permission profiles are unavailable.",
        });
      }
      const profile = capability.profiles.find(
        (candidate) => candidate.id === input.data.id,
      );
      if (!profile) {
        return reply
          .code(400)
          .send({ error: "Codex did not advertise that permission profile." });
      }
      if (!profile.allowed) {
        return reply
          .code(409)
          .send({ error: "That permission profile is not allowed here." });
      }
      const latest = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        context.chatId,
      );
      if (!latest) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (chatIsExecuting(latest.status)) {
        return reply
          .code(409)
          .send({ error: "Wait for the active turn or approval to finish." });
      }
      const updated = await repository.setChatPermissionProfile(
        LOCAL_USER_ID,
        context.chatId,
        profile.id,
      );
      if (!updated) {
        const current = await repository.getChatExecutionContext(
          LOCAL_USER_ID,
          context.chatId,
        );
        return current
          ? reply.code(409).send({
              error: "The chat started executing before the profile changed.",
            })
          : reply.code(404).send({ error: "Chat source not found." });
      }
      const refreshed = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        context.chatId,
      );
      if (!refreshed) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      return reply.send(
        chatPermissionProfileStateSchema.parse({
          ...effectivePermissionProfile(refreshed),
          available: true,
          profiles: capability.profiles,
          reason: null,
        }),
      );
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
      let attachments: Awaited<ReturnType<typeof resolvePromptAttachments>>;
      try {
        modelId = await resolveModelId(context, input.data.modelId);
        attachments = await resolvePromptAttachments(
          context,
          input.data.attachmentIds,
        );
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
      const prompt = await repository.createQueuedPrompt(
        LOCAL_USER_ID,
        context.chatId,
        input.data,
        modelId,
        attachments.map((attachment) =>
          chatAttachmentSummarySchema.parse(attachment),
        ),
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
      const current = await repository.getQueuedPrompt(
        LOCAL_USER_ID,
        request.params.promptId,
      );
      if (!current) {
        return reply.code(404).send({ error: "Queued prompt not found." });
      }
      let attachments:
        Awaited<ReturnType<typeof resolvePromptAttachments>> | undefined;
      if (input.data.attachmentIds !== undefined) {
        const context = await repository.getChatExecutionContext(
          LOCAL_USER_ID,
          current.chatId,
        );
        if (!context) return reply.code(404).send({ error: "Chat not found." });
        try {
          attachments = await resolvePromptAttachments(
            context,
            input.data.attachmentIds,
          );
        } catch (error) {
          return reply.code(409).send({ error: errorMessage(error) });
        }
      }
      if (
        !(input.data.text ?? current.text) &&
        (attachments ?? current.attachments).length === 0
      ) {
        return reply
          .code(400)
          .send({ error: "A prompt needs text or at least one attachment." });
      }
      const prompt = await repository.updateQueuedPrompt(
        LOCAL_USER_ID,
        request.params.promptId,
        input.data,
        attachments?.map((attachment) =>
          chatAttachmentSummarySchema.parse(attachment),
        ),
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
        if (chatIsExecuting(context.status)) {
          if (queued.mode !== "default") {
            throw new Error(
              "Plan and Goal mode prompts cannot steer an active turn. Leave this prompt queued for the next turn.",
            );
          }
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
          const attachments = await resolvePromptAttachments(
            context,
            queued.attachments.map(({ id }) => id),
          );
          await bridge.request(context.workerId, {
            type: "chat.steer",
            chatId: context.chatId,
            threadId: context.threadId,
            prompt:
              queued.text ||
              "Review the attached files and respond to the user.",
            attachments: attachments.map((attachment) => ({
              id: attachment.id,
              fileName: attachment.fileName,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
              kind: attachment.kind,
            })),
            model: runtime.model,
            provider: runtime.provider,
          });
          const appended = await repository.appendMessage(
            LOCAL_USER_ID,
            context.chatId,
            {
              role: "user",
              mode: queued.mode,
              content: [
                ...(queued.text
                  ? [{ type: "text" as const, text: queued.text }]
                  : []),
                ...queued.attachments.map((attachment) => ({
                  type: "attachment" as const,
                  attachment,
                })),
              ],
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
          message = await beginPromptTurn(context, {
            text: queued.text,
            attachmentIds: queued.attachments.map(({ id }) => id),
            mode: queued.mode,
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
      if (context.automationPaused || chatIsExecuting(context.status)) {
        let modelId: string;
        let attachments: Awaited<ReturnType<typeof resolvePromptAttachments>>;
        try {
          modelId = await resolveModelId(context, input.data.modelId);
          attachments = await resolvePromptAttachments(
            context,
            input.data.attachmentIds,
          );
        } catch (error) {
          return reply.code(409).send({ error: errorMessage(error) });
        }
        const prompt = await repository.createQueuedPrompt(
          LOCAL_USER_ID,
          context.chatId,
          { ...input.data, modelId, frozen: false, worktreeId: null },
          modelId,
          attachments.map((attachment) =>
            chatAttachmentSummarySchema.parse(attachment),
          ),
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
        const message = await beginPromptTurn(context, input.data);
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
    clearInterval(agentInteractionExpiryTimer);
    bridge.close();
    await Promise.allSettled(projectSetupTasks);
    await database.close();
  });

  return app;
}
