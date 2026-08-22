import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readlink,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
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
  linkPath: string | null;
  mode: ProjectReplicaPlacementMode;
  ownership: ProjectReplicaOwnershipKind;
  projectId: string;
  releasedAt?: string | null;
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
  linkPath: string | null;
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
      | "link-unsupported"
      | "link-target-mismatch"
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
    (record.linkPath !== undefined &&
      record.linkPath !== null &&
      (typeof record.linkPath !== "string" ||
        !record.linkPath ||
        record.linkPath.length > MAX_PATH_LENGTH)) ||
    (record.mode !== "direct" && record.mode !== "managed-link") ||
    (record.ownership !== "cantrip" && record.ownership !== "user") ||
    (record.releasedAt !== undefined &&
      record.releasedAt !== null &&
      typeof record.releasedAt !== "string") ||
    typeof record.createdAt !== "string"
  ) {
    throw new Error("Invalid project replica placement record.");
  }
  return {
    canonicalPath: record.canonicalPath,
    createdAt: record.createdAt,
    linkPath: typeof record.linkPath === "string" ? record.linkPath : null,
    mode: record.mode,
    ownership: record.ownership,
    projectId: record.projectId,
    releasedAt:
      typeof record.releasedAt === "string" ? record.releasedAt : null,
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

function pathsEqual(left: string, right: string): boolean {
  const comparable = (value: string) => {
    const normalized = path.normalize(value);
    if (process.platform !== "win32") return normalized;
    const withoutNamespace = normalized.startsWith("\\\\?\\UNC\\")
      ? `\\\\${normalized.slice(8)}`
      : normalized.startsWith("\\\\?\\")
        ? normalized.slice(4)
        : normalized;
    return withoutNamespace.toLowerCase();
  };
  return comparable(left) === comparable(right);
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

export async function probeManagedLinkPlacement(
  dataDirectory: string,
): Promise<boolean> {
  let probeDirectory: string | null = null;
  try {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    probeDirectory = await mkdtemp(
      path.join(dataDirectory, ".project-link-capability-"),
    );
    const target = path.join(probeDirectory, "target");
    const link = path.join(probeDirectory, "link");
    await mkdir(target, { mode: 0o700 });
    await symlink(
      target,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    return pathsEqual(await realpath(target), await realpath(link));
  } catch {
    return false;
  } finally {
    if (probeDirectory) {
      await rm(probeDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
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
      const managedTarget = path.resolve(input.managedTarget);
      const placementRecord = (await this.#readRegistry()).records.find(
        (record) => pathsEqual(record.canonicalPath, managedTarget),
      );
      if (placementRecord) {
        throw new ProjectReplicaPlacementError(
          "ownership-proof-missing",
          placementRecord.releasedAt == null
            ? "The managed repository source is already assigned to a custom-placement project."
            : "The managed repository source was retained as user-managed storage and cannot be reclaimed automatically.",
        );
      }
      return {
        exists: (await existingStats(managedTarget)) !== null,
        linkPath: null,
        mode: "managed",
        requestedPath: null,
        stagingPath: `${managedTarget}.cantrip-provision-${input.jobId}`,
        targetPath: managedTarget,
      };
    }
    if (input.placement.mode === "managed-link") {
      await mkdir(path.dirname(input.managedTarget), {
        recursive: true,
        mode: 0o700,
      });
      const requestedPath = this.#validateRequestedPath(input.placement.path);
      const canonicalParent = await this.#ensureParents(
        path.dirname(requestedPath),
      );
      const linkPath = path.join(canonicalParent, path.basename(requestedPath));
      const managedTarget = path.resolve(input.managedTarget);
      if (pathIsWithin(managedTarget, linkPath)) {
        throw new ProjectReplicaPlacementError(
          "link-target-mismatch",
          "The managed link must be outside its canonical repository source.",
        );
      }
      const registry = await this.#readRegistry();
      const retainedSource = registry.records.find(
        (record) =>
          record.releasedAt != null &&
          pathsEqual(record.canonicalPath, managedTarget),
      );
      if (retainedSource) {
        throw new ProjectReplicaPlacementError(
          "ownership-proof-missing",
          "The managed repository source was retained as user-managed storage and cannot be reclaimed automatically.",
        );
      }
      const collision = registry.records.find(
        (record) =>
          record.releasedAt == null &&
          (pathsEqual(record.canonicalPath, managedTarget) ||
            (record.linkPath !== null &&
              pathsEqual(record.linkPath, linkPath))),
      );
      if (collision && collision.projectId !== input.projectId) {
        throw new ProjectReplicaPlacementError(
          "target-owned-by-another-project",
          "The requested managed link is already assigned to another Cantrip project.",
        );
      }
      const linkStats = await existingStats(linkPath);
      if (linkStats) {
        if (!linkStats.isSymbolicLink()) {
          throw new ProjectReplicaPlacementError(
            "link-target-mismatch",
            "The requested managed-link path is occupied by another filesystem entry.",
          );
        }
        if (!collision || collision.projectId !== input.projectId) {
          throw new ProjectReplicaPlacementError(
            "ownership-proof-missing",
            "The existing repository link is not owned by this Cantrip project.",
          );
        }
      }
      return {
        exists: (await existingStats(managedTarget)) !== null,
        linkPath,
        mode: "managed-link",
        requestedPath,
        stagingPath: `${managedTarget}.cantrip-provision-${input.jobId}`,
        targetPath: managedTarget,
      };
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
      (record) =>
        record.releasedAt == null &&
        pathsEqual(record.canonicalPath, targetPath),
    );
    if (collision && collision.projectId !== input.projectId) {
      throw new ProjectReplicaPlacementError(
        "target-owned-by-another-project",
        "The requested repository target is already attached to another Cantrip project.",
      );
    }

    return {
      exists,
      linkPath: null,
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
      (candidate) =>
        candidate.releasedAt == null &&
        pathsEqual(candidate.canonicalPath, input.canonicalPath),
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
        (candidate) =>
          candidate.releasedAt == null &&
          (pathsEqual(candidate.canonicalPath, input.canonicalPath) ||
            (candidate.linkPath !== null &&
              input.linkPath !== null &&
              pathsEqual(candidate.linkPath, input.linkPath))),
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

  async materializeManagedLink(input: {
    canonicalPath: string;
    linkPath: string;
    projectId: string;
    repositoryFingerprint: string;
    requestedPath: string;
    requireExistingClaim?: boolean;
  }): Promise<{ changed: boolean }> {
    let changed = false;
    await this.#serializeWrite(async () => {
      const registry = await this.#readRegistry();
      const retainedSource = registry.records.find(
        (candidate) =>
          candidate.releasedAt != null &&
          pathsEqual(candidate.canonicalPath, input.canonicalPath),
      );
      if (retainedSource) {
        throw new ProjectReplicaPlacementError(
          "ownership-proof-missing",
          "The managed repository source was retained as user-managed storage and cannot be reclaimed automatically.",
        );
      }
      const projectRecord = registry.records.find(
        (candidate) =>
          candidate.projectId === input.projectId &&
          candidate.releasedAt == null,
      );
      const matchingClaim =
        projectRecord?.workerId === this.workerId &&
        projectRecord.mode === "managed-link" &&
        projectRecord.ownership === "cantrip" &&
        pathsEqual(projectRecord.canonicalPath, input.canonicalPath) &&
        projectRecord.linkPath !== null &&
        pathsEqual(projectRecord.linkPath, input.linkPath) &&
        projectRecord.repositoryFingerprint === input.repositoryFingerprint;
      if (projectRecord && !matchingClaim) {
        throw new ProjectReplicaPlacementError(
          "ownership-proof-missing",
          "The managed-link ownership record does not match this repository.",
        );
      }
      const collision = registry.records.find(
        (candidate) =>
          candidate.projectId !== input.projectId &&
          candidate.releasedAt == null &&
          (pathsEqual(candidate.canonicalPath, input.canonicalPath) ||
            (candidate.linkPath !== null &&
              pathsEqual(candidate.linkPath, input.linkPath))),
      );
      if (collision) {
        throw new ProjectReplicaPlacementError(
          "target-owned-by-another-project",
          "The managed source or link is already assigned to another Cantrip project.",
        );
      }

      const linkStats = await existingStats(input.linkPath);
      if (linkStats) {
        if (!matchingClaim) {
          throw new ProjectReplicaPlacementError(
            "ownership-proof-missing",
            "The existing repository link is not owned by this Cantrip project.",
          );
        }
        await this.#verifyManagedLink(input.linkPath, input.canonicalPath);
        return;
      }
      if (input.requireExistingClaim && !matchingClaim) {
        throw new ProjectReplicaPlacementError(
          "ownership-proof-missing",
          "The managed link cannot be repaired without its worker ownership record.",
        );
      }
      if (!matchingClaim) {
        const records = registry.records.filter(
          (candidate) => candidate.projectId !== input.projectId,
        );
        records.push({
          canonicalPath: input.canonicalPath,
          createdAt: new Date().toISOString(),
          linkPath: input.linkPath,
          mode: "managed-link",
          ownership: "cantrip",
          projectId: input.projectId,
          repositoryFingerprint: input.repositoryFingerprint,
          requestedPath: input.requestedPath,
          workerId: this.workerId,
        });
        await this.#writeRegistry({ version: REGISTRY_VERSION, records });
      }
      try {
        await symlink(
          input.canonicalPath,
          input.linkPath,
          process.platform === "win32" ? "junction" : "dir",
        );
        changed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new ProjectReplicaPlacementError(
            isPermissionFailure(error)
              ? "path-permission-denied"
              : "link-unsupported",
            "The worker could not create the requested managed repository link.",
            isPermissionFailure(error),
          );
        }
      }
      await this.#verifyManagedLink(input.linkPath, input.canonicalPath);
    });
    return { changed };
  }

  async verifyPlacementOwnership(input: {
    canonicalPath: string;
    gitCommonDir: string;
    linkPath: string | null;
    mode: "direct" | "managed-link";
    ownership: ProjectReplicaOwnershipKind;
    projectId: string;
    repositoryFingerprint: string;
  }): Promise<void> {
    const registry = await this.#readRegistry();
    const record = registry.records.find(
      (candidate) =>
        candidate.projectId === input.projectId && candidate.releasedAt == null,
    );
    if (
      !record ||
      record.workerId !== this.workerId ||
      record.mode !== input.mode ||
      record.ownership !== input.ownership ||
      !pathsEqual(record.canonicalPath, input.canonicalPath) ||
      record.repositoryFingerprint !== input.repositoryFingerprint ||
      (input.linkPath === null
        ? record.linkPath !== null
        : record.linkPath === null ||
          !pathsEqual(record.linkPath, input.linkPath))
    ) {
      throw new ProjectReplicaPlacementError(
        "ownership-proof-missing",
        "The worker ownership record does not match this project replica.",
      );
    }
    if (input.mode === "direct" && input.ownership === "cantrip") {
      const marker = await this.#readOwnershipMarker(input.gitCommonDir);
      if (
        marker?.projectId !== input.projectId ||
        marker.workerId !== this.workerId ||
        marker.repositoryFingerprint !== input.repositoryFingerprint
      ) {
        throw new ProjectReplicaPlacementError(
          "ownership-proof-missing",
          "The direct checkout no longer has matching Cantrip ownership proof.",
        );
      }
    }
  }

  async releasePlacement(input: {
    canonicalPath: string;
    gitCommonDir: string | null;
    mode: "direct" | "managed-link";
    ownership: ProjectReplicaOwnershipKind;
    projectId: string;
    repositoryFingerprint: string;
  }): Promise<void> {
    await this.#serializeWrite(async () => {
      const registry = await this.#readRegistry();
      const index = registry.records.findIndex(
        (candidate) =>
          candidate.projectId === input.projectId &&
          pathsEqual(candidate.canonicalPath, input.canonicalPath) &&
          candidate.mode === input.mode &&
          candidate.ownership === input.ownership &&
          candidate.repositoryFingerprint === input.repositoryFingerprint,
      );
      if (index < 0) {
        throw new ProjectReplicaPlacementError(
          "ownership-proof-missing",
          "The repository placement ownership record cannot be released safely.",
        );
      }
      const record = registry.records[index]!;
      if (record.workerId !== this.workerId) {
        throw new ProjectReplicaPlacementError(
          "ownership-proof-missing",
          "The repository placement belongs to another worker.",
        );
      }
      if (record.releasedAt == null) {
        registry.records[index] = {
          ...record,
          releasedAt: new Date().toISOString(),
        };
        await this.#writeRegistry(registry);
      }
    });
    if (
      input.mode === "direct" &&
      input.ownership === "cantrip" &&
      input.gitCommonDir
    ) {
      const marker = await this.#readOwnershipMarker(input.gitCommonDir);
      const markerPath = path.join(input.gitCommonDir, OWNER_MARKER_NAME);
      if (!marker && !(await existingStats(markerPath))) return;
      if (
        marker?.projectId !== input.projectId ||
        marker.workerId !== this.workerId ||
        marker.repositoryFingerprint !== input.repositoryFingerprint
      ) {
        throw new ProjectReplicaPlacementError(
          "ownership-proof-missing",
          "The direct checkout ownership marker cannot be released safely.",
        );
      }
      const markerStats = await lstat(markerPath);
      if (!markerStats.isFile() || markerStats.isSymbolicLink()) {
        throw new ProjectReplicaPlacementError(
          "ownership-proof-missing",
          "The direct checkout ownership marker changed unexpectedly.",
        );
      }
      await unlink(markerPath);
    }
  }

  async isPlacementReleased(input: {
    canonicalPath: string;
    mode: "direct" | "managed-link";
    projectId: string;
    repositoryFingerprint: string;
  }): Promise<boolean> {
    const registry = await this.#readRegistry();
    return registry.records.some(
      (candidate) =>
        candidate.projectId === input.projectId &&
        candidate.workerId === this.workerId &&
        candidate.mode === input.mode &&
        pathsEqual(candidate.canonicalPath, input.canonicalPath) &&
        candidate.repositoryFingerprint === input.repositoryFingerprint &&
        candidate.releasedAt != null,
    );
  }

  async forgetPlacement(
    projectId: string,
    canonicalPath: string,
  ): Promise<void> {
    await this.#serializeWrite(async () => {
      const registry = await this.#readRegistry();
      const records = registry.records.filter(
        (candidate) =>
          !(
            candidate.projectId === projectId &&
            pathsEqual(candidate.canonicalPath, canonicalPath)
          ),
      );
      if (records.length !== registry.records.length) {
        await this.#writeRegistry({ version: REGISTRY_VERSION, records });
      }
    });
  }

  async removeManagedLinkIfMatching(input: {
    canonicalPath: string;
    linkPath: string;
  }): Promise<{ removed: boolean; warning: string | null }> {
    const linkStats = await existingStats(input.linkPath);
    if (!linkStats) return { removed: false, warning: null };
    if (!linkStats.isSymbolicLink()) {
      return {
        removed: false,
        warning:
          "The original managed-link path now contains another entry and was left untouched.",
      };
    }
    let matches = false;
    try {
      matches = pathsEqual(
        await realpath(input.linkPath),
        await realpath(input.canonicalPath),
      );
    } catch {
      const destination = await readlink(input.linkPath).catch(() => null);
      if (destination !== null) {
        matches = pathsEqual(
          path.resolve(path.dirname(input.linkPath), destination),
          input.canonicalPath,
        );
      }
    }
    if (!matches) {
      return {
        removed: false,
        warning:
          "The original managed-link path no longer points to this checkout and was left untouched.",
      };
    }
    await unlink(input.linkPath);
    return { removed: true, warning: null };
  }

  async #verifyManagedLink(
    linkPath: string,
    canonicalPath: string,
  ): Promise<void> {
    const metadata = await existingStats(linkPath);
    if (!metadata?.isSymbolicLink()) {
      throw new ProjectReplicaPlacementError(
        "link-target-mismatch",
        "The managed repository link is missing or has been replaced.",
      );
    }
    try {
      if (
        !pathsEqual(await realpath(linkPath), await realpath(canonicalPath))
      ) {
        throw new ProjectReplicaPlacementError(
          "link-target-mismatch",
          "The managed repository link points to a different checkout.",
        );
      }
    } catch (error) {
      if (error instanceof ProjectReplicaPlacementError) throw error;
      throw new ProjectReplicaPlacementError(
        "link-target-mismatch",
        "The managed repository link could not be verified.",
      );
    }
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
