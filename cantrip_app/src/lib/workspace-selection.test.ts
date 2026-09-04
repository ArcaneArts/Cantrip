import type { ProjectTabLayoutSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  emptyWorkspaceSelection,
  reconcileWorkspaceSelection,
  selectedWorkspaceTabKey,
  selectWorkspaceGroup,
  selectWorkspaceOverview,
  selectWorkspaceTab,
} from "./workspace-selection";

const timestamp = "2026-08-09T12:00:00.000Z";

function layout(
  groups: Array<{
    anchor: string;
    id: string;
    members: Array<{ key: string; kind: "chat" | "terminal" }>;
  }>,
  projectId = "project-1",
): ProjectTabLayoutSummary {
  return {
    projectId,
    revision: 1,
    panes: groups.map((group, groupPosition) => ({
      id: group.id,
      projectId,
      title: group.anchor,
      position: groupPosition,
      region: "center",
      anchorTabKey: group.anchor,
      createdAt: timestamp,
      updatedAt: timestamp,
      members: group.members.map((member, position) => ({
        tabKey: member.key,
        paneId: group.id,
        projectId,
        tabKind: member.kind,
        tabId: member.key.split(":")[1]!,
        title: member.key,
        position,
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
    })),
  };
}

describe("workspace selection", () => {
  const initialLayout = layout([
    {
      id: "group-1",
      anchor: "chat:one",
      members: [
        { key: "chat:one", kind: "chat" },
        { key: "terminal:one", kind: "terminal" },
      ],
    },
    {
      id: "group-2",
      anchor: "chat:two",
      members: [{ key: "chat:two", kind: "chat" }],
    },
  ]);

  it("keeps one window-local active member per group", () => {
    let selection = reconcileWorkspaceSelection(
      emptyWorkspaceSelection(),
      initialLayout,
    );
    selection = selectWorkspaceTab(selection, initialLayout, "terminal:one");
    selection = selectWorkspaceTab(selection, initialLayout, "chat:two");
    expect(selection.activeTabByPane).toEqual({
      "group-1": "terminal:one",
      "group-2": "chat:two",
    });
    expect(selectedWorkspaceTabKey(selection)).toBe("chat:two");
    selection = selectWorkspaceTab(selection, initialLayout, "terminal:one");
    expect(selectedWorkspaceTabKey(selection)).toBe("terminal:one");
  });

  it("falls back to the anchor when an active member disappears", () => {
    let selection = selectWorkspaceTab(
      reconcileWorkspaceSelection(emptyWorkspaceSelection(), initialLayout),
      initialLayout,
      "terminal:one",
    );
    const changed = layout([
      {
        id: "group-1",
        anchor: "chat:one",
        members: [{ key: "chat:one", kind: "chat" }],
      },
    ]);
    selection = reconcileWorkspaceSelection(selection, changed);
    expect(selectedWorkspaceTabKey(selection)).toBe("chat:one");
  });

  it("returns to the project overview when the last tab disappears", () => {
    const selected = selectWorkspaceTab(
      reconcileWorkspaceSelection(emptyWorkspaceSelection(), initialLayout),
      initialLayout,
      "chat:two",
    );

    expect(reconcileWorkspaceSelection(selected, layout([]))).toEqual(
      emptyWorkspaceSelection("project-1"),
    );
  });

  it("honors an initial deep link without globally persisting selection", () => {
    const selection = reconcileWorkspaceSelection(
      emptyWorkspaceSelection("project-1"),
      initialLayout,
      "chat:two",
    );
    expect(selection.focusedPaneId).toBe("group-2");
    expect(selectedWorkspaceTabKey(selection)).toBe("chat:two");
  });

  it("keeps the project overview selected while tab layouts refresh", () => {
    const selection = reconcileWorkspaceSelection(
      emptyWorkspaceSelection("project-1"),
      initialLayout,
    );

    expect(selection.destination).toBe("overview");
    expect(selection.focusedPaneId).toBeNull();
    expect(selectedWorkspaceTabKey(selection)).toBeNull();
    expect(selection.activeTabByPane).toEqual({
      "group-1": "chat:one",
      "group-2": "chat:two",
    });
  });

  it("leaves the overview when a child tab is selected", () => {
    const overview = reconcileWorkspaceSelection(
      emptyWorkspaceSelection("project-1"),
      initialLayout,
    );
    const selected = selectWorkspaceTab(overview, initialLayout, "chat:two");

    expect(selected.destination).toBe("surface");
    expect(selectedWorkspaceTabKey(selected)).toBe("chat:two");
  });

  it("returns to overview without forgetting valid group-local members", () => {
    const selected = selectWorkspaceTab(
      reconcileWorkspaceSelection(emptyWorkspaceSelection(), initialLayout),
      initialLayout,
      "terminal:one",
    );
    const overview = selectWorkspaceOverview(selected);

    expect(overview).toMatchObject({
      destination: "overview",
      projectId: "project-1",
      focusedPaneId: null,
      activeTabByPane: {
        "group-1": "terminal:one",
        "group-2": "chat:two",
      },
    });
  });

  it("clears remembered members when overview changes projects", () => {
    const selected = selectWorkspaceTab(
      reconcileWorkspaceSelection(emptyWorkspaceSelection(), initialLayout),
      initialLayout,
      "terminal:one",
    );

    expect(selectWorkspaceOverview(selected, "project-2")).toEqual(
      emptyWorkspaceSelection("project-2"),
    );
  });

  it("resets group-local state when the project changes", () => {
    const selected = selectWorkspaceTab(
      reconcileWorkspaceSelection(emptyWorkspaceSelection(), initialLayout),
      initialLayout,
      "terminal:one",
    );
    const next = reconcileWorkspaceSelection(
      selected,
      layout(
        [
          {
            id: "other-group",
            anchor: "chat:other",
            members: [{ key: "chat:other", kind: "chat" }],
          },
        ],
        "project-2",
      ),
    );
    expect(next).toMatchObject({
      projectId: "project-2",
      focusedPaneId: "other-group",
      activeTabByPane: { "other-group": "chat:other" },
    });
  });

  it("restores the window-local active member when selecting a group", () => {
    let selected = selectWorkspaceTab(
      reconcileWorkspaceSelection(emptyWorkspaceSelection(), initialLayout),
      initialLayout,
      "terminal:one",
    );
    selected = selectWorkspaceGroup(selected, initialLayout, "group-2");
    selected = selectWorkspaceGroup(selected, initialLayout, "group-1");
    expect(selectedWorkspaceTabKey(selected)).toBe("terminal:one");
  });
});
