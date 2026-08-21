import { generateAccountMasterKey } from "@cantrip/crypto";
import type {
  EncryptedGithubProjectCreate,
  EncryptedManagedFolderProjectCreate,
  ProjectPreferredWorkerUpdate,
  ProjectWorktreeSummary,
  ProjectWireSummary,
  WorktreePolicy,
} from "@cantrip/protocol";
import type { PrivateDisplayLabelOpaque } from "@cantrip/protocol/private-labels";
import { describe, expect, it } from "vitest";

import { ClientEncryptionService } from "./client-encryption";
import type { ClientSessionContext } from "./client-session";
import {
  ProjectEncryptionAdapter,
  type ProjectWireApi,
} from "./project-encryption";

const identity = {
  ownerId: "owner-project-label",
  serverId: "server-project-label",
};
const timestamp = "2026-08-19T12:00:00.000Z";

function session(): ClientSessionContext {
  return {
    authMode: "accounts",
    csrfToken: "c".repeat(32),
    expiresAt: "2026-08-19T13:00:00.000Z",
    serverId: identity.serverId,
    user: { id: identity.ownerId },
  } as ClientSessionContext;
}

function wire(
  id: string,
  nameProtection: PrivateDisplayLabelOpaque,
  kind: "github" | "managed-folder",
): ProjectWireSummary {
  return {
    id,
    nameProtection,
    position: 0,
    originKind: kind,
    folderManagement: kind === "managed-folder" ? "managed" : null,
    capabilities:
      kind === "managed-folder"
        ? {
            git: false,
            worktrees: false,
            github: false,
            replicas: false,
            relocation: false,
          }
        : {
            git: true,
            worktrees: true,
            github: true,
            replicas: true,
            relocation: true,
          },
    setupStatus: kind === "managed-folder" ? "preparing" : "cloning",
    setupError: null,
    worktreePolicy: kind === "managed-folder" ? "direct" : "agent-managed",
    preferredWorkerId: kind === "managed-folder" ? "worker-a" : null,
    github:
      kind === "github"
        ? {
            repositoryId: "repository-1",
            nameWithOwner: "ArcaneArts/SentinelProject",
            url: "https://github.com/ArcaneArts/SentinelProject",
          }
        : null,
    source: null,
    replicas: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

class MemoryProjectApi implements ProjectWireApi {
  readonly rows: ProjectWireSummary[] = [];
  readonly worktrees: ProjectWorktreeSummary[] = [];
  writes = 0;

  async createGithub(
    input: EncryptedGithubProjectCreate,
  ): Promise<ProjectWireSummary> {
    this.writes += 1;
    const row = wire(input.id, input.nameProtection, "github");
    this.rows.push(row);
    return structuredClone(row);
  }

  async createManagedFolder(
    input: EncryptedManagedFolderProjectCreate,
  ): Promise<ProjectWireSummary> {
    this.writes += 1;
    const row = wire(input.id, input.nameProtection, "managed-folder");
    this.rows.push(row);
    return structuredClone(row);
  }

  list(): Promise<ProjectWireSummary[]> {
    return Promise.resolve(structuredClone(this.rows));
  }

  listWorktrees(projectId: string): Promise<ProjectWorktreeSummary[]> {
    return Promise.resolve(
      structuredClone(
        this.worktrees.filter((worktree) => worktree.projectId === projectId),
      ),
    );
  }

  updatePreferredWorker(
    projectId: string,
    input: ProjectPreferredWorkerUpdate,
  ): Promise<ProjectWireSummary> {
    const row = this.rows.find(({ id }) => id === projectId)!;
    row.preferredWorkerId = input.workerId;
    return Promise.resolve(structuredClone(row));
  }

  updateWorktreePolicy(
    projectId: string,
    policy: WorktreePolicy,
  ): Promise<ProjectWireSummary> {
    const row = this.rows.find(({ id }) => id === projectId)!;
    row.worktreePolicy = policy;
    return Promise.resolve(structuredClone(row));
  }
}

function fixture(api = new MemoryProjectApi()) {
  const service = new ClientEncryptionService();
  service.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity,
    masterKeyRevision: 1,
  });
  return {
    api,
    adapter: new ProjectEncryptionAdapter({ api, service, session }),
    service,
  };
}

describe("encrypted project display names", () => {
  it("creates and lists GitHub and folder projects without plaintext wire names", async () => {
    const { adapter, api } = fixture();
    const github = await adapter.createGithub({
      workerId: "worker-a",
      repositoryId: "repository-1",
      nameWithOwner: "ArcaneArts/SentinelProject",
      url: "https://github.com/ArcaneArts/SentinelProject",
    });
    const folder = await adapter.createManagedFolder({
      name: "Sentinel Folder",
      workerId: "worker-a",
    });
    expect(github.name).toBe("SentinelProject");
    expect(folder.name).toBe("Sentinel Folder");
    expect((await adapter.list()).map(({ name }) => name)).toEqual([
      "Sentinel Folder",
      "SentinelProject",
    ]);
    expect(JSON.stringify(api.rows)).not.toContain("Sentinel Folder");
    expect(api.rows.every((row) => !("name" in row))).toBe(true);
  });

  it("blocks locked writes and rejects row swaps and tampering", async () => {
    const api = new MemoryProjectApi();
    const locked = new ProjectEncryptionAdapter({
      api,
      service: new ClientEncryptionService(),
      session,
    });
    await expect(
      locked.createManagedFolder({ name: "Blocked", workerId: "worker-a" }),
    ).rejects.toMatchObject({ state: "locked" });
    expect(api.writes).toBe(0);

    const { adapter } = fixture(api);
    await adapter.createManagedFolder({ name: "Alpha", workerId: "worker-a" });
    await adapter.createManagedFolder({ name: "Beta", workerId: "worker-a" });
    const [left, right] = api.rows;
    left!.nameProtection = right!.nameProtection;
    await expect(adapter.list()).rejects.toMatchObject({ state: "corrupt" });

    left!.nameProtection = {
      ...left!.nameProtection,
      protectedLabel: {
        ...left!.nameProtection.protectedLabel,
        envelope: {
          ...left!.nameProtection.protectedLabel.envelope,
          ciphertext: `$${left!.nameProtection.protectedLabel.envelope.ciphertext.slice(1)}`,
        },
      },
    };
    await expect(adapter.list()).rejects.toMatchObject({ state: "corrupt" });
  });

  it("hydrates opaque server routing handles from a protected worker status", async () => {
    const { adapter, api } = fixture();
    const created = await adapter.createGithub({
      workerId: "worker-a",
      repositoryId: "repository-1",
      nameWithOwner: "ArcaneArts/SentinelProject",
      url: "https://github.com/ArcaneArts/SentinelProject",
    });
    const row = api.rows[0]!;
    row.setupStatus = "ready";
    row.source = {
      id: "source-a",
      sourceKind: "git",
      workerId: "worker-a",
      path: `ctrr_${"a".repeat(43)}`,
      displayPath: `ctrr_${"a".repeat(43)}`,
    };
    api.worktrees.push({
      id: "worktree-a",
      projectSourceId: "source-a",
      projectId: created.id,
      rootKind: "git-worktree",
      workerId: "worker-a",
      name: "Primary",
      path: "/Users/example/private-repository",
      displayPath: "/Users/example/private-repository",
      isPrimary: true,
      isDefault: true,
      origin: "cantrip",
      lifecycleState: "ready",
      branch: "private-feature",
      head: "a".repeat(40),
      detached: false,
      locked: false,
      lockReason: null,
      lastScannedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const [project] = await adapter.list();
    expect(project?.source?.path).toBe("/Users/example/private-repository");
    expect(JSON.stringify(api.rows)).not.toContain(
      "/Users/example/private-repository",
    );
  });
});
