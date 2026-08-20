import {
  clearSensitiveBytes,
  computeBlindLookupTag,
  decryptPayload,
  deriveFieldKey,
  deriveLookupKey,
  encryptPayload,
} from "@cantrip/crypto";
import {
  projectWorkspaceCreateSchema,
  projectWorkspaceSummarySchema,
  projectWorkspaceUpdateSchema,
  type EncryptedProjectWorkspaceCreate,
  type EncryptedProjectWorkspaceName,
  type EncryptedProjectWorkspaceUpdate,
  type ProjectWorkspaceCreate,
  type ProjectWorkspaceSummary,
  type ProjectWorkspaceUpdate,
  type ProjectWorkspaceWireList,
  type ProjectWorkspaceWireSummary,
} from "@cantrip/protocol";
import type {
  AccountEncryptionProfile,
  AccountEncryptionProfileState,
  EncryptionAssociatedData,
  EncryptionProfileMigrationUpdate,
} from "@cantrip/protocol/encryption";

import {
  createEncryptedProjectWorkspace,
  deleteProjectWorkspace as deleteProjectWorkspaceWire,
  getProjectWorkspaceWireList,
  updateEncryptedProjectWorkspace,
} from "./api";
import { CantripApiError } from "./api-client";
import {
  ClientEncryptionError,
  ClientEncryptionService,
  clientEncryption,
  type ClientEncryptionIdentity,
} from "./client-encryption";
import {
  getClientSession,
  notifyAuthenticationRequired,
} from "./client-session";
import { prepareClientEncryption } from "./account-encryption";
import {
  getAccountEncryptionProfile,
  updateAccountEncryptionMigration,
} from "./encryption-api";

const component = "workspace-display-name" as const;
const table = "project_workspaces";
const field = "name";
const formatVersion = 1 as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface ProjectWorkspaceWireApi {
  create(
    input: EncryptedProjectWorkspaceCreate,
  ): Promise<ProjectWorkspaceWireSummary>;
  delete(workspaceId: string): Promise<void>;
  getEncryptionProfile(): Promise<AccountEncryptionProfileState>;
  list(): Promise<ProjectWorkspaceWireList>;
  update(
    workspaceId: string,
    input: EncryptedProjectWorkspaceUpdate,
  ): Promise<ProjectWorkspaceWireSummary>;
  updateMigration(
    input: EncryptionProfileMigrationUpdate,
  ): Promise<AccountEncryptionProfile>;
}

const defaultApi: ProjectWorkspaceWireApi = {
  create: createEncryptedProjectWorkspace,
  delete: deleteProjectWorkspaceWire,
  getEncryptionProfile: getAccountEncryptionProfile,
  list: getProjectWorkspaceWireList,
  update: updateEncryptedProjectWorkspace,
  updateMigration: updateAccountEncryptionMigration,
};

function normalizedWorkspaceName(name: string): string {
  return name.trim().normalize("NFKC").toLowerCase();
}

function associatedData(
  identity: ClientEncryptionIdentity,
  rowId: string,
  keyRevision: number,
): EncryptionAssociatedData {
  return {
    ownerId: identity.ownerId,
    component,
    table,
    rowId,
    field,
    formatVersion,
    keyRevision,
  };
}

export class ProjectWorkspaceEncryptionAdapter {
  constructor(
    private readonly options: {
      api?: ProjectWorkspaceWireApi;
      onCredentialRequired?: (reason: string) => void;
      prepare?: typeof prepareClientEncryption;
      service?: ClientEncryptionService;
      session?: typeof getClientSession;
    } = {},
  ) {}

  private get api(): ProjectWorkspaceWireApi {
    return this.options.api ?? defaultApi;
  }

  private get service(): ClientEncryptionService {
    return this.options.service ?? clientEncryption;
  }

  private async identity(): Promise<{
    identity: ClientEncryptionIdentity;
    keyRevision: number;
  }> {
    const session = (this.options.session ?? getClientSession)();
    if (!session) {
      throw new ClientEncryptionError(
        "locked",
        "Workspace encryption is locked for this account.",
      );
    }
    let snapshot = this.service.getSnapshot();
    if (
      snapshot.status !== "ready" ||
      !snapshot.identity ||
      snapshot.masterKeyRevision === null ||
      snapshot.identity.ownerId !== session.user.id ||
      snapshot.identity.serverId !== session.serverId
    ) {
      const access = await (this.options.prepare ?? prepareClientEncryption)({
        authMode: session.authMode,
        identity: {
          ownerId: session.user.id,
          serverId: session.serverId,
        },
        service: this.service,
      });
      if (access.status !== "ready") {
        const reason =
          "This device encryption key must be authorized again. Sign in once to continue.";
        (this.options.onCredentialRequired ?? notifyAuthenticationRequired)(
          reason,
        );
        throw new ClientEncryptionError("locked", reason);
      }
      snapshot = this.service.getSnapshot();
    }
    if (
      snapshot.status !== "ready" ||
      !snapshot.identity ||
      snapshot.masterKeyRevision === null ||
      snapshot.identity.ownerId !== session.user.id ||
      snapshot.identity.serverId !== session.serverId
    ) {
      throw new ClientEncryptionError(
        "locked",
        "Workspace encryption is locked for this account.",
      );
    }
    return {
      identity: snapshot.identity,
      keyRevision: snapshot.masterKeyRevision,
    };
  }

  private async encryptName(
    rowId: string,
    name: string,
  ): Promise<EncryptedProjectWorkspaceName> {
    const { identity, keyRevision } = await this.identity();
    const componentKey = this.service.componentKey({
      component,
      identity,
      keyRevision,
    });
    const fieldKey = deriveFieldKey({
      componentKey,
      ownerId: identity.ownerId,
      component,
      table,
      field,
      keyRevision,
    });
    const lookupKey = deriveLookupKey({
      componentKey,
      ownerId: identity.ownerId,
      component,
      table,
      field,
      keyRevision,
    });
    const plaintext = encoder.encode(name.trim());
    try {
      return {
        state: "encrypted",
        formatVersion,
        keyRevision,
        blindIndex: computeBlindLookupTag(
          lookupKey,
          normalizedWorkspaceName(name),
        ),
        envelope: await encryptPayload({
          key: fieldKey,
          plaintext,
          associatedData: associatedData(identity, rowId, keyRevision),
        }),
      };
    } finally {
      clearSensitiveBytes(plaintext);
      clearSensitiveBytes(lookupKey);
      clearSensitiveBytes(fieldKey);
      clearSensitiveBytes(componentKey);
    }
  }

  private async decrypt(
    workspace: ProjectWorkspaceWireSummary,
  ): Promise<ProjectWorkspaceSummary> {
    if (workspace.nameProtection.state !== "encrypted") {
      throw new ClientEncryptionError(
        "decryption-failed",
        "A legacy workspace name was not migrated before use.",
      );
    }
    const { identity } = await this.identity();
    const keyRevision = workspace.nameProtection.keyRevision;
    const componentKey = this.service.componentKey({
      component,
      identity,
      keyRevision,
    });
    const fieldKey = deriveFieldKey({
      componentKey,
      ownerId: identity.ownerId,
      component,
      table,
      field,
      keyRevision,
    });
    let plaintext: Uint8Array | null = null;
    try {
      plaintext = await decryptPayload({
        key: fieldKey,
        envelope: workspace.nameProtection.envelope,
        associatedData: associatedData(identity, workspace.id, keyRevision),
      });
      return projectWorkspaceSummarySchema.parse({
        id: workspace.id,
        name: decoder.decode(plaintext),
        position: workspace.position,
        isDefault: workspace.isDefault,
        projectIds: workspace.projectIds,
        revision: workspace.revision,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      });
    } catch {
      throw new ClientEncryptionError(
        "decryption-failed",
        "A workspace name could not be authenticated.",
      );
    } finally {
      if (plaintext) clearSensitiveBytes(plaintext);
      clearSensitiveBytes(fieldKey);
      clearSensitiveBytes(componentKey);
    }
  }

  private async markMigration(
    status: "in-progress" | "complete",
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await this.api.getEncryptionProfile();
      if (state.status !== "initialized") {
        throw new ClientEncryptionError(
          "locked",
          "Workspace migration requires initialized encryption.",
        );
      }
      if (
        state.profile.payloadMigrationStatus === status ||
        (status === "in-progress" &&
          state.profile.payloadMigrationStatus === "complete")
      ) {
        return;
      }
      try {
        await this.api.updateMigration({
          expectedRevision: state.profile.revision,
          payloadMigrationStatus: status,
        });
        return;
      } catch (error) {
        if (!(error instanceof CantripApiError) || error.status !== 409) {
          throw error;
        }
      }
    }
    throw new ClientEncryptionError(
      "decryption-failed",
      "Encryption migration state could not be saved.",
    );
  }

  private async migrateLegacy(
    initial: ProjectWorkspaceWireList,
  ): Promise<ProjectWorkspaceWireList> {
    if (initial.legacyCount === 0) return initial;
    await this.markMigration("in-progress");
    for (const workspace of initial.workspaces) {
      if (workspace.nameProtection.state !== "legacy") continue;
      const nameProtection = await this.encryptName(
        workspace.id,
        workspace.nameProtection.plaintext,
      );
      try {
        await this.api.update(workspace.id, {
          expectedRevision: workspace.revision,
          nameProtection,
        });
      } catch (error) {
        if (!(error instanceof CantripApiError) || error.status !== 409) {
          throw error;
        }
      }
    }
    const migrated = await this.api.list();
    if (migrated.legacyCount !== 0) {
      throw new ClientEncryptionError(
        "decryption-failed",
        "Workspace encryption migration did not finish.",
      );
    }
    await this.markMigration("complete");
    return migrated;
  }

  async list(): Promise<ProjectWorkspaceSummary[]> {
    await this.identity();
    const wire = await this.migrateLegacy(await this.api.list());
    return Promise.all(
      wire.workspaces.map((workspace) => this.decrypt(workspace)),
    );
  }

  async create(
    input: ProjectWorkspaceCreate,
  ): Promise<ProjectWorkspaceSummary> {
    const parsed = projectWorkspaceCreateSchema.parse(input);
    await this.identity();
    const id = globalThis.crypto.randomUUID();
    return this.decrypt(
      await this.api.create({
        id,
        nameProtection: await this.encryptName(id, parsed.name),
      }),
    );
  }

  async update(
    workspaceId: string,
    input: ProjectWorkspaceUpdate,
  ): Promise<ProjectWorkspaceSummary> {
    const parsed = projectWorkspaceUpdateSchema.parse(input);
    await this.identity();
    const current = (
      await this.migrateLegacy(await this.api.list())
    ).workspaces.find(({ id }) => id === workspaceId);
    if (!current) throw new Error("Workspace not found.");
    return this.decrypt(
      await this.api.update(workspaceId, {
        expectedRevision: current.revision,
        ...(parsed.name === undefined
          ? {}
          : {
              nameProtection: await this.encryptName(workspaceId, parsed.name),
            }),
        ...(parsed.projectIds === undefined
          ? {}
          : { projectIds: parsed.projectIds }),
        ...(parsed.isDefault ? { isDefault: true as const } : {}),
      }),
    );
  }

  async delete(workspaceId: string): Promise<void> {
    await this.identity();
    await this.api.delete(workspaceId);
  }
}

const projectWorkspaceEncryption = new ProjectWorkspaceEncryptionAdapter();

export const getProjectWorkspaces = () => projectWorkspaceEncryption.list();
export const createProjectWorkspace = (input: ProjectWorkspaceCreate) =>
  projectWorkspaceEncryption.create(input);
export const updateProjectWorkspace = (
  workspaceId: string,
  input: ProjectWorkspaceUpdate,
) => projectWorkspaceEncryption.update(workspaceId, input);
export const deleteProjectWorkspace = (workspaceId: string) =>
  projectWorkspaceEncryption.delete(workspaceId);
