import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  projectGithubConversionExecutionResultSchema,
  projectGithubConversionPreflightResultSchema,
  projectGithubConversionReadySchema,
  projectGithubConversionRepositorySchema,
  type ProjectGithubConversionError,
  type ProjectGithubConversionExecutionResult,
  type ProjectGithubConversionPreflightResult,
  type ProjectGithubConversionReady,
  type ProjectGithubConversionRepository,
  type ProjectWorkspaceStorageContext,
} from "@cantrip/protocol";

import { readProjectWorktreePolicy } from "./github.js";
import type { ManagedFolderManager } from "./managed-folders.js";

const execFileAsync = promisify(execFile);
const SAFE_REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const GIT_OUTPUT_LIMIT = 32 * 1024 * 1024;

interface GithubRepositoryApiValue {
  default_branch?: unknown;
  full_name?: unknown;
  html_url?: unknown;
  id?: unknown;
}

interface LocalGitState {
  branch: string | null;
  dirty: boolean;
  head: string | null;
  kind: "not-initialized" | "unborn" | "committed";
  originUrl: string | null;
  statusFingerprint: string;
}

interface ConversionMarker {
  confirmationToken: string;
  jobId: string;
  projectId: string;
  repositoryId: string;
}

class ConversionFailure extends Error {
  constructor(
    readonly conversionError: ProjectGithubConversionError,
    options?: ErrorOptions,
  ) {
    super(conversionError.message, options);
  }
}

function conversionFailure(
  code: ProjectGithubConversionError["code"],
  message: string,
  retryable: boolean,
  cause?: unknown,
): ConversionFailure {
  return new ConversionFailure(
    { code, message: message.slice(0, 4_000), retryable },
    cause === undefined ? undefined : { cause },
  );
}

function repositorySegments(nameWithOwner: string): [string, string] {
  const segments = nameWithOwner.split("/");
  if (
    segments.length !== 2 ||
    segments.some(
      (segment) =>
        !segment ||
        !SAFE_REPOSITORY_SEGMENT.test(segment) ||
        segment === "." ||
        segment === "..",
    )
  ) {
    throw new Error("The GitHub repository identity is invalid.");
  }
  return [segments[0]!, segments[1]!];
}

function normalizedGithubRepository(value: string): string | null {
  const trimmed = value.trim();
  const scp = /^git@github\.com:([^/]+)\/(.+)$/iu.exec(trimmed);
  if (scp) {
    return `${scp[1]}/${scp[2]!.replace(/\.git$/iu, "")}`.toLowerCase();
  }
  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const segments = url.pathname
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

function boundedMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return (message.trim() || fallback).slice(0, 4_000);
}

function blocked(
  projectId: string,
  repository: ProjectGithubConversionRepository,
  error: ProjectGithubConversionError,
): ProjectGithubConversionPreflightResult {
  return projectGithubConversionPreflightResultSchema.parse({
    status: "blocked",
    projectId,
    repository,
    error,
  });
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_LIMIT,
  });
  return stdout.trim();
}

async function runAuthenticatedGit(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", "credential.helper=!gh auth git-credential", ...args],
    {
      encoding: "utf8",
      maxBuffer: GIT_OUTPUT_LIMIT,
    },
  );
  return stdout.trim();
}

async function optionalGit(
  cwd: string,
  args: string[],
): Promise<string | null> {
  try {
    return await runGit(cwd, args);
  } catch {
    return null;
  }
}

async function inspectLocalGit(cwd: string): Promise<LocalGitState> {
  const gitEntry = await lstat(path.join(cwd, ".git")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (!gitEntry) {
    return {
      branch: null,
      dirty: false,
      head: null,
      kind: "not-initialized",
      originUrl: null,
      statusFingerprint: "not-initialized",
    };
  }
  if (!gitEntry.isDirectory() || gitEntry.isSymbolicLink()) {
    throw new Error(
      "The managed folder has a linked or unsafe .git entry. Conversion only accepts a repository rooted directly in this folder.",
    );
  }
  const topLevel = await realpath(
    await runGit(cwd, ["rev-parse", "--show-toplevel"]),
  );
  if (topLevel !== cwd) {
    throw new Error(
      "The local Git repository is rooted outside the managed folder.",
    );
  }
  const remotes = (await runGit(cwd, ["remote"]))
    .split(/\r?\n/gu)
    .filter(Boolean);
  if (remotes.length > 1 || (remotes.length === 1 && remotes[0] !== "origin")) {
    throw new Error(
      "The local Git repository has an ambiguous remote configuration. Conversion accepts no remotes or one remote named origin.",
    );
  }
  const originUrl = remotes.length
    ? await runGit(cwd, ["config", "--get", "remote.origin.url"])
    : null;
  const head = await optionalGit(cwd, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ]);
  const branch =
    (await optionalGit(cwd, ["branch", "--show-current"])) ||
    (head ? null : await optionalGit(cwd, ["symbolic-ref", "--short", "HEAD"]));
  if (head && !branch) {
    throw new Error(
      "The local Git repository has a detached HEAD. Choose a branch before converting.",
    );
  }
  const status = await runGit(cwd, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  return {
    branch: branch || null,
    dirty: Boolean(status),
    head: head?.toLowerCase() ?? null,
    kind: head ? "committed" : "unborn",
    originUrl,
    statusFingerprint: createHash("sha256").update(status).digest("hex"),
  };
}

function confirmationToken(input: {
  local: LocalGitState;
  projectId: string;
  repository: ProjectGithubConversionRepository;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        branch: input.local.branch,
        dirty: input.local.dirty,
        head: input.local.head,
        localState: input.local.kind,
        originUrl: input.local.originUrl,
        projectId: input.projectId,
        repository: input.repository,
        statusFingerprint: input.local.statusFingerprint,
      }),
    )
    .digest("hex");
}

function markerPath(cwd: string): string {
  return path.join(cwd, ".git", "cantrip-conversion.json");
}

async function readConversionMarker(
  cwd: string,
): Promise<ConversionMarker | null> {
  try {
    const value = JSON.parse(
      await readFile(markerPath(cwd), "utf8"),
    ) as Partial<ConversionMarker> | null;
    return value &&
      typeof value.confirmationToken === "string" &&
      typeof value.jobId === "string" &&
      typeof value.projectId === "string" &&
      typeof value.repositoryId === "string"
      ? (value as ConversionMarker)
      : null;
  } catch {
    return null;
  }
}

async function writeConversionMarker(
  cwd: string,
  marker: ConversionMarker,
): Promise<void> {
  await writeFile(markerPath(cwd), JSON.stringify(marker), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export class ProjectGithubConverter {
  constructor(private readonly managedFolders: ManagedFolderManager) {}

  private async githubApi(pathname: string): Promise<unknown> {
    const { stdout } = await execFileAsync("gh", ["api", pathname], {
      encoding: "utf8",
      maxBuffer: GIT_OUTPUT_LIMIT,
    });
    return JSON.parse(stdout) as unknown;
  }

  private async verifiedRepository(
    expected: ProjectGithubConversionRepository,
  ): Promise<{
    defaultBranch: string;
    repository: ProjectGithubConversionRepository;
  }> {
    const [owner, name] = repositorySegments(expected.nameWithOwner);
    const value = (await this.githubApi(
      `repos/${owner}/${name}`,
    )) as GithubRepositoryApiValue;
    const repository = projectGithubConversionRepositorySchema.parse({
      repositoryId: String(value.id),
      nameWithOwner: String(value.full_name),
      url: String(value.html_url),
    });
    if (
      repository.repositoryId !== expected.repositoryId ||
      repository.nameWithOwner.toLowerCase() !==
        expected.nameWithOwner.toLowerCase() ||
      repository.url !== expected.url
    ) {
      throw new Error(
        "The selected GitHub repository identity changed or does not match the worker-visible repository.",
      );
    }
    const defaultBranch = String(value.default_branch || "main").trim();
    if (
      !defaultBranch ||
      defaultBranch.startsWith("-") ||
      defaultBranch.includes("..")
    ) {
      throw new Error("The GitHub repository has an invalid default branch.");
    }
    return { defaultBranch, repository };
  }

  private async repositoryIsEmpty(
    repository: ProjectGithubConversionRepository,
  ): Promise<boolean> {
    const [owner, name] = repositorySegments(repository.nameWithOwner);
    const query =
      "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){isEmpty}}";
    const { stdout } = await execFileAsync(
      "gh",
      [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
      ],
      { encoding: "utf8", maxBuffer: GIT_OUTPUT_LIMIT },
    );
    const result = JSON.parse(stdout) as {
      data?: { repository?: { isEmpty?: unknown } | null };
    };
    if (typeof result.data?.repository?.isEmpty !== "boolean") {
      throw new Error("GitHub did not return the repository history state.");
    }
    return result.data.repository.isEmpty;
  }

  async preflight(input: {
    projectId: string;
    repository: ProjectGithubConversionRepository;
    workspaceStorage?: ProjectWorkspaceStorageContext;
  }): Promise<ProjectGithubConversionPreflightResult> {
    const expected = projectGithubConversionRepositorySchema.parse(
      input.repository,
    );
    let verified: Awaited<
      ReturnType<ProjectGithubConverter["verifiedRepository"]>
    >;
    try {
      verified = await this.verifiedRepository(expected);
    } catch (error) {
      return blocked(input.projectId, expected, {
        code: "repository-unavailable",
        message: boundedMessage(
          error,
          "The worker could not access the selected GitHub repository.",
        ),
        retryable: true,
      });
    }
    let local: LocalGitState;
    try {
      const target = await this.managedFolders.resolve(
        input.projectId,
        input.workspaceStorage ?? { kind: "system" },
      );
      local = await inspectLocalGit(target.path);
    } catch (error) {
      return blocked(input.projectId, verified.repository, {
        code: "local-git-ambiguous",
        message: boundedMessage(
          error,
          "The local Git state is not safe for automatic conversion.",
        ),
        retryable: false,
      });
    }
    if (
      local.originUrl &&
      normalizedGithubRepository(local.originUrl) !==
        verified.repository.nameWithOwner.toLowerCase()
    ) {
      return blocked(input.projectId, verified.repository, {
        code: "local-git-ambiguous",
        message: `The local origin points to ${local.originUrl}, not ${verified.repository.nameWithOwner}.`,
        retryable: false,
      });
    }
    try {
      if (!(await this.repositoryIsEmpty(verified.repository))) {
        return blocked(input.projectId, verified.repository, {
          code: "repository-not-empty",
          message:
            "V1 conversion accepts only a new or empty GitHub repository. Importing or merging existing history must be handled separately.",
          retryable: false,
        });
      }
    } catch (error) {
      return blocked(input.projectId, verified.repository, {
        code: "repository-unavailable",
        message: boundedMessage(
          error,
          "The worker could not inspect the GitHub repository history.",
        ),
        retryable: true,
      });
    }
    const warnings = [
      "Conversion is one-way in V1.",
      "Cantrip will never force-push or merge unrelated remote history.",
    ];
    if (local.dirty && local.head) {
      warnings.push(
        "Uncommitted local changes will remain uncommitted; only the current branch history will be pushed.",
      );
    }
    if (!local.head) {
      warnings.push(
        "An initial commit containing the current folder contents is required before the empty repository can be pushed.",
      );
    }
    return projectGithubConversionPreflightResultSchema.parse({
      status: "ready",
      projectId: input.projectId,
      repository: verified.repository,
      confirmationToken: confirmationToken({
        local,
        projectId: input.projectId,
        repository: verified.repository,
      }),
      localState: local.kind,
      branch: local.branch,
      head: local.head,
      dirty: local.dirty,
      originUrl: local.originUrl,
      requiresInitialCommit: !local.head,
      warnings,
    });
  }

  private async remoteRefs(
    repository: ProjectGithubConversionRepository,
  ): Promise<Map<string, string>> {
    const output = await runAuthenticatedGit([
      "ls-remote",
      "--heads",
      "--tags",
      `https://github.com/${repository.nameWithOwner}.git`,
    ]);
    return new Map(
      output
        .split(/\r?\n/gu)
        .filter(Boolean)
        .map((line) => {
          const [revision, ref] = line.split(/\s+/u);
          if (!revision || !ref)
            throw new Error("Git returned an invalid remote ref.");
          return [ref, revision.toLowerCase()];
        }),
    );
  }

  async execute(input: {
    attempt: number;
    confirmationToken: string;
    initialCommit: { message: string } | null;
    jobId: string;
    projectId: string;
    repository: ProjectGithubConversionRepository;
    workspaceStorage?: ProjectWorkspaceStorageContext;
  }): Promise<ProjectGithubConversionExecutionResult> {
    try {
      return await this.executeReady(input);
    } catch (error) {
      const conversionError =
        error instanceof ConversionFailure
          ? error.conversionError
          : {
              code: "reconciliation-failed" as const,
              message: boundedMessage(
                error,
                "The worker could not reconcile the local folder with GitHub.",
              ),
              retryable: false,
            };
      return projectGithubConversionExecutionResultSchema.parse({
        status: "blocked",
        jobId: input.jobId,
        attempt: input.attempt,
        error: conversionError,
      });
    }
  }

  private async executeReady(input: {
    attempt: number;
    confirmationToken: string;
    initialCommit: { message: string } | null;
    jobId: string;
    projectId: string;
    repository: ProjectGithubConversionRepository;
    workspaceStorage?: ProjectWorkspaceStorageContext;
  }): Promise<ProjectGithubConversionReady> {
    let verified: Awaited<
      ReturnType<ProjectGithubConverter["verifiedRepository"]>
    >;
    try {
      verified = await this.verifiedRepository(input.repository);
    } catch (error) {
      throw conversionFailure(
        "repository-unavailable",
        boundedMessage(
          error,
          "The worker could not access the selected GitHub repository.",
        ),
        true,
        error,
      );
    }
    const target = await this.managedFolders.resolve(
      input.projectId,
      input.workspaceStorage ?? { kind: "system" },
    );
    let local: LocalGitState;
    try {
      local = await inspectLocalGit(target.path);
    } catch (error) {
      throw conversionFailure(
        "local-git-ambiguous",
        boundedMessage(
          error,
          "The local Git state is not safe for automatic conversion.",
        ),
        false,
        error,
      );
    }
    let remoteEmpty: boolean;
    try {
      remoteEmpty = await this.repositoryIsEmpty(verified.repository);
    } catch (error) {
      throw conversionFailure(
        "repository-unavailable",
        boundedMessage(
          error,
          "The worker could not inspect the GitHub repository history.",
        ),
        true,
        error,
      );
    }
    if (remoteEmpty) {
      const currentToken = confirmationToken({
        local,
        projectId: input.projectId,
        repository: verified.repository,
      });
      const marker = await readConversionMarker(target.path);
      const resumable =
        marker?.confirmationToken === input.confirmationToken &&
        marker.jobId === input.jobId &&
        marker.projectId === input.projectId &&
        marker.repositoryId === verified.repository.repositoryId;
      if (currentToken !== input.confirmationToken && !resumable) {
        throw conversionFailure(
          "preflight-changed",
          "The local Git state changed after preflight. Run conversion preflight again before retrying.",
          false,
        );
      }
    }
    if (local.kind === "not-initialized") {
      if (!input.initialCommit) {
        throw conversionFailure(
          "initial-commit-required",
          "This folder has no Git history. Confirm an initial commit before converting.",
          false,
        );
      }
      try {
        await runGit(target.path, ["init", "-b", verified.defaultBranch]);
      } catch (error) {
        throw conversionFailure(
          "git-initialization-failed",
          boundedMessage(error, "Git could not be initialized in the folder."),
          true,
          error,
        );
      }
      local = await inspectLocalGit(target.path);
    }
    await writeConversionMarker(target.path, {
      confirmationToken: input.confirmationToken,
      jobId: input.jobId,
      projectId: input.projectId,
      repositoryId: verified.repository.repositoryId,
    });
    if (
      local.originUrl &&
      normalizedGithubRepository(local.originUrl) !==
        verified.repository.nameWithOwner.toLowerCase()
    ) {
      throw conversionFailure(
        "local-git-ambiguous",
        `The local origin points to ${local.originUrl}, not ${verified.repository.nameWithOwner}.`,
        false,
      );
    }
    if (!local.originUrl) {
      try {
        await runGit(target.path, [
          "remote",
          "add",
          "origin",
          `https://github.com/${verified.repository.nameWithOwner}.git`,
        ]);
      } catch (error) {
        throw conversionFailure(
          "git-initialization-failed",
          boundedMessage(error, "Git could not bind the origin remote."),
          true,
          error,
        );
      }
    }
    if (!local.head) {
      if (!input.initialCommit) {
        throw conversionFailure(
          "initial-commit-required",
          "This repository has no commits. Confirm an initial commit before converting.",
          false,
        );
      }
      try {
        await runGit(target.path, ["add", "--all"]);
        await runGit(target.path, [
          "commit",
          "--allow-empty",
          "-m",
          input.initialCommit.message,
        ]);
      } catch (error) {
        throw conversionFailure(
          "commit-failed",
          boundedMessage(
            error,
            "Git could not create the explicitly approved initial commit.",
          ),
          true,
          error,
        );
      }
      local = await inspectLocalGit(target.path);
    }
    if (!local.head || !local.branch) {
      throw conversionFailure(
        "local-git-ambiguous",
        "Conversion requires a named local branch with at least one commit.",
        false,
      );
    }
    const branchRef = `refs/heads/${local.branch}`;
    if (remoteEmpty) {
      try {
        await runAuthenticatedGit([
          "-C",
          target.path,
          "push",
          "--set-upstream",
          "origin",
          local.branch,
        ]);
      } catch (error) {
        throw conversionFailure(
          "push-failed",
          boundedMessage(
            error,
            "Git could not push the local branch to GitHub.",
          ),
          true,
          error,
        );
      }
    } else {
      let refs: Map<string, string>;
      try {
        refs = await this.remoteRefs(verified.repository);
      } catch (error) {
        throw conversionFailure(
          "repository-unavailable",
          boundedMessage(error, "Git could not inspect the remote refs."),
          true,
          error,
        );
      }
      if (refs.size !== 1 || refs.get(branchRef) !== local.head) {
        throw conversionFailure(
          "repository-not-empty",
          "The GitHub repository gained history that does not exactly match this conversion attempt. Cantrip did not merge or overwrite it.",
          false,
        );
      }
    }
    let refs: Map<string, string>;
    try {
      refs = await this.remoteRefs(verified.repository);
    } catch (error) {
      throw conversionFailure(
        "repository-unavailable",
        boundedMessage(error, "Git could not verify the pushed remote refs."),
        true,
        error,
      );
    }
    if (refs.size !== 1 || refs.get(branchRef) !== local.head) {
      throw conversionFailure(
        "reconciliation-failed",
        "The pushed GitHub branch could not be reconciled exactly. Cantrip did not enable Git capabilities.",
        false,
      );
    }
    const commonDirOutput = await runGit(target.path, [
      "rev-parse",
      "--git-common-dir",
    ]);
    const commonDir = await realpath(
      path.isAbsolute(commonDirOutput)
        ? commonDirOutput
        : path.resolve(target.path, commonDirOutput),
    );
    const policy = await readProjectWorktreePolicy(target.path);
    const ready = projectGithubConversionReadySchema.parse({
      status: "ready",
      jobId: input.jobId,
      attempt: input.attempt,
      repository: verified.repository,
      path: target.path,
      displayPath: target.displayPath,
      repositoryFingerprint: createHash("sha256")
        .update(commonDir)
        .digest("hex"),
      branch: local.branch,
      head: local.head,
      worktreePolicy: policy.policy ?? "agent-managed",
    });
    await rm(markerPath(target.path), { force: true });
    return ready;
  }
}
