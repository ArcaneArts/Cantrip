import {
  browserListSchema,
  browserSummarySchema,
  agentThreadSyncSchema,
  chatListSchema,
  chatGoalClearSchema,
  chatGoalCreateSchema,
  chatGoalResponseSchema,
  chatGoalUpdateSchema,
  codexAuthStatusSchema,
  codexDeviceLoginSchema,
  chatMessageListSchema,
  chatSummarySchema,
  chatCompactAcceptedSchema,
  chatInterruptAcceptedSchema,
  chatPromptSteerResultSchema,
  chatPromptSubmitResultSchema,
  explorerDirectorySchema,
  explorerFileSchema,
  explorerListSchema,
  explorerSummarySchema,
  githubAuthStatusSchema,
  githubIssueDetailSchema,
  githubIssueListSchema,
  githubRepositoryListSchema,
  gitActionResultSchema,
  gitHistorySchema,
  gitStatusSchema,
  modelProfileCreateSchema,
  modelProfileSummarySchema,
  modelProfileUpdateSchema,
  modelProviderCreateSchema,
  modelProviderSummarySchema,
  modelProviderUpdateSchema,
  orderedIdsSchema,
  projectListSchema,
  projectSummarySchema,
  projectWorktreeListSchema,
  projectWorktreeSummarySchema,
  projectViewListSchema,
  projectViewSummarySchema,
  queuedPromptListSchema,
  queuedPromptSchema,
  remoteDesktopListSchema,
  remoteDesktopSummarySchema,
  serverBootstrapSchema,
  settingsBundleSchema,
  skillListSchema,
  systemHealthSchema,
  terminalListSchema,
  terminalSummarySchema,
  worktreeStatusResultSchema,
  workerListSchema,
} from "@cantrip/protocol";
import type {
  ChatWorktreeUpdate,
  ChatGoalCreate,
  ChatGoalUpdate,
  GitAction,
  GithubIssueState,
  ModelProfileCreate,
  ModelProfileUpdate,
  ModelProviderCreate,
  ModelProviderUpdate,
  ProjectViewKind,
  ProjectWorktreeCreate,
  UserSettingsUpdate,
  WorktreePolicy,
} from "@cantrip/protocol";

const serverUrl = (import.meta.env.VITE_CANTRIP_SERVER_URL ?? "").replace(
  /\/$/,
  "",
);

export class CantripApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${serverUrl}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new CantripApiError(
      body?.error ?? `Cantrip Server returned HTTP ${response.status}.`,
      response.status,
    );
  }
  return response.status === 204 ? null : response.json();
}

function post(path: string, body: unknown) {
  return request(path, { method: "POST", body: JSON.stringify(body) });
}

export async function getSystemHealth() {
  return systemHealthSchema.parse(await request("/api/health"));
}

export async function getServerBootstrap() {
  return serverBootstrapSchema.parse(await request("/api/bootstrap"));
}

export async function getWorkers() {
  return workerListSchema.parse(await request("/api/workers"));
}

export async function getCodexAuthStatus(workerId: string, providerId: string) {
  return codexAuthStatusSchema.parse(
    await request(
      `/api/codex/auth/status?workerId=${encodeURIComponent(workerId)}&providerId=${encodeURIComponent(providerId)}`,
    ),
  );
}

export async function startCodexDeviceLogin(
  workerId: string,
  providerId: string,
) {
  return codexDeviceLoginSchema.parse(
    await post("/api/codex/auth/device-login", { workerId, providerId }),
  );
}

export async function logoutCodex(workerId: string, providerId: string) {
  await post("/api/codex/auth/logout", { workerId, providerId });
}

export async function getSettings() {
  return settingsBundleSchema.parse(await request("/api/settings"));
}

export async function updateSettings(input: UserSettingsUpdate) {
  return settingsBundleSchema.parse(
    await request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function createModelProvider(input: ModelProviderCreate) {
  return modelProviderSummarySchema.parse(
    await post(
      "/api/settings/providers",
      modelProviderCreateSchema.parse(input),
    ),
  );
}

export async function deleteModelProvider(providerId: string) {
  await request(`/api/settings/providers/${encodeURIComponent(providerId)}`, {
    method: "DELETE",
  });
}

export async function updateModelProvider(
  providerId: string,
  input: ModelProviderUpdate,
) {
  return modelProviderSummarySchema.parse(
    await request(`/api/settings/providers/${encodeURIComponent(providerId)}`, {
      method: "PATCH",
      body: JSON.stringify(modelProviderUpdateSchema.parse(input)),
    }),
  );
}

export async function createModelProfile(input: ModelProfileCreate) {
  return modelProfileSummarySchema.parse(
    await post("/api/settings/models", modelProfileCreateSchema.parse(input)),
  );
}

export async function deleteModelProfile(modelId: string) {
  await request(`/api/settings/models/${encodeURIComponent(modelId)}`, {
    method: "DELETE",
  });
}

export async function updateModelProfile(
  modelId: string,
  input: ModelProfileUpdate,
) {
  return modelProfileSummarySchema.parse(
    await request(`/api/settings/models/${encodeURIComponent(modelId)}`, {
      method: "PATCH",
      body: JSON.stringify(modelProfileUpdateSchema.parse(input)),
    }),
  );
}

export async function getGithubStatus(workerId: string) {
  return githubAuthStatusSchema.parse(
    await request(
      `/api/github/status?workerId=${encodeURIComponent(workerId)}`,
    ),
  );
}

export async function getGithubRepositories(workerId: string) {
  return githubRepositoryListSchema.parse(
    await request(
      `/api/github/repositories?workerId=${encodeURIComponent(workerId)}`,
    ),
  );
}

export async function getCachedGithubRepositories(
  workerId: string,
  login: string,
) {
  return githubRepositoryListSchema.parse(
    await request(
      `/api/github/repositories/cache?workerId=${encodeURIComponent(workerId)}&login=${encodeURIComponent(login)}`,
    ),
  );
}

export async function getProjects() {
  return projectListSchema.parse(await request("/api/projects"));
}

export async function getProjectWorktrees(projectId: string) {
  return projectWorktreeListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/worktrees`),
  );
}

export async function getProjectWorktreeStatus(
  projectId: string,
  worktreeId: string,
) {
  return worktreeStatusResultSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/status`,
    ),
  );
}

export async function createProjectWorktree(
  projectId: string,
  input: ProjectWorktreeCreate,
) {
  return projectWorktreeSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees`,
      input,
    ),
  );
}

export async function reconcileProjectWorktrees(projectId: string) {
  return projectWorktreeListSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/reconcile`,
      {},
    ),
  );
}

export async function getProjectWorktreeHistory(
  projectId: string,
  worktreeId: string,
  cursor = 0,
) {
  return gitHistorySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/history?cursor=${cursor}&limit=100`,
    ),
  );
}

export async function runProjectWorktreeGitAction(
  projectId: string,
  worktreeId: string,
  action: GitAction,
) {
  return gitActionResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/actions`,
      action,
    ),
  );
}

export async function lockProjectWorktree(
  projectId: string,
  worktreeId: string,
  reason: string | null,
) {
  return projectWorktreeSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/lock`,
      { reason },
    ),
  );
}

export async function unlockProjectWorktree(
  projectId: string,
  worktreeId: string,
) {
  return projectWorktreeSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/unlock`,
      {},
    ),
  );
}

export async function pruneProjectWorktrees(
  projectId: string,
  allowExternal: boolean,
) {
  return projectWorktreeListSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/prune`,
      { allowExternal },
    ),
  );
}

export async function removeProjectWorktree(
  projectId: string,
  worktreeId: string,
  input: { allowExternal: boolean; force: boolean },
) {
  return projectWorktreeSummarySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}`,
      { method: "DELETE", body: JSON.stringify(input) },
    ),
  );
}

export async function getGitHistory(projectId: string, cursor = 0) {
  return gitHistorySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/git/history?limit=100&cursor=${cursor}`,
    ),
  );
}

export async function getGithubIssues(
  projectId: string,
  state: GithubIssueState,
) {
  return githubIssueListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/github/issues?state=${encodeURIComponent(state)}`,
    ),
  );
}

export async function getGithubIssue(projectId: string, issueNumber: number) {
  return githubIssueDetailSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/github/issues/${issueNumber}`,
    ),
  );
}

export async function commentOnGithubIssue(
  projectId: string,
  issueNumber: number,
  body: string,
) {
  return githubIssueDetailSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/github/issues/${issueNumber}/comments`,
      { body },
    ),
  );
}

export async function closeGithubIssue(
  projectId: string,
  issueNumber: number,
  comment: string | null,
) {
  return githubIssueDetailSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/github/issues/${issueNumber}/close`,
      { comment },
    ),
  );
}

export async function getGitStatus(projectId: string) {
  return gitStatusSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/git/status`),
  );
}

export async function runGitAction(projectId: string, action: GitAction) {
  return gitActionResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/git/actions`,
      action,
    ),
  );
}

export async function removeProject(
  projectId: string,
  deleteLocalFiles: boolean,
) {
  await request(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
    body: JSON.stringify({ deleteLocalFiles }),
  });
}

export async function createGithubProject(input: {
  nameWithOwner: string;
  repositoryId: string;
  url: string;
  workerId: string;
}) {
  return projectSummarySchema.parse(
    await post("/api/projects/from-github", input),
  );
}

export async function updateProjectWorktreePolicy(
  projectId: string,
  policy: WorktreePolicy,
) {
  return projectSummarySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktree-policy`,
      {
        method: "PATCH",
        body: JSON.stringify({ policy }),
      },
    ),
  );
}

export async function getChats(projectId: string) {
  return chatListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/chats`),
  );
}

export async function createChat(
  projectId: string,
  title: string,
  worktreeId?: string,
  worktreeMode?: "agent-managed" | "pinned",
) {
  return chatSummarySchema.parse(
    await post(`/api/projects/${encodeURIComponent(projectId)}/chats`, {
      title,
      ...(worktreeId ? { worktreeId } : {}),
      ...(worktreeMode ? { worktreeMode } : {}),
    }),
  );
}

export async function getTerminals(projectId: string) {
  return terminalListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/terminals`),
  );
}

export async function createTerminal(
  projectId: string,
  title: string,
  worktreeId?: string,
) {
  return terminalSummarySchema.parse(
    await post(`/api/projects/${encodeURIComponent(projectId)}/terminals`, {
      title,
      ...(worktreeId ? { worktreeId } : {}),
    }),
  );
}

export async function updateTerminalWorktree(
  terminalId: string,
  worktreeId: string,
) {
  return terminalSummarySchema.parse(
    await request(`/api/terminals/${encodeURIComponent(terminalId)}/worktree`, {
      method: "PATCH",
      body: JSON.stringify({ worktreeId }),
    }),
  );
}

export async function renameTerminal(terminalId: string, title: string) {
  return terminalSummarySchema.parse(
    await request(`/api/terminals/${encodeURIComponent(terminalId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  );
}

export async function deleteTerminal(terminalId: string) {
  await request(`/api/terminals/${encodeURIComponent(terminalId)}`, {
    method: "DELETE",
  });
}

export async function getExplorers(projectId: string) {
  return explorerListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/explorers`),
  );
}

export async function createExplorer(
  projectId: string,
  title: string,
  worktreeId?: string,
) {
  return explorerSummarySchema.parse(
    await post(`/api/projects/${encodeURIComponent(projectId)}/explorers`, {
      title,
      ...(worktreeId ? { worktreeId } : {}),
    }),
  );
}

export async function updateExplorerWorktree(
  explorerId: string,
  worktreeId: string,
) {
  return explorerSummarySchema.parse(
    await request(`/api/explorers/${encodeURIComponent(explorerId)}/worktree`, {
      method: "PATCH",
      body: JSON.stringify({ worktreeId }),
    }),
  );
}

export async function renameExplorer(explorerId: string, title: string) {
  return explorerSummarySchema.parse(
    await request(`/api/explorers/${encodeURIComponent(explorerId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  );
}

export async function deleteExplorer(explorerId: string) {
  await request(`/api/explorers/${encodeURIComponent(explorerId)}`, {
    method: "DELETE",
  });
}

export async function getBrowsers(projectId: string) {
  return browserListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/browsers`),
  );
}

export async function createBrowser(projectId: string, title: string) {
  return browserSummarySchema.parse(
    await post(`/api/projects/${encodeURIComponent(projectId)}/browsers`, {
      title,
    }),
  );
}

export async function updateBrowser(
  browserId: string,
  input: { title?: string; url?: string },
) {
  return browserSummarySchema.parse(
    await request(`/api/browsers/${encodeURIComponent(browserId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function deleteBrowser(browserId: string) {
  await request(`/api/browsers/${encodeURIComponent(browserId)}`, {
    method: "DELETE",
  });
}

export async function getRemoteDesktops(projectId: string) {
  return remoteDesktopListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/remote-desktops`,
    ),
  );
}

export async function getRemoteDesktop(desktopId: string) {
  return remoteDesktopSummarySchema.parse(
    await request(`/api/remote-desktops/${encodeURIComponent(desktopId)}`),
  );
}

export async function createRemoteDesktop(projectId: string) {
  return remoteDesktopSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/remote-desktops`,
      {},
    ),
  );
}

export async function getProjectViews(projectId: string) {
  return projectViewListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/views`),
  );
}

export async function createProjectView(
  projectId: string,
  kind: ProjectViewKind,
  title: string,
  worktreeId?: string,
) {
  return projectViewSummarySchema.parse(
    await post(`/api/projects/${encodeURIComponent(projectId)}/views`, {
      kind,
      title,
      ...(worktreeId ? { worktreeId } : {}),
    }),
  );
}

export async function updateProjectViewWorktree(
  viewId: string,
  worktreeId: string,
) {
  return projectViewSummarySchema.parse(
    await request(`/api/project-views/${encodeURIComponent(viewId)}/worktree`, {
      method: "PATCH",
      body: JSON.stringify({ worktreeId }),
    }),
  );
}

export async function renameProjectView(viewId: string, title: string) {
  return projectViewSummarySchema.parse(
    await request(`/api/project-views/${encodeURIComponent(viewId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  );
}

export async function deleteProjectView(viewId: string) {
  await request(`/api/project-views/${encodeURIComponent(viewId)}`, {
    method: "DELETE",
  });
}

export async function getExplorerDirectory(explorerId: string, path: string) {
  return explorerDirectorySchema.parse(
    await request(
      `/api/explorers/${encodeURIComponent(explorerId)}/directory?path=${encodeURIComponent(path)}`,
    ),
  );
}

export async function getExplorerFile(explorerId: string, path: string) {
  return explorerFileSchema.parse(
    await request(
      `/api/explorers/${encodeURIComponent(explorerId)}/file?path=${encodeURIComponent(path)}`,
    ),
  );
}

export function terminalWebSocketUrl(terminalId: string): string {
  const url = new URL(
    `/api/terminals/${encodeURIComponent(terminalId)}/connect`,
    serverUrl || window.location.origin,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function remoteSurfaceWebSocketUrl(
  surfaceId: string,
  viewport: { width: number; height: number; devicePixelRatio: number },
): string {
  const url = new URL(
    `/api/remote-surfaces/${encodeURIComponent(surfaceId)}/connect`,
    serverUrl || window.location.origin,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("width", String(viewport.width));
  url.searchParams.set("height", String(viewport.height));
  url.searchParams.set("devicePixelRatio", String(viewport.devicePixelRatio));
  return url.toString();
}

export async function renameChat(chatId: string, title: string) {
  return chatSummarySchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  );
}

export async function updateChatWorktree(
  chatId: string,
  input: ChatWorktreeUpdate,
) {
  return chatSummarySchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/worktree`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function deleteChat(chatId: string) {
  await request(`/api/chats/${encodeURIComponent(chatId)}`, {
    method: "DELETE",
  });
}

export async function forkChat(chatId: string, messageId?: string) {
  return chatSummarySchema.parse(
    await post(`/api/chats/${encodeURIComponent(chatId)}/fork`, {
      ...(messageId ? { messageId } : {}),
    }),
  );
}

export async function compactChat(chatId: string) {
  return chatCompactAcceptedSchema.parse(
    await post(`/api/chats/${encodeURIComponent(chatId)}/compact`, {}),
  );
}

export async function getChatGoal(chatId: string) {
  return chatGoalResponseSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/goal`),
  );
}

export async function createChatGoal(chatId: string, input: ChatGoalCreate) {
  return chatGoalResponseSchema.parse(
    await post(
      `/api/chats/${encodeURIComponent(chatId)}/goal`,
      chatGoalCreateSchema.parse(input),
    ),
  );
}

export async function updateChatGoal(chatId: string, input: ChatGoalUpdate) {
  return chatGoalResponseSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/goal`, {
      method: "PATCH",
      body: JSON.stringify(chatGoalUpdateSchema.parse(input)),
    }),
  );
}

export async function clearChatGoal(chatId: string) {
  return chatGoalClearSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/goal`, {
      method: "DELETE",
    }),
  );
}

export async function syncChat(chatId: string) {
  return agentThreadSyncSchema.parse(
    await post(`/api/chats/${encodeURIComponent(chatId)}/sync`, {}),
  );
}

export async function createChatConsole(chatId: string) {
  return terminalSummarySchema.parse(
    await post(`/api/chats/${encodeURIComponent(chatId)}/console`, {}),
  );
}

export async function interruptChat(chatId: string) {
  return chatInterruptAcceptedSchema.parse(
    await post(`/api/chats/${encodeURIComponent(chatId)}/interrupt`, {}),
  );
}

export async function reorderProjects(ids: string[]) {
  await request("/api/projects/order", {
    method: "PATCH",
    body: JSON.stringify(orderedIdsSchema.parse({ ids })),
  });
}

export async function reorderProjectTabs(projectId: string, ids: string[]) {
  await request(`/api/projects/${encodeURIComponent(projectId)}/tabs/order`, {
    method: "PATCH",
    body: JSON.stringify(orderedIdsSchema.parse({ ids })),
  });
}

export async function getMessages(chatId: string) {
  return chatMessageListSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/messages`),
  );
}

export async function getSkills(chatId: string) {
  return skillListSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/skills`),
  );
}

export async function updateChatModel(chatId: string, modelId: string) {
  return chatSummarySchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/model`, {
      method: "PATCH",
      body: JSON.stringify({ modelId }),
    }),
  );
}

export async function startTurn(chatId: string, text: string, modelId: string) {
  return chatPromptSubmitResultSchema.parse(
    await post(`/api/chats/${encodeURIComponent(chatId)}/turns`, {
      text,
      modelId,
      idempotencyKey: crypto.randomUUID(),
    }),
  );
}

export async function getQueuedPrompts(chatId: string) {
  return queuedPromptListSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/queue`),
  );
}

export async function updateQueuedPrompt(
  promptId: string,
  input: { text?: string; frozen?: boolean },
) {
  return queuedPromptSchema.parse(
    await request(`/api/queued-prompts/${encodeURIComponent(promptId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function deleteQueuedPrompt(promptId: string) {
  await request(`/api/queued-prompts/${encodeURIComponent(promptId)}`, {
    method: "DELETE",
  });
}

export async function reorderQueuedPrompts(chatId: string, ids: string[]) {
  await request(`/api/chats/${encodeURIComponent(chatId)}/queue/order`, {
    method: "PATCH",
    body: JSON.stringify({ ids }),
  });
}

export async function steerQueuedPrompt(promptId: string) {
  return chatPromptSteerResultSchema.parse(
    await post(`/api/queued-prompts/${encodeURIComponent(promptId)}/steer`, {}),
  );
}
