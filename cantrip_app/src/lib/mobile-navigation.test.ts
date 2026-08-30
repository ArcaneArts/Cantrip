import { describe, expect, it } from "vitest";

import { projectSelectionAction } from "./mobile-navigation";

const projects = [{ id: "one" }, { id: "two" }];

describe("mobile project selection", () => {
  it("preserves the selector on compact startup and valid cross-workspace selections", () => {
    expect(
      projectSelectionAction({
        compact: true,
        projects,
        selectedProjectId: null,
        visibleProjects: [projects[0]!],
      }),
    ).toBeNull();
    expect(
      projectSelectionAction({
        compact: true,
        projects,
        selectedProjectId: "two",
        visibleProjects: [projects[0]!],
      }),
    ).toBeNull();
  });

  it("returns a deleted compact project to the selector", () => {
    expect(
      projectSelectionAction({
        compact: true,
        projects,
        selectedProjectId: "missing",
        visibleProjects: projects,
      }),
    ).toEqual({ projectId: null, showImporter: false });
  });

  it("keeps desktop automatic selection and opens project onboarding when empty", () => {
    expect(
      projectSelectionAction({
        compact: false,
        projects,
        selectedProjectId: null,
        visibleProjects: [projects[1]!],
      }),
    ).toEqual({ projectId: "two" });
    expect(
      projectSelectionAction({
        compact: false,
        projects: [],
        selectedProjectId: null,
        visibleProjects: [],
      }),
    ).toEqual({ projectId: null, showImporter: true });
  });

  it("preserves a managed root screen while workspace data refreshes", () => {
    expect(
      projectSelectionAction({
        compact: false,
        preserveCurrentDestination: true,
        projects: [],
        selectedProjectId: null,
        visibleProjects: [],
      }),
    ).toBeNull();
  });
});
