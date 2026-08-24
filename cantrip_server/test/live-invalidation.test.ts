import { describe, expect, it } from "vitest";

import { mutationLiveResources } from "../src/app.js";

describe("live mutation invalidation", () => {
  it("does not publish mutation events for protected repository reads", () => {
    const workerRoute = "/api/workers/:workerId/repository-operation";
    const worktreeRoute =
      "/api/projects/:projectId/worktrees/:worktreeId/repository-operation";

    expect(mutationLiveResources(workerRoute, "read")).toEqual([]);
    expect(mutationLiveResources(worktreeRoute, "read")).toEqual([]);
    expect(mutationLiveResources(workerRoute, "write")).toEqual(["worker"]);
    expect(mutationLiveResources(worktreeRoute, "write")).toEqual(["worktree"]);
  });

  it("invalidates shared Run definitions independently from runtime state", () => {
    expect(
      mutationLiveResources(
        "/api/projects/:projectId/run-configurations/:configurationId",
      ),
    ).toEqual(["run-configuration"]);
  });

  it("does not fan out chat-list invalidations for composer autosaves", () => {
    expect(mutationLiveResources("/api/chats/:chatId/composer-draft")).toEqual(
      [],
    );
  });
});
