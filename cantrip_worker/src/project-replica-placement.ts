import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type {
  ProjectReplicaOwnershipKind,
  ProjectReplicaPlacementMode,
  ProjectReplicaPlacementRequest,
} from "@cantrip/protocol";

const REGISTRY_VERSION = 1 as const;
const OWNER_MARKER_NAME = "cantrip-project-owner.json";
const MAX_PATH_LENGTH = 8_192;

interface PlacementRecord {
  canonicalPath: string;
  createdAt: string;
  mode: ProjectReplicaPlacementMode;
  ownership: ProjectReplicaOwnershipKind;
  projectId: string;
  repositoryFingerprint: string;
  requestedPath: string;
  workerId: string;
}

interface PlacementRegistry {
  records: PlacementRecord[];
  version: typeof REGISTRY_VERSION;
}

interface OwnershipMarker {
  createdBy: "cantrip";
  projectId: string;
  repositoryFingerprint: string;
  version: typeof REGISTRY_VERSION;
  workerId: string;
}

interface StagingMarker {
  jobId: string;
  projectId: string;
  version: typeof REGISTRY_VERSION;
  workerId: string;
}

export interface PreparedReplicaPlacement {
  exists: boolean;
  mode: ProjectReplicaPlacementMode;
  requestedPath: string | null;
  stagingPath: string;
  targetPath: string;
}

export class ProjectReplicaPlacementError extends Error {
  constructor(
    readonly code:
      | "placement-unsupported"
      | "path-invalid"
      | "path-permission-denied"
      | "parent-creation-failed"
      | "target-type-mismatch"
      | "target-owned-by-another-project"
      | "ownership-proof-missing",
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isPermissionFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM" || code === "EROFS";
}

function parseRecord(value: unknown): PlacementRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid project replica placement record.");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.projectId !== "string" ||
    !record.projectId ||
    typeof record.workerId !== "string" ||
    !record.workerId ||
    typeof record.repositoryFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.repositoryFingerprint) ||
    typeof record.canonicalPath !== "string" ||
    !record.canonicalPath ||
    record.canonicalPath.length > MAX_PATH_LENGTH ||
    typeof record.requestedPath !== "string" ||
    !record.requestedPath ||
    record.requestedPath.length > MAX_PATH_LENGTH ||
    (record.mode !== "direct" && record.mode !== "managed-link") ||
    (record.ownership !== "cantrip" && record.ownership !== "user") ||
    typeof record.createdAt !== "string"
  ) {
    throw new Error("Invalid project replica placement record.");
  }
  return {
    canonicalPath: record.canonicalPath,
    createdAt: record.createdAt,
    mode: record.mode,
    ownership: record.ownership,
    projectId: record.projectId,
    repositoryFingerprint: record.repositoryFingerprint,
    requestedPath: record.requestedPath,
    workerId: record.workerId,
  };
}

function parseRegistry(value: unknown): PlacementRegistry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid project replica placement registry.");
  }
  const registry = value as Record<string, unknown>;
  if (
    registry.version !== REGISTRY_VERSION ||
    !Array.isArray(registry.records)
  ) {
    throw new Error("Invalid project replica placement registry.");
  }
  return {
    version: REGISTRY_VERSION,
    records: registry.records.map(parseRecord),
  };
}

function parseOwnershipMarker(value: unknown): OwnershipMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const marker = value as Record<string, unknown>;
  return marker.version === REGISTRY_VERSION &&
    marker.createdBy === "cantrip" &&
    typeof marker.projectId === "string" &&
    typeof marker.workerId === "string" &&
    typeof marker.repositoryFingerprint === "string" &&
    /^[0-9a-f]{64}$/u.test(marker.repositoryFingerprint)
    ? {
        version: REGISTRY_VERSION,
        createdBy: "cantrip",
        projectId: marker.projectId,
        workerId: marker.workerId,
        repositoryFingerprint: marker.repositoryFingerprint,
      }
    : null;
}

async function existingStats(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export class ProjectReplicaPlacementManager {
  readonly #registryPath: string;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataDirectory: string,
    private readonly workerId: string,
  ) {
    this.#registryPath = path.join(
      dataDirectory,
      "project-replica-placements.json",
    );
  }

  async prepare(input: {
    jobId: string;
    managedTarget: string;
    placement: ProjectReplicaPlacementRequest;
    projectId: string;
  }): Promise<PreparedReplicaPlacement> {
    if (input.placement.mode === "managed") {
      await mkdir(path.dirname(input.managedTarget), {
        recursive: true,
        mode: 0o700,
      });
      return {
        exists: (await existingStats(input.managedTarget)) !== null,
        mode: "managed",
        requestedPath: null,
        stagingPath: `${input.managedTarget}.cantrip-provision-${input.jobId}`,
        targetPath: input.managedTarget,
      };
    }
    if (input.placement.mode !== "direct") {
      throw new ProjectReplicaPlacementError(
        "placement-unsupported",
        "Managed-link placement is not available on this worker yet.",
      );
    }

    const requestedPath = this.#validateRequestedPath(input.placement.path);
    let targetPath: string;
    let exists: boolean;
    const finalStats = await existingStats(requestedPath);
    if (finalStats) {
      if (!finalStats.isDirectory() && !finalStats.isSymbolicLink()) {
        throw new ProjectReplicaPlacementError(
          "target-type-mismatch",
          "The requested repository target already exists and is not a directory.",
        );
      }
      try {
        targetPath = await realpath(requestedPath);
        if (!(await stat(targetPath)).isDirectory()) {
          throw new ProjectReplicaPlacementError(
            "target-type-mismatch",
            "The requested repository target does not resolve to a directory.",
          );
        }
      } catch (error) {
        if (error instanceof ProjectReplicaPlacementError) throw error;
        throw new ProjectReplicaPlacementError(
          isPermissionFailure(error)
            ? "path-permission-denied"
            : "target-type-mismatch",
          "The requested repository target could not be resolved safely.",
        );
      }
      exists = true;
    } else {
      const canonicalParent = await this.#ensureParents(
        path.dirname(requestedPath),
      );
      targetPath = path.join(canonicalParent, path.basename(requestedPath));
      exists = false;
    }

    const collision = (await this.#readRegistry()).records.find(
      (record) => record.canonicalPath === targetPath,
    );
    if (collision && collision.projectId !== input.projectId) {
      throw new ProjectReplicaPlacementError(
        "target-owned-by-another-project",
        "The requested repository target is already attached to another Cantrip project.",
      );
    }

    return {
      exists,
      mode: "direct",
      requestedPath,
      stagingPath: `${targetPath}.cantrip-provision-${input.jobId}`,
      targetPath,
    };
  }

  async claimStaging(input: {
    jobId: string;
    projectId: string;
    stagingPath: string;
  }): Promise<void> {
    const markerPath = this.#stagingMarkerPath(input.stagingPath);
    const existing = await existingStats(input.stagingPath);
    if (existing) {
      const marker = await this.#readStagingMarker(markerPath);
      if (
        !marker ||
        marker.jobId !== input.jobId ||
        marker.projectId !== input.projectId ||
        marker.workerId !== this.workerId
      ) {
        throw new ProjectReplicaPlacementError(
          "target-type-mismatch",
          "The repository staging path already exists and is not owned by this job.",
        );
      }
      await rm(input.stagingPath, { recursive: true, force: true });
    }
    await mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });
    await writeFile(
      markerPath,
      `${JSON.stringify({
        version: REGISTRY_VERSION,
        jobId: input.jobId,
        projectId: input.projectId,
        workerId: this.workerId,
      } satisfies StagingMarker)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    ).catch(async (error: unknown) => {
      const marker = await this.#readStagingMarker(markerPath);
      if (
        !marker ||
        marker.jobId !== input.jobId ||
        marker.projectId !== input.projectId ||
        marker.workerId !== this.workerId
      ) {
        throw error;
      }
    });
  }

  async cleanupStaging(input: {
    jobId: string;
    projectId: string;
    stagingPath: string;
  }): Promise<void> {
    const markerPath = this.#stagingMarkerPath(input.stagingPath);
    const marker = await this.#readStagingMarker(markerPath);
    if (
      !marker ||
      marker.jobId !== input.jobId ||
      marker.projectId !== input.projectId ||
      marker.workerId !== this.workerId
    ) {
      return;
    }
    await rm(input.stagingPath, { recursive: true, force: true });
    await rm(markerPath, { force: true });
  }

  async writeCreatedMarker(input: {
    gitCommonDir: string;
    projectId: string;
    repositoryFingerprint: string;
  }): Promise<void> {
    const markerPath = path.join(input.gitCommonDir, OWNER_MARKER_NAME);
    const temporaryPath = `${markerPath}.${randomUUID()}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify({
        version: REGISTRY_VERSION,
        createdBy: "cantrip",
        projectId: input.projectId,
        workerId: this.workerId,
        repositoryFingerprint: input.repositoryFingerprint,
      } satisfies OwnershipMarker)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await rename(temporaryPath, markerPath);
  }

  async classifyExisting(input: {
    canonicalPath: string;
    gitCommonDir: string;
    projectId: string;
    repositoryFingerprint: string;
  }): Promise<ProjectReplicaOwnershipKind> {
    const registry = await this.#readRegistry();
    const record = registry.records.find(
      (candidate) => candidate.canonicalPath === input.canonicalPath,
    );
    if (record && record.projectId !== input.projectId) {
      throw new ProjectReplicaPlacementError(
        "target-owned-by-another-project",
        "The requested repository target is already attached to another Cantrip project.",
      );
    }
    const marker = await this.#readOwnershipMarker(input.gitCommonDir);
    const markerPath = path.join(input.gitCommonDir, OWNER_MARKER_NAME);
    if (!marker && (await existingStats(markerPath))) {
      throw new ProjectReplicaPlacementError(
        "ownership-proof-missing",
        "The checkout contains invalid Cantrip ownership metadata.",
      );
    }
    if (marker && marker.projectId !== input.projectId) {
      throw new ProjectReplicaPlacementError(
        "target-owned-by-another-project",
        "The requested repository target is owned by another Cantrip project.",
      );
    }
    if (
      marker &&
      (marker.workerId !== this.workerId ||
        marker.repositoryFingerprint !== input.repositoryFingerprint)
    ) {
      throw new ProjectReplicaPlacementError(
        "ownership-proof-missing",
        "Cantrip ownership metadata does not match this repository checkout.",
      );
    }
    const markerMatches =
      marker?.projectId === input.projectId &&
      marker.workerId === this.workerId &&
      marker.repositoryFingerprint === input.repositoryFingerprint;
    if (markerMatches) return "cantrip";
    if (record?.ownership === "cantrip") {
      throw new ProjectReplicaPlacementError(
        "ownership-proof-missing",
        "Cantrip ownership metadata no longer matches this repository checkout.",
      );
    }
    return "user";
  }

  async record(input: Omit<PlacementRecord, "workerId">): Promise<void> {
    await this.#serializeWrite(async () => {
      const registry = await this.#readRegistry();
      const collision = registry.records.find(
        (candidate) => candidate.canonicalPath === input.canonicalPath,
      );
      if (collision && collision.projectId !== input.projectId) {
        throw new ProjectReplicaPlacementError(
          "target-owned-by-another-project",
          "The requested repository target is already attached to another Cantrip project.",
        );
      }
      const records = registry.records.filter(
        (candidate) => candidate.projectId !== input.projectId,
      );
      records.push({ ...input, workerId: this.workerId });
      await this.#writeRegistry({ version: REGISTRY_VERSION, records });
    });
  }

  #validateRequestedPath(value: string): string {
    const trimmed = value.trim();
    if (
      !trimmed ||
      trimmed.length > MAX_PATH_LENGTH ||
      trimmed.includes("\0") ||
      !path.isAbsolute(trimmed) ||
      /[\\/]$/u.test(trimmed)
    ) {
      throw new ProjectReplicaPlacementError(
        "path-invalid",
        "The repository placement must be an exact absolute worker path.",
      );
    }
    const finalLexicalPart = trimmed.split(/[\\/]/u).at(-1);
    if (finalLexicalPart === "." || finalLexicalPart === "..") {
      throw new ProjectReplicaPlacementError(
        "path-invalid",
        "The repository placement cannot end in '.' or '..'.",
      );
    }
    const normalized = path.normalize(trimmed);
    if (normalized === path.parse(normalized).root) {
      throw new ProjectReplicaPlacementError(
        "path-invalid",
        "A filesystem root cannot be used as a repository placement.",
      );
    }
    return normalized;
  }

  async #ensureParents(parentPath: string): Promise<string> {
    const missing: string[] = [];
    let ancestor = parentPath;
    while (!(await existingStats(ancestor))) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        throw new ProjectReplicaPlacementError(
          "parent-creation-failed",
          "No existing ancestor could be found for the repository placement.",
        );
      }
      missing.push(path.basename(ancestor));
      ancestor = parent;
    }

    let canonicalParent: string;
    try {
      canonicalParent = await realpath(ancestor);
      if (!(await stat(canonicalParent)).isDirectory()) {
        throw new Error("Ancestor is not a directory.");
      }
      for (const component of missing.reverse()) {
        const next = path.join(canonicalParent, component);
        try {
          await mkdir(next, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const metadata = await lstat(next);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw new ProjectReplicaPlacementError(
            "parent-creation-failed",
            "A repository parent path changed during directory creation.",
          );
        }
        canonicalParent = await realpath(next);
      }
      return canonicalParent;
    } catch (error) {
      if (error instanceof ProjectReplicaPlacementError) throw error;
      throw new ProjectReplicaPlacementError(
        isPermissionFailure(error)
          ? "path-permission-denied"
          : "parent-creation-failed",
        "The repository parent directories could not be created safely.",
      );
    }
  }

  async #readRegistry(): Promise<PlacementRegistry> {
    try {
      const metadata = await lstat(this.#registryPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("Invalid project replica placement registry.");
      }
      return parseRegistry(
        JSON.parse(await readFile(this.#registryPath, "utf8")),
      );
    } catch (error) {
      if (isMissing(error)) return { version: REGISTRY_VERSION, records: [] };
      throw error;
    }
  }

  async #writeRegistry(registry: PlacementRegistry): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#registryPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(registry)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, this.#registryPath);
  }

  async #readOwnershipMarker(
    gitCommonDir: string,
  ): Promise<OwnershipMarker | null> {
    try {
      const markerPath = path.join(gitCommonDir, OWNER_MARKER_NAME);
      const metadata = await lstat(markerPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
      return parseOwnershipMarker(
        JSON.parse(await readFile(markerPath, "utf8")),
      );
    } catch (error) {
      if (isMissing(error)) return null;
      return null;
    }
  }

  async #readStagingMarker(markerPath: string): Promise<StagingMarker | null> {
    try {
      const metadata = await lstat(markerPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
      const value = JSON.parse(await readFile(markerPath, "utf8")) as Record<
        string,
        unknown
      >;
      return value.version === REGISTRY_VERSION &&
        typeof value.jobId === "string" &&
        typeof value.projectId === "string" &&
        typeof value.workerId === "string"
        ? {
            version: REGISTRY_VERSION,
            jobId: value.jobId,
            projectId: value.projectId,
            workerId: value.workerId,
          }
        : null;
    } catch (error) {
      if (isMissing(error)) return null;
      return null;
    }
  }

  #stagingMarkerPath(stagingPath: string): string {
    return `${stagingPath}.cantrip-owner.json`;
  }

  async #serializeWrite(operation: () => Promise<void>): Promise<void> {
    const next = this.#writeQueue.then(operation, operation);
    this.#writeQueue = next.catch(() => undefined);
    await next;
  }
}
