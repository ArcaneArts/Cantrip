import type {
  EncryptedProjectWorkspaceCreate,
  EncryptedProjectWorkspaceUpdate,
  ProjectSummary,
  ProjectWorkspaceWireList,
  ProjectWorkspaceWireSummary,
} from "@cantrip/protocol";
import type {
  AccountEncryptionProfile,
  AccountEncryptionProfileState,
  EncryptionProfileMigrationUpdate,
} from "@cantrip/protocol/encryption";
import { describe, expect, it } from "vitest";

import { CantripApiError } from "./api-client";
import { ClientEncryptionService } from "./client-encryption";
import type { ClientSessionContext } from "./client-session";
import { searchProjects } from "./project-workspaces";
import {
  ProjectWorkspaceEncryptionAdapter,
  type ProjectWorkspaceWireApi,
} from "./workspace-encryption";

const identity = { ownerId: "owner-a", serverId: "server-a" } as const;
const timestamp = "2026-08-19T12:00:00.000Z";

function session(): ClientSessionContext {
  return {
    authMode: "accounts",
    csrfToken: "c".repeat(32),
    expiresAt: "2026-08-19T13:00:00.000Z",
    serverId: identity.serverId,
    user: {
      id: identity.ownerId,
      kind: "account",
      displayName: "Owner A",
      email: "owner-a@example.com",
      role: "owner",
    },
  };
}

function profile(): AccountEncryptionProfile {
  return {
    ownerId: identity.ownerId,
    formatVersion: 1,
    activeMasterKeyRevision: 1,
    passwordKdf: null,
    passwordWrappedMasterKey: null,
    initializationStatus: "initialized",
    payloadMigrationStatus: "pending",
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

class MemoryWorkspaceApi implements ProjectWorkspaceWireApi {
  readonly rows: ProjectWorkspaceWireSummary[] = [
    {
      id: "workspace:default:owner-a",
      nameProtection: { state: "legacy", plaintext: "Default" },
      position: 0,
      isDefault: true,
      projectIds: [],
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  migrationUpdates = 0;
  writes = 0;
  private encryptionProfile = profile();

  async create(
    input: EncryptedProjectWorkspaceCreate,
  ): Promise<ProjectWorkspaceWireSummary> {
    if (
      this.rows.some(
        ({ nameProtection }) =>
          nameProtection.state === "encrypted" &&
          nameProtection.blindIndex === input.nameProtection.blindIndex,
      )
    ) {
      throw new CantripApiError("Workspace name already exists.", 409);
    }
    this.writes += 1;
    const row: ProjectWorkspaceWireSummary = {
      id: input.id,
      nameProtection: input.nameProtection,
      position: this.rows.length,
      isDefault: false,
      projectIds: [],
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.rows.push(row);
    return structuredClone(row);
  }

  async delete(workspaceId: string): Promise<void> {
    this.writes += 1;
    const index = this.rows.findIndex(({ id }) => id === workspaceId);
    if (index >= 0) this.rows.splice(index, 1);
  }

  getEncryptionProfile(): Promise<AccountEncryptionProfileState> {
    return Promise.resolve({
      status: "initialized",
      profile: structuredClone(this.encryptionProfile),
    });
  }

  list(): Promise<ProjectWorkspaceWireList> {
    const workspaces = structuredClone(this.rows);
    return Promise.resolve({
      workspaces,
      legacyCount: workspaces.filter(
        ({ nameProtection }) => nameProtection.state === "legacy",
      ).length,
    });
  }

  async update(
    workspaceId: string,
    input: EncryptedProjectWorkspaceUpdate,
  ): Promise<ProjectWorkspaceWireSummary> {
    const index = this.rows.findIndex(({ id }) => id === workspaceId);
    const current = this.rows[index];
    if (!current || current.revision !== input.expectedRevision) {
      throw new CantripApiError("Workspace revision conflict.", 409);
    }
    this.writes += 1;
    const next: ProjectWorkspaceWireSummary = {
      ...current,
      ...(input.nameProtection ? { nameProtection: input.nameProtection } : {}),
      ...(input.projectIds ? { projectIds: input.projectIds } : {}),
      ...(input.isDefault ? { isDefault: true } : {}),
      revision: current.revision + 1,
      updatedAt: timestamp,
    };
    this.rows[index] = next;
    return structuredClone(next);
  }

  async updateMigration(
    input: EncryptionProfileMigrationUpdate,
  ): Promise<AccountEncryptionProfile> {
    if (input.expectedRevision !== this.encryptionProfile.revision) {
      throw new CantripApiError("Profile revision conflict.", 409);
    }
    this.migrationUpdates += 1;
    this.encryptionProfile = {
      ...this.encryptionProfile,
      payloadMigrationStatus: input.payloadMigrationStatus,
      revision: this.encryptionProfile.revision + 1,
      updatedAt: timestamp,
    };
    return structuredClone(this.encryptionProfile);
  }
}

function fixture(api = new MemoryWorkspaceApi()) {
  const service = new ClientEncryptionService();
  service.setAccountMasterKey({
    accountMasterKey: new Uint8Array(32).fill(17),
    identity,
    masterKeyRevision: 1,
  });
  return {
    api,
    adapter: new ProjectWorkspaceEncryptionAdapter({
      api,
      service,
      session,
    }),
    service,
  };
}

describe("workspace encryption adapter", () => {
  it("migrates, creates, lists, renames, and searches decrypted names", async () => {
    const { adapter, api } = fixture();
    expect((await adapter.list()).map(({ name }) => name)).toEqual(["Default"]);
    expect((await api.list()).legacyCount).toBe(0);
    const writesAfterMigration = api.writes;
    await adapter.list();
    expect(api.writes).toBe(writesAfterMigration);

    const created = await adapter.create({ name: "Team" });
    await expect(adapter.create({ name: "  TEAM " })).rejects.toMatchObject({
      status: 409,
    });
    const renamed = await adapter.update(created.id, {
      name: "Research",
      projectIds: ["project-1"],
    });
    expect(renamed.name).toBe("Research");
    const workspaces = await adapter.list();
    const projects = [{ id: "project-1", name: "Cantrip" }] as ProjectSummary[];
    expect(searchProjects(projects, workspaces, null, "research")).toHaveLength(
      1,
    );
    expect(JSON.stringify(api.rows)).not.toContain("Research");
    expect(api.migrationUpdates).toBe(2);
  });

  it("fails authentication when envelopes are swapped between row IDs", async () => {
    const { adapter, api } = fixture();
    await adapter.list();
    await adapter.create({ name: "Alpha" });
    await adapter.create({ name: "Beta" });
    const left = api.rows[1]!;
    const right = api.rows[2]!;
    if (
      left.nameProtection.state !== "encrypted" ||
      right.nameProtection.state !== "encrypted"
    ) {
      throw new Error("Expected encrypted test rows.");
    }
    const envelope = left.nameProtection.envelope;
    left.nameProtection.envelope = right.nameProtection.envelope;
    right.nameProtection.envelope = envelope;
    await expect(adapter.list()).rejects.toThrow(/authenticated/iu);
    left.nameProtection.envelope = envelope;
    right.nameProtection.envelope.ciphertext =
      (right.nameProtection.envelope.ciphertext.startsWith("A") ? "B" : "A") +
      right.nameProtection.envelope.ciphertext.slice(1);
    await expect(adapter.list()).rejects.toThrow(/authenticated/iu);
  });

  it("blocks mutations while the client is locked", async () => {
    const api = new MemoryWorkspaceApi();
    const adapter = new ProjectWorkspaceEncryptionAdapter({
      api,
      prepare: async () => ({
        credential: "password" as const,
        reason: "authorize-device" as const,
        status: "credential-required" as const,
      }),
      service: new ClientEncryptionService(),
      session,
    });
    await expect(adapter.create({ name: "Blocked" })).rejects.toMatchObject({
      code: "locked",
    });
    await expect(
      adapter.update("workspace:default:owner-a", { name: "Blocked" }),
    ).rejects.toMatchObject({ code: "locked" });
    expect(api.writes).toBe(0);
  });

  it("recovers a dropped in-memory key through the authorized device", async () => {
    const api = new MemoryWorkspaceApi();
    const service = new ClientEncryptionService();
    let preparations = 0;
    const adapter = new ProjectWorkspaceEncryptionAdapter({
      api,
      prepare: async (input) => {
        preparations += 1;
        input.service?.setAccountMasterKey({
          accountMasterKey: new Uint8Array(32).fill(17),
          identity,
          masterKeyRevision: 1,
        });
        return { status: "ready" };
      },
      service,
      session,
    });

    await expect(adapter.create({ name: "Recovered" })).resolves.toMatchObject({
      name: "Recovered",
    });
    expect(preparations).toBe(1);
    expect(service.getSnapshot()).toMatchObject({ status: "ready", identity });
  });
});
