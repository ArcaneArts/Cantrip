import { describe, expect, it } from "vitest";

import type { CantripMcpBinding } from "@cantrip/protocol";

import {
  assertCantripMcpBinding,
  CantripMcpBindingError,
} from "../src/agent-tools/binding.js";
import type { ChatExecutionContext } from "../src/db/repository.js";

const now = Date.parse("2026-08-21T12:00:00.000Z");
const context: ChatExecutionContext = {
  automationPaused: false,
  chatId: "chat-one",
  cwd: "/worktrees/one",
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
  threadId: "thread-one",
  workerId: "worker-one",
  worktreeId: "worktree-one",
  worktreeMode: "agent-managed",
  worktreePolicy: "agent-managed",
};
const binding: CantripMcpBinding = {
  bindingId: "00000000-0000-4000-8000-000000000001",
  ownerId: "owner-one",
  projectId: context.projectId,
  chatId: context.chatId,
  executionLaneId: context.executionLaneId!,
  workerId: context.workerId,
  worktreeId: context.worktreeId,
  canonicalRoot: context.cwd,
  rootKind: context.rootKind,
  permissionProfileId: ":workspace-write",
  allowedOperations: ["context.get"],
  issuedAt: "2026-08-21T11:59:00.000Z",
  expiresAt: "2026-08-21T13:00:00.000Z",
};
const serverAllowedOperations = new Set(["context.get"] as const);

describe("Cantrip MCP server binding", () => {
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

  it.each([
    ["chat", { ...context, chatId: "chat-two" }],
    ["lane", { ...context, executionLaneId: "lane-two" }],
    ["worker", { ...context, workerId: "worker-two" }],
    ["worktree", { ...context, worktreeId: "worktree-two" }],
    ["root", { ...context, cwd: "/worktrees/two" }],
    ["permission", { ...context, permissionProfileId: ":read-only" }],
    ["status", { ...context, status: "idle" as const }],
  ])("rejects a stale %s claim", (_name, changedContext) => {
    expect(() =>
      assertCantripMcpBinding({
        binding,
        context: changedContext,
        operation: "context.get",
        ownerId: "owner-one",
        serverAllowedOperations,
        now,
      }),
    ).toThrowError(CantripMcpBindingError);
  });

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
