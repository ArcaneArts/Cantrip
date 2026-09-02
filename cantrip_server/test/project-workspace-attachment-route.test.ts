import Fastify from "fastify";
import {
  encryptedAttachedProjectWorkspaceCreateResultSchema,
  workspaceRepositoryMutationConflictSchema,
  workspaceRepositoryDiscoverySnapshotSchema,
  type ProjectWorkspaceWireSummary,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import { installProjectWorkspaceRoutes } from "../src/app/routes/project-workspaces.js";
import { protectedProjectFields } from "./private-label-fixture.js";

const operationId = "b621ff08-178a-48aa-93ba-b249435c1d3b";
const workspaceId = "51567e1e-961e-417c-955f-395e489b9d69";
const protectedEnvelope = {
  formatVersion: 1 as const,
  keyRevision: 1,
  envelope: {
    version: 1 as const,
    algorithm: "AES-256-GCM" as const,
    keyRevision: 1,
    nonce: Buffer.alloc(12, 1).toString("base64url"),
    ciphertext: Buffer.alloc(32, 2).toString("base64url"),
  },
};
const nameProtection = {
  state: "encrypted" as const,
  formatVersion: 1 as const,
  keyRevision: 1,
  blindIndex: Buffer.alloc(32, 3).toString("base64url"),
  envelope: protectedEnvelope.envelope,
};
const attachment = {
  rootPathHandle: `ctrr_${"a".repeat(43)}`,
  displayHandle: `ctrr_${"b".repeat(43)}`,
};

function workspace(): ProjectWorkspaceWireSummary {
  const timestamp = "2026-08-31T12:00:00.000Z";
  return {
    id: workspaceId,
    nameProtection,
    storage: {
      kind: "attached",
      workerId: "worker-one",
      ...attachment,
    },
    position: 1,
    isDefault: false,
    projectIds: [],
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function requestPayload() {
  return {
    id: workspaceId,
    nameProtection,
    storage: { kind: "attached" as const, workerId: "worker-one" },
    operationId,
    protectedRequest: protectedEnvelope,
  };
}

function discoveryJob() {
  const timestamp = "2026-09-02T12:00:00.000Z";
  return {
    id: "72b3b25e-dd0f-4a12-bef5-1a77cc064219",
    workspaceId,
    workerId: "worker-one",
    state: "queued" as const,
    stateRevision: 1,
    attempt: 0,
    depth: 3,
    diagnosticCode: null,
    truncated: false,
    counts: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    completedAt: null,
  };
}

describe("attached project workspace route", () => {
  it("persists only the protected binding returned by the selected worker", async () => {
    const app = Fastify();
    const request = vi.fn().mockResolvedValue({
      operationId,
      protectedResponse: protectedEnvelope,
      agentExecution: null,
      workspaceRootAttachment: attachment,
    });
    const createVerifiedAttachedProjectWorkspace = vi
      .fn()
      .mockResolvedValue(workspace());
    const queue = vi.fn().mockResolvedValue(discoveryJob());
    const publishWorkspaceRepositoryDiscoveryChange = vi.fn();
    const queueWorkspaceRepositoryDiscoveryJobs = vi.fn();
    installProjectWorkspaceRoutes(app, {
      applicationOwnerId: () => "owner-one",
      bridge: { isConnected: () => true, request },
      repository: {
        createEncryptedProjectWorkspace: vi.fn(),
        createVerifiedAttachedProjectWorkspace,
        deleteProjectWorkspace: vi.fn(),
        getWorker: vi.fn().mockResolvedValue({
          workerId: "worker-one",
          managedFolders: { attachWorkspaceRoot: true },
        }),
        listProjectWorkspaceWire: vi.fn(),
        updateEncryptedProjectWorkspace: vi.fn(),
        workspaceRepositoryDiscoveryJobs: { queue },
      },
      publishWorkspaceRepositoryDiscoveryChange,
      queueWorkspaceRepositoryDiscoveryJobs,
      serverId: "server-one",
    } as never);

    const response = await app.inject({
      method: "POST",
      url: "/api/workspaces/attached",
      payload: requestPayload(),
    });

    expect(response.statusCode).toBe(201);
    expect(
      encryptedAttachedProjectWorkspaceCreateResultSchema.parse(response.json())
        .workspace,
    ).toEqual(workspace());
    expect(request).toHaveBeenCalledWith(
      "worker-one",
      expect.objectContaining({
        type: "repository.operation",
        routingPurpose: "workspace-root-attachment",
        protectedRequest: protectedEnvelope,
      }),
      expect.objectContaining({ ownerId: "owner-one" }),
    );
    expect(createVerifiedAttachedProjectWorkspace).toHaveBeenCalledWith(
      "owner-one",
      expect.objectContaining({
        id: workspaceId,
        storage: {
          kind: "attached",
          workerId: "worker-one",
          ...attachment,
        },
      }),
    );
    expect(JSON.stringify(request.mock.calls)).not.toContain("/private/");
    expect(queue).toHaveBeenCalledWith("owner-one", workspaceId);
    expect(publishWorkspaceRepositoryDiscoveryChange).toHaveBeenCalledWith({
      job: discoveryJob(),
      ownerId: "owner-one",
    });
    expect(queueWorkspaceRepositoryDiscoveryJobs).toHaveBeenCalledOnce();
    await app.close();
  });

  it("does not persist when the protected worker operation fails", async () => {
    const app = Fastify();
    const createVerifiedAttachedProjectWorkspace = vi.fn();
    installProjectWorkspaceRoutes(app, {
      applicationOwnerId: () => "owner-one",
      bridge: {
        isConnected: () => true,
        request: vi.fn().mockResolvedValue({
          operationId,
          protectedResponse: protectedEnvelope,
          agentExecution: null,
        }),
      },
      repository: {
        createEncryptedProjectWorkspace: vi.fn(),
        createVerifiedAttachedProjectWorkspace,
        deleteProjectWorkspace: vi.fn(),
        getWorker: vi.fn().mockResolvedValue({
          workerId: "worker-one",
          managedFolders: { attachWorkspaceRoot: true },
        }),
        listProjectWorkspaceWire: vi.fn(),
        updateEncryptedProjectWorkspace: vi.fn(),
      },
      serverId: "server-one",
    } as never);

    const response = await app.inject({
      method: "POST",
      url: "/api/workspaces/attached",
      payload: requestPayload(),
    });

    expect(response.statusCode).toBe(200);
    expect(
      encryptedAttachedProjectWorkspaceCreateResultSchema.parse(response.json())
        .workspace,
    ).toBeNull();
    expect(createVerifiedAttachedProjectWorkspace).not.toHaveBeenCalled();
    await app.close();
  });

  it("serves durable state and queues optimistic manual rescans", async () => {
    const app = Fastify();
    const job = discoveryJob();
    const snapshot = workspaceRepositoryDiscoverySnapshotSchema.parse({
      job,
      candidates: [],
    });
    const queue = vi.fn().mockResolvedValue({ ...job, stateRevision: 2 });
    const getSnapshot = vi.fn().mockResolvedValue({
      job: { ...job, stateRevision: 2 },
      candidates: [],
    });
    const publishWorkspaceRepositoryDiscoveryChange = vi.fn();
    const queueWorkspaceRepositoryDiscoveryJobs = vi.fn();
    installProjectWorkspaceRoutes(app, {
      applicationOwnerId: () => "owner-one",
      bridge: { request: vi.fn() },
      repository: {
        workspaceRepositoryDiscoveryJobs: { getSnapshot, queue },
      },
      publishWorkspaceRepositoryDiscoveryChange,
      queueWorkspaceRepositoryDiscoveryJobs,
      serverId: "server-one",
    } as never);

    getSnapshot.mockResolvedValueOnce(snapshot);
    const getResponse = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/repository-discovery`,
    });
    expect(getResponse.statusCode).toBe(200);
    expect(
      workspaceRepositoryDiscoverySnapshotSchema.parse(getResponse.json()),
    ).toEqual(snapshot);

    const rescanResponse = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/repository-discovery`,
      payload: { expectedStateRevision: 1 },
    });
    expect(rescanResponse.statusCode).toBe(202);
    expect(queue).toHaveBeenCalledWith("owner-one", workspaceId, {
      expectedStateRevision: 1,
      depth: 3,
    });
    expect(publishWorkspaceRepositoryDiscoveryChange).toHaveBeenCalledWith({
      job: { ...job, stateRevision: 2 },
      ownerId: "owner-one",
    });
    expect(queueWorkspaceRepositoryDiscoveryJobs).toHaveBeenCalledOnce();
    await app.close();
  });

  it("returns a structured conflict when a manual rescan is stale", async () => {
    const app = Fastify();
    const queue = vi.fn().mockResolvedValue(null);
    installProjectWorkspaceRoutes(app, {
      applicationOwnerId: () => "owner-one",
      bridge: { request: vi.fn() },
      repository: {
        workspaceRepositoryDiscoveryJobs: { queue },
      },
      publishWorkspaceRepositoryDiscoveryChange: vi.fn(),
      queueWorkspaceRepositoryDiscoveryJobs: vi.fn(),
      serverId: "server-one",
    } as never);

    const response = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/repository-discovery`,
      payload: { expectedStateRevision: 7 },
    });

    expect(response.statusCode).toBe(409);
    expect(
      workspaceRepositoryMutationConflictSchema.parse(response.json()),
    ).toEqual({
      code: "repository-discovery-stale",
      error: "Workspace repository discovery is already running or changed.",
    });
    await app.close();
  });

  it("queues an explicit revision-fenced repository import batch", async () => {
    const app = Fastify();
    const job = { ...discoveryJob(), state: "succeeded" as const };
    const candidateId = "fe47e031-8924-44c0-9b51-677fc23397ca";
    const projectId = "95ed0d89-a1d5-48ac-a1b7-67a2037f8373";
    const snapshot = workspaceRepositoryDiscoverySnapshotSchema.parse({
      job: { ...job, stateRevision: 4 },
      candidates: [],
    });
    const queueImports = vi.fn().mockResolvedValue(snapshot);
    const publishWorkspaceRepositoryDiscoveryChange = vi.fn();
    const queueWorkspaceRepositoryDiscoveryJobs = vi.fn();
    installProjectWorkspaceRoutes(app, {
      applicationOwnerId: () => "owner-one",
      bridge: { request: vi.fn() },
      repository: {
        workspaceRepositoryDiscoveryJobs: { queueImports },
      },
      publishWorkspaceRepositoryDiscoveryChange,
      queueWorkspaceRepositoryDiscoveryJobs,
      serverId: "server-one",
    } as never);
    const candidate = {
      candidateId,
      projectId,
      nameProtection: protectedProjectFields(projectId).nameProtection,
      repositoryBlindIndex: null,
    };

    const response = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/repository-imports`,
      payload: { expectedStateRevision: 3, candidates: [candidate] },
    });

    expect(response.statusCode).toBe(202);
    expect(
      workspaceRepositoryDiscoverySnapshotSchema.parse(response.json()),
    ).toEqual(snapshot);
    expect(queueImports).toHaveBeenCalledWith("owner-one", workspaceId, {
      expectedStateRevision: 3,
      candidates: [candidate],
    });
    expect(publishWorkspaceRepositoryDiscoveryChange).toHaveBeenCalledWith({
      job: snapshot.job,
      ownerId: "owner-one",
    });
    expect(queueWorkspaceRepositoryDiscoveryJobs).toHaveBeenCalledOnce();
    await app.close();
  });

  it("returns a structured conflict for a stale repository candidate batch", async () => {
    const app = Fastify();
    const queueImports = vi.fn().mockResolvedValue(null);
    installProjectWorkspaceRoutes(app, {
      applicationOwnerId: () => "owner-one",
      bridge: { request: vi.fn() },
      repository: {
        workspaceRepositoryDiscoveryJobs: { queueImports },
      },
      publishWorkspaceRepositoryDiscoveryChange: vi.fn(),
      queueWorkspaceRepositoryDiscoveryJobs: vi.fn(),
      serverId: "server-one",
    } as never);
    const candidateId = "fe47e031-8924-44c0-9b51-677fc23397ca";
    const projectId = "95ed0d89-a1d5-48ac-a1b7-67a2037f8373";

    const response = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/repository-imports`,
      payload: {
        expectedStateRevision: 7,
        candidates: [
          {
            candidateId,
            projectId,
            nameProtection: protectedProjectFields(projectId).nameProtection,
            repositoryBlindIndex: null,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(
      workspaceRepositoryMutationConflictSchema.parse(response.json()),
    ).toEqual({
      code: "repository-candidates-stale",
      error: "Repository discovery changed before the import was queued.",
    });
    await app.close();
  });
});
