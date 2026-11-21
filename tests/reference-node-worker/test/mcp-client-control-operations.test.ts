import {
  CANTRIP_MCP_OPERATIONS,
  clientNotificationContentSchema,
  protectedClientNotificationSchema,
  type CantripMcpBinding,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import { executeCantripMcpClientControlOperation } from "../src/mcp/client-control-operations.js";
import { executeCantripMcpOperation } from "../src/mcp/operations.js";
import { openWorkerEndpointContent } from "../src/endpoint-content-encryption.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

const binding: CantripMcpBinding = {
  bindingId: "00000000-0000-4000-8000-000000000001",
  ownerId: "owner-one",
  contextKind: "project",
  projectId: "project-one",
  chatId: "chat-one",
  executionLaneId: "lane-one",
  workerId: "worker-one",
  worktreeId: "worktree-one",
  rootKind: "git-worktree",
  scratchRootId: null,
  permissionProfileId: ":workspace",
  allowedOperations: [...CANTRIP_MCP_OPERATIONS],
  issuedAt: "2026-08-21T12:00:00.000Z",
  expiresAt: "2026-08-21T18:00:00.000Z",
};

const clientControlKey = new Uint8Array(32).fill(7);
const service = {
  componentKey: () => ({
    key: new Uint8Array(clientControlKey),
    keyRevision: 1,
  }),
  ownerId: () => binding.ownerId,
  serverIdentity: () => "server-one",
} as unknown as WorkerEncryptionService;
const correlationId = "00000000-0000-4000-8000-000000000010";

function result(status: "applied" | "unavailable") {
  return {
    summary: `Client control ${status}.`,
    target: { kind: "project" as const, projectId: binding.projectId },
    worktreeId: binding.worktreeId,
    continuationScheduled: false as const,
    mutated: status === "applied",
    data: { correlationId, status },
  };
}

function resolution(target: {
  kind: "surface";
  projectId: string;
  surfaceKind: "browser" | "chat" | "code" | "explorer" | "terminal";
  surfaceId: string;
}) {
  return {
    summary: "Target is available.",
    target,
    worktreeId: binding.worktreeId,
    continuationScheduled: false as const,
    mutated: false as const,
    data: {
      target,
      placement: {
        projectId: binding.projectId,
        workerId: binding.workerId,
        projectReplicaId: "replica-one",
        worktreeId: binding.worktreeId,
        surface: { kind: target.surfaceKind, id: target.surfaceId },
      },
      worker: { workerId: binding.workerId, name: "Worker one", online: true },
      availability: "available" as const,
      unavailableReason: null,
      stateRevision: null,
      serverId: "server-one",
    },
  };
}

describe("Cantrip MCP client-control normalization", () => {
  it("normalizes notification and unavailable project-focus results", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce(result("applied"))
      .mockResolvedValueOnce(result("unavailable"));
    const operationId = "00000000-0000-4000-8000-000000000020";
    const notified = await executeCantripMcpOperation({
      binding,
      service,
      requestId: operationId,
      request: {
        operation: "client.notify",
        arguments: {
          level: "info",
          title: "Ready",
          message: "Focused validation passed.",
        },
      },
      execute,
    });
    expect(execute).toHaveBeenNthCalledWith(
      1,
      binding,
      {
        operation: "client.notify",
        arguments: expect.objectContaining({
          operationId,
          protectedContent: expect.objectContaining({
            domain: "client-control-content",
          }),
        }),
      },
      operationId,
    );
    const forwarded = protectedClientNotificationSchema.parse(
      execute.mock.calls[0]?.[1].arguments,
    );
    expect(JSON.stringify(forwarded)).not.toContain(
      "Focused validation passed",
    );
    await expect(
      openWorkerEndpointContent({
        context: {
          domain: "client-control-content",
          serverId: "server-one",
          workerId: binding.workerId,
          scopeId: binding.projectId,
          operationId,
          operation: "client.notify",
          direction: "event",
          sequence: 0,
        },
        opaque: forwarded.protectedContent,
        schema: clientNotificationContentSchema,
        service,
      }),
    ).resolves.toEqual({
      level: "info",
      title: "Ready",
      message: "Focused validation passed.",
    });
    expect(notified).toMatchObject({
      target: { kind: "project", projectId: binding.projectId },
      mutated: true,
      data: { correlationId, status: "applied" },
    });

    const focused = await executeCantripMcpClientControlOperation({
      binding,
      service,
      requestId: "focus-project-one",
      request: { operation: "client.focus-project", arguments: {} },
      execute,
    });
    expect(focused).toMatchObject({
      mutated: false,
      data: { status: "unavailable" },
    });
  });

  it("revalidates an exact surface before sending a focus request", async () => {
    const target = {
      kind: "surface" as const,
      projectId: binding.projectId,
      surfaceKind: "terminal" as const,
      surfaceId: "terminal-one",
    };
    const execute = vi.fn(async (_binding, request) =>
      request.operation === "target.inspect"
        ? resolution(target)
        : {
            ...result("applied"),
            target,
          },
    );
    const focused = await executeCantripMcpClientControlOperation({
      binding,
      service,
      requestId: "focus-surface-one",
      request: { operation: "client.focus-surface", arguments: { target } },
      execute,
    });
    expect(execute.mock.calls.map(([, request]) => request)).toEqual([
      { operation: "target.inspect", arguments: { target } },
      { operation: "client.focus-surface", arguments: { target } },
    ]);
    expect(focused).toMatchObject({
      target,
      worktreeId: binding.worktreeId,
      mutated: true,
    });
  });

  it("rejects foreign surfaces before calling the server", async () => {
    const execute = vi.fn();
    await expect(
      executeCantripMcpClientControlOperation({
        binding,
        service,
        requestId: "foreign-surface",
        request: {
          operation: "client.focus-surface",
          arguments: {
            target: {
              kind: "surface",
              projectId: "project-foreign",
              surfaceKind: "browser",
              surfaceId: "browser-one",
            },
          },
        },
        execute,
      }),
    ).rejects.toThrow(/another project/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("forwards only an exact interaction identifier in the bound chat", async () => {
    const execute = vi.fn().mockResolvedValue({
      ...result("applied"),
      target: {
        kind: "surface",
        projectId: binding.projectId,
        surfaceKind: "chat",
        surfaceId: binding.chatId,
      },
    });
    const shown = await executeCantripMcpClientControlOperation({
      binding,
      service,
      requestId: "interaction-one",
      request: {
        operation: "client.show-interaction",
        arguments: { interactionId: "interaction-one" },
      },
      execute,
    });
    expect(execute).toHaveBeenCalledWith(
      binding,
      {
        operation: "client.show-interaction",
        arguments: { interactionId: "interaction-one" },
      },
      "interaction-one",
    );
    expect(shown).toMatchObject({
      target: {
        kind: "surface",
        projectId: binding.projectId,
        surfaceKind: "chat",
        surfaceId: binding.chatId,
      },
      data: { status: "applied" },
    });
  });
});
