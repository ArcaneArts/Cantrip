import type { AppLiveResource } from "@cantrip/protocol";

export type ChatLiveResource = Extract<
  AppLiveResource,
  | "agent-interaction"
  | "chat"
  | "chat-goal"
  | "chat-message"
  | "chat-plan"
  | "chat-queue"
  | "customization"
  | "inference-progress"
  | "task"
>;

export function mutationLiveResources(
  route: string,
  repositoryAccess: "read" | "write" = "write",
): AppLiveResource[] {
  if (
    repositoryAccess === "read" &&
    (route ===
      "/api/projects/:projectId/worktrees/:worktreeId/repository-operation" ||
      route === "/api/workers/:workerId/repository-operation")
  ) {
    return [];
  }
  if (
    route === "/api/projects/:projectId/tasks" ||
    route === "/api/tasks/:chatId" ||
    route.startsWith("/api/tasks/:chatId/")
  ) {
    return ["task", "chat"];
  }
  if (
    route === "/api/policies" ||
    route.startsWith("/api/policies/") ||
    route === "/api/projects/:projectId/policies" ||
    route === "/api/workspaces/:workspaceId/policies"
  ) {
    return ["policy"];
  }
  if (
    route === "/api/workspaces/:workspaceId/repository-discovery" ||
    route === "/api/workspaces/:workspaceId/repository-imports"
  ) {
    return ["workspace-repository-discovery-job"];
  }
  if (route === "/api/workspaces" || route.startsWith("/api/workspaces/")) {
    return ["project", "policy"];
  }
  if (route === "/api/tunnels" || route.startsWith("/api/tunnels/")) {
    return ["tunnel"];
  }
  if (route.startsWith("/api/tunnel-attachments/")) return ["tunnel"];
  if (route === "/api/browsers/:browserId/tunnel") {
    return ["browser", "tunnel"];
  }
  if (route === "/api/browsers/:browserId") {
    return ["browser", "tunnel", "project-tab-layout"];
  }
  if (route.startsWith("/api/workers/")) return ["worker"];
  if (
    route === "/api/projects/from-github" ||
    route === "/api/projects/from-folder" ||
    route === "/api/projects/:projectId/folder-setup/retry" ||
    route === "/api/projects/:projectId/github-conversion" ||
    route === "/api/projects/:projectId/github-conversion/retry" ||
    route === "/api/projects/order" ||
    route === "/api/projects/:projectId" ||
    route === "/api/projects/:projectId/preferred-worker" ||
    route === "/api/projects/:projectId/worktree-policy"
  ) {
    return ["project"];
  }
  if (
    route.startsWith("/api/projects/:projectId/tab-groups") ||
    route.startsWith("/api/projects/:projectId/panes")
  ) {
    return ["project", "project-tab-layout"];
  }
  if (route.includes("/worktrees")) return ["worktree"];
  if (
    route.includes("/run-configurations") ||
    route.includes("/run-configuration-secrets")
  ) {
    return ["run-configuration"];
  }
  if (route === "/api/chats/:chatId/console") {
    return ["chat", "terminal", "project-tab-layout"];
  }
  if (route === "/api/chats/:chatId/composer-draft") return [];
  if (
    route === "/api/projects/:projectId/chats" ||
    route === "/api/chats/:chatId"
  ) {
    return ["chat", "project-tab-layout"];
  }
  if (route.startsWith("/api/chats/")) return ["chat"];
  if (route.includes("/terminals")) {
    return ["terminal", "project-tab-layout"];
  }
  if (route.includes("/explorers")) {
    return ["explorer", "project-tab-layout"];
  }
  if (route.includes("/browsers")) {
    return ["browser", "project-tab-layout"];
  }
  if (route.includes("/code-tabs")) {
    return ["code-tab", "project-tab-layout"];
  }
  if (
    route.includes("/remote-desktops") ||
    route.includes("/remote-surfaces")
  ) {
    return ["browser", "remote-desktop", "project-view", "project-tab-layout"];
  }
  if (
    route === "/api/projects/:projectId/views" ||
    route.startsWith("/api/project-views/")
  ) {
    return ["project-view", "project-tab-layout"];
  }
  return [];
}

export function mutationChatLiveResources(route: string): ChatLiveResource[] {
  if (route === "/api/chats/:chatId/goal") return ["chat-goal"];
  return [];
}
