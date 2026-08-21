import {
  githubProjectCreateSchema,
  managedFolderProjectCreateSchema,
  projectPreferredWorkerUpdateSchema,
  projectSummarySchema,
  type EncryptedGithubProjectCreate,
  type EncryptedManagedFolderProjectCreate,
  type GithubProjectCreate,
  type ManagedFolderProjectCreate,
  type ProjectPreferredWorkerUpdate,
  type ProjectSummary,
  type ProjectWorktreeSummary,
  type ProjectWireSummary,
  type WorktreePolicy,
} from "@cantrip/protocol";

import {
  createEncryptedGithubProject,
  createEncryptedManagedFolderProject,
  getProjectWorktrees,
  getProjectWireList,
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
    if (
      !this.api.listWorktrees ||
      (!project.source && project.replicas.length === 0)
    ) {
      return project;
    }
    let worktrees: ProjectWorktreeSummary[] = [];
    try {
      worktrees = await this.api.listWorktrees(project.id);
    } catch {
      // Fail closed: server-returned routing handles are never presented as
      // filesystem metadata when the authorized worker cannot open them.
    }
    const unavailablePath = "Protected path unavailable";
    const sourceWorktree = project.source
      ? worktrees.find(
          (worktree) =>
            worktree.projectSourceId === project.source?.id &&
            worktree.isPrimary,
        )
      : undefined;
    return {
      ...project,
      source: project.source
        ? {
            ...project.source,
            path: sourceWorktree?.path ?? unavailablePath,
            displayPath: sourceWorktree?.displayPath ?? unavailablePath,
          }
        : null,
      replicas: project.replicas.map((replica) => {
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
    return this.decrypt(
      await this.api.createGithub({
        ...parsed,
        id,
        nameProtection: await this.protectName(id, name),
      }),
    );
  }

  async createManagedFolder(
    input: ManagedFolderProjectCreate,
  ): Promise<ProjectSummary> {
    const parsed = managedFolderProjectCreateSchema.parse(input);
    const id = globalThis.crypto.randomUUID();
    const { name, ...publicInput } = parsed;
    return this.decrypt(
      await this.api.createManagedFolder({
        ...publicInput,
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
