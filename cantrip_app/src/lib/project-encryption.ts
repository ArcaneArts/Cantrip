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
  type ProjectWireSummary,
  type WorktreePolicy,
} from "@cantrip/protocol";

import {
  createEncryptedGithubProject,
  createEncryptedManagedFolderProject,
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
    const { nameProtection, ...publicProject } = project;
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
