import {
  encryptedProjectReplicaPlacementRequestSchema,
  githubProjectCreateSchema,
  managedFolderProjectCreateSchema,
  projectGithubConversionRepositorySchema,
  projectPreferredWorkerUpdateSchema,
  projectSummarySchema,
  type EncryptedGithubProjectCreate,
  type EncryptedManagedFolderProjectCreate,
  type GithubProjectCreate,
  type ManagedFolderProjectCreate,
  type ProjectPreferredWorkerUpdate,
  type ProjectGithubConversionRepository,
  type ProjectGithubRoutingRepository,
  type ProjectSummary,
  type ProjectWorktreeSummary,
  type ProjectWireSummary,
  type WorktreePolicy,
} from "@cantrip/protocol";
import { repositoryRoutingHandleSchema } from "@cantrip/protocol/repository-operation";

import {
  createEncryptedGithubProject,
  createEncryptedManagedFolderProject,
  getProjectWorktrees,
  getProjectWireList,
  protectWorkerRepositoryIdentity,
  registerWorkerRepositoryMetadata,
  resolveWorkerRepositoryMetadata,
  updateProjectPreferredWorkerWire,
  updateProjectWorktreePolicyWire,
} from "./api";
import type { ClientEncryptionService } from "./client-encryption";
import { clientEncryption } from "./client-encryption";
import { getClientSession } from "./client-session";
import {
  decodePrivateDisplayLabelForClient,
  encodePrivateDisplayLabelForClient,
} from "./private-label-encryption";

export interface ProjectWireApi {
  createGithub(
    input: EncryptedGithubProjectCreate,
  ): Promise<ProjectWireSummary>;
  createManagedFolder(
    input: EncryptedManagedFolderProjectCreate,
  ): Promise<ProjectWireSummary>;
  list(): Promise<ProjectWireSummary[]>;
  listWorktrees?(projectId: string): Promise<ProjectWorktreeSummary[]>;
  protectRepositoryIdentity?(input: {
    projectId: string;
    repository: ProjectGithubConversionRepository;
    workerId: string;
  }): Promise<{
    repository: ProjectGithubRoutingRepository;
    repositoryBlindIndex: string;
  }>;
  registerMetadata?(input: {
    scopeId: string;
    values: Record<string, string | string[] | null>;
    workerId: string;
  }): Promise<{ values: Record<string, string | string[] | null> }>;
  resolveMetadata?(input: {
    scopeId: string;
    values: Record<string, string | string[] | null>;
    workerId: string;
  }): Promise<{ values: Record<string, string | string[] | null> }>;
  updatePreferredWorker(
    projectId: string,
    input: ProjectPreferredWorkerUpdate,
  ): Promise<ProjectWireSummary>;
  updateWorktreePolicy(
    projectId: string,
    policy: WorktreePolicy,
  ): Promise<ProjectWireSummary>;
}

const defaultApi: ProjectWireApi = {
  createGithub: createEncryptedGithubProject,
  createManagedFolder: createEncryptedManagedFolderProject,
  list: getProjectWireList,
  listWorktrees: getProjectWorktrees,
  protectRepositoryIdentity: protectWorkerRepositoryIdentity,
  registerMetadata: registerWorkerRepositoryMetadata,
  resolveMetadata: resolveWorkerRepositoryMetadata,
  updatePreferredWorker: updateProjectPreferredWorkerWire,
  updateWorktreePolicy: updateProjectWorktreePolicyWire,
};

export class ProjectEncryptionAdapter {
  constructor(
    private readonly options: {
      api?: ProjectWireApi;
      service?: ClientEncryptionService;
      session?: typeof getClientSession;
    } = {},
  ) {}

  private get api(): ProjectWireApi {
    return this.options.api ?? defaultApi;
  }

  private get service(): ClientEncryptionService {
    return this.options.service ?? clientEncryption;
  }

  private identity() {
    const session = (this.options.session ?? getClientSession)();
    if (!session) {
      throw new Error("An authenticated session is required for projects.");
    }
    return { ownerId: session.user.id, serverId: session.serverId };
  }

  private async protectName(
    projectId: string,
    name: string,
  ): Promise<ProjectWireSummary["nameProtection"]> {
    return encodePrivateDisplayLabelForClient({
      identity: this.identity(),
      label: name.trim(),
      recordKind: "project",
      rowId: projectId,
      service: this.service,
    });
  }

  private async decrypt(project: ProjectWireSummary): Promise<ProjectSummary> {
    const routedProject = await this.hydrateRoutingMetadata(project);
    const { nameProtection, ...publicProject } = routedProject;
    return projectSummarySchema.parse({
      ...publicProject,
      name: await decodePrivateDisplayLabelForClient({
        identity: this.identity(),
        opaque: nameProtection,
        recordKind: "project",
        rowId: project.id,
        service: this.service,
      }),
    });
  }

  private async hydrateRoutingMetadata(
    project: ProjectWireSummary,
  ): Promise<ProjectWireSummary> {
    let routedProject = project;
    const workerId =
      project.source?.workerId ??
      project.preferredWorkerId ??
      project.replicas[0]?.workerId;
    const protectedGithub =
      project.github &&
      repositoryRoutingHandleSchema.safeParse(project.github.repositoryId)
        .success &&
      repositoryRoutingHandleSchema.safeParse(project.github.nameWithOwner)
        .success &&
      repositoryRoutingHandleSchema.safeParse(project.github.url).success;
    const protectedSetupError =
      project.setupError &&
      repositoryRoutingHandleSchema.safeParse(project.setupError).success;
    if (
      workerId &&
      this.api.resolveMetadata &&
      (protectedGithub || protectedSetupError)
    ) {
      try {
        const resolved = await this.api.resolveMetadata({
          workerId,
          scopeId: project.id,
          values: {
            ...(protectedGithub ? project.github : {}),
            ...(protectedSetupError ? { setupError: project.setupError } : {}),
          },
        });
        routedProject = {
          ...project,
          github: protectedGithub
            ? projectGithubConversionRepositorySchema.parse(resolved.values)
            : project.github,
          setupError: protectedSetupError
            ? typeof resolved.values.setupError === "string"
              ? resolved.values.setupError
              : "Protected setup error unavailable"
            : project.setupError,
        };
      } catch {
        routedProject = {
          ...project,
          github: protectedGithub ? null : project.github,
          setupError: protectedSetupError
            ? "Protected setup error unavailable"
            : project.setupError,
        };
      }
    }
    if (
      !this.api.listWorktrees ||
      (!project.source && project.replicas.length === 0)
    ) {
      return routedProject;
    }
    let worktrees: ProjectWorktreeSummary[] = [];
    try {
      worktrees = await this.api.listWorktrees(project.id);
    } catch {
      // Fail closed: server-returned routing handles are never presented as
      // filesystem metadata when the authorized worker cannot open them.
    }
    const unavailablePath = "Protected path unavailable";
    const hydratedReplicas = [...project.replicas];
    if (this.api.resolveMetadata) {
      const replicasByWorker = new Map<
        string,
        Array<{
          index: number;
          replica: ProjectWireSummary["replicas"][number];
        }>
      >();
      project.replicas.forEach((replica, index) => {
        if (!replica.requestedPath && !replica.linkPath) return;
        const group = replicasByWorker.get(replica.workerId) ?? [];
        group.push({ index, replica });
        replicasByWorker.set(replica.workerId, group);
      });
      await Promise.all(
        [...replicasByWorker].map(async ([replicaWorkerId, entries]) => {
          const requested = entries.flatMap(({ replica }) =>
            replica.requestedPath ? [replica.requestedPath] : [],
          );
          const links = entries.flatMap(({ replica }) =>
            replica.linkPath ? [replica.linkPath] : [],
          );
          try {
            const resolved = await this.api.resolveMetadata!({
              workerId: replicaWorkerId,
              scopeId: project.id,
              values: {
                ...(requested.length ? { requestedPath: requested } : {}),
                ...(links.length ? { linkPath: links } : {}),
              },
            });
            const resolvedRequested = Array.isArray(
              resolved.values.requestedPath,
            )
              ? resolved.values.requestedPath
              : [];
            const resolvedLinks = Array.isArray(resolved.values.linkPath)
              ? resolved.values.linkPath
              : [];
            let requestedIndex = 0;
            let linkIndex = 0;
            for (const { index, replica } of entries) {
              hydratedReplicas[index] = {
                ...replica,
                requestedPath: replica.requestedPath
                  ? (resolvedRequested[requestedIndex++] ?? unavailablePath)
                  : null,
                linkPath: replica.linkPath
                  ? (resolvedLinks[linkIndex++] ?? unavailablePath)
                  : null,
              };
            }
          } catch {
            for (const { index, replica } of entries) {
              hydratedReplicas[index] = {
                ...replica,
                requestedPath: replica.requestedPath ? unavailablePath : null,
                linkPath: replica.linkPath ? unavailablePath : null,
              };
            }
          }
        }),
      );
    }
    const sourceWorktree = project.source
      ? worktrees.find(
          (worktree) =>
            worktree.projectSourceId === project.source?.id &&
            worktree.isPrimary,
        )
      : undefined;
    const sourcePlacement = project.source
      ? hydratedReplicas.find(({ id }) => id === project.source?.id)
      : undefined;
    return {
      ...routedProject,
      source: project.source
        ? {
            ...project.source,
            ...(sourcePlacement
              ? {
                  requestedPath: sourcePlacement.requestedPath,
                  linkPath: sourcePlacement.linkPath,
                }
              : {}),
            path: sourceWorktree?.path ?? unavailablePath,
            displayPath: sourceWorktree?.displayPath ?? unavailablePath,
          }
        : null,
      replicas: hydratedReplicas.map((replica) => {
        const worktree = replica.primaryWorktreeId
          ? worktrees.find(({ id }) => id === replica.primaryWorktreeId)
          : undefined;
        return {
          ...replica,
          path: worktree?.path ?? unavailablePath,
          displayPath: worktree?.displayPath ?? unavailablePath,
          branch: worktree?.branch ?? null,
        };
      }),
    };
  }

  async list(): Promise<ProjectSummary[]> {
    const projects = await Promise.all(
      (await this.api.list()).map((project) => this.decrypt(project)),
    );
    return projects.sort(
      (left, right) =>
        left.position - right.position ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    );
  }

  async createGithub(input: GithubProjectCreate): Promise<ProjectSummary> {
    const parsed = githubProjectCreateSchema.parse(input);
    const id = globalThis.crypto.randomUUID();
    const name = parsed.nameWithOwner.split("/").at(-1) ?? parsed.nameWithOwner;
    if (!this.api.protectRepositoryIdentity) {
      throw new Error("Protected repository identity is unavailable.");
    }
    const {
      workerId,
      workspaceIds,
      placement = { mode: "managed" as const },
      ...repository
    } = parsed;
    const protectedIdentity = await this.api.protectRepositoryIdentity({
      workerId,
      projectId: id,
      repository,
    });
    let protectedPlacement =
      encryptedProjectReplicaPlacementRequestSchema.parse({ mode: "managed" });
    if (placement.mode !== "managed") {
      if (!this.api.registerMetadata) {
        throw new Error("Protected repository metadata is unavailable.");
      }
      const registered = await this.api.registerMetadata({
        workerId,
        scopeId: id,
        values: { placementPath: placement.path },
      });
      protectedPlacement = encryptedProjectReplicaPlacementRequestSchema.parse({
        mode: placement.mode,
        path: registered.values.placementPath,
      });
    }
    return this.decrypt(
      await this.api.createGithub({
        workerId,
        workspaceIds,
        placement: protectedPlacement,
        id,
        nameProtection: await this.protectName(id, name),
        repositoryBlindIndex: protectedIdentity.repositoryBlindIndex,
        ...protectedIdentity.repository,
      }),
    );
  }

  async createManagedFolder(
    input: ManagedFolderProjectCreate,
  ): Promise<ProjectSummary> {
    const parsed = managedFolderProjectCreateSchema.parse(input);
    const id = globalThis.crypto.randomUUID();
    const { existingPath, name, ...publicInput } = parsed;
    let existingPathHandle: string | undefined;
    if (existingPath) {
      if (!this.api.registerMetadata) {
        throw new Error("Protected repository metadata is unavailable.");
      }
      const registered = await this.api.registerMetadata({
        workerId: parsed.workerId,
        scopeId: id,
        values: { existingPath },
      });
      existingPathHandle = repositoryRoutingHandleSchema.parse(
        registered.values.existingPath,
      );
    }
    return this.decrypt(
      await this.api.createManagedFolder({
        ...publicInput,
        ...(existingPathHandle ? { existingPath: existingPathHandle } : {}),
        id,
        nameProtection: await this.protectName(id, name),
      }),
    );
  }

  async updatePreferredWorker(
    projectId: string,
    input: ProjectPreferredWorkerUpdate,
  ): Promise<ProjectSummary> {
    return this.decrypt(
      await this.api.updatePreferredWorker(
        projectId,
        projectPreferredWorkerUpdateSchema.parse(input),
      ),
    );
  }

  async updateWorktreePolicy(
    projectId: string,
    policy: WorktreePolicy,
  ): Promise<ProjectSummary> {
    return this.decrypt(await this.api.updateWorktreePolicy(projectId, policy));
  }
}

const projectEncryption = new ProjectEncryptionAdapter();

export const getProjects = () => projectEncryption.list();
export const createGithubProject = (input: GithubProjectCreate) =>
  projectEncryption.createGithub(input);
export const createManagedFolderProject = (input: ManagedFolderProjectCreate) =>
  projectEncryption.createManagedFolder(input);
export const updateProjectPreferredWorker = (
  projectId: string,
  input: ProjectPreferredWorkerUpdate,
) => projectEncryption.updatePreferredWorker(projectId, input);
export const updateProjectWorktreePolicy = (
  projectId: string,
  policy: WorktreePolicy,
) => projectEncryption.updateWorktreePolicy(projectId, policy);
