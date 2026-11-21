import { opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  workspaceRootAttachmentSchema,
  type WorkspaceRootAttachment,
  type WorkspaceRootAttachmentErrorCode,
} from "@cantrip/protocol/repository-operation";

import type { WorkerRoutingRegistry } from "./routing-registry.js";

export class WorkspaceRootAttachmentError extends Error {
  constructor(
    readonly code: WorkspaceRootAttachmentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceRootAttachmentError";
  }
}

export async function attachWorkspaceRoot(
  requestedPath: string,
  routingRegistry: Pick<WorkerRoutingRegistry, "protectMetadata">,
): Promise<WorkspaceRootAttachment> {
  const input = requestedPath.trim();
  if (!path.isAbsolute(input)) {
    throw new WorkspaceRootAttachmentError(
      "invalid-root",
      "Workspace root must be an absolute path on the worker.",
    );
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(input);
  } catch {
    throw new WorkspaceRootAttachmentError(
      "root-unavailable",
      "Workspace root does not exist or is inaccessible.",
    );
  }

  let rootStats;
  try {
    rootStats = await stat(canonicalPath);
  } catch {
    throw new WorkspaceRootAttachmentError(
      "root-unavailable",
      "Workspace root is inaccessible.",
    );
  }
  if (!rootStats.isDirectory()) {
    throw new WorkspaceRootAttachmentError(
      "invalid-root",
      "Workspace root is not a directory.",
    );
  }

  try {
    const directory = await opendir(canonicalPath);
    await directory.close();
  } catch {
    throw new WorkspaceRootAttachmentError(
      "root-unavailable",
      "Workspace root is inaccessible.",
    );
  }

  const protectedPaths = await routingRegistry.protectMetadata({
    rootPath: canonicalPath,
    displayPath: canonicalPath,
  });
  return workspaceRootAttachmentSchema.parse({
    rootPathHandle: protectedPaths.rootPath,
    displayHandle: protectedPaths.displayPath,
  });
}
