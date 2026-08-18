import { chmod, lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

import {
  managedFolderDeleteResultSchema,
  managedFolderMaterializeReadySchema,
  type ManagedFolderDeleteResult,
  type ManagedFolderMaterializeReady,
} from "@cantrip/protocol";

const PROJECT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

async function directoryEntry(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class ManagedFolderManager {
  constructor(private readonly dataDirectory: string) {}

  private foldersRoot(): string {
    return path.resolve(this.dataDirectory, "folders");
  }

  private projectPath(projectId: string): string {
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      throw new Error("Managed folder commands require a project UUID.");
    }
    return path.join(this.foldersRoot(), projectId.toLowerCase());
  }

  private async canonicalRoot(): Promise<string> {
    const root = this.foldersRoot();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const entry = await lstat(root);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("The managed folders root is not a safe directory.");
    }
    return realpath(root);
  }

  private async verifiedTarget(projectId: string): Promise<{
    canonicalRoot: string;
    target: string;
  }> {
    const canonicalRoot = await this.canonicalRoot();
    const target = this.projectPath(projectId);
    if (path.dirname(target) !== this.foldersRoot()) {
      throw new Error("Managed folder target escaped its storage root.");
    }
    return { canonicalRoot, target };
  }

  async resolve(projectId: string): Promise<{
    displayPath: string;
    path: string;
  }> {
    const { canonicalRoot, target } = await this.verifiedTarget(projectId);
    const entry = await directoryEntry(target);
    if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("The managed folder target is not a safe directory.");
    }
    const canonicalTarget = await realpath(target);
    if (path.dirname(canonicalTarget) !== canonicalRoot) {
      throw new Error("The managed folder target escaped its storage root.");
    }
    return {
      path: canonicalTarget,
      displayPath: path.join("folders", projectId.toLowerCase()),
    };
  }

  async materialize(input: {
    attempt: number;
    jobId: string;
    projectId: string;
  }): Promise<ManagedFolderMaterializeReady> {
    const { canonicalRoot, target } = await this.verifiedTarget(
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
    const canonicalTarget = await realpath(target);
    if (path.dirname(canonicalTarget) !== canonicalRoot) {
      throw new Error("The managed folder target escaped its storage root.");
    }
    return managedFolderMaterializeReadySchema.parse({
      status: "ready",
      jobId: input.jobId,
      attempt: input.attempt,
      path: canonicalTarget,
      displayPath: path.join("folders", input.projectId.toLowerCase()),
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
    const canonicalTarget = await realpath(target);
    if (path.dirname(canonicalTarget) !== canonicalRoot) {
      throw new Error("The managed folder target escaped its storage root.");
    }
    await rm(target, { recursive: true, force: false });
    return managedFolderDeleteResultSchema.parse({ deleted: true });
  }
}
