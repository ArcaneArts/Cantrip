import type {
  GitDiffScope,
  GitHistoryOptions,
  GitGraphRequest,
  GitGraphCommitOverlayRequest,
  GitCommitSearchQuery,
  GitRecoveryAction,
  GitRecoveryApply,
  GitAction,
  GitAgentDraftCreate,
  GitBranchAction,
  GitCommitAction,
  GitWorktreeChangesMoveRequest,
  GitManagedOperationAction,
  GitConflictResolutionRequest,
  GitRemoteAction,
  GitSubmoduleAction,
  GitLfsAction,
  GitTagAction,
  GithubReleaseCreate,
  GitPartialPatchRequest,
  GitStashCreate,
  GitStashAction,
} from "@cantrip/protocol";
import {
  gitFileDiffSchema,
  gitHistorySchema,
  gitGraphRequestSchema,
  gitGraphSnapshotSchema,
  gitGraphMetricsSchema,
  gitGraphCommitOverlayRequestSchema,
  gitGraphCommitOverlaySchema,
  gitFileHistorySchema,
  gitBlameSchema,
  gitCommitSearchResultSchema,
  gitRecoveryCandidateListSchema,
  gitRecoveryPreviewSchema,
  gitRecoveryResultSchema,
  gitCommitDetailSchema,
  gitSignatureSchema,
  gitRevisionCandidateListSchema,
  gitComparisonSchema,
  gitRevisionFileDiffSchema,
  gitActionResultSchema,
  gitAgentDraftCreateSchema,
  gitAgentDraftResultSchema,
  gitForcePushPreviewSchema,
  gitBranchListSchema,
  gitBranchActionPreviewSchema,
  gitBranchMutationResultSchema,
  gitCommitActionPreviewSchema,
  gitCommitActionResultSchema,
  gitWorktreeChangesMovePreviewSchema,
  gitWorktreeChangesMoveResultSchema,
  gitManagedOperationResponseSchema,
  gitManagedOperationPreviewSchema,
  gitConflictListSchema,
  gitConflictDetailSchema,
  gitConflictResolutionPreviewSchema,
  gitConflictResolutionResultSchema,
  gitRemoteListSchema,
  gitRemoteActionPreviewSchema,
  gitRemoteMutationResultSchema,
  gitSubmoduleListSchema,
  gitSubmoduleActionPreviewSchema,
  gitSubmoduleMutationResultSchema,
  gitLfsStatusSchema,
  gitLfsActionPreviewSchema,
  gitLfsMutationResultSchema,
  gitTagListSchema,
  gitTagDetailSchema,
  gitTagActionPreviewSchema,
  gitTagMutationResultSchema,
  githubReleaseListSchema,
  githubReleaseSummarySchema,
  gitPartialPatchPreviewSchema,
  gitStashListSchema,
  gitStashMutationResultSchema,
  gitStashFileDiffSchema,
  gitStashActionPreviewSchema,
  projectRepositoryStatsSchema,
  gitStatusSchema,
} from "@cantrip/protocol";
import { request } from "@/lib/api-client";
import { runProtectedRepositoryOperation } from "./repository-operations";

export async function getProjectWorktreeFileDiff(
  projectId: string,
  worktreeId: string,
  path: string,
  scope: GitDiffScope,
  contextLines = 3,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.diff",
    arguments: { contextLines, path, scope },
    resultSchema: gitFileDiffSchema,
  });
}

export async function getProjectWorktreeHistory(
  projectId: string,
  worktreeId: string,
  cursor = 0,
  options?: GitHistoryOptions,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.history",
    arguments: { cursor, limit: 100, revisions: [], options },
    resultSchema: gitHistorySchema,
  });
}

export async function getProjectWorktreeGraphSnapshot(
  projectId: string,
  worktreeId: string,
  input: Partial<GitGraphRequest> = {},
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.graph.snapshot",
    arguments: gitGraphRequestSchema.parse(input),
    resultSchema: gitGraphSnapshotSchema,
  });
}

export async function getProjectWorktreeGraphMetrics(
  projectId: string,
  worktreeId: string,
  input: Partial<GitGraphRequest> = {},
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.graph.metrics",
    arguments: gitGraphRequestSchema.parse(input),
    resultSchema: gitGraphMetricsSchema,
  });
}

export async function getProjectWorktreeGraphCommitOverlay(
  projectId: string,
  worktreeId: string,
  input: GitGraphCommitOverlayRequest,
) {
  const parsed = gitGraphCommitOverlayRequestSchema.parse(input);
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.graph.commit-overlay",
    arguments: parsed,
    resultSchema: gitGraphCommitOverlaySchema,
  });
}

export async function getProjectWorktreeFileHistory(
  projectId: string,
  worktreeId: string,
  path: string,
  revision = "HEAD",
  cursor = 0,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.file.history",
    arguments: { path, revision, cursor, limit: 100 },
    resultSchema: gitFileHistorySchema,
  });
}

export async function getProjectWorktreeFileBlame(
  projectId: string,
  worktreeId: string,
  path: string,
  revision = "HEAD",
  cursor = 0,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.file.blame",
    arguments: { path, revision, cursor, limit: 200 },
    resultSchema: gitBlameSchema,
  });
}

export async function searchProjectWorktreeCommits(
  projectId: string,
  worktreeId: string,
  query: GitCommitSearchQuery,
  cursor = 0,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.commit.search",
    arguments: { query, cursor, limit: 100 },
    resultSchema: gitCommitSearchResultSchema,
  });
}

export async function getProjectWorktreeRecoveryCandidates(
  projectId: string,
  worktreeId: string,
  kind: "reflog" | "dangling",
  cursor = 0,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.recovery.list",
    arguments: { kind, cursor, limit: 100 },
    resultSchema: gitRecoveryCandidateListSchema,
  });
}

export async function previewProjectWorktreeRecovery(
  projectId: string,
  worktreeId: string,
  action: GitRecoveryAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.recovery.preview",
    arguments: { action },
    resultSchema: gitRecoveryPreviewSchema,
  });
}

export async function applyProjectWorktreeRecovery(
  projectId: string,
  worktreeId: string,
  recovery: GitRecoveryApply,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.recovery.apply",
    arguments: { request: recovery },
    resultSchema: gitRecoveryResultSchema,
  });
}

export async function getProjectWorktreeCommit(
  projectId: string,
  worktreeId: string,
  revision: string,
  parentIndex = 0,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.commit.get",
    arguments: { revision, parentIndex, revisions: [] },
    resultSchema: gitCommitDetailSchema,
  });
}

export async function getProjectWorktreeCommitSignature(
  projectId: string,
  worktreeId: string,
  revision: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.commit.signature.get",
    arguments: { revision },
    resultSchema: gitSignatureSchema,
  });
}

export async function getProjectWorktreeRevisionCandidates(
  projectId: string,
  worktreeId: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.refs.list",
    arguments: {},
    resultSchema: gitRevisionCandidateListSchema,
  });
}

export async function getProjectWorktreeComparison(
  projectId: string,
  worktreeId: string,
  left: string,
  right: string,
  mode: "direct" | "merge-base",
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.compare",
    arguments: { left, right, mode },
    resultSchema: gitComparisonSchema,
  });
}

export async function getProjectWorktreeRevisionDiff(
  projectId: string,
  worktreeId: string,
  revision: string,
  baseRevision: string | null,
  path: string,
  contextLines = 3,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.revision.diff",
    arguments: { revision, baseRevision, path, contextLines },
    resultSchema: gitRevisionFileDiffSchema,
  });
}

export async function runProjectWorktreeGitAction(
  projectId: string,
  worktreeId: string,
  action: GitAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.action",
    arguments: { action },
    resultSchema: gitActionResultSchema,
  });
}

export async function generateProjectWorktreeGitDraft(
  projectId: string,
  worktreeId: string,
  input: GitAgentDraftCreate,
) {
  const request = gitAgentDraftCreateSchema.parse(input);
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.agent.generate",
    arguments: request,
    agent: true,
    modelId: request.modelId,
    resultSchema: gitAgentDraftResultSchema,
  });
}

export async function previewProjectWorktreeGitForcePush(
  projectId: string,
  worktreeId: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.force-push.preview",
    arguments: {},
    resultSchema: gitForcePushPreviewSchema,
  });
}

export async function applyProjectWorktreeGitForcePush(
  projectId: string,
  worktreeId: string,
  token: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.force-push.apply",
    arguments: { token },
    resultSchema: gitActionResultSchema,
  });
}

export async function getProjectWorktreeBranches(
  projectId: string,
  worktreeId: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.branch.list",
    arguments: {},
    resultSchema: gitBranchListSchema,
  });
}

export async function previewProjectWorktreeBranchAction(
  projectId: string,
  worktreeId: string,
  action: GitBranchAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.branch.action.preview",
    arguments: { action },
    resultSchema: gitBranchActionPreviewSchema,
  });
}

export async function applyProjectWorktreeBranchAction(
  projectId: string,
  worktreeId: string,
  action: GitBranchAction,
  token: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.branch.action.apply",
    arguments: { action, token },
    resultSchema: gitBranchMutationResultSchema,
  });
}

export async function previewProjectWorktreeCommitAction(
  projectId: string,
  worktreeId: string,
  action: GitCommitAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.commit.action.preview",
    arguments: { action },
    resultSchema: gitCommitActionPreviewSchema,
  });
}

export async function applyProjectWorktreeCommitAction(
  projectId: string,
  worktreeId: string,
  action: GitCommitAction,
  token: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.commit.action.apply",
    arguments: { action, token },
    resultSchema: gitCommitActionResultSchema,
  });
}

export async function previewProjectWorktreeChangesMove(
  projectId: string,
  sourceWorktreeId: string,
  targetWorktreeId: string,
) {
  const request: GitWorktreeChangesMoveRequest = { sourceWorktreeId };
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId: targetWorktreeId,
    peerWorktreeId: sourceWorktreeId,
    type: "git.worktree.changes.preview",
    arguments: { request },
    resultSchema: gitWorktreeChangesMovePreviewSchema,
  });
}

export async function applyProjectWorktreeChangesMove(
  projectId: string,
  sourceWorktreeId: string,
  targetWorktreeId: string,
  token: string,
) {
  const request: GitWorktreeChangesMoveRequest = { sourceWorktreeId };
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId: targetWorktreeId,
    peerWorktreeId: sourceWorktreeId,
    type: "git.worktree.changes.apply",
    arguments: { request, token },
    resultSchema: gitWorktreeChangesMoveResultSchema,
  });
}

export async function getProjectWorktreeGitOperation(
  projectId: string,
  worktreeId: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.operation.current",
    arguments: {},
    resultSchema: gitManagedOperationResponseSchema,
  });
}

export async function previewProjectWorktreeGitOperation(
  projectId: string,
  worktreeId: string,
  action: GitManagedOperationAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.operation.preview",
    arguments: { action },
    resultSchema: gitManagedOperationPreviewSchema,
  });
}

export async function startProjectWorktreeGitOperation(
  projectId: string,
  worktreeId: string,
  action: GitManagedOperationAction,
  token: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.operation.start",
    arguments: { action, token },
    resultSchema: gitManagedOperationResponseSchema,
  });
}

export async function controlProjectWorktreeGitOperation(
  projectId: string,
  worktreeId: string,
  operationId: string,
  action: "continue" | "skip" | "abort" | "good" | "bad" | "reset",
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.operation.control",
    arguments: { operationId, action },
    resultSchema: gitManagedOperationResponseSchema,
  });
}

export async function amendProjectWorktreeGitOperation(
  projectId: string,
  worktreeId: string,
  operationId: string,
  message: string | null,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.operation.amend",
    arguments: { operationId, message },
    resultSchema: gitManagedOperationResponseSchema,
  });
}

export async function getProjectWorktreeGitConflicts(
  projectId: string,
  worktreeId: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.conflicts.list",
    arguments: {},
    resultSchema: gitConflictListSchema,
  });
}

export async function getProjectWorktreeGitConflict(
  projectId: string,
  worktreeId: string,
  path: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.conflicts.get",
    arguments: { path },
    resultSchema: gitConflictDetailSchema,
  });
}

export async function previewProjectWorktreeGitConflictResolution(
  projectId: string,
  worktreeId: string,
  resolution: GitConflictResolutionRequest,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.conflicts.preview",
    arguments: { request: resolution },
    resultSchema: gitConflictResolutionPreviewSchema,
  });
}

export async function applyProjectWorktreeGitConflictResolution(
  projectId: string,
  worktreeId: string,
  resolution: GitConflictResolutionRequest,
  token: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.conflicts.apply",
    arguments: { request: resolution, token },
    resultSchema: gitConflictResolutionResultSchema,
  });
}

export async function getProjectWorktreeRemotes(
  projectId: string,
  worktreeId: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.remote.list",
    arguments: {},
    resultSchema: gitRemoteListSchema,
  });
}

export async function previewProjectWorktreeRemoteAction(
  projectId: string,
  worktreeId: string,
  action: GitRemoteAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.remote.action.preview",
    arguments: { action },
    resultSchema: gitRemoteActionPreviewSchema,
  });
}

export async function applyProjectWorktreeRemoteAction(
  projectId: string,
  worktreeId: string,
  action: GitRemoteAction,
  token: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.remote.action.apply",
    arguments: { action, token },
    resultSchema: gitRemoteMutationResultSchema,
  });
}

export async function getProjectWorktreeSubmodules(
  projectId: string,
  worktreeId: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.submodule.list",
    arguments: {},
    resultSchema: gitSubmoduleListSchema,
  });
}

export async function previewProjectWorktreeSubmoduleAction(
  projectId: string,
  worktreeId: string,
  action: GitSubmoduleAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.submodule.action.preview",
    arguments: { action },
    resultSchema: gitSubmoduleActionPreviewSchema,
  });
}

export async function applyProjectWorktreeSubmoduleAction(
  projectId: string,
  worktreeId: string,
  action: GitSubmoduleAction,
  token: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.submodule.action.apply",
    arguments: { action, token },
    resultSchema: gitSubmoduleMutationResultSchema,
  });
}

export async function getProjectWorktreeGitLfs(
  projectId: string,
  worktreeId: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.lfs.status",
    arguments: { refreshLocks: true },
    resultSchema: gitLfsStatusSchema,
  });
}

export async function previewProjectWorktreeGitLfsAction(
  projectId: string,
  worktreeId: string,
  action: GitLfsAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.lfs.action.preview",
    arguments: { action },
    resultSchema: gitLfsActionPreviewSchema,
  });
}

export async function applyProjectWorktreeGitLfsAction(
  projectId: string,
  worktreeId: string,
  action: GitLfsAction,
  token: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.lfs.action.apply",
    arguments: { action, token },
    resultSchema: gitLfsMutationResultSchema,
  });
}

export async function getProjectWorktreeTags(
  projectId: string,
  worktreeId: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.tag.list",
    arguments: {},
    resultSchema: gitTagListSchema,
  });
}

export async function getProjectWorktreeTag(
  projectId: string,
  worktreeId: string,
  name: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.tag.get",
    arguments: { name },
    resultSchema: gitTagDetailSchema,
  });
}

export async function previewProjectWorktreeTagAction(
  projectId: string,
  worktreeId: string,
  action: GitTagAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.tag.action.preview",
    arguments: { action },
    resultSchema: gitTagActionPreviewSchema,
  });
}

export async function applyProjectWorktreeTagAction(
  projectId: string,
  worktreeId: string,
  action: GitTagAction,
  token: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.tag.action.apply",
    arguments: { action, token },
    resultSchema: gitTagMutationResultSchema,
  });
}

export async function getProjectWorktreeGithubReleases(
  projectId: string,
  worktreeId: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.releases.list",
    arguments: {},
    resultSchema: githubReleaseListSchema,
  });
}

export async function getProjectWorktreeGithubRelease(
  projectId: string,
  worktreeId: string,
  releaseId: number,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.release.get",
    arguments: { releaseId },
    resultSchema: githubReleaseSummarySchema,
  });
}

export async function createProjectWorktreeGithubRelease(
  projectId: string,
  worktreeId: string,
  input: GithubReleaseCreate,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.release.create",
    arguments: { request: input },
    resultSchema: githubReleaseSummarySchema,
  });
}

export async function previewProjectWorktreePartialPatch(
  projectId: string,
  worktreeId: string,
  input: GitPartialPatchRequest,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.patch.preview",
    arguments: { request: input },
    resultSchema: gitPartialPatchPreviewSchema,
  });
}

export async function applyProjectWorktreePartialPatch(
  projectId: string,
  worktreeId: string,
  request: GitPartialPatchRequest,
  token: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.patch.apply",
    arguments: { request, token },
    resultSchema: gitActionResultSchema,
  });
}

export async function getProjectWorktreeStashes(
  projectId: string,
  worktreeId: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.stash.list",
    arguments: {},
    resultSchema: gitStashListSchema,
  });
}

export async function createProjectWorktreeStash(
  projectId: string,
  worktreeId: string,
  input: GitStashCreate,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.stash.create",
    arguments: { request: input },
    resultSchema: gitStashMutationResultSchema,
  });
}

export async function getProjectWorktreeStashFileDiff(
  projectId: string,
  worktreeId: string,
  hash: string,
  path: string,
  contextLines = 3,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.stash.diff",
    arguments: { hash, path, contextLines },
    resultSchema: gitStashFileDiffSchema,
  });
}

export async function previewProjectWorktreeStashAction(
  projectId: string,
  worktreeId: string,
  action: GitStashAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.stash.action.preview",
    arguments: { action },
    resultSchema: gitStashActionPreviewSchema,
  });
}

export async function applyProjectWorktreeStashAction(
  projectId: string,
  worktreeId: string,
  action: GitStashAction,
  token: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.stash.action.apply",
    arguments: { action, token },
    resultSchema: gitStashMutationResultSchema,
  });
}

export async function getGitHistory(
  projectId: string,
  cursor = 0,
  options?: GitHistoryOptions,
) {
  return runProtectedRepositoryOperation({
    projectId,
    type: "git.history",
    arguments: { cursor, limit: 100, revisions: [], options },
    resultSchema: gitHistorySchema,
  });
}

export async function getProjectRepositoryStats(projectId: string) {
  return projectRepositoryStatsSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/repository-stats`,
    ),
  );
}

export async function getGitStatus(projectId: string) {
  return runProtectedRepositoryOperation({
    projectId,
    type: "git.status",
    arguments: {},
    resultSchema: gitStatusSchema,
  });
}

export async function runGitAction(projectId: string, action: GitAction) {
  return runProtectedRepositoryOperation({
    projectId,
    type: "git.action",
    arguments: { action },
    resultSchema: gitActionResultSchema,
  });
}
