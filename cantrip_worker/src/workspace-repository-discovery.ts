import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  projectGithubConversionRepositorySchema,
  type ProjectGithubConversionRepository,
  type WorkspaceRepositoryCandidateDiagnosticCode,
  type WorkspaceRepositoryDetectedClassification,
  type WorkspaceRepositoryDiscoveredClassification,
  type WorkspaceRepositoryDiscoveryProgress,
  type WorkspaceRepositoryImportValidationResult,
} from "@cantrip/protocol";

const execFileAsync = promisify(execFile);

export type WorkspaceRepositoryDiscoveryProgressHandler = (
  progress: WorkspaceRepositoryDiscoveryProgress,
) => void;

export interface WorkspaceRepositoryDiscoveryLimits {
  durationMs: number;
  maxCandidates: number;
  maxDepth: number;
  maxDirectories: number;
  maxEntries: number;
  maxGitOutputBytes: number;
  perGitCommandTimeoutMs: number;
}

export interface WorkspaceRepositoryDiscoveryCandidate {
  canonicalPath: string;
  classification: WorkspaceRepositoryDiscoveredClassification;
  diagnosticCode: WorkspaceRepositoryCandidateDiagnosticCode | null;
  gitCommonDirectory: string;
  github: ProjectGithubConversionRepository | null;
  originUrl: string | null;
  relativePath: string;
  repositoryFingerprint: string;
}

export interface WorkspaceRepositoryOriginClassification {
  classification: WorkspaceRepositoryDetectedClassification;
  diagnosticCode: WorkspaceRepositoryCandidateDiagnosticCode | null;
  github: ProjectGithubConversionRepository | null;
  originUrl: string | null;
}

export type WorkspaceRepositoryGithubApiRunner = (
  nameWithOwner: string,
  options: { maxBuffer: number; timeout: number },
) => Promise<unknown>;

export interface WorkspaceRepositoryDiscoveryResult {
  candidates: WorkspaceRepositoryDiscoveryCandidate[];
  canonicalRoot: string;
  collapsedRepositories: number;
  unreadableDirectories: number;
  rejectedRepositories: number;
  scannedDirectories: number;
  scannedEntries: number;
  skippedSymlinks: number;
  truncated: boolean;
}

interface SearchDirectory {
  canonicalPath: string;
  depth: number;
}

const DEFAULT_LIMITS: WorkspaceRepositoryDiscoveryLimits = {
  durationMs: 30_000,
  maxCandidates: 500,
  maxDepth: 3,
  maxDirectories: 10_000,
  maxEntries: 100_000,
  maxGitOutputBytes: 1_024 * 1_024,
  perGitCommandTimeoutMs: 5_000,
};

function rootUnavailable(message: string): Error {
  return Object.assign(new Error(message), { code: "root-unavailable" });
}

function importValidationError(
  code: "repository-unavailable" | "repository-changed",
  message: string,
): Error {
  return Object.assign(new Error(message), { code });
}

function boundedInteger(value: number, minimum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.floor(value));
}

function comparablePath(value: string): string {
  const normalized = path.normalize(value);
  if (process.platform !== "win32") return normalized;
  const withoutNamespace = normalized.startsWith("\\\\?\\UNC\\")
    ? `\\\\${normalized.slice(8)}`
    : normalized.startsWith("\\\\?\\")
      ? normalized.slice(4)
      : normalized;
  return withoutNamespace.toLowerCase();
}

function pathsEqual(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
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

function portableRelativePath(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  return relative ? relative.split(path.sep).join("/") : ".";
}

function repositoryFingerprint(gitCommonDirectory: string): string {
  return createHash("sha256").update(gitCommonDirectory).digest("hex");
}

export function parseGithubRepositoryOrigin(
  value: string,
): { nameWithOwner: string; url: string } | null {
  const origin = value.trim();
  const match =
    origin.match(
      /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,99})\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/iu,
    ) ??
    origin.match(
      /^git@github\.com:([A-Za-z0-9][A-Za-z0-9-]{0,99})\/([A-Za-z0-9._-]+?)(?:\.git)?$/iu,
    ) ??
    origin.match(
      /^ssh:\/\/git@github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,99})\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/iu,
    );
  const owner = match?.[1];
  const repository = match?.[2];
  if (!owner || !repository || repository === "." || repository === "..") {
    return null;
  }
  const nameWithOwner = `${owner}/${repository}`;
  return {
    nameWithOwner,
    url: `https://github.com/${nameWithOwner}`,
  };
}

async function defaultGithubApiRunner(
  nameWithOwner: string,
  options: { maxBuffer: number; timeout: number },
): Promise<unknown> {
  const { stdout } = await execFileAsync(
    "gh",
    ["api", `repos/${nameWithOwner}`],
    {
      encoding: "utf8",
      ...options,
    },
  );
  return JSON.parse(stdout) as unknown;
}

export async function classifyWorkspaceRepositoryOrigin(
  originUrl: string | null,
  options: {
    githubApi?: WorkspaceRepositoryGithubApiRunner;
    maxBuffer: number;
    timeout: number;
  },
): Promise<WorkspaceRepositoryOriginClassification> {
  const origin = originUrl?.trim() || null;
  if (!origin) {
    return {
      classification: "local-git",
      diagnosticCode: null,
      github: null,
      originUrl: null,
    };
  }
  if (origin.length > 32_768) {
    return {
      classification: "local-git",
      diagnosticCode: "origin-invalid",
      github: null,
      originUrl: null,
    };
  }
  const expected = parseGithubRepositoryOrigin(origin);
  if (!expected) {
    return {
      classification: "local-git",
      diagnosticCode: null,
      github: null,
      originUrl: origin,
    };
  }
  try {
    const value = await (options.githubApi ?? defaultGithubApiRunner)(
      expected.nameWithOwner,
      { maxBuffer: options.maxBuffer, timeout: options.timeout },
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        classification: "github-unavailable",
        diagnosticCode: "github-api-invalid",
        github: null,
        originUrl: origin,
      };
    }
    const record = value as Record<string, unknown>;
    const repository = projectGithubConversionRepositorySchema.safeParse({
      repositoryId:
        typeof record.id === "number" || typeof record.id === "string"
          ? String(record.id)
          : "",
      nameWithOwner: record.full_name,
      url: record.html_url,
    });
    const apiOrigin =
      repository.success && parseGithubRepositoryOrigin(repository.data.url);
    if (
      !repository.success ||
      !apiOrigin ||
      repository.data.nameWithOwner.toLowerCase() !==
        expected.nameWithOwner.toLowerCase() ||
      apiOrigin.nameWithOwner.toLowerCase() !==
        expected.nameWithOwner.toLowerCase()
    ) {
      return {
        classification: "github-unavailable",
        diagnosticCode: "github-identity-mismatch",
        github: null,
        originUrl: origin,
      };
    }
    return {
      classification: "github-accessible",
      diagnosticCode: null,
      github: repository.data,
      originUrl: origin,
    };
  } catch (error) {
    const code =
      error && typeof error === "object" ? Reflect.get(error, "code") : null;
    return {
      classification: "github-unavailable",
      diagnosticCode:
        code === "ENOENT" ? "github-cli-unavailable" : "github-api-unavailable",
      github: null,
      originUrl: origin,
    };
  }
}

async function resolveGitPath(
  checkout: string,
  value: string,
): Promise<string> {
  return realpath(
    path.isAbsolute(value) ? value : path.resolve(checkout, value),
  );
}

async function inspectRepositoryRoot(
  directory: string,
  root: string,
  limits: WorkspaceRepositoryDiscoveryLimits,
  remainingDurationMs: () => number,
): Promise<WorkspaceRepositoryDiscoveryCandidate | null> {
  const git = async (arguments_: string[]): Promise<string> => {
    const timeout = Math.max(
      1,
      Math.min(limits.perGitCommandTimeoutMs, remainingDurationMs()),
    );
    if (remainingDurationMs() <= 0) {
      throw new Error("Workspace repository discovery expired.");
    }
    const { stdout } = await execFileAsync(
      "git",
      ["-C", directory, ...arguments_],
      {
        encoding: "utf8",
        maxBuffer: limits.maxGitOutputBytes,
        timeout,
      },
    );
    return stdout.trim();
  };

  const bare = await git(["rev-parse", "--is-bare-repository"]);
  if (bare === "true") {
    const gitCommonDirectory = await resolveGitPath(
      directory,
      await git(["rev-parse", "--git-common-dir"]),
    );
    return {
      canonicalPath: directory,
      classification: "unsupported",
      diagnosticCode: "bare-repository",
      gitCommonDirectory,
      github: null,
      originUrl: null,
      relativePath: portableRelativePath(root, directory),
      repositoryFingerprint: repositoryFingerprint(gitCommonDirectory),
    };
  }
  if (bare !== "false") return null;

  const topLevel = await resolveGitPath(
    directory,
    await git(["rev-parse", "--show-toplevel"]),
  );
  if (!pathsEqual(topLevel, directory) || !pathIsWithin(root, topLevel)) {
    return null;
  }
  const gitDirectory = await resolveGitPath(
    directory,
    await git(["rev-parse", "--git-dir"]),
  );
  const gitCommonDirectory = await resolveGitPath(
    directory,
    await git(["rev-parse", "--git-common-dir"]),
  );
  if (!pathsEqual(gitDirectory, gitCommonDirectory)) {
    return {
      canonicalPath: topLevel,
      classification: "unsupported",
      diagnosticCode: "linked-worktree",
      gitCommonDirectory,
      github: null,
      originUrl: null,
      relativePath: portableRelativePath(root, topLevel),
      repositoryFingerprint: repositoryFingerprint(gitCommonDirectory),
    };
  }

  let originUrl: string | null = null;
  let originReadFailed = false;
  try {
    originUrl = await git(["config", "--get", "remote.origin.url"]);
  } catch (error) {
    const code =
      error && typeof error === "object" ? Reflect.get(error, "code") : null;
    if (code !== 1) originReadFailed = true;
  }
  const classification = originReadFailed
    ? {
        classification: "local-git" as const,
        diagnosticCode: "origin-unavailable" as const,
        github: null,
        originUrl: null,
      }
    : await classifyWorkspaceRepositoryOrigin(originUrl, {
        maxBuffer: limits.maxGitOutputBytes,
        timeout: Math.max(
          1,
          Math.min(limits.perGitCommandTimeoutMs, remainingDurationMs()),
        ),
      });

  return {
    canonicalPath: topLevel,
    ...classification,
    gitCommonDirectory,
    relativePath: portableRelativePath(root, topLevel),
    repositoryFingerprint: repositoryFingerprint(gitCommonDirectory),
  };
}

export async function validateWorkspaceRepositoryImport(input: {
  attempt: number;
  candidateId: string;
  expectedRepositoryFingerprint: string;
  path: string;
  rootPath: string;
}): Promise<WorkspaceRepositoryImportValidationResult> {
  if (!path.isAbsolute(input.rootPath)) {
    throw importValidationError(
      "repository-unavailable",
      "The attached workspace root is not absolute.",
    );
  }
  const rootMetadata = await lstat(input.rootPath).catch(() => null);
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw importValidationError(
      "repository-unavailable",
      "The attached workspace root is no longer accessible.",
    );
  }
  const canonicalRoot = await realpath(input.rootPath).catch(() => null);
  if (!canonicalRoot) {
    throw importValidationError(
      "repository-unavailable",
      "The attached workspace root could not be resolved.",
    );
  }
  if (!path.isAbsolute(input.path)) {
    throw importValidationError(
      "repository-unavailable",
      "The repository import path is not absolute.",
    );
  }
  const metadata = await lstat(input.path).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw importValidationError(
      "repository-unavailable",
      "The repository import path is no longer an accessible directory.",
    );
  }
  const canonicalPath = await realpath(input.path).catch(() => null);
  if (!canonicalPath || !pathIsWithin(canonicalRoot, canonicalPath)) {
    throw importValidationError(
      "repository-unavailable",
      "The repository import path is outside the attached workspace root.",
    );
  }
  let candidate: WorkspaceRepositoryDiscoveryCandidate | null;
  try {
    candidate = await inspectRepositoryRoot(
      canonicalPath,
      canonicalRoot,
      DEFAULT_LIMITS,
      () => DEFAULT_LIMITS.durationMs,
    );
  } catch {
    throw importValidationError(
      "repository-unavailable",
      "The repository import path is no longer an attachable Git checkout.",
    );
  }
  if (!candidate) {
    throw importValidationError(
      "repository-unavailable",
      "The repository import path is no longer a primary Git checkout.",
    );
  }
  if (candidate.classification === "unsupported") {
    throw importValidationError(
      "repository-unavailable",
      "The repository import path is not an importable primary Git checkout.",
    );
  }
  if (candidate.repositoryFingerprint !== input.expectedRepositoryFingerprint) {
    throw importValidationError(
      "repository-changed",
      "The repository checkout changed after discovery.",
    );
  }
  const git = async (arguments_: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", canonicalPath, ...arguments_],
        {
          encoding: "utf8",
          maxBuffer: DEFAULT_LIMITS.maxGitOutputBytes,
          timeout: DEFAULT_LIMITS.perGitCommandTimeoutMs,
        },
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  };
  return {
    candidateId: input.candidateId,
    attempt: input.attempt,
    path: candidate.canonicalPath,
    displayPath: candidate.canonicalPath,
    originUrl: candidate.originUrl,
    github: candidate.github,
    repositoryFingerprint: candidate.repositoryFingerprint,
    classification: candidate.classification,
    diagnosticCode: candidate.diagnosticCode,
    branch: await git(["symbolic-ref", "--quiet", "--short", "HEAD"]),
    head: await git(["rev-parse", "--verify", "HEAD"]),
  };
}

export async function discoverWorkspaceRepositories(
  requestedRoot: string,
  overrides: Partial<WorkspaceRepositoryDiscoveryLimits> = {},
  onProgress: WorkspaceRepositoryDiscoveryProgressHandler = () => undefined,
): Promise<WorkspaceRepositoryDiscoveryResult> {
  if (!path.isAbsolute(requestedRoot)) {
    throw rootUnavailable(
      "Workspace repository discovery requires an absolute root.",
    );
  }
  const requestedMetadata = await lstat(requestedRoot).catch(() => null);
  if (!requestedMetadata?.isDirectory() || requestedMetadata.isSymbolicLink()) {
    throw rootUnavailable(
      "Workspace repository discovery root is not an accessible directory.",
    );
  }
  const canonicalRoot = await realpath(requestedRoot).catch(() => {
    throw rootUnavailable(
      "Workspace repository discovery root could not be resolved.",
    );
  });
  const limits: WorkspaceRepositoryDiscoveryLimits = {
    durationMs: boundedInteger(
      overrides.durationMs ?? DEFAULT_LIMITS.durationMs,
      1,
    ),
    maxCandidates: boundedInteger(
      overrides.maxCandidates ?? DEFAULT_LIMITS.maxCandidates,
      1,
    ),
    maxDepth: boundedInteger(overrides.maxDepth ?? DEFAULT_LIMITS.maxDepth, 0),
    maxDirectories: boundedInteger(
      overrides.maxDirectories ?? DEFAULT_LIMITS.maxDirectories,
      1,
    ),
    maxEntries: boundedInteger(
      overrides.maxEntries ?? DEFAULT_LIMITS.maxEntries,
      1,
    ),
    maxGitOutputBytes: boundedInteger(
      overrides.maxGitOutputBytes ?? DEFAULT_LIMITS.maxGitOutputBytes,
      1_024,
    ),
    perGitCommandTimeoutMs: boundedInteger(
      overrides.perGitCommandTimeoutMs ?? DEFAULT_LIMITS.perGitCommandTimeoutMs,
      1,
    ),
  };
  const startedAt = Date.now();
  const remainingDurationMs = () =>
    Math.max(0, limits.durationMs - (Date.now() - startedAt));
  const queue: SearchDirectory[] = [{ canonicalPath: canonicalRoot, depth: 0 }];
  const candidates: WorkspaceRepositoryDiscoveryCandidate[] = [];
  const candidateIndexByFingerprint = new Map<string, number>();
  let collapsedRepositories = 0;
  let queueIndex = 0;
  let rejectedRepositories = 0;
  let scannedDirectories = 0;
  let scannedEntries = 0;
  let skippedSymlinks = 0;
  let truncated = false;
  let unreadableDirectories = 0;
  let lastProgressAt = 0;
  const reportProgress = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 250) return;
    lastProgressAt = now;
    onProgress({
      counts: {
        candidates: candidates.length,
        collapsedRepositories,
        rejectedRepositories,
        scannedDirectories,
        scannedEntries,
        skippedSymlinks,
        unreadableDirectories,
      },
      diagnosticCode: truncated ? "scan-truncated" : null,
      truncated,
    });
  };
  reportProgress(true);

  scan: while (queueIndex < queue.length) {
    if (remainingDurationMs() <= 0) {
      truncated = true;
      break;
    }
    const directory = queue[queueIndex++]!;
    scannedDirectories += 1;
    reportProgress();
    let entries;
    try {
      entries = await readdir(directory.canonicalPath, {
        withFileTypes: true,
      });
    } catch {
      unreadableDirectories += 1;
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const gitMarker = entries.find((entry) => entry.name === ".git");
    const bareMarkers = ["HEAD", "objects", "refs"].map((name) =>
      entries.find((entry) => entry.name === name),
    );
    const possibleBareRepository =
      bareMarkers[0]?.isFile() === true &&
      bareMarkers[1]?.isDirectory() === true &&
      bareMarkers[2]?.isDirectory() === true;
    if (gitMarker || possibleBareRepository) {
      scannedEntries += gitMarker ? 1 : bareMarkers.length;
      if (scannedEntries > limits.maxEntries) {
        truncated = true;
        break;
      }
      if (gitMarker?.isSymbolicLink()) {
        skippedSymlinks += 1;
        rejectedRepositories += 1;
      } else if (
        (gitMarker && (gitMarker.isDirectory() || gitMarker.isFile())) ||
        possibleBareRepository
      ) {
        try {
          const candidate = await inspectRepositoryRoot(
            directory.canonicalPath,
            canonicalRoot,
            limits,
            remainingDurationMs,
          );
          if (!candidate) {
            rejectedRepositories += 1;
          } else {
            if (candidate.classification === "unsupported") {
              rejectedRepositories += 1;
            }
            const existingIndex = candidateIndexByFingerprint.get(
              candidate.repositoryFingerprint,
            );
            if (existingIndex !== undefined) {
              collapsedRepositories += 1;
              const existing = candidates[existingIndex]!;
              if (
                existing.classification === "unsupported" &&
                candidate.classification !== "unsupported"
              ) {
                candidates[existingIndex] = candidate;
              }
            } else if (candidates.length >= limits.maxCandidates) {
              truncated = true;
              break scan;
            } else {
              candidateIndexByFingerprint.set(
                candidate.repositoryFingerprint,
                candidates.length,
              );
              candidates.push(candidate);
            }
            if (remainingDurationMs() <= 0) {
              truncated = true;
              break scan;
            }
          }
        } catch {
          rejectedRepositories += 1;
          if (remainingDurationMs() <= 0) {
            truncated = true;
            break scan;
          }
        }
      } else {
        rejectedRepositories += 1;
      }
      // A Git marker is a traversal boundary even when the checkout is invalid.
      reportProgress();
      continue;
    }

    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries > limits.maxEntries) {
        truncated = true;
        break scan;
      }
      if (entry.isSymbolicLink()) {
        skippedSymlinks += 1;
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (directory.depth >= limits.maxDepth) {
        truncated = true;
        continue;
      }
      const entryPath = path.join(directory.canonicalPath, entry.name);
      try {
        const metadata = await lstat(entryPath);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          if (metadata.isSymbolicLink()) skippedSymlinks += 1;
          continue;
        }
        const canonicalPath = await realpath(entryPath);
        if (
          !pathIsWithin(canonicalRoot, canonicalPath) ||
          !pathsEqual(entryPath, canonicalPath)
        ) {
          skippedSymlinks += 1;
          continue;
        }
        if (queue.length >= limits.maxDirectories) {
          truncated = true;
          continue;
        }
        queue.push({
          canonicalPath,
          depth: directory.depth + 1,
        });
      } catch {
        continue;
      }
    }
    reportProgress();
  }

  candidates.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  reportProgress(true);
  return {
    candidates,
    canonicalRoot,
    collapsedRepositories,
    unreadableDirectories,
    rejectedRepositories,
    scannedDirectories,
    scannedEntries,
    skippedSymlinks,
    truncated,
  };
}
