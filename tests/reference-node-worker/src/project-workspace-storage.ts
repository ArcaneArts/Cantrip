import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import type { ProjectWorkspaceStorageContext } from "@cantrip/protocol";

const WORKSPACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type ProjectStoragePathApi = Pick<
  typeof path,
  "dirname" | "join" | "resolve"
>;

export interface ProjectWorkspaceRootLocation {
  displayPrefix: string | null;
  root: string;
}

function safePathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

export function deriveProjectWorkspaceRoot(
  dataDirectory: string,
  storage: ProjectWorkspaceStorageContext,
  pathApi: ProjectStoragePathApi = path,
): ProjectWorkspaceRootLocation {
  if (storage.kind !== "managed") {
    // Attached workspace roots are user-owned and never become an implicit
    // destination. Any additional Cantrip-owned replica keeps the established
    // worker-level placement until a direct path is explicitly supplied.
    return { displayPrefix: null, root: pathApi.resolve(dataDirectory) };
  }
  if (!WORKSPACE_ID_PATTERN.test(storage.workspaceId)) {
    throw new Error("Managed workspace storage requires a workspace UUID.");
  }
  const workspaceId = storage.workspaceId.toLowerCase();
  const parent = pathApi.resolve(dataDirectory, "workspaces");
  const root = pathApi.join(parent, workspaceId);
  if (pathApi.dirname(root) !== parent) {
    throw new Error("Managed workspace root escaped worker storage.");
  }
  return {
    displayPrefix: pathApi.join("workspaces", workspaceId),
    root,
  };
}

export function deriveManagedRepositoryTarget(
  dataDirectory: string,
  storage: ProjectWorkspaceStorageContext,
  owner: string,
  repository: string,
  pathApi: ProjectStoragePathApi = path,
): string {
  const workspace = deriveProjectWorkspaceRoot(dataDirectory, storage, pathApi);
  const repositoriesRoot = pathApi.join(workspace.root, "repositories");
  const ownerRoot = pathApi.join(repositoriesRoot, owner);
  const target = pathApi.join(ownerRoot, repository);
  if (
    pathApi.dirname(ownerRoot) !== repositoriesRoot ||
    pathApi.dirname(target) !== ownerRoot
  ) {
    throw new Error("Managed repository target escaped its storage root.");
  }
  return target;
}

export async function ensureManagedWorkspaceDirectory(
  dataDirectory: string,
  storage: ProjectWorkspaceStorageContext,
  segments: readonly string[],
): Promise<string> {
  if (storage.kind !== "managed") {
    return path.resolve(dataDirectory, ...segments);
  }
  if (segments.some((segment) => !safePathSegment(segment))) {
    throw new Error(
      "Managed workspace storage contains an unsafe path segment.",
    );
  }
  const workspace = deriveProjectWorkspaceRoot(dataDirectory, storage);
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  let current = await realpath(dataDirectory);
  const relativeWorkspaceRoot = path.relative(
    path.resolve(dataDirectory),
    workspace.root,
  );
  const workspaceSegments = relativeWorkspaceRoot.split(path.sep);
  for (const segment of [...workspaceSegments, ...segments]) {
    if (!safePathSegment(segment)) {
      throw new Error(
        "Managed workspace storage contains an unsafe path segment.",
      );
    }
    const next = path.join(current, segment);
    await mkdir(next, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const entry = await lstat(next);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(
        "Managed workspace storage contains an unsafe directory boundary.",
      );
    }
    const canonicalNext = await realpath(next);
    if (path.dirname(canonicalNext) !== current) {
      throw new Error("Managed workspace storage escaped worker storage.");
    }
    current = canonicalNext;
  }
  return current;
}
