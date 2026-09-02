import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
  gitCommonDirectory: string;
  relativePath: string;
  repositoryFingerprint: string;
}

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

  const topLevel = await resolveGitPath(
    directory,
    await git(["rev-parse", "--show-toplevel"]),
  );
  if (!pathsEqual(topLevel, directory) || !pathIsWithin(root, topLevel)) {
    return null;
  }
  if ((await git(["rev-parse", "--is-bare-repository"])) !== "false") {
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
  if (!pathsEqual(gitDirectory, gitCommonDirectory)) return null;

  return {
    canonicalPath: topLevel,
    gitCommonDirectory,
    relativePath: portableRelativePath(root, topLevel),
    repositoryFingerprint: createHash("sha256")
      .update(gitCommonDirectory)
      .digest("hex"),
  };
}

export async function discoverWorkspaceRepositories(
  requestedRoot: string,
  overrides: Partial<WorkspaceRepositoryDiscoveryLimits> = {},
): Promise<WorkspaceRepositoryDiscoveryResult> {
  if (!path.isAbsolute(requestedRoot)) {
    throw new Error(
      "Workspace repository discovery requires an absolute root.",
    );
  }
  const requestedMetadata = await lstat(requestedRoot).catch(() => null);
  if (!requestedMetadata?.isDirectory() || requestedMetadata.isSymbolicLink()) {
    throw new Error(
      "Workspace repository discovery root is not an accessible directory.",
    );
  }
  const canonicalRoot = await realpath(requestedRoot);
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
  const fingerprints = new Set<string>();
  let collapsedRepositories = 0;
  let queueIndex = 0;
  let rejectedRepositories = 0;
  let scannedDirectories = 0;
  let scannedEntries = 0;
  let skippedSymlinks = 0;
  let truncated = false;
  let unreadableDirectories = 0;

  scan: while (queueIndex < queue.length) {
    if (remainingDurationMs() <= 0) {
      truncated = true;
      break;
    }
    const directory = queue[queueIndex++]!;
    scannedDirectories += 1;
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
    if (gitMarker) {
      scannedEntries += 1;
      if (scannedEntries > limits.maxEntries) {
        truncated = true;
        break;
      }
      if (gitMarker.isSymbolicLink()) {
        skippedSymlinks += 1;
        rejectedRepositories += 1;
      } else if (gitMarker.isDirectory() || gitMarker.isFile()) {
        try {
          const candidate = await inspectRepositoryRoot(
            directory.canonicalPath,
            canonicalRoot,
            limits,
            remainingDurationMs,
          );
          if (!candidate) {
            rejectedRepositories += 1;
          } else if (fingerprints.has(candidate.repositoryFingerprint)) {
            collapsedRepositories += 1;
          } else if (candidates.length >= limits.maxCandidates) {
            truncated = true;
            break scan;
          } else {
            fingerprints.add(candidate.repositoryFingerprint);
            candidates.push(candidate);
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
  }

  candidates.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
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
