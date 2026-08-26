import { describe, expect, it } from "vitest";

import {
  CANTRIP_MCP_READ_OPERATIONS,
  CANTRIP_MCP_OPERATIONS,
  cantripMcpOperationsForPermissionProfile,
  type CantripMcpBinding,
} from "@cantrip/protocol";

import {
  assertCantripMcpBinding,
  cantripMcpBindingReadiness,
} from "../src/agent-tools/binding.js";
import type { ChatExecutionContext } from "../src/db/repository.js";

const now = Date.parse("2026-08-21T12:00:00.000Z");
const context: ChatExecutionContext = {
  automationPaused: false,
  chatId: "chat-one",
  contextKind: "project",
  cwd: `ctrr_${"A".repeat(43)}`,
  experience: "chat",
  defaultPermissionProfileId: ":default",
  executionLaneId: "lane-one",
  isPrimary: false,
  status: "running",
  modelId: "model-one",
  reasoningEffort: null,
  modelRouteId: "route-one",
  providerAccountId: null,
  permissionProfileId: ":workspace-write",
  planMode: "default",
  projectId: "project-one",
  rootKind: "git-worktree",
  scratchRootId: null,
  threadId: "thread-one",
  workerId: "worker-one",
  worktreeId: "worktree-one",
  worktreeMode: "agent-managed",
  worktreePolicy: "agent-managed",
};
const binding: CantripMcpBinding = {
  bindingId: "00000000-0000-4000-8000-000000000001",
  ownerId: "owner-one",
  contextKind: "project",
  projectId: context.projectId,
  chatId: context.chatId,
  executionLaneId: context.executionLaneId!,
  workerId: context.workerId,
  worktreeId: context.worktreeId,
  rootKind: context.rootKind,
  scratchRootId: null,
  permissionProfileId: ":workspace-write",
  allowedOperations: [...CANTRIP_MCP_READ_OPERATIONS],
  issuedAt: "2026-08-21T11:59:00.000Z",
  expiresAt: "2026-08-21T13:00:00.000Z",
};
const serverAllowedOperations = new Set(CANTRIP_MCP_READ_OPERATIONS);

const standaloneContext: ChatExecutionContext = {
  ...context,
  contextKind: "standalone",
  projectId: null,
  rootKind: null,
  scratchRootId: "scratch-one",
  worktreeId: null,
  worktreeMode: null,
  worktreePolicy: null,
};
const standaloneBinding: CantripMcpBinding = {
  ...binding,
  contextKind: "standalone",
  projectId: null,
  rootKind: null,
  scratchRootId: "scratch-one",
  worktreeId: null,
  allowedOperations: ["web.search", "web.read"],
};

describe("Cantrip MCP server binding", () => {
  it("reports authoritative mutation readiness and bounded recovery claims", () => {
    expect(
      cantripMcpBindingReadiness({
        binding: {
          ...binding,
          allowedOperations: [...CANTRIP_MCP_OPERATIONS],
        },
        context,
        serverAllowedOperations: new Set(CANTRIP_MCP_OPERATIONS),
      }),
    ).toMatchObject({
      status: "ready",
      mutationReady: true,
      staleClaims: [],
      recoveryInstruction: null,
    });
    expect(
      cantripMcpBindingReadiness({
        binding: {
          ...binding,
          allowedOperations: [...CANTRIP_MCP_OPERATIONS],
        },
        context: { ...context, worktreeId: "worktree-two" },
        serverAllowedOperations: new Set(CANTRIP_MCP_OPERATIONS),
      }),
    ).toMatchObject({
      status: "refresh-required",
      mutationReady: false,
      staleClaims: ["worktree"],
      recoveryInstruction: expect.stringContaining("Do not retry"),
    });
    expect(
      cantripMcpBindingReadiness({
        binding: {
          ...binding,
          permissionProfileId: ":read-only",
        },
        context: {
          ...context,
          defaultPermissionProfileId: ":read-only",
          permissionProfileId: ":read-only",
        },
        serverAllowedOperations,
      }),
    ).toMatchObject({
      status: "read-only",
      mutationReady: false,
      staleClaims: [],
      recoveryInstruction: expect.stringContaining("read-only"),
    });
  });

  it("accepts only the exact live lane and server-approved operation", () => {
    expect(() =>
      assertCantripMcpBinding({
        binding,
        context,
        operation: "context.get",
        ownerId: "owner-one",
        serverAllowedOperations,
        now,
      }),
    ).not.toThrow();
  });

  it("accepts standalone bindings only for the exact standalone scratch root", () => {
    const webOperations = new Set(["web.search", "web.read"] as const);
    expect(() =>
      assertCantripMcpBinding({
        binding: standaloneBinding,
        context: standaloneContext,
        operation: "web.search",
        ownerId: "owner-one",
        serverAllowedOperations: webOperations,
        now,
      }),
    ).not.toThrow();
    expect(() =>
      assertCantripMcpBinding({
        binding: standaloneBinding,
        context: { ...standaloneContext, scratchRootId: "scratch-two" },
        operation: "web.search",
        ownerId: "owner-one",
        serverAllowedOperations: webOperations,
        now,
      }),
    ).toThrow("changed: scratch root");
    expect(() =>
      assertCantripMcpBinding({
        binding: standaloneBinding,
        context,
        operation: "web.search",
        ownerId: "owner-one",
        serverAllowedOperations: webOperations,
        now,
      }),
    ).toThrow("changed: context kind");
  });

  it("allows the read-only context probe between linked console turns", () => {
    const idleContext = { ...context, status: "idle" as const };

    expect(() =>
      assertCantripMcpBinding({
        binding,
        context: idleContext,
        operation: "context.get",
        ownerId: "owner-one",
        serverAllowedOperations,
        now,
      }),
    ).not.toThrow();
    expect(() =>
      assertCantripMcpBinding({
        binding,
        context: idleContext,
        operation: "policy.list",
        ownerId: "owner-one",
        serverAllowedOperations,
        now,
      }),
    ).toThrow("active Cantrip chat lane");
  });

  it("allows the read catalog under an unchanged read-only profile", () => {
    const readOnlyContext = {
      ...context,
      defaultPermissionProfileId: ":read-only",
      permissionProfileId: ":read-only",
    };
    const readOnlyBinding = {
      ...binding,
      permissionProfileId: ":read-only",
    };
    for (const operation of cantripMcpOperationsForPermissionProfile(
      ":read-only",
    )) {
      expect(() =>
        assertCantripMcpBinding({
          binding: readOnlyBinding,
          context: readOnlyContext,
          operation,
          ownerId: "owner-one",
          serverAllowedOperations,
          now,
        }),
      ).not.toThrow();
    }
  });

  it("independently denies mutations under read-only permission", () => {
    const readOnlyContext = {
      ...context,
      defaultPermissionProfileId: ":read-only",
      permissionProfileId: ":read-only",
    };
    const readOnlyBinding = {
      ...binding,
      permissionProfileId: ":read-only",
      allowedOperations: [...CANTRIP_MCP_OPERATIONS],
    };
    for (const operation of [
      "explorer.write",
      "run-configuration.start",
      "run-configuration.stop",
    ] as const) {
      expect(() =>
        assertCantripMcpBinding({
          binding: readOnlyBinding,
          context: readOnlyContext,
          operation,
          ownerId: "owner-one",
          serverAllowedOperations: new Set(CANTRIP_MCP_OPERATIONS),
          now,
        }),
      ).toThrow("permission profile");
    }
  });

  it("allows mutations for an unchanged write-capable profile", () => {
    expect(() =>
      assertCantripMcpBinding({
        binding: {
          ...binding,
          allowedOperations: [...CANTRIP_MCP_OPERATIONS],
        },
        context,
        operation: "explorer.write",
        ownerId: "owner-one",
        serverAllowedOperations: new Set(CANTRIP_MCP_OPERATIONS),
        now,
      }),
    ).not.toThrow();
  });

  it.each([
    ["chat", "chat", { ...context, chatId: "chat-two" }],
    ["project", "project", { ...context, projectId: "project-two" }],
    ["worker", "worker", { ...context, workerId: "worker-two" }],
  ])(
    "rejects a stale %s identity claim",
    (_name, changedClaim, changedContext) => {
      expect(() =>
        assertCantripMcpBinding({
          binding,
          context: changedContext,
          operation: "context.get",
          ownerId: "owner-one",
          serverAllowedOperations,
          now,
        }),
      ).toThrow(`changed: ${changedClaim}`);
    },
  );

  it.each([
    ["lane", { ...context, executionLaneId: "lane-two" }],
    ["worktree", { ...context, worktreeId: "worktree-two" }],
    ["root kind", { ...context, rootKind: "project-root" as const }],
    ["permission", { ...context, permissionProfileId: ":read-only" }],
  ])(
    "allows read-only discovery to follow a changed %s scope",
    (_name, changedContext) => {
      expect(() =>
        assertCantripMcpBinding({
          binding,
          context: changedContext,
          operation: "context.get",
          ownerId: "owner-one",
          serverAllowedOperations,
          now,
        }),
      ).not.toThrow();
    },
  );

  it.each([
    ["lane", "execution lane", { ...context, executionLaneId: "lane-two" }],
    ["worktree", "worktree", { ...context, worktreeId: "worktree-two" }],
    [
      "root kind",
      "root kind",
      { ...context, rootKind: "project-root" as const },
    ],
    [
      "permission",
      "permission profile",
      { ...context, permissionProfileId: ":read-only" },
    ],
  ])(
    "keeps mutations pinned to the original %s scope",
    (_name, changedClaim, changedContext) => {
      expect(() =>
        assertCantripMcpBinding({
          binding: {
            ...binding,
            allowedOperations: [...CANTRIP_MCP_OPERATIONS],
          },
          context: changedContext,
          operation: "explorer.write",
          ownerId: "owner-one",
          serverAllowedOperations: new Set(CANTRIP_MCP_OPERATIONS),
          now,
        }),
      ).toThrow(`changed: ${changedClaim}`);
    },
  );

  it("rejects expiry, owner mismatch, and server-side operation denial", () => {
    expect(() =>
      assertCantripMcpBinding({
        binding,
        context,
        operation: "context.get",
        ownerId: "owner-one",
        serverAllowedOperations,
        now: Date.parse(binding.expiresAt),
      }),
    ).toThrow("expired");
    expect(() =>
      assertCantripMcpBinding({
        binding,
        context,
        operation: "context.get",
        ownerId: "owner-two",
        serverAllowedOperations,
        now,
      }),
    ).toThrow("different owner");
    expect(() =>
      assertCantripMcpBinding({
        binding,
        context,
        operation: "context.get",
        ownerId: "owner-one",
        serverAllowedOperations: new Set(),
        now,
      }),
    ).toThrow("does not authorize");
  });
});
