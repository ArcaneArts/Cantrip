import {
  githubAuthStatusSchema,
  githubRepositoryListSchema,
  githubRepositoryOwnerListSchema,
  githubRepositoryCreateSchema,
  githubRepositorySchema,
  githubPullRequestCreateResultSchema,
  githubPullRequestDetailSchema,
  githubPullRequestOverviewSchema,
  githubPullRequestAgentContextSchema,
  githubPullRequestFilesSchema,
  githubPullRequestCommitsSchema,
  githubPullRequestChecksSchema,
  githubPullRequestCheckoutPreparedSchema,
  githubPullRequestCheckoutResultSchema,
  githubActionsOverviewSchema,
  githubActionsRunDetailSchema,
  githubActionsRunLogsSchema,
  githubActionsMutationResultSchema,
  githubActionsRunCheckoutPreparedSchema,
  githubActionsRunCheckoutResultSchema,
  githubPullRequestLifecyclePreviewSchema,
  githubIssueListSchema,
  githubInboxListSchema,
  githubPullRequestListSchema,
  githubIssueDetailSchema,
} from "@cantrip/protocol";
import type {
  GithubRepositoryCreate,
  GithubPullRequestCreate,
  GithubPullRequestAgentContextRequest,
  GithubActionsWorkflowDispatch,
  GithubActionsRunAction,
  GithubPullRequestReviewAction,
  GithubPullRequestLifecycleAction,
  GithubPullRequestLifecycleApply,
  GithubIssueState,
  GithubIssueListFilters,
  GithubIssueKind,
  GithubInboxView,
  GithubIssueCreate,
} from "@cantrip/protocol";
import { request } from "@/lib/api-client";
import {
  runProtectedWorkerRepositoryOperation,
  runProtectedRepositoryOperation,
} from "./repository-operations";
import { getProjectWorktrees, createProjectWorktree } from "./worktrees";

export async function getGithubStatus(workerId: string) {
  return runProtectedWorkerRepositoryOperation({
    workerId,
    scopeId: "github-catalog",
    type: "github.auth.status",
    arguments: {},
    resultSchema: githubAuthStatusSchema,
  });
}

export async function getGithubRepositories(workerId: string) {
  return runProtectedWorkerRepositoryOperation({
    workerId,
    scopeId: "github-catalog",
    type: "github.repositories.list",
    arguments: {},
    resultSchema: githubRepositoryListSchema,
  });
}

export async function getGithubRepositoryOwners(workerId: string) {
  return runProtectedWorkerRepositoryOperation({
    workerId,
    scopeId: "github-catalog",
    type: "github.repository-owners.list",
    arguments: {},
    resultSchema: githubRepositoryOwnerListSchema,
  });
}

export async function createGithubRepository(
  workerId: string,
  input: GithubRepositoryCreate,
) {
  return runProtectedWorkerRepositoryOperation({
    workerId,
    scopeId: "github-catalog",
    type: "github.repositories.create",
    arguments: { request: githubRepositoryCreateSchema.parse(input) },
    resultSchema: githubRepositorySchema,
  });
}

export async function getCachedGithubRepositories(
  workerId: string,
  login: string,
) {
  return runProtectedWorkerRepositoryOperation({
    workerId,
    scopeId: "github-catalog",
    type: "github.repositories.cached",
    arguments: { login },
    resultSchema: githubRepositoryListSchema,
  });
}

export async function createGithubPullRequest(
  projectId: string,
  worktreeId: string,
  request: GithubPullRequestCreate,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.pull-request.create",
    arguments: { request },
    resultSchema: githubPullRequestCreateResultSchema,
  });
}

export async function getGithubPullRequest(
  projectId: string,
  worktreeId: string,
  pullRequestNumber: number,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.pull-request.get",
    arguments: { number: pullRequestNumber },
    resultSchema: githubPullRequestDetailSchema,
  });
}

export async function getGithubPullRequestOverview(
  projectId: string,
  worktreeId: string,
  pullRequestNumber: number,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.pull-request.get",
    arguments: { number: pullRequestNumber, section: "overview" },
    resultSchema: githubPullRequestOverviewSchema,
  });
}

export async function getGithubPullRequestAgentContext(
  projectId: string,
  worktreeId: string,
  pullRequestNumber: number,
  request: GithubPullRequestAgentContextRequest,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.pull-request.agent-context",
    arguments: { number: pullRequestNumber, request },
    resultSchema: githubPullRequestAgentContextSchema,
  });
}

export async function getGithubPullRequestFiles(
  projectId: string,
  worktreeId: string,
  pullRequestNumber: number,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.pull-request.get",
    arguments: { number: pullRequestNumber, section: "files" },
    resultSchema: githubPullRequestFilesSchema,
  });
}

export async function getGithubPullRequestCommits(
  projectId: string,
  worktreeId: string,
  pullRequestNumber: number,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.pull-request.get",
    arguments: { number: pullRequestNumber, section: "commits" },
    resultSchema: githubPullRequestCommitsSchema,
  });
}

export async function getGithubPullRequestChecks(
  projectId: string,
  worktreeId: string,
  pullRequestNumber: number,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.pull-request.get",
    arguments: { number: pullRequestNumber, section: "checks" },
    resultSchema: githubPullRequestChecksSchema,
  });
}

export async function checkoutGithubPullRequest(
  projectId: string,
  worktreeId: string,
  pullRequestNumber: number,
  expectedHeadSha?: string,
) {
  const prepared = await runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.pull-request.checkout.prepare",
    arguments: { number: pullRequestNumber },
    resultSchema: githubPullRequestCheckoutPreparedSchema,
  });
  if (expectedHeadSha && prepared.headSha !== expectedHeadSha) {
    throw new Error(
      "The pull request advanced while its agent context was loading. Retry to use the new exact head.",
    );
  }
  const existing = (await getProjectWorktrees(projectId)).find(
    ({ branch }) => branch === prepared.branch,
  );
  if (existing) {
    if (
      existing.lifecycleState !== "ready" ||
      existing.head !== prepared.headSha
    ) {
      throw new Error(
        `The checkout branch ${prepared.branch} belongs to a worktree that is unavailable or no longer at the exact pull-request head.`,
      );
    }
    return githubPullRequestCheckoutResultSchema.parse({
      pullRequest: prepared.pullRequest,
      worktree: existing,
      reused: true,
    });
  }
  const worktree = await createProjectWorktree(projectId, {
    name: prepared.name,
    mode: {
      type: "newBranch",
      branch: prepared.branch,
      startPoint: prepared.headSha,
    },
  });
  return githubPullRequestCheckoutResultSchema.parse({
    pullRequest: prepared.pullRequest,
    worktree,
    reused: false,
  });
}

export async function getGithubActionsOverview(
  projectId: string,
  worktreeId: string,
  page = 1,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.actions.overview",
    arguments: { page, limit: 50 },
    resultSchema: githubActionsOverviewSchema,
  });
}

export async function getGithubActionsRun(
  projectId: string,
  worktreeId: string,
  runId: number,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.actions.run.get",
    arguments: { runId },
    resultSchema: githubActionsRunDetailSchema,
  });
}

export async function getGithubActionsRunLogs(
  projectId: string,
  worktreeId: string,
  runId: number,
  jobId: number | null,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.actions.run.logs",
    arguments: { runId, jobId },
    resultSchema: githubActionsRunLogsSchema,
  });
}

export async function dispatchGithubActionsWorkflow(
  projectId: string,
  worktreeId: string,
  request: GithubActionsWorkflowDispatch,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.actions.workflow.dispatch",
    arguments: { request },
    resultSchema: githubActionsMutationResultSchema,
  });
}

export async function runGithubActionsRunAction(
  projectId: string,
  worktreeId: string,
  request: GithubActionsRunAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.actions.run.action",
    arguments: { request },
    resultSchema: githubActionsMutationResultSchema,
  });
}

export async function checkoutGithubActionsRun(
  projectId: string,
  worktreeId: string,
  runId: number,
) {
  const prepared = await runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.actions.run.checkout.prepare",
    arguments: { runId },
    resultSchema: githubActionsRunCheckoutPreparedSchema,
  });
  const existing = (await getProjectWorktrees(projectId)).find(
    ({ branch }) => branch === prepared.branch,
  );
  if (existing) {
    return githubActionsRunCheckoutResultSchema.parse({
      run: prepared.run,
      worktree: existing,
      reused: true,
    });
  }
  const worktree = await createProjectWorktree(projectId, {
    name: prepared.name,
    mode: {
      type: "newBranch",
      branch: prepared.branch,
      startPoint: prepared.headSha,
    },
  });
  return githubActionsRunCheckoutResultSchema.parse({
    run: prepared.run,
    worktree,
    reused: false,
  });
}

export async function runGithubPullRequestReviewAction(
  projectId: string,
  worktreeId: string,
  pullRequestNumber: number,
  action: GithubPullRequestReviewAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.pull-request.review.mutate",
    arguments: { number: pullRequestNumber, action },
    resultSchema: githubPullRequestDetailSchema,
  });
}

export async function previewGithubPullRequestLifecycle(
  projectId: string,
  worktreeId: string,
  pullRequestNumber: number,
  action: GithubPullRequestLifecycleAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.pull-request.lifecycle.preview",
    arguments: { number: pullRequestNumber, action },
    resultSchema: githubPullRequestLifecyclePreviewSchema,
  });
}

export async function applyGithubPullRequestLifecycle(
  projectId: string,
  worktreeId: string,
  pullRequestNumber: number,
  input: GithubPullRequestLifecycleApply,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.pull-request.lifecycle.apply",
    arguments: { number: pullRequestNumber, request: input },
    resultSchema: githubPullRequestDetailSchema,
  });
}

export async function getGithubIssues(
  projectId: string,
  state: GithubIssueState,
  cursor: string | null = null,
  filters: Partial<GithubIssueListFilters> = {},
) {
  return runProtectedRepositoryOperation({
    projectId,
    type: "github.issues.list",
    arguments: { state, cursor, limit: 100, filters },
    resultSchema: githubIssueListSchema,
  });
}

export async function getGithubInbox(
  projectId: string,
  kind: GithubIssueKind,
  state: GithubIssueState,
  view: GithubInboxView,
  cursor: string | null = null,
) {
  return runProtectedRepositoryOperation({
    projectId,
    type: "github.inbox.list",
    arguments: { kind, state, view, cursor, limit: 50 },
    resultSchema: githubInboxListSchema,
  });
}

export async function getGithubPullRequests(
  projectId: string,
  state: GithubIssueState,
  cursor: string | null = null,
  filters: Partial<GithubIssueListFilters> = {},
) {
  return runProtectedRepositoryOperation({
    projectId,
    type: "github.pull-requests.list",
    arguments: { state, cursor, limit: 100, filters },
    resultSchema: githubPullRequestListSchema,
  });
}

export async function getGithubIssue(projectId: string, issueNumber: number) {
  return runProtectedRepositoryOperation({
    projectId,
    type: "github.issue.get",
    arguments: { number: issueNumber },
    resultSchema: githubIssueDetailSchema,
  });
}

export async function createGithubIssue(
  projectId: string,
  input: GithubIssueCreate,
) {
  return runProtectedRepositoryOperation({
    projectId,
    type: "github.issue.create",
    arguments: { request: input },
    resultSchema: githubIssueDetailSchema,
  });
}

export async function commentOnGithubIssue(
  projectId: string,
  issueNumber: number,
  body: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    type: "github.issue.comment",
    arguments: { number: issueNumber, body },
    resultSchema: githubIssueDetailSchema,
  });
}

export async function closeGithubIssue(
  projectId: string,
  issueNumber: number,
  comment: string | null,
) {
  return runProtectedRepositoryOperation({
    projectId,
    type: "github.issue.close",
    arguments: { number: issueNumber, comment },
    resultSchema: githubIssueDetailSchema,
  });
}
