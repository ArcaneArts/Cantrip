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

const actionId = "a".repeat(64);
const configurationRevision = "b".repeat(64);
const runId = "00000000-0000-4000-8000-000000000301";

function runFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: runId,
    projectId: binding.projectId,
    worktreeId: binding.worktreeId,
    workerId: "worker-two",
    actionId,
    configurationRevision,
    state: "running" as const,
    terminalId: null,
    exitCode: null,
    signal: null,
    createdAt: "2026-08-21T12:00:00.000Z",
    startedAt: "2026-08-21T12:00:01.000Z",
    endedAt: null,
    updatedAt: "2026-08-21T12:00:01.000Z",
    ...overrides,
  };
}

function runConfiguration() {
  return {
    relativePath: ".codex/environments/environment.toml",
    revision: configurationRevision,
    version: 1,
    name: "Spectral Lab",
    sourceControlState: "ignored" as const,
    setup: null,
    actions: [
      {
        id: actionId,
        name: "Run Spectral Lab",
        icon: "run",
        command: "dotnet run --project ./src/SpectralLab.App",
        platform: "linux" as const,
        configurationPath: ".codex/environments/environment.toml",
        sourceIndex: 1,
      },
    ],
    diagnostics: [],
  };
}

function setupFixture(state: "running" | "succeeded" = "succeeded") {
  return {
    id: "00000000-0000-4000-8000-000000000401",
    projectId: binding.projectId,
    worktreeId: binding.worktreeId,
    workerId: binding.workerId,
    configurationRevision,
    state,
    stateRevision: 2,
    attempt: 1,
    error: null,
    createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:02.000Z",
    startedAt: "2026-08-21T12:00:01.000Z",
    completedAt: state === "succeeded" ? "2026-08-21T12:00:02.000Z" : null,
  };
}

describe("Cantrip MCP read operation normalization", () => {
  it("lists and reads exact revision-checked Run configuration actions", async () => {
    const service = encryptionService(randomBytes(32));
    const configuration = runConfiguration();
    const inspection = {
      platform: "linux" as const,
      canonical: {
        relativePath: ".codex/environments/environment.toml" as const,
        sourceControlState: "ignored" as const,
      },
      configured: true,
      valid: true,
      configurations: [configuration],
      diagnostics: [],
    };
    const calls: unknown[] = [];
    const execute = async (_binding: CantripMcpBinding, request: unknown) => {
      calls.push(request);
      const operation = (request as { operation: string }).operation;
      return {
        ...commonResult,
        summary:
          operation === "run-config.list"
            ? "Found one run action for linux."
            : "Read run action Run Spectral Lab.",
        data:
          operation === "run-config.list"
            ? inspection
            : { configuration, action: configuration.actions[0] },
      };
    };

    const listed = await executeCantripMcpReadOperation({
      binding,
      service,
      requestId: "run-list-one",
      request: { operation: "run-config.list", arguments: {} },
      execute,
    });
    expect(listed.data).toMatchObject({
      platform: "linux",
      configurations: [
        {
          revision: configurationRevision,
          actions: [{ id: actionId, name: "Run Spectral Lab" }],
        },
      ],
    });

    const read = await executeCantripMcpReadOperation({
      binding,
      service,
      requestId: "run-read-config-one",
      request: {
        operation: "run-config.read",
        arguments: { actionId, configRevision: configurationRevision },
      },
      execute,
    });
    expect(read.data).toMatchObject({
      configuration: { revision: configurationRevision },
      action: { id: actionId },
    });
    expect(calls).toEqual([
      { operation: "run-config.list", arguments: {} },
      {
        operation: "run-config.read",
        arguments: { actionId, configRevision: configurationRevision },
      },
    ]);
  });

  it("accepts server-routed Run workers, bounds output, and rejects foreign Runs", async () => {
    const service = encryptionService(randomBytes(32));
    const run = runFixture();
    const calls: unknown[] = [];
    const execute = async (_binding: CantripMcpBinding, request: unknown) => {
      calls.push(request);
      return {
        ...commonResult,
        summary: "Read Run state.",
        data:
          (request as { operation: string }).operation === "run.status"
            ? { run }
            : { run, data: "0123456789abcdef", truncated: false },
      };
    };

    const status = await executeCantripMcpReadOperation({
      binding,
      service,
      requestId: "run-status-one",
      request: { operation: "run.status", arguments: { runId } },
      execute,
    });
    expect(status.data).toMatchObject({
      run: { id: runId, workerId: "worker-two", state: "running" },
    });

    const output = await executeCantripMcpReadOperation({
      binding,
      service,
      requestId: "run-output-one",
      request: {
        operation: "run.read",
        arguments: { runId, maxChars: 6 },
      },
      execute,
    });
    expect(output.data).toMatchObject({ data: "abcdef", truncated: true });
    expect(calls).toEqual([
      { operation: "run.status", arguments: { runId } },
      { operation: "run.read", arguments: { runId, maxChars: 6 } },
    ]);

    await expect(
      executeCantripMcpReadOperation({
        binding,
        service,
        requestId: "run-status-foreign",
        request: { operation: "run.status", arguments: { runId } },
        execute: async () => ({
          ...commonResult,
          summary: "Foreign Run.",
          data: { run: runFixture({ projectId: "project-two" }) },
        }),
      }),
    ).rejects.toThrow("outside the MCP binding");
  });

  it("reads durable setup status without exposing the worker environment", async () => {
    const service = encryptionService(randomBytes(32));
    const calls: unknown[] = [];
    const result = await executeCantripMcpReadOperation({
      binding,
      service,
      requestId: "run-setup-status-one",
      request: { operation: "run.setup-status", arguments: {} },
      execute: async (_binding, request) => {
        calls.push(request);
        return {
          ...commonResult,
          summary: "Worktree setup succeeded.",
          data: {
            worktreeId: binding.worktreeId,
            setup: setupFixture(),
            currentConfigurationRevision: configurationRevision,
            output: "restored\r\n",
            outputTruncated: false,
            exitCode: 0,
            signal: null,
            workerStatusAvailable: true,
          },
        };
      },
    });
    expect(result.data).toMatchObject({
      worktreeId: binding.worktreeId,
      setup: { state: "succeeded", attempt: 1 },
      output: "restored\r\n",
    });
    expect(result.data).not.toHaveProperty("environmentDelta");
    expect(calls).toEqual([{ operation: "run.setup-status", arguments: {} }]);
  });

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
