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
  readonly folderCreates: EncryptedManagedFolderProjectCreate[] = [];
  readonly githubCreates: EncryptedGithubProjectCreate[] = [];
  readonly metadataRegistrations: Record<string, string | string[] | null>[] =
    [];
  readonly rows: ProjectWireSummary[] = [];
  readonly routingValues = new Map<string, string>();
  readonly worktrees: ProjectWorktreeSummary[] = [];
  metadataResolutionCalls = 0;
  writes = 0;

  protectRepositoryIdentity(): Promise<{
    repository: {
      repositoryId: string;
      nameWithOwner: string;
      url: string;
    };
    repositoryBlindIndex: string;
  }> {
    return Promise.resolve({
      repository: {
        repositoryId: `ctrr_${"i".repeat(43)}`,
        nameWithOwner: `ctrr_${"n".repeat(43)}`,
        url: `ctrr_${"u".repeat(43)}`,
      },
      repositoryBlindIndex: "b".repeat(43),
    });
  }

  async createGithub(
    input: EncryptedGithubProjectCreate,
  ): Promise<ProjectWireSummary> {
    this.writes += 1;
    this.githubCreates.push(structuredClone(input));
    const row = wire(input.id, input.nameProtection, "github");
    this.rows.push(row);
    return structuredClone(row);
  }

  async createManagedFolder(
    input: EncryptedManagedFolderProjectCreate,
  ): Promise<ProjectWireSummary> {
    this.writes += 1;
    this.folderCreates.push(structuredClone(input));
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

  registerMetadata(input: {
    values: Record<string, string | string[] | null>;
  }): Promise<{ values: Record<string, string | string[] | null> }> {
    this.metadataRegistrations.push(structuredClone(input.values));
    return Promise.resolve({
      values: Object.fromEntries(
        Object.keys(input.values).map((field) => [
          field,
          `ctrr_${field.slice(0, 1).repeat(43)}`,
        ]),
      ),
    });
  }

  resolveMetadata(input: {
    values: Record<string, string | string[] | null>;
  }): Promise<{ values: Record<string, string | string[] | null> }> {
    this.metadataResolutionCalls += 1;
    const resolve = (value: string) => this.routingValues.get(value) ?? value;
    return Promise.resolve({
      values: Object.fromEntries(
        Object.entries(input.values).map(([field, value]) => [
          field,
          Array.isArray(value)
            ? value.map(resolve)
            : typeof value === "string"
              ? resolve(value)
              : null,
        ]),
      ),
    });
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
      existingPath: "/Users/example/Sentinel Folder",
    });
    expect(github.name).toBe("SentinelProject");
    expect(folder.name).toBe("Sentinel Folder");
    expect((await adapter.list()).map(({ name }) => name)).toEqual([
      "Sentinel Folder",
      "SentinelProject",
    ]);
    expect(JSON.stringify(api.rows)).not.toContain("Sentinel Folder");
    expect(api.rows.every((row) => !("name" in row))).toBe(true);
    expect(JSON.stringify(api.githubCreates)).not.toContain(
      "ArcaneArts/SentinelProject",
    );
    expect(api.githubCreates[0]).toMatchObject({
      repositoryBlindIndex: "b".repeat(43),
      repositoryId: expect.stringMatching(/^ctrr_/u),
      nameWithOwner: expect.stringMatching(/^ctrr_/u),
      url: expect.stringMatching(/^ctrr_/u),
    });
    expect(JSON.stringify(api.folderCreates)).not.toContain(
      "/Users/example/Sentinel Folder",
    );
    expect(api.folderCreates[0]?.existingPath).toMatch(/^ctrr_/u);
  });

  it("registers custom placement paths on the worker before project creation", async () => {
    const { adapter, api } = fixture();
    const placementPath = "/srv/private/ArcaneArts/Cantrip";
    await adapter.createGithub({
      workerId: "worker-a",
      repositoryId: "repository-1",
      nameWithOwner: "ArcaneArts/SentinelProject",
      url: "https://github.com/ArcaneArts/SentinelProject",
      placement: { mode: "direct", path: placementPath },
    });

    expect(api.metadataRegistrations).toContainEqual({ placementPath });
    expect(api.githubCreates[0]?.placement).toEqual({
      mode: "direct",
      path: `ctrr_${"p".repeat(43)}`,
    });
    expect(JSON.stringify(api.githubCreates)).not.toContain(placementPath);
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
      placementMode: "managed-link",
      ownershipKind: "cantrip",
      requestedPath: `ctrr_${"r".repeat(43)}`,
      linkPath: `ctrr_${"l".repeat(43)}`,
    };
    row.replicas = [
      {
        id: "source-a",
        projectId: created.id,
        sourceKind: "git",
        workerId: "worker-a",
        workerName: "Worker A",
        workerOnline: true,
        path: `ctrr_${"a".repeat(43)}`,
        displayPath: `ctrr_${"d".repeat(43)}`,
        placementMode: "managed-link",
        ownershipKind: "cantrip",
        requestedPath: `ctrr_${"r".repeat(43)}`,
        linkPath: `ctrr_${"l".repeat(43)}`,
        repositoryFingerprint: "f".repeat(64),
        primaryWorktreeId: "worktree-a",
        branch: "main",
        head: "a".repeat(40),
        dirty: false,
        ready: true,
        worktreeCount: 1,
        lastObservedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ];
    api.routingValues.set(
      `ctrr_${"r".repeat(43)}`,
      "/Users/example/linked-repository",
    );
    api.routingValues.set(
      `ctrr_${"l".repeat(43)}`,
      "/Users/example/linked-repository",
    );
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
    expect(project?.source?.linkPath).toBe("/Users/example/linked-repository");
    expect(project?.replicas[0]?.requestedPath).toBe(
      "/Users/example/linked-repository",
    );
    expect(api.metadataResolutionCalls).toBe(1);
    expect(JSON.stringify(api.rows)).not.toContain(
      "/Users/example/private-repository",
    );
  });
});
