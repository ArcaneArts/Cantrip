import type { ProjectSummary } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import { createWorkspaceDropHandler } from "./tab-layout-operations";

const projects = ["one", "two", "three"].map(
  (id) => ({ id }) as ProjectSummary,
);

describe("workspace drop operations", () => {
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
