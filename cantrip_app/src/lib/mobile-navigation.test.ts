import { describe, expect, it } from "vitest";

import {
  mobileSecondNavigationTarget,
  projectSelectionAction,
  validMobileSurfaceTabKey,
} from "./mobile-navigation";

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

  it("keeps desktop automatic selection and empty-project importing", () => {
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
});

describe("mobile second destination", () => {
  const validTabKeys = new Set(["chat:one", "terminal:one"]);

  it("opens the grid before a surface has been selected", () => {
    expect(
      mobileSecondNavigationTarget({
        gridOpen: false,
        overviewSelected: true,
        rememberedTabKey: null,
        selectedTabKey: null,
        validTabKeys,
      }),
    ).toEqual({ kind: "grid" });
  });

  it("returns from overview to the remembered surface", () => {
    expect(
      mobileSecondNavigationTarget({
        gridOpen: false,
        overviewSelected: true,
        rememberedTabKey: "terminal:one",
        selectedTabKey: null,
        validTabKeys,
      }),
    ).toEqual({ kind: "surface", tabKey: "terminal:one" });
  });

  it("reopens the grid when the active surface destination is tapped", () => {
    expect(
      mobileSecondNavigationTarget({
        gridOpen: false,
        overviewSelected: false,
        rememberedTabKey: "chat:one",
        selectedTabKey: "chat:one",
        validTabKeys,
      }),
    ).toEqual({ kind: "grid" });
  });

  it("clears deleted remembered surfaces", () => {
    expect(validMobileSurfaceTabKey("chat:deleted", validTabKeys)).toBeNull();
    expect(
      mobileSecondNavigationTarget({
        gridOpen: false,
        overviewSelected: true,
        rememberedTabKey: "chat:deleted",
        selectedTabKey: null,
        validTabKeys,
      }),
    ).toEqual({ kind: "grid" });
  });
});
