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
import type { EncryptionAssociatedData } from "@cantrip/protocol/encryption";

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
import { clientLogger, operationalErrorMetadata } from "./client-log-relay";

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
  list(): Promise<ProjectWorkspaceWireList>;
  update(
    workspaceId: string,
    input: EncryptedProjectWorkspaceUpdate,
  ): Promise<ProjectWorkspaceWireSummary>;
}

const defaultApi: ProjectWorkspaceWireApi = {
  create: createEncryptedProjectWorkspace,
  delete: deleteProjectWorkspaceWire,
  list: getProjectWorkspaceWireList,
  update: updateEncryptedProjectWorkspace,
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
      clientLogger.warn("Workspace encryption has no active client session", {
        event: "encryption.workspace.identity.failed",
        operation: "prepare-workspace-encryption",
        reasonCode: "client-session-missing",
        status: "locked",
        subsystem: "encryption",
      });
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
      let access: Awaited<ReturnType<typeof prepareClientEncryption>>;
      try {
        access = await (this.options.prepare ?? prepareClientEncryption)({
          authMode: session.authMode,
          identity: {
            ownerId: session.user.id,
            serverId: session.serverId,
          },
          service: this.service,
        });
      } catch (error) {
        clientLogger.warn("Workspace encryption preparation failed", {
          ...operationalErrorMetadata(error),
          event: "encryption.workspace.prepare.failed",
          operation: "prepare-workspace-encryption",
          reasonCode: "preparation-failed",
          status: "locked",
          subsystem: "encryption",
        });
        throw error;
      }
      if (access.status !== "ready") {
        clientLogger.warn("Workspace encryption needs client authorization", {
          ...(access.status === "credential-required"
            ? { credential: access.credential, reason: access.reason }
            : {}),
          event: "encryption.workspace.authorization-required",
          operation: "prepare-workspace-encryption",
          reasonCode:
            access.status === "credential-required"
              ? "device-authorization-required"
              : "recovery-acknowledgment-required",
          status: "locked",
          subsystem: "encryption",
        });
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
      clientLogger.warn(
        "Workspace encryption remained locked after preparation",
        {
          event: "encryption.workspace.identity.failed",
          operation: "prepare-workspace-encryption",
          reasonCode: "prepared-key-state-not-ready",
          status: "locked",
          subsystem: "encryption",
        },
      );
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
        "The system-default workspace name was not sealed before use.",
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

  private async sealSystemDefault(
    initial: ProjectWorkspaceWireList,
  ): Promise<ProjectWorkspaceWireList> {
    if (
      initial.workspaces.every(
        ({ nameProtection }) => nameProtection.state === "encrypted",
      )
    ) {
      return initial;
    }
    for (const workspace of initial.workspaces) {
      if (workspace.nameProtection.state !== "system-default") continue;
      const nameProtection = await this.encryptName(workspace.id, "Default");
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
    const sealed = await this.api.list();
    if (
      sealed.workspaces.some(
        ({ nameProtection }) => nameProtection.state !== "encrypted",
      )
    ) {
      throw new ClientEncryptionError(
        "decryption-failed",
        "The system-default workspace name could not be sealed.",
      );
    }
    return sealed;
  }

  async list(): Promise<ProjectWorkspaceSummary[]> {
    await this.identity();
    const wire = await this.sealSystemDefault(await this.api.list());
    return Promise.all(
      wire.workspaces.map((workspace) => this.decrypt(workspace)),
    );
  }

  async create(
    input: ProjectWorkspaceCreate,
  ): Promise<ProjectWorkspaceSummary> {
    const parsed = projectWorkspaceCreateSchema.parse(input);
    await this.identity();
    await this.sealSystemDefault(await this.api.list());
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
      await this.sealSystemDefault(await this.api.list())
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
