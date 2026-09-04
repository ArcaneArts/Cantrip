import type { ProjectSummary } from "@cantrip/protocol";
import type { ProjectTabLayoutSummary } from "@cantrip/protocol";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  applyDockPresentationToLayout,
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
  panes: [
    {
      id: "group-1",
      projectId: "one",
      title: "Tabs",
      position: 0,
      region: "center",
      anchorTabKey: "chat:first",
      createdAt: timestamp,
      updatedAt: timestamp,
      members: ["chat:first", "chat:second"].map((tabKey, position) => ({
        paneId: "group-1",
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
  it("optimistically updates only the addressed tab presentation", () => {
    const preference = {
      preferredMode: "full",
      restoreFraction: 0.38,
      splitFraction: 0.38,
    } as const;
    const updated = applyDockPresentationToLayout(
      layout,
      "chat:second",
      preference,
    );

    expect(updated.revision).toBe(layout.revision);
    expect(updated.panes[0]?.members[0]?.dockPresentation).toBeUndefined();
    expect(updated.panes[0]?.members[1]?.dockPresentation).toEqual(preference);
    expect(layout.panes[0]?.members[1]?.dockPresentation).toBeUndefined();
  });

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
        paneId: "group-1",
        tabKeys: ["chat:second", "chat:first"],
      },
    });

    expect(
      queryClient
        .getQueryData<ProjectTabLayoutSummary>(queryKey)
        ?.panes[0]?.members.map(({ tabKey }) => tabKey),
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
      command: {
        type: "reorder-panes",
        paneIds: ["group-2", "group-1"],
        region: "center",
      },
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
