import type {
  AppLiveResyncReason,
  AppLiveScope,
  AppLiveServerMessage,
} from "@cantrip/protocol";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

type AppLiveEvent = Extract<AppLiveServerMessage, { type: "event" }>;

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
      return [["workers"]];
    case "project":
      return [["projects"]];
    case "worktree":
      return projectId
        ? [["worktrees", projectId]]
        : event.scope.kind === "current-user"
          ? [["worktrees"]]
          : [];
    case "worktree-status":
      return projectId
        ? [["worktree-status", projectId]]
        : event.scope.kind === "current-user"
          ? [["worktree-status"]]
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
    case "workflow-definition":
      return event.entityId
        ? [["workflows"], ["workflow", event.entityId]]
        : [["workflows"]];
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
        ? [["chat-customizations", event.scope.chatId]]
        : [["settings"]];
  }
}

export function appLiveScopeQueryKeys(scope: AppLiveScope): QueryKey[] {
  switch (scope.kind) {
    case "current-user":
      return [
        ["server-bootstrap"],
        ["settings"],
        ["workers"],
        ["projects"],
        ["workflows"],
      ];
    case "project":
      return [
        ["worktrees", scope.projectId],
        ["worktree-status", scope.projectId],
        ["chats", scope.projectId],
        ["terminals", scope.projectId],
        ["explorers", scope.projectId],
        ["browsers", scope.projectId],
        ["code-tabs", scope.projectId],
        ["project-views", scope.projectId],
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
        ["chat-customizations", scope.chatId],
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
  readonly #pendingKeys = new Map<string, QueryKey>();
  readonly #queryClient: QueryClient;
  #flushScheduled = false;

  constructor(queryClient: QueryClient) {
    this.#queryClient = queryClient;
  }

  handleEvent(event: AppLiveEvent): void {
    for (const key of appLiveEventQueryKeys(event)) {
      this.#pendingKeys.set(JSON.stringify(key), key);
    }
    if (this.#pendingKeys.size === 0 || this.#flushScheduled) return;
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      void this.#flush();
    });
  }

  async recoverScopes(
    scopes: AppLiveScope[],
    _reason: AppLiveResyncReason,
  ): Promise<void> {
    await this.#flush();
    const keys = uniqueQueryKeys(scopes.flatMap(appLiveScopeQueryKeys));
    await Promise.all(
      keys.map((queryKey) => this.#queryClient.invalidateQueries({ queryKey })),
    );
  }

  async #flush(): Promise<void> {
    if (this.#pendingKeys.size === 0) return;
    const keys = [...this.#pendingKeys.values()];
    this.#pendingKeys.clear();
    await Promise.all(
      keys.map((queryKey) => this.#queryClient.invalidateQueries({ queryKey })),
    );
  }
}
