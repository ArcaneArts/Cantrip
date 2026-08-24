import { randomBytes } from "@cantrip/crypto";
import {
  CANTRIP_MCP_OPERATIONS,
  type CantripAgentOperationRequest,
  type CantripMcpBinding,
} from "@cantrip/protocol";
import {
  runConfigurationRuntimeOutputContentSchema,
  runConfigurationRuntimeOutputSchema,
} from "@cantrip/protocol/run-configuration-runtime";
import { describe, expect, it } from "vitest";

import { executeCantripMcpRunConfigurationOperation } from "../src/mcp/run-configuration-operations.js";
import { protectWorkerRunContent } from "../src/run-content-encryption.js";
import { openRunConfigurationSecretValue } from "../src/run-configuration-secret-encryption.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

const projectId = "00000000-0000-4000-8000-000000000010";
const configurationId = "00000000-0000-4000-8000-000000000020";
const worktreeId = "00000000-0000-4000-8000-000000000030";
const binding: CantripMcpBinding = {
  bindingId: "00000000-0000-4000-8000-000000000001",
  ownerId: "owner-one",
  projectId,
  chatId: "chat-one",
  executionLaneId: "lane-one",
  workerId: "worker-one",
  worktreeId,
  rootKind: "git-worktree",
  permissionProfileId: ":workspace",
  allowedOperations: [...CANTRIP_MCP_OPERATIONS],
  issuedAt: "2026-08-24T12:00:00.000Z",
  expiresAt: "2026-08-24T18:00:00.000Z",
};

function encryptionService(key = randomBytes(32)) {
  return {
    ownerId: () => binding.ownerId,
    serverIdentity: () => "server-one",
    componentKey: () => ({ key: new Uint8Array(key), keyRevision: 1 }),
    status: () => ({ error: null }),
  } as unknown as WorkerEncryptionService;
}

describe("managed MCP Run configuration operations", () => {
  it("encrypts write-only secret values before invoking the server", async () => {
    const service = encryptionService();
    const operationId = "00000000-0000-4000-8000-000000000040";
    const calls: CantripAgentOperationRequest[] = [];
    const result = await executeCantripMcpRunConfigurationOperation({
      binding,
      service,
      requestId: "transport-request",
      request: {
        operation: "run-configuration.secret-set",
        arguments: {
          operationId,
          reference: "project/database-url",
          value: "postgres://private",
        },
      },
      execute: async (_binding, request) => {
        calls.push(request);
        const arguments_ = request.arguments as Record<string, unknown>;
        expect(arguments_).not.toHaveProperty("value");
        expect(
          await openRunConfigurationSecretValue({
            projectId,
            secret: {
              reference: arguments_.reference,
              revision: 1,
              protectedValue: arguments_.protectedValue,
            },
            service,
          }),
        ).toBe("postgres://private");
        return {
          summary: "Stored Run configuration secret project/database-url.",
          target: { kind: "project", projectId },
          worktreeId: null,
          mutated: true,
          data: {
            operationId,
            projectId,
            replayed: false,
            secret: {
              reference: "project/database-url",
              available: true,
              revision: 1,
              updatedAt: "2026-08-24T12:00:00.000Z",
            },
          },
        };
      },
    });

    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({
      mutated: true,
      data: { secret: { reference: "project/database-url" } },
    });
    expect(JSON.stringify(calls)).not.toContain("postgres://private");
  });

  it("opens bounded protected runtime output only on the worker", async () => {
    const service = encryptionService();
    const operationId = "00000000-0000-4000-8000-000000000050";
    const result = await executeCantripMcpRunConfigurationOperation({
      binding,
      service,
      requestId: "transport-request",
      request: {
        operation: "run-configuration.read-output",
        arguments: {
          operationId,
          configurationId,
          worktreeId,
          tail: 1_000,
        },
      },
      execute: async () => ({
        summary: `Read Run configuration ${configurationId} output.`,
        target: { kind: "worktree", projectId, worktreeId },
        worktreeId,
        data: {
          operationId,
          projectId,
          configurationId,
          worktreeId,
          generation: 3,
          protectedOutput: await protectWorkerRunContent({
            serverId: service.serverIdentity(),
            projectId,
            worktreeId,
            operationId,
            operation: "run.configuration.output",
            content: { data: "ready\n", truncated: false },
            schema: runConfigurationRuntimeOutputContentSchema,
            service,
            direction: "response",
          }),
        },
      }),
    });

    expect(runConfigurationRuntimeOutputSchema.parse(result.data)).toEqual({
      operationId,
      projectId,
      configurationId,
      worktreeId,
      generation: 3,
      data: "ready\n",
      truncated: false,
    });
  });
});
