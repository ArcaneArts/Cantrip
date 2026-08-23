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
  githubIssueListSchema,
  githubPullRequestListSchema,
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
  projectReplicaLinkRepairResultSchema,
  projectReplicaRemoveResultSchema,
  projectReplicaSynchronizeResultSchema,
  worktreePolicySchema,
  type GithubAuthStatus,
  type GithubIssueCreate,
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
  type GithubPullRequestList,
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
  type ProjectReplicaJobErrorCode,
  type ProjectReplicaLinkRepairResult,
  type ProjectReplicaPlacementRequest,
  type ProjectReplicaPlacementResult,
  type ProjectReplicaProvisionResult,
  type ProjectReplicaRemoveResult,
  type ProjectReplicaSynchronizationPolicy,
  type ProjectReplicaSynchronizeResult,
  type WorktreePolicy,
} from "@cantrip/protocol";

import {
  ProjectReplicaPlacementError,
  ProjectReplicaPlacementManager,
} from "./project-replica-placement.js";

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
  merged_at?: unknown;
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

  async listPullRequests(
    nameWithOwner: string,
    state: GithubIssueState,
    page = 1,
    limit = 100,
  ): Promise<GithubPullRequestList> {
    const values = (await this.api(
      `${this.repositoryApiPath(nameWithOwner)}/pulls`,
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
    )) as GithubApiPullRequest[];
    const pullRequests = values.map(parsePullRequest);
    return githubPullRequestListSchema.parse({
      state,
      total: pullRequests.length,
      pullRequests,
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
    const jobId = randomUUID();
    const provisioned = await this.provisionReplica({
      jobId,
      attempt: 1,
      projectId: jobId,
      nameWithOwner,
      placement: { mode: "managed" },
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
      nameWithOwner: string;
      placement?: ProjectReplicaPlacementRequest;
      expectedRevision: string | null;
    },
    reportProgress: (progress: ProjectReplicaJobProgressEvent) => void = () =>
      undefined,
  ): Promise<ProjectReplicaProvisionResult> {
    const normalizedInput = {
      ...input,
      projectId: input.projectId ?? input.jobId,
      placement: input.placement ?? ({ mode: "managed" } as const),
    };
    const [owner, repository] = repositorySegments(input.nameWithOwner);
    const queueTarget =
      normalizedInput.placement.mode !== "direct"
        ? path.join(this.dataDirectory, "repositories", owner, repository)
        : normalizedInput.placement.path;
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
      nameWithOwner: string;
      placement: ProjectReplicaPlacementRequest;
      expectedRevision: string | null;
    },
    reportProgress: (progress: ProjectReplicaJobProgressEvent) => void,
  ): Promise<ProjectReplicaProvisionResult> {
    const [owner, repository] = repositorySegments(input.nameWithOwner);
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
    let prepared;
    try {
      prepared = await this.placementManager.prepare({
        jobId: input.jobId,
        managedTarget: path.join(
          this.dataDirectory,
          "repositories",
          owner,
          repository,
        ),
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
        if (input.expectedRevision) {
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

    const canonicalTarget = await realpath(target);
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
      displayPath: prepared.requestedPath ?? `${owner}/${repository}`,
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
    const sourceTarget = path.resolve(input.sourcePath);
    if (
      placement &&
      !pathsEqual(path.resolve(placement.canonicalPath), sourceTarget)
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
        ? await this.validateDirectReplica(
            input.sourcePath,
            input.nameWithOwner,
          )
        : await this.validateManagedReplica(
            input.sourcePath,
            input.nameWithOwner,
          );
    if (!validation.ok) {
      return blocked(validation.code, validation.message, false);
    }
    const target = validation.path;
    if (customPlacement && placement && input.repositoryFingerprint) {
      const canonicalTarget = await realpath(target);
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
      nameWithOwner: string;
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
      nameWithOwner: string;
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
    const validation =
      placementMode === "direct"
        ? await this.validateDirectReplica(target, input.nameWithOwner)
        : await this.validateManagedReplica(target, input.nameWithOwner);
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
    nameWithOwner: string,
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
    const target = path.resolve(repositoryPath);
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
      const origin = (
        await execFileAsync(
          "git",
          ["-C", target, "config", "--get", "remote.origin.url"],
          { maxBuffer: 1024 * 1024 },
        )
      ).stdout.trim();
      if (
        !pathsEqual(topLevel, target) ||
        isBare !== "false" ||
        githubRepositoryFromRemoteUrl(origin) !== nameWithOwner.toLowerCase()
      ) {
        return {
          ok: false,
          code: "target-repository-mismatch",
          message:
            "The direct checkout no longer matches this GitHub repository.",
        };
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
    const target = path.resolve(repositoryPath);
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
