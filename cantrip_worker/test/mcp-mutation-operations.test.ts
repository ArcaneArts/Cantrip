import { randomBytes } from "@cantrip/crypto";
import {
  CANTRIP_MCP_OPERATIONS,
  browserPrivateStateProtectedContentSchema,
  type CantripMcpBinding,
} from "@cantrip/protocol";
import {
  explorerOperationRequestContentSchema,
  surfaceOperationOutcomeContentSchema,
  surfaceStreamWireResponseSchema,
  terminalInputContentSchema,
} from "@cantrip/protocol/surface-stream";
import { describe, expect, it } from "vitest";

import { encodePrivateDisplayLabelForWorker } from "../src/private-label-encryption.js";
import { CantripServerRequestError } from "../src/cli-client.js";
import { executeCantripMcpMutationOperation } from "../src/mcp/mutation-operations.js";
import { decodeSurfacePrivateStateForWorker } from "../src/surface-private-state-encryption.js";
import {
  openWorkerSurfaceStreamContent,
  protectWorkerSurfaceStreamContent,
} from "../src/surface-stream-encryption.js";
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

function encryptionService(key = randomBytes(32)) {
  return {
    ownerId: () => binding.ownerId,
    componentKey: () => ({ key: new Uint8Array(key), keyRevision: 1 }),
    status: () => ({ error: null }),
  } as unknown as WorkerEncryptionService;
}

const commonMutation = {
  continuationScheduled: false as const,
  mutated: true as const,
};

const actionId = "a".repeat(64);
const configurationRevision = "b".repeat(64);
const runId = "00000000-0000-4000-8000-000000000302";

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

function setupFixture() {
  return {
    id: "00000000-0000-4000-8000-000000000402",
    projectId: binding.projectId,
    worktreeId: binding.worktreeId,
    workerId: binding.workerId,
    configurationRevision,
    state: "queued" as const,
    stateRevision: 3,
    attempt: 1,
    error: null,
    createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:03.000Z",
    startedAt: "2026-08-21T12:00:01.000Z",
    completedAt: null,
  };
}

function runConfigurationSnapshot() {
  return {
    relativePath: ".codex/environments/environment.toml" as const,
    sourceControlState: "untracked" as const,
    revision: configurationRevision,
    document: {
      version: 1 as const,
      name: "Project environment",
      setup: { default: null, win32: null, darwin: null, linux: null },
      actions: [
        {
          name: "Run app",
          command: "pnpm run dev",
          icon: "run",
          platform: null,
        },
      ],
    },
    editingError: null,
    inspection: {
      platform: "linux" as const,
      canonical: {
        relativePath: ".codex/environments/environment.toml" as const,
        sourceControlState: "untracked" as const,
      },
      configured: true,
      valid: true,
      configurations: [],
      diagnostics: [],
    },
  };
}

function worktree(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectSourceId: "source-one",
    projectId: binding.projectId,
    rootKind: "git-worktree" as const,
    workerId: binding.workerId,
    name: `Worktree ${id}`,
    path: `/private/worktrees/${id}`,
    displayPath: `/private/worktrees/${id}`,
    isPrimary: false,
    isDefault: false,
    origin: "agent" as const,
    lifecycleState: "ready" as const,
    branch: `cantrip/${id}`,
    head: "a".repeat(40),
    detached: false,
    locked: false,
    lockReason: null,
    lastScannedAt: null,
    createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:00.000Z",
    ...overrides,
  };
}

function resolution(
  target:
    | {
        kind: "surface";
        projectId: string;
        surfaceKind: "browser" | "explorer" | "terminal";
        surfaceId: string;
      }
    | {
        kind: "worktree";
        projectId: string;
        worktreeId: string;
      },
  additions: Record<string, unknown> = {},
) {
  return {
    summary: "Target is available.",
    target,
    worktreeId:
      target.kind === "worktree" ? target.worktreeId : binding.worktreeId,
    continuationScheduled: false as const,
    mutated: false as const,
    data: {
      target,
      placement: {
        projectId: binding.projectId,
        workerId: binding.workerId,
        projectReplicaId: "replica-one",
        worktreeId:
          target.kind === "worktree" ? target.worktreeId : binding.worktreeId,
        surface:
          target.kind === "surface"
            ? { kind: target.surfaceKind, id: target.surfaceId }
            : null,
      },
      worker: {
        workerId: binding.workerId,
        name: "Worker one",
        online: true,
      },
      availability: "available" as const,
      unavailableReason: null,
      ...additions,
    },
  };
}

function lane(worktreeId: string, transitionKind: "switch" | "release") {
  return {
    id: "lane-two",
    chatId: binding.chatId,
    worktreeId,
    workerId: binding.workerId,
    acquiringActor: "agent" as const,
    exclusive: true,
    purpose: "Continue the task",
    state: "suspended" as const,
    baseRevision: null,
    startingHead: null,
    runtimeSessionId: "private-runtime-session",
    codexThreadId: "private-codex-thread",
    transitionKind,
    createdAt: "2026-08-21T12:00:00.000Z",
    activatedAt: null,
    releasedAt: null,
    updatedAt: "2026-08-21T12:00:00.000Z",
  };
}

function removalResult(removedPath: string) {
  return {
    removedPath,
    inventory: {
      sourcePath: "/private/source",
      primaryPath: "/private/source",
      gitCommonDir: "/private/source/.git",
      managedRoot: "/private/worktrees",
      repositoryFingerprint: "f".repeat(64),
      worktrees: [
        {
          path: "/private/source",
          head: "a".repeat(40),
          branch: "main",
          detached: false,
          isPrimary: true,
          managed: false,
          locked: false,
          lockReason: null,
          prunable: false,
          pruneReason: null,
          missing: false,
        },
      ],
    },
  };
}

describe("Cantrip MCP mutation operation normalization", () => {
  it("creates and transitions worktrees without exposing private paths or runtime IDs", async () => {
    const service = encryptionService();
    const created = worktree("worktree-two");
    const createdResult = await executeCantripMcpMutationOperation({
      binding,
      service,
      requestId: "create-one",
      request: {
        operation: "worktree.create",
        arguments: {
          intent: "newBranch",
          name: "Cycle four",
          branch: "agent/manual/cycle-four",
          baseRevision: "origin/main",
        },
      },
      execute: async (_binding, request) => {
        expect(request.operation).toBe("worktree.create");
        return {
          ...commonMutation,
          summary: "Created Cycle four.",
          target: null,
          worktreeId: created.id,
          data: created,
        };
      },
    });
    expect(createdResult).toMatchObject({
      target: {
        kind: "worktree",
        projectId: binding.projectId,
        worktreeId: created.id,
      },
      mutated: true,
      continuationScheduled: false,
      data: { worktree: { id: created.id } },
    });

    const target = {
      kind: "worktree" as const,
      projectId: binding.projectId,
      worktreeId: created.id,
    };
    const calls: unknown[] = [];
    const switched = await executeCantripMcpMutationOperation({
      binding,
      service,
      requestId: "switch-one",
      request: {
        operation: "worktree.switch",
        arguments: { target, purpose: "Continue Cycle four" },
      },
      execute: async (_binding, request) => {
        calls.push(request);
        if (request.operation === "target.inspect") return resolution(target);
        return {
          summary: "Continuation is scheduled. Finish this turn now.",
          target: null,
          worktreeId: created.id,
          continuationScheduled: true,
          mutated: true,
          data: { lane: lane(created.id, "switch"), worktree: created },
        };
      },
    });
    expect(calls).toEqual([
      { operation: "target.inspect", arguments: { target } },
      {
        operation: "worktree.switch",
        arguments: { target, purpose: "Continue Cycle four" },
      },
    ]);
    expect(switched).toMatchObject({
      continuationScheduled: true,
      mutated: true,
      data: {
        lane: { id: "lane-two", state: "suspended", transitionKind: "switch" },
        worktree: { id: created.id },
      },
    });
    const serialized = JSON.stringify([createdResult, switched]);
    expect(serialized).not.toContain("/private/worktrees");
    expect(serialized).not.toContain("private-runtime-session");
    expect(serialized).not.toContain("private-codex-thread");
  });

  it("normalizes release and removal without returning worker inventory paths", async () => {
    const service = encryptionService();
    const primary = worktree("worktree-primary", {
      isPrimary: true,
      isDefault: true,
      name: "Primary",
      origin: "cantrip",
      branch: "main",
    });
    const released = await executeCantripMcpMutationOperation({
      binding,
      service,
      requestId: "release-one",
      request: {
        operation: "worktree.release",
        arguments: { purpose: "Return after Cycle four" },
      },
      execute: async () => ({
        summary: "Release scheduled. Finish this turn now.",
        target: null,
        worktreeId: primary.id,
        continuationScheduled: true,
        mutated: true,
        data: {
          lane: lane(primary.id, "release"),
          worktree: primary,
        },
      }),
    });
    expect(released).toMatchObject({
      target: {
        kind: "worktree",
        projectId: binding.projectId,
        worktreeId: primary.id,
      },
      continuationScheduled: true,
      data: { lane: { transitionKind: "release" } },
    });

    const target = {
      kind: "worktree" as const,
      projectId: binding.projectId,
      worktreeId: "worktree-old",
    };
    const removed = await executeCantripMcpMutationOperation({
      binding,
      service,
      requestId: "remove-one",
      request: { operation: "worktree.remove", arguments: { target } },
      execute: async (_binding, request) =>
        request.operation === "target.inspect"
          ? resolution(target)
          : {
              ...commonMutation,
              summary: "Removed old worktree; branch retained.",
              target: null,
              worktreeId: target.worktreeId,
              data: removalResult("/private/worktrees/worktree-old"),
            },
    });
    expect(removed).toMatchObject({
      target,
      mutated: true,
      data: {
        removedWorktreeId: target.worktreeId,
        branchRetained: true,
      },
    });
    expect(JSON.stringify([released, removed])).not.toContain("/private/");
  });

  it("keeps Explorer write paths and contents opaque across the server relay", async () => {
    const service = encryptionService();
    const serverId = "https://cantrip.example";
    const target = {
      kind: "surface" as const,
      projectId: binding.projectId,
      surfaceKind: "explorer" as const,
      surfaceId: "explorer-one",
    };
    const path = "private/customer-notes.md";
    const content = "private replacement content";
    const version = "a".repeat(64);
    const relayed: unknown[] = [];
    const result = await executeCantripMcpMutationOperation({
      binding,
      service,
      requestId: "write-one",
      request: {
        operation: "explorer.write",
        arguments: { target, path, content, version },
      },
      execute: async (_binding, request) => {
        relayed.push(request);
        if (request.operation === "target.inspect") {
          return resolution(target, { serverId });
        }
        const operationId = String(request.arguments.operationId);
        const sequence = Number(request.arguments.sequence);
        await expect(
          openWorkerSurfaceStreamContent({
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
          }),
        ).resolves.toEqual({
          type: "explorer.file.write",
          path,
          content,
          version,
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
                path,
                content,
                size: content.length,
                markdown: true,
                version: "b".repeat(64),
              },
            },
          },
          schema: surfaceOperationOutcomeContentSchema,
          service,
        });
        return {
          ...commonMutation,
          summary: "Protected Explorer write completed.",
          target,
          worktreeId: binding.worktreeId,
          data: surfaceStreamWireResponseSchema.parse({
            operationId,
            sequence,
            protectedResponse,
          }),
        };
      },
    });
    expect(result).toMatchObject({
      summary: `Saved ${path}.`,
      target,
      mutated: true,
      data: { path, size: content.length, version: "b".repeat(64) },
    });
    expect(result.data).not.toHaveProperty("content");
    const serializedRelay = JSON.stringify(relayed);
    expect(serializedRelay).not.toContain(path);
    expect(serializedRelay).not.toContain(content);
  });

  it("protects terminal input and normalizes restart acknowledgement", async () => {
    const service = encryptionService();
    const serverId = "https://cantrip.example";
    const target = {
      kind: "surface" as const,
      projectId: binding.projectId,
      surfaceKind: "terminal" as const,
      surfaceId: "terminal-one",
    };
    const input = "deploy-sensitive-command\n";
    const relayed: unknown[] = [];
    const sent = await executeCantripMcpMutationOperation({
      binding,
      service,
      requestId: "send-one",
      request: {
        operation: "terminal.send",
        arguments: { target, data: input },
      },
      execute: async (_binding, request) => {
        relayed.push(request);
        if (request.operation === "target.inspect") {
          return resolution(target, { serverId });
        }
        const operationId = String(request.arguments.operationId);
        const sequence = Number(request.arguments.sequence);
        await expect(
          openWorkerSurfaceStreamContent({
            context: {
              serverId,
              surfaceKind: "terminal",
              surfaceId: target.surfaceId,
              operationId,
              direction: "input",
              sequence,
            },
            opaque: request.arguments.protectedRequest,
            schema: terminalInputContentSchema,
            service,
          }),
        ).resolves.toEqual({ type: "terminal.input", data: input });
        const protectedResponse = await protectWorkerSurfaceStreamContent({
          context: {
            serverId,
            surfaceKind: "terminal",
            surfaceId: target.surfaceId,
            operationId,
            direction: "response",
            sequence,
          },
          content: {
            ok: true as const,
            result: { type: "terminal.input.accepted" as const },
          },
          schema: surfaceOperationOutcomeContentSchema,
          service,
        });
        return {
          ...commonMutation,
          summary: "Protected terminal input completed.",
          target,
          worktreeId: binding.worktreeId,
          data: { operationId, sequence, protectedResponse },
        };
      },
    });
    expect(sent).toMatchObject({ mutated: true, data: { accepted: true } });
    expect(JSON.stringify(relayed)).not.toContain(input);

    const restarted = await executeCantripMcpMutationOperation({
      binding,
      service,
      requestId: "restart-one",
      request: { operation: "terminal.restart", arguments: { target } },
      execute: async (_binding, request) =>
        request.operation === "target.inspect"
          ? resolution(target, { serverId })
          : {
              ...commonMutation,
              summary: "Restarted terminal service.",
              target,
              worktreeId: binding.worktreeId,
            },
    });
    expect(restarted).toMatchObject({
      target,
      mutated: true,
      data: { status: "running" },
    });
  });

  it("protects browser navigation state and strips the encrypted response", async () => {
    const service = encryptionService();
    const serverId = "https://cantrip.example";
    const target = {
      kind: "surface" as const,
      projectId: binding.projectId,
      surfaceKind: "browser" as const,
      surfaceId: "browser-one",
    };
    const titleProtection = await encodePrivateDisplayLabelForWorker({
      label: "Preview",
      ownerId: binding.ownerId,
      recordKind: "browser",
      rowId: target.surfaceId,
      service,
    });
    const result = await executeCantripMcpMutationOperation({
      binding,
      service,
      requestId: "navigate-one",
      request: {
        operation: "browser.open",
        arguments: { target, url: "https://example.com/docs" },
      },
      execute: async (_binding, request) => {
        if (request.operation === "target.inspect") {
          return resolution(target, { serverId, stateRevision: 4 });
        }
        const opened = browserPrivateStateProtectedContentSchema.parse(
          await decodeSurfacePrivateStateForWorker({
            ownerId: binding.ownerId,
            context: {
              serverId,
              resource: "browser-row",
              resourceId: target.surfaceId,
              operationId: null,
              recordKind: "browser-state",
            },
            opaque: request.arguments.stateProtection,
            service,
          }),
        );
        expect(opened).toMatchObject({
          revision: 5,
          url: "https://example.com/docs",
        });
        return {
          ...commonMutation,
          summary: "Navigated browser.",
          target,
          worktreeId: binding.worktreeId,
          data: {
            id: target.surfaceId,
            projectId: binding.projectId,
            position: 0,
            stateRevision: 5,
            workerId: binding.workerId,
            createdAt: "2026-08-21T12:00:00.000Z",
            updatedAt: "2026-08-21T12:01:00.000Z",
            titleProtection,
            stateProtection: request.arguments.stateProtection,
          },
        };
      },
    });
    expect(result).toMatchObject({
      target,
      mutated: true,
      data: { url: "https://example.com/docs", stateRevision: 5 },
    });
    expect(JSON.stringify(result)).not.toContain("stateProtection");
    expect(JSON.stringify(result)).not.toContain("ciphertext");
  });
});
