import { randomUUID } from "node:crypto";
import type { CantripMcpBinding } from "@cantrip/protocol";
import type { CuaAgentAuthority } from "@cantrip/protocol/computer-use-agent";
import { describe, expect, it, vi } from "vitest";
import { CuaAgentCoordinator, type CuaAgentCommand } from "./agent.js";
import { CuaAgentApprovalEvents } from "./agent-approval-events.js";
import type { CuaApprovalManager } from "./approvals.js";
import type { CantripCuaService } from "./service.js";

const claims = {
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
    usesDefault: true,
  },
};
function fixture(usesDefault = true) {
  const currentAuthority = structuredClone(authority);
  currentAuthority.profile.usesDefault = usesDefault;
  const root = new AbortController();
  const child = new AbortController();
  const service = {
    evaluateJavascript: vi.fn(async (_scope: unknown) => ({
      value: 1,
      images: [],
    })),
    resetJavascript: vi.fn(async () => {}),
    cancelScope: vi.fn(),
  };
  const approvals = { revokeContext: vi.fn() };
  const fetch = vi.fn(async () => structuredClone(currentAuthority));
  const events = new CuaAgentApprovalEvents();
  const coordinator = new CuaAgentCoordinator({
    identity: () => identity,
    authority: fetch,
    service: service as unknown as CantripCuaService,
    approvals: approvals as unknown as CuaApprovalManager,
    events,
  });
  const command = {
    ...identity,
    initialAuthority: structuredClone(currentAuthority),
    chatId: "chat",
    projectId: "project",
    contextKind: "project",
    executionLaneId: "lane",
    placementId: "worktree",
    taskId: "task",
    rootThreadId: "root",
    publish: async () => {},
    ownsThread: (threadId: string) => ["root", "child"].includes(threadId),
    resolve: ({ chatId, threadId, turnId }) =>
      ["root", "child"].includes(threadId) && turnId === `${threadId}-turn`
        ? {
            chatId,
            threadId,
            turnId,
            rootThreadId: "root",
            rootTurnId: "root-turn",
            parentThreadId: threadId === "root" ? null : "root",
            signal: (threadId === "root" ? root : child).signal,
          }
        : null,
  } satisfies CuaAgentCommand;
  const register = () => coordinator.register(command);
  const unregister = register();
  const call = async (threadId = "root", operation: "js" | "js_reset" = "js") =>
    coordinator.execute(
      claims,
      {
        operation,
        ...(operation === "js" ? { script: "1" } : {}),
        threadId,
        turnId: `${threadId}-turn`,
        itemId: null,
        callId: null,
      } as never,
      randomUUID(),
      new AbortController().signal,
    );
  return {
    coordinator,
    unregister,
    register,
    events,
    service,
    approvals,
    fetch,
    call,
    root,
    child,
  };
}
describe("CUA agent runtime authority", () => {
  it("uses exact native child identity and rejects an unobserved thread", async () => {
    const f = fixture();
    await f.call("child");
    expect(f.service.evaluateJavascript.mock.calls[0]?.[0]).toMatchObject({
      threadId: "child",
      turnId: "child-turn",
      taskId: "task",
    });
    await expect(f.call("unknown")).rejects.toThrow();
    await f.unregister();
  });
  it("Stop revokes a registered execution before any session or approval exists", async () => {
    const f = fixture();
    f.coordinator.cancelChat("chat");
    await expect(f.call()).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
    await f.unregister();
  });
  it("inherited-default revocation fences an execution before its first authority fetch", async () => {
    const f = fixture();
    f.coordinator.revoke({
      ownerId: "owner",
      serverId: "server",
      scope: { kind: "inherited-default", contextKind: "project" },
    });
    await expect(f.call()).rejects.toThrow();
    await f.unregister();
  });
  it("explicit child cancellation prevents reopening and preserves the root", async () => {
    const f = fixture();
    await f.call("child");
    f.coordinator.cancelThread("child");
    await expect(f.call("child")).rejects.toThrow();
    await f.call("root");
    await f.unregister();
  });
  it("explicit child Stop before its first call fences only that child", async () => {
    const f = fixture();
    f.coordinator.cancelThread("child");
    await expect(f.call("child")).rejects.toThrow();
    await f.call("root");
    await f.unregister();
  });
  it("an explicit selected profile is unaffected by inherited-default revocation", async () => {
    const f = fixture(false);
    f.coordinator.revoke({
      ownerId: "owner",
      serverId: "server",
      scope: { kind: "inherited-default", contextKind: "project" },
    });
    await f.call();
    await f.unregister();
  });
  it("unrelated thread releases cannot exhaust a live command's cancellation memory", async () => {
    const f = fixture();
    for (let i = 0; i < 65; i++) f.coordinator.cancelThread(`unrelated-${i}`);
    await f.call();
    await f.unregister();
  });

  it("native child completion disposes its scope without cancelling the root", async () => {
    const f = fixture();
    await f.call("child");
    f.child.abort();
    await expect(f.call("child")).rejects.toThrow();
    await f.call("root");
    await f.unregister();
  });
  it("Stop suppresses a late authority response before starting native work", async () => {
    const f = fixture();
    let done!: (value: CuaAgentAuthority) => void;
    f.fetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    const pending = f.call();
    f.coordinator.cancelChat("chat");
    done(authority);
    await expect(pending).rejects.toThrow();
    expect(f.service.evaluateJavascript).not.toHaveBeenCalled();
    await f.unregister();
  });
  it("releases a command registration even when its event drain fails", async () => {
    const f = fixture();
    vi.spyOn(f.events, "drain").mockRejectedValue(
      new Error("terminal delivery"),
    );
    await expect(f.unregister()).rejects.toThrow("terminal delivery");
    for (let i = 0; i < 33; i++) {
      const release = f.register();
      await expect(release()).rejects.toThrow("terminal delivery");
    }
  });

  it("Stop after reset still revokes the live execution", async () => {
    const f = fixture();
    await f.call("root", "js_reset");
    f.coordinator.cancelChat("chat");
    await expect(f.call()).rejects.toThrow();
    await f.unregister();
  });
});
