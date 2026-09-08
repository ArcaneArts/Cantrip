import { describe, expect, it, vi } from "vitest";
import {
  ThreadObservationRegistry,
  type ThreadObservationScope,
} from "../src/codex/thread-observation.js";

const scope: ThreadObservationScope = {
  serverId: "server",
  ownerId: "owner",
  workerId: "worker",
  chatId: "chat",
  threadId: "native-thread",
  cwd: "/worktree",
  modelRouteId: "root-route",
  providerId: "provider",
  providerKind: "chatgpt",
  providerAccountId: "account",
  credentialHomeKey: "home",
};
const snapshot = {
  threadId: "native-thread",
  status: "idle" as const,
  turns: [],
};

describe("bound thread observation", () => {
  it("uses the exact prepared runtime without selecting or configuring child models", async () => {
    const registry = new ThreadObservationRegistry();
    const runtime = { observeThread: vi.fn().mockResolvedValue(snapshot) };
    const coldRead = vi
      .fn()
      .mockRejectedValue(new Error("child route unavailable"));
    registry.bind(scope, runtime);
    await expect(registry.sync(scope, coldRead)).resolves.toEqual(snapshot);
    expect(runtime.observeThread).toHaveBeenCalledExactlyOnceWith({
      cwd: scope.cwd,
      threadId: scope.threadId,
    });
    expect(coldRead).not.toHaveBeenCalled();
  });

  it.each([
    "serverId",
    "ownerId",
    "workerId",
    "chatId",
    "threadId",
    "cwd",
    "modelRouteId",
    "providerId",
    "providerKind",
    "providerAccountId",
    "credentialHomeKey",
  ] as const)("does not reuse a binding after %s changes", async (key) => {
    const registry = new ThreadObservationRegistry();
    const runtime = { observeThread: vi.fn().mockResolvedValue(snapshot) };
    const coldRead = vi.fn().mockResolvedValue(snapshot);
    registry.bind(scope, runtime);
    await registry.sync({ ...scope, [key]: "changed" }, coldRead);
    expect(runtime.observeThread).not.toHaveBeenCalled();
    expect(coldRead).toHaveBeenCalledExactlyOnceWith();
  });

  it("uses current cold bootstrap after actual transport loss but propagates actual read errors", async () => {
    const registry = new ThreadObservationRegistry();
    const runtime = { observeThread: vi.fn().mockResolvedValue(null) };
    const coldRead = vi.fn().mockResolvedValue(snapshot);
    registry.bind(scope, runtime);
    await expect(registry.sync(scope, coldRead)).resolves.toEqual(snapshot);
    expect(coldRead).toHaveBeenCalledTimes(1);
    runtime.observeThread.mockRejectedValue(
      new Error("native storage failure"),
    );
    await expect(registry.sync(scope, coldRead)).rejects.toThrow(
      "native storage failure",
    );
    expect(coldRead).toHaveBeenCalledTimes(1);
  });
});
