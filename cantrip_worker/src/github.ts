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
  githubWorkerRepositoryListSchema,
  projectCloneResultSchema,
  worktreePolicySchema,
  type GithubAuthStatus,
  type GithubIssueDetail,
  type GithubIssueList,
  type GithubIssueState,
  type GithubIssueSummary,
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
    state: GithubIssueState,
  ): Promise<GithubIssueList> {
    const pages = (await this.api(
      `${this.repositoryApiPath(nameWithOwner)}/issues`,
      [
        "--method",
        "GET",
        "--paginate",
        "--slurp",
        "-f",
        "per_page=100",
        "-f",
        `state=${state}`,
        "-f",
        "sort=updated",
        "-f",
        "direction=desc",
      ],
    )) as GithubApiIssue[][];
    const issues = pages
      .flat()
      .filter((issue) => !issue.pull_request)
      .map(parseIssue);
    return githubIssueListSchema.parse({ state, total: issues.length, issues });
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
