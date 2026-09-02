import Fastify from "fastify";
import {
  encryptedAttachedProjectWorkspaceCreateResultSchema,
  type ProjectWorkspaceWireSummary,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import { installProjectWorkspaceRoutes } from "../src/app/routes/project-workspaces.js";

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
      },
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
});
