import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  githubAuthStatusSchema,
  githubIssueCreateSchema,
  githubIssueDetailSchema,
  githubIssueListFiltersSchema,
  githubIssueListSchema,
  githubPullRequestChecksSchema,
  githubPullRequestCommitsSchema,
  githubPullRequestFilesSchema,
  githubPullRequestListSchema,
  githubPullRequestOverviewSchema,
  githubPullRequestCreateResultSchema,
  githubPullRequestCheckoutPreparedSchema,
  githubPullRequestDetailSchema,
  githubPullRequestAgentContextSchema,
  githubPullRequestLifecyclePreviewSchema,
  githubPullRequestSummarySchema,
  githubActionsArtifactSchema,
  githubActionsJobSchema,
  githubActionsMutationResultSchema,
  githubActionsOverviewSchema,
  githubActionsRunCheckoutPreparedSchema,
  githubActionsRunDetailSchema,
  githubActionsRunLogsSchema,
  githubActionsRunActionSchema,
  githubActionsRunSchema,
  githubActionsRunnerSchema,
  githubActionsWorkflowDispatchSchema,
  githubActionsWorkflowSchema,
  githubReleaseListSchema,
  githubReleaseSummarySchema,
  githubRepositoryOwnerListSchema,
  githubRepositoryCreateSchema,
  githubWorkerRepositorySchema,
  githubWorkerRepositoryListSchema,
  projectCloneResultSchema,
  projectGithubConversionRepositorySchema,
  projectReplicaProvisionResultSchema,
  projectReplicaLinkRepairResultSchema,
  projectReplicaRemoveResultSchema,
  projectReplicaSynchronizeResultSchema,
  worktreePolicySchema,
  type GithubAuthStatus,
  type GithubInboxList,
  type GithubInboxView,
  type GithubIssueCreate,
  type GithubIssueDetail,
  type GithubIssueListFilters,
  type GithubIssueList,
  type GithubIssueState,
  type GithubIssueSummary,
  type GithubPullRequestCreate,
  type GithubPullRequestCreateResult,
  type GithubPullRequestCheckoutPrepared,
  type GithubPullRequestAgentContext,
  type GithubPullRequestAgentContextRequest,
  type GithubPullRequestCheck,
  type GithubPullRequestChecks,
  type GithubPullRequestCommits,
  type GithubPullRequestDetail,
  type GithubPullRequestFiles,
  type GithubPullRequestInlineCommentCreate,
  type GithubPullRequestLifecycleAction,
  type GithubPullRequestLifecycleApply,
  type GithubPullRequestLifecyclePreview,
  type GithubPullRequestList,
  type GithubPullRequestOverview,
  type GithubPullRequestReview,
  type GithubPullRequestReviewAction,
  type GithubPullRequestReviewComment,
  type GithubPullRequestReviewSubmit,
  type GithubPullRequestReviewThread,
  type GithubPullRequestSummary,
  type GithubActionsMutationResult,
  type GithubActionsOverview,
  type GithubActionsRun,
  type GithubActionsRunAction,
  type GithubActionsRunCheckoutPrepared,
  type GithubActionsRunDetail,
  type GithubActionsRunLogs,
  type GithubActionsWorkflowDispatch,
  type GithubReleaseCreate,
  type GithubReleaseList,
  type GithubReleaseSummary,
  type GithubRepositoryCreate,
  type GithubRepositoryOwner,
  type GithubWorkerRepository,
  type ProjectCloneResult,
  type ProjectGithubConversionRepository,
  type ProjectReplicaJobProgressEvent,
  type ProjectReplicaJobErrorCode,
  type ProjectReplicaLinkRepairResult,
  type ProjectReplicaPlacementRequest,
  type ProjectReplicaPlacementResult,
  type ProjectReplicaProvisionResult,
  type ProjectReplicaRemoveResult,
  type ProjectReplicaSynchronizationPolicy,
  type ProjectReplicaSynchronizeResult,
  type ProjectWorkspaceStorageContext,
  type WorktreePolicy,
} from "@cantrip/protocol";

import {
  ProjectReplicaPlacementError,
  ProjectReplicaPlacementManager,
} from "./project-replica-placement.js";
import {
  deriveManagedRepositoryTarget,
  ensureManagedWorkspaceDirectory,
} from "./project-workspace-storage.js";
import { loadGithubInbox } from "./github-inbox.js";
import {
  canonicalProjectSourcePath,
  normalizeProjectSourcePath,
} from "./project-source-path.js";

const execFileAsync = promisify(execFile);
const SAFE_REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const MAX_PROJECT_POLICY_BYTES = 64 * 1024;
const CLONE_INACTIVITY_TIMEOUT_MS = 5 * 60_000;
const CLONE_MAX_DURATION_MS = 2 * 60 * 60_000;
const CLONE_PROGRESS_HEARTBEAT_MS = 10_000;
const CLONE_OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024;

async function resolveGitCommit(
  cwd: string,
  revision: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "rev-parse", "--verify", `${revision}^{commit}`],
      { maxBuffer: 1024 * 1024 },
    );
    return stdout.trim().toLowerCase();
  } catch {
    return null;
  }
}

async function attachUnbornHeadToOrigin(cwd: string): Promise<string | null> {
  let remoteHead: string;
  try {
    await execFileAsync(
      "git",
      ["-C", cwd, "remote", "set-head", "origin", "--auto"],
      { maxBuffer: 1024 * 1024 },
    );
    remoteHead = (
      await execFileAsync(
        "git",
        [
          "-C",
          cwd,
          "symbolic-ref",
          "--quiet",
          "--short",
          "refs/remotes/origin/HEAD",
        ],
        { maxBuffer: 1024 * 1024 },
      )
    ).stdout.trim();
  } catch {
    return null;
  }
  if (
    !remoteHead.startsWith("origin/") ||
    remoteHead.length <= "origin/".length
  ) {
    return null;
  }
  const revision = await resolveGitCommit(cwd, remoteHead);
  if (!revision) return null;
  const branch = remoteHead.slice("origin/".length);
  await execFileAsync(
    "git",
    ["-C", cwd, "checkout", "-B", branch, remoteHead],
    {
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  await execFileAsync(
    "git",
    ["-C", cwd, "branch", "--set-upstream-to", remoteHead, branch],
    { maxBuffer: 1024 * 1024 },
  );
  return revision;
}

export function parseGithubCloneProgress(
  output: string,
): Pick<ProjectReplicaJobProgressEvent, "percent"> | null {
  const matches = [
    {
      expression: /Receiving objects:\s+(\d+)%/giu,
      offset: 30,
      range: 42,
    },
    {
      expression: /Resolving deltas:\s+(\d+)%/giu,
      offset: 72,
      range: 12,
    },
    {
      expression: /Updating files:\s+(\d+)%/giu,
      offset: 84,
      range: 4,
    },
  ] as const;
  let latest:
    | (Pick<ProjectReplicaJobProgressEvent, "percent"> & {
        index: number;
      })
    | null = null;
  for (const candidate of matches) {
    for (const match of output.matchAll(candidate.expression)) {
      const gitPercent = Math.min(100, Math.max(0, Number(match[1])));
      const index = match.index ?? 0;
      if (!latest || index >= latest.index) {
        latest = {
          index,
          percent:
            candidate.offset + Math.floor((gitPercent * candidate.range) / 100),
        };
      }
    }
  }
  return latest ? { percent: latest.percent } : null;
}

export function summarizeGithubCloneFailure(output: string): string {
  const lines = output
    .split(/[\r\n]+/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const diagnostics = lines.filter((line) => /\b(?:error|fatal):/iu.test(line));
  return (diagnostics.length > 0 ? diagnostics.slice(-8) : lines.slice(-20))
    .join("\n")
    .slice(-4_000);
}

export function isWindowsLongPathGitFailure(
  output: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    platform === "win32" &&
    /\b(?:filename|file name|path)(?: or extension)?(?: is)? too long\b/iu.test(
      output,
    )
  );
}

export function githubCloneFailureDetails(
  detail: string,
  platform: NodeJS.Platform = process.platform,
): {
  code: "remote-unavailable" | "windows-long-paths-disabled";
  message: string;
} {
  return isWindowsLongPathGitFailure(detail, platform)
    ? {
        code: "windows-long-paths-disabled",
        message:
          "Git for Windows rejected Cantrip's managed repository path because long-path support is disabled. Enable Git long paths on this worker, then retry setup.",
      }
    : {
        code: "remote-unavailable",
        message: `Could not clone the repository: ${detail}`,
      };
}

async function cloneGithubRepository(
  nameWithOwner: string,
  target: string,
  reportProgress: (progress: ProjectReplicaJobProgressEvent) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "gh",
      ["repo", "clone", nameWithOwner, target, "--", "--progress"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let outputBytes = 0;
    let settled = false;
    let lastActivityAt = Date.now();
    let terminationError: Error | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let maxDuration: ReturnType<typeof setTimeout> | null = null;
    let forceKill: ReturnType<typeof setTimeout> | null = null;
    let currentProgress: ProjectReplicaJobProgressEvent = {
      stage: "materializing",
      percent: 30,
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (heartbeat) clearInterval(heartbeat);
      if (watchdog) clearInterval(watchdog);
      if (maxDuration) clearTimeout(maxDuration);
      if (forceKill) clearTimeout(forceKill);
      if (error) reject(error);
      else resolve();
    };
    const terminate = (message: string) => {
      if (terminationError) return;
      terminationError = new Error(message);
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
      forceKill.unref();
    };
    const capture = (chunk: Buffer) => {
      lastActivityAt = Date.now();
      outputBytes += chunk.length;
      if (outputBytes > CLONE_OUTPUT_LIMIT_BYTES) {
        terminate("Repository clone output exceeded the 32 MiB safety limit.");
        return;
      }
      output = `${output}${chunk.toString("utf8")}`.slice(-16_384);
      const parsed = parseGithubCloneProgress(output);
      if (parsed && parsed.percent >= currentProgress.percent) {
        currentProgress = { stage: "materializing", ...parsed };
        reportProgress(currentProgress);
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) => finish(terminationError ?? error));
    child.once("close", (code, signal) => {
      if (settled) return;
      if (terminationError) {
        finish(terminationError);
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      const detail = summarizeGithubCloneFailure(output);
      finish(
        new Error(
          detail ||
            `GitHub clone exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}.`,
        ),
      );
    });
    heartbeat = setInterval(() => {
      reportProgress(currentProgress);
    }, CLONE_PROGRESS_HEARTBEAT_MS);
    heartbeat.unref();
    watchdog = setInterval(() => {
      if (Date.now() - lastActivityAt >= CLONE_INACTIVITY_TIMEOUT_MS) {
        terminate(
          "Repository clone stopped after five minutes without network or Git progress.",
        );
      }
    }, CLONE_PROGRESS_HEARTBEAT_MS);
    watchdog.unref();
    maxDuration = setTimeout(() => {
      terminate("Repository clone exceeded the two-hour safety limit.");
    }, CLONE_MAX_DURATION_MS);
    maxDuration.unref();
  });
}

export async function readProjectWorktreePolicy(
  repositoryPath: string,
): Promise<{
  policy: WorktreePolicy | null;
  warning: string | null;
}> {
  const policyPath = path.join(repositoryPath, ".cantrip", "project.json");
  try {
    const metadata = await lstat(policyPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return {
        policy: null,
        warning:
          "Ignored .cantrip/project.json because it is not a regular file.",
      };
    }
    if (metadata.size > MAX_PROJECT_POLICY_BYTES) {
      return {
        policy: null,
        warning: "Ignored .cantrip/project.json because it exceeds 64 KiB.",
      };
    }
    const document = JSON.parse(await readFile(policyPath, "utf8")) as unknown;
    if (
      !document ||
      typeof document !== "object" ||
      !("worktreePolicy" in document)
    ) {
      return {
        policy: null,
        warning:
          "Ignored .cantrip/project.json because worktreePolicy is missing.",
      };
    }
    const policy = worktreePolicySchema.safeParse(
      (document as { worktreePolicy?: unknown }).worktreePolicy,
    );
    return policy.success
      ? { policy: policy.data, warning: null }
      : {
          policy: null,
          warning:
            "Ignored .cantrip/project.json because worktreePolicy is invalid.",
        };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { policy: null, warning: null };
    }
    return {
      policy: null,
      warning: `Ignored .cantrip/project.json: ${(error as Error).message}`,
    };
  }
}

interface GithubApiRepository {
  default_branch?: unknown;
  description?: unknown;
  fork?: unknown;
  full_name?: unknown;
  html_url?: unknown;
  id?: unknown;
  name?: unknown;
  private?: unknown;
  updated_at?: unknown;
}

interface GithubApiOrganization {
  login?: unknown;
}

interface GithubApiIssue {
  assignees?: unknown;
  body?: unknown;
  closed_at?: unknown;
  comments?: unknown;
  created_at?: unknown;
  html_url?: unknown;
  labels?: unknown;
  milestone?: unknown;
  number?: unknown;
  pull_request?: unknown;
  state?: unknown;
  title?: unknown;
  updated_at?: unknown;
  user?: unknown;
}

interface GithubApiIssueComment {
  body?: unknown;
  created_at?: unknown;
  html_url?: unknown;
  id?: unknown;
  updated_at?: unknown;
  user?: unknown;
}

interface GithubApiPullRequest extends GithubApiIssue {
  additions?: unknown;
  base?: unknown;
  changed_files?: unknown;
  commits?: unknown;
  deletions?: unknown;
  draft?: unknown;
  head?: unknown;
  mergeable?: unknown;
  mergeable_state?: unknown;
  merged?: unknown;
  merged_at?: unknown;
  node_id?: unknown;
  requested_reviewers?: unknown;
}

interface GithubGraphqlConnection<T> {
  nodes?: T[] | null;
  totalCount?: number;
}

interface GithubGraphqlIssueNode {
  __typename?: unknown;
  assignees?: GithubGraphqlConnection<{ login?: unknown }>;
  author?: { login?: unknown } | null;
  baseRefName?: unknown;
  baseRefOid?: unknown;
  body?: unknown;
  closedAt?: unknown;
  comments?: { totalCount?: unknown };
  commits?: GithubGraphqlConnection<{
    commit?: { statusCheckRollup?: { state?: unknown } | null };
  }>;
  createdAt?: unknown;
  headRefName?: unknown;
  headRefOid?: unknown;
  isDraft?: unknown;
  labels?: GithubGraphqlConnection<{ color?: unknown; name?: unknown }>;
  mergeable?: unknown;
  merged?: unknown;
  milestone?: { title?: unknown } | null;
  number?: unknown;
  reviewDecision?: unknown;
  state?: unknown;
  title?: unknown;
  updatedAt?: unknown;
  url?: unknown;
}

interface GithubGraphqlSearchResponse {
  data?: {
    search?: {
      issueCount?: unknown;
      nodes?: GithubGraphqlIssueNode[] | null;
      pageInfo?: {
        endCursor?: unknown;
        hasNextPage?: unknown;
      };
    };
  };
}

interface GithubGraphqlPullRequestReviewCommentNode {
  author?: { login?: unknown } | null;
  body?: unknown;
  createdAt?: unknown;
  databaseId?: unknown;
  diffHunk?: unknown;
  line?: unknown;
  path?: unknown;
  pullRequestReview?: {
    databaseId?: unknown;
    id?: unknown;
    state?: unknown;
  } | null;
  replyTo?: { databaseId?: unknown } | null;
  startLine?: unknown;
  updatedAt?: unknown;
  url?: unknown;
}

interface GithubGraphqlPullRequestReviewThreadNode {
  comments?: GithubGraphqlConnection<GithubGraphqlPullRequestReviewCommentNode>;
  diffSide?: unknown;
  id?: unknown;
  isOutdated?: unknown;
  isResolved?: unknown;
  line?: unknown;
  path?: unknown;
  startDiffSide?: unknown;
  startLine?: unknown;
  viewerCanResolve?: unknown;
  viewerCanUnresolve?: unknown;
}

interface GithubGraphqlPullRequestReviewContextResponse {
  data?: {
    repository?: {
      pullRequest?: {
        autoMergeRequest?: {
          enabledAt?: unknown;
          mergeMethod?: unknown;
        } | null;
        id?: unknown;
        isMergeQueueEnabled?: unknown;
        mergeQueueEntry?: {
          id?: unknown;
          position?: unknown;
          state?: unknown;
        } | null;
        reviews?: GithubGraphqlConnection<{
          author?: { login?: unknown } | null;
          comments?: { totalCount?: unknown };
          id?: unknown;
          state?: unknown;
        }>;
        reviewThreads?: GithubGraphqlConnection<GithubGraphqlPullRequestReviewThreadNode>;
      } | null;
    } | null;
    viewer?: { login?: unknown } | null;
  };
}

interface GithubGraphqlPullRequestFileStateResponse {
  data?: {
    repository?: {
      pullRequest?: {
        files?: GithubGraphqlConnection<{
          path?: unknown;
          viewerViewedState?: unknown;
        }>;
      } | null;
    } | null;
  };
}

const GITHUB_LIST_SEARCH_QUERY = `
  query CantripGithubList($search: String!, $first: Int!, $after: String) {
    search(type: ISSUE, query: $search, first: $first, after: $after) {
      issueCount
      pageInfo { endCursor hasNextPage }
      nodes {
        __typename
        ... on Issue {
          number title state url createdAt updatedAt closedAt
          author { login }
          comments { totalCount }
          labels(first: 20) { nodes { name color } }
          assignees(first: 20) { nodes { login } }
          milestone { title }
        }
        ... on PullRequest {
          number title body state url createdAt updatedAt closedAt
          author { login }
          comments { totalCount }
          labels(first: 20) { nodes { name color } }
          assignees(first: 20) { nodes { login } }
          milestone { title }
          isDraft merged mergeable reviewDecision
          headRefName headRefOid baseRefName baseRefOid
          commits(last: 1) {
            nodes { commit { statusCheckRollup { state } } }
          }
        }
      }
    }
  }
`;

const GITHUB_PULL_REQUEST_REVIEW_CONTEXT_QUERY = `
  query CantripPullRequestReviewContext(
    $owner: String!
    $repository: String!
    $number: Int!
  ) {
    viewer { login }
    repository(owner: $owner, name: $repository) {
      pullRequest(number: $number) {
        id
        isMergeQueueEnabled
        autoMergeRequest { enabledAt mergeMethod }
        mergeQueueEntry { id position state }
        reviews(last: 20, states: [PENDING]) {
          nodes { id state author { login } comments { totalCount } }
        }
        reviewThreads(first: 100) {
          totalCount
          nodes {
            id path line startLine diffSide startDiffSide
            isResolved isOutdated viewerCanResolve viewerCanUnresolve
            comments(first: 100) {
              totalCount
              nodes {
                databaseId author { login } body url path line startLine
                diffHunk createdAt updatedAt replyTo { databaseId }
                pullRequestReview { databaseId id state }
              }
            }
          }
        }
      }
    }
  }
`;

const GITHUB_PULL_REQUEST_FILE_STATES_QUERY = `
  query CantripPullRequestFileStates(
    $owner: String!
    $repository: String!
    $number: Int!
  ) {
    repository(owner: $owner, name: $repository) {
      pullRequest(number: $number) {
        files(first: 100) { nodes { path viewerViewedState } }
      }
    }
  }
`;

const GITHUB_CREATE_PENDING_REVIEW_MUTATION = `
  mutation CantripCreatePendingReview($pullRequestId: ID!, $head: GitObjectID!) {
    addPullRequestReview(input: {
      pullRequestId: $pullRequestId
      commitOID: $head
    }) { pullRequestReview { id } }
  }
`;

const GITHUB_ADD_PENDING_REVIEW_THREAD_MUTATION = `
  mutation CantripAddPendingReviewThread(
    $reviewId: ID!
    $body: String!
    $path: String!
    $line: Int!
    $side: DiffSide!
    $startLine: Int
    $startSide: DiffSide
  ) {
    addPullRequestReviewThread(input: {
      pullRequestReviewId: $reviewId
      body: $body
      path: $path
      line: $line
      side: $side
      startLine: $startLine
      startSide: $startSide
    }) { thread { id } }
  }
`;

const GITHUB_SUBMIT_PENDING_REVIEW_MUTATION = `
  mutation CantripSubmitPendingReview(
    $reviewId: ID!
    $event: PullRequestReviewEvent!
    $body: String
  ) {
    submitPullRequestReview(input: {
      pullRequestReviewId: $reviewId
      event: $event
      body: $body
    }) { pullRequestReview { id state } }
  }
`;

const GITHUB_DELETE_PENDING_REVIEW_MUTATION = `
  mutation CantripDeletePendingReview($reviewId: ID!) {
    deletePullRequestReview(input: { pullRequestReviewId: $reviewId }) {
      pullRequestReview { id }
    }
  }
`;

const GITHUB_SET_REVIEW_THREAD_RESOLVED_MUTATION = `
  mutation CantripSetReviewThreadResolved($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }
`;

const GITHUB_SET_REVIEW_THREAD_UNRESOLVED_MUTATION = `
  mutation CantripSetReviewThreadUnresolved($threadId: ID!) {
    unresolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }
`;

const GITHUB_MARK_FILE_VIEWED_MUTATION = `
  mutation CantripMarkFileViewed($pullRequestId: ID!, $path: String!) {
    markFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) {
      pullRequest { id }
    }
  }
`;

const GITHUB_UNMARK_FILE_VIEWED_MUTATION = `
  mutation CantripUnmarkFileViewed($pullRequestId: ID!, $path: String!) {
    unmarkFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) {
      pullRequest { id }
    }
  }
`;

const GITHUB_CONVERT_PULL_REQUEST_TO_DRAFT_MUTATION = `
  mutation CantripConvertPullRequestToDraft($pullRequestId: ID!) {
    convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) {
      pullRequest { id isDraft }
    }
  }
`;

const GITHUB_ENABLE_AUTO_MERGE_MUTATION = `
  mutation CantripEnableAutoMerge(
    $pullRequestId: ID!
    $head: GitObjectID!
    $method: PullRequestMergeMethod!
    $title: String
    $body: String
  ) {
    enablePullRequestAutoMerge(input: {
      pullRequestId: $pullRequestId
      expectedHeadOid: $head
      mergeMethod: $method
      commitHeadline: $title
      commitBody: $body
    }) { pullRequest { id } }
  }
`;

const GITHUB_DISABLE_AUTO_MERGE_MUTATION = `
  mutation CantripDisableAutoMerge($pullRequestId: ID!) {
    disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
      pullRequest { id }
    }
  }
`;

const GITHUB_ENQUEUE_PULL_REQUEST_MUTATION = `
  mutation CantripEnqueuePullRequest($pullRequestId: ID!, $head: GitObjectID!) {
    enqueuePullRequest(input: {
      pullRequestId: $pullRequestId
      expectedHeadOid: $head
    }) { mergeQueueEntry { id } }
  }
`;

const GITHUB_DEQUEUE_PULL_REQUEST_MUTATION = `
  mutation CantripDequeuePullRequest($pullRequestId: ID!) {
    dequeuePullRequest(input: { pullRequestId: $pullRequestId }) {
      mergeQueueEntry { id }
    }
  }
`;

interface GithubApiPullRequestCommit {
  author?: unknown;
  commit?: unknown;
  html_url?: unknown;
  sha?: unknown;
}

interface GithubApiPullRequestFile {
  additions?: unknown;
  blob_url?: unknown;
  changes?: unknown;
  deletions?: unknown;
  filename?: unknown;
  patch?: unknown;
  previous_filename?: unknown;
  raw_url?: unknown;
  sha?: unknown;
  status?: unknown;
}

interface GithubApiCheckRun {
  completed_at?: unknown;
  conclusion?: unknown;
  details_url?: unknown;
  html_url?: unknown;
  id?: unknown;
  name?: unknown;
  output?: unknown;
  started_at?: unknown;
  status?: unknown;
}

interface GithubApiCheckRuns {
  check_runs?: unknown;
  total_count?: unknown;
}

interface GithubApiCommitStatus {
  context?: unknown;
  created_at?: unknown;
  description?: unknown;
  id?: unknown;
  state?: unknown;
  target_url?: unknown;
  updated_at?: unknown;
}

interface GithubApiCombinedStatus {
  statuses?: unknown;
}

interface GithubApiPullRequestReview {
  body?: unknown;
  commit_id?: unknown;
  html_url?: unknown;
  id?: unknown;
  state?: unknown;
  submitted_at?: unknown;
  user?: unknown;
}

interface GithubApiPullRequestReviewComment {
  body?: unknown;
  created_at?: unknown;
  diff_hunk?: unknown;
  html_url?: unknown;
  id?: unknown;
  in_reply_to_id?: unknown;
  line?: unknown;
  path?: unknown;
  pull_request_review_id?: unknown;
  side?: unknown;
  start_line?: unknown;
  start_side?: unknown;
  updated_at?: unknown;
  user?: unknown;
}

interface GithubApiGitRef {
  object?: unknown;
}

interface GithubApiRelease {
  author?: unknown;
  body?: unknown;
  created_at?: unknown;
  draft?: unknown;
  html_url?: unknown;
  id?: unknown;
  name?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  tag_name?: unknown;
}

interface GithubApiActionsWorkflow {
  badge_url?: unknown;
  html_url?: unknown;
  id?: unknown;
  name?: unknown;
  path?: unknown;
  state?: unknown;
}

interface GithubApiActionsWorkflowList {
  total_count?: unknown;
  workflows?: unknown;
}

interface GithubApiActionsRun {
  actor?: unknown;
  conclusion?: unknown;
  created_at?: unknown;
  display_title?: unknown;
  event?: unknown;
  head_branch?: unknown;
  head_sha?: unknown;
  html_url?: unknown;
  id?: unknown;
  name?: unknown;
  pull_requests?: unknown;
  run_attempt?: unknown;
  run_number?: unknown;
  status?: unknown;
  updated_at?: unknown;
  workflow_id?: unknown;
}

interface GithubApiActionsRunList {
  total_count?: unknown;
  workflow_runs?: unknown;
}

interface GithubApiActionsStep {
  completed_at?: unknown;
  conclusion?: unknown;
  name?: unknown;
  number?: unknown;
  started_at?: unknown;
  status?: unknown;
}

interface GithubApiActionsJob {
  completed_at?: unknown;
  conclusion?: unknown;
  html_url?: unknown;
  id?: unknown;
  name?: unknown;
  runner_group_name?: unknown;
  runner_name?: unknown;
  started_at?: unknown;
  status?: unknown;
  steps?: unknown;
}

interface GithubApiActionsJobList {
  jobs?: unknown;
  total_count?: unknown;
}

interface GithubApiActionsArtifact {
  created_at?: unknown;
  expired?: unknown;
  expires_at?: unknown;
  id?: unknown;
  name?: unknown;
  size_in_bytes?: unknown;
}

interface GithubApiActionsArtifactList {
  artifacts?: unknown;
  total_count?: unknown;
}

interface GithubApiActionsRunner {
  busy?: unknown;
  id?: unknown;
  labels?: unknown;
  name?: unknown;
  os?: unknown;
  status?: unknown;
}

interface GithubApiActionsRunnerList {
  runners?: unknown;
  total_count?: unknown;
}

interface RepositoryCache {
  login: string;
  repositories: GithubWorkerRepository[];
  updatedAt: string;
}

function repositorySegments(nameWithOwner: string): [string, string] {
  const parts = nameWithOwner.split("/");
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    parts.some(
      (part) =>
        !SAFE_REPOSITORY_SEGMENT.test(part) || part === "." || part === "..",
    )
  ) {
    throw new Error(`Invalid GitHub repository name: ${nameWithOwner}`);
  }
  return [parts[0], parts[1]];
}

export function githubRepositoryFromRemoteUrl(value: string): string | null {
  const trimmed = value.trim();
  const scp = /^git@github\.com:([^/]+)\/(.+)$/iu.exec(trimmed);
  if (scp) {
    return `${scp[1]}/${scp[2]!.replace(/\.git$/iu, "")}`.toLowerCase();
  }
  try {
    const remote = new URL(trimmed);
    if (remote.hostname.toLowerCase() !== "github.com") return null;
    const segments = remote.pathname
      .replace(/^\/+|\/+$/gu, "")
      .replace(/\.git$/iu, "")
      .split("/");
    return segments.length === 2
      ? `${segments[0]}/${segments[1]}`.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function pathsEqual(left: string, right: string): boolean {
  const comparable = (value: string) => {
    const normalized = path.normalize(value);
    if (process.platform !== "win32") return normalized;
    const withoutNamespace = normalized.startsWith("\\\\?\\UNC\\")
      ? `\\\\${normalized.slice(8)}`
      : normalized.startsWith("\\\\?\\")
        ? normalized.slice(4)
        : normalized;
    return withoutNamespace.toLowerCase();
  };
  return comparable(left) === comparable(right);
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function pullRequestCheckoutIdentity(pullRequest: GithubPullRequestSummary): {
  branch: string;
  name: string;
} {
  const slug = pullRequest.headRef
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return {
    branch: `cantrip/pr/${pullRequest.number}-${slug || "head"}-${pullRequest.headSha.slice(0, 8)}`,
    name: `PR #${pullRequest.number} ${pullRequest.title}`.slice(0, 200),
  };
}

function parseRepository(value: GithubApiRepository): GithubWorkerRepository {
  return {
    id: String(value.id),
    name: String(value.name),
    nameWithOwner: String(value.full_name),
    description:
      typeof value.description === "string" ? value.description : null,
    isPrivate: value.private === true,
    isFork: value.fork === true,
    url: String(value.html_url),
    defaultBranch: String(value.default_branch),
    updatedAt: String(value.updated_at),
  };
}

function githubLogin(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "login" in value &&
    typeof value.login === "string"
  ) {
    return value.login;
  }
  return "ghost";
}

function parseIssue(value: GithubApiIssue): GithubIssueSummary {
  const labels = Array.isArray(value.labels)
    ? value.labels.flatMap((label) => {
        if (!label || typeof label !== "object") return [];
        const name = "name" in label ? label.name : null;
        const color = "color" in label ? label.color : null;
        return typeof name === "string" && typeof color === "string"
          ? [{ name, color }]
          : [];
      })
    : [];
  return {
    number: Number(value.number),
    title: String(value.title),
    state: value.state === "closed" ? "closed" : "open",
    url: String(value.html_url),
    author: githubLogin(value.user),
    commentCount: Number(value.comments) || 0,
    labels,
    assignees: Array.isArray(value.assignees)
      ? value.assignees.map(githubLogin)
      : [],
    milestone:
      value.milestone &&
      typeof value.milestone === "object" &&
      "title" in value.milestone &&
      typeof value.milestone.title === "string"
        ? value.milestone.title
        : null,
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
    closedAt: typeof value.closed_at === "string" ? value.closed_at : null,
  };
}

function parseIssueComment(value: GithubApiIssueComment) {
  return {
    id: String(value.id),
    author: githubLogin(value.user),
    body: typeof value.body === "string" ? value.body : "",
    url: String(value.html_url),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  };
}

function pullRequestBranch(value: unknown): { ref: string; sha: string } {
  if (!value || typeof value !== "object") return { ref: "unknown", sha: "" };
  const branch = value as { ref?: unknown; sha?: unknown };
  return {
    ref: typeof branch.ref === "string" ? branch.ref : "unknown",
    sha: typeof branch.sha === "string" ? branch.sha : "",
  };
}

function parsePullRequest(
  value: GithubApiPullRequest,
): GithubPullRequestSummary {
  const head = pullRequestBranch(value.head);
  const base = pullRequestBranch(value.base);
  return githubPullRequestSummarySchema.parse({
    ...parseIssue(value),
    body: typeof value.body === "string" ? value.body : null,
    draft: value.draft === true,
    merged: value.merged === true || typeof value.merged_at === "string",
    headRef: head.ref,
    headSha: head.sha,
    baseRef: base.ref,
    baseSha: base.sha,
    mergeable: typeof value.mergeable === "boolean" ? value.mergeable : null,
    reviewDecision: "none",
    checksState: "unknown",
  });
}

function graphqlConnectionNodes<T>(
  connection: GithubGraphqlConnection<T> | null | undefined,
): T[] {
  return Array.isArray(connection?.nodes) ? connection.nodes : [];
}

function graphqlLogin(value: unknown): string {
  return value &&
    typeof value === "object" &&
    "login" in value &&
    typeof value.login === "string"
    ? value.login
    : "ghost";
}

function parseGraphqlLabels(value: GithubGraphqlIssueNode) {
  return graphqlConnectionNodes(value.labels).flatMap((label) =>
    typeof label.name === "string" && typeof label.color === "string"
      ? [{ name: label.name, color: label.color }]
      : [],
  );
}

function parseGraphqlIssue(value: GithubGraphqlIssueNode): GithubIssueSummary {
  return {
    number: Number(value.number),
    title: String(value.title),
    state: value.state === "OPEN" ? "open" : "closed",
    url: String(value.url),
    author: graphqlLogin(value.author),
    commentCount: Number(value.comments?.totalCount) || 0,
    labels: parseGraphqlLabels(value),
    assignees: graphqlConnectionNodes(value.assignees).map(graphqlLogin),
    milestone:
      value.milestone && typeof value.milestone.title === "string"
        ? value.milestone.title
        : null,
    createdAt: String(value.createdAt),
    updatedAt: String(value.updatedAt),
    closedAt: typeof value.closedAt === "string" ? value.closedAt : null,
  };
}

function graphqlChecksState(
  value: GithubGraphqlIssueNode,
): GithubPullRequestSummary["checksState"] {
  const state = graphqlConnectionNodes(value.commits)[0]?.commit
    ?.statusCheckRollup?.state;
  switch (state) {
    case "SUCCESS":
      return "success";
    case "ERROR":
    case "FAILURE":
      return "failure";
    case "EXPECTED":
    case "PENDING":
      return "pending";
    case undefined:
    case null:
      return "none";
    default:
      return "unknown";
  }
}

function graphqlReviewDecision(
  value: unknown,
): GithubPullRequestSummary["reviewDecision"] {
  switch (value) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "REVIEW_REQUIRED":
      return "review-required";
    case null:
    case undefined:
      return "none";
    default:
      return "reviewed";
  }
}

function parseGraphqlPullRequest(
  value: GithubGraphqlIssueNode,
): GithubPullRequestSummary {
  return githubPullRequestSummarySchema.parse({
    ...parseGraphqlIssue(value),
    body: typeof value.body === "string" ? value.body : null,
    draft: value.isDraft === true,
    merged: value.merged === true,
    headRef: String(value.headRefName ?? "unknown"),
    headSha: String(value.headRefOid ?? ""),
    baseRef: String(value.baseRefName ?? "unknown"),
    baseSha: String(value.baseRefOid ?? ""),
    mergeable:
      value.mergeable === "MERGEABLE"
        ? true
        : value.mergeable === "CONFLICTING"
          ? false
          : null,
    reviewDecision: graphqlReviewDecision(value.reviewDecision),
    checksState: graphqlChecksState(value),
  });
}

function quoteGithubSearchValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function githubListSearchQuery(
  nameWithOwner: string,
  kind: "issue" | "pull-request",
  state: GithubIssueState,
  input: GithubIssueListFilters,
  now = new Date(),
): string {
  repositorySegments(nameWithOwner);
  const filters = githubIssueListFiltersSchema.parse(input);
  if (
    kind === "issue" &&
    (filters.view === "review-requested" ||
      filters.draft !== null ||
      filters.reviewDecision !== null ||
      filters.mergeability !== null ||
      filters.checksState !== null)
  ) {
    throw new Error("Pull request filters cannot be applied to issues.");
  }
  const terms = [
    `repo:${nameWithOwner}`,
    kind === "pull-request" ? "is:pr" : "is:issue",
    `is:${state}`,
  ];
  if (filters.search) terms.push(quoteGithubSearchValue(filters.search));
  for (const label of filters.labels) {
    terms.push(`label:${quoteGithubSearchValue(label)}`);
  }
  if (filters.author) terms.push(`author:${filters.author}`);
  if (filters.assignee) terms.push(`assignee:${filters.assignee}`);
  if (filters.milestone) {
    terms.push(`milestone:${quoteGithubSearchValue(filters.milestone)}`);
  }
  if (filters.view === "assigned-to-me") terms.push("assignee:@me");
  if (filters.view === "review-requested") {
    terms.push("review-requested:@me");
  }
  if (filters.view === "recently-updated") {
    const threshold = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000)
      .toISOString()
      .slice(0, 10);
    terms.push(`updated:>=${threshold}`);
  }
  if (kind === "pull-request") {
    if (filters.draft === true) terms.push("is:draft");
    if (filters.draft === false) terms.push("-is:draft");
    if (filters.reviewDecision) {
      const decision = {
        approved: "approved",
        "changes-requested": "changes_requested",
        "review-required": "required",
        none: "none",
      }[filters.reviewDecision];
      terms.push(`review:${decision}`);
    }
    if (filters.checksState) terms.push(`status:${filters.checksState}`);
  }
  terms.push("sort:updated-desc");
  return terms.join(" ");
}

function matchesMergeability(
  pullRequest: GithubPullRequestSummary,
  filter: GithubIssueListFilters["mergeability"],
): boolean {
  if (filter === null) return true;
  if (filter === "mergeable") return pullRequest.mergeable === true;
  if (filter === "conflicting") return pullRequest.mergeable === false;
  return pullRequest.mergeable === null;
}

function boundedText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function nullableUrl(value: unknown): string | null {
  return typeof value === "string" && /^https?:\/\//u.test(value)
    ? value
    : null;
}

function nullableDate(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parsePullRequestCommit(value: GithubApiPullRequestCommit) {
  const sha = String(value.sha);
  const commit =
    value.commit && typeof value.commit === "object"
      ? (value.commit as { author?: unknown; message?: unknown })
      : {};
  const author =
    commit.author && typeof commit.author === "object"
      ? (commit.author as { date?: unknown; name?: unknown })
      : {};
  return {
    sha,
    shortSha: sha.slice(0, 7),
    message: boundedText(commit.message, 1_000_000),
    author:
      typeof author.name === "string" && author.name
        ? author.name
        : githubLogin(value.author),
    authoredAt: nullableDate(author.date),
    url: String(value.html_url),
  };
}

function parsePullRequestFile(value: GithubApiPullRequestFile) {
  const rawPatch = typeof value.patch === "string" ? value.patch : null;
  return {
    sha: String(value.sha),
    path: String(value.filename),
    previousPath:
      typeof value.previous_filename === "string"
        ? value.previous_filename
        : null,
    status: String(value.status),
    additions: Number(value.additions) || 0,
    deletions: Number(value.deletions) || 0,
    changes: Number(value.changes) || 0,
    blobUrl: String(value.blob_url),
    rawUrl: nullableUrl(value.raw_url),
    patch: rawPatch?.slice(0, 1_000_000) ?? null,
    patchTruncated: rawPatch !== null && rawPatch.length > 1_000_000,
    viewed: null,
  };
}

function parseCheckRun(value: GithubApiCheckRun): GithubPullRequestCheck {
  const output =
    value.output && typeof value.output === "object"
      ? (value.output as { summary?: unknown; text?: unknown; title?: unknown })
      : {};
  const rawStatus = String(value.status).toLowerCase();
  const status =
    rawStatus === "completed"
      ? "completed"
      : rawStatus === "in_progress"
        ? "in-progress"
        : "queued";
  const summary = [output.title, output.summary, output.text]
    .filter((part): part is string => typeof part === "string" && Boolean(part))
    .join("\n\n")
    .slice(0, 100_000);
  return {
    id: String(value.id),
    name: String(value.name),
    source: "check-run",
    status,
    conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
    url: nullableUrl(value.details_url) ?? nullableUrl(value.html_url),
    startedAt: nullableDate(value.started_at),
    completedAt: nullableDate(value.completed_at),
    summary: summary || null,
  };
}

function parseCommitStatus(
  value: GithubApiCommitStatus,
): GithubPullRequestCheck {
  const state = String(value.state).toLowerCase();
  return {
    id: `status-${String(value.id)}`,
    name: String(value.context),
    source: "commit-status",
    status: state === "pending" ? "in-progress" : "completed",
    conclusion: state === "pending" ? null : state,
    url: nullableUrl(value.target_url),
    startedAt: nullableDate(value.created_at),
    completedAt: state === "pending" ? null : nullableDate(value.updated_at),
    summary:
      typeof value.description === "string"
        ? value.description.slice(0, 100_000)
        : null,
  };
}

function reviewState(state: unknown): GithubPullRequestReview["state"] {
  switch (String(state).toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "DISMISSED":
      return "dismissed";
    case "PENDING":
      return "pending";
    default:
      return "commented";
  }
}

function parsePullRequestReview(
  value: GithubApiPullRequestReview,
): GithubPullRequestReview {
  const commitSha =
    typeof value.commit_id === "string" &&
    /^[0-9a-f]{40}$/u.test(value.commit_id)
      ? value.commit_id
      : null;
  return {
    id: String(value.id),
    author: githubLogin(value.user),
    state: reviewState(value.state),
    body: boundedText(value.body, 1_000_000),
    commitSha,
    submittedAt: nullableDate(value.submitted_at),
    url: nullableUrl(value.html_url),
  };
}

function nullablePositiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function reviewSide(value: unknown): "LEFT" | "RIGHT" | null {
  return value === "LEFT" || value === "RIGHT" ? value : null;
}

function parsePullRequestReviewComment(
  value: GithubApiPullRequestReviewComment,
): GithubPullRequestReviewComment {
  return {
    id: Number(value.id),
    reviewId: nullablePositiveInteger(value.pull_request_review_id),
    author: githubLogin(value.user),
    body: boundedText(value.body, 1_000_000),
    url: String(value.html_url),
    path: String(value.path),
    line: nullablePositiveInteger(value.line),
    side: reviewSide(value.side),
    startLine: nullablePositiveInteger(value.start_line),
    startSide: reviewSide(value.start_side),
    diffHunk: boundedText(value.diff_hunk, 100_000),
    inReplyToId: nullablePositiveInteger(value.in_reply_to_id),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
    pending: false,
  };
}

interface PullRequestReviewContext {
  autoMerge: GithubPullRequestOverview["autoMerge"];
  mergeQueueEnabled: boolean;
  mergeQueueEntry: GithubPullRequestOverview["mergeQueueEntry"];
  nodeId: string;
  pendingReview: GithubPullRequestOverview["pendingReview"];
  reviewThreads: GithubPullRequestReviewThread[];
  reviewThreadsTruncated: boolean;
  viewerLogin: string;
}

function graphqlReviewComment(
  value: GithubGraphqlPullRequestReviewCommentNode,
  thread: GithubGraphqlPullRequestReviewThreadNode,
): GithubPullRequestReviewComment | null {
  const id = nullablePositiveInteger(value.databaseId);
  const path = typeof value.path === "string" ? value.path : thread.path;
  const url = typeof value.url === "string" ? value.url : null;
  const createdAt = nullableDate(value.createdAt);
  const updatedAt = nullableDate(value.updatedAt);
  if (
    id === null ||
    typeof path !== "string" ||
    !url ||
    !createdAt ||
    !updatedAt
  ) {
    return null;
  }
  return {
    id,
    reviewId: nullablePositiveInteger(value.pullRequestReview?.databaseId),
    author: githubLogin(value.author),
    body: boundedText(value.body, 1_000_000),
    url,
    path,
    line:
      nullablePositiveInteger(value.line) ??
      nullablePositiveInteger(thread.line),
    side: reviewSide(thread.diffSide),
    startLine:
      nullablePositiveInteger(value.startLine) ??
      nullablePositiveInteger(thread.startLine),
    startSide: reviewSide(thread.startDiffSide),
    diffHunk: boundedText(value.diffHunk, 100_000),
    inReplyToId: nullablePositiveInteger(value.replyTo?.databaseId),
    createdAt,
    updatedAt,
    pending: String(value.pullRequestReview?.state).toUpperCase() === "PENDING",
  };
}

export function parsePullRequestReviewContext(
  value: GithubGraphqlPullRequestReviewContextResponse,
): PullRequestReviewContext {
  const viewerLogin = value.data?.viewer?.login;
  const pullRequest = value.data?.repository?.pullRequest;
  if (
    typeof viewerLogin !== "string" ||
    !viewerLogin ||
    typeof pullRequest?.id !== "string" ||
    !pullRequest.id
  ) {
    throw new Error("GitHub returned an invalid pull request review context.");
  }
  const reviewNodes = Array.isArray(pullRequest.reviews?.nodes)
    ? pullRequest.reviews.nodes
    : [];
  const pending = reviewNodes.find(
    (review) =>
      String(review.state).toUpperCase() === "PENDING" &&
      review.author?.login === viewerLogin,
  );
  const threadNodes = Array.isArray(pullRequest.reviewThreads?.nodes)
    ? pullRequest.reviewThreads.nodes
    : [];
  let commentsTruncated = false;
  const reviewThreads = threadNodes.flatMap((thread) => {
    if (typeof thread.id !== "string" || typeof thread.path !== "string") {
      return [];
    }
    const commentNodes = Array.isArray(thread.comments?.nodes)
      ? thread.comments.nodes
      : [];
    const comments = commentNodes.flatMap((comment) => {
      const parsed = graphqlReviewComment(comment, thread);
      return parsed ? [parsed] : [];
    });
    if (Number(thread.comments?.totalCount) > comments.length) {
      commentsTruncated = true;
    }
    if (comments.length === 0) return [];
    return [
      {
        id: thread.id,
        path: thread.path,
        line: nullablePositiveInteger(thread.line),
        side: reviewSide(thread.diffSide),
        startLine: nullablePositiveInteger(thread.startLine),
        startSide: reviewSide(thread.startDiffSide),
        resolved:
          typeof thread.isResolved === "boolean" ? thread.isResolved : null,
        outdated: thread.isOutdated === true,
        viewerCanResolve: thread.viewerCanResolve === true,
        viewerCanUnresolve: thread.viewerCanUnresolve === true,
        comments: comments.slice(0, 100),
      },
    ];
  });
  const autoMerge = pullRequest.autoMergeRequest;
  const enabledAt = nullableDate(autoMerge?.enabledAt);
  const method = String(autoMerge?.mergeMethod).toLowerCase();
  const parsedAutoMerge =
    enabledAt && ["merge", "squash", "rebase"].includes(method)
      ? {
          enabledAt,
          method: method as "merge" | "squash" | "rebase",
        }
      : null;
  const queue = pullRequest.mergeQueueEntry;
  return {
    nodeId: pullRequest.id,
    viewerLogin,
    pendingReview:
      pending && typeof pending.id === "string"
        ? {
            id: pending.id,
            commentCount: Math.max(
              0,
              Number(pending.comments?.totalCount) || 0,
            ),
          }
        : null,
    autoMerge: parsedAutoMerge,
    mergeQueueEnabled: pullRequest.isMergeQueueEnabled === true,
    mergeQueueEntry:
      queue && typeof queue.id === "string" && typeof queue.state === "string"
        ? {
            id: queue.id,
            position:
              Number.isInteger(Number(queue.position)) &&
              Number(queue.position) >= 0
                ? Number(queue.position)
                : null,
            state: queue.state.toLowerCase(),
          }
        : null,
    reviewThreads: reviewThreads.slice(0, 100),
    reviewThreadsTruncated:
      commentsTruncated ||
      Number(pullRequest.reviewThreads?.totalCount) > reviewThreads.length,
  };
}

function parsePullRequestFileViewedStates(
  value: GithubGraphqlPullRequestFileStateResponse,
): Map<string, boolean> {
  const nodes = value.data?.repository?.pullRequest?.files?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error("GitHub returned invalid pull request file review state.");
  }
  return new Map(
    nodes.flatMap((node) =>
      typeof node.path === "string"
        ? [[node.path, node.viewerViewedState === "VIEWED"] as const]
        : [],
    ),
  );
}

export function groupPullRequestReviewThreads(
  comments: GithubPullRequestReviewComment[],
): GithubPullRequestReviewThread[] {
  const roots = new Map<number, GithubPullRequestReviewComment[]>();
  const rootFor = new Map<number, number>();
  for (const comment of comments) {
    if (comment.inReplyToId === null) {
      roots.set(comment.id, [comment]);
      rootFor.set(comment.id, comment.id);
    }
  }
  for (const comment of comments) {
    if (comment.inReplyToId === null) continue;
    const rootId = rootFor.get(comment.inReplyToId) ?? comment.inReplyToId;
    const thread = roots.get(rootId);
    if (thread) {
      thread.push(comment);
      rootFor.set(comment.id, rootId);
    } else {
      roots.set(comment.id, [comment]);
      rootFor.set(comment.id, comment.id);
    }
  }
  return [...roots.entries()].slice(0, 100).map(([id, threadComments]) => {
    const root = threadComments[0]!;
    return {
      id: String(id),
      path: root.path,
      line: root.line,
      side: root.side,
      startLine: root.startLine,
      startSide: root.startSide,
      resolved: null,
      outdated: false,
      viewerCanResolve: false,
      viewerCanUnresolve: false,
      comments: threadComments.slice(0, 100),
    };
  });
}

function deriveReviewDecision(
  reviews: GithubPullRequestReview[],
  requestedReviewers: string[],
): GithubPullRequestDetail["reviewDecision"] {
  const actionable = new Map<string, GithubPullRequestReview["state"]>();
  for (const review of reviews) {
    if (
      review.state === "approved" ||
      review.state === "changes-requested" ||
      review.state === "dismissed"
    ) {
      actionable.set(review.author, review.state);
    }
  }
  const states = [...actionable.values()];
  if (states.includes("changes-requested")) return "changes-requested";
  if (states.includes("approved")) return "approved";
  if (requestedReviewers.length > 0) return "review-required";
  if (reviews.length > 0) return "reviewed";
  return "none";
}

function deriveChecksState(
  checks: GithubPullRequestCheck[],
): GithubPullRequestDetail["checksState"] {
  if (checks.length === 0) return "none";
  if (
    checks.some((check) =>
      [
        "failure",
        "error",
        "timed_out",
        "cancelled",
        "action_required",
      ].includes(check.conclusion ?? ""),
    )
  ) {
    return "failure";
  }
  if (checks.some((check) => check.status !== "completed")) return "pending";
  if (checks.every((check) => check.conclusion === "success")) return "success";
  return "neutral";
}

function pullRequestDataWarning(
  section:
    | "conversation"
    | "reviews"
    | "review-threads"
    | "files"
    | "commits"
    | "checks",
  error: unknown,
) {
  const message =
    error instanceof Error && error.message
      ? error.message
      : "GitHub request failed.";
  return {
    section,
    message: message.slice(0, 1_000),
  };
}

const failedCheckConclusions = new Set([
  "failure",
  "error",
  "timed_out",
  "cancelled",
  "action_required",
]);

function failedPullRequestCheck(check: GithubPullRequestCheck): boolean {
  return failedCheckConclusions.has(check.conclusion ?? "");
}

export function githubActionsRunId(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return null;
    return parsed.pathname.match(/\/actions\/runs\/(\d+)/u)?.[1] ?? null;
  } catch {
    return null;
  }
}

function pullRequestLifecycleToken(
  detail: GithubPullRequestDetail,
  action: GithubPullRequestLifecycleAction,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        action,
        number: detail.number,
        state: detail.state,
        draft: detail.draft,
        merged: detail.merged,
        headSha: detail.headSha,
        baseSha: detail.baseSha,
        mergeable: detail.mergeable,
        mergeableState: detail.mergeableState,
        checksState: detail.checksState,
        reviewDecision: detail.reviewDecision,
        autoMerge: detail.autoMerge,
        mergeQueueEntry: detail.mergeQueueEntry,
      }),
    )
    .digest("hex");
}

function encodedRefPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function parseRelease(value: GithubApiRelease): GithubReleaseSummary {
  const tagName = String(value.tag_name);
  return githubReleaseSummarySchema.parse({
    id: Number(value.id),
    tagName,
    name:
      typeof value.name === "string" && value.name.trim()
        ? value.name
        : tagName,
    body: typeof value.body === "string" ? value.body : "",
    url: String(value.html_url),
    author: githubLogin(value.author),
    draft: value.draft === true,
    prerelease: value.prerelease === true,
    createdAt: String(value.created_at),
    publishedAt:
      typeof value.published_at === "string" ? value.published_at : null,
  });
}

function actionsStatus(value: unknown) {
  const status = String(value).toLowerCase().replaceAll("_", "-");
  return [
    "queued",
    "in-progress",
    "completed",
    "waiting",
    "requested",
    "pending",
  ].includes(status)
    ? status
    : "pending";
}

function parseActionsWorkflow(value: GithubApiActionsWorkflow) {
  return githubActionsWorkflowSchema.parse({
    id: Number(value.id),
    name: String(value.name || "Unnamed workflow"),
    path: String(value.path || ".github/workflows"),
    state: String(value.state || "unknown"),
    url: String(value.html_url),
    badgeUrl: nullableUrl(value.badge_url),
  });
}

function parseActionsRun(value: GithubApiActionsRun): GithubActionsRun {
  const pullRequestNumber = Array.isArray(value.pull_requests)
    ? (value.pull_requests.flatMap((pullRequest) => {
        if (!pullRequest || typeof pullRequest !== "object") return [];
        const number = Number((pullRequest as { number?: unknown }).number);
        return Number.isInteger(number) && number > 0 ? [number] : [];
      })[0] ?? null)
    : null;
  const name = String(value.name || "Workflow run");
  return githubActionsRunSchema.parse({
    id: Number(value.id),
    workflowId: Number(value.workflow_id),
    name,
    displayTitle: String(value.display_title || name),
    event: String(value.event || "unknown"),
    status: actionsStatus(value.status),
    conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
    headBranch:
      typeof value.head_branch === "string" && value.head_branch
        ? value.head_branch
        : null,
    headSha: String(value.head_sha).toLowerCase(),
    pullRequestNumber,
    runNumber: Number(value.run_number),
    runAttempt: Number(value.run_attempt) || 1,
    actor: githubLogin(value.actor),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
    url: String(value.html_url),
  });
}

function parseActionsJob(value: GithubApiActionsJob) {
  const rawSteps = Array.isArray(value.steps)
    ? (value.steps as GithubApiActionsStep[])
    : [];
  return githubActionsJobSchema.parse({
    id: Number(value.id),
    name: String(value.name || "Job"),
    status: actionsStatus(value.status),
    conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
    url: String(value.html_url),
    startedAt: nullableDate(value.started_at),
    completedAt: nullableDate(value.completed_at),
    runnerName:
      typeof value.runner_name === "string" && value.runner_name
        ? value.runner_name
        : null,
    runnerGroupName:
      typeof value.runner_group_name === "string" && value.runner_group_name
        ? value.runner_group_name
        : null,
    steps: rawSteps.slice(0, 100).map((step) => ({
      number: Number(step.number) || 0,
      name: String(step.name || "Step"),
      status: actionsStatus(step.status),
      conclusion: typeof step.conclusion === "string" ? step.conclusion : null,
      startedAt: nullableDate(step.started_at),
      completedAt: nullableDate(step.completed_at),
    })),
    stepsTruncated: rawSteps.length > 100,
  });
}

function parseActionsRunner(value: GithubApiActionsRunner) {
  const labels = Array.isArray(value.labels)
    ? value.labels.flatMap((label) => {
        if (!label || typeof label !== "object") return [];
        const name = (label as { name?: unknown }).name;
        return typeof name === "string" && name ? [name] : [];
      })
    : [];
  return githubActionsRunnerSchema.parse({
    id: Number(value.id),
    name: String(value.name || "Runner"),
    os: String(value.os || "unknown"),
    status: value.status === "online" ? "online" : "offline",
    busy: value.busy === true,
    labels: labels.slice(0, 100),
  });
}

function actionsRunCheckoutIdentity(run: GithubActionsRun): {
  branch: string;
  name: string;
} {
  const slug = run.displayTitle
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  return {
    branch: `cantrip/actions/${run.runNumber}-${run.headSha.slice(0, 8)}`,
    name: `Actions #${run.runNumber} ${slug || run.name}`.slice(0, 200),
  };
}

export class GithubClient {
  private readonly replicaOperationQueues = new Map<string, Promise<void>>();
  private readonly placementManager: ProjectReplicaPlacementManager;

  constructor(
    private readonly dataDirectory: string,
    workerId = "local-worker",
  ) {
    this.placementManager = new ProjectReplicaPlacementManager(
      dataDirectory,
      workerId,
    );
  }

  private repositoriesRoot(): string {
    return path.resolve(this.dataDirectory, "repositories");
  }

  private repositoryCachePath(): string {
    return path.join(this.dataDirectory, "github", "repositories.json");
  }

  private repositoryApiPath(nameWithOwner: string): string {
    const [owner, repository] = repositorySegments(nameWithOwner);
    return `repos/${owner}/${repository}`;
  }

  private async api(pathname: string, args: string[] = []): Promise<unknown> {
    const { stdout } = await execFileAsync("gh", ["api", pathname, ...args], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, string | number | boolean | null>,
  ): Promise<T> {
    const args = ["-f", `query=${query}`];
    for (const [name, value] of Object.entries(variables)) {
      if (value === null) continue;
      args.push(
        typeof value === "string" ? "-f" : "-F",
        `${name}=${String(value)}`,
      );
    }
    return (await this.api("graphql", args)) as T;
  }

  private async pullRequestReviewContext(
    nameWithOwner: string,
    pullRequestNumber: number,
  ): Promise<PullRequestReviewContext> {
    const [owner, repository] = repositorySegments(nameWithOwner);
    return parsePullRequestReviewContext(
      await this.graphql<GithubGraphqlPullRequestReviewContextResponse>(
        GITHUB_PULL_REQUEST_REVIEW_CONTEXT_QUERY,
        { owner, repository, number: pullRequestNumber },
      ),
    );
  }

  private async listSearchPage(
    nameWithOwner: string,
    kind: "issue" | "pull-request",
    state: GithubIssueState,
    cursor: string | null,
    limit: number,
    input: GithubIssueListFilters,
  ): Promise<{
    items: Array<GithubIssueSummary | GithubPullRequestSummary>;
    nextCursor: string | null;
    total: number | null;
  }> {
    const filters = githubIssueListFiltersSchema.parse(input);
    const searchQuery = githubListSearchQuery(
      nameWithOwner,
      kind,
      state,
      filters,
    );
    const items: Array<GithubIssueSummary | GithubPullRequestSummary> = [];
    let currentCursor = cursor;
    let nextCursor: string | null = null;
    let total: number | null = null;
    const needsMergeabilityScan =
      kind === "pull-request" && filters.mergeability !== null;

    for (let scan = 0; scan < (needsMergeabilityScan ? 10 : 1); scan += 1) {
      const remaining = limit - items.length;
      if (remaining <= 0) break;
      const args = [
        "-f",
        `query=${GITHUB_LIST_SEARCH_QUERY}`,
        "-f",
        `search=${searchQuery}`,
        "-F",
        `first=${remaining}`,
      ];
      if (currentCursor) args.push("-f", `after=${currentCursor}`);
      const response = (await this.api(
        "graphql",
        args,
      )) as GithubGraphqlSearchResponse;
      const search = response.data?.search;
      if (!search || !search.pageInfo || !Array.isArray(search.nodes)) {
        throw new Error("GitHub returned an invalid issue search response.");
      }
      if (!needsMergeabilityScan) {
        const issueCount = Number(search.issueCount);
        total = Number.isFinite(issueCount) ? issueCount : null;
      }
      const parsed = search.nodes.flatMap((node) => {
        if (kind === "issue" && node.__typename === "Issue") {
          return [parseGraphqlIssue(node)];
        }
        if (kind === "pull-request" && node.__typename === "PullRequest") {
          const pullRequest = parseGraphqlPullRequest(node);
          return matchesMergeability(pullRequest, filters.mergeability)
            ? [pullRequest]
            : [];
        }
        return [];
      });
      items.push(...parsed);
      const hasNextPage = search.pageInfo.hasNextPage === true;
      const endCursor = search.pageInfo.endCursor;
      if (hasNextPage && typeof endCursor !== "string") {
        throw new Error("GitHub omitted the next issue search cursor.");
      }
      nextCursor = hasNextPage ? (endCursor as string) : null;
      if (!hasNextPage || !needsMergeabilityScan || items.length >= limit) {
        break;
      }
      currentCursor = nextCursor;
    }

    return { items, nextCursor, total };
  }

  private async apiVoid(pathname: string, args: string[] = []): Promise<void> {
    await execFileAsync("gh", ["api", pathname, ...args], {
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  private async verifyWorktree(cwd: string): Promise<void> {
    await execFileAsync("git", ["-C", cwd, "rev-parse", "--git-dir"]);
  }

  async repositoryForCheckout(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", cwd, "config", "--get", "remote.origin.url"],
        { maxBuffer: 1024 * 1024, timeout: 10_000 },
      );
      return githubRepositoryFromRemoteUrl(stdout);
    } catch {
      return null;
    }
  }

  async inspectCheckout(
    cwd: string,
    lookupRepository: (
      nameWithOwner: string,
    ) => Promise<ProjectGithubConversionRepository> = async (nameWithOwner) => {
      const value = (await this.api(
        this.repositoryApiPath(nameWithOwner),
      )) as GithubApiRepository;
      return projectGithubConversionRepositorySchema.parse({
        repositoryId: String(value.id),
        nameWithOwner: String(value.full_name),
        url: String(value.html_url),
      });
    },
  ): Promise<{
    github: ProjectGithubConversionRepository | null;
    repositoryFingerprint: string | null;
  }> {
    try {
      const topLevel = await realpath(
        (
          await execFileAsync(
            "git",
            ["-C", cwd, "rev-parse", "--show-toplevel"],
            { maxBuffer: 1024 * 1024, timeout: 10_000 },
          )
        ).stdout.trim(),
      );
      if (!pathsEqual(topLevel, cwd)) {
        return { github: null, repositoryFingerprint: null };
      }
      const commonDirOutput = (
        await execFileAsync(
          "git",
          ["-C", cwd, "rev-parse", "--git-common-dir"],
          { maxBuffer: 1024 * 1024, timeout: 10_000 },
        )
      ).stdout.trim();
      const commonDir = await realpath(
        path.isAbsolute(commonDirOutput)
          ? commonDirOutput
          : path.resolve(cwd, commonDirOutput),
      );
      const repositoryFingerprint = createHash("sha256")
        .update(commonDir)
        .digest("hex");
      const nameWithOwner = await this.repositoryForCheckout(cwd);
      if (!nameWithOwner) {
        return { github: null, repositoryFingerprint };
      }
      try {
        const repository = await lookupRepository(nameWithOwner);
        return repository.nameWithOwner.toLowerCase() === nameWithOwner
          ? { github: repository, repositoryFingerprint }
          : { github: null, repositoryFingerprint };
      } catch {
        return { github: null, repositoryFingerprint };
      }
    } catch {
      return { github: null, repositoryFingerprint: null };
    }
  }

  async cachedRepositories(login: string): Promise<GithubWorkerRepository[]> {
    try {
      const cache = JSON.parse(
        await readFile(this.repositoryCachePath(), "utf8"),
      ) as RepositoryCache;
      if (cache.login !== login) return [];
      return githubWorkerRepositoryListSchema.parse(cache.repositories);
    } catch {
      return [];
    }
  }

  async deleteRepository(
    repositoryPath: string,
  ): Promise<{ deleted: boolean }> {
    const root = this.repositoriesRoot();
    const target = path.resolve(repositoryPath);
    if (!target.startsWith(`${root}${path.sep}`) || target === root) {
      throw new Error("Cantrip will only delete repositories it manages.");
    }
    try {
      const entry = await lstat(target);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error("The project source is not a managed directory.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { deleted: false };
      }
      throw error;
    }
    await rm(target, { recursive: true, force: false });
    return { deleted: true };
  }

  async authStatus(): Promise<GithubAuthStatus> {
    try {
      const { stdout } = await execFileAsync(
        "gh",
        ["api", "user", "--jq", ".login"],
        { maxBuffer: 1024 * 1024 },
      );
      const login = stdout.trim();
      return githubAuthStatusSchema.parse({
        authenticated: true,
        login,
        source:
          process.env.GH_TOKEN || process.env.GITHUB_TOKEN ? "token" : "gh-cli",
      });
    } catch {
      return githubAuthStatusSchema.parse({
        authenticated: false,
        login: null,
        source: "none",
      });
    }
  }

  async listRepositories(): Promise<GithubWorkerRepository[]> {
    const status = await this.authStatus();
    if (!status.authenticated || !status.login) {
      throw new Error(
        "GitHub is not authenticated on this worker. Run `gh auth login` or set GH_TOKEN.",
      );
    }

    const { stdout } = await execFileAsync(
      "gh",
      [
        "api",
        "--method",
        "GET",
        "--paginate",
        "--slurp",
        "user/repos",
        "-f",
        "per_page=100",
        "-f",
        "affiliation=owner,collaborator,organization_member",
        "-f",
        "sort=updated",
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    const pages = JSON.parse(stdout) as GithubApiRepository[][];
    const repositories = githubWorkerRepositoryListSchema.parse(
      pages
        .flat()
        .map(parseRepository)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    );
    const cachePath = this.repositoryCachePath();
    const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 });
      await writeFile(
        temporaryPath,
        JSON.stringify({
          login: status.login,
          repositories,
          updatedAt: new Date().toISOString(),
        } satisfies RepositoryCache),
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(temporaryPath, cachePath);
    } catch {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    return repositories;
  }

  async listRepositoryOwners(): Promise<GithubRepositoryOwner[]> {
    const status = await this.authStatus();
    if (!status.authenticated || !status.login) {
      throw new Error(
        "GitHub is not authenticated on this worker. Run `gh auth login` or set GH_TOKEN.",
      );
    }
    const { stdout } = await execFileAsync(
      "gh",
      [
        "api",
        "--method",
        "GET",
        "--paginate",
        "--slurp",
        "user/orgs",
        "-f",
        "per_page=100",
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const pages = JSON.parse(stdout) as GithubApiOrganization[][];
    const organizations = pages
      .flat()
      .flatMap(({ login }) => (typeof login === "string" ? [login] : []))
      .filter((login) => login !== status.login)
      .sort((left, right) => left.localeCompare(right));
    return githubRepositoryOwnerListSchema.parse([
      { login: status.login, kind: "user" },
      ...[...new Set(organizations)].map((login) => ({
        login,
        kind: "organization" as const,
      })),
    ]);
  }

  async createRepository(
    input: GithubRepositoryCreate,
  ): Promise<GithubWorkerRepository> {
    const request = githubRepositoryCreateSchema.parse(input);
    const nameWithOwner = `${request.owner}/${request.name}`;
    repositorySegments(nameWithOwner);
    const args = ["repo", "create", nameWithOwner, `--${request.visibility}`];
    if (request.initialize === "readme") args.push("--add-readme");
    if (request.description) {
      args.push("--description", request.description);
    }
    await execFileAsync("gh", args, { maxBuffer: 8 * 1024 * 1024 });
    return githubWorkerRepositorySchema.parse(
      parseRepository(
        (await this.api(
          this.repositoryApiPath(nameWithOwner),
        )) as GithubApiRepository,
      ),
    );
  }

  async listIssues(
    nameWithOwner: string,
    state: GithubIssueState,
    cursor: string | null = null,
    limit = 100,
    filters: GithubIssueListFilters = githubIssueListFiltersSchema.parse({}),
  ): Promise<GithubIssueList> {
    const page = await this.listSearchPage(
      nameWithOwner,
      "issue",
      state,
      cursor,
      limit,
      filters,
    );
    return githubIssueListSchema.parse({
      kind: "issue",
      state,
      total: page.total,
      issues: page.items,
      nextCursor: page.nextCursor,
    });
  }

  async listInbox(
    nameWithOwner: string,
    kind: "issue" | "pull-request",
    state: "open" | "closed",
    view: GithubInboxView,
    cursor: string | null = null,
    limit = 50,
  ): Promise<GithubInboxList> {
    repositorySegments(nameWithOwner);
    const auth = await this.authStatus();
    if (!auth.authenticated || !auth.login) {
      throw new Error("GitHub authentication is unavailable on this worker.");
    }
    return loadGithubInbox({
      api: (pathname, args) => this.api(pathname, args),
      apiRepositoryPath: this.repositoryApiPath(nameWithOwner),
      cursor,
      kind,
      limit,
      repository: nameWithOwner,
      state,
      view,
      viewerLogin: auth.login,
    });
  }

  async listPullRequests(
    nameWithOwner: string,
    state: GithubIssueState,
    cursor: string | null = null,
    limit = 100,
    filters: GithubIssueListFilters = githubIssueListFiltersSchema.parse({}),
  ): Promise<GithubPullRequestList> {
    const page = await this.listSearchPage(
      nameWithOwner,
      "pull-request",
      state,
      cursor,
      limit,
      filters,
    );
    return githubPullRequestListSchema.parse({
      state,
      total: page.total,
      pullRequests: page.items,
      nextCursor: page.nextCursor,
    });
  }

  async countOpenIssues(nameWithOwner: string): Promise<number> {
    repositorySegments(nameWithOwner);
    const result = (await this.api("search/issues", [
      "--method",
      "GET",
      "-f",
      `q=repo:${nameWithOwner} is:issue is:open`,
      "-f",
      "per_page=1",
    ])) as { total_count?: unknown };
    if (
      typeof result.total_count !== "number" ||
      !Number.isInteger(result.total_count) ||
      result.total_count < 0
    ) {
      throw new Error("GitHub returned an invalid open issue count.");
    }
    return result.total_count;
  }

  async getIssue(
    nameWithOwner: string,
    issueNumber: number,
  ): Promise<GithubIssueDetail> {
    const issuePath = `${this.repositoryApiPath(nameWithOwner)}/issues/${issueNumber}`;
    const [rawIssue, commentPages] = await Promise.all([
      this.api(issuePath) as Promise<GithubApiIssue>,
      this.api(`${issuePath}/comments`, [
        "--method",
        "GET",
        "--paginate",
        "--slurp",
        "-f",
        "per_page=100",
      ]) as Promise<GithubApiIssueComment[][]>,
    ]);
    return githubIssueDetailSchema.parse({
      ...parseIssue(rawIssue),
      body: typeof rawIssue.body === "string" ? rawIssue.body : null,
      comments: commentPages.flat().map(parseIssueComment),
    });
  }

  async createIssue(
    nameWithOwner: string,
    input: GithubIssueCreate,
  ): Promise<GithubIssueDetail> {
    const request = githubIssueCreateSchema.parse(input);
    const rawIssue = (await this.api(
      `${this.repositoryApiPath(nameWithOwner)}/issues`,
      [
        "--method",
        "POST",
        "-f",
        `title=${request.title}`,
        "-f",
        `body=${request.body}`,
      ],
    )) as GithubApiIssue;
    return githubIssueDetailSchema.parse({
      ...parseIssue(rawIssue),
      body: typeof rawIssue.body === "string" ? rawIssue.body : null,
      comments: [],
    });
  }

  async commentOnIssue(
    nameWithOwner: string,
    issueNumber: number,
    body: string,
  ): Promise<GithubIssueDetail> {
    const issuePath = `${this.repositoryApiPath(nameWithOwner)}/issues/${issueNumber}`;
    await this.api(`${issuePath}/comments`, [
      "--method",
      "POST",
      "-f",
      `body=${body}`,
    ]);
    return this.getIssue(nameWithOwner, issueNumber);
  }

  async closeIssue(
    nameWithOwner: string,
    issueNumber: number,
    comment: string | null,
  ): Promise<GithubIssueDetail> {
    const issuePath = `${this.repositoryApiPath(nameWithOwner)}/issues/${issueNumber}`;
    if (comment) {
      await this.api(`${issuePath}/comments`, [
        "--method",
        "POST",
        "-f",
        `body=${comment}`,
      ]);
    }
    await this.api(issuePath, ["--method", "PATCH", "-f", "state=closed"]);
    return this.getIssue(nameWithOwner, issueNumber);
  }

  async createPullRequest(
    nameWithOwner: string,
    cwd: string,
    request: GithubPullRequestCreate,
  ): Promise<GithubPullRequestCreateResult> {
    await Promise.all([
      execFileAsync("git", [
        "-C",
        cwd,
        "check-ref-format",
        "--branch",
        request.head,
      ]),
      execFileAsync("git", [
        "-C",
        cwd,
        "check-ref-format",
        "--branch",
        request.base,
      ]),
    ]);
    const { stdout } = await execFileAsync("git", [
      "-C",
      cwd,
      "rev-parse",
      `refs/heads/${request.head}`,
    ]);
    const localHead = stdout.trim();
    const remoteHead = (await this.api(
      `${this.repositoryApiPath(nameWithOwner)}/git/ref/heads/${encodedRefPath(request.head)}`,
    )) as GithubApiGitRef;
    const remoteObject =
      remoteHead.object && typeof remoteHead.object === "object"
        ? (remoteHead.object as { sha?: unknown })
        : null;
    const remoteSha =
      remoteObject && typeof remoteObject.sha === "string"
        ? remoteObject.sha
        : "";
    if (!/^[0-9a-f]{40}$/u.test(remoteSha) || remoteSha !== localHead) {
      throw new Error(
        `Push ${request.head} to ${nameWithOwner} before creating its pull request. The local and GitHub branch tips must match.`,
      );
    }

    const linkedIssues = [...new Set(request.linkedIssueNumbers)].map(
      (number) => `Closes #${number}`,
    );
    const body = [request.body.trim(), linkedIssues.join("\n")]
      .filter(Boolean)
      .join("\n\n");
    const rawPullRequest = (await this.api(
      `${this.repositoryApiPath(nameWithOwner)}/pulls`,
      [
        "--method",
        "POST",
        "-f",
        `title=${request.title}`,
        "-f",
        `head=${request.head}`,
        "-f",
        `base=${request.base}`,
        "-f",
        `body=${body}`,
        "-F",
        `draft=${request.draft}`,
      ],
    )) as GithubApiPullRequest;
    const pullRequest = parsePullRequest(rawPullRequest);
    const warnings: string[] = [];
    const labels = [...new Set(request.labels)];
    if (labels.length > 0) {
      try {
        await this.api(
          `${this.repositoryApiPath(nameWithOwner)}/issues/${pullRequest.number}/labels`,
          [
            "--method",
            "POST",
            ...labels.flatMap((label) => ["-f", `labels[]=${label}`]),
          ],
        );
      } catch (error) {
        warnings.push(
          `The pull request was created, but labels could not be applied: ${(error as Error).message}`,
        );
      }
    }
    const reviewers = [...new Set(request.reviewers)];
    if (reviewers.length > 0) {
      try {
        await this.api(
          `${this.repositoryApiPath(nameWithOwner)}/pulls/${pullRequest.number}/requested_reviewers`,
          [
            "--method",
            "POST",
            ...reviewers.flatMap((reviewer) => [
              "-f",
              `reviewers[]=${reviewer}`,
            ]),
          ],
        );
      } catch (error) {
        warnings.push(
          `The pull request was created, but reviewers could not be requested: ${(error as Error).message}`,
        );
      }
    }
    return githubPullRequestCreateResultSchema.parse({
      pullRequest,
      warnings,
    });
  }

  async getPullRequestOverview(
    nameWithOwner: string,
    cwd: string,
    pullRequestNumber: number,
  ): Promise<GithubPullRequestOverview> {
    await this.verifyWorktree(cwd);
    const repositoryPath = this.repositoryApiPath(nameWithOwner);
    const pullRequestPath = `${repositoryPath}/pulls/${pullRequestNumber}`;
    const rawPullRequest = (await this.api(
      pullRequestPath,
    )) as GithubApiPullRequest;
    const summary = parsePullRequest(rawPullRequest);
    const issuePath = `${repositoryPath}/issues/${pullRequestNumber}`;
    const [
      commentsResult,
      reviewsResult,
      reviewCommentsResult,
      reviewContextResult,
    ] = await Promise.allSettled([
      this.api(`${issuePath}/comments`, [
        "--method",
        "GET",
        "-f",
        "per_page=100",
      ]) as Promise<GithubApiIssueComment[]>,
      this.api(`${pullRequestPath}/reviews`, [
        "--method",
        "GET",
        "-f",
        "per_page=100",
      ]) as Promise<GithubApiPullRequestReview[]>,
      this.api(`${pullRequestPath}/comments`, [
        "--method",
        "GET",
        "-f",
        "per_page=100",
      ]) as Promise<GithubApiPullRequestReviewComment[]>,
      this.pullRequestReviewContext(nameWithOwner, pullRequestNumber),
    ]);
    const warnings: GithubPullRequestOverview["warnings"] = [];
    const rawComments =
      commentsResult.status === "fulfilled" &&
      Array.isArray(commentsResult.value)
        ? commentsResult.value
        : [];
    if (commentsResult.status === "rejected") {
      warnings.push(
        pullRequestDataWarning("conversation", commentsResult.reason),
      );
    }
    const rawReviews =
      reviewsResult.status === "fulfilled" && Array.isArray(reviewsResult.value)
        ? reviewsResult.value
        : [];
    if (reviewsResult.status === "rejected") {
      warnings.push(pullRequestDataWarning("reviews", reviewsResult.reason));
    }
    const rawReviewComments =
      reviewCommentsResult.status === "fulfilled" &&
      Array.isArray(reviewCommentsResult.value)
        ? reviewCommentsResult.value
        : [];
    if (reviewCommentsResult.status === "rejected") {
      warnings.push(
        pullRequestDataWarning("review-threads", reviewCommentsResult.reason),
      );
    }
    if (reviewContextResult.status === "rejected") {
      warnings.push(
        pullRequestDataWarning("review-threads", reviewContextResult.reason),
      );
    }
    const reviews = rawReviews.slice(0, 100).map(parsePullRequestReview);
    const reviewComments = rawReviewComments
      .slice(0, 100)
      .map(parsePullRequestReviewComment);
    const fallbackReviewThreads = groupPullRequestReviewThreads(reviewComments);
    const reviewContext =
      reviewContextResult.status === "fulfilled"
        ? reviewContextResult.value
        : null;
    const reviewThreads = reviewContext?.reviewThreads ?? fallbackReviewThreads;
    const requestedReviewers = Array.isArray(rawPullRequest.requested_reviewers)
      ? [
          ...new Set(
            rawPullRequest.requested_reviewers.map((reviewer) =>
              githubLogin(reviewer),
            ),
          ),
        ]
      : [];
    return githubPullRequestOverviewSchema.parse({
      ...summary,
      nodeId:
        reviewContext?.nodeId ??
        (typeof rawPullRequest.node_id === "string"
          ? rawPullRequest.node_id
          : null),
      viewerLogin: reviewContext?.viewerLogin ?? null,
      pendingReview: reviewContext?.pendingReview ?? null,
      autoMerge: reviewContext?.autoMerge ?? null,
      mergeQueueEnabled: reviewContext?.mergeQueueEnabled ?? false,
      mergeQueueEntry: reviewContext?.mergeQueueEntry ?? null,
      comments: rawComments.slice(0, 100).map(parseIssueComment),
      commentsTruncated: summary.commentCount > rawComments.length,
      requestedReviewers,
      mergeable:
        typeof rawPullRequest.mergeable === "boolean"
          ? rawPullRequest.mergeable
          : null,
      mergeableState:
        typeof rawPullRequest.mergeable_state === "string"
          ? rawPullRequest.mergeable_state
          : "unknown",
      reviewDecision:
        reviewsResult.status === "fulfilled"
          ? deriveReviewDecision(reviews, requestedReviewers)
          : "unknown",
      checksState: "unknown",
      additions: Number(rawPullRequest.additions) || 0,
      deletions: Number(rawPullRequest.deletions) || 0,
      changedFileCount: Number(rawPullRequest.changed_files) || 0,
      commitCount: Number(rawPullRequest.commits) || 0,
      reviews,
      reviewsTruncated: rawReviews.length >= 100,
      reviewThreads,
      reviewThreadsTruncated:
        reviewContext?.reviewThreadsTruncated ??
        (rawReviewComments.length >= 100 || reviewThreads.length >= 100),
      warnings,
    });
  }

  async getPullRequestFiles(
    nameWithOwner: string,
    cwd: string,
    pullRequestNumber: number,
  ): Promise<GithubPullRequestFiles> {
    await this.verifyWorktree(cwd);
    const [values, viewedStatesResult] = await Promise.all([
      this.api(
        `${this.repositoryApiPath(nameWithOwner)}/pulls/${pullRequestNumber}/files`,
        ["--method", "GET", "-f", "per_page=100"],
      ),
      (async () => {
        const [owner, repository] = repositorySegments(nameWithOwner);
        return parsePullRequestFileViewedStates(
          await this.graphql<GithubGraphqlPullRequestFileStateResponse>(
            GITHUB_PULL_REQUEST_FILE_STATES_QUERY,
            { owner, repository, number: pullRequestNumber },
          ),
        );
      })().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    ]);
    if (!Array.isArray(values)) {
      throw new Error(
        "GitHub returned an invalid pull request files response.",
      );
    }
    const viewedStates = viewedStatesResult.ok
      ? viewedStatesResult.value
      : new Map<string, boolean>();
    return githubPullRequestFilesSchema.parse({
      files: (values as GithubApiPullRequestFile[])
        .slice(0, 100)
        .map((value) => {
          const file = parsePullRequestFile(value);
          return {
            ...file,
            viewed: viewedStates.get(file.path) ?? null,
          };
        }),
      filesTruncated: values.length >= 100,
      warnings: viewedStatesResult.ok
        ? []
        : [pullRequestDataWarning("files", viewedStatesResult.error)],
    });
  }

  async getPullRequestCommits(
    nameWithOwner: string,
    cwd: string,
    pullRequestNumber: number,
  ): Promise<GithubPullRequestCommits> {
    await this.verifyWorktree(cwd);
    const values = await this.api(
      `${this.repositoryApiPath(nameWithOwner)}/pulls/${pullRequestNumber}/commits`,
      ["--method", "GET", "-f", "per_page=100"],
    );
    if (!Array.isArray(values)) {
      throw new Error(
        "GitHub returned an invalid pull request commits response.",
      );
    }
    return githubPullRequestCommitsSchema.parse({
      commits: (values as GithubApiPullRequestCommit[])
        .slice(0, 100)
        .map(parsePullRequestCommit),
      commitsTruncated: values.length >= 100,
      warnings: [],
    });
  }

  async getPullRequestChecks(
    nameWithOwner: string,
    cwd: string,
    pullRequestNumber: number,
  ): Promise<GithubPullRequestChecks> {
    await this.verifyWorktree(cwd);
    const repositoryPath = this.repositoryApiPath(nameWithOwner);
    const pullRequest = parsePullRequest(
      (await this.api(
        `${repositoryPath}/pulls/${pullRequestNumber}`,
      )) as GithubApiPullRequest,
    );
    const [checkRunsResult, statusesResult] = await Promise.allSettled([
      this.api(`${repositoryPath}/commits/${pullRequest.headSha}/check-runs`, [
        "--method",
        "GET",
        "-f",
        "per_page=100",
      ]) as Promise<GithubApiCheckRuns>,
      this.api(`${repositoryPath}/commits/${pullRequest.headSha}/status`, [
        "--method",
        "GET",
        "-f",
        "per_page=100",
      ]) as Promise<GithubApiCombinedStatus>,
    ]);
    if (
      checkRunsResult.status === "rejected" &&
      statusesResult.status === "rejected"
    ) {
      throw new Error(
        `GitHub checks are unavailable: ${pullRequestDataWarning("checks", checkRunsResult.reason).message}`,
      );
    }
    const warnings: GithubPullRequestChecks["warnings"] = [];
    if (checkRunsResult.status === "rejected") {
      warnings.push(pullRequestDataWarning("checks", checkRunsResult.reason));
    }
    if (statusesResult.status === "rejected") {
      warnings.push(pullRequestDataWarning("checks", statusesResult.reason));
    }
    const rawCheckRuns =
      checkRunsResult.status === "fulfilled" ? checkRunsResult.value : {};
    const rawStatuses =
      statusesResult.status === "fulfilled" ? statusesResult.value : {};
    const checkRuns = Array.isArray(rawCheckRuns.check_runs)
      ? (rawCheckRuns.check_runs as GithubApiCheckRun[])
          .slice(0, 100)
          .map(parseCheckRun)
      : [];
    const statuses = Array.isArray(rawStatuses.statuses)
      ? (rawStatuses.statuses as GithubApiCommitStatus[])
          .slice(0, 100)
          .map(parseCommitStatus)
      : [];
    const checks = [...checkRuns, ...statuses].slice(0, 200);
    return githubPullRequestChecksSchema.parse({
      checks,
      checksState: deriveChecksState(checks),
      checksTruncated:
        Number(rawCheckRuns.total_count) > checkRuns.length ||
        (Array.isArray(rawStatuses.statuses) &&
          rawStatuses.statuses.length >= 100),
      warnings,
    });
  }

  async getPullRequest(
    nameWithOwner: string,
    cwd: string,
    pullRequestNumber: number,
  ): Promise<GithubPullRequestDetail> {
    const overview = await this.getPullRequestOverview(
      nameWithOwner,
      cwd,
      pullRequestNumber,
    );
    const [filesResult, commitsResult, checksResult] = await Promise.allSettled(
      [
        this.getPullRequestFiles(nameWithOwner, cwd, pullRequestNumber),
        this.getPullRequestCommits(nameWithOwner, cwd, pullRequestNumber),
        this.getPullRequestChecks(nameWithOwner, cwd, pullRequestNumber),
      ],
    );
    const warnings = [...overview.warnings];
    if (filesResult.status === "rejected") {
      warnings.push(pullRequestDataWarning("files", filesResult.reason));
    }
    if (commitsResult.status === "rejected") {
      warnings.push(pullRequestDataWarning("commits", commitsResult.reason));
    }
    if (checksResult.status === "rejected") {
      warnings.push(pullRequestDataWarning("checks", checksResult.reason));
    }
    return githubPullRequestDetailSchema.parse({
      ...overview,
      files: filesResult.status === "fulfilled" ? filesResult.value.files : [],
      filesTruncated:
        filesResult.status === "fulfilled"
          ? filesResult.value.filesTruncated
          : true,
      commits:
        commitsResult.status === "fulfilled" ? commitsResult.value.commits : [],
      commitsTruncated:
        commitsResult.status === "fulfilled"
          ? commitsResult.value.commitsTruncated
          : true,
      checks:
        checksResult.status === "fulfilled" ? checksResult.value.checks : [],
      checksTruncated:
        checksResult.status === "fulfilled"
          ? checksResult.value.checksTruncated
          : true,
      checksState:
        checksResult.status === "fulfilled"
          ? checksResult.value.checksState
          : "unknown",
      warnings: [
        ...warnings,
        ...(filesResult.status === "fulfilled"
          ? filesResult.value.warnings
          : []),
        ...(commitsResult.status === "fulfilled"
          ? commitsResult.value.warnings
          : []),
        ...(checksResult.status === "fulfilled"
          ? checksResult.value.warnings
          : []),
      ],
    });
  }

  async getPullRequestAgentContext(
    nameWithOwner: string,
    cwd: string,
    pullRequestNumber: number,
    request: GithubPullRequestAgentContextRequest,
  ): Promise<GithubPullRequestAgentContext> {
    const pullRequest = await this.getPullRequest(
      nameWithOwner,
      cwd,
      pullRequestNumber,
    );
    const activeReviewThreads = pullRequest.reviewThreads.filter(
      ({ resolved }) => resolved !== true,
    );
    const failedChecks = pullRequest.checks
      .filter(failedPullRequestCheck)
      .slice(0, 20);
    const logs = new Map<
      string,
      { excerpt: string | null; unavailableReason: string | null }
    >();
    if (request.intent === "fix-checks") {
      await Promise.all(
        [...new Set(failedChecks.map(({ url }) => githubActionsRunId(url)))]
          .filter((runId): runId is string => Boolean(runId))
          .slice(0, 5)
          .map(async (runId) => {
            try {
              const { stdout, stderr } = await execFileAsync(
                "gh",
                ["run", "view", runId, "--repo", nameWithOwner, "--log-failed"],
                { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 },
              );
              const output = `${stdout}${stderr}`.trim();
              logs.set(runId, {
                excerpt: output ? output.slice(-100_000) : null,
                unavailableReason: output
                  ? null
                  : "GitHub returned no failed-step log output for this run.",
              });
            } catch (error) {
              logs.set(runId, {
                excerpt: null,
                unavailableReason:
                  `Failed-step logs could not be loaded: ${error instanceof Error ? error.message : String(error)}`.slice(
                    0,
                    2_000,
                  ),
              });
            }
          }),
      );
    }
    return githubPullRequestAgentContextSchema.parse({
      intent: request.intent,
      pullRequest,
      activeReviewThreads:
        request.intent === "address-review" ? activeReviewThreads : [],
      failedChecks:
        request.intent === "fix-checks"
          ? failedChecks.map((check) => {
              const runId = githubActionsRunId(check.url);
              const log = runId ? logs.get(runId) : null;
              return {
                checkId: check.id,
                name: check.name,
                url: check.url,
                summary: check.summary,
                logExcerpt: log?.excerpt ?? null,
                logUnavailableReason: log
                  ? log.unavailableReason
                  : runId
                    ? "This run was outside the bounded log-fetch window."
                    : "This check does not expose GitHub Actions run logs.",
              };
            })
          : [],
    });
  }

  async preparePullRequestCheckout(
    nameWithOwner: string,
    cwd: string,
    pullRequestNumber: number,
  ): Promise<GithubPullRequestCheckoutPrepared> {
    await this.verifyWorktree(cwd);
    const rawPullRequest = (await this.api(
      `${this.repositoryApiPath(nameWithOwner)}/pulls/${pullRequestNumber}`,
    )) as GithubApiPullRequest;
    const pullRequest = parsePullRequest(rawPullRequest);
    const expectedRepository = nameWithOwner.toLowerCase();
    const { stdout: remoteOutput } = await execFileAsync("git", [
      "-C",
      cwd,
      "remote",
    ]);
    const remoteNames = remoteOutput
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
    const matches: string[] = [];
    for (const remote of remoteNames) {
      const { stdout } = await execFileAsync("git", [
        "-C",
        cwd,
        "remote",
        "get-url",
        remote,
      ]);
      if (githubRepositoryFromRemoteUrl(stdout) === expectedRepository) {
        matches.push(remote);
      }
    }
    const remote = matches.includes("origin") ? "origin" : matches[0];
    if (!remote) {
      throw new Error(
        `No Git remote in this project points to ${nameWithOwner}. Add the GitHub repository as a remote before checking out its pull requests.`,
      );
    }
    await execFileAsync("git", [
      "-C",
      cwd,
      "fetch",
      "--no-tags",
      remote,
      `refs/pull/${pullRequestNumber}/head`,
    ]);
    const { stdout: fetchedOutput } = await execFileAsync("git", [
      "-C",
      cwd,
      "rev-parse",
      "--verify",
      "FETCH_HEAD^{commit}",
    ]);
    const headSha = fetchedOutput.trim();
    if (headSha !== pullRequest.headSha) {
      throw new Error(
        "The pull request changed while its checkout was prepared. Retry to use the latest head commit.",
      );
    }
    return githubPullRequestCheckoutPreparedSchema.parse({
      pullRequest,
      ...pullRequestCheckoutIdentity(pullRequest),
      headSha,
      remote,
    });
  }

  async commentOnPullRequest(
    nameWithOwner: string,
    cwd: string,
    pullRequestNumber: number,
    body: string,
  ): Promise<GithubPullRequestDetail> {
    await this.verifyWorktree(cwd);
    await this.api(
      `${this.repositoryApiPath(nameWithOwner)}/issues/${pullRequestNumber}/comments`,
      ["--method", "POST", "-f", `body=${body}`],
    );
    return this.getPullRequest(nameWithOwner, cwd, pullRequestNumber);
  }

  async submitPullRequestReview(
    nameWithOwner: string,
    cwd: string,
    pullRequestNumber: number,
    review: GithubPullRequestReviewSubmit,
  ): Promise<GithubPullRequestDetail> {
    await this.verifyWorktree(cwd);
    const event =
      review.event === "approve"
        ? "APPROVE"
        : review.event === "request-changes"
          ? "REQUEST_CHANGES"
          : "COMMENT";
    const context = await this.pullRequestReviewContext(
      nameWithOwner,
      pullRequestNumber,
    );
    if (context.pendingReview) {
      await this.graphql(GITHUB_SUBMIT_PENDING_REVIEW_MUTATION, {
        reviewId: context.pendingReview.id,
        event,
        body: review.body || null,
      });
    } else {
      await this.api(
        `${this.repositoryApiPath(nameWithOwner)}/pulls/${pullRequestNumber}/reviews`,
        [
          "--method",
          "POST",
          "-f",
          `event=${event}`,
          "-f",
          `body=${review.body}`,
        ],
      );
    }
    return this.getPullRequest(nameWithOwner, cwd, pullRequestNumber);
  }

  async commentOnPullRequestLine(
    nameWithOwner: string,
    cwd: string,
    pullRequestNumber: number,
    comment: GithubPullRequestInlineCommentCreate,
  ): Promise<GithubPullRequestDetail> {
    await this.verifyWorktree(cwd);
    const pullRequestPath = `${this.repositoryApiPath(nameWithOwner)}/pulls/${pullRequestNumber}`;
    const pullRequest = parsePullRequest(
      (await this.api(pullRequestPath)) as GithubApiPullRequest,
    );
    const context = await this.pullRequestReviewContext(
      nameWithOwner,
      pullRequestNumber,
    );
    let reviewId = context.pendingReview?.id ?? null;
    if (!reviewId) {
      const created = await this.graphql<{
        data?: {
          addPullRequestReview?: { pullRequestReview?: { id?: unknown } };
        };
      }>(GITHUB_CREATE_PENDING_REVIEW_MUTATION, {
        pullRequestId: context.nodeId,
        head: pullRequest.headSha,
      });
      const id = created.data?.addPullRequestReview?.pullRequestReview?.id;
      if (typeof id !== "string" || !id) {
        throw new Error("GitHub did not create a pending review.");
      }
      reviewId = id;
    }
    await this.graphql(GITHUB_ADD_PENDING_REVIEW_THREAD_MUTATION, {
      reviewId,
      body: comment.body,
      path: comment.path,
      line: comment.line,
      side: comment.side,
      startLine: comment.startLine,
      startSide: comment.startSide,
    });
    return this.getPullRequest(nameWithOwner, cwd, pullRequestNumber);
  }

  async discardPullRequestReview(
    nameWithOwner: string,
    cwd: string,
    pullRequestNumber: number,
  ): Promise<GithubPullRequestDetail> {
    await this.verifyWorktree(cwd);
    const context = await this.pullRequestReviewContext(
      nameWithOwner,
      pullRequestNumber,
    );
    if (!context.pendingReview) {
      throw new Error("There is no pending review to discard.");
    }
    await this.graphql(GITHUB_DELETE_PENDING_REVIEW_MUTATION, {
      reviewId: context.pendingReview.id,
    });
    return this.getPullRequest(nameWithOwner, cwd, pullRequestNumber);
  }

  async setPullRequestThreadResolved(
    nameWithOwner: string,
    cwd: string,
    pullRequestNumber: number,
    threadId: string,
    resolved: boolean,
  ): Promise<GithubPullRequestDetail> {
    await this.verifyWorktree(cwd);
    const context = await this.pullRequestReviewContext(
      nameWithOwner,
      pullRequestNumber,
    );
    if (!context.reviewThreads.some((thread) => thread.id === threadId)) {
      throw new Error(
        "The review thread does not belong to this pull request.",
      );
    }
    await this.graphql(
      resolved
        ? GITHUB_SET_REVIEW_THREAD_RESOLVED_MUTATION
        : GITHUB_SET_REVIEW_THREAD_UNRESOLVED_MUTATION,
      { threadId },
    );
    return this.getPullRequest(nameWithOwner, cwd, pullRequestNumber);
  }

  async setPullRequestFileViewed(
    nameWithOwner: string,
    cwd: string,
    pullRequestNumber: number,
    filePath: string,
    viewed: boolean,
  ): Promise<GithubPullRequestDetail> {
    await this.verifyWorktree(cwd);
    const context = await this.pullRequestReviewContext(
      nameWithOwner,
      pullRequestNumber,
    );
    await this.graphql(
      viewed
        ? GITHUB_MARK_FILE_VIEWED_MUTATION
        : GITHUB_UNMARK_FILE_VIEWED_MUTATION,
      { pullRequestId: context.nodeId, path: filePath },
    );
    return this.getPullRequest(nameWithOwner, cwd, pullRequestNumber);
  }

  async updatePullRequestDetails(
    nameWithOwner: string,
    cwd: string,
    pullRequestNumber: number,
    details: Extract<
      GithubPullRequestReviewAction,
      { type: "update-details" }
    >["details"],
  ): Promise<GithubPullRequestDetail> {
    await this.verifyWorktree(cwd);
    const repositoryPath = this.repositoryApiPath(nameWithOwner);
    const pullRequestPath = `${repositoryPath}/pulls/${pullRequestNumber}`;
    const current = await this.getPullRequestOverview(
      nameWithOwner,
      cwd,
      pullRequestNumber,
    );
    await this.api(pullRequestPath, [
      "--method",
      "PATCH",
      "-f",
      `title=${details.title}`,
      "-f",
      `body=${details.body}`,
    ]);

    const nextLabels = new Set(details.labels);
    const currentLabels = new Set(current.labels.map((label) => label.name));
    const addedLabels = [...nextLabels].filter(
      (label) => !currentLabels.has(label),
    );
    if (addedLabels.length > 0) {
      await this.api(`${repositoryPath}/issues/${pullRequestNumber}/labels`, [
        "--method",
        "POST",
        ...addedLabels.flatMap((label) => ["-f", `labels[]=${label}`]),
      ]);
    }
    for (const label of currentLabels) {
      if (!nextLabels.has(label)) {
        await this.api(
          `${repositoryPath}/issues/${pullRequestNumber}/labels/${encodeURIComponent(label)}`,
          ["--method", "DELETE"],
        );
      }
    }

    const nextReviewers = new Set(details.reviewers);
    const currentReviewers = new Set(current.requestedReviewers);
    const addedReviewers = [...nextReviewers].filter(
      (reviewer) => !currentReviewers.has(reviewer),
    );
    const removedReviewers = [...currentReviewers].filter(
      (reviewer) => !nextReviewers.has(reviewer),
    );
    if (addedReviewers.length > 0) {
      await this.api(`${pullRequestPath}/requested_reviewers`, [
        "--method",
        "POST",
        ...addedReviewers.flatMap((reviewer) => [
          "-f",
          `reviewers[]=${reviewer}`,
        ]),
      ]);
    }
    if (removedReviewers.length > 0) {
      await this.api(`${pullRequestPath}/requested_reviewers`, [
        "--method",
        "DELETE",
        ...removedReviewers.flatMap((reviewer) => [
          "-f",
          `reviewers[]=${reviewer}`,
        ]),
      ]);
    }
    return this.getPullRequest(nameWithOwner, cwd, pullRequestNumber);
  }

  async runPullRequestReviewAction(
    nameWithOwner: string,
    cwd: string,
    pullRequestNumber: number,
    action: GithubPullRequestReviewAction,
  ): Promise<GithubPullRequestDetail> {
    switch (action.type) {
      case "comment":
        return this.commentOnPullRequest(
          nameWithOwner,
          cwd,
          pullRequestNumber,
          action.body,
        );
      case "submit-review":
        return this.submitPullRequestReview(
          nameWithOwner,
          cwd,
          pullRequestNumber,
          action.review,
        );
      case "inline-comment":
        return this.commentOnPullRequestLine(
          nameWithOwner,
          cwd,
          pullRequestNumber,
          action.comment,
        );
      case "reply":
        return this.replyToPullRequestReview(
          nameWithOwner,
          cwd,
          pullRequestNumber,
          action.commentId,
          action.body,
        );
      case "discard-review":
        return this.discardPullRequestReview(
          nameWithOwner,
          cwd,
          pullRequestNumber,
        );
      case "set-thread-resolved":
        return this.setPullRequestThreadResolved(
          nameWithOwner,
          cwd,
          pullRequestNumber,
          action.threadId,
          action.resolved,
        );
      case "set-file-viewed":
        return this.setPullRequestFileViewed(
          nameWithOwner,
          cwd,
          pullRequestNumber,
          action.path,
          action.viewed,
        );
      case "update-details":
        return this.updatePullRequestDetails(
          nameWithOwner,
          cwd,
          pullRequestNumber,
          action.details,
        );
    }
  }

  async replyToPullRequestReview(
    nameWithOwner: string,
    cwd: string,
    pullRequestNumber: number,
    commentId: number,
    body: string,
  ): Promise<GithubPullRequestDetail> {
    await this.verifyWorktree(cwd);
    await this.api(
      `${this.repositoryApiPath(nameWithOwner)}/pulls/${pullRequestNumber}/comments/${commentId}/replies`,
      ["--method", "POST", "-f", `body=${body}`],
    );
    return this.getPullRequest(nameWithOwner, cwd, pullRequestNumber);
  }

  async previewPullRequestLifecycle(
    nameWithOwner: string,
    cwd: string,
    pullRequestNumber: number,
    action: GithubPullRequestLifecycleAction,
  ): Promise<GithubPullRequestLifecyclePreview> {
    const detail = await this.getPullRequest(
      nameWithOwner,
      cwd,
      pullRequestNumber,
    );
    const warnings: string[] = [];
    let destructive = false;
    let confirmationPhrase: string | null = null;
    switch (action.type) {
      case "close":
        if (detail.state !== "open" || detail.merged) {
          throw new Error("Only an open, unmerged pull request can be closed.");
        }
        destructive = true;
        confirmationPhrase = `close #${detail.number}`;
        warnings.push(
          `This closes #${detail.number} without merging ${detail.headRef} into ${detail.baseRef}.`,
        );
        break;
      case "reopen":
        if (detail.state !== "closed" || detail.merged) {
          throw new Error(
            "Only a closed, unmerged pull request can be reopened.",
          );
        }
        break;
      case "mark-ready":
        if (detail.state !== "open" || !detail.draft || detail.merged) {
          throw new Error(
            "Only an open draft pull request can be marked ready.",
          );
        }
        warnings.push(
          "GitHub will notify requested reviewers that this draft is ready for review.",
        );
        break;
      case "convert-draft":
        warnings.push(
          "Requested reviewers will no longer be expected to review this pull request until it is marked ready again.",
        );
        break;
      case "update-branch":
        warnings.push(
          `GitHub will update ${detail.headRef} with the latest changes from ${detail.baseRef} and may run checks again.`,
        );
        break;
      case "merge":
        if (detail.state !== "open" || detail.draft || detail.merged) {
          throw new Error(
            "Only an open, non-draft pull request can be merged.",
          );
        }
        if (detail.mergeable === null) {
          throw new Error(
            "GitHub is still calculating mergeability. Refresh and try again.",
          );
        }
        if (!detail.mergeable) {
          throw new Error(
            `GitHub reports this pull request is not mergeable (${detail.mergeableState}).`,
          );
        }
        destructive = true;
        confirmationPhrase = `${action.method} #${detail.number}`;
        warnings.push(
          `${action.method} will integrate ${detail.headRef} (${detail.headSha.slice(0, 7)}) into ${detail.baseRef} at ${detail.baseSha.slice(0, 7)}.`,
        );
        if (detail.checksState !== "success" && detail.checksState !== "none") {
          warnings.push(`Checks currently report ${detail.checksState}.`);
        }
        if (detail.reviewDecision === "changes-requested") {
          warnings.push("At least one latest review requests changes.");
        } else if (detail.reviewDecision === "review-required") {
          warnings.push("Requested reviews are still outstanding.");
        }
        break;
      case "enable-auto-merge":
        destructive = true;
        confirmationPhrase = `auto-merge #${detail.number}`;
        warnings.push(
          `GitHub will ${action.method} this pull request automatically once repository requirements are satisfied.`,
        );
        break;
      case "disable-auto-merge":
        break;
      case "enqueue-merge-queue":
        destructive = true;
        confirmationPhrase = `queue #${detail.number}`;
        warnings.push(
          "The pull request will merge when it reaches the front of GitHub's merge queue and required checks pass.",
        );
        break;
      case "dequeue-merge-queue":
        warnings.push(
          "Removing this pull request from the merge queue may discard its current queue position.",
        );
        break;
    }
    return githubPullRequestLifecyclePreviewSchema.parse({
      action,
      number: detail.number,
      title: detail.title,
      state: detail.state,
      draft: detail.draft,
      headRef: detail.headRef,
      headSha: detail.headSha,
      baseRef: detail.baseRef,
      baseSha: detail.baseSha,
      mergeable: detail.mergeable,
      mergeableState: detail.mergeableState,
      checksState: detail.checksState,
      reviewDecision: detail.reviewDecision,
      destructive,
      confirmationPhrase,
      warnings,
      token: pullRequestLifecycleToken(detail, action),
    });
  }

  async applyPullRequestLifecycle(
    nameWithOwner: string,
    cwd: string,
    pullRequestNumber: number,
    request: GithubPullRequestLifecycleApply,
  ): Promise<GithubPullRequestDetail> {
    const preview = await this.previewPullRequestLifecycle(
      nameWithOwner,
      cwd,
      pullRequestNumber,
      request.action,
    );
    if (preview.token !== request.token) {
      throw new Error(
        "The pull request no longer matches this preview. Review the action again.",
      );
    }
    if (
      preview.confirmationPhrase !== null &&
      request.confirmation !== preview.confirmationPhrase
    ) {
      throw new Error(
        `Type ${preview.confirmationPhrase} to confirm this action.`,
      );
    }
    const pullRequestPath = `${this.repositoryApiPath(nameWithOwner)}/pulls/${pullRequestNumber}`;
    switch (request.action.type) {
      case "close":
        await this.api(pullRequestPath, [
          "--method",
          "PATCH",
          "-f",
          "state=closed",
        ]);
        break;
      case "reopen":
        await this.api(pullRequestPath, [
          "--method",
          "PATCH",
          "-f",
          "state=open",
        ]);
        break;
      case "mark-ready":
        await execFileAsync(
          "gh",
          ["pr", "ready", String(pullRequestNumber), "--repo", nameWithOwner],
          { maxBuffer: 4 * 1024 * 1024 },
        );
        break;
      case "convert-draft": {
        const context = await this.pullRequestReviewContext(
          nameWithOwner,
          pullRequestNumber,
        );
        await this.graphql(GITHUB_CONVERT_PULL_REQUEST_TO_DRAFT_MUTATION, {
          pullRequestId: context.nodeId,
        });
        break;
      }
      case "update-branch":
        await this.api(`${pullRequestPath}/update-branch`, [
          "--method",
          "PUT",
          "-f",
          `expected_head_sha=${preview.headSha}`,
        ]);
        break;
      case "merge": {
        const args = [
          "--method",
          "PUT",
          "-f",
          `merge_method=${request.action.method}`,
          "-f",
          `sha=${preview.headSha}`,
        ];
        if (request.action.commitTitle) {
          args.push("-f", `commit_title=${request.action.commitTitle}`);
        }
        if (request.action.commitMessage) {
          args.push("-f", `commit_message=${request.action.commitMessage}`);
        }
        const response = (await this.api(`${pullRequestPath}/merge`, args)) as {
          merged?: unknown;
          message?: unknown;
        };
        if (response.merged !== true) {
          throw new Error(
            typeof response.message === "string"
              ? response.message
              : "GitHub did not merge the pull request.",
          );
        }
        break;
      }
      case "enable-auto-merge": {
        const context = await this.pullRequestReviewContext(
          nameWithOwner,
          pullRequestNumber,
        );
        await this.graphql(GITHUB_ENABLE_AUTO_MERGE_MUTATION, {
          pullRequestId: context.nodeId,
          head: preview.headSha,
          method: request.action.method.toUpperCase(),
          title: request.action.commitTitle,
          body: request.action.commitMessage,
        });
        break;
      }
      case "disable-auto-merge": {
        const context = await this.pullRequestReviewContext(
          nameWithOwner,
          pullRequestNumber,
        );
        await this.graphql(GITHUB_DISABLE_AUTO_MERGE_MUTATION, {
          pullRequestId: context.nodeId,
        });
        break;
      }
      case "enqueue-merge-queue": {
        const context = await this.pullRequestReviewContext(
          nameWithOwner,
          pullRequestNumber,
        );
        await this.graphql(GITHUB_ENQUEUE_PULL_REQUEST_MUTATION, {
          pullRequestId: context.nodeId,
          head: preview.headSha,
        });
        break;
      }
      case "dequeue-merge-queue": {
        const context = await this.pullRequestReviewContext(
          nameWithOwner,
          pullRequestNumber,
        );
        await this.graphql(GITHUB_DEQUEUE_PULL_REQUEST_MUTATION, {
          pullRequestId: context.nodeId,
        });
        break;
      }
    }
    return this.getPullRequest(nameWithOwner, cwd, pullRequestNumber);
  }

  async listActionsOverview(
    nameWithOwner: string,
    cwd: string,
    page = 1,
    limit = 50,
  ): Promise<GithubActionsOverview> {
    await this.verifyWorktree(cwd);
    const repositoryPath = this.repositoryApiPath(nameWithOwner);
    const [rawWorkflows, rawRuns] = await Promise.all([
      this.api(`${repositoryPath}/actions/workflows`, [
        "--method",
        "GET",
        "-f",
        "per_page=100",
      ]) as Promise<GithubApiActionsWorkflowList>,
      this.api(`${repositoryPath}/actions/runs`, [
        "--method",
        "GET",
        "-f",
        `per_page=${limit}`,
        "-f",
        `page=${page}`,
      ]) as Promise<GithubApiActionsRunList>,
    ]);
    const warnings: string[] = [];
    let runners: GithubApiActionsRunner[] = [];
    let runnerAccess: "available" | "unavailable" = "available";
    try {
      const rawRunners = (await this.api(`${repositoryPath}/actions/runners`, [
        "--method",
        "GET",
        "-f",
        "per_page=100",
      ])) as GithubApiActionsRunnerList;
      runners = Array.isArray(rawRunners.runners)
        ? (rawRunners.runners as GithubApiActionsRunner[])
        : [];
      if (Number(rawRunners.total_count) > runners.length) {
        warnings.push(
          "Only the first 100 repository self-hosted runners are shown.",
        );
      }
    } catch {
      runnerAccess = "unavailable";
      warnings.push(
        "GitHub requires repository administration access to list self-hosted runners.",
      );
    }
    const workflows = Array.isArray(rawWorkflows.workflows)
      ? (rawWorkflows.workflows as GithubApiActionsWorkflow[])
      : [];
    const runs = Array.isArray(rawRuns.workflow_runs)
      ? (rawRuns.workflow_runs as GithubApiActionsRun[])
      : [];
    const totalRunCount = Number(rawRuns.total_count) || runs.length;
    return githubActionsOverviewSchema.parse({
      workflows: workflows.slice(0, 100).map(parseActionsWorkflow),
      workflowsTruncated:
        Number(rawWorkflows.total_count) > 100 || workflows.length > 100,
      runs: runs.slice(0, limit).map(parseActionsRun),
      totalRunCount,
      nextPage: page * limit < totalRunCount ? page + 1 : null,
      runners: runners.slice(0, 100).map(parseActionsRunner),
      runnerAccess,
      warnings,
    });
  }

  async getActionsRun(
    nameWithOwner: string,
    cwd: string,
    runId: number,
  ): Promise<GithubActionsRunDetail> {
    await this.verifyWorktree(cwd);
    const repositoryPath = this.repositoryApiPath(nameWithOwner);
    const rawRun = (await this.api(
      `${repositoryPath}/actions/runs/${runId}`,
    )) as GithubApiActionsRun;
    const [jobsResult, artifactsResult] = await Promise.allSettled([
      this.api(`${repositoryPath}/actions/runs/${runId}/jobs`, [
        "--method",
        "GET",
        "-f",
        "per_page=100",
      ]) as Promise<GithubApiActionsJobList>,
      this.api(`${repositoryPath}/actions/runs/${runId}/artifacts`, [
        "--method",
        "GET",
        "-f",
        "per_page=100",
      ]) as Promise<GithubApiActionsArtifactList>,
    ]);
    const warnings: string[] = [];
    const rawJobs =
      jobsResult.status === "fulfilled" && Array.isArray(jobsResult.value.jobs)
        ? (jobsResult.value.jobs as GithubApiActionsJob[])
        : [];
    const rawArtifacts =
      artifactsResult.status === "fulfilled" &&
      Array.isArray(artifactsResult.value.artifacts)
        ? (artifactsResult.value.artifacts as GithubApiActionsArtifact[])
        : [];
    if (jobsResult.status === "rejected") {
      warnings.push(
        `Jobs could not be loaded: ${(jobsResult.reason as Error).message}`.slice(
          0,
          2_000,
        ),
      );
    }
    if (artifactsResult.status === "rejected") {
      warnings.push(
        `Artifacts could not be loaded: ${(artifactsResult.reason as Error).message}`.slice(
          0,
          2_000,
        ),
      );
    }
    return githubActionsRunDetailSchema.parse({
      run: parseActionsRun(rawRun),
      jobs: rawJobs.slice(0, 100).map(parseActionsJob),
      jobsTruncated:
        jobsResult.status === "fulfilled" &&
        (Number(jobsResult.value.total_count) > 100 || rawJobs.length > 100),
      artifacts: rawArtifacts.slice(0, 100).map((artifact) => {
        const id = Number(artifact.id);
        const name = String(artifact.name || "Artifact");
        return githubActionsArtifactSchema.parse({
          id,
          name,
          sizeInBytes: Number(artifact.size_in_bytes) || 0,
          expired: artifact.expired === true,
          createdAt: String(artifact.created_at),
          expiresAt: String(artifact.expires_at),
          url: `https://github.com/${nameWithOwner}/actions/runs/${runId}/artifacts/${id}`,
          testReport:
            /(?:^|[-_. ])(?:test|tests|junit|coverage|playwright|cypress|report)(?:$|[-_. ])/iu.test(
              name,
            ),
        });
      }),
      artifactsTruncated:
        artifactsResult.status === "fulfilled" &&
        (Number(artifactsResult.value.total_count) > 100 ||
          rawArtifacts.length > 100),
      warnings,
    });
  }

  async readActionsRunLogs(
    nameWithOwner: string,
    cwd: string,
    runId: number,
    jobId: number | null,
  ): Promise<GithubActionsRunLogs> {
    await this.verifyWorktree(cwd);
    const args = [
      "run",
      "view",
      String(runId),
      "--repo",
      nameWithOwner,
      ...(jobId ? ["--job", String(jobId)] : []),
      "--log",
    ];
    let available = true;
    let raw = "";
    try {
      raw = (
        await execFileAsync("gh", args, {
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
          timeout: 30_000,
        })
      ).stdout;
    } catch (error) {
      available = false;
      const commandError = error as Error & {
        stderr?: string;
        stdout?: string;
      };
      raw =
        [commandError.stdout, commandError.stderr]
          .filter((value): value is string => typeof value === "string")
          .join("\n") || commandError.message;
    }
    const normalized = raw.replace(
      // eslint-disable-next-line no-control-regex
      /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu,
      "",
    );
    const limit = 1_000_000;
    return githubActionsRunLogsSchema.parse({
      runId,
      jobId,
      available,
      text:
        normalized.length > limit
          ? normalized.slice(normalized.length - limit)
          : normalized,
      truncated: normalized.length > limit,
      updatedAt: new Date().toISOString(),
    });
  }

  async dispatchActionsWorkflow(
    nameWithOwner: string,
    cwd: string,
    input: GithubActionsWorkflowDispatch,
  ): Promise<GithubActionsMutationResult> {
    await this.verifyWorktree(cwd);
    const request = githubActionsWorkflowDispatchSchema.parse(input);
    const fields = Object.entries(request.inputs).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    await this.apiVoid(
      `${this.repositoryApiPath(nameWithOwner)}/actions/workflows/${request.workflowId}/dispatches`,
      [
        "--method",
        "POST",
        "-f",
        `ref=${request.ref}`,
        ...fields.flatMap(([key, value]) => ["-f", `inputs[${key}]=${value}`]),
      ],
    );
    return githubActionsMutationResultSchema.parse({
      accepted: true,
      runId: null,
      workflowId: request.workflowId,
      action: "dispatch",
      acceptedAt: new Date().toISOString(),
    });
  }

  async runActionsRunAction(
    nameWithOwner: string,
    cwd: string,
    input: GithubActionsRunAction,
  ): Promise<GithubActionsMutationResult> {
    await this.verifyWorktree(cwd);
    const request = githubActionsRunActionSchema.parse(input);
    const endpoint =
      request.action === "cancel"
        ? "cancel"
        : request.action === "rerun-failed"
          ? "rerun-failed-jobs"
          : "rerun";
    await this.apiVoid(
      `${this.repositoryApiPath(nameWithOwner)}/actions/runs/${request.runId}/${endpoint}`,
      ["--method", "POST"],
    );
    return githubActionsMutationResultSchema.parse({
      accepted: true,
      runId: request.runId,
      workflowId: null,
      action: request.action,
      acceptedAt: new Date().toISOString(),
    });
  }

  async prepareActionsRunCheckout(
    nameWithOwner: string,
    cwd: string,
    runId: number,
  ): Promise<GithubActionsRunCheckoutPrepared> {
    await this.verifyWorktree(cwd);
    const rawRun = (await this.api(
      `${this.repositoryApiPath(nameWithOwner)}/actions/runs/${runId}`,
    )) as GithubApiActionsRun;
    const run = parseActionsRun(rawRun);
    const expectedRepository = nameWithOwner.toLowerCase();
    const { stdout: remoteOutput } = await execFileAsync("git", [
      "-C",
      cwd,
      "remote",
    ]);
    const remoteNames = remoteOutput
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
    const matches: string[] = [];
    for (const remoteName of remoteNames) {
      const { stdout } = await execFileAsync("git", [
        "-C",
        cwd,
        "remote",
        "get-url",
        remoteName,
      ]);
      if (githubRepositoryFromRemoteUrl(stdout) === expectedRepository) {
        matches.push(remoteName);
      }
    }
    const remote = matches.includes("origin") ? "origin" : matches[0];
    if (!remote) {
      throw new Error(
        `No Git remote in this project points to ${nameWithOwner}. Add the GitHub repository as a remote before creating a run worktree.`,
      );
    }
    const hasCommit = async () =>
      Boolean(await resolveGitCommit(cwd, run.headSha));
    if (!(await hasCommit())) {
      const refspecs = [
        run.headSha,
        ...(run.pullRequestNumber
          ? [`refs/pull/${run.pullRequestNumber}/head`]
          : []),
        ...(run.headBranch ? [`refs/heads/${run.headBranch}`] : []),
      ];
      let lastError: unknown = null;
      for (const refspec of [...new Set(refspecs)]) {
        try {
          await execFileAsync("git", [
            "-C",
            cwd,
            "fetch",
            "--no-tags",
            "--",
            remote,
            refspec,
          ]);
          if (await hasCommit()) break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!(await hasCommit())) {
        throw new Error(
          `Git could not fetch the exact workflow run commit ${run.headSha.slice(0, 12)}: ${lastError instanceof Error ? lastError.message : "the commit is unavailable from this repository"}`,
        );
      }
    }
    return githubActionsRunCheckoutPreparedSchema.parse({
      run,
      ...actionsRunCheckoutIdentity(run),
      headSha: run.headSha,
      remote,
    });
  }

  async listReleases(nameWithOwner: string): Promise<GithubReleaseList> {
    const values = (await this.api(
      `${this.repositoryApiPath(nameWithOwner)}/releases`,
      ["--method", "GET", "-f", "per_page=100", "-f", "page=1"],
    )) as GithubApiRelease[];
    return githubReleaseListSchema.parse({
      releases: values.map(parseRelease),
      truncated: values.length >= 100,
    });
  }

  async getRelease(
    nameWithOwner: string,
    releaseId: number,
  ): Promise<GithubReleaseSummary> {
    return parseRelease(
      (await this.api(
        `${this.repositoryApiPath(nameWithOwner)}/releases/${releaseId}`,
      )) as GithubApiRelease,
    );
  }

  async createRelease(
    nameWithOwner: string,
    cwd: string,
    request: GithubReleaseCreate,
  ): Promise<GithubReleaseSummary> {
    let targetCommitish: string;
    try {
      targetCommitish = (
        await execFileAsync("git", [
          "-C",
          cwd,
          "rev-parse",
          "--verify",
          `refs/tags/${request.tagName}^{commit}`,
        ])
      ).stdout.trim();
    } catch {
      targetCommitish = (
        await execFileAsync("git", [
          "-C",
          cwd,
          "rev-parse",
          "--verify",
          "HEAD^{commit}",
        ])
      ).stdout.trim();
    }
    return parseRelease(
      (await this.api(`${this.repositoryApiPath(nameWithOwner)}/releases`, [
        "--method",
        "POST",
        "-f",
        `tag_name=${request.tagName}`,
        "-f",
        `target_commitish=${targetCommitish}`,
        "-f",
        `name=${request.name}`,
        "-f",
        `body=${request.body}`,
        "-F",
        `draft=${request.draft}`,
        "-F",
        `prerelease=${request.prerelease}`,
      ])) as GithubApiRelease,
    );
  }

  async cloneRepository(nameWithOwner: string): Promise<ProjectCloneResult> {
    const jobId = randomUUID();
    const provisioned = await this.provisionReplica({
      jobId,
      attempt: 1,
      projectId: jobId,
      nameWithOwner,
      placement: { mode: "managed" },
      workspaceStorage: { kind: "system" },
      expectedRevision: null,
    });
    if (provisioned.status === "blocked") {
      throw new Error(
        `Repository provisioning failed with code ${provisioned.error.code}.`,
      );
    }
    return projectCloneResultSchema.parse({
      path: provisioned.path,
      displayPath: provisioned.displayPath,
      reused: provisioned.reused,
      updated: false,
      warning: null,
      worktreePolicy: provisioned.worktreePolicy,
    });
  }

  async provisionReplica(
    input: {
      jobId: string;
      attempt: number;
      projectId?: string;
      nameWithOwner: string | null;
      placement?: ProjectReplicaPlacementRequest;
      workspaceStorage?: ProjectWorkspaceStorageContext;
      expectedRevision: string | null;
    },
    reportProgress: (progress: ProjectReplicaJobProgressEvent) => void = () =>
      undefined,
  ): Promise<ProjectReplicaProvisionResult> {
    const normalizedInput = {
      ...input,
      projectId: input.projectId ?? input.jobId,
      placement: input.placement ?? ({ mode: "managed" } as const),
      workspaceStorage: input.workspaceStorage ?? ({ kind: "system" } as const),
    };
    const repositoryIdentity = input.nameWithOwner
      ? repositorySegments(input.nameWithOwner)
      : null;
    const queueTarget =
      normalizedInput.placement.mode === "direct"
        ? normalizedInput.placement.path
        : repositoryIdentity
          ? deriveManagedRepositoryTarget(
              this.dataDirectory,
              normalizedInput.workspaceStorage,
              repositoryIdentity[0],
              repositoryIdentity[1],
            )
          : `invalid-local-git:${normalizedInput.jobId}`;
    const previous =
      this.replicaOperationQueues.get(queueTarget) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.replicaOperationQueues.set(queueTarget, queued);
    await previous.catch(() => undefined);
    try {
      return await this.provisionReplicaUnlocked(
        normalizedInput,
        reportProgress,
      );
    } finally {
      release();
      if (this.replicaOperationQueues.get(queueTarget) === queued) {
        this.replicaOperationQueues.delete(queueTarget);
      }
    }
  }

  private async provisionReplicaUnlocked(
    input: {
      jobId: string;
      attempt: number;
      projectId: string;
      nameWithOwner: string | null;
      placement: ProjectReplicaPlacementRequest;
      workspaceStorage: ProjectWorkspaceStorageContext;
      expectedRevision: string | null;
    },
    reportProgress: (progress: ProjectReplicaJobProgressEvent) => void,
  ): Promise<ProjectReplicaProvisionResult> {
    const repositoryIdentity = input.nameWithOwner
      ? repositorySegments(input.nameWithOwner)
      : null;
    const blocked = (
      code: ProjectReplicaJobErrorCode,
      message: string,
      retryable: boolean,
    ): ProjectReplicaProvisionResult =>
      projectReplicaProvisionResultSchema.parse({
        status: "blocked",
        jobId: input.jobId,
        attempt: input.attempt,
        error: { code, message: message.slice(0, 4_000), retryable },
      });
    const blockedFromPlacementError = (
      error: ProjectReplicaPlacementError,
    ): ProjectReplicaProvisionResult =>
      blocked(error.code, error.message, error.retryable);

    reportProgress({
      stage:
        input.placement.mode === "managed"
          ? "validating"
          : "validating-placement",
      percent: 10,
    });
    if (!repositoryIdentity && input.placement.mode !== "direct") {
      return blocked(
        "policy-denied",
        "Local Git sources can only attach an existing checkout at an explicit worker path.",
        false,
      );
    }
    if (!repositoryIdentity && !input.expectedRevision) {
      return blocked(
        "target-revision-mismatch",
        "Local Git source attachment requires a current project revision for compatibility verification.",
        false,
      );
    }
    let prepared;
    try {
      const managedTarget =
        input.placement.mode === "direct"
          ? input.placement.path
          : input.workspaceStorage.kind === "managed"
            ? path.join(
                await ensureManagedWorkspaceDirectory(
                  this.dataDirectory,
                  input.workspaceStorage,
                  ["repositories", repositoryIdentity![0]],
                ),
                repositoryIdentity![1],
              )
            : deriveManagedRepositoryTarget(
                this.dataDirectory,
                input.workspaceStorage,
                repositoryIdentity![0],
                repositoryIdentity![1],
              );
      prepared = await this.placementManager.prepare({
        jobId: input.jobId,
        managedTarget,
        placement: input.placement,
        projectId: input.projectId,
      });
    } catch (error) {
      if (error instanceof ProjectReplicaPlacementError) {
        return blockedFromPlacementError(error);
      }
      throw error;
    }

    const target = prepared.targetPath;
    let materialization: "attached" | "cloned" | "reused" = prepared.exists
      ? "reused"
      : "cloned";
    let ownership: "cantrip" | "user" = "cantrip";
    let directCommonDir: string | null = null;
    let directFingerprint: string | null = null;

    if (prepared.exists && prepared.mode === "direct") {
      reportProgress({
        stage: "inspecting-existing-checkout",
        percent: 35,
      });
      try {
        const topLevel = (
          await execFileAsync(
            "git",
            ["-C", target, "rev-parse", "--show-toplevel"],
            { maxBuffer: 1024 * 1024 },
          )
        ).stdout.trim();
        const canonicalTopLevel = await realpath(topLevel);
        if (canonicalTopLevel !== target) {
          return blocked(
            "target-repository-mismatch",
            "The requested target is not the root of its Git checkout.",
            false,
          );
        }
        const isBare = (
          await execFileAsync(
            "git",
            ["-C", target, "rev-parse", "--is-bare-repository"],
            { maxBuffer: 1024 * 1024 },
          )
        ).stdout.trim();
        if (isBare !== "false") {
          return blocked(
            "target-repository-mismatch",
            "Bare Git repositories cannot be attached as a project checkout.",
            false,
          );
        }
        if (input.nameWithOwner) {
          const origin = (
            await execFileAsync(
              "git",
              ["-C", target, "config", "--get", "remote.origin.url"],
              { maxBuffer: 1024 * 1024 },
            )
          ).stdout.trim();
          if (
            githubRepositoryFromRemoteUrl(origin) !==
            input.nameWithOwner.toLowerCase()
          ) {
            return blocked(
              "target-repository-mismatch",
              "The requested checkout belongs to a different GitHub repository.",
              false,
            );
          }
        }
        const gitDirOutput = (
          await execFileAsync("git", ["-C", target, "rev-parse", "--git-dir"], {
            maxBuffer: 1024 * 1024,
          })
        ).stdout.trim();
        const commonDirOutput = (
          await execFileAsync(
            "git",
            ["-C", target, "rev-parse", "--git-common-dir"],
            { maxBuffer: 1024 * 1024 },
          )
        ).stdout.trim();
        const gitDir = await realpath(
          path.isAbsolute(gitDirOutput)
            ? gitDirOutput
            : path.resolve(target, gitDirOutput),
        );
        directCommonDir = await realpath(
          path.isAbsolute(commonDirOutput)
            ? commonDirOutput
            : path.resolve(target, commonDirOutput),
        );
        if (gitDir !== directCommonDir) {
          return blocked(
            "target-not-primary-worktree",
            "Only the repository's Primary worktree can be attached.",
            false,
          );
        }
        const currentRevision = await resolveGitCommit(target, "HEAD");
        if (
          input.expectedRevision &&
          currentRevision !== input.expectedRevision.toLowerCase()
        ) {
          return blocked(
            "target-revision-mismatch",
            "The existing checkout is not at the requested immutable revision.",
            false,
          );
        }
        if (input.expectedRevision && input.nameWithOwner) {
          const status = (
            await execFileAsync(
              "git",
              [
                "-C",
                target,
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
              ],
              { maxBuffer: 4 * 1024 * 1024 },
            )
          ).stdout.trim();
          if (status) {
            return blocked(
              "worktree-dirty",
              "An exact-revision replica can attach only to a clean checkout.",
              false,
            );
          }
        }
        directFingerprint = createHash("sha256")
          .update(directCommonDir)
          .digest("hex");
        ownership = await this.placementManager.classifyExisting({
          canonicalPath: target,
          gitCommonDir: directCommonDir,
          projectId: input.projectId,
          repositoryFingerprint: directFingerprint,
        });
        materialization = ownership === "cantrip" ? "reused" : "attached";
      } catch (error) {
        if (error instanceof ProjectReplicaPlacementError) {
          return blockedFromPlacementError(error);
        }
        return blocked(
          "target-repository-mismatch",
          "The requested target is not an attachable Git checkout.",
          false,
        );
      }
    } else if (prepared.exists) {
      if (!input.nameWithOwner) {
        return blocked(
          "policy-denied",
          "Local Git repositories can only be attached through direct placement.",
          false,
        );
      }
      let origin: string;
      try {
        origin = (
          await execFileAsync(
            "git",
            ["-C", target, "remote", "get-url", "origin"],
            { maxBuffer: 1024 * 1024 },
          )
        ).stdout.trim();
      } catch {
        return blocked(
          "target-mismatch",
          "The managed replica path exists but is not a Git repository with an origin remote.",
          false,
        );
      }
      const normalizedOrigin = origin
        .replace(/\.git$/u, "")
        .replaceAll("\\", "/")
        .toLowerCase();
      const expectedSuffix = input.nameWithOwner.toLowerCase();
      if (
        !normalizedOrigin.endsWith(`/${expectedSuffix}`) &&
        !normalizedOrigin.endsWith(`:${expectedSuffix}`)
      ) {
        return blocked(
          "target-mismatch",
          `The managed replica path points at a different origin: ${origin}`,
          false,
        );
      }
      reportProgress({
        stage: "fetching",
        percent: 35,
      });
      try {
        await execFileAsync(
          "git",
          ["-C", target, "fetch", "origin", "--prune"],
          { maxBuffer: 32 * 1024 * 1024 },
        );
      } catch (error) {
        return blocked(
          "remote-unavailable",
          `Could not fetch the repository origin: ${(error as Error).message}`,
          true,
        );
      }
      reportProgress({
        stage: "inspecting",
        percent: 55,
      });
      const status = (
        await execFileAsync(
          "git",
          ["-C", target, "status", "--porcelain=v1", "--untracked-files=all"],
          { maxBuffer: 4 * 1024 * 1024 },
        )
      ).stdout.trim();
      if (status) {
        return blocked(
          "worktree-dirty",
          "The existing replica has tracked or untracked changes and was not modified.",
          false,
        );
      }
      let currentRevision = await resolveGitCommit(target, "HEAD");
      if (!currentRevision) {
        if (input.expectedRevision) {
          currentRevision = await resolveGitCommit(
            target,
            input.expectedRevision,
          );
          if (!currentRevision) {
            return blocked(
              "target-not-found",
              `Revision ${input.expectedRevision} is not available from the repository origin.`,
              false,
            );
          }
          await execFileAsync(
            "git",
            ["-C", target, "checkout", "--detach", currentRevision],
            { maxBuffer: 32 * 1024 * 1024 },
          );
        } else {
          currentRevision = await attachUnbornHeadToOrigin(target);
        }
      }
      if (
        input.expectedRevision &&
        currentRevision !== input.expectedRevision.toLowerCase()
      ) {
        return blocked(
          "revision-diverged",
          `The existing replica is at ${currentRevision}; exact revision ${input.expectedRevision} was requested. Synchronization must be requested explicitly.`,
          false,
        );
      }
    } else if (!input.nameWithOwner) {
      return blocked(
        "target-not-found",
        "The local Git checkout does not exist. Cantrip will not clone a local-only project.",
        false,
      );
    } else {
      const staging = prepared.stagingPath;
      reportProgress({
        stage: "materializing",
        percent: 30,
      });
      try {
        if (prepared.mode === "direct") {
          await this.placementManager.claimStaging({
            jobId: input.jobId,
            projectId: input.projectId,
            stagingPath: staging,
          });
        } else {
          await rm(staging, { recursive: true, force: true });
        }
        await cloneGithubRepository(
          input.nameWithOwner,
          staging,
          reportProgress,
        );
        await execFileAsync(
          "git",
          ["-C", staging, "fetch", "origin", "--prune"],
          {
            maxBuffer: 32 * 1024 * 1024,
          },
        );
        if (input.expectedRevision) {
          reportProgress({
            stage: "resolving-revision",
            percent: 88,
          });
          try {
            await execFileAsync(
              "git",
              [
                "-C",
                staging,
                "cat-file",
                "-e",
                `${input.expectedRevision}^{commit}`,
              ],
              { maxBuffer: 1024 * 1024 },
            );
          } catch {
            if (prepared.mode === "direct") {
              await this.placementManager.cleanupStaging({
                jobId: input.jobId,
                projectId: input.projectId,
                stagingPath: staging,
              });
            } else {
              await rm(staging, { recursive: true, force: true });
            }
            return blocked(
              "target-not-found",
              `Revision ${input.expectedRevision} is not available from the repository origin.`,
              false,
            );
          }
          await execFileAsync(
            "git",
            ["-C", staging, "checkout", "--detach", input.expectedRevision],
            { maxBuffer: 32 * 1024 * 1024 },
          );
        } else if (!(await resolveGitCommit(staging, "HEAD"))) {
          await attachUnbornHeadToOrigin(staging);
        }
        if (prepared.mode === "direct") {
          const commonDirOutput = (
            await execFileAsync(
              "git",
              ["-C", staging, "rev-parse", "--git-common-dir"],
              { maxBuffer: 1024 * 1024 },
            )
          ).stdout.trim();
          const stagingCommonDir = await realpath(
            path.isAbsolute(commonDirOutput)
              ? commonDirOutput
              : path.resolve(staging, commonDirOutput),
          );
          const relativeCommonDir = path.relative(staging, stagingCommonDir);
          if (
            !relativeCommonDir ||
            relativeCommonDir === ".." ||
            relativeCommonDir.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relativeCommonDir)
          ) {
            throw new ProjectReplicaPlacementError(
              "ownership-proof-missing",
              "The staged checkout has an unsupported Git common directory.",
            );
          }
          const expectedCommonDir = path.join(target, relativeCommonDir);
          const expectedFingerprint = createHash("sha256")
            .update(expectedCommonDir)
            .digest("hex");
          await this.placementManager.writeCreatedMarker({
            gitCommonDir: stagingCommonDir,
            projectId: input.projectId,
            repositoryFingerprint: expectedFingerprint,
          });
        }
        await rename(staging, target);
        if (prepared.mode === "direct") {
          await this.placementManager.cleanupStaging({
            jobId: input.jobId,
            projectId: input.projectId,
            stagingPath: staging,
          });
        }
      } catch (error) {
        if (prepared.mode === "direct") {
          await this.placementManager
            .cleanupStaging({
              jobId: input.jobId,
              projectId: input.projectId,
              stagingPath: staging,
            })
            .catch(() => undefined);
        } else {
          await rm(staging, { recursive: true, force: true }).catch(
            () => undefined,
          );
        }
        if (error instanceof ProjectReplicaPlacementError) {
          return blockedFromPlacementError(error);
        }
        const detail =
          error instanceof Error ? error.message : "Unknown Git clone failure.";
        const failure = githubCloneFailureDetails(detail);
        return blocked(
          failure.code,
          prepared.mode === "direct" && failure.code === "remote-unavailable"
            ? "Could not clone the repository into the requested worker placement."
            : failure.message,
          true,
        );
      }
    }

    reportProgress({
      stage: "verifying",
      percent: 90,
    });

    const canonicalTarget = await canonicalProjectSourcePath(target);
    const resolvedRevision = await resolveGitCommit(canonicalTarget, "HEAD");
    const branch = (
      await execFileAsync(
        "git",
        ["-C", canonicalTarget, "branch", "--show-current"],
        { maxBuffer: 1024 * 1024 },
      )
    ).stdout.trim();
    const commonDir =
      directCommonDir ??
      (await (async () => {
        const commonDirOutput = (
          await execFileAsync(
            "git",
            ["-C", canonicalTarget, "rev-parse", "--git-common-dir"],
            { maxBuffer: 1024 * 1024 },
          )
        ).stdout.trim();
        return realpath(
          path.isAbsolute(commonDirOutput)
            ? commonDirOutput
            : path.resolve(canonicalTarget, commonDirOutput),
        );
      })());
    const repositoryFingerprint =
      directFingerprint ?? createHash("sha256").update(commonDir).digest("hex");

    if (prepared.mode === "direct") {
      try {
        if (input.nameWithOwner) {
          const configuredOrigin = (
            await execFileAsync(
              "git",
              ["-C", canonicalTarget, "config", "--get", "remote.origin.url"],
              { maxBuffer: 1024 * 1024 },
            )
          ).stdout.trim();
          if (
            githubRepositoryFromRemoteUrl(configuredOrigin) !==
            input.nameWithOwner.toLowerCase()
          ) {
            return blocked(
              "target-repository-mismatch",
              "The materialized checkout belongs to a different GitHub repository.",
              false,
            );
          }
        }
        const topLevel = await realpath(
          (
            await execFileAsync(
              "git",
              ["-C", canonicalTarget, "rev-parse", "--show-toplevel"],
              { maxBuffer: 1024 * 1024 },
            )
          ).stdout.trim(),
        );
        const gitDirOutput = (
          await execFileAsync(
            "git",
            ["-C", canonicalTarget, "rev-parse", "--git-dir"],
            { maxBuffer: 1024 * 1024 },
          )
        ).stdout.trim();
        const gitDir = await realpath(
          path.isAbsolute(gitDirOutput)
            ? gitDirOutput
            : path.resolve(canonicalTarget, gitDirOutput),
        );
        if (topLevel !== canonicalTarget || gitDir !== commonDir) {
          return blocked(
            "target-not-primary-worktree",
            "The materialized checkout is not the repository's Primary worktree.",
            false,
          );
        }
        if (materialization === "cloned") {
          ownership = await this.placementManager.classifyExisting({
            canonicalPath: canonicalTarget,
            gitCommonDir: commonDir,
            projectId: input.projectId,
            repositoryFingerprint,
          });
          if (ownership !== "cantrip") {
            throw new ProjectReplicaPlacementError(
              "ownership-proof-missing",
              "The cloned checkout is missing its Cantrip ownership proof.",
            );
          }
        }
        await this.placementManager.record({
          canonicalPath: canonicalTarget,
          createdAt: new Date().toISOString(),
          linkPath: null,
          mode: "direct",
          ownership,
          projectId: input.projectId,
          repositoryFingerprint,
          requestedPath: prepared.requestedPath!,
        });
      } catch (error) {
        if (error instanceof ProjectReplicaPlacementError) {
          return blockedFromPlacementError(error);
        }
        return blocked(
          "target-repository-mismatch",
          "The materialized checkout could not be verified safely.",
          false,
        );
      }
    }

    if (prepared.mode === "managed-link") {
      try {
        await this.placementManager.materializeManagedLink({
          canonicalPath: canonicalTarget,
          linkPath: prepared.linkPath!,
          projectId: input.projectId,
          repositoryFingerprint,
          requestedPath: prepared.requestedPath!,
        });
      } catch (error) {
        if (error instanceof ProjectReplicaPlacementError) {
          return blockedFromPlacementError(error);
        }
        return blocked(
          "link-unsupported",
          "The managed repository link could not be created safely.",
          false,
        );
      }
    }

    const projectPolicy = await readProjectWorktreePolicy(canonicalTarget);
    return projectReplicaProvisionResultSchema.parse({
      status: "ready",
      jobId: input.jobId,
      attempt: input.attempt,
      path: canonicalTarget,
      displayPath:
        prepared.requestedPath ??
        `${repositoryIdentity![0]}/${repositoryIdentity![1]}`,
      repositoryFingerprint,
      resolvedRevision,
      branch: branch || null,
      reused: materialization !== "cloned",
      placement: {
        mode: prepared.mode,
        materialization,
        ownership,
        canonicalPath: canonicalTarget,
        requestedPath: prepared.requestedPath,
        linkPath: prepared.linkPath,
      },
      worktreePolicy: projectPolicy.policy,
    });
  }

  async synchronizeReplica(
    input: {
      jobId: string;
      attempt: number;
      projectId?: string;
      nameWithOwner: string;
      sourcePath: string;
      placement?: ProjectReplicaPlacementResult;
      repositoryFingerprint?: string;
      expectedRevision: string;
      policy: ProjectReplicaSynchronizationPolicy;
    },
    reportProgress: (progress: ProjectReplicaJobProgressEvent) => void = () =>
      undefined,
  ): Promise<ProjectReplicaSynchronizeResult> {
    const normalizedInput = {
      ...input,
      projectId: input.projectId ?? input.jobId,
    };
    return this.withReplicaOperation(input.sourcePath, () =>
      this.synchronizeReplicaUnlocked(normalizedInput, reportProgress),
    );
  }

  private async synchronizeReplicaUnlocked(
    input: {
      jobId: string;
      attempt: number;
      projectId: string;
      nameWithOwner: string;
      sourcePath: string;
      placement?: ProjectReplicaPlacementResult;
      repositoryFingerprint?: string;
      expectedRevision: string;
      policy: ProjectReplicaSynchronizationPolicy;
    },
    reportProgress: (progress: ProjectReplicaJobProgressEvent) => void,
  ): Promise<ProjectReplicaSynchronizeResult> {
    const blocked = (
      code: ProjectReplicaJobErrorCode,
      message: string,
      retryable: boolean,
    ): ProjectReplicaSynchronizeResult =>
      projectReplicaSynchronizeResultSchema.parse({
        status: "blocked",
        jobId: input.jobId,
        attempt: input.attempt,
        error: { code, message: message.slice(0, 4_000), retryable },
      });

    const placement = input.placement ?? null;
    const placementMode = placement?.mode ?? "managed";
    const customPlacement =
      placementMode === "direct" || placementMode === "managed-link";
    let persistedPlacementPath: string | null;
    let sourceTarget: string;
    try {
      sourceTarget = normalizeProjectSourcePath(input.sourcePath);
      persistedPlacementPath = placement
        ? normalizeProjectSourcePath(placement.canonicalPath)
        : null;
    } catch {
      return blocked(
        "target-not-found",
        "The persisted project source path is not a supported native path.",
        false,
      );
    }
    if (
      persistedPlacementPath &&
      !pathsEqual(persistedPlacementPath, sourceTarget)
    ) {
      return blocked(
        "target-mismatch",
        "The persisted canonical repository path does not match the synchronization target.",
        false,
      );
    }
    if (customPlacement && (!placement || !input.repositoryFingerprint)) {
      return blocked(
        "ownership-proof-missing",
        "Custom repository synchronization requires its persisted placement identity.",
        false,
      );
    }
    reportProgress({
      stage: "validating",
      percent: 10,
    });
    const validation =
      placementMode === "direct"
        ? await this.validateDirectReplica(sourceTarget, input.nameWithOwner)
        : await this.validateManagedReplica(sourceTarget, input.nameWithOwner);
    if (!validation.ok) {
      return blocked(validation.code, validation.message, false);
    }
    const target = validation.path;
    if (customPlacement && placement && input.repositoryFingerprint) {
      const canonicalTarget = await canonicalProjectSourcePath(target);
      const gitCommonDir = await this.gitCommonDirectory(canonicalTarget);
      const repositoryFingerprint = createHash("sha256")
        .update(gitCommonDir)
        .digest("hex");
      if (repositoryFingerprint !== input.repositoryFingerprint) {
        return blocked(
          "ownership-proof-missing",
          "The repository fingerprint no longer matches the persisted project replica.",
          false,
        );
      }
      try {
        await this.placementManager.verifyPlacementOwnership({
          canonicalPath: canonicalTarget,
          gitCommonDir,
          linkPath: placement.linkPath,
          mode: placementMode,
          ownership: placement.ownership,
          projectId: input.projectId,
          repositoryFingerprint,
        });
      } catch (error) {
        if (error instanceof ProjectReplicaPlacementError) {
          return blocked(error.code, error.message, error.retryable);
        }
        throw error;
      }
    }
    reportProgress({
      stage: "fetching",
      percent: 30,
    });
    try {
      await execFileAsync("git", ["-C", target, "fetch", "origin", "--prune"], {
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (error) {
      return blocked(
        "remote-unavailable",
        customPlacement
          ? "Could not fetch the selected worker checkout's repository origin."
          : `Could not fetch the repository origin: ${(error as Error).message}`,
        true,
      );
    }
    reportProgress({
      stage: "inspecting",
      percent: 50,
    });
    const status = (
      await execFileAsync(
        "git",
        ["-C", target, "status", "--porcelain=v1", "--untracked-files=normal"],
        { maxBuffer: 4 * 1024 * 1024 },
      )
    ).stdout.trim();
    if (status) {
      return blocked(
        "worktree-dirty",
        "The replica has tracked or untracked changes and was not modified.",
        false,
      );
    }
    try {
      await execFileAsync("git", [
        "-C",
        target,
        "cat-file",
        "-e",
        `${input.expectedRevision}^{commit}`,
      ]);
    } catch {
      return blocked(
        "target-not-found",
        `Revision ${input.expectedRevision} is not available from the repository origin.`,
        false,
      );
    }
    const remoteContaining = (
      await execFileAsync(
        "git",
        [
          "-C",
          target,
          "for-each-ref",
          "--format=%(refname)",
          "--contains",
          input.expectedRevision,
          "refs/remotes/origin",
        ],
        { maxBuffer: 4 * 1024 * 1024 },
      )
    ).stdout.trim();
    if (!remoteContaining) {
      return blocked(
        "policy-denied",
        "The expected revision is not reachable from a fetched origin reference.",
        false,
      );
    }
    const previousRevision = await this.revisionAt(target, "HEAD");
    const branch = (
      await execFileAsync("git", ["-C", target, "branch", "--show-current"])
    ).stdout.trim();
    if (previousRevision === input.expectedRevision) {
      return projectReplicaSynchronizeResultSchema.parse({
        status: "ready",
        jobId: input.jobId,
        attempt: input.attempt,
        path: target,
        previousRevision,
        resolvedRevision: previousRevision,
        branch: branch || null,
        changed: false,
      });
    }
    if (input.policy === "verify-only") {
      return blocked(
        "revision-diverged",
        `The replica is at ${previousRevision}; verify-only policy did not change it.`,
        false,
      );
    }
    if (!branch) {
      return blocked(
        "policy-denied",
        "Only an attached Primary branch may be fast-forwarded.",
        false,
      );
    }
    const canFastForward = await this.isAncestor(
      target,
      previousRevision,
      input.expectedRevision,
    );
    if (!canFastForward) {
      const aheadOfTarget = await this.isAncestor(
        target,
        input.expectedRevision,
        previousRevision,
      );
      return blocked(
        aheadOfTarget ? "unpushed-commits" : "revision-diverged",
        aheadOfTarget
          ? "The replica contains commits beyond the expected revision and was not changed."
          : "The replica and expected revision have diverged and cannot be fast-forwarded.",
        false,
      );
    }
    reportProgress({
      stage: "fast-forwarding",
      percent: 75,
    });
    await execFileAsync(
      "git",
      ["-C", target, "merge", "--ff-only", input.expectedRevision],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    const resolvedRevision = await this.revisionAt(target, "HEAD");
    const verifiedStatus = (
      await execFileAsync(
        "git",
        ["-C", target, "status", "--porcelain=v1", "--untracked-files=normal"],
        { maxBuffer: 4 * 1024 * 1024 },
      )
    ).stdout.trim();
    if (resolvedRevision !== input.expectedRevision || verifiedStatus) {
      throw new Error(
        "Replica verification failed after the fast-forward operation.",
      );
    }
    return projectReplicaSynchronizeResultSchema.parse({
      status: "ready",
      jobId: input.jobId,
      attempt: input.attempt,
      path: target,
      previousRevision,
      resolvedRevision,
      branch,
      changed: true,
    });
  }

  async repairReplicaLink(input: {
    projectId: string;
    nameWithOwner: string;
    sourcePath: string;
    linkPath: string;
    repositoryFingerprint: string;
  }): Promise<ProjectReplicaLinkRepairResult> {
    return this.withReplicaOperation(input.sourcePath, async () => {
      const blocked = (
        code: ProjectReplicaJobErrorCode,
        message: string,
        retryable = false,
      ): ProjectReplicaLinkRepairResult =>
        projectReplicaLinkRepairResultSchema.parse({
          status: "blocked",
          error: { code, message: message.slice(0, 4_000), retryable },
        });
      const validation = await this.validateManagedReplica(
        input.sourcePath,
        input.nameWithOwner,
      );
      if (!validation.ok) {
        return blocked(validation.code, validation.message);
      }
      const canonicalPath = await realpath(validation.path);
      const gitCommonDir = await this.gitCommonDirectory(canonicalPath);
      const repositoryFingerprint = createHash("sha256")
        .update(gitCommonDir)
        .digest("hex");
      if (repositoryFingerprint !== input.repositoryFingerprint) {
        return blocked(
          "ownership-proof-missing",
          "The repository fingerprint no longer matches the managed-link replica.",
        );
      }
      try {
        await this.placementManager.verifyPlacementOwnership({
          canonicalPath,
          gitCommonDir,
          linkPath: input.linkPath,
          mode: "managed-link",
          ownership: "cantrip",
          projectId: input.projectId,
          repositoryFingerprint,
        });
        const result = await this.placementManager.materializeManagedLink({
          canonicalPath,
          linkPath: input.linkPath,
          projectId: input.projectId,
          repositoryFingerprint,
          requestedPath: input.linkPath,
          requireExistingClaim: true,
        });
        return projectReplicaLinkRepairResultSchema.parse({
          status: "ready",
          projectId: input.projectId,
          path: canonicalPath,
          linkPath: input.linkPath,
          repaired: result.changed,
        });
      } catch (error) {
        if (error instanceof ProjectReplicaPlacementError) {
          return blocked(error.code, error.message, error.retryable);
        }
        return blocked(
          "link-unsupported",
          "The managed repository link could not be repaired safely.",
        );
      }
    });
  }

  async removeReplica(
    input: {
      jobId: string;
      attempt: number;
      projectId?: string;
      nameWithOwner: string | null;
      sourcePath: string;
      placement?: ProjectReplicaPlacementResult;
      repositoryFingerprint?: string;
      deleteLocalFiles: boolean;
    },
    reportProgress: (progress: ProjectReplicaJobProgressEvent) => void = () =>
      undefined,
  ): Promise<ProjectReplicaRemoveResult> {
    const normalizedInput = {
      ...input,
      projectId: input.projectId ?? input.jobId,
    };
    return this.withReplicaOperation(input.sourcePath, () =>
      this.removeReplicaUnlocked(normalizedInput, reportProgress),
    );
  }

  private async removeReplicaUnlocked(
    input: {
      jobId: string;
      attempt: number;
      projectId: string;
      nameWithOwner: string | null;
      sourcePath: string;
      placement?: ProjectReplicaPlacementResult;
      repositoryFingerprint?: string;
      deleteLocalFiles: boolean;
    },
    reportProgress: (progress: ProjectReplicaJobProgressEvent) => void,
  ): Promise<ProjectReplicaRemoveResult> {
    const blocked = (
      code: ProjectReplicaJobErrorCode,
      message: string,
      retryable: boolean,
    ): ProjectReplicaRemoveResult =>
      projectReplicaRemoveResultSchema.parse({
        status: "blocked",
        jobId: input.jobId,
        attempt: input.attempt,
        error: { code, message: message.slice(0, 4_000), retryable },
      });
    const blockedFromPlacementError = (
      error: ProjectReplicaPlacementError,
    ): ProjectReplicaRemoveResult =>
      blocked(error.code, error.message, error.retryable);
    if (!input.nameWithOwner && input.deleteLocalFiles) {
      return blocked(
        "policy-denied",
        "Detaching a local Git source never deletes its checkout.",
        false,
      );
    }
    const target = path.resolve(input.sourcePath);
    const placement = input.placement ?? null;
    const placementMode = placement?.mode ?? "managed";
    const customPlacement =
      placementMode === "direct" || placementMode === "managed-link";
    const root = this.repositoriesRoot();
    const canonicalRoot = await realpath(root).catch(() => root);
    if (
      placement &&
      !pathsEqual(path.resolve(placement.canonicalPath), target)
    ) {
      return blocked(
        "target-mismatch",
        "The persisted canonical repository path does not match the removal target.",
        false,
      );
    }
    if (
      placementMode !== "direct" &&
      !(
        (pathIsWithin(root, target) && !pathsEqual(target, root)) ||
        (pathIsWithin(canonicalRoot, target) &&
          !pathsEqual(target, canonicalRoot))
      )
    ) {
      return blocked(
        "target-mismatch",
        "Cantrip will only remove managed repositories from worker-owned storage.",
        false,
      );
    }
    if (customPlacement && !input.repositoryFingerprint) {
      return blocked(
        "ownership-proof-missing",
        "Custom repository removal requires its persisted repository fingerprint.",
        false,
      );
    }
    const placementReleased =
      customPlacement && placement && input.repositoryFingerprint
        ? await this.placementManager.isPlacementReleased({
            canonicalPath: target,
            mode: placementMode,
            projectId: input.projectId,
            repositoryFingerprint: input.repositoryFingerprint,
          })
        : false;
    if (placementReleased && input.deleteLocalFiles) {
      return blocked(
        "policy-denied",
        "This repository placement was already retained as user-managed storage.",
        false,
      );
    }
    try {
      await access(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (placementReleased) {
          return projectReplicaRemoveResultSchema.parse({
            status: "removed",
            jobId: input.jobId,
            attempt: input.attempt,
            path: target,
            localFilesDeleted: false,
            ownershipReleased: true,
          });
        }
        let linkRemoved = false;
        let warning: string | null = null;
        if (
          placementMode === "managed-link" &&
          placement?.linkPath &&
          input.repositoryFingerprint
        ) {
          try {
            await this.placementManager.verifyPlacementOwnership({
              canonicalPath: target,
              gitCommonDir: "",
              linkPath: placement.linkPath,
              mode: "managed-link",
              ownership: placement.ownership,
              projectId: input.projectId,
              repositoryFingerprint: input.repositoryFingerprint,
            });
            if (input.deleteLocalFiles) {
              const link =
                await this.placementManager.removeManagedLinkIfMatching({
                  canonicalPath: target,
                  linkPath: placement.linkPath,
                });
              linkRemoved = link.removed;
              warning = link.warning;
            }
            if (input.deleteLocalFiles) {
              await this.placementManager.forgetPlacement(
                input.projectId,
                target,
              );
            } else {
              await this.placementManager.releasePlacement({
                canonicalPath: target,
                gitCommonDir: null,
                mode: "managed-link",
                ownership: placement.ownership,
                projectId: input.projectId,
                repositoryFingerprint: input.repositoryFingerprint,
              });
            }
          } catch (placementError) {
            if (placementError instanceof ProjectReplicaPlacementError) {
              return blockedFromPlacementError(placementError);
            }
            throw placementError;
          }
        } else if (placementMode === "direct") {
          await this.placementManager.forgetPlacement(input.projectId, target);
        }
        return projectReplicaRemoveResultSchema.parse({
          status: "removed",
          jobId: input.jobId,
          attempt: input.attempt,
          path: target,
          localFilesDeleted: input.deleteLocalFiles,
          linkRemoved,
          ownershipReleased: customPlacement,
          warning,
        });
      }
      throw error;
    }
    if (placementMode !== "direct" && !input.nameWithOwner) {
      return blocked(
        "policy-denied",
        "Local Git repositories can only be removed from direct placement.",
        false,
      );
    }
    const validation =
      placementMode === "direct"
        ? await this.validateDirectReplica(target, input.nameWithOwner)
        : await this.validateManagedReplica(target, input.nameWithOwner!);
    if (!validation.ok) {
      return blocked(validation.code, validation.message, false);
    }
    const canonicalTarget = await realpath(target);
    let gitCommonDir: string | null = null;
    if (customPlacement) {
      gitCommonDir = await this.gitCommonDirectory(canonicalTarget);
      const repositoryFingerprint = createHash("sha256")
        .update(gitCommonDir)
        .digest("hex");
      if (repositoryFingerprint !== input.repositoryFingerprint) {
        return blocked(
          "ownership-proof-missing",
          "The repository fingerprint no longer matches the persisted project replica.",
          false,
        );
      }
      if (
        !placement ||
        (placementMode === "managed-link" && !placement.linkPath)
      ) {
        return blocked(
          "ownership-proof-missing",
          "The custom repository placement metadata is incomplete.",
          false,
        );
      }
      if (placementReleased) {
        try {
          await this.placementManager.releasePlacement({
            canonicalPath: canonicalTarget,
            gitCommonDir,
            mode: placementMode,
            ownership: placement.ownership,
            projectId: input.projectId,
            repositoryFingerprint,
          });
        } catch (error) {
          if (error instanceof ProjectReplicaPlacementError) {
            return blockedFromPlacementError(error);
          }
          throw error;
        }
        return projectReplicaRemoveResultSchema.parse({
          status: "removed",
          jobId: input.jobId,
          attempt: input.attempt,
          path: target,
          localFilesDeleted: false,
          ownershipReleased: true,
        });
      }
      try {
        await this.placementManager.verifyPlacementOwnership({
          canonicalPath: canonicalTarget,
          gitCommonDir,
          linkPath: placement.linkPath,
          mode: placementMode,
          ownership: placement.ownership,
          projectId: input.projectId,
          repositoryFingerprint,
        });
      } catch (error) {
        if (error instanceof ProjectReplicaPlacementError) {
          return blockedFromPlacementError(error);
        }
        throw error;
      }
      if (
        placementMode === "direct" &&
        placement.ownership === "user" &&
        input.deleteLocalFiles
      ) {
        return blocked(
          "policy-denied",
          "This checkout existed before Cantrip and cannot be deleted.",
          false,
        );
      }
    }
    if (!input.deleteLocalFiles) {
      if (customPlacement && placement && gitCommonDir) {
        try {
          await this.placementManager.releasePlacement({
            canonicalPath: canonicalTarget,
            gitCommonDir,
            mode: placementMode,
            ownership: placement.ownership,
            projectId: input.projectId,
            repositoryFingerprint: input.repositoryFingerprint!,
          });
        } catch (error) {
          if (error instanceof ProjectReplicaPlacementError) {
            return blockedFromPlacementError(error);
          }
          throw error;
        }
      }
      return projectReplicaRemoveResultSchema.parse({
        status: "removed",
        jobId: input.jobId,
        attempt: input.attempt,
        path: target,
        localFilesDeleted: false,
        ownershipReleased: customPlacement,
      });
    }
    reportProgress({
      stage: "inspecting",
      percent: 30,
    });
    const status = (
      await execFileAsync(
        "git",
        ["-C", target, "status", "--porcelain=v1", "--untracked-files=normal"],
        { maxBuffer: 4 * 1024 * 1024 },
      )
    ).stdout.trim();
    const ignored = (
      await execFileAsync(
        "git",
        [
          "-C",
          target,
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-standard",
          "--directory",
        ],
        { maxBuffer: 4 * 1024 * 1024 },
      )
    ).stdout.trim();
    if (status || ignored) {
      return blocked(
        "worktree-dirty",
        "The replica contains changed, untracked, or ignored files and was not deleted.",
        false,
      );
    }
    const worktrees = (
      await execFileAsync(
        "git",
        ["-C", target, "worktree", "list", "--porcelain"],
        {
          maxBuffer: 4 * 1024 * 1024,
        },
      )
    ).stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "));
    if (worktrees.length !== 1) {
      return blocked(
        "policy-denied",
        "The replica has additional Git worktrees and was not deleted.",
        false,
      );
    }
    try {
      await execFileAsync("git", ["-C", target, "fetch", "origin", "--prune"], {
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (error) {
      return blocked(
        "remote-unavailable",
        customPlacement
          ? "Could not verify published history for the selected worker checkout."
          : `Could not verify published history: ${(error as Error).message}`,
        true,
      );
    }
    const head = await this.revisionAt(target, "HEAD");
    const remoteContaining = (
      await execFileAsync(
        "git",
        [
          "-C",
          target,
          "for-each-ref",
          "--format=%(refname)",
          "--contains",
          head,
          "refs/remotes/origin",
        ],
        { maxBuffer: 4 * 1024 * 1024 },
      )
    ).stdout.trim();
    if (!remoteContaining) {
      return blocked(
        "unpushed-commits",
        "The replica HEAD is not contained in a fetched origin reference and was not deleted.",
        false,
      );
    }
    reportProgress({
      stage: "removing",
      percent: 80,
    });
    if (
      customPlacement &&
      placement &&
      gitCommonDir &&
      input.repositoryFingerprint
    ) {
      try {
        await this.placementManager.verifyPlacementOwnership({
          canonicalPath: canonicalTarget,
          gitCommonDir,
          linkPath: placement.linkPath,
          mode: placementMode,
          ownership: placement.ownership,
          projectId: input.projectId,
          repositoryFingerprint: input.repositoryFingerprint,
        });
      } catch (error) {
        if (error instanceof ProjectReplicaPlacementError) {
          return blockedFromPlacementError(error);
        }
        throw error;
      }
    }
    await rm(target, { recursive: true, force: false });
    let linkRemoved = false;
    let warning: string | null = null;
    if (
      placementMode === "managed-link" &&
      placement?.linkPath &&
      input.repositoryFingerprint
    ) {
      const link = await this.placementManager.removeManagedLinkIfMatching({
        canonicalPath: canonicalTarget,
        linkPath: placement.linkPath,
      });
      linkRemoved = link.removed;
      warning = link.warning;
      await this.placementManager.forgetPlacement(
        input.projectId,
        canonicalTarget,
      );
    } else if (placementMode === "direct") {
      await this.placementManager.forgetPlacement(
        input.projectId,
        canonicalTarget,
      );
    }
    return projectReplicaRemoveResultSchema.parse({
      status: "removed",
      jobId: input.jobId,
      attempt: input.attempt,
      path: target,
      localFilesDeleted: true,
      linkRemoved,
      ownershipReleased: customPlacement,
      warning,
    });
  }

  private async withReplicaOperation<T>(
    targetPath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const target = normalizeProjectSourcePath(targetPath);
    const previous =
      this.replicaOperationQueues.get(target) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.replicaOperationQueues.set(target, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.replicaOperationQueues.get(target) === queued) {
        this.replicaOperationQueues.delete(target);
      }
    }
  }

  private async gitCommonDirectory(repositoryPath: string): Promise<string> {
    const commonDirOutput = (
      await execFileAsync(
        "git",
        ["-C", repositoryPath, "rev-parse", "--git-common-dir"],
        { maxBuffer: 1024 * 1024 },
      )
    ).stdout.trim();
    return realpath(
      path.isAbsolute(commonDirOutput)
        ? commonDirOutput
        : path.resolve(repositoryPath, commonDirOutput),
    );
  }

  private async validateDirectReplica(
    repositoryPath: string,
    nameWithOwner: string | null,
  ): Promise<
    | { ok: true; path: string }
    | {
        ok: false;
        code:
          | "target-not-found"
          | "target-repository-mismatch"
          | "target-not-primary-worktree";
        message: string;
      }
  > {
    let target: string;
    try {
      target = normalizeProjectSourcePath(repositoryPath);
    } catch {
      return {
        ok: false,
        code: "target-not-found",
        message: "The direct repository path is not a supported native path.",
      };
    }
    try {
      const entry = await lstat(target);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        return {
          ok: false,
          code: "target-repository-mismatch",
          message: "The direct repository path is not a canonical directory.",
        };
      }
      if (!pathsEqual(await realpath(target), target)) {
        return {
          ok: false,
          code: "target-repository-mismatch",
          message:
            "The direct repository path no longer has its canonical identity.",
        };
      }
      const topLevel = await realpath(
        (
          await execFileAsync(
            "git",
            ["-C", target, "rev-parse", "--show-toplevel"],
            { maxBuffer: 1024 * 1024 },
          )
        ).stdout.trim(),
      );
      const isBare = (
        await execFileAsync(
          "git",
          ["-C", target, "rev-parse", "--is-bare-repository"],
          { maxBuffer: 1024 * 1024 },
        )
      ).stdout.trim();
      if (!pathsEqual(topLevel, target) || isBare !== "false") {
        return {
          ok: false,
          code: "target-repository-mismatch",
          message:
            "The direct checkout is no longer an attachable Git repository.",
        };
      }
      if (nameWithOwner) {
        const origin = (
          await execFileAsync(
            "git",
            ["-C", target, "config", "--get", "remote.origin.url"],
            { maxBuffer: 1024 * 1024 },
          )
        ).stdout.trim();
        if (
          githubRepositoryFromRemoteUrl(origin) !== nameWithOwner.toLowerCase()
        ) {
          return {
            ok: false,
            code: "target-repository-mismatch",
            message:
              "The direct checkout no longer matches this GitHub repository.",
          };
        }
      }
      const gitDirOutput = (
        await execFileAsync("git", ["-C", target, "rev-parse", "--git-dir"], {
          maxBuffer: 1024 * 1024,
        })
      ).stdout.trim();
      const gitDir = await realpath(
        path.isAbsolute(gitDirOutput)
          ? gitDirOutput
          : path.resolve(target, gitDirOutput),
      );
      const commonDir = await this.gitCommonDirectory(target);
      if (!pathsEqual(gitDir, commonDir)) {
        return {
          ok: false,
          code: "target-not-primary-worktree",
          message:
            "Only the direct repository's Primary worktree can be removed.",
        };
      }
      return { ok: true, path: target };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          ok: false,
          code: "target-not-found",
          message: "The direct repository checkout no longer exists.",
        };
      }
      return {
        ok: false,
        code: "target-repository-mismatch",
        message: "The direct repository checkout could not be verified safely.",
      };
    }
  }

  private async validateManagedReplica(
    repositoryPath: string,
    nameWithOwner: string,
  ): Promise<
    | { ok: true; path: string }
    | {
        ok: false;
        code: "target-not-found" | "target-mismatch";
        message: string;
      }
  > {
    const root = this.repositoriesRoot();
    let target: string;
    try {
      target = normalizeProjectSourcePath(repositoryPath);
    } catch {
      return {
        ok: false,
        code: "target-not-found",
        message: "The managed repository path is not a supported native path.",
      };
    }
    try {
      const entry = await lstat(target);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        return {
          ok: false,
          code: "target-mismatch",
          message: "The replica path is not a managed directory.",
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          ok: false,
          code: "target-not-found",
          message: "The worker-local replica path does not exist.",
        };
      }
      throw error;
    }
    const [resolvedRoot, resolvedTarget] = await Promise.all([
      canonicalProjectSourcePath(root),
      canonicalProjectSourcePath(target),
    ]);
    if (
      !pathIsWithin(resolvedRoot, resolvedTarget) ||
      pathsEqual(resolvedTarget, resolvedRoot)
    ) {
      return {
        ok: false,
        code: "target-mismatch",
        message:
          "The replica resolves outside worker-managed repository storage.",
      };
    }
    let origin: string;
    try {
      origin = (
        await execFileAsync("git", [
          "-C",
          target,
          "remote",
          "get-url",
          "origin",
        ])
      ).stdout.trim();
    } catch {
      return {
        ok: false,
        code: "target-mismatch",
        message: "The replica is not a Git repository with an origin remote.",
      };
    }
    const normalizedOrigin = origin
      .replace(/\.git$/u, "")
      .replaceAll("\\", "/")
      .toLowerCase();
    const expectedSuffix = nameWithOwner.toLowerCase();
    if (
      !normalizedOrigin.endsWith(`/${expectedSuffix}`) &&
      !normalizedOrigin.endsWith(`:${expectedSuffix}`)
    ) {
      return {
        ok: false,
        code: "target-mismatch",
        message: `The replica points at a different origin: ${origin}`,
      };
    }
    return { ok: true, path: resolvedTarget };
  }

  private async revisionAt(repositoryPath: string, revision: string) {
    return (
      await execFileAsync("git", [
        "-C",
        repositoryPath,
        "rev-parse",
        "--verify",
        `${revision}^{commit}`,
      ])
    ).stdout
      .trim()
      .toLowerCase();
  }

  private async isAncestor(
    repositoryPath: string,
    ancestor: string,
    descendant: string,
  ): Promise<boolean> {
    try {
      await execFileAsync("git", [
        "-C",
        repositoryPath,
        "merge-base",
        "--is-ancestor",
        ancestor,
        descendant,
      ]);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException & { code?: number }).code === 1) {
        return false;
      }
      throw error;
    }
  }
}
