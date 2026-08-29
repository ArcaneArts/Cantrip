import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { WorktreeObservationPathReconciliation } from "@cantrip/protocol";

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/u;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/u;
const WINDOWS_UNC = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u;
const WINDOWS_VERBATIM_DRIVE = /^\\\\\?\\([A-Za-z]:[\\/].*)$/u;
const WINDOWS_VERBATIM_UNC = /^\\\\\?\\UNC\\(.+)$/iu;

function windowsNativePath(value: string): string {
  const slashes = value.replaceAll("/", "\\");
  const verbatimUnc = WINDOWS_VERBATIM_UNC.exec(slashes);
  const withoutNamespace = verbatimUnc
    ? `\\\\${verbatimUnc[1]}`
    : (WINDOWS_VERBATIM_DRIVE.exec(slashes)?.[1] ?? slashes);
  if (
    !WINDOWS_DRIVE.test(withoutNamespace) &&
    !WINDOWS_UNC.test(withoutNamespace)
  ) {
    throw new Error("Project source path must be an absolute Windows path.");
  }
  const normalized = path.win32.normalize(withoutNamespace);
  return WINDOWS_DRIVE.test(normalized)
    ? `${normalized[0]!.toUpperCase()}${normalized.slice(1)}`
    : normalized;
}

/**
 * Converts supported path representations into one native absolute form.
 * Windows namespace prefixes are deliberately removed before persistence.
 */
export function normalizeProjectSourcePath(
  input: string,
  platform: NodeJS.Platform = process.platform,
): string {
  let value = input;
  if (/^file:/iu.test(value)) {
    value = fileURLToPath(new URL(value), { windows: platform === "win32" });
  } else if (
    URL_SCHEME.test(value) &&
    !(platform === "win32" && WINDOWS_DRIVE_PREFIX.test(value))
  ) {
    throw new Error("Project source path uses an unsupported URL scheme.");
  }
  if (platform === "win32") return windowsNativePath(value);
  if (!path.posix.isAbsolute(value)) {
    throw new Error("Project source path must be absolute.");
  }
  return path.posix.normalize(value);
}

/** Resolves an existing project directory and returns its canonical native path. */
export async function canonicalProjectSourcePath(
  input: string,
): Promise<string> {
  const requested = normalizeProjectSourcePath(input);
  const canonical = normalizeProjectSourcePath(await realpath(requested));
  const entry = await lstat(canonical);
  if (!entry.isDirectory()) {
    throw new Error("Project source path is not a directory.");
  }
  return canonical;
}

interface ProjectObservationPathTarget {
  projectId?: string;
  sourcePath: string;
  worktreeId?: string;
  worktreePath: string;
}

export async function reconcileProjectObservationPaths<
  Target extends ProjectObservationPathTarget,
>(
  targets: readonly Target[],
): Promise<{
  paths: WorktreeObservationPathReconciliation[];
  targets: Target[];
}> {
  const reconciled = await Promise.all(
    targets.map(async (target) => {
      if (!target.projectId || !target.worktreeId) {
        return { path: null, target };
      }
      try {
        const sourcePath = await canonicalProjectSourcePath(target.sourcePath);
        const worktreePath =
          target.worktreePath === target.sourcePath
            ? sourcePath
            : await canonicalProjectSourcePath(target.worktreePath);
        return {
          path: {
            projectId: target.projectId,
            worktreeId: target.worktreeId,
            sourcePath,
            worktreePath,
          },
          target: { ...target, sourcePath, worktreePath },
        };
      } catch {
        return { path: null, target };
      }
    }),
  );
  return {
    paths: reconciled.flatMap(({ path: resolved }) =>
      resolved ? [resolved] : [],
    ),
    targets: reconciled.map(({ target }) => target),
  };
}
