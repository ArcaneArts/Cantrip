import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  managedFolderDeleteResultSchema,
  managedFolderMaterializeReadySchema,
  type ManagedFolderDeleteResult,
  type ManagedFolderMaterializeReady,
  type ProjectGithubConversionRepository,
} from "@cantrip/protocol";

import { canonicalProjectSourcePath } from "./project-source-path.js";

const PROJECT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type ManagedFolderPathApi = Pick<typeof path, "dirname" | "join" | "resolve">;

export function deriveManagedFolderLocation(
  dataDirectory: string,
  projectId: string,
  pathApi: ManagedFolderPathApi = path,
): { displayPath: string; root: string; target: string } {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error("Managed folder commands require a project UUID.");
  }
  const normalizedProjectId = projectId.toLowerCase();
  const root = pathApi.resolve(dataDirectory, "folders");
  const target = pathApi.join(root, normalizedProjectId);
  if (pathApi.dirname(target) !== root) {
    throw new Error("Managed folder target escaped its storage root.");
  }
  return {
    displayPath: pathApi.join("folders", normalizedProjectId),
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

  private foldersRoot(): string {
    return path.resolve(this.dataDirectory, "folders");
  }

  private async canonicalRoot(): Promise<string> {
    const root = this.foldersRoot();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const entry = await lstat(root);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("The managed folders root is not a safe directory.");
    }
    return canonicalProjectSourcePath(root);
  }

  private async verifiedTarget(projectId: string): Promise<{
    canonicalRoot: string;
    displayPath: string;
    target: string;
  }> {
    const location = deriveManagedFolderLocation(this.dataDirectory, projectId);
    const canonicalRoot = await this.canonicalRoot();
    return { canonicalRoot, ...location };
  }

  async resolve(projectId: string): Promise<{
    displayPath: string;
    path: string;
  }> {
    const { canonicalRoot, displayPath, target } =
      await this.verifiedTarget(projectId);
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

  async delete(projectId: string): Promise<ManagedFolderDeleteResult> {
    const { canonicalRoot, target } = await this.verifiedTarget(projectId);
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
