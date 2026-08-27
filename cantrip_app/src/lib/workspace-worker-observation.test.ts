import { describe, expect, it } from "vitest";

import { workspaceWorkerObservationDemands } from "./workspace-worker-observation";

describe("workspaceWorkerObservationDemands", () => {
  it("scopes visible project and standalone Chat workers by topic", () => {
    expect(
      workspaceWorkerObservationDemands({
        projectBroadWorkerIds: ["worker-project", "worker-chat"],
        projectChatWorkerId: "worker-chat",
        projectFilesystemWorkerIds: ["worker-files", "worker-project"],
        projectVisible: true,
        standaloneChatWorkerId: "worker-standalone",
      }),
    ).toEqual([
      {
        workerId: "worker-chat",
        topics: ["chat-progress", "filesystem", "worktree", "runtime"],
      },
      {
        workerId: "worker-files",
        topics: ["filesystem", "worktree"],
      },
      {
        workerId: "worker-project",
        topics: ["filesystem", "worktree", "runtime"],
      },
      {
        workerId: "worker-standalone",
        topics: ["chat-progress"],
      },
    ]);
  });

  it("drops project demand when the project UI is hidden", () => {
    expect(
      workspaceWorkerObservationDemands({
        projectBroadWorkerIds: ["worker-project"],
        projectChatWorkerId: "worker-chat",
        projectFilesystemWorkerIds: ["worker-files"],
        projectVisible: false,
        standaloneChatWorkerId: "worker-standalone",
      }),
    ).toEqual([
      {
        workerId: "worker-standalone",
        topics: ["chat-progress"],
      },
    ]);
  });
});
