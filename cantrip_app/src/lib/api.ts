import {
  agentInteractionRequestListSchema,
  agentInteractionRequestSchema,
  agentInteractionResolutionCreateSchema,
  browserListSchema,
  browserSummarySchema,
  agentThreadSyncSchema,
  chatListSchema,
  chatAttachmentSummarySchema,
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
  chatPlanAcceptedSchema,
  chatPlanAnswerSchema,
  chatPlanStateSchema,
  chatPlanUpdateSchema,
  chatPauseStateSchema,
  chatPauseUpdateSchema,
  chatPermissionProfileStateSchema,
  chatPermissionProfileUpdateSchema,
  chatPromptSteerResultSchema,
  chatPromptSubmitResultSchema,
  codeAttachmentSchema,
  codeRuntimeStatusSchema,
  codeSaveAllResultSchema,
  codeTabListSchema,
  codeTabSummarySchema,
  codexCustomizationInventorySchema,
  codexExternalImportApplySchema,
  codexExternalImportPreviewSchema,
  codexExternalImportStatusSchema,
  codexMcpOauthStartResultSchema,
  codexMcpOauthStartSchema,
  codexMcpOauthStatusSchema,
  codexMcpReloadResultSchema,
  codexMcpResourceReadRequestSchema,
  codexMcpResourceReadSchema,
  codexSkillConfigResultSchema,
  codexSkillConfigUpdateSchema,
  codexSkillRootsResultSchema,
  codexSkillRootsUpdateSchema,
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
  AgentInteractionRequestStatus,
  AgentInteractionResolutionCreate,
  ChatWorktreeUpdate,
  ChatAttachmentKind,
  ChatAttachmentSource,
  ChatGoalCreate,
  ChatGoalUpdate,
  ChatPlanAnswer,
  ChatPlanUpdate,
  ChatTurnMode,
  CodeAppearance,
  CodeThemeMode,
  CodexExternalImportApply,
  CodexMcpOauthStart,
  CodexMcpResourceReadRequest,
  CodexSkillConfigUpdate,
  CodexSkillRootsUpdate,
  GitAction,
  GithubIssueKind,
  GithubIssueState,
  ModelProfileCreate,
  ModelProfileUpdate,
  ModelProviderCreate,
  ModelProviderUpdate,
  ProjectViewKind,
  ProjectWorktreeCreate,
  RemoteDesktopTarget,
  UserSettingsUpdate,
  WorktreePolicy,
} from "@cantrip/protocol";
import {
  workflowDefinitionDetailSchema,
  workflowDefinitionListSchema,
  workflowGateDecisionSchema,
  workflowNodeRetrySchema,
  workflowRunCancelSchema,
  workflowRunCreateSchema,
  workflowRunDetailSchema,
  workflowRunListSchema,
  workflowRunPauseSchema,
  workflowRunResumeSchema,
  workflowWorktreeOutcomeRequestSchema,
  type WorkflowDefinitionQuery,
  type WorkflowGateDecision,
  type WorkflowNodeRetry,
  type WorkflowRunCancel,
  type WorkflowRunCreate,
  type WorkflowRunPause,
  type WorkflowRunQuery,
  type WorkflowRunResume,
  type WorkflowWorktreeOutcomeRequest,
} from "@cantrip/protocol/workflows";
import { getActiveServerUrl } from "@/lib/server-connections";

export class CantripApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${getActiveServerUrl()}${path}`, {
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

function withQuery(
  path: string,
  input: Record<string, boolean | number | string | undefined>,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export async function getWorkflows(
  input: Partial<WorkflowDefinitionQuery> = {},
) {
  return workflowDefinitionListSchema.parse(
    await request(
      withQuery("/api/workflows", {
        scope: input.scope,
        projectId: input.projectId,
        includeArchived: input.includeArchived,
        limit: input.limit,
      }),
    ),
  );
}

export async function getWorkflow(workflowId: string) {
  return workflowDefinitionDetailSchema.parse(
    await request(`/api/workflows/${encodeURIComponent(workflowId)}`),
  );
}

export async function getWorkflowRuns(input: Partial<WorkflowRunQuery> = {}) {
  return workflowRunListSchema.parse(
    await request(
      withQuery("/api/workflow-runs", {
        workflowId: input.workflowId,
        projectId: input.projectId,
        status: input.status,
        recoveryState: input.recoveryState,
        limit: input.limit,
      }),
    ),
  );
}

export async function getWorkflowRun(runId: string) {
  return workflowRunDetailSchema.parse(
    await request(`/api/workflow-runs/${encodeURIComponent(runId)}`),
  );
}

export async function createWorkflowRun(input: WorkflowRunCreate) {
  return workflowRunDetailSchema.parse(
    await post("/api/workflow-runs", workflowRunCreateSchema.parse(input)),
  );
}

export async function pauseWorkflowRun(runId: string, input: WorkflowRunPause) {
  return workflowRunDetailSchema.parse(
    await post(
      `/api/workflow-runs/${encodeURIComponent(runId)}/pause`,
      workflowRunPauseSchema.parse(input),
    ),
  );
}

export async function resumeWorkflowRun(
  runId: string,
  input: WorkflowRunResume,
) {
  return workflowRunDetailSchema.parse(
    await post(
      `/api/workflow-runs/${encodeURIComponent(runId)}/resume`,
      workflowRunResumeSchema.parse(input),
    ),
  );
}

export async function cancelWorkflowRun(
  runId: string,
  input: WorkflowRunCancel,
) {
  return workflowRunDetailSchema.parse(
    await post(
      `/api/workflow-runs/${encodeURIComponent(runId)}/cancel`,
      workflowRunCancelSchema.parse(input),
    ),
  );
}

export async function decideWorkflowGate(
  runId: string,
  gateId: string,
  input: WorkflowGateDecision,
) {
  return workflowRunDetailSchema.parse(
    await post(
      `/api/workflow-runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(gateId)}/decision`,
      workflowGateDecisionSchema.parse(input),
    ),
  );
}

export async function retryWorkflowNode(
  runId: string,
  runNodeId: string,
  input: WorkflowNodeRetry,
) {
  return workflowRunDetailSchema.parse(
    await post(
      `/api/workflow-runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(runNodeId)}/retry`,
      workflowNodeRetrySchema.parse(input),
    ),
  );
}

export async function resolveWorkflowWorktree(
  runId: string,
  leaseId: string,
  input: WorkflowWorktreeOutcomeRequest,
) {
  return workflowRunDetailSchema.parse(
    await post(
      `/api/workflow-runs/${encodeURIComponent(runId)}/worktree-leases/${encodeURIComponent(leaseId)}/outcome`,
      workflowWorktreeOutcomeRequestSchema.parse(input),
    ),
  );
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
  kind: GithubIssueKind,
  state: GithubIssueState,
  page = 1,
) {
  return githubIssueListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/github/issues?kind=${encodeURIComponent(kind)}&state=${encodeURIComponent(state)}&page=${page}&limit=100`,
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

export async function updateRemoteDesktopTarget(
  desktopId: string,
  target: RemoteDesktopTarget,
) {
  return remoteDesktopSummarySchema.parse(
    await request(`/api/remote-desktops/${encodeURIComponent(desktopId)}`, {
      method: "PATCH",
      body: JSON.stringify({ target }),
    }),
  );
}

export async function getProjectViews(projectId: string) {
  return projectViewListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/views`),
  );
}

export async function getCodeTabs(projectId: string) {
  return codeTabListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/code-tabs`),
  );
}

export async function createCodeTab(
  projectId: string,
  title = "Code",
  worktreeId?: string,
) {
  return codeTabSummarySchema.parse(
    await post(`/api/projects/${encodeURIComponent(projectId)}/code-tabs`, {
      title,
      ...(worktreeId ? { worktreeId } : {}),
    }),
  );
}

export async function updateCodeTab(
  codeTabId: string,
  input: { title?: string; themeMode?: CodeThemeMode },
) {
  return codeTabSummarySchema.parse(
    await request(`/api/code-tabs/${encodeURIComponent(codeTabId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function updateCodeTabWorktree(
  codeTabId: string,
  worktreeId: string,
) {
  return codeTabSummarySchema.parse(
    await request(`/api/code-tabs/${encodeURIComponent(codeTabId)}/worktree`, {
      method: "PATCH",
      body: JSON.stringify({ worktreeId }),
    }),
  );
}

export async function deleteCodeTab(codeTabId: string) {
  await request(`/api/code-tabs/${encodeURIComponent(codeTabId)}`, {
    method: "DELETE",
  });
}

export async function createCodeAttachment(
  codeTabId: string,
  appearance: CodeAppearance,
) {
  return codeAttachmentSchema.parse(
    await post(`/api/code-tabs/${encodeURIComponent(codeTabId)}/attachments`, {
      appearance,
    }),
  );
}

export async function saveAllCodeTab(codeTabId: string) {
  return codeSaveAllResultSchema.parse(
    await post(`/api/code-tabs/${encodeURIComponent(codeTabId)}/save-all`, {}),
  );
}

export async function stopCodeTab(codeTabId: string) {
  const result = await post(
    `/api/code-tabs/${encodeURIComponent(codeTabId)}/stop`,
    {},
  );
  return result === null ? null : codeRuntimeStatusSchema.parse(result);
}

export async function setCodeTabTheme(
  codeTabId: string,
  themeMode: CodeThemeMode,
  appearance: CodeAppearance,
) {
  return codeTabSummarySchema.parse(
    await post(`/api/code-tabs/${encodeURIComponent(codeTabId)}/theme`, {
      themeMode,
      appearance,
    }),
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
  const serverUrl = getActiveServerUrl();
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
  const serverUrl = getActiveServerUrl();
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

export async function getChatPlan(chatId: string) {
  return chatPlanStateSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/plan`),
  );
}

export async function updateChatPlan(chatId: string, input: ChatPlanUpdate) {
  return chatPlanStateSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/plan`, {
      method: "PATCH",
      body: JSON.stringify(chatPlanUpdateSchema.parse(input)),
    }),
  );
}

export async function answerChatPlan(chatId: string, input: ChatPlanAnswer) {
  return chatPlanAcceptedSchema.parse(
    await post(
      `/api/chats/${encodeURIComponent(chatId)}/plan/answer`,
      chatPlanAnswerSchema.parse(input),
    ),
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

export async function setChatPaused(chatId: string, paused: boolean) {
  return chatPauseStateSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/pause`, {
      method: "PATCH",
      body: JSON.stringify(chatPauseUpdateSchema.parse({ paused })),
    }),
  );
}

export async function getChatPermissionProfiles(chatId: string) {
  return chatPermissionProfileStateSchema.parse(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/permission-profiles`,
    ),
  );
}

export async function updateChatPermissionProfile(chatId: string, id: string) {
  return chatPermissionProfileStateSchema.parse(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/permission-profile`,
      {
        method: "PATCH",
        body: JSON.stringify(chatPermissionProfileUpdateSchema.parse({ id })),
      },
    ),
  );
}

export async function getAgentInteractionRequests(
  input: {
    chatId?: string;
    status?: AgentInteractionRequestStatus;
    limit?: number;
  } = {},
) {
  const query = new URLSearchParams();
  if (input.chatId) query.set("chatId", input.chatId);
  if (input.status) query.set("status", input.status);
  if (input.limit) query.set("limit", String(input.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return agentInteractionRequestListSchema.parse(
    await request(`/api/agent-requests${suffix}`),
  );
}

export async function respondToAgentInteractionRequest(
  requestId: string,
  input: AgentInteractionResolutionCreate,
) {
  return agentInteractionRequestSchema.parse(
    await post(
      `/api/agent-requests/${encodeURIComponent(requestId)}/respond`,
      agentInteractionResolutionCreateSchema.parse(input),
    ),
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

export async function getChatCustomizations(chatId: string, refresh = false) {
  const query = refresh ? "?refresh=true" : "";
  return codexCustomizationInventorySchema.parse(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/customizations${query}`,
    ),
  );
}

export async function getChatExternalImportPreview(chatId: string) {
  return codexExternalImportPreviewSchema.parse(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/customizations/external-preview`,
    ),
  );
}

export async function readChatMcpResource(
  chatId: string,
  input: CodexMcpResourceReadRequest,
) {
  return codexMcpResourceReadSchema.parse(
    await post(
      `/api/chats/${encodeURIComponent(chatId)}/customizations/mcp-resource`,
      codexMcpResourceReadRequestSchema.parse(input),
    ),
  );
}

export async function configureChatSkill(
  chatId: string,
  input: CodexSkillConfigUpdate,
) {
  return codexSkillConfigResultSchema.parse(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/customizations/skill`,
      {
        method: "PATCH",
        body: JSON.stringify(codexSkillConfigUpdateSchema.parse(input)),
      },
    ),
  );
}

export async function setChatSkillRoots(
  chatId: string,
  input: CodexSkillRootsUpdate,
) {
  return codexSkillRootsResultSchema.parse(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/customizations/skill-roots`,
      {
        method: "PUT",
        body: JSON.stringify(codexSkillRootsUpdateSchema.parse(input)),
      },
    ),
  );
}

export async function startChatMcpOauth(
  chatId: string,
  input: CodexMcpOauthStart,
) {
  return codexMcpOauthStartResultSchema.parse(
    await post(
      `/api/chats/${encodeURIComponent(chatId)}/customizations/mcp-oauth`,
      codexMcpOauthStartSchema.parse(input),
    ),
  );
}

export async function getChatMcpOauthStatus(chatId: string, server: string) {
  return codexMcpOauthStatusSchema.parse(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/customizations/mcp-oauth/status?server=${encodeURIComponent(server)}`,
    ),
  );
}

export async function reloadChatMcpServers(chatId: string) {
  return codexMcpReloadResultSchema.parse(
    await post(
      `/api/chats/${encodeURIComponent(chatId)}/customizations/mcp-reload`,
      {},
    ),
  );
}

export async function applyChatExternalImport(
  chatId: string,
  input: CodexExternalImportApply,
) {
  return codexExternalImportStatusSchema.parse(
    await post(
      `/api/chats/${encodeURIComponent(chatId)}/customizations/external-import`,
      codexExternalImportApplySchema.parse(input),
    ),
  );
}

export async function getChatExternalImportStatus(
  chatId: string,
  importId: string,
) {
  return codexExternalImportStatusSchema.parse(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/customizations/external-import/status?importId=${encodeURIComponent(importId)}`,
    ),
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

export async function startTurn(
  chatId: string,
  text: string,
  modelId: string,
  attachmentIds: string[] = [],
  mode: ChatTurnMode = "default",
) {
  return chatPromptSubmitResultSchema.parse(
    await post(`/api/chats/${encodeURIComponent(chatId)}/turns`, {
      text,
      attachmentIds,
      mode,
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
  input: {
    attachmentIds?: string[];
    text?: string;
    mode?: ChatTurnMode;
    frozen?: boolean;
  },
) {
  return queuedPromptSchema.parse(
    await request(`/api/queued-prompts/${encodeURIComponent(promptId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function uploadChatAttachment(
  chatId: string,
  file: File,
  kind: ChatAttachmentKind,
  source: ChatAttachmentSource,
) {
  const response = await fetch(
    `${getActiveServerUrl()}/api/chats/${encodeURIComponent(chatId)}/attachments`,
    {
      method: "POST",
      body: file,
      credentials: "include",
      headers: {
        accept: "application/json",
        "content-type": "application/octet-stream",
        "x-cantrip-attachment-kind": kind,
        "x-cantrip-attachment-source": source,
        "x-cantrip-file-name": encodeURIComponent(file.name),
        "x-cantrip-mime-type": file.type || "application/octet-stream",
      },
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new CantripApiError(
      body?.error ?? `Cantrip Server returned HTTP ${response.status}.`,
      response.status,
    );
  }
  return chatAttachmentSummarySchema.parse(await response.json());
}

export async function deleteChatAttachment(attachmentId: string) {
  await request(`/api/attachments/${encodeURIComponent(attachmentId)}`, {
    method: "DELETE",
  });
}

export function chatAttachmentContentUrl(attachmentId: string): string {
  return `${getActiveServerUrl()}/api/attachments/${encodeURIComponent(attachmentId)}/content`;
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
