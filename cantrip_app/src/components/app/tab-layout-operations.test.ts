import type { ProjectSummary } from "@cantrip/protocol";
import type { ProjectTabLayoutSummary } from "@cantrip/protocol";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  createWorkspaceDropHandler,
  prepareOptimisticTabLayoutMutation,
} from "./tab-layout-operations";

const projects = ["one", "two", "three"].map(
  (id) => ({ id }) as ProjectSummary,
);

const timestamp = "2026-08-27T12:00:00.000Z";
const layout: ProjectTabLayoutSummary = {
  projectId: "one",
  revision: 1,
  groups: [
    {
      id: "group-1",
      projectId: "one",
      title: "Tabs",
      position: 0,
      anchorTabKey: "chat:first",
      createdAt: timestamp,
      updatedAt: timestamp,
      members: ["chat:first", "chat:second"].map((tabKey, position) => ({
        groupId: "group-1",
        projectId: "one",
        tabKind: "chat" as const,
        tabId: tabKey.slice("chat:".length),
        tabKey,
        title: tabKey,
        position,
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
    },
  ],
};

describe("workspace drop operations", () => {
  it("publishes the destination layout before query cancellation finishes", async () => {
    const queryClient = new QueryClient();
    const queryKey = ["project-tab-layout", layout.projectId] as const;
    queryClient.setQueryData(queryKey, layout);
    let finishCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    vi.spyOn(queryClient, "cancelQueries").mockReturnValue(cancellation);

    const prepared = prepareOptimisticTabLayoutMutation(queryClient, {
      projectId: layout.projectId,
      command: {
        type: "reorder-members",
        groupId: "group-1",
        tabKeys: ["chat:second", "chat:first"],
      },
    });

    expect(
      queryClient
        .getQueryData<ProjectTabLayoutSummary>(queryKey)
        ?.groups[0]?.members.map(({ tabKey }) => tabKey),
    ).toEqual(["chat:second", "chat:first"]);
    finishCancellation();
    await expect(prepared.cancellation).resolves.toBeUndefined();
  });

  it("does not overlap optimistic tab-layout mutations", () => {
    const setWorkspaceDragError = vi.fn();
    const tabLayoutMutation = { isPending: true, mutate: vi.fn() };
    const handleDrop = createWorkspaceDropHandler({
      projects,
      reorderProjectsMutation: { mutate: vi.fn() },
      setWorkspaceDragError,
      tabLayoutMutation,
    });

    handleDrop({
      type: "tab-layout",
      projectId: "one",
      command: { type: "reorder-groups", groupIds: ["group-2", "group-1"] },
    });

    expect(tabLayoutMutation.mutate).not.toHaveBeenCalled();
    expect(setWorkspaceDragError).toHaveBeenLastCalledWith(
      "Wait for the current tab move to finish.",
    );
  });

  it("reorders projects by moving the source to the target position", () => {
    const reorderProjectsMutation = { mutate: vi.fn() };
    const handleDrop = createWorkspaceDropHandler({
      projects,
      reorderProjectsMutation,
      setWorkspaceDragError: vi.fn(),
      tabLayoutMutation: { isPending: false, mutate: vi.fn() },
    });

    handleDrop({
      type: "reorder-projects",
      sourceProjectId: "three",
      targetProjectId: "one",
    });

    expect(reorderProjectsMutation.mutate).toHaveBeenCalledWith([
      "three",
      "one",
      "two",
    ]);
  });
});
