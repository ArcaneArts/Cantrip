import { describe, expect, it, vi } from "vitest";
import { consoleCuaExecutor } from "./console.js";
import { CuaAgentCoordinator } from "./agent.js";
import { CuaAgentApprovalEvents } from "./agent-approval-events.js";
import { CodexConsoleExecutions } from "../codex/execution-lifetime.js";
import type { CantripMcpBinding } from "@cantrip/protocol";
import type { CuaAgentAuthority } from "@cantrip/protocol/computer-use-agent";
import type { CantripCuaService } from "./service.js";
import type { CuaApprovalManager } from "./approvals.js";

function fixture() {
  const binding = {
    ownerId: "owner",
    workerId: "worker",
    chatId: "chat",
    projectId: "project",
    contextKind: "project",
    executionLaneId: "lane",
    worktreeId: "worktree",
    rootKind: "git-worktree",
    scratchRootId: null,
  } as CantripMcpBinding;
  const identity = { ownerId: "owner", serverId: "server", workerId: "worker" };
  const authority: CuaAgentAuthority = {
    ...identity,
    chatId: "chat",
    projectId: "project",
    contextKind: "project",
    executionLaneId: "lane",
    placementId: "worktree",
    generation: 1,
    profile: {
      selectedId: ":yolo",
      effectiveId: ":yolo",
      forcedByWorktreePolicy: false,
      usesDefault: false,
    },
  };
  const fetch = vi.fn(async () => authority);
  const service = {
    evaluateJavascript: vi.fn(async () => ({ value: 1, images: [] })),
    cancelScope: vi.fn(),
  };
  const coordinator = new CuaAgentCoordinator({
    service: service as unknown as CantripCuaService,
    approvals: { revokeContext: vi.fn() } as unknown as CuaApprovalManager,
    events: new CuaAgentApprovalEvents(),
    identity: () => identity,
    authority: fetch,
  });
  const register = vi.spyOn(coordinator, "register");
  const roots = new CodexConsoleExecutions();
  roots.prepare("chat", "thread");
  const run = consoleCuaExecutor({
    coordinator,
    resolve: (input) => roots.resolve(input),
    authority: fetch,
    publish: async () => {},
  });
  const call = () =>
    run(
      binding,
      {
        operation: "js",
        script: "await cua.help()",
        threadId: "thread",
        turnId: "turn",
        itemId: null,
        callId: null,
      },
      "request",
      new AbortController().signal,
    );
  return { roots, call, service, fetch, register };
}

describe("CLI CUA dispatch", () => {
  it("registers one live CLI turn across multiple calls, then releases on completion", async () => {
    const f = fixture();
    await expect(f.call()).rejects.toThrow();
    expect(f.register).not.toHaveBeenCalled();
    f.roots.observe("thread", "turn");
    await f.call();
    await f.call();
    expect(f.register).toHaveBeenCalledTimes(1);
    expect(f.service.evaluateJavascript).toHaveBeenCalledTimes(2);
    f.roots.abort("thread", "turn");
    await expect(f.call()).rejects.toThrow();
    expect(f.service.cancelScope).toHaveBeenCalled();
  });

  it("rechecks authorization instead of borrowing the enabled setting from startup", async () => {
    const f = fixture();
    f.roots.observe("thread", "turn");
    await f.call();
    f.fetch.mockRejectedValue(new Error("Computer use is not enabled."));
    await expect(f.call()).rejects.toThrow("Computer use is not enabled");
    expect(f.service.evaluateJavascript).toHaveBeenCalledTimes(1);
    f.roots.clear();
  });
});
