import { execFile } from "node:child_process";
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
  githubIssueDetailSchema,
  githubIssueListSchema,
  githubPullRequestCreateResultSchema,
  githubPullRequestCheckoutPreparedSchema,
  githubPullRequestDetailSchema,
  githubPullRequestLifecyclePreviewSchema,
  githubPullRequestSummarySchema,
  githubReleaseListSchema,
  githubReleaseSummarySchema,
  githubRepositoryOwnerListSchema,
  githubRepositoryCreateSchema,
  githubWorkerRepositorySchema,
  githubWorkerRepositoryListSchema,
  projectCloneResultSchema,
  projectReplicaProvisionResultSchema,
  projectReplicaRemoveResultSchema,
  projectReplicaSynchronizeResultSchema,
  worktreePolicySchema,
  type GithubAuthStatus,
  type GithubIssueDetail,
  type GithubIssueKind,
  type GithubIssueList,
  type GithubIssueState,
  type GithubIssueSummary,
  type GithubPullRequestCreate,
  type GithubPullRequestCreateResult,
  type GithubPullRequestCheckoutPrepared,
  type GithubPullRequestDetail,
  type GithubPullRequestCheck,
  type GithubPullRequestInlineCommentCreate,
  type GithubPullRequestLifecycleAction,
  type GithubPullRequestLifecycleApply,
  type GithubPullRequestLifecyclePreview,
  type GithubPullRequestReview,
  type GithubPullRequestReviewComment,
  type GithubPullRequestReviewSubmit,
  type GithubPullRequestReviewThread,
  type GithubPullRequestSummary,
  type GithubReleaseCreate,
  type GithubReleaseList,
  type GithubReleaseSummary,
  type GithubRepositoryCreate,
  type GithubRepositoryOwner,
  type GithubWorkerRepository,
  type ProjectCloneResult,
  type ProjectReplicaJobProgressEvent,
  type ProjectReplicaProvisionResult,
  type ProjectReplicaRemoveResult,
  type ProjectReplicaSynchronizationPolicy,
  type ProjectReplicaSynchronizeResult,
  type WorktreePolicy,
} from "@cantrip/protocol";

const execFileAsync = promisify(execFile);
const SAFE_REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const MAX_PROJECT_POLICY_BYTES = 64 * 1024;
const EMPTY_REPOSITORY_MESSAGE =
  "The repository origin does not have an initial commit yet. Create the first commit on GitHub, then retry setup.";

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
  body?: unknown;
  closed_at?: unknown;
  comments?: unknown;
  created_at?: unknown;
  html_url?: unknown;
  labels?: unknown;
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
  requested_reviewers?: unknown;
}

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

function githubRepositoryFromRemoteUrl(value: string): string | null {
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
    merged: value.merged === true,
    headRef: head.ref,
    headSha: head.sha,
    baseRef: base.ref,
    baseSha: base.sha,
  });
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
  };
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
      resolved: null,
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

export class GithubClient {
  private readonly replicaOperationQueues = new Map<string, Promise<void>>();

  constructor(private readonly dataDirectory: string) {}

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

  private async verifyWorktree(cwd: string): Promise<void> {
    await execFileAsync("git", ["-C", cwd, "rev-parse", "--git-dir"]);
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
    const args = [
      "repo",
      "create",
      nameWithOwner,
      `--${request.visibility}`,
      "--add-readme",
    ];
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
    kind: GithubIssueKind,
    state: GithubIssueState,
    page = 1,
    limit = 100,
  ): Promise<GithubIssueList> {
    const values = (await this.api(
      `${this.repositoryApiPath(nameWithOwner)}/issues`,
      [
        "--method",
        "GET",
        "-f",
        `per_page=${limit}`,
        "-f",
        `page=${page}`,
        "-f",
        `state=${state}`,
        "-f",
        "sort=updated",
        "-f",
        "direction=desc",
      ],
    )) as GithubApiIssue[];
    const issues = values
      .filter((issue) =>
        kind === "pull-request"
          ? Boolean(issue.pull_request)
          : !issue.pull_request,
      )
      .map(parseIssue);
    return githubIssueListSchema.parse({
      kind,
      state,
      total: issues.length,
      issues,
      nextPage: values.length === limit ? page + 1 : null,
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

  async getPullRequest(
    nameWithOwner: string,
    cwd: string,
    pullRequestNumber: number,
  ): Promise<GithubPullRequestDetail> {
    await this.verifyWorktree(cwd);
    const repositoryPath = this.repositoryApiPath(nameWithOwner);
    const pullRequestPath = `${repositoryPath}/pulls/${pullRequestNumber}`;
    const rawPullRequest = (await this.api(
      pullRequestPath,
    )) as GithubApiPullRequest;
    const summary = parsePullRequest(rawPullRequest);
    const issuePath = `${repositoryPath}/issues/${pullRequestNumber}`;
    const [
      rawComments,
      rawCommits,
      rawFiles,
      rawCheckRuns,
      rawStatuses,
      rawReviews,
      rawReviewComments,
    ] = await Promise.all([
      this.api(`${issuePath}/comments`, [
        "--method",
        "GET",
        "-f",
        "per_page=100",
      ]) as Promise<GithubApiIssueComment[]>,
      this.api(`${pullRequestPath}/commits`, [
        "--method",
        "GET",
        "-f",
        "per_page=100",
      ]) as Promise<GithubApiPullRequestCommit[]>,
      this.api(`${pullRequestPath}/files`, [
        "--method",
        "GET",
        "-f",
        "per_page=100",
      ]) as Promise<GithubApiPullRequestFile[]>,
      this.api(`${repositoryPath}/commits/${summary.headSha}/check-runs`, [
        "--method",
        "GET",
        "-f",
        "per_page=100",
      ]) as Promise<GithubApiCheckRuns>,
      this.api(`${repositoryPath}/commits/${summary.headSha}/status`, [
        "--method",
        "GET",
        "-f",
        "per_page=100",
      ]) as Promise<GithubApiCombinedStatus>,
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
    ]);
    const commits = rawCommits.slice(0, 100).map(parsePullRequestCommit);
    const files = rawFiles.slice(0, 100).map(parsePullRequestFile);
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
    const reviews = rawReviews.slice(0, 100).map(parsePullRequestReview);
    const reviewComments = rawReviewComments
      .slice(0, 100)
      .map(parsePullRequestReviewComment);
    const reviewThreads = groupPullRequestReviewThreads(reviewComments);
    const requestedReviewers = Array.isArray(rawPullRequest.requested_reviewers)
      ? [
          ...new Set(
            rawPullRequest.requested_reviewers.map((reviewer) =>
              githubLogin(reviewer),
            ),
          ),
        ]
      : [];
    const commitCount = Number(rawPullRequest.commits) || commits.length;
    const changedFileCount =
      Number(rawPullRequest.changed_files) || files.length;
    return githubPullRequestDetailSchema.parse({
      ...summary,
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
      reviewDecision: deriveReviewDecision(reviews, requestedReviewers),
      checksState: deriveChecksState(checks),
      additions: Number(rawPullRequest.additions) || 0,
      deletions: Number(rawPullRequest.deletions) || 0,
      changedFileCount,
      commitCount,
      commits,
      commitsTruncated: commitCount > commits.length,
      files,
      filesTruncated: changedFileCount > files.length,
      checks,
      checksTruncated:
        Number(rawCheckRuns.total_count) > checkRuns.length ||
        (Array.isArray(rawStatuses.statuses) &&
          rawStatuses.statuses.length >= 100),
      reviews,
      reviewsTruncated: rawReviews.length >= 100,
      reviewThreads,
      reviewThreadsTruncated:
        rawReviewComments.length >= 100 || reviewThreads.length >= 100,
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
    const event = review.event === "approve" ? "APPROVE" : "REQUEST_CHANGES";
    await this.api(
      `${this.repositoryApiPath(nameWithOwner)}/pulls/${pullRequestNumber}/reviews`,
      ["--method", "POST", "-f", `event=${event}`, "-f", `body=${review.body}`],
    );
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
    const args = [
      "--method",
      "POST",
      "-f",
      `body=${comment.body}`,
      "-f",
      `commit_id=${pullRequest.headSha}`,
      "-f",
      `path=${comment.path}`,
      "-F",
      `line=${comment.line}`,
      "-f",
      `side=${comment.side}`,
    ];
    if (comment.startLine !== null && comment.startSide !== null) {
      args.push(
        "-F",
        `start_line=${comment.startLine}`,
        "-f",
        `start_side=${comment.startSide}`,
      );
    }
    await this.api(`${pullRequestPath}/comments`, args);
    return this.getPullRequest(nameWithOwner, cwd, pullRequestNumber);
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
    }
    return this.getPullRequest(nameWithOwner, cwd, pullRequestNumber);
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
    const provisioned = await this.provisionReplica({
      jobId: randomUUID(),
      attempt: 1,
      nameWithOwner,
      expectedRevision: null,
    });
    if (provisioned.status === "blocked") {
      throw new Error(provisioned.error.message);
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
      nameWithOwner: string;
      expectedRevision: string | null;
    },
    reportProgress: (progress: ProjectReplicaJobProgressEvent) => void = () =>
      undefined,
  ): Promise<ProjectReplicaProvisionResult> {
    const [owner, repository] = repositorySegments(input.nameWithOwner);
    const target = path.join(
      this.dataDirectory,
      "repositories",
      owner,
      repository,
    );
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
      return await this.provisionReplicaUnlocked(input, reportProgress);
    } finally {
      release();
      if (this.replicaOperationQueues.get(target) === queued) {
        this.replicaOperationQueues.delete(target);
      }
    }
  }

  private async provisionReplicaUnlocked(
    input: {
      jobId: string;
      attempt: number;
      nameWithOwner: string;
      expectedRevision: string | null;
    },
    reportProgress: (progress: ProjectReplicaJobProgressEvent) => void,
  ): Promise<ProjectReplicaProvisionResult> {
    reportProgress({
      stage: "validating",
      percent: 10,
      message: "Validating the managed replica target.",
    });
    const [owner, repository] = repositorySegments(input.nameWithOwner);
    const repositoriesDirectory = path.join(
      this.dataDirectory,
      "repositories",
      owner,
    );
    const target = path.join(repositoriesDirectory, repository);
    await mkdir(repositoriesDirectory, { recursive: true });

    const blocked = (
      code:
        | "target-not-found"
        | "target-mismatch"
        | "worktree-dirty"
        | "revision-diverged"
        | "remote-unavailable",
      message: string,
      retryable: boolean,
    ): ProjectReplicaProvisionResult =>
      projectReplicaProvisionResultSchema.parse({
        status: "blocked",
        jobId: input.jobId,
        attempt: input.attempt,
        error: { code, message: message.slice(0, 4_000), retryable },
      });

    let reused = true;
    try {
      await access(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      reused = false;
    }

    if (reused) {
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
        message:
          "Fetching repository references without changing the worktree.",
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
        message: "Checking worktree cleanliness and revision identity.",
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
          if (!currentRevision) {
            return blocked("target-not-found", EMPTY_REPOSITORY_MESSAGE, true);
          }
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
    } else {
      const staging = `${target}.cantrip-provision-${input.jobId}`;
      reportProgress({
        stage: "materializing",
        percent: 30,
        message: "Cloning into worker-owned staging storage.",
      });
      try {
        await rm(staging, { recursive: true, force: true });
        await execFileAsync(
          "gh",
          ["repo", "clone", input.nameWithOwner, staging],
          { maxBuffer: 32 * 1024 * 1024 },
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
            percent: 65,
            message:
              "Resolving and checking out the requested immutable revision.",
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
            await rm(staging, { recursive: true, force: true });
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
          if (!(await attachUnbornHeadToOrigin(staging))) {
            await rm(staging, { recursive: true, force: true });
            return blocked("target-not-found", EMPTY_REPOSITORY_MESSAGE, true);
          }
        }
        await rename(staging, target);
      } catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(
          () => undefined,
        );
        return blocked(
          "remote-unavailable",
          `Could not clone the repository: ${(error as Error).message}`,
          true,
        );
      }
    }

    reportProgress({
      stage: "verifying",
      percent: 90,
      message: "Verifying the materialized repository identity and revision.",
    });

    const resolvedRevision = (
      await execFileAsync(
        "git",
        ["-C", target, "rev-parse", "--verify", "HEAD^{commit}"],
        { maxBuffer: 1024 * 1024 },
      )
    ).stdout
      .trim()
      .toLowerCase();
    const branch = (
      await execFileAsync("git", ["-C", target, "branch", "--show-current"], {
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
    const commonDir = await realpath(
      path.isAbsolute(commonDirOutput)
        ? commonDirOutput
        : path.resolve(target, commonDirOutput),
    );

    const projectPolicy = await readProjectWorktreePolicy(target);
    return projectReplicaProvisionResultSchema.parse({
      status: "ready",
      jobId: input.jobId,
      attempt: input.attempt,
      path: target,
      displayPath: `${owner}/${repository}`,
      repositoryFingerprint: createHash("sha256")
        .update(commonDir)
        .digest("hex"),
      resolvedRevision,
      branch: branch || null,
      reused,
      worktreePolicy: projectPolicy.policy,
    });
  }

  async synchronizeReplica(
    input: {
      jobId: string;
      attempt: number;
      nameWithOwner: string;
      sourcePath: string;
      expectedRevision: string;
      policy: ProjectReplicaSynchronizationPolicy;
    },
    reportProgress: (progress: ProjectReplicaJobProgressEvent) => void = () =>
      undefined,
  ): Promise<ProjectReplicaSynchronizeResult> {
    return this.withReplicaOperation(input.sourcePath, () =>
      this.synchronizeReplicaUnlocked(input, reportProgress),
    );
  }

  private async synchronizeReplicaUnlocked(
    input: {
      jobId: string;
      attempt: number;
      nameWithOwner: string;
      sourcePath: string;
      expectedRevision: string;
      policy: ProjectReplicaSynchronizationPolicy;
    },
    reportProgress: (progress: ProjectReplicaJobProgressEvent) => void,
  ): Promise<ProjectReplicaSynchronizeResult> {
    const blocked = (
      code:
        | "target-not-found"
        | "target-mismatch"
        | "worktree-dirty"
        | "revision-diverged"
        | "unpushed-commits"
        | "policy-denied"
        | "remote-unavailable",
      message: string,
      retryable: boolean,
    ): ProjectReplicaSynchronizeResult =>
      projectReplicaSynchronizeResultSchema.parse({
        status: "blocked",
        jobId: input.jobId,
        attempt: input.attempt,
        error: { code, message: message.slice(0, 4_000), retryable },
      });

    reportProgress({
      stage: "validating",
      percent: 10,
      message: "Validating the worker-managed replica.",
    });
    const validation = await this.validateManagedReplica(
      input.sourcePath,
      input.nameWithOwner,
    );
    if (!validation.ok) {
      return blocked(validation.code, validation.message, false);
    }
    const target = validation.path;
    reportProgress({
      stage: "fetching",
      percent: 30,
      message: "Fetching origin references without changing the checkout.",
    });
    try {
      await execFileAsync("git", ["-C", target, "fetch", "origin", "--prune"], {
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (error) {
      return blocked(
        "remote-unavailable",
        `Could not fetch the repository origin: ${(error as Error).message}`,
        true,
      );
    }
    reportProgress({
      stage: "inspecting",
      percent: 50,
      message: "Checking cleanliness, ancestry, and revision availability.",
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
      message: "Fast-forwarding the clean Primary checkout.",
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

  async removeReplica(
    input: {
      jobId: string;
      attempt: number;
      nameWithOwner: string;
      sourcePath: string;
      deleteLocalFiles: boolean;
    },
    reportProgress: (progress: ProjectReplicaJobProgressEvent) => void = () =>
      undefined,
  ): Promise<ProjectReplicaRemoveResult> {
    return this.withReplicaOperation(input.sourcePath, () =>
      this.removeReplicaUnlocked(input, reportProgress),
    );
  }

  private async removeReplicaUnlocked(
    input: {
      jobId: string;
      attempt: number;
      nameWithOwner: string;
      sourcePath: string;
      deleteLocalFiles: boolean;
    },
    reportProgress: (progress: ProjectReplicaJobProgressEvent) => void,
  ): Promise<ProjectReplicaRemoveResult> {
    const blocked = (
      code:
        | "target-not-found"
        | "target-mismatch"
        | "worktree-dirty"
        | "unpushed-commits"
        | "policy-denied"
        | "remote-unavailable",
      message: string,
      retryable: boolean,
    ): ProjectReplicaRemoveResult =>
      projectReplicaRemoveResultSchema.parse({
        status: "blocked",
        jobId: input.jobId,
        attempt: input.attempt,
        error: { code, message: message.slice(0, 4_000), retryable },
      });
    const target = path.resolve(input.sourcePath);
    const root = this.repositoriesRoot();
    if (!target.startsWith(`${root}${path.sep}`) || target === root) {
      return blocked(
        "target-mismatch",
        "Cantrip will only remove repositories from worker-managed storage.",
        false,
      );
    }
    try {
      await access(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return projectReplicaRemoveResultSchema.parse({
          status: "removed",
          jobId: input.jobId,
          attempt: input.attempt,
          path: target,
          localFilesDeleted: input.deleteLocalFiles,
        });
      }
      throw error;
    }
    const validation = await this.validateManagedReplica(
      target,
      input.nameWithOwner,
    );
    if (!validation.ok) {
      return blocked(validation.code, validation.message, false);
    }
    if (!input.deleteLocalFiles) {
      return projectReplicaRemoveResultSchema.parse({
        status: "removed",
        jobId: input.jobId,
        attempt: input.attempt,
        path: target,
        localFilesDeleted: false,
      });
    }
    reportProgress({
      stage: "inspecting",
      percent: 30,
      message: "Checking local files, worktrees, and published history.",
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
        `Could not verify published history: ${(error as Error).message}`,
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
      message: "Removing verified worker-local replica files.",
    });
    await rm(target, { recursive: true, force: false });
    return projectReplicaRemoveResultSchema.parse({
      status: "removed",
      jobId: input.jobId,
      attempt: input.attempt,
      path: target,
      localFilesDeleted: true,
    });
  }

  private async withReplicaOperation<T>(
    targetPath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const target = path.resolve(targetPath);
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
    const target = path.resolve(repositoryPath);
    if (!target.startsWith(`${root}${path.sep}`) || target === root) {
      return {
        ok: false,
        code: "target-mismatch",
        message:
          "The replica path is outside worker-managed repository storage.",
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
      realpath(root),
      realpath(target),
    ]);
    if (
      !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`) ||
      resolvedTarget === resolvedRoot
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
    return { ok: true, path: target };
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
