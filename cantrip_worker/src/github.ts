import { execFile } from "node:child_process";
import { access, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  githubAuthStatusSchema,
  githubWorkerRepositoryListSchema,
  projectCloneResultSchema,
  type GithubAuthStatus,
  type GithubWorkerRepository,
  type ProjectCloneResult,
} from "@cantrip/protocol";

const execFileAsync = promisify(execFile);
const SAFE_REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/;

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

export class GithubClient {
  constructor(private readonly dataDirectory: string) {}

  private repositoriesRoot(): string {
    return path.resolve(this.dataDirectory, "repositories");
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
    if (!status.authenticated) {
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
    return githubWorkerRepositoryListSchema.parse(
      pages
        .flat()
        .map(parseRepository)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
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

    return projectCloneResultSchema.parse({
      path: target,
      displayPath: `${owner}/${repository}`,
      reused,
      updated,
      warning,
    });
  }
}
