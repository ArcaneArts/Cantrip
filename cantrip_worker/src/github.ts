import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
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
  githubPullRequestDetailSchema,
  githubPullRequestSummarySchema,
  githubReleaseListSchema,
  githubReleaseSummarySchema,
  githubWorkerRepositoryListSchema,
  projectCloneResultSchema,
  worktreePolicySchema,
  type GithubAuthStatus,
  type GithubIssueDetail,
  type GithubIssueKind,
  type GithubIssueList,
  type GithubIssueState,
  type GithubIssueSummary,
  type GithubPullRequestCreate,
  type GithubPullRequestCreateResult,
  type GithubPullRequestDetail,
  type GithubPullRequestCheck,
  type GithubPullRequestInlineCommentCreate,
  type GithubPullRequestReview,
  type GithubPullRequestReviewComment,
  type GithubPullRequestReviewSubmit,
  type GithubPullRequestReviewThread,
  type GithubPullRequestSummary,
  type GithubReleaseCreate,
  type GithubReleaseList,
  type GithubReleaseSummary,
  type GithubWorkerRepository,
  type ProjectCloneResult,
  type WorktreePolicy,
} from "@cantrip/protocol";

const execFileAsync = promisify(execFile);
const SAFE_REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const MAX_PROJECT_POLICY_BYTES = 64 * 1024;

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
    try {
      await execFileAsync("git", [
        "-C",
        cwd,
        "show-ref",
        "--verify",
        `refs/tags/${request.tagName}`,
      ]);
    } catch {
      throw new Error(
        `Local tag ${request.tagName} does not exist in the selected worktree repository.`,
      );
    }
    return parseRelease(
      (await this.api(`${this.repositoryApiPath(nameWithOwner)}/releases`, [
        "--method",
        "POST",
        "-f",
        `tag_name=${request.tagName}`,
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
    const [owner, repository] = repositorySegments(nameWithOwner);
    const repositoriesDirectory = path.join(
      this.dataDirectory,
      "repositories",
      owner,
    );
    const target = path.join(repositoriesDirectory, repository);
    await mkdir(repositoriesDirectory, { recursive: true });

    let reused = false;
    let updated = false;
    let warning: string | null = null;
    try {
      await access(target);
      reused = true;
      const { stdout } = await execFileAsync(
        "git",
        ["-C", target, "remote", "get-url", "origin"],
        { maxBuffer: 1024 * 1024 },
      );
      const remote = stdout
        .trim()
        .replace(/\.git$/, "")
        .toLowerCase();
      if (!remote.includes(nameWithOwner.toLowerCase())) {
        throw new Error(
          `Clone destination already exists for a different repository: ${target}`,
        );
      }
      try {
        await execFileAsync(
          "git",
          ["-C", target, "fetch", "--all", "--prune"],
          {
            maxBuffer: 32 * 1024 * 1024,
          },
        );
        const { stdout: status } = await execFileAsync(
          "git",
          ["-C", target, "status", "--porcelain"],
          { maxBuffer: 4 * 1024 * 1024 },
        );
        const { stdout: branch } = await execFileAsync(
          "git",
          ["-C", target, "branch", "--show-current"],
          { maxBuffer: 1024 * 1024 },
        );
        if (status.trim()) {
          warning =
            "Existing repository was re-linked but not pulled because it has local changes.";
        } else if (branch.trim()) {
          await execFileAsync("git", ["-C", target, "pull", "--ff-only"], {
            maxBuffer: 32 * 1024 * 1024,
          });
          updated = true;
        } else {
          warning =
            "Existing repository was re-linked at a detached HEAD; fetched without pulling.";
        }
      } catch (error) {
        warning = `Existing repository was re-linked, but could not be updated: ${(error as Error).message}`;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
      await execFileAsync("gh", ["repo", "clone", nameWithOwner, target], {
        maxBuffer: 32 * 1024 * 1024,
      });
    }

    const projectPolicy = await readProjectWorktreePolicy(target);
    warning =
      [warning, projectPolicy.warning].filter(Boolean).join(" ") || null;
    return projectCloneResultSchema.parse({
      path: target,
      displayPath: `${owner}/${repository}`,
      reused,
      updated,
      warning,
      worktreePolicy: projectPolicy.policy,
    });
  }
}
