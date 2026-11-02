import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  CANTRIP_MCP_OPERATIONS,
  projectAlertDetailSchema,
  type CantripMcpBinding,
} from "@cantrip/protocol";
import { executeCantripMcpAlertOperation } from "../src/mcp/alert-operations.js";
import { openWorkerEndpointContent } from "../src/endpoint-content-encryption.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";
const binding: CantripMcpBinding = {
  bindingId: randomUUID(),
  ownerId: "owner",
  contextKind: "project",
  projectId: "project",
  chatId: "chat",
  executionLaneId: "lane",
  workerId: "worker",
  worktreeId: "tree",
  rootKind: "git-worktree",
  scratchRootId: null,
  permissionProfileId: ":read-only",
  allowedOperations: [...CANTRIP_MCP_OPERATIONS],
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 10000).toISOString(),
};
const service = {
  ownerId: () => "owner",
  serverIdentity: () => "server",
  componentKey: () => ({ key: new Uint8Array(32).fill(7), keyRevision: 1 }),
} as unknown as WorkerEncryptionService;
it("relays protected details under authenticated Chat AAD and never sends plaintext to the server", async () => {
  const key = randomUUID();
  const execute = vi.fn(async () => ({
    summary: "ok",
    data: null,
    target: null,
    mutated: true,
    continuationScheduled: false as const,
    worktreeId: "tree",
  }));
  await executeCantripMcpAlertOperation({
    binding,
    service,
    execute,
    requestId: randomUUID(),
    request: {
      operation: "alert.raise",
      arguments: {
        key,
        revision: 1,
        kind: "blocked",
        title: "PRIVATE TITLE",
        message: "PRIVATE REASON",
        nextStep: "User action",
      },
    },
  });
  const wire = execute.mock.calls[0][1].arguments as any;
  expect(JSON.stringify(wire)).not.toContain("PRIVATE");
  expect(wire.protectedDetail.context).toMatchObject({
    domain: "alert-content",
    scopeId: "chat",
    workerId: "worker",
    operationId: key,
    sequence: 1,
  });
  expect(
    await openWorkerEndpointContent({
      context: wire.protectedDetail.context,
      opaque: wire.protectedDetail.protectedContent,
      schema: projectAlertDetailSchema,
      service,
    }),
  ).toEqual({
    title: "PRIVATE TITLE",
    message: "PRIVATE REASON",
    nextStep: "User action",
  });
  await expect(
    openWorkerEndpointContent({
      context: { ...wire.protectedDetail.context, scopeId: "other" },
      opaque: wire.protectedDetail.protectedContent,
      schema: projectAlertDetailSchema,
      service,
    }),
  ).rejects.toThrow();
});
it("fails the actual encryption operation without relaying when a grant is unavailable", async () => {
  const execute = vi.fn();
  await expect(
    executeCantripMcpAlertOperation({
      binding,
      service: {
        ...service,
        componentKey: () => {
          throw new Error("No key");
        },
      },
      execute,
      requestId: randomUUID(),
      request: {
        operation: "alert.resolve",
        arguments: { key: randomUUID(), revision: 2 },
      },
    }),
  ).rejects.toThrow("No key");
  expect(execute).not.toHaveBeenCalled();
});
