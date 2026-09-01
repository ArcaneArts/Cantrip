import { randomUUID } from "node:crypto";

import type {
  EncryptedGithubProjectCreate,
  EncryptedManagedFolderProjectCreate,
  ProjectCloneResult,
  ProjectFolderSetupJobSummary,
  ProjectReplicaSummary,
  ProjectWireSummary,
} from "@cantrip/protocol";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import * as schema from "../schema.js";
import { firstOrThrow, type RepositoryDatabase } from "./database.js";
import {
  ProjectWorkspaceInvariantError,
  toProjectWireSummary,
} from "./projects.js";

export interface ProjectRemovalContext {
  convertedManagedFolderSource: {
    localFilesDeleted: boolean;
    projectSourceId: string;
    workerId: string;
  } | null;
  folderManagement: ProjectWireSummary["folderManagement"];
  originKind: ProjectWireSummary["originKind"];
  preferredWorkerId: string | null;
  replicas: Array<{
    cwd: string;
    id: string;
    workerId: string;
  }>;
  remoteSurfaces: Array<{ id: string; workerId: string }>;
  setupStatus: ProjectWireSummary["setupStatus"];
  terminals: Array<{
    id: string;
    workerId: string;
  }>;
}

export interface GithubProjectExecutionContext {
  nameWithOwner: string;
  url: string;
  workerId: string;
}

export interface ProjectLifecycleRepositoryCollaborators {
  ensureDefaultProjectWorkspace(ownerId: string): Promise<{ id: string }>;
  getConvertedManagedFolderSource(
    ownerId: string,
    projectId: string,
  ): Promise<{
    localFilesDeleted: boolean;
    projectSourceId: string;
    workerId: string;
  } | null>;
  getProjectFolderSetupJob(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectFolderSetupJobSummary | null>;
  listProjectReplicas(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectReplicaSummary[] | null>;
}

export class ProjectLifecycleRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: ProjectLifecycleRepositoryCollaborators,
  ) {}

  async getGithubProjectExecutionContext(
    ownerId: string,
    projectId: string,
    workerId?: string,
  ): Promise<GithubProjectExecutionContext | null> {
    const rows = await this.database
      .select({
        nameWithOwner: schema.projects.githubRepositoryFullName,
        url: schema.projects.githubRepositoryUrl,
        projectReplicaId: schema.projectSources.id,
        workerId: schema.projectSources.workerId,
      })
      .from(schema.projects)
      .innerJoin(
        schema.projectSources,
        eq(schema.projectSources.projectId, schema.projects.id),
      )
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
          isNull(schema.projectSources.removedAt),
          workerId ? eq(schema.projectSources.workerId, workerId) : undefined,
        ),
      )
      .orderBy(asc(schema.projectSources.createdAt))
      .limit(1);
    const row = rows[0];
    if (!row?.nameWithOwner || !row.url) return null;
    const provision = await this.database
      .select({ repository: schema.projectReplicaJobs.repository })
      .from(schema.projectReplicaJobs)
      .where(
        and(
          eq(schema.projectReplicaJobs.ownerId, ownerId),
          eq(schema.projectReplicaJobs.projectId, projectId),
          eq(schema.projectReplicaJobs.projectReplicaId, row.projectReplicaId),
          eq(schema.projectReplicaJobs.workerId, row.workerId),
          eq(schema.projectReplicaJobs.kind, "provision"),
          eq(schema.projectReplicaJobs.state, "succeeded"),
        ),
      )
      .orderBy(desc(schema.projectReplicaJobs.completedAt))
      .limit(1);
    return {
      nameWithOwner: provision[0]?.repository ?? row.nameWithOwner,
      url: row.url,
      workerId: row.workerId,
    };
  }

  async hasGithubProject(ownerId: string, repositoryBlindIndex: string) {
    const [projects, conversions] = await Promise.all([
      this.database
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.ownerId, ownerId),
            eq(
              schema.projects.githubRepositoryBlindIndex,
              repositoryBlindIndex,
            ),
          ),
        )
        .limit(1),
      this.database
        .select({ id: schema.projectGithubConversionJobs.id })
        .from(schema.projectGithubConversionJobs)
        .where(
          and(
            eq(schema.projectGithubConversionJobs.ownerId, ownerId),
            eq(
              schema.projectGithubConversionJobs.repositoryBlindIndex,
              repositoryBlindIndex,
            ),
            inArray(schema.projectGithubConversionJobs.state, [
              "queued",
              "running",
              "blocked",
            ]),
          ),
        )
        .limit(1),
    ]);
    return Boolean(projects[0] || conversions[0]);
  }

  async listGithubRepositoryIds(ownerId: string): Promise<Set<string>> {
    const [rows, conversions] = await Promise.all([
      this.database
        .select({
          repositoryId: schema.projects.githubRepositoryBlindIndex,
        })
        .from(schema.projects)
        .where(eq(schema.projects.ownerId, ownerId)),
      this.database
        .select({
          repositoryId: schema.projectGithubConversionJobs.repositoryBlindIndex,
        })
        .from(schema.projectGithubConversionJobs)
        .where(
          and(
            eq(schema.projectGithubConversionJobs.ownerId, ownerId),
            inArray(schema.projectGithubConversionJobs.state, [
              "queued",
              "running",
              "blocked",
            ]),
          ),
        ),
    ]);
    return new Set([
      ...rows.flatMap(({ repositoryId }) =>
        repositoryId === null ? [] : [repositoryId],
      ),
      ...conversions.map(({ repositoryId }) => repositoryId),
    ]);
  }

  async createGithubProject(
    ownerId: string,
    input: EncryptedGithubProjectCreate,
  ): Promise<ProjectWireSummary> {
    const defaultWorkspace =
      await this.collaborators.ensureDefaultProjectWorkspace(ownerId);
    const workspaceIds = [
      ...new Set(input.workspaceIds ?? [defaultWorkspace.id]),
    ];
    const ownedWorkspaces = await this.database
      .select({ id: schema.projectWorkspaces.id })
      .from(schema.projectWorkspaces)
      .where(
        and(
          eq(schema.projectWorkspaces.ownerId, ownerId),
          inArray(schema.projectWorkspaces.id, workspaceIds),
        ),
      );
    if (ownedWorkspaces.length !== workspaceIds.length) {
      throw new ProjectWorkspaceInvariantError(
        "Project import referenced an unknown workspace.",
      );
    }
    const project = await this.database.transaction(async (transaction) => {
      const lastProjects = await transaction
        .select({ position: schema.projects.position })
        .from(schema.projects)
        .where(eq(schema.projects.ownerId, ownerId))
        .orderBy(desc(schema.projects.position))
        .limit(1);
      const projectResult = await transaction
        .insert(schema.projects)
        .values({
          id: input.id,
          ownerId,
          protectedLabel: input.nameProtection,
          position: (lastProjects[0]?.position ?? -1) + 1,
          originKind: "github",
          setupStatus: "cloning",
          setupError: null,
          preferredWorkerId: input.workerId,
          githubRepositoryBlindIndex: input.repositoryBlindIndex,
          githubRepositoryId: input.repositoryId,
          githubRepositoryFullName: input.nameWithOwner,
          githubRepositoryUrl: input.url,
        })
        .returning();
      const created = firstOrThrow(projectResult, "creating a GitHub project");
      await transaction.insert(schema.projectWorkspaceMemberships).values(
        workspaceIds.map((workspaceId) => ({
          workspaceId,
          projectId: created.id,
        })),
      );
      return created;
    });
    return toProjectWireSummary(project);
  }

  async createManagedFolderProject(
    ownerId: string,
    input: EncryptedManagedFolderProjectCreate,
  ): Promise<{
    job: ProjectFolderSetupJobSummary;
    project: ProjectWireSummary;
  }> {
    const defaultWorkspace =
      await this.collaborators.ensureDefaultProjectWorkspace(ownerId);
    const workspaceIds = [
      ...new Set(input.workspaceIds ?? [defaultWorkspace.id]),
    ];
    const ownedWorkspaces = await this.database
      .select({ id: schema.projectWorkspaces.id })
      .from(schema.projectWorkspaces)
      .where(
        and(
          eq(schema.projectWorkspaces.ownerId, ownerId),
          inArray(schema.projectWorkspaces.id, workspaceIds),
        ),
      );
    if (ownedWorkspaces.length !== workspaceIds.length) {
      throw new ProjectWorkspaceInvariantError(
        "Folder project creation referenced an unknown workspace.",
      );
    }
    const projectId = input.id;
    const jobId = randomUUID();
    const project = await this.database.transaction(async (transaction) => {
      const workers = await transaction
        .select({ id: schema.workers.id })
        .from(schema.workers)
        .where(
          and(
            eq(schema.workers.id, input.workerId),
            eq(schema.workers.ownerId, ownerId),
            isNull(schema.workers.unlinkedAt),
          ),
        )
        .limit(1);
      if (!workers[0]) {
        throw new ProjectWorkspaceInvariantError("Worker not found.");
      }
      const lastProjects = await transaction
        .select({ position: schema.projects.position })
        .from(schema.projects)
        .where(eq(schema.projects.ownerId, ownerId))
        .orderBy(desc(schema.projects.position))
        .limit(1);
      const projectRows = await transaction
        .insert(schema.projects)
        .values({
          id: projectId,
          ownerId,
          protectedLabel: input.nameProtection,
          position: (lastProjects[0]?.position ?? -1) + 1,
          originKind: "managed-folder",
          folderManagement: input.existingPath ? "external" : "managed",
          setupStatus: "preparing",
          setupError: null,
          worktreePolicy: "direct",
          gitCapability: false,
          githubCapability: false,
          preferredWorkerId: input.workerId,
          githubRepositoryBlindIndex: null,
          githubRepositoryId: null,
          githubRepositoryFullName: null,
          githubRepositoryUrl: null,
        })
        .returning();
      await transaction
        .insert(schema.projectWorkspaceMemberships)
        .values(
          workspaceIds.map((workspaceId) => ({ workspaceId, projectId })),
        );
      await transaction.insert(schema.projectFolderSetupJobs).values({
        id: jobId,
        ownerId,
        projectId,
        workerId: input.workerId,
        requestedPath: input.existingPath ?? null,
        state: "queued",
      });
      return firstOrThrow(projectRows, "creating a folder project");
    });
    const job = await this.collaborators.getProjectFolderSetupJob(
      ownerId,
      projectId,
    );
    if (!job) throw new Error("Folder setup job was not created.");
    return { job, project: toProjectWireSummary(project) };
  }

  async completeGithubProjectSetup(
    ownerId: string,
    projectId: string,
    workerId: string,
    clone: ProjectCloneResult,
  ): Promise<ProjectWireSummary | null> {
    const completed = await this.database.transaction(async (transaction) => {
      const projectRows = await transaction
        .select()
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!projectRows[0]) return null;
      const sourceResult = await transaction
        .insert(schema.projectSources)
        .values({
          id: randomUUID(),
          projectId,
          workerId,
          sourceKind: "git",
          absolutePath: clone.path,
          displayPath: clone.displayPath,
        })
        .returning();
      const source = firstOrThrow(sourceResult, "recording a project source");
      await transaction.insert(schema.projectWorktrees).values({
        id: randomUUID(),
        projectSourceId: source.id,
        workerId,
        rootKind: "git-worktree",
        name: "Primary",
        absolutePath: clone.path,
        displayPath: clone.displayPath,
        isPrimary: true,
        isDefault: true,
        origin: "cantrip",
        lifecycleState: "ready",
      });
      const projectResult = await transaction
        .update(schema.projects)
        .set({
          setupStatus: "ready",
          setupError: null,
          worktreePolicy: clone.worktreePolicy ?? projectRows[0].worktreePolicy,
          updatedAt: new Date(),
        })
        .where(eq(schema.projects.id, projectId))
        .returning();
      return firstOrThrow(projectResult, "completing project setup");
    });
    return completed
      ? toProjectWireSummary(
          completed,
          (await this.collaborators.listProjectReplicas(ownerId, projectId)) ??
            [],
        )
      : null;
  }

  async getProjectRemovalContext(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectRemovalContext | null> {
    const rows = await this.database
      .select({
        folderManagement: schema.projects.folderManagement,
        originKind: schema.projects.originKind,
        preferredWorkerId: schema.projects.preferredWorkerId,
        projectId: schema.projects.id,
        setupStatus: schema.projects.setupStatus,
      })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);
    const project = rows[0];
    if (!project) return null;
    const convertedManagedFolderSource =
      project.originKind === "github"
        ? await this.collaborators.getConvertedManagedFolderSource(
            ownerId,
            projectId,
          )
        : null;
    const replicas = await this.database
      .select({
        cwd: schema.projectSources.absolutePath,
        id: schema.projectSources.id,
        workerId: schema.projectSources.workerId,
      })
      .from(schema.projectSources)
      .where(
        and(
          eq(schema.projectSources.projectId, projectId),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .orderBy(
        asc(schema.projectSources.createdAt),
        asc(schema.projectSources.id),
      );
    const terminals = await this.database
      .select({
        id: schema.terminals.id,
        workerId: schema.terminals.activeWorkerId,
      })
      .from(schema.terminals)
      .where(eq(schema.terminals.projectId, projectId));
    const remoteSurfaces = await this.database
      .select({ surface: schema.remoteSurfaces })
      .from(schema.remoteSurfaces)
      .where(eq(schema.remoteSurfaces.projectId, projectId));
    return {
      convertedManagedFolderSource,
      folderManagement: project.folderManagement,
      originKind: project.originKind,
      preferredWorkerId: project.preferredWorkerId,
      replicas,
      remoteSurfaces: remoteSurfaces.map(({ surface }) => ({
        id: surface.id,
        workerId: surface.workerId,
      })),
      setupStatus: project.setupStatus as ProjectWireSummary["setupStatus"],
      terminals,
    };
  }

  async deleteProject(ownerId: string, projectId: string): Promise<boolean> {
    const deleted = await this.database
      .delete(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .returning({ id: schema.projects.id });
    if (deleted.length !== 1) return false;
    await this.database
      .update(schema.userSettings)
      .set({
        mobileProjectTabConfigurations: sql`${schema.userSettings.mobileProjectTabConfigurations} - ${projectId}`,
        updatedAt: new Date(),
      })
      .where(eq(schema.userSettings.userId, ownerId));
    return true;
  }
}
