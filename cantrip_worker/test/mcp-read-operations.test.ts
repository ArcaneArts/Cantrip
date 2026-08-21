import { encryptPolicyContent, randomBytes } from "@cantrip/crypto";
import {
  CANTRIP_MCP_READ_OPERATIONS,
  type CantripMcpBinding,
} from "@cantrip/protocol";
import {
  explorerOperationRequestContentSchema,
  surfaceOperationOutcomeContentSchema,
  surfaceStreamWireResponseSchema,
} from "@cantrip/protocol/surface-stream";
import { describe, expect, it } from "vitest";

import { encodePrivateDisplayLabelForWorker } from "../src/private-label-encryption.js";
import { executeCantripMcpReadOperation } from "../src/mcp/read-operations.js";
import {
  openWorkerSurfaceStreamContent,
  protectWorkerSurfaceStreamContent,
} from "../src/surface-stream-encryption.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

const binding: CantripMcpBinding = {
  bindingId: "00000000-0000-4000-8000-000000000001",
  ownerId: "owner-one",
  projectId: "project-one",
  chatId: "chat-one",
  executionLaneId: "lane-one",
  workerId: "worker-one",
  worktreeId: "worktree-one",
  canonicalRoot: "/private/worktrees/one",
  rootKind: "git-worktree",
  permissionProfileId: ":workspace-write",
  allowedOperations: [...CANTRIP_MCP_READ_OPERATIONS],
  issuedAt: "2026-08-21T12:00:00.000Z",
  expiresAt: "2026-08-21T18:00:00.000Z",
};

function encryptionService(key: Uint8Array) {
  return {
    ownerId: () => binding.ownerId,
    componentKey: () => ({ key: new Uint8Array(key), keyRevision: 1 }),
    status: () => ({ error: null }),
  } as unknown as WorkerEncryptionService;
}

const commonResult = {
  target: null,
  worktreeId: binding.worktreeId,
  continuationScheduled: false as const,
  mutated: false as const,
};

describe("Cantrip MCP read operation normalization", () => {
  it("opens effective policy summaries and bodies only on the worker", async () => {
    const key = randomBytes(32);
    const service = encryptionService(key);
    const policyId = "00000000-0000-4000-8000-000000000201";
    const protectedPolicy = await encryptPolicyContent({
      ownerId: binding.ownerId,
      policyId,
      keyRevision: 1,
      componentKey: key,
      summary: {
        version: 1,
        key: "manual-change-protocol",
        name: "Manual Change Protocol",
        summary: "Read the current policy before manual changes.",
      },
      body: { version: 1, bodyMarkdown: "# Current policy body" },
    });
    const calls: unknown[] = [];
    const result = await executeCantripMcpReadOperation({
      binding,
      service,
      requestId: "request-one",
      request: {
        operation: "policy.read",
        arguments: { key: "manual-change-protocol" },
      },
      execute: async (_binding, request) => {
        calls.push(request);
        return {
          ...commonResult,
          summary: "Returned protected policy data.",
          data:
            request.operation === "policy.list"
              ? {
                  policies: [
                    {
                      id: policyId,
                      protectedSummary: protectedPolicy.protectedSummary,
                      mandatory: true,
                      sources: [{ type: "mandatory" }],
                    },
                  ],
                }
              : {
                  policy: {
                    id: policyId,
                    content: protectedPolicy,
                    enabled: true,
                    mandatory: true,
                    position: 0,
                    templateKey: "manual-change-protocol",
                    rowVersion: 1,
                    workspaceAssignmentCount: 0,
                    projectAssignmentCount: 0,
                    createdAt: "2026-08-21T12:00:00.000Z",
                    updatedAt: "2026-08-21T12:00:00.000Z",
                  },
                },
        };
      },
    });

    expect(result).toMatchObject({
      summary: "Read policy manual-change-protocol.",
      data: {
        policy: {
          key: "manual-change-protocol",
          bodyMarkdown: "# Current policy body",
        },
      },
    });
    expect(calls).toEqual([
      { operation: "policy.list", arguments: {} },
      { operation: "policy.read", arguments: { policyId } },
    ]);
  });

  it("keeps Explorer paths and file contents opaque across the server relay", async () => {
    const key = randomBytes(32);
    const service = encryptionService(key);
    const serverId = "https://cantrip.example";
    const target = {
      kind: "surface" as const,
      projectId: binding.projectId,
      surfaceKind: "explorer" as const,
      surfaceId: "explorer-one",
    };
    const sentinelPath = "private/customer-notes.md";
    const sentinelContent = "private Explorer file content";
    const relayed: unknown[] = [];
    const result = await executeCantripMcpReadOperation({
      binding,
      service,
      requestId: "request-two",
      request: {
        operation: "explorer.read",
        arguments: { target, path: sentinelPath, maxChars: 7 },
      },
      execute: async (_binding, request) => {
        relayed.push(request);
        if (request.operation === "target.inspect") {
          return {
            ...commonResult,
            summary: "Explorer is available.",
            target,
            data: {
              target,
              placement: {
                projectId: binding.projectId,
                workerId: binding.workerId,
                projectReplicaId: "replica-one",
                worktreeId: binding.worktreeId,
                surface: { kind: "explorer", id: target.surfaceId },
              },
              worker: {
                workerId: binding.workerId,
                name: "Worker one",
                online: true,
              },
              availability: "available",
              unavailableReason: null,
              serverId,
            },
          };
        }
        const operationId = String(request.arguments.operationId);
        const sequence = Number(request.arguments.sequence);
        const opened = await openWorkerSurfaceStreamContent({
          context: {
            serverId,
            surfaceKind: "explorer",
            surfaceId: target.surfaceId,
            operationId,
            direction: "request",
            sequence,
          },
          opaque: request.arguments.protectedRequest,
          schema: explorerOperationRequestContentSchema,
          service,
        });
        expect(opened).toEqual({
          type: "explorer.file.read",
          path: sentinelPath,
        });
        const protectedResponse = await protectWorkerSurfaceStreamContent({
          context: {
            serverId,
            surfaceKind: "explorer",
            surfaceId: target.surfaceId,
            operationId,
            direction: "response",
            sequence,
          },
          content: {
            ok: true as const,
            result: {
              type: "explorer.file" as const,
              value: {
                path: sentinelPath,
                content: sentinelContent,
                size: sentinelContent.length,
                markdown: true,
                version: "a".repeat(64),
              },
            },
          },
          schema: surfaceOperationOutcomeContentSchema,
          service,
        });
        return {
          ...commonResult,
          summary: "Protected Explorer read completed.",
          target,
          data: surfaceStreamWireResponseSchema.parse({
            operationId,
            sequence,
            protectedResponse,
          }),
        };
      },
    });

    expect(result.data).toMatchObject({
      path: sentinelPath,
      content: sentinelContent.slice(0, 7),
      truncated: true,
    });
    const serializedRelay = JSON.stringify(relayed);
    expect(serializedRelay).not.toContain(sentinelPath);
    expect(serializedRelay).not.toContain(sentinelContent);
  });

  it("decrypts target titles and strips protected transcript fields", async () => {
    const key = randomBytes(32);
    const service = encryptionService(key);
    const target = {
      kind: "surface" as const,
      projectId: binding.projectId,
      surfaceKind: "terminal" as const,
      surfaceId: "terminal-one",
    };
    const titleProtection = await encodePrivateDisplayLabelForWorker({
      label: "Build terminal",
      ownerId: binding.ownerId,
      recordKind: "terminal",
      rowId: target.surfaceId,
      service,
    });
    const result = await executeCantripMcpReadOperation({
      binding,
      service,
      requestId: "request-three",
      request: { operation: "target.list", arguments: {} },
      execute: async () => ({
        ...commonResult,
        summary: "Found one target.",
        data: {
          projectId: binding.projectId,
          targets: [
            {
              target,
              placement: {
                projectId: binding.projectId,
                workerId: binding.workerId,
                projectReplicaId: "replica-one",
                worktreeId: binding.worktreeId,
                surface: { kind: "terminal", id: target.surfaceId },
              },
              worker: {
                workerId: binding.workerId,
                name: "Worker one",
                online: true,
              },
              availability: "available",
              unavailableReason: null,
              resourceKind: "terminal",
              status: "running",
              title: null,
              titleProtection,
            },
          ],
          cursor: 0,
          nextCursor: null,
          total: 1,
          truncated: false,
        },
      }),
    });

    expect(result.data).toMatchObject({
      targets: [{ title: "Build terminal" }],
    });
    expect(JSON.stringify(result)).not.toContain("titleProtection");
    expect(JSON.stringify(result)).not.toContain("ciphertext");
  });

  it("strips private routing details from target inspection", async () => {
    const service = encryptionService(randomBytes(32));
    const target = {
      kind: "surface" as const,
      projectId: binding.projectId,
      surfaceKind: "browser" as const,
      surfaceId: "browser-one",
    };
    const resolution = {
      target,
      placement: {
        projectId: binding.projectId,
        workerId: binding.workerId,
        projectReplicaId: "replica-one",
        worktreeId: binding.worktreeId,
        surface: { kind: "browser" as const, id: target.surfaceId },
      },
      worker: {
        workerId: binding.workerId,
        name: "Worker one",
        online: true,
      },
      availability: "available" as const,
      unavailableReason: null,
    };
    const result = await executeCantripMcpReadOperation({
      binding,
      service,
      requestId: "request-inspect",
      request: { operation: "target.inspect", arguments: { target } },
      execute: async () => ({
        ...commonResult,
        summary: "Browser is available.",
        target,
        data: {
          ...resolution,
          serverId: "private-server-routing-id",
          stateRevision: 7,
        },
      }),
    });

    expect(result).toMatchObject({
      target,
      data: { ...resolution, stateRevision: 7 },
    });
    expect(JSON.stringify(result)).not.toContain("serverId");
    expect(JSON.stringify(result)).not.toContain("private-server-routing-id");
  });

  it("removes private worktree paths from paginated MCP output", async () => {
    const service = encryptionService(randomBytes(32));
    const result = await executeCantripMcpReadOperation({
      binding,
      service,
      requestId: "request-four",
      request: { operation: "worktree.list", arguments: {} },
      execute: async () => ({
        ...commonResult,
        summary: "Found one worktree.",
        data: {
          currentWorktreeId: binding.worktreeId,
          worktrees: [
            {
              id: binding.worktreeId,
              projectSourceId: "source-one",
              projectId: binding.projectId,
              rootKind: "git-worktree",
              workerId: binding.workerId,
              name: "Cycle three",
              path: "/private/worktrees/one",
              displayPath: "/private/worktrees/one",
              isPrimary: false,
              isDefault: false,
              origin: "agent",
              lifecycleState: "ready",
              branch: "agent/manual/cycle-three",
              head: "a".repeat(40),
              detached: false,
              locked: false,
              lockReason: null,
              lastScannedAt: null,
              createdAt: "2026-08-21T12:00:00.000Z",
              updatedAt: "2026-08-21T12:00:00.000Z",
            },
          ],
          leases: [],
          cursor: 0,
          nextCursor: null,
          total: 1,
          truncated: false,
        },
      }),
    });

    expect(result.data).toMatchObject({
      worktrees: [{ id: binding.worktreeId, name: "Cycle three" }],
    });
    expect(JSON.stringify(result)).not.toContain("/private/worktrees/one");
    expect(JSON.stringify(result)).not.toContain("displayPath");
  });
});
