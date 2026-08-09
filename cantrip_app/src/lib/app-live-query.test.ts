import type { AppLiveServerMessage } from "@cantrip/protocol";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  AppLiveQueryBridge,
  appLiveEventQueryKeys,
  appLiveScopeQueryKeys,
} from "./app-live-query";

type AppLiveEvent = Extract<AppLiveServerMessage, { type: "event" }>;

const event = (
  input: Pick<AppLiveEvent, "resource" | "scope"> &
    Partial<Pick<AppLiveEvent, "entityId">>,
): AppLiveEvent => ({
  type: "event",
  cursor: 1,
  action: "updated",
  entityId: input.entityId ?? null,
  revision: null,
  payload: null,
  occurredAt: "2026-08-09T12:00:00.000Z",
  ...input,
});

describe("application live query bridge", () => {
  it("maps typed resources to their scoped query families", () => {
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "worktree-status",
          scope: { kind: "project", projectId: "project-one" },
        }),
      ),
    ).toEqual([["worktree-status", "project-one"]]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "chat-message",
          scope: { kind: "chat", chatId: "chat-one" },
        }),
      ),
    ).toEqual([["messages", "chat-one"]]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "workflow-run",
          scope: { kind: "workflow-run", runId: "run-one" },
        }),
      ),
    ).toEqual([["workflow-run", "run-one"]]);
    expect(
      appLiveScopeQueryKeys({ kind: "project", projectId: "project-one" }),
    ).toContainEqual(["worktrees", "project-one"]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "terminal",
          scope: { kind: "current-user" },
        }),
      ),
    ).toEqual([["terminals"]]);
  });

  it("coalesces repeated events before invalidating TanStack Query", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const bridge = new AppLiveQueryBridge(queryClient);
    const workerEvent = event({
      resource: "worker",
      scope: { kind: "current-user" },
    });
    bridge.handleEvent(workerEvent);
    bridge.handleEvent({ ...workerEvent, cursor: 2 });
    await Promise.resolve();
    await Promise.resolve();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["workers"] });
  });

  it("awaits all authoritative scope invalidations during recovery", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const bridge = new AppLiveQueryBridge(queryClient);
    await bridge.recoverScopes(
      [{ kind: "current-user" }, { kind: "chat", chatId: "chat-one" }],
      "server-epoch-changed",
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["projects"] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["messages", "chat-one"],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["chat-customizations", "chat-one"],
    });
  });
});
