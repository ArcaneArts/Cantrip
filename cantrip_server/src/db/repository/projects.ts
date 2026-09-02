import {
  isLocalGitProject,
  isWorkerBoundFolderProject,
  projectCapabilitiesForSource,
  projectWorkspaceStorageContextSchema,
  projectWorkspaceStorageCanBeDefault,
  projectWireSummarySchema,
  type EncryptedProjectWorkspaceCreate,
  type EncryptedProjectWorkspaceUpdate,
  type ProjectReplicaSummary,
  type ProjectWireSummary,
  type ProjectWorkspaceWireList,
  type ProjectWorkspaceWireSummary,
  type ProjectWorkspaceStorageContext,
  type ProjectWorktreePolicyUpdate,
  type ProjectWorktreeSummary,
  type WorkerSummary,
} from "@cantrip/protocol";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import * as schema from "../schema.js";
import {
  firstOrThrow,
  toISOString,
  type RepositoryDatabase,
  type RepositoryTransaction,
} from "./database.js";
import { toWorkerSummary } from "./workers.js";

type ProjectRow = typeof schema.projects.$inferSelect;
type ProjectSourceRow = typeof schema.projectSources.$inferSelect;
type ProjectWorktreeRow = typeof schema.projectWorktrees.$inferSelect;
export type ProjectWorkspaceRow = typeof schema.projectWorkspaces.$inferSelect;
type ProjectWorkspaceStorageProfileRow =
  typeof schema.projectWorkspaceStorageProfiles.$inferSelect;
type WorkerRow = typeof schema.workers.$inferSelect;

export class ProjectWorkspaceInvariantError extends Error {}
export class ProjectPreferredWorkerConflictError extends Error {}

function toProjectWorkspaceStorageContext(input: {
  kind: ProjectWorkspaceStorageProfileRow["kind"];
  workerId: string | null;
  workspaceId: string;
}): ProjectWorkspaceStorageContext {
  return projectWorkspaceStorageContextSchema.parse(
    input.kind === "managed"
      ? { kind: input.kind, workspaceId: input.workspaceId }
      : input.kind === "attached"
        ? {
            kind: input.kind,
            workspaceId: input.workspaceId,
            workerId: input.workerId,
          }
        : { kind: input.kind },
  );
}

export interface ProjectWorktreeExecutionContext {
  projectId: string;
  projectSourceId: string;
  sourcePath: string;
  workerId: string;
  worktree: ProjectWorktreeSummary;
}

export interface ProjectWorkspaceDeletionPlan {
  projectIds: string[];
}

export interface ProjectSourceSelectionOptions {
  isWorkerAvailable?: (workerId: string) => boolean;
  workerId?: string;
}

export interface ProjectRepositoryCollaborators {
  ensureDefaultProjectWorkspace(ownerId: string): Promise<ProjectWorkspaceRow>;
  getWorker(ownerId: string, workerId: string): Promise<WorkerSummary | null>;
  listProjectReplicas(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectReplicaSummary[] | null>;
  listProjectWorkspaceWire(ownerId: string): Promise<ProjectWorkspaceWireList>;
}

export function toProjectWireSummary(
  project: ProjectRow,
  replicas: ProjectReplicaSummary[] = [],
): ProjectWireSummary {
  const capabilities = projectCapabilitiesForSource({
    originKind: project.originKind,
    git: project.gitCapability,
    github: project.githubCapability,
  });
  const github =
    project.githubRepositoryId &&
    project.githubRepositoryFullName &&
    project.githubRepositoryUrl
      ? {
          repositoryId: project.githubRepositoryId,
          nameWithOwner: project.githubRepositoryFullName,
          url: project.githubRepositoryUrl,
        }
      : null;
  const sourceReplica =
    (project.preferredWorkerId
      ? replicas.find(
          (replica) =>
            replica.workerId === project.preferredWorkerId && replica.ready,
        )
      : null) ??
    replicas.find((replica) => replica.ready) ??
    replicas[0] ??
    null;

  return projectWireSummarySchema.parse({
    id: project.id,
    nameProtection: project.protectedLabel,
    position: project.position,
    originKind: project.originKind,
    folderManagement: project.folderManagement,
    capabilities,
    setupStatus: project.setupStatus as ProjectWireSummary["setupStatus"],
    setupError: project.setupError,
    worktreePolicy:
      project.worktreePolicy as ProjectWireSummary["worktreePolicy"],
    preferredWorkerId: project.preferredWorkerId,
    github,
    source: sourceReplica
      ? {
          id: sourceReplica.id,
          sourceKind: sourceReplica.sourceKind,
          workerId: sourceReplica.workerId,
          path: sourceReplica.path,
          displayPath: sourceReplica.displayPath,
          placementMode: sourceReplica.placementMode,
          ownershipKind: sourceReplica.ownershipKind,
          requestedPath: sourceReplica.requestedPath,
          linkPath: sourceReplica.linkPath,
        }
      : null,
    replicas,
    createdAt: toISOString(project.createdAt),
    updatedAt: toISOString(project.updatedAt),
  });
}

function toProjectReplicaSummary(
  source: ProjectSourceRow,
  worker: WorkerRow,
  worktrees: ProjectWorktreeRow[],
): ProjectReplicaSummary {
  const primary = worktrees.find((worktree) => worktree.isPrimary) ?? null;
  const observedStatus = primary?.statusSnapshot?.status ?? null;
  const workerSummary = toWorkerSummary(worker);
  return {
    id: source.id,
    projectId: source.projectId,
    sourceKind: source.sourceKind,
    workerId: source.workerId,
    workerName: workerSummary.name,
    workerOnline: workerSummary.online,
    path: source.absolutePath,
    displayPath: source.displayPath,
    placementMode: source.placementMode,
    ownershipKind: source.ownershipKind,
    requestedPath: source.requestedPath,
    linkPath: source.linkPath,
    repositoryFingerprint: source.repositoryFingerprint,
    primaryWorktreeId: primary?.id ?? null,
    branch: observedStatus?.branch ?? primary?.branch ?? null,
    head: observedStatus?.head ?? primary?.head ?? null,
    dirty: observedStatus ? observedStatus.files.length > 0 : null,
    ready: primary?.lifecycleState === "ready",
    worktreeCount: worktrees.length,
    lastObservedAt: primary?.statusObservedAt
      ? toISOString(primary.statusObservedAt)
      : null,
    createdAt: toISOString(source.createdAt),
    updatedAt: toISOString(source.updatedAt),
  };
}

function toProjectWorkspaceWireSummary(
  workspace: ProjectWorkspaceRow,
  storage: ProjectWorkspaceStorageProfileRow,
  projectIds: string[],
): ProjectWorkspaceWireSummary {
  if (
    workspace.nameEnvelope === null &&
    (workspace.id !== `workspace:default:${workspace.ownerId}` ||
      workspace.nameFormatVersion !== null ||
      workspace.nameKeyRevision !== null ||
      workspace.nameBlindIndex !== null)
  ) {
    throw new ProjectWorkspaceInvariantError(
      "Only the deterministic system-default workspace may omit name ciphertext.",
    );
  }
  if (
    workspace.nameEnvelope !== null &&
    (workspace.nameFormatVersion !== 1 ||
      workspace.nameKeyRevision === null ||
      workspace.nameBlindIndex === null ||
      workspace.nameEnvelope.keyRevision !== workspace.nameKeyRevision)
  ) {
    throw new ProjectWorkspaceInvariantError(
      "Encrypted workspace name metadata is incomplete.",
    );
  }
  const nameProtection: ProjectWorkspaceWireSummary["nameProtection"] =
    workspace.nameEnvelope === null
      ? { state: "system-default" }
      : {
          state: "encrypted",
          formatVersion: 1,
          keyRevision: workspace.nameKeyRevision!,
          blindIndex: workspace.nameBlindIndex!,
          envelope: workspace.nameEnvelope,
        };
  const storageSummary: ProjectWorkspaceWireSummary["storage"] =
    storage.kind === "attached"
      ? {
          kind: "attached",
          workerId: storage.workerId!,
          rootPathHandle: storage.protectedRootPathHandle!,
          displayHandle: storage.protectedDisplayHandle!,
        }
      : { kind: storage.kind };
  return {
    id: workspace.id,
    nameProtection,
    storage: storageSummary,
    position: workspace.position,
    isDefault: workspace.isDefault,
    projectIds,
    revision: workspace.revision,
    createdAt: toISOString(workspace.createdAt),
    updatedAt: toISOString(workspace.updatedAt),
  };
}

export function toProjectWorktreeSummary(
  worktree: ProjectWorktreeRow,
  projectId: string,
): ProjectWorktreeSummary {
  return {
    id: worktree.id,
    projectSourceId: worktree.projectSourceId,
    projectId,
    rootKind: worktree.rootKind,
    workerId: worktree.workerId,
    name: worktree.name,
    path: worktree.absolutePath,
    displayPath: worktree.displayPath,
    isPrimary: worktree.isPrimary,
    isDefault: worktree.isDefault,
    origin: worktree.origin as ProjectWorktreeSummary["origin"],
    lifecycleState:
      worktree.lifecycleState as ProjectWorktreeSummary["lifecycleState"],
    branch: worktree.branch,
    head: worktree.head,
    detached: worktree.detached,
    locked: worktree.locked,
    lockReason: worktree.lockReason,
    lastScannedAt: worktree.lastScannedAt
      ? toISOString(worktree.lastScannedAt)
      : null,
    createdAt: toISOString(worktree.createdAt),
    updatedAt: toISOString(worktree.updatedAt),
  };
}

export class ProjectRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: ProjectRepositoryCollaborators,
  ) {}

  private async projectReplicasByProject(
    ownerId: string,
    projectIds: string[],
  ): Promise<Map<string, ProjectReplicaSummary[]>> {
    const replicasByProject = new Map<string, ProjectReplicaSummary[]>();
    for (const projectId of projectIds) replicasByProject.set(projectId, []);
    if (projectIds.length === 0) return replicasByProject;

    const sourceRows = await this.database
      .select({ source: schema.projectSources, worker: schema.workers })
      .from(schema.projectSources)
      .innerJoin(
        schema.projects,
        eq(schema.projects.id, schema.projectSources.projectId),
      )
      .innerJoin(
        schema.workers,
        eq(schema.workers.id, schema.projectSources.workerId),
      )
      .where(
        and(
          eq(schema.projects.ownerId, ownerId),
          inArray(schema.projectSources.projectId, projectIds),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .orderBy(
        asc(schema.projectSources.createdAt),
        asc(schema.projectSources.id),
      );
    if (sourceRows.length === 0) return replicasByProject;

    const sourceIds = sourceRows.map(({ source }) => source.id);
    const worktrees = await this.database
      .select()
      .from(schema.projectWorktrees)
      .where(inArray(schema.projectWorktrees.projectSourceId, sourceIds))
      .orderBy(
        desc(schema.projectWorktrees.isPrimary),
        asc(schema.projectWorktrees.createdAt),
      );
    const worktreesBySource = new Map<string, ProjectWorktreeRow[]>();
    for (const worktree of worktrees) {
      const entries = worktreesBySource.get(worktree.projectSourceId) ?? [];
      entries.push(worktree);
      worktreesBySource.set(worktree.projectSourceId, entries);
    }
    for (const { source, worker } of sourceRows) {
      const replicas = replicasByProject.get(source.projectId);
      if (!replicas) continue;
      replicas.push(
        toProjectReplicaSummary(
          source,
          worker,
          worktreesBySource.get(source.id) ?? [],
        ),
      );
    }
    for (const replicas of replicasByProject.values()) {
      replicas.sort(
        (left, right) =>
          Number(right.ready) - Number(left.ready) ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
    }
    return replicasByProject;
  }

  async listProjects(ownerId: string): Promise<ProjectWireSummary[]> {
    const projects = await this.database
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.ownerId, ownerId))
      .orderBy(asc(schema.projects.position), asc(schema.projects.createdAt));
    const replicasByProject = await this.projectReplicasByProject(
      ownerId,
      projects.map(({ id }) => id),
    );
    return projects.map((project) =>
      toProjectWireSummary(project, replicasByProject.get(project.id) ?? []),
    );
  }

  async getProject(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectWireSummary | null> {
    const projects = await this.database
      .select()
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);
    const project = projects[0];
    if (!project) return null;
    return toProjectWireSummary(
      project,
      (await this.collaborators.listProjectReplicas(ownerId, projectId)) ?? [],
    );
  }

  async getProjectWorkspaceStorageContext(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectWorkspaceStorageContext | null> {
    const rows = await this.database
      .select({
        kind: schema.projectWorkspaceStorageProfiles.kind,
        workerId: schema.projectWorkspaceStorageProfiles.workerId,
        workspaceId: schema.projectWorkspaceMemberships.workspaceId,
      })
      .from(schema.projectWorkspaceMemberships)
      .innerJoin(
        schema.projectWorkspaces,
        eq(
          schema.projectWorkspaces.id,
          schema.projectWorkspaceMemberships.workspaceId,
        ),
      )
      .innerJoin(
        schema.projectWorkspaceStorageProfiles,
        eq(
          schema.projectWorkspaceStorageProfiles.workspaceId,
          schema.projectWorkspaceMemberships.workspaceId,
        ),
      )
      .where(
        and(
          eq(schema.projectWorkspaceMemberships.projectId, projectId),
          eq(schema.projectWorkspaces.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ? toProjectWorkspaceStorageContext(rows[0]) : null;
  }

  async ensureDefaultProjectWorkspace(
    ownerId: string,
  ): Promise<ProjectWorkspaceRow> {
    const defaultId = `workspace:default:${ownerId}`;
    return this.database.transaction(async (transaction) => {
      let workspaces = await transaction
        .select()
        .from(schema.projectWorkspaces)
        .where(eq(schema.projectWorkspaces.ownerId, ownerId));
      await transaction
        .insert(schema.projectWorkspaces)
        .values({
          id: defaultId,
          ownerId,
          position: 0,
          isDefault: !workspaces.some(({ isDefault }) => isDefault),
        })
        .onConflictDoNothing();
      workspaces = await transaction
        .select()
        .from(schema.projectWorkspaces)
        .where(eq(schema.projectWorkspaces.ownerId, ownerId));

      const existingProfiles = await transaction
        .select({
          workspaceId: schema.projectWorkspaceStorageProfiles.workspaceId,
        })
        .from(schema.projectWorkspaceStorageProfiles)
        .innerJoin(
          schema.projectWorkspaces,
          eq(
            schema.projectWorkspaces.id,
            schema.projectWorkspaceStorageProfiles.workspaceId,
          ),
        )
        .where(eq(schema.projectWorkspaces.ownerId, ownerId));
      const profiledWorkspaceIds = new Set(
        existingProfiles.map(({ workspaceId }) => workspaceId),
      );
      const missingProfiles = workspaces
        .filter(({ id }) => !profiledWorkspaceIds.has(id))
        .map(({ id }) => ({
          workspaceId: id,
          kind: id === defaultId ? ("system" as const) : ("legacy" as const),
        }));
      if (missingProfiles.length > 0) {
        await transaction
          .insert(schema.projectWorkspaceStorageProfiles)
          .values(missingProfiles)
          .onConflictDoNothing();
      }

      const profiles = await transaction
        .select()
        .from(schema.projectWorkspaceStorageProfiles)
        .innerJoin(
          schema.projectWorkspaces,
          eq(
            schema.projectWorkspaces.id,
            schema.projectWorkspaceStorageProfiles.workspaceId,
          ),
        )
        .where(eq(schema.projectWorkspaces.ownerId, ownerId));
      const defaultWorkspace = profiles.find(
        ({ project_workspaces: workspace }) => workspace.isDefault,
      );
      if (
        defaultWorkspace &&
        projectWorkspaceStorageCanBeDefault(
          defaultWorkspace.project_workspace_storage_profiles.kind,
        )
      ) {
        return defaultWorkspace.project_workspaces;
      }

      const updatedAt = new Date();
      if (defaultWorkspace) {
        await transaction
          .update(schema.projectWorkspaces)
          .set({
            isDefault: false,
            revision: sql`${schema.projectWorkspaces.revision} + 1`,
            updatedAt,
          })
          .where(
            eq(
              schema.projectWorkspaces.id,
              defaultWorkspace.project_workspaces.id,
            ),
          );
      }
      const restored = await transaction
        .update(schema.projectWorkspaces)
        .set({
          isDefault: true,
          revision: sql`${schema.projectWorkspaces.revision} + 1`,
          updatedAt,
        })
        .where(
          and(
            eq(schema.projectWorkspaces.id, defaultId),
            eq(schema.projectWorkspaces.ownerId, ownerId),
          ),
        )
        .returning();
      return firstOrThrow(restored, "restoring the system workspace default");
    });
  }

  async listProjectWorkspaceWire(
    ownerId: string,
  ): Promise<ProjectWorkspaceWireList> {
    await this.collaborators.ensureDefaultProjectWorkspace(ownerId);
    const [workspaces, storageProfiles, memberships] = await Promise.all([
      this.database
        .select()
        .from(schema.projectWorkspaces)
        .where(eq(schema.projectWorkspaces.ownerId, ownerId))
        .orderBy(
          asc(schema.projectWorkspaces.position),
          asc(schema.projectWorkspaces.createdAt),
        ),
      this.database
        .select()
        .from(schema.projectWorkspaceStorageProfiles)
        .innerJoin(
          schema.projectWorkspaces,
          eq(
            schema.projectWorkspaces.id,
            schema.projectWorkspaceStorageProfiles.workspaceId,
          ),
        )
        .where(eq(schema.projectWorkspaces.ownerId, ownerId)),
      this.database
        .select({
          workspaceId: schema.projectWorkspaceMemberships.workspaceId,
          projectId: schema.projectWorkspaceMemberships.projectId,
        })
        .from(schema.projectWorkspaceMemberships)
        .innerJoin(
          schema.projectWorkspaces,
          eq(
            schema.projectWorkspaces.id,
            schema.projectWorkspaceMemberships.workspaceId,
          ),
        )
        .where(eq(schema.projectWorkspaces.ownerId, ownerId)),
    ]);
    const projectIds = new Map<string, string[]>();
    for (const membership of memberships) {
      const current = projectIds.get(membership.workspaceId) ?? [];
      current.push(membership.projectId);
      projectIds.set(membership.workspaceId, current);
    }
    const storageByWorkspaceId = new Map(
      storageProfiles.map(({ project_workspace_storage_profiles: profile }) => [
        profile.workspaceId,
        profile,
      ]),
    );
    const summaries = workspaces.map((workspace) => {
      const storage = storageByWorkspaceId.get(workspace.id);
      if (!storage) {
        throw new ProjectWorkspaceInvariantError(
          `Workspace ${workspace.id} has no storage profile.`,
        );
      }
      return toProjectWorkspaceWireSummary(
        workspace,
        storage,
        projectIds.get(workspace.id) ?? [],
      );
    });
    return { workspaces: summaries };
  }

  async createEncryptedProjectWorkspace(
    ownerId: string,
    input: EncryptedProjectWorkspaceCreate,
  ): Promise<ProjectWorkspaceWireSummary> {
    if (input.storage.kind !== "managed") {
      throw new ProjectWorkspaceInvariantError(
        "Attached workspaces must be created through verified root attachment.",
      );
    }
    return this.#createEncryptedProjectWorkspace(ownerId, input);
  }

  async createVerifiedAttachedProjectWorkspace(
    ownerId: string,
    input: EncryptedProjectWorkspaceCreate,
  ): Promise<ProjectWorkspaceWireSummary> {
    if (input.storage.kind !== "attached") {
      throw new ProjectWorkspaceInvariantError(
        "Verified workspace attachment requires attached storage.",
      );
    }
    return this.#createEncryptedProjectWorkspace(ownerId, input);
  }

  async #createEncryptedProjectWorkspace(
    ownerId: string,
    input: EncryptedProjectWorkspaceCreate,
  ): Promise<ProjectWorkspaceWireSummary> {
    await this.collaborators.ensureDefaultProjectWorkspace(ownerId);
    const profiles = await this.database
      .select({
        activeMasterKeyRevision:
          schema.accountEncryptionProfiles.activeMasterKeyRevision,
      })
      .from(schema.accountEncryptionProfiles)
      .where(eq(schema.accountEncryptionProfiles.ownerId, ownerId))
      .limit(1);
    if (!profiles[0]) {
      throw new ProjectWorkspaceInvariantError(
        "Workspace encryption must be initialized before creating a workspace.",
      );
    }
    if (
      input.nameProtection.keyRevision !== profiles[0].activeMasterKeyRevision
    ) {
      throw new ProjectWorkspaceInvariantError(
        "Workspace encryption key revision is not active.",
      );
    }
    const { profile, workspace } = await this.database.transaction(
      async (transaction) => {
        const last = await transaction
          .select({ position: schema.projectWorkspaces.position })
          .from(schema.projectWorkspaces)
          .where(eq(schema.projectWorkspaces.ownerId, ownerId))
          .orderBy(desc(schema.projectWorkspaces.position))
          .limit(1);
        const rows = await transaction
          .insert(schema.projectWorkspaces)
          .values({
            id: input.id,
            ownerId,
            nameEnvelope: input.nameProtection.envelope,
            nameBlindIndex: input.nameProtection.blindIndex,
            nameFormatVersion: input.nameProtection.formatVersion,
            nameKeyRevision: input.nameProtection.keyRevision,
            position: (last[0]?.position ?? -1) + 1,
            isDefault: false,
          })
          .returning();
        const profiles = await transaction
          .insert(schema.projectWorkspaceStorageProfiles)
          .values(
            input.storage.kind === "attached"
              ? {
                  workspaceId: input.id,
                  kind: input.storage.kind,
                  workerId: input.storage.workerId,
                  protectedRootPathHandle: input.storage.rootPathHandle,
                  protectedDisplayHandle: input.storage.displayHandle,
                }
              : { workspaceId: input.id, kind: input.storage.kind },
          )
          .returning();
        return {
          profile: firstOrThrow(profiles, "creating workspace storage"),
          workspace: firstOrThrow(
            rows,
            "creating an encrypted project workspace",
          ),
        };
      },
    );
    return toProjectWorkspaceWireSummary(workspace, profile, []);
  }

  async updateEncryptedProjectWorkspace(
    ownerId: string,
    workspaceId: string,
    input: EncryptedProjectWorkspaceUpdate,
  ): Promise<ProjectWorkspaceWireSummary | null> {
    const rows = await this.database
      .select()
      .from(schema.projectWorkspaces)
      .where(
        and(
          eq(schema.projectWorkspaces.id, workspaceId),
          eq(schema.projectWorkspaces.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!rows[0]) return null;
    if (input.isDefault) {
      const profiles = await this.database
        .select({ kind: schema.projectWorkspaceStorageProfiles.kind })
        .from(schema.projectWorkspaceStorageProfiles)
        .where(
          eq(schema.projectWorkspaceStorageProfiles.workspaceId, workspaceId),
        )
        .limit(1);
      if (
        !profiles[0] ||
        !projectWorkspaceStorageCanBeDefault(profiles[0].kind)
      ) {
        throw new ProjectWorkspaceInvariantError(
          "Attached workspaces cannot be the default workspace.",
        );
      }
    }
    if (input.nameProtection) {
      const profiles = await this.database
        .select({
          activeMasterKeyRevision:
            schema.accountEncryptionProfiles.activeMasterKeyRevision,
        })
        .from(schema.accountEncryptionProfiles)
        .where(eq(schema.accountEncryptionProfiles.ownerId, ownerId))
        .limit(1);
      if (
        !profiles[0] ||
        input.nameProtection.keyRevision !== profiles[0].activeMasterKeyRevision
      ) {
        throw new ProjectWorkspaceInvariantError(
          "Workspace encryption key revision is not active.",
        );
      }
    }
    await this.database.transaction(async (transaction) => {
      const updatedAt = new Date();
      if (input.isDefault) {
        await transaction
          .update(schema.projectWorkspaces)
          .set({
            isDefault: false,
            revision: sql`${schema.projectWorkspaces.revision} + 1`,
            updatedAt,
          })
          .where(
            and(
              eq(schema.projectWorkspaces.ownerId, ownerId),
              eq(schema.projectWorkspaces.isDefault, true),
              sql`${schema.projectWorkspaces.id} <> ${workspaceId}`,
            ),
          );
      }
      const updated = await transaction
        .update(schema.projectWorkspaces)
        .set({
          ...(input.nameProtection
            ? {
                nameEnvelope: input.nameProtection.envelope,
                nameBlindIndex: input.nameProtection.blindIndex,
                nameFormatVersion: input.nameProtection.formatVersion,
                nameKeyRevision: input.nameProtection.keyRevision,
              }
            : {}),
          ...(input.isDefault ? { isDefault: true } : {}),
          revision: sql`${schema.projectWorkspaces.revision} + 1`,
          updatedAt,
        })
        .where(
          and(
            eq(schema.projectWorkspaces.id, workspaceId),
            eq(schema.projectWorkspaces.ownerId, ownerId),
            eq(schema.projectWorkspaces.revision, input.expectedRevision),
          ),
        )
        .returning({ id: schema.projectWorkspaces.id });
      if (!updated[0]) {
        throw new ProjectWorkspaceInvariantError(
          "Workspace revision changed before the update could be saved.",
        );
      }
    });
    return (
      await this.collaborators.listProjectWorkspaceWire(ownerId)
    ).workspaces.find(({ id }) => id === workspaceId)!;
  }

  async deleteProjectWorkspace(
    ownerId: string,
    workspaceId: string,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const plan = await this.getProjectWorkspaceDeletionPlan(
        ownerId,
        workspaceId,
        transaction,
      );
      if (!plan) return false;
      if (plan.projectIds.length > 0) {
        await transaction
          .delete(schema.projects)
          .where(
            and(
              eq(schema.projects.ownerId, ownerId),
              inArray(schema.projects.id, plan.projectIds),
            ),
          );
        for (const projectId of plan.projectIds) {
          await transaction
            .update(schema.userSettings)
            .set({
              mobileProjectTabConfigurations: sql`${schema.userSettings.mobileProjectTabConfigurations} - ${projectId}`,
              updatedAt: new Date(),
            })
            .where(eq(schema.userSettings.userId, ownerId));
        }
      }
      const deleted = await transaction
        .delete(schema.projectWorkspaces)
        .where(
          and(
            eq(schema.projectWorkspaces.id, workspaceId),
            eq(schema.projectWorkspaces.ownerId, ownerId),
          ),
        )
        .returning({ id: schema.projectWorkspaces.id });
      return deleted.length === 1;
    });
  }

  async getProjectWorkspaceDeletionPlan(
    ownerId: string,
    workspaceId: string,
    database: RepositoryDatabase | RepositoryTransaction = this.database,
  ): Promise<ProjectWorkspaceDeletionPlan | null> {
    const rows = await database
      .select({
        isDefault: schema.projectWorkspaces.isDefault,
        storageKind: schema.projectWorkspaceStorageProfiles.kind,
      })
      .from(schema.projectWorkspaces)
      .innerJoin(
        schema.projectWorkspaceStorageProfiles,
        eq(
          schema.projectWorkspaceStorageProfiles.workspaceId,
          schema.projectWorkspaces.id,
        ),
      )
      .where(
        and(
          eq(schema.projectWorkspaces.id, workspaceId),
          eq(schema.projectWorkspaces.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!rows[0]) return null;
    if (rows[0].isDefault || rows[0].storageKind === "system") {
      throw new ProjectWorkspaceInvariantError(
        "The Default workspace cannot be deleted.",
      );
    }
    const assignedProjects = await database
      .select({ projectId: schema.projectWorkspaceMemberships.projectId })
      .from(schema.projectWorkspaceMemberships)
      .where(eq(schema.projectWorkspaceMemberships.workspaceId, workspaceId));
    return { projectIds: assignedProjects.map(({ projectId }) => projectId) };
  }

  async updateProjectWorktreePolicy(
    ownerId: string,
    projectId: string,
    input: ProjectWorktreePolicyUpdate,
  ): Promise<ProjectWireSummary | null> {
    const rows = await this.database
      .update(schema.projects)
      .set({ worktreePolicy: input.policy, updatedAt: new Date() })
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .returning();
    if (!rows[0]) return null;
    return toProjectWireSummary(
      rows[0],
      (await this.collaborators.listProjectReplicas(ownerId, projectId)) ?? [],
    );
  }

  async updateProjectPreferredWorker(
    ownerId: string,
    projectId: string,
    workerId: string | null,
  ): Promise<ProjectWireSummary | null> {
    if (workerId && !(await this.collaborators.getWorker(ownerId, workerId))) {
      return null;
    }
    const projects = await this.database
      .select({
        gitCapability: schema.projects.gitCapability,
        originKind: schema.projects.originKind,
        preferredWorkerId: schema.projects.preferredWorkerId,
      })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);
    const project = projects[0];
    if (!project) return null;
    if (workerId) {
      const replicas =
        (await this.collaborators.listProjectReplicas(ownerId, projectId)) ??
        [];
      if (
        isWorkerBoundFolderProject(project.originKind, project.gitCapability) &&
        workerId !== (project.preferredWorkerId ?? replicas[0]?.workerId)
      ) {
        throw new ProjectPreferredWorkerConflictError(
          "This folder project is bound to its owning worker.",
        );
      }
      if (
        isLocalGitProject(project.originKind, project.gitCapability) &&
        !replicas.some(
          (replica) => replica.workerId === workerId && replica.ready,
        )
      ) {
        throw new ProjectPreferredWorkerConflictError(
          "Attach a ready local Git source on this worker before selecting it as preferred.",
        );
      }
    }
    const rows = await this.database
      .update(schema.projects)
      .set({ preferredWorkerId: workerId, updatedAt: new Date() })
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .returning();
    if (!rows[0]) return null;
    return toProjectWireSummary(
      rows[0],
      (await this.collaborators.listProjectReplicas(ownerId, projectId)) ?? [],
    );
  }

  async listProjectReplicas(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectReplicaSummary[] | null> {
    const ownedProjects = await this.database
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!ownedProjects[0]) return null;
    return (
      (await this.projectReplicasByProject(ownerId, [projectId])).get(
        projectId,
      ) ?? []
    );
  }

  async getProjectReplica(
    ownerId: string,
    projectId: string,
    projectReplicaId: string,
  ): Promise<ProjectReplicaSummary | null> {
    const replicas = await this.collaborators.listProjectReplicas(
      ownerId,
      projectId,
    );
    return replicas?.find((replica) => replica.id === projectReplicaId) ?? null;
  }

  async getProjectSource(
    ownerId: string,
    projectId: string,
    options: ProjectSourceSelectionOptions = {},
  ) {
    const rows = await this.database
      .select({
        projectReplicaId: schema.projectSources.id,
        workerId: schema.projectWorktrees.workerId,
        cwd: schema.projectWorktrees.absolutePath,
        worktreeId: schema.projectWorktrees.id,
      })
      .from(schema.projects)
      .innerJoin(
        schema.projectSources,
        eq(schema.projectSources.projectId, schema.projects.id),
      )
      .innerJoin(
        schema.projectWorktrees,
        and(
          eq(schema.projectWorktrees.projectSourceId, schema.projectSources.id),
          eq(schema.projectWorktrees.isPrimary, true),
        ),
      )
      .leftJoin(
        schema.userSettings,
        eq(schema.userSettings.userId, schema.projects.ownerId),
      )
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
          isNull(schema.projectSources.removedAt),
          eq(schema.projectWorktrees.lifecycleState, "ready"),
          options.workerId
            ? eq(schema.projectSources.workerId, options.workerId)
            : undefined,
        ),
      )
      .orderBy(
        desc(
          sql<boolean>`coalesce(${schema.projectSources.workerId} = ${schema.projects.preferredWorkerId}, false)`,
        ),
        desc(
          sql<boolean>`coalesce(${schema.projectSources.workerId} = ${schema.userSettings.defaultWorkerId}, false)`,
        ),
        asc(schema.projectSources.createdAt),
        asc(schema.projectSources.id),
      );
    const isWorkerAvailable = options.isWorkerAvailable;
    const selected = isWorkerAvailable
      ? (rows.find(({ workerId }) => isWorkerAvailable(workerId)) ?? rows[0])
      : rows[0];
    return selected ?? null;
  }

  async getProjectWorktreeContext(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<ProjectWorktreeExecutionContext | null> {
    const rows = await this.database
      .select({
        projectId: schema.projects.id,
        source: schema.projectSources,
        worktree: schema.projectWorktrees,
      })
      .from(schema.projectWorktrees)
      .innerJoin(
        schema.projectSources,
        eq(schema.projectSources.id, schema.projectWorktrees.projectSourceId),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectSources.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projectWorktrees.id, worktreeId),
          isNull(schema.projectSources.removedAt),
          eq(schema.projectWorktrees.lifecycleState, "ready"),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row
      ? {
          projectId: row.projectId,
          projectSourceId: row.source.id,
          sourcePath: row.source.absolutePath,
          workerId: row.worktree.workerId,
          worktree: toProjectWorktreeSummary(row.worktree, row.projectId),
        }
      : null;
  }
}
