import {
  chatMessageSchema,
  codeGraphProjectStatusSchema,
  providerAuthLiveStatusSchema,
  gitConflictListSchema,
  gitManagedOperationResponseSchema,
  gitStatusSchema,
} from "@cantrip/protocol";
import type {
  AppLiveResyncReason,
  AppLiveScope,
  AppLiveServerMessage,
  CodeGraphProjectStatus,
  CodexAuthStatus,
  GitConflictList,
  GitManagedOperationResponse,
  GitStatus,
} from "@cantrip/protocol";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { chatMessageOpaqueSummarySchema } from "@cantrip/protocol/communication-content";
import { taskMessageOpaqueSummarySchema } from "@cantrip/protocol/tasks";

import { openChatMessageOpaqueSummary } from "./chat-message-encryption";
import {
  EMPTY_CHAT_MESSAGE_LIVE_OVERLAY,
  chatMessageLiveQueryKey,
  chatMessagePagesQueryKey,
  deleteFromChatMessageLiveOverlay,
  upsertChatMessageLiveOverlay,
  type ChatMessageLiveOverlay,
} from "./chat-message-history";
import { openTaskMessageOpaqueSummary } from "./task-message-encryption";

type AppLiveEvent = Extract<AppLiveServerMessage, { type: "event" }>;

export interface AppLiveQueryBridgeStats {
  coalescedInvalidationCount: number;
  directlyAppliedEventCount: number;
  invalidatedQueryCount: number;
  invalidationFlushCount: number;
  receivedEventCount: number;
}

const MAX_TRACKED_WORKFLOW_SEQUENCES = 4_096;
const MAX_TRACKED_CODEGRAPH_REVISIONS = 4_096;
const MAX_TRACKED_PROVIDER_AUTH_REVISIONS = 4_096;

function projectScopeId(scope: AppLiveScope): string | null {
  return scope.kind === "project" ? scope.projectId : null;
}

export function appLiveEventQueryKeys(event: AppLiveEvent): QueryKey[] {
  const projectId = projectScopeId(event.scope);
  switch (event.resource) {
    case "server":
      return [["server-bootstrap"]];
    case "account-session":
      return [["account-sessions"]];
    case "account-resource-usage":
      return [["account-resource-usage"], ["account-resource-usage-history"]];
    case "settings":
      return [["settings"], ["code-settings-worker-status"]];
    case "provider-auth":
      return [["codex-auth"]];
    case "policy":
      return [
        ["policies"],
        ["workspace-policy-assignments"],
        ["project-policy-assignments"],
        ["effective-policies"],
        ...(event.entityId ? [["policy", event.entityId]] : []),
      ];
    case "worker":
      return [
        ["workers"],
        ["worker-management"],
        ["worker-enrollment-status"],
        ["desktop-worker-enrollment-status"],
        ["chat-sync"],
        ["project-repository-stats"],
      ];
    case "project":
      return projectId
        ? [
            ["projects"],
            ["project-workspaces"],
            ["project-tab-layout", projectId],
          ]
        : [["projects"], ["project-workspaces"]];
    case "project-automation":
      return projectId
        ? [["project-automations", projectId]]
        : [["project-automations"]];
    case "project-token-usage":
      return projectId
        ? [["project-token-usage", projectId]]
        : [["project-token-usage"]];
    case "project-replica-job":
      return projectId
        ? [
            ["project-replica-jobs", projectId],
            ...(event.entityId
              ? [["project-replica-job", event.entityId]]
              : []),
          ]
        : [["project-replica-jobs"]];
    case "project-folder-setup-job":
      return projectId
        ? [["project-folder-setup", projectId], ["projects"]]
        : [["project-folder-setup"], ["projects"]];
    case "project-github-conversion-job":
      return projectId
        ? [
            ["project-github-conversion", projectId],
            ["projects"],
            ["worktrees", projectId],
            ["worktree-status", projectId],
            ["github-repositories"],
          ]
        : [["project-github-conversion"], ["projects"]];
    case "project-tab-layout":
      return projectId
        ? [["project-tab-layout", projectId]]
        : event.scope.kind === "current-user"
          ? [["project-tab-layout"]]
          : [];
    case "worktree":
      return projectId
        ? [["worktrees", projectId]]
        : event.scope.kind === "current-user"
          ? [["worktrees"]]
          : [];
    case "worktree-status":
      return projectId
        ? [
            event.entityId
              ? ["worktree-status", projectId, event.entityId]
              : ["worktree-status", projectId],
            event.entityId
              ? ["worktree-history", projectId, event.entityId]
              : ["worktree-history", projectId],
            event.entityId
              ? ["git-graph-snapshot", projectId, event.entityId]
              : ["git-graph-snapshot", projectId],
            event.entityId
              ? ["git-graph-metrics", projectId, event.entityId]
              : ["git-graph-metrics", projectId],
            event.entityId
              ? ["git-graph-commit-overlay", projectId, event.entityId]
              : ["git-graph-commit-overlay", projectId],
          ]
        : event.scope.kind === "current-user"
          ? [["worktree-status"]]
          : [];
    case "codegraph-status":
      return projectId
        ? [
            event.entityId
              ? ["codegraph", projectId, event.entityId]
              : ["codegraph", projectId],
          ]
        : [];
    case "git-operation":
      return projectId
        ? [["git-operation", projectId]]
        : event.scope.kind === "current-user"
          ? [["git-operation"]]
          : [];
    case "git-conflict":
      return projectId
        ? [
            event.entityId
              ? ["git-conflicts", projectId, event.entityId]
              : ["git-conflicts", projectId],
            event.entityId
              ? ["git-conflict", projectId, event.entityId]
              : ["git-conflict", projectId],
          ]
        : event.scope.kind === "current-user"
          ? [["git-conflicts"]]
          : [];
    case "chat":
      return projectId
        ? [["chats", projectId]]
        : event.scope.kind === "chat"
          ? [
              ["messages", event.scope.chatId],
              ["task-dashboard", event.scope.chatId],
            ]
          : event.scope.kind === "current-user"
            ? [["chats"]]
            : [];
    case "task":
      return event.scope.kind === "chat"
        ? [
            ["task", event.scope.chatId],
            ["task-dashboard", event.scope.chatId],
          ]
        : event.entityId
          ? [
              ["task", event.entityId],
              ["task-dashboard", event.entityId],
            ]
          : [["tasks"], ["task-dashboard"]];
    case "chat-import-job":
      return projectId
        ? [
            ["chat-import-jobs", projectId],
            ...(event.entityId ? [["chat-import-job", event.entityId]] : []),
            ["external-chat-history", projectId],
            ["chats", projectId],
            ["project-tab-layout", projectId],
          ]
        : [["chat-import-jobs"]];
    case "chat-relocation-job":
      return event.scope.kind === "chat"
        ? [
            ["chat-relocation-jobs", event.scope.chatId],
            ...(event.entityId
              ? [["chat-relocation-job", event.entityId]]
              : []),
          ]
        : [];
    case "chat-message":
      return event.scope.kind === "chat"
        ? [
            ["messages", event.scope.chatId],
            ["message-history", event.scope.chatId],
          ]
        : [];
    case "chat-queue":
      return event.scope.kind === "chat"
        ? [["prompt-queue", event.scope.chatId]]
        : [];
    case "chat-goal":
      return event.scope.kind === "chat"
        ? [
            ["goal", event.scope.chatId],
            ["task-dashboard", event.scope.chatId],
          ]
        : [];
    case "chat-plan":
      return event.scope.kind === "chat" ? [["plan", event.scope.chatId]] : [];
    case "agent-interaction":
      return event.scope.kind === "chat"
        ? [["agent-requests", event.scope.chatId]]
        : [];
    case "terminal":
      return projectId
        ? [["terminals", projectId]]
        : event.scope.kind === "current-user"
          ? [["terminals"]]
          : [];
    case "run":
      return projectId
        ? [["run-environment", projectId]]
        : event.scope.kind === "current-user"
          ? [["run-environment"]]
          : [];
    case "run-configuration":
      return projectId
        ? [
            ["run-configurations", projectId],
            ...(event.entityId
              ? [["run-configuration", projectId, event.entityId]]
              : []),
          ]
        : event.scope.kind === "current-user"
          ? [["run-configurations"]]
          : [];
    case "explorer":
      return projectId
        ? [["explorers", projectId]]
        : event.scope.kind === "current-user"
          ? [["explorers"]]
          : [];
    case "explorer-filesystem":
      return projectId
        ? [
            event.entityId
              ? ["explorer-directory", projectId, event.entityId]
              : ["explorer-directory", projectId],
            event.entityId
              ? ["explorer-directory-commits", projectId, event.entityId]
              : ["explorer-directory-commits", projectId],
          ]
        : [];
    case "browser":
      return projectId
        ? [["browsers", projectId]]
        : event.scope.kind === "current-user"
          ? [["browsers"]]
          : [];
    case "code-tab":
      return projectId
        ? [["code-tabs", projectId]]
        : event.scope.kind === "current-user"
          ? [["code-tabs"]]
          : [];
    case "project-view":
      return projectId
        ? [["project-views", projectId]]
        : event.scope.kind === "current-user"
          ? [["project-views"]]
          : [];
    case "remote-desktop":
      return [
        ...(projectId ? [["project-views", projectId]] : []),
        ...(event.entityId
          ? [["remote-desktop", event.entityId]]
          : event.scope.kind === "current-user"
            ? [["remote-desktop"]]
            : []),
      ];
    case "tunnel":
      return [
        ["tunnels"],
        ...(projectId ? [["project-tunnels", projectId]] : []),
      ];
    case "workflow-definition":
      return projectId
        ? [["workflow-repository", projectId]]
        : [
            ["workflows"],
            ...(event.entityId ? [["workflow", event.entityId]] : []),
          ];
    case "workflow-run":
    case "workflow-node":
    case "workflow-gate":
      if (event.scope.kind === "workflow-run") {
        return [
          ["workflow-run", event.scope.runId],
          ["workflow-interactions", event.scope.runId],
        ];
      }
      return projectId ? [["workflow-runs", projectId]] : [];
    case "workflow-trigger":
      return projectId ? [["workflow-triggers", projectId]] : [];
    case "customization":
      return event.scope.kind === "chat"
        ? [
            ["chat-customizations", event.scope.chatId, "inventory"],
            ["skills", event.scope.chatId],
          ]
        : [
            ["settings-skills"],
            ...(projectId ? [["settings-skills", projectId]] : []),
          ];
  }
}

export function appLiveScopeQueryKeys(scope: AppLiveScope): QueryKey[] {
  switch (scope.kind) {
    case "current-user":
      return [
        ["server-bootstrap"],
        ["account-sessions"],
        ["account-resource-usage"],
        ["account-resource-usage-history"],
        ["settings"],
        ["code-settings-worker-status"],
        ["codex-auth"],
        ["policies"],
        ["policy-templates"],
        ["workspace-policy-assignments"],
        ["project-policy-assignments"],
        ["effective-policies"],
        ["workers"],
        ["worker-management"],
        ["worker-enrollment-status"],
        ["desktop-worker-enrollment-status"],
        ["projects"],
        ["project-workspaces"],
        ["tunnels"],
        ["workflows"],
      ];
    case "project":
      return [
        ["project-policy-assignments", scope.projectId],
        ["effective-policies", scope.projectId],
        ["project-replica-jobs", scope.projectId],
        ["project-automations", scope.projectId],
        ["project-token-usage", scope.projectId],
        ["project-folder-setup", scope.projectId],
        ["project-github-conversion", scope.projectId],
        ["project-tab-layout", scope.projectId],
        ["worktrees", scope.projectId],
        ["worktree-status", scope.projectId],
        ["codegraph", scope.projectId],
        ["worktree-history", scope.projectId],
        ["git-graph-snapshot", scope.projectId],
        ["git-graph-metrics", scope.projectId],
        ["git-graph-commit-overlay", scope.projectId],
        ["git-operation", scope.projectId],
        ["git-conflicts", scope.projectId],
        ["git-conflict", scope.projectId],
        ["chat-import-jobs", scope.projectId],
        ["chats", scope.projectId],
        ["terminals", scope.projectId],
        ["run-configurations", scope.projectId],
        ["explorers", scope.projectId],
        ["explorer-directory", scope.projectId],
        ["explorer-directory-commits", scope.projectId],
        ["browsers", scope.projectId],
        ["code-tabs", scope.projectId],
        ["project-views", scope.projectId],
        ["project-repository-stats", scope.projectId],
        ["project-tunnels", scope.projectId],
        ["workflow-repository", scope.projectId],
        ["workflow-runs", scope.projectId],
        ["workflow-triggers", scope.projectId],
      ];
    case "chat":
      return [
        ["chat-sync", scope.chatId],
        ["chat-relocation-jobs", scope.chatId],
        ["messages", scope.chatId],
        ["task", scope.chatId],
        ["task-dashboard", scope.chatId],
        ["prompt-queue", scope.chatId],
        ["goal", scope.chatId],
        ["plan", scope.chatId],
        ["agent-requests", scope.chatId],
        ["permission-profiles", scope.chatId],
        ["skills", scope.chatId],
        ["chat-customizations", scope.chatId, "inventory"],
      ];
    case "workflow-run":
      return [
        ["workflow-run", scope.runId],
        ["workflow-interactions", scope.runId],
      ];
  }
}

function uniqueQueryKeys(keys: QueryKey[]): QueryKey[] {
  const unique = new Map<string, QueryKey>();
  for (const key of keys) unique.set(JSON.stringify(key), key);
  return [...unique.values()];
}

export class AppLiveQueryBridge {
  readonly #codeGraphRevisions = new Map<string, number>();
  readonly #gitConflictRevisions = new Map<string, number>();
  readonly #gitOperationRevisions = new Map<string, number>();
  readonly #messageCursors = new Map<string, number>();
  readonly #providerAuthRevisions = new Map<string, number>();
  readonly #pendingKeys = new Map<string, QueryKey>();
  readonly #queryClient: QueryClient;
  readonly #workflowRunSequences = new Map<string, number>();
  #coalescedInvalidationCount = 0;
  #coalescedFlushTimer: ReturnType<typeof setTimeout> | null = null;
  #directlyAppliedEventCount = 0;
  #flushScheduled = false;
  #invalidatedQueryCount = 0;
  #invalidationFlushCount = 0;
  #receivedEventCount = 0;

  constructor(queryClient: QueryClient) {
    this.#queryClient = queryClient;
  }

  handleEvent(event: AppLiveEvent): void {
    this.#receivedEventCount += 1;
    if (!this.#acceptWorkflowEvent(event)) return;
    const worktreeStatus = this.#applyWorktreeStatusEvent(event);
    const directlyApplied =
      this.#applyChatMessageEvent(event) ||
      this.#applyCodeGraphStatusEvent(event) ||
      this.#applyProviderAuthEvent(event) ||
      this.#applyGitOperationEvent(event) ||
      this.#applyGitConflictEvent(event) ||
      worktreeStatus.applied;
    if (directlyApplied) {
      this.#directlyAppliedEventCount += 1;
      if (event.resource !== "worktree-status") return;
    }
    for (const key of appLiveEventQueryKeys(event)) {
      if (directlyApplied && key[0] === "worktree-status") continue;
      if (
        worktreeStatus.applied &&
        !worktreeStatus.revisionChanged &&
        [
          "worktree-history",
          "git-graph-snapshot",
          "git-graph-metrics",
          "git-graph-commit-overlay",
        ].includes(String(key[0]))
      ) {
        continue;
      }
      const serialized = JSON.stringify(key);
      if (this.#pendingKeys.has(serialized)) {
        this.#coalescedInvalidationCount += 1;
      }
      this.#pendingKeys.set(serialized, key);
    }
    if (this.#pendingKeys.size === 0) return;
    if (
      [
        "customization",
        "workflow-definition",
        "workflow-gate",
        "workflow-node",
        "workflow-run",
        "workflow-trigger",
      ].includes(event.resource)
    ) {
      if (this.#flushScheduled || this.#coalescedFlushTimer) return;
      this.#coalescedFlushTimer = setTimeout(() => {
        this.#coalescedFlushTimer = null;
        void this.#flush();
      }, 100);
      return;
    }
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      if (this.#coalescedFlushTimer) clearTimeout(this.#coalescedFlushTimer);
      this.#coalescedFlushTimer = null;
      void this.#flush();
    });
  }

  #acceptWorkflowEvent(event: AppLiveEvent): boolean {
    if (
      !["workflow-gate", "workflow-node", "workflow-run"].includes(
        event.resource,
      ) ||
      event.revision === null ||
      !event.entityId
    ) {
      return true;
    }
    const scopeKey =
      event.scope.kind === "workflow-run"
        ? `workflow-run:${event.scope.runId}`
        : event.scope.kind === "project"
          ? `project:${event.scope.projectId}`
          : null;
    if (!scopeKey) return true;
    const key = `${scopeKey}:${event.entityId}`;
    const latest = this.#workflowRunSequences.get(key);
    if (latest !== undefined && event.revision <= latest) return false;
    this.#workflowRunSequences.set(key, event.revision);
    if (this.#workflowRunSequences.size > MAX_TRACKED_WORKFLOW_SEQUENCES) {
      const oldest = this.#workflowRunSequences.keys().next().value;
      if (oldest !== undefined) this.#workflowRunSequences.delete(oldest);
    }
    return true;
  }

  #applyChatMessageEvent(event: AppLiveEvent): boolean {
    if (
      event.resource !== "chat-message" ||
      event.scope.kind !== "chat" ||
      !event.entityId
    ) {
      return false;
    }
    const entityKey = `${event.scope.chatId}:${event.entityId}`;
    const latestCursor = this.#messageCursors.get(entityKey);
    if (latestCursor !== undefined && event.cursor <= latestCursor) return true;

    const liveQueryKey = chatMessageLiveQueryKey(event.scope.chatId);
    const pagesQueryKey = chatMessagePagesQueryKey(event.scope.chatId);
    if (event.action === "deleted") {
      this.#queryClient.setQueryData<ChatMessageLiveOverlay>(
        liveQueryKey,
        (current) => deleteFromChatMessageLiveOverlay(current, event.entityId!),
      );
      this.#messageCursors.set(entityKey, event.cursor);
      return true;
    }

    const parsed = chatMessageSchema.safeParse(event.payload);
    const encryptedChat = chatMessageOpaqueSummarySchema.safeParse(
      event.payload,
    );
    const encrypted = taskMessageOpaqueSummarySchema.safeParse(event.payload);
    if (
      encryptedChat.success &&
      encryptedChat.data.id === event.entityId &&
      encryptedChat.data.chatId === event.scope.chatId
    ) {
      void openChatMessageOpaqueSummary(encryptedChat.data)
        .catch(() => openTaskMessageOpaqueSummary(encryptedChat.data))
        .then((message) => {
          const latest = this.#messageCursors.get(entityKey);
          if (latest !== undefined && event.cursor <= latest) return;
          this.#queryClient.setQueryData<ChatMessageLiveOverlay>(
            liveQueryKey,
            (current) => upsertChatMessageLiveOverlay(current, message),
          );
          this.#messageCursors.set(entityKey, event.cursor);
        })
        .catch(() => {
          void this.#queryClient.invalidateQueries({ queryKey: pagesQueryKey });
        });
      return true;
    }
    if (
      encrypted.success &&
      encrypted.data.id === event.entityId &&
      encrypted.data.chatId === event.scope.chatId
    ) {
      void openTaskMessageOpaqueSummary(encrypted.data)
        .then((message) => {
          const latest = this.#messageCursors.get(entityKey);
          if (latest !== undefined && event.cursor <= latest) return;
          this.#queryClient.setQueryData<ChatMessageLiveOverlay>(
            liveQueryKey,
            (current) => upsertChatMessageLiveOverlay(current, message),
          );
          this.#messageCursors.set(entityKey, event.cursor);
        })
        .catch(() => {
          void this.#queryClient.invalidateQueries({ queryKey: pagesQueryKey });
        });
      return true;
    }
    if (
      !parsed.success ||
      parsed.data.id !== event.entityId ||
      parsed.data.chatId !== event.scope.chatId
    ) {
      return false;
    }
    this.#queryClient.setQueryData<ChatMessageLiveOverlay>(
      liveQueryKey,
      (current) => upsertChatMessageLiveOverlay(current, parsed.data),
    );
    this.#messageCursors.set(entityKey, event.cursor);
    return true;
  }

  #applyWorktreeStatusEvent(event: AppLiveEvent): {
    applied: boolean;
    revisionChanged: boolean;
  } {
    if (
      event.resource !== "worktree-status" ||
      event.action !== "updated" ||
      event.scope.kind !== "project" ||
      !event.entityId
    ) {
      return { applied: false, revisionChanged: false };
    }
    const parsed = gitStatusSchema.safeParse(event.payload);
    if (!parsed.success) return { applied: false, revisionChanged: false };
    const queryKey = [
      "worktree-status",
      event.scope.projectId,
      event.entityId,
    ] as const;
    const previous = this.#queryClient.getQueryData<GitStatus>(queryKey);
    this.#queryClient.setQueryData<GitStatus>(queryKey, parsed.data);
    return {
      applied: true,
      revisionChanged:
        previous === undefined || previous.head !== parsed.data.head,
    };
  }

  #applyCodeGraphStatusEvent(event: AppLiveEvent): boolean {
    if (
      event.resource !== "codegraph-status" ||
      event.action !== "updated" ||
      event.scope.kind !== "project" ||
      !event.entityId ||
      event.revision === null
    ) {
      return false;
    }
    const revisionKey = `${event.scope.projectId}:${event.entityId}`;
    const latestRevision = this.#codeGraphRevisions.get(revisionKey);
    if (latestRevision !== undefined && event.revision <= latestRevision) {
      return true;
    }
    const parsed = codeGraphProjectStatusSchema.safeParse(event.payload);
    if (
      !parsed.success ||
      parsed.data.projectId !== event.scope.projectId ||
      parsed.data.worktreeId !== event.entityId
    ) {
      return false;
    }
    const queryKey = [
      "codegraph",
      event.scope.projectId,
      event.entityId,
    ] as const;
    void this.#queryClient.cancelQueries({ queryKey, exact: true });
    this.#queryClient.setQueryData<CodeGraphProjectStatus>(
      queryKey,
      parsed.data,
    );
    this.#codeGraphRevisions.delete(revisionKey);
    this.#codeGraphRevisions.set(revisionKey, event.revision);
    if (this.#codeGraphRevisions.size > MAX_TRACKED_CODEGRAPH_REVISIONS) {
      const oldest = this.#codeGraphRevisions.keys().next().value;
      if (oldest !== undefined) this.#codeGraphRevisions.delete(oldest);
    }
    return true;
  }

  #applyGitOperationEvent(event: AppLiveEvent): boolean {
    if (
      event.resource !== "git-operation" ||
      event.action !== "updated" ||
      event.scope.kind !== "project" ||
      !event.entityId ||
      event.revision === null
    ) {
      return false;
    }
    const parsed = gitManagedOperationResponseSchema.safeParse(event.payload);
    const operation = parsed.success ? parsed.data.operation : null;
    if (
      !operation ||
      operation.id !== event.entityId ||
      operation.projectId !== event.scope.projectId
    ) {
      return false;
    }
    const revisionKey = `${operation.projectId}:${operation.worktreeId}`;
    const latestRevision = this.#gitOperationRevisions.get(revisionKey);
    if (latestRevision !== undefined && event.revision <= latestRevision) {
      return true;
    }
    const queryKey = [
      "git-operation",
      operation.projectId,
      operation.worktreeId,
    ] as const;
    void this.#queryClient.cancelQueries({ queryKey, exact: true });
    this.#queryClient.setQueryData<GitManagedOperationResponse>(
      queryKey,
      parsed.data,
    );
    this.#rememberGitRevision(
      this.#gitOperationRevisions,
      revisionKey,
      event.revision,
    );
    return true;
  }

  #applyGitConflictEvent(event: AppLiveEvent): boolean {
    if (
      event.resource !== "git-conflict" ||
      event.action !== "updated" ||
      event.scope.kind !== "project" ||
      !event.entityId ||
      event.revision === null
    ) {
      return false;
    }
    const parsed = gitConflictListSchema.safeParse(event.payload);
    if (!parsed.success) return false;
    const revisionKey = `${event.scope.projectId}:${event.entityId}`;
    const latestRevision = this.#gitConflictRevisions.get(revisionKey);
    if (latestRevision !== undefined && event.revision <= latestRevision) {
      return true;
    }
    const queryKey = [
      "git-conflicts",
      event.scope.projectId,
      event.entityId,
    ] as const;
    void this.#queryClient.cancelQueries({ queryKey, exact: true });
    this.#queryClient.setQueryData<GitConflictList>(queryKey, parsed.data);
    void this.#queryClient.invalidateQueries({
      queryKey: ["git-conflict", event.scope.projectId, event.entityId],
    });
    this.#rememberGitRevision(
      this.#gitConflictRevisions,
      revisionKey,
      event.revision,
    );
    return true;
  }

  #applyProviderAuthEvent(event: AppLiveEvent): boolean {
    if (
      event.resource !== "provider-auth" ||
      event.action !== "status" ||
      event.scope.kind !== "current-user" ||
      !event.entityId ||
      event.revision === null
    ) {
      return false;
    }
    const parsed = providerAuthLiveStatusSchema.safeParse(event.payload);
    if (
      !parsed.success ||
      parsed.data.providerAccountId !== event.entityId ||
      parsed.data.revision !== event.revision
    ) {
      return false;
    }
    const revisionKey = `${parsed.data.providerId}:${parsed.data.providerAccountId}`;
    const latestRevision = this.#providerAuthRevisions.get(revisionKey);
    if (latestRevision !== undefined && event.revision <= latestRevision) {
      return true;
    }
    const loginError = (() => {
      switch (parsed.data.status.failureCode) {
        case "authorization-cancelled":
          return "Provider sign-in was cancelled.";
        case "authorization-denied":
          return "Provider sign-in was denied.";
        case "authorization-expired":
          return "The provider sign-in code expired.";
        case "credential-capture-failed":
          return "The worker could not protect and save provider authentication.";
        case "status-unavailable":
          return "Provider sign-in status is temporarily unavailable.";
        case "authorization-failed":
          return "Provider sign-in failed.";
        case null:
          return null;
      }
    })();
    const status: CodexAuthStatus = {
      authenticated: parsed.data.status.state === "authenticated",
      authMode: parsed.data.status.authMode,
      email: parsed.data.status.email,
      planType: parsed.data.status.planType,
      weeklyUsage: parsed.data.status.weeklyUsage,
      loginPending: parsed.data.status.state === "pending",
      loginError,
    };
    const queryKey = [
      "codex-auth",
      parsed.data.providerId,
      parsed.data.providerAccountId,
    ] as const;
    void this.#queryClient.cancelQueries({ queryKey, exact: true });
    this.#queryClient.setQueryData<CodexAuthStatus>(queryKey, status);
    this.#providerAuthRevisions.delete(revisionKey);
    this.#providerAuthRevisions.set(revisionKey, event.revision);
    if (
      this.#providerAuthRevisions.size > MAX_TRACKED_PROVIDER_AUTH_REVISIONS
    ) {
      const oldest = this.#providerAuthRevisions.keys().next().value;
      if (oldest !== undefined) this.#providerAuthRevisions.delete(oldest);
    }
    return true;
  }

  #rememberGitRevision(
    revisions: Map<string, number>,
    key: string,
    revision: number,
  ): void {
    revisions.delete(key);
    revisions.set(key, revision);
    if (revisions.size > 4_096) {
      const oldest = revisions.keys().next().value;
      if (oldest !== undefined) revisions.delete(oldest);
    }
  }

  async recoverScopes(
    scopes: AppLiveScope[],
    _reason: AppLiveResyncReason,
  ): Promise<void> {
    if (this.#coalescedFlushTimer) clearTimeout(this.#coalescedFlushTimer);
    this.#coalescedFlushTimer = null;
    await this.#flush();
    for (const scope of scopes) {
      if (scope.kind !== "chat") continue;
      this.#queryClient.setQueryData(
        chatMessageLiveQueryKey(scope.chatId),
        EMPTY_CHAT_MESSAGE_LIVE_OVERLAY,
      );
      this.#queryClient.removeQueries({
        queryKey: ["message-history", scope.chatId],
      });
      const prefix = `${scope.chatId}:`;
      for (const key of this.#messageCursors.keys()) {
        if (key.startsWith(prefix)) this.#messageCursors.delete(key);
      }
    }
    for (const scope of scopes) {
      if (scope.kind !== "project") continue;
      const prefix = `${scope.projectId}:`;
      for (const key of this.#codeGraphRevisions.keys()) {
        if (key.startsWith(prefix)) this.#codeGraphRevisions.delete(key);
      }
      for (const revisions of [
        this.#gitOperationRevisions,
        this.#gitConflictRevisions,
      ]) {
        for (const key of revisions.keys()) {
          if (key.startsWith(prefix)) revisions.delete(key);
        }
      }
    }
    for (const scope of scopes) {
      if (scope.kind === "current-user") {
        this.#providerAuthRevisions.clear();
      }
      const prefix =
        scope.kind === "workflow-run"
          ? `workflow-run:${scope.runId}:`
          : scope.kind === "project"
            ? `project:${scope.projectId}:`
            : null;
      if (!prefix) continue;
      for (const key of this.#workflowRunSequences.keys()) {
        if (key.startsWith(prefix)) this.#workflowRunSequences.delete(key);
      }
    }
    const keys = uniqueQueryKeys(scopes.flatMap(appLiveScopeQueryKeys));
    await Promise.all(
      keys.map((queryKey) => this.#queryClient.invalidateQueries({ queryKey })),
    );
  }

  stats(): AppLiveQueryBridgeStats {
    return {
      coalescedInvalidationCount: this.#coalescedInvalidationCount,
      directlyAppliedEventCount: this.#directlyAppliedEventCount,
      invalidatedQueryCount: this.#invalidatedQueryCount,
      invalidationFlushCount: this.#invalidationFlushCount,
      receivedEventCount: this.#receivedEventCount,
    };
  }

  async #flush(): Promise<void> {
    if (this.#pendingKeys.size === 0) return;
    const keys = [...this.#pendingKeys.values()];
    this.#pendingKeys.clear();
    this.#invalidationFlushCount += 1;
    this.#invalidatedQueryCount += keys.length;
    await Promise.all(
      keys.map((queryKey) => this.#queryClient.invalidateQueries({ queryKey })),
    );
  }
}
