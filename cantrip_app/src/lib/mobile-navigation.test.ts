import { describe, expect, it } from "vitest";

import {
  assignMobileBottomTab,
  initialMobileBottomTabs,
  mobileBottomTabConfiguration,
  mobileBottomTabsFromConfiguration,
  PRIMARY_MOBILE_BOTTOM_TAB_ID,
  projectSelectionAction,
  reconcileMobileBottomTabs,
  removeMobileBottomTab,
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

describe("mobile bottom tabs", () => {
  it("starts with one permanent unassigned project tab", () => {
    expect(initialMobileBottomTabs()).toEqual([
      { groupId: null, id: PRIMARY_MOBILE_BOTTOM_TAB_ID },
    ]);
  });

  it("restores and serializes ordered project tab assignments", () => {
    const restored = mobileBottomTabsFromConfiguration([
      "group-1",
      null,
      "group-3",
    ]);
    expect(restored).toEqual([
      { groupId: "group-1", id: PRIMARY_MOBILE_BOTTOM_TAB_ID },
      { groupId: null, id: "mobile-1" },
      { groupId: "group-3", id: "mobile-2" },
    ]);
    expect(mobileBottomTabConfiguration(restored)).toEqual([
      "group-1",
      null,
      "group-3",
    ]);
  });

  it("assigns a project group to a bottom tab", () => {
    const tabs = initialMobileBottomTabs();
    expect(
      assignMobileBottomTab(tabs, PRIMARY_MOBILE_BOTTOM_TAB_ID, "group-1"),
    ).toEqual([{ groupId: "group-1", id: PRIMARY_MOBILE_BOTTOM_TAB_ID }]);
    expect(tabs[0]?.groupId).toBeNull();
  });

  it("returns deleted groups to the tab switcher", () => {
    expect(
      reconcileMobileBottomTabs(
        [
          { groupId: "group-1", id: PRIMARY_MOBILE_BOTTOM_TAB_ID },
          { groupId: "deleted", id: "mobile-1" },
        ],
        new Set(["group-1"]),
      ),
    ).toEqual([
      { groupId: "group-1", id: PRIMARY_MOBILE_BOTTOM_TAB_ID },
      { groupId: null, id: "mobile-1" },
    ]);
  });

  it("protects the first project tab and selects the previous tab after removal", () => {
    const tabs = [
      { groupId: "group-1", id: PRIMARY_MOBILE_BOTTOM_TAB_ID },
      { groupId: "group-2", id: "mobile-1" },
      { groupId: "group-3", id: "mobile-2" },
    ];

    expect(
      removeMobileBottomTab(tabs, PRIMARY_MOBILE_BOTTOM_TAB_ID),
    ).toBeNull();
    expect(removeMobileBottomTab(tabs, "mobile-2")).toEqual({
      activeTabId: "mobile-1",
      tabs: tabs.slice(0, 2),
    });
  });
});
