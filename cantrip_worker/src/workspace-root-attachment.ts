import { opendir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  workspaceRootAttachmentSchema,
  type WorkspaceRootAttachment,
} from "@cantrip/protocol/repository-operation";

import type { WorkerRoutingRegistry } from "./routing-registry.js";

export async function attachWorkspaceRoot(
  requestedPath: string,
  routingRegistry: Pick<WorkerRoutingRegistry, "protectMetadata">,
): Promise<WorkspaceRootAttachment> {
  const input = requestedPath.trim();
  if (!path.isAbsolute(input)) {
    throw new Error("Workspace root must be an absolute path on the worker.");
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(input);
  } catch {
    throw new Error("Workspace root does not exist or is inaccessible.");
  }

  try {
    const directory = await opendir(canonicalPath);
    await directory.close();
  } catch {
    throw new Error("Workspace root is not an accessible directory.");
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
