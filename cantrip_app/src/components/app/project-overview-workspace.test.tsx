import { describe, expect, it, vi } from "vitest";
import { ProjectOverviewWorkspace } from "./project-overview-workspace";

describe("Overview workspace navigation", () => {
  it("does not change selection on render and exits before opening a surface", () => {
    const events: string[] = [];
    const bindings = {
      selectedProject: { id: "project-1" },
      repositoryStats: {},
      projectTokenUsage: {},
      workers: {},
      worktrees: {},
      projectSurfaces: [],
      creatingSurfaceKinds: new Set(),
      setShowProjectOverview: vi.fn(() => events.push("exit")),
      selectTopTab: vi.fn(() => events.push("select")),
      createProjectSurface: vi.fn(() => events.push("create")),
    };
    const content = ProjectOverviewWorkspace({ bindings }).props.children;
    expect(events).toEqual([]);
    expect(content.props.surfaces).toEqual([]);
    content.props.onOpenSurface("terminal:1");
    expect(events).toEqual(["exit", "select"]);
    expect(bindings.setShowProjectOverview).toHaveBeenCalledWith(false);
    expect(bindings.selectTopTab).toHaveBeenCalledWith("terminal:1");
    events.length = 0;
    content.props.onCreateSurface("terminal");
    expect(events).toEqual(["exit", "create"]);
    expect(bindings.createProjectSurface).toHaveBeenCalledWith(
      "project-1",
      "terminal",
      undefined,
      undefined,
    );
  });
});
