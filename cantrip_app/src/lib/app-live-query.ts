import {
  chatMessageSchema,
  codexExternalImportStatusSchema,
  codexMcpOauthStatusSchema,
  gitStatusSchema,
} from "@cantrip/protocol";
import type {
  AppLiveResyncReason,
  AppLiveScope,
  AppLiveServerMessage,
  ChatMessage,
  CodexExternalImportStatus,
  CodexMcpOauthStatus,
  GitStatus,
} from "@cantrip/protocol";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

type AppLiveEvent = Extract<AppLiveServerMessage, { type: "event" }>;

export interface AppLiveQueryBridgeStats {
  coalescedInvalidationCount: number;
  directlyAppliedEventCount: number;
  invalidatedQueryCount: number;
  invalidationFlushCount: number;
  receivedEventCount: number;
}

const MAX_TRACKED_WORKFLOW_SEQUENCES = 4_096;

function projectScopeId(scope: AppLiveScope): string | null {
  return scope.kind === "project" ? scope.projectId : null;
}

export function appLiveEventQueryKeys(event: AppLiveEvent): QueryKey[] {
  const projectId = projectScopeId(event.scope);
  switch (event.resource) {
    case "server":
      return [["server-bootstrap"]];
    case "settings":
      return [["settings"]];
    case "worker":
      return [["workers"], ["worker-management"], ["chat-sync"]];
    case "project":
      return projectId
        ? [["projects"], ["project-tab-layout", projectId]]
        : [["projects"]];
    case "project-replica-job":
      return projectId
        ? [
            ["project-replica-jobs", projectId],
            ...(event.entityId
              ? [["project-replica-job", event.entityId]]
              : []),
          ]
        : [["project-replica-jobs"]];
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
          ]
        : event.scope.kind === "current-user"
          ? [["worktree-status"]]
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
          ]
        : event.scope.kind === "current-user"
          ? [["git-conflicts"]]
          : [];
    case "chat":
      return projectId
        ? [["chats", projectId]]
        : event.scope.kind === "chat"
          ? [["chat-sync", event.scope.chatId]]
          : event.scope.kind === "current-user"
            ? [["chats"]]
            : [];
    case "chat-message":
      return event.scope.kind === "chat"
        ? [["messages", event.scope.chatId]]
        : [];
    case "chat-queue":
      return event.scope.kind === "chat"
        ? [["prompt-queue", event.scope.chatId]]
        : [];
    case "chat-goal":
      return event.scope.kind === "chat" ? [["goal", event.scope.chatId]] : [];
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
    case "explorer":
      return projectId
        ? [["explorers", projectId]]
        : event.scope.kind === "current-user"
          ? [["explorers"]]
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
        return [["workflow-run", event.scope.runId]];
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
        ["settings"],
        ["workers"],
        ["worker-management"],
        ["projects"],
        ["tunnels"],
        ["workflows"],
      ];
    case "project":
      return [
        ["project-tab-layout", scope.projectId],
        ["worktrees", scope.projectId],
        ["worktree-status", scope.projectId],
        ["git-operation", scope.projectId],
        ["git-conflicts", scope.projectId],
        ["chats", scope.projectId],
        ["terminals", scope.projectId],
        ["explorers", scope.projectId],
        ["browsers", scope.projectId],
        ["code-tabs", scope.projectId],
        ["project-views", scope.projectId],
        ["project-tunnels", scope.projectId],
        ["workflow-repository", scope.projectId],
        ["workflow-runs", scope.projectId],
        ["workflow-triggers", scope.projectId],
      ];
    case "chat":
      return [
        ["chat-sync", scope.chatId],
        ["messages", scope.chatId],
        ["prompt-queue", scope.chatId],
        ["goal", scope.chatId],
        ["plan", scope.chatId],
        ["agent-requests", scope.chatId],
        ["permission-profiles", scope.chatId],
        ["skills", scope.chatId],
        ["chat-customizations", scope.chatId, "inventory"],
      ];
    case "workflow-run":
      return [["workflow-run", scope.runId]];
  }
}

function uniqueQueryKeys(keys: QueryKey[]): QueryKey[] {
  const unique = new Map<string, QueryKey>();
  for (const key of keys) unique.set(JSON.stringify(key), key);
  return [...unique.values()];
}

export class AppLiveQueryBridge {
  readonly #messageCursors = new Map<string, number>();
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
    if (
      this.#applyChatMessageEvent(event) ||
      this.#applyWorktreeStatusEvent(event) ||
      this.#applyCustomizationStatusEvent(event)
    ) {
      this.#directlyAppliedEventCount += 1;
      return;
    }
    for (const key of appLiveEventQueryKeys(event)) {
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

    const queryKey = ["messages", event.scope.chatId] as const;
    const current = this.#queryClient.getQueryData<ChatMessage[]>(queryKey);
    if (!current) return false;
    if (event.action === "deleted") {
      this.#queryClient.setQueryData<ChatMessage[]>(
        queryKey,
        current.filter((message) => message.id !== event.entityId),
      );
      this.#messageCursors.set(entityKey, event.cursor);
      return true;
    }

    const parsed = chatMessageSchema.safeParse(event.payload);
    if (
      !parsed.success ||
      parsed.data.id !== event.entityId ||
      parsed.data.chatId !== event.scope.chatId
    ) {
      return false;
    }
    const next = [
      ...current.filter((message) => message.id !== parsed.data.id),
      parsed.data,
    ].sort(
      (left, right) =>
        left.sequence - right.sequence || left.id.localeCompare(right.id),
    );
    this.#queryClient.setQueryData<ChatMessage[]>(queryKey, next);
    this.#messageCursors.set(entityKey, event.cursor);
    return true;
  }

  #applyWorktreeStatusEvent(event: AppLiveEvent): boolean {
    if (
      event.resource !== "worktree-status" ||
      event.action !== "updated" ||
      event.scope.kind !== "project" ||
      !event.entityId
    ) {
      return false;
    }
    const parsed = gitStatusSchema.safeParse(event.payload);
    if (!parsed.success) return false;
    this.#queryClient.setQueryData<GitStatus>(
      ["worktree-status", event.scope.projectId, event.entityId],
      parsed.data,
    );
    return true;
  }

  #applyCustomizationStatusEvent(event: AppLiveEvent): boolean {
    if (
      event.resource !== "customization" ||
      event.action !== "updated" ||
      event.scope.kind !== "chat" ||
      !event.payload
    ) {
      return false;
    }
    if (event.entityId === "mcp-oauth") {
      const parsed = codexMcpOauthStatusSchema.safeParse(event.payload);
      if (!parsed.success) return false;
      this.#queryClient.setQueryData<CodexMcpOauthStatus>(
        [
          "chat-customizations",
          event.scope.chatId,
          "mcp-oauth",
          parsed.data.server,
        ],
        parsed.data,
      );
      return true;
    }
    if (event.entityId === "external-import") {
      const parsed = codexExternalImportStatusSchema.safeParse(event.payload);
      if (!parsed.success) return false;
      this.#queryClient.setQueryData<CodexExternalImportStatus>(
        [
          "chat-customizations",
          event.scope.chatId,
          "external-import",
          parsed.data.importId,
        ],
        parsed.data,
      );
      return true;
    }
    return false;
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
      const prefix = `${scope.chatId}:`;
      for (const key of this.#messageCursors.keys()) {
        if (key.startsWith(prefix)) this.#messageCursors.delete(key);
      }
    }
    for (const scope of scopes) {
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
