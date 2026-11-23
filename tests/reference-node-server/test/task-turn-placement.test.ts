import { describe, expect, it, vi } from "vitest";
import { reconcileTaskTurnPlacement } from "../src/app/runtime/task-turn-placement.js";

function fixture() {
  const context = {
    contextKind: "project",
    experience: "task",
    rootKind: "git-worktree",
    projectId: "project",
    chatId: "chat",
    workerId: "worker",
    worktreeId: "old",
    worktreeMode: "agent-managed",
    status: "idle",
    threadId: "old-thread",
  };
  const selected = {
    id: "old",
    projectSourceId: "source",
    workerId: "worker",
    isPrimary: false,
    lifecycleState: "missing",
  };
  const primary = {
    ...selected,
    id: "primary",
    path: "/repo",
    isPrimary: true,
    lifecycleState: "ready",
  };
  const refreshed = [selected, primary];
  const next = {
    ...context,
    worktreeId: "primary",
    threadId: "primary-thread",
  };
  const inventory = {
    sourcePath: "/repo",
    gitCommonDir: "/repo/.git",
    managedRoot: "/worktrees",
    repositoryFingerprint: "a".repeat(64),
    primaryPath: "/repo",
    worktrees: [
      {
        path: "/repo",
        isPrimary: true,
        managed: false,
        branch: "main",
        head: "abc",
        detached: false,
        locked: false,
        lockReason: null,
        missing: false,
        prunable: false,
        pruneReason: null,
      },
    ],
  };
  const repository = {
    listProjectWorktrees: vi.fn(async () => [selected, primary]),
    getProjectSource: vi.fn(async () => ({ cwd: "/repo" })),
    reconcileProjectWorktrees: vi.fn(async () => refreshed),
    updateChatWorktree: vi.fn(async () => ({})),
    getChatExecutionContext: vi.fn(async () => next),
  };
  const bridge = {
    isConnected: vi.fn(() => true),
    request: vi.fn(async () => inventory),
  };
  const run = () =>
    reconcileTaskTurnPlacement(
      repository as never,
      bridge as never,
      "owner",
      context as never,
    );
  return {
    context,
    selected,
    primary,
    repository,
    bridge,
    refreshed,
    next,
    run,
  };
}

describe("Task follow-up placement", () => {
  it("returns a cleaned-up agent-managed checkout to the same source's Primary without changing chat identity", async () => {
    const f = fixture();
    expect(await f.run()).toEqual(f.next);
    expect(f.bridge.request).toHaveBeenCalledWith("worker", {
      type: "worktree.reconcile",
      sourcePath: "/repo",
    });
    expect(f.repository.updateChatWorktree).toHaveBeenCalledWith(
      "owner",
      "chat",
      {
        worktreeId: "primary",
        mode: "agent-managed",
      },
      "old",
    );
  });
  it("refreshes a stale missing flag without moving an existing checkout", async () => {
    const f = fixture();
    f.repository.reconcileProjectWorktrees.mockResolvedValue([
      { ...f.selected, lifecycleState: "ready" },
      f.primary,
    ]);
    expect(await f.run()).toEqual(f.context);
    expect(f.repository.updateChatWorktree).not.toHaveBeenCalled();
  });
  it.each([
    "pinned",
    "running",
    "waiting-for-approval",
    "offline-worker",
    "wrong-source",
    "wrong-worker",
    "creating",
    "folder",
    "ready",
  ])("does not silently relocate %s", async (scenario) => {
    const f = fixture();
    if (scenario === "pinned") f.context.worktreeMode = "pinned";
    if (["running", "waiting-for-approval"].includes(scenario))
      f.context.status = scenario;
    if (scenario === "offline-worker")
      f.bridge.isConnected.mockReturnValue(false);
    if (scenario === "wrong-source") f.primary.projectSourceId = "other";
    if (scenario === "wrong-worker") f.primary.workerId = "other";
    if (scenario === "creating") f.selected.lifecycleState = "creating";
    if (scenario === "ready") f.selected.lifecycleState = "ready";
    if (scenario === "folder") f.context.rootKind = "managed-folder";
    expect(await f.run()).toEqual(f.context);
    expect(f.repository.updateChatWorktree).not.toHaveBeenCalled();
  });
  it("propagates actual worker failure instead of treating it as proof a checkout was removed", async () => {
    const f = fixture();
    f.bridge.request.mockRejectedValue(new Error("Worker unavailable"));
    await expect(f.run()).rejects.toThrow("Worker unavailable");
    expect(f.repository.updateChatWorktree).not.toHaveBeenCalled();
  });
  it("does not overwrite a concurrent placement change", async () => {
    const f = fixture();
    f.repository.updateChatWorktree.mockRejectedValue(
      new Error("placement changed"),
    );
    await expect(f.run()).rejects.toThrow("placement changed");
  });
});
