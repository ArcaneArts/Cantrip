import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  managedFolderDeleteResultSchema,
  managedFolderMaterializeReadySchema,
  type ManagedFolderDeleteResult,
  type ManagedFolderMaterializeReady,
  type ProjectGithubConversionRepository,
  type ProjectWorkspaceStorageContext,
} from "@cantrip/protocol";

import { canonicalProjectSourcePath } from "./project-source-path.js";
import {
  deriveProjectWorkspaceRoot,
  ensureManagedWorkspaceDirectory,
  type ProjectStoragePathApi,
} from "./project-workspace-storage.js";

const PROJECT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function deriveManagedFolderLocation(
  dataDirectory: string,
  projectId: string,
  storage: ProjectWorkspaceStorageContext = { kind: "system" },
  pathApi: ProjectStoragePathApi = path,
): { displayPath: string; root: string; target: string } {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error("Managed folder commands require a project UUID.");
  }
  const normalizedProjectId = projectId.toLowerCase();
  const workspace = deriveProjectWorkspaceRoot(dataDirectory, storage, pathApi);
  const root = pathApi.join(workspace.root, "folders");
  const target = pathApi.join(root, normalizedProjectId);
  if (pathApi.dirname(target) !== root) {
    throw new Error("Managed folder target escaped its storage root.");
  }
  return {
    displayPath: workspace.displayPrefix
      ? pathApi.join(workspace.displayPrefix, "folders", normalizedProjectId)
      : pathApi.join("folders", normalizedProjectId),
    root,
    target,
  };
}

async function directoryEntry(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class ManagedFolderManager {
  constructor(
    private readonly dataDirectory: string,
    private readonly inspectRepository: (cwd: string) => Promise<{
      github: ProjectGithubConversionRepository | null;
      repositoryFingerprint: string | null;
    }> = async () => ({ github: null, repositoryFingerprint: null }),
  ) {}

  private foldersRoot(storage: ProjectWorkspaceStorageContext): string {
    return path.join(
      deriveProjectWorkspaceRoot(this.dataDirectory, storage).root,
      "folders",
    );
  }

  private async canonicalRoot(
    storage: ProjectWorkspaceStorageContext,
  ): Promise<string> {
    const root =
      storage.kind === "managed"
        ? await ensureManagedWorkspaceDirectory(this.dataDirectory, storage, [
            "folders",
          ])
        : this.foldersRoot(storage);
    if (storage.kind !== "managed") {
      await mkdir(root, { recursive: true, mode: 0o700 });
    }
    const entry = await lstat(root);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("The managed folders root is not a safe directory.");
    }
    return canonicalProjectSourcePath(root);
  }

  private async verifiedTarget(
    projectId: string,
    storage: ProjectWorkspaceStorageContext,
  ): Promise<{
    canonicalRoot: string;
    displayPath: string;
    target: string;
  }> {
    const location = deriveManagedFolderLocation(
      this.dataDirectory,
      projectId,
      storage,
    );
    const canonicalRoot = await this.canonicalRoot(storage);
    return { canonicalRoot, ...location };
  }

  async resolve(
    projectId: string,
    storage: ProjectWorkspaceStorageContext = { kind: "system" },
  ): Promise<{
    displayPath: string;
    path: string;
  }> {
    const { canonicalRoot, displayPath, target } = await this.verifiedTarget(
      projectId,
      storage,
    );
    const entry = await directoryEntry(target);
    if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("The managed folder target is not a safe directory.");
    }
    const canonicalTarget = await canonicalProjectSourcePath(target);
    if (path.dirname(canonicalTarget) !== canonicalRoot) {
      throw new Error("The managed folder target escaped its storage root.");
    }
    return {
      path: canonicalTarget,
      displayPath,
    };
  }

  async materialize(input: {
    attempt: number;
    existingPath?: string;
    jobId: string;
    projectId: string;
    workspaceStorage?: ProjectWorkspaceStorageContext;
  }): Promise<ManagedFolderMaterializeReady> {
    if (input.existingPath) {
      const canonicalTarget = await canonicalProjectSourcePath(
        input.existingPath,
      );
      const targetEntry = await lstat(canonicalTarget);
      if (!targetEntry.isDirectory()) {
        throw new Error("The existing folder path is not a directory.");
      }
      const repository = await this.inspectRepository(canonicalTarget);
      return managedFolderMaterializeReadySchema.parse({
        status: "ready",
        jobId: input.jobId,
        attempt: input.attempt,
        path: canonicalTarget,
        displayPath: input.existingPath,
        reused: true,
        ...repository,
      });
    }
    const { canonicalRoot, displayPath, target } = await this.verifiedTarget(
      input.projectId,
      input.workspaceStorage ?? { kind: "system" },
    );
    const existing = await directoryEntry(target);
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
      throw new Error("The managed folder target is not a safe directory.");
    }
    if (!existing) {
      await mkdir(target, { mode: 0o700 });
      await chmod(target, 0o700).catch((error: unknown) => {
        if (process.platform !== "win32") throw error;
      });
    }
    const targetEntry = await lstat(target);
    if (!targetEntry.isDirectory() || targetEntry.isSymbolicLink()) {
      throw new Error("The managed folder target changed during creation.");
    }
    const canonicalTarget = await canonicalProjectSourcePath(target);
    if (path.dirname(canonicalTarget) !== canonicalRoot) {
      throw new Error("The managed folder target escaped its storage root.");
    }
    return managedFolderMaterializeReadySchema.parse({
      status: "ready",
      jobId: input.jobId,
      attempt: input.attempt,
      path: canonicalTarget,
      displayPath,
      reused: Boolean(existing),
    });
  }

  async delete(
    projectId: string,
    storage: ProjectWorkspaceStorageContext = { kind: "system" },
  ): Promise<ManagedFolderDeleteResult> {
    const { canonicalRoot, target } = await this.verifiedTarget(
      projectId,
      storage,
    );
    const entry = await directoryEntry(target);
    if (!entry) {
      return managedFolderDeleteResultSchema.parse({ deleted: false });
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("The managed folder target is not a safe directory.");
    }
    const canonicalTarget = await canonicalProjectSourcePath(target);
    if (path.dirname(canonicalTarget) !== canonicalRoot) {
      throw new Error("The managed folder target escaped its storage root.");
    }
    await rm(target, { recursive: true, force: false });
    return managedFolderDeleteResultSchema.parse({ deleted: true });
  }
}
