import { describe, expect, it } from "vitest";
import {
  applyWorkspaceCommand,
  workspaceOwnershipSchema,
  WorkspaceCommandError,
  type WorkspaceAction,
  type WorkspaceCommand,
  type WorkspaceOwnership,
  type WorkspaceTab,
} from "../src/index.js";

function tab(id: string): WorkspaceTab {
  return {
    id,
    resource: {
      kind: "entity",
      definitionId: "project.terminal",
      resourceId: `resource-${id}`,
    },
    titleProtection: null,
    preview: false,
    builtInState: null,
    dockPresentation: null,
  };
}
function fixture(): WorkspaceOwnership {
  return workspaceOwnershipSchema.parse({
    version: 1,
    id: "desktop",
    projectId: "project",
    revision: 4,
    mainWindowId: "main",
    windows: [
      {
        id: "main",
        attachmentGeneration: 2,
        panes: [
          {
            id: "a",
            region: "center",
            titleProtection: null,
            tabs: [tab("a1"), tab("a2"), tab("a3")],
            activeTabId: "a2",
          },
          {
            id: "b",
            region: "center",
            titleProtection: null,
            tabs: [tab("b1")],
            activeTabId: "b1",
          },
          {
            id: "dock",
            region: "right",
            titleProtection: null,
            tabs: [tab("d1")],
            activeTabId: "d1",
          },
        ],
        centerRoot: {
          kind: "split",
          id: "split-ab",
          direction: "horizontal",
          fraction: 0.35,
          first: { kind: "pane", paneId: "a" },
          second: { kind: "pane", paneId: "b" },
        },
        focusedPaneId: "a",
        recentPaneIds: ["a", "dock", "b"],
      },
      {
        id: "popout",
        attachmentGeneration: 3,
        panes: [
          {
            id: "p",
            region: "center",
            titleProtection: null,
            tabs: [tab("p1")],
            activeTabId: "p1",
          },
        ],
        centerRoot: { kind: "pane", paneId: "p" },
        focusedPaneId: "p",
        recentPaneIds: ["p"],
      },
    ],
  });
}
function command(
  layout: WorkspaceOwnership,
  action: WorkspaceAction,
  windowId = "main",
): WorkspaceCommand {
  return {
    operationId: "operation",
    workspaceId: layout.id,
    projectId: layout.projectId,
    windowId,
    attachmentGeneration: layout.windows.find(
      (window) => window.id === windowId,
    )!.attachmentGeneration,
    expectedRevision: layout.revision,
    action,
  };
}
function run(action: WorkspaceAction, layout = fixture(), windowId = "main") {
  return applyWorkspaceCommand(layout, command(layout, action, windowId));
}

describe("workspace command scope and atomicity", () => {
  it.each<[string, Partial<WorkspaceCommand>, string]>([
    ["another device", { workspaceId: "mobile" }, "scope"],
    ["another project", { projectId: "other" }, "scope"],
    ["stale revision", { expectedRevision: 3 }, "revision"],
    ["future revision", { expectedRevision: 5 }, "revision"],
    ["stale renderer", { attachmentGeneration: 1 }, "attachment"],
    ["unknown window", { windowId: "missing" }, "missing"],
  ])("rejects %s without changing the input", (_name, patch, code) => {
    const input = fixture();
    const before = structuredClone(input);
    expect(() =>
      applyWorkspaceCommand(input, {
        ...command(input, { type: "close-tab", tabId: "a2" }),
        ...patch,
      }),
    ).toThrow(expect.objectContaining({ code }));
    expect(input).toEqual(before);
  });

  it("advances one revision, returns the operation identity, and does not mutate its inputs", () => {
    const input = fixture();
    const before = structuredClone(input);
    const result = run({ type: "select", tabId: "b1" }, input);
    expect(result.layout.revision).toBe(5);
    expect(result.operationId).toBe("operation");
    expect(input).toEqual(before);
    expect(result.layout.windows[0]!.recentPaneIds).toEqual(["b", "a", "dock"]);
  });

  it.each<WorkspaceAction>([
    { type: "select", tabId: "p1" },
    { type: "close-tab", tabId: "p1" },
    { type: "close-pane", paneId: "p" },
    { type: "move", tabId: "a1", targetPaneId: "p", position: 0 },
    { type: "resize", splitId: "missing", fraction: 0.5 },
  ])("rejects a nonlocal or missing target for $type", (action) => {
    expect(() => run(action)).toThrow(WorkspaceCommandError);
  });

  it("does not leave partial edits when a generated identity conflicts", () => {
    const input = fixture();
    const before = structuredClone(input);
    expect(() =>
      run(
        {
          type: "split",
          tabId: "a1",
          targetPaneId: "b",
          paneId: "p",
          splitId: "new-split",
          edge: "right",
          fraction: 0.5,
        },
        input,
      ),
    ).toThrow();
    expect(input).toEqual(before);
  });
});

describe("close selection", () => {
  it("does not close an unrelated empty destination that may still be preparing a transfer", () => {
    const input = fixture();
    input.windows.push({
      id: "preparing",
      attachmentGeneration: 0,
      panes: [],
      centerRoot: null,
      focusedPaneId: null,
      recentPaneIds: [],
    });
    expect(
      run({ type: "close-tab", tabId: "a1" }, input).emptyWindowIds,
    ).toEqual([]);
  });
  it.each([
    ["a1", "a2"],
    ["a2", "a3"],
    ["a3", "a2"],
  ])("closing %s selects or retains %s", (tabId, expected) => {
    expect(
      run({ type: "close-tab", tabId }).layout.windows[0]!.panes[0]!
        .activeTabId,
    ).toBe(expected);
  });

  it("closing the active rightmost tab selects its left neighbor", () => {
    const input = fixture();
    input.windows[0]!.panes[0]!.activeTabId = "a3";
    expect(
      run({ type: "close-tab", tabId: "a3" }, input).layout.windows[0]!
        .panes[0]!.activeTabId,
    ).toBe("a2");
  });

  it("removes an empty pane and its split, then uses local focus history", () => {
    const result = run({ type: "close-pane", paneId: "a" });
    const main = result.layout.windows[0]!;
    expect(main.panes.map((pane) => pane.id)).toEqual(["b", "dock"]);
    expect(main.centerRoot).toEqual({ kind: "pane", paneId: "b" });
    expect(main.focusedPaneId).toBe("dock");
    expect(main.recentPaneIds).toEqual(["dock", "b"]);
    expect(result.layout.windows[1]).toEqual(fixture().windows[1]);
  });

  it("closing another pane preserves current focus", () => {
    expect(
      run({ type: "close-tab", tabId: "b1" }).layout.windows[0]!.focusedPaneId,
    ).toBe("a");
  });

  it("closing the final popout tab reports an empty window without resurrecting tabs in main", () => {
    const result = run({ type: "close-tab", tabId: "p1" }, fixture(), "popout");
    expect(result.emptyWindowIds).toEqual(["popout"]);
    expect(result.layout.windows[1]).toMatchObject({
      panes: [],
      centerRoot: null,
      focusedPaneId: null,
      recentPaneIds: [],
    });
    expect(result.layout.windows[0]).toEqual(fixture().windows[0]);
  });

  it("keeps the main window when its last pane closes", () => {
    let input = fixture();
    for (const paneId of ["a", "b", "dock"])
      input = run({ type: "close-pane", paneId }, input).layout;
    expect(input.windows[0]).toMatchObject({
      panes: [],
      centerRoot: null,
      focusedPaneId: null,
    });
    expect(run({ type: "home" }, input).emptyWindowIds).toEqual([]);
  });
});

describe("ordinary tab and pane operations", () => {
  it("pins a preview without replacing its identity or resource", () => {
    const input = fixture();
    input.windows[0]!.panes[0]!.tabs[0]!.preview = true;
    expect(
      run({ type: "pin", tabId: "a1" }, input).layout.windows[0]!.panes[0]!
        .tabs[0],
    ).toEqual(tab("a1"));
  });

  it("reorders without changing selection", () => {
    const pane = run({
      type: "reorder",
      paneId: "a",
      tabIds: ["a3", "a1", "a2"],
    }).layout.windows[0]!.panes[0]!;
    expect(pane.tabs.map((tab) => tab.id)).toEqual(["a3", "a1", "a2"]);
    expect(pane.activeTabId).toBe("a2");
  });

  it.each([
    ["a1", "a1", "a3"],
    ["a1", "a2"],
    ["a1", "a2", "missing"],
  ])("rejects an incomplete or duplicated order %j", (...tabIds) => {
    expect(() => run({ type: "reorder", paneId: "a", tabIds })).toThrow(
      WorkspaceCommandError,
    );
  });

  it("moves a view and removes its now-empty source pane without reminting the view", () => {
    const main = run({
      type: "move",
      tabId: "b1",
      targetPaneId: "a",
      position: 1,
    }).layout.windows[0]!;
    expect(main.panes.map((pane) => pane.id)).toEqual(["a", "dock"]);
    expect(main.panes[0]!.tabs.map((tab) => tab.id)).toEqual([
      "a1",
      "b1",
      "a2",
      "a3",
    ]);
    expect(main.panes[0]!.tabs[1]).toEqual(tab("b1"));
    expect(main.panes[0]!.activeTabId).toBe("b1");
    expect(main.centerRoot).toEqual({ kind: "pane", paneId: "a" });
  });

  it("supports same-pane moves including a one-tab pane", () => {
    expect(
      run({
        type: "move",
        tabId: "a1",
        targetPaneId: "a",
        position: 2,
      }).layout.windows[0]!.panes[0]!.tabs.map((tab) => tab.id),
    ).toEqual(["a2", "a3", "a1"]);
    expect(
      run({ type: "move", tabId: "b1", targetPaneId: "b", position: 0 }).layout
        .windows[0]!.panes[1]!.tabs,
    ).toEqual([tab("b1")]);
    expect(() =>
      run({ type: "move", tabId: "b1", targetPaneId: "b", position: 1 }),
    ).toThrow(WorkspaceCommandError);
  });

  it.each(["left", "right", "top", "bottom"] as const)(
    "splits toward %s while preserving identity and existing topology",
    (edge) => {
      const main = run({
        type: "split",
        tabId: "a1",
        targetPaneId: "a",
        paneId: "new",
        splitId: "new-split",
        edge,
        fraction: 0.4,
      }).layout.windows[0]!;
      expect(main.panes.find((pane) => pane.id === "new")!.tabs).toEqual([
        tab("a1"),
      ]);
      expect(
        main.panes.find((pane) => pane.id === "a")!.tabs.map((tab) => tab.id),
      ).toEqual(["a2", "a3"]);
      expect(main.focusedPaneId).toBe("new");
      expect(main.centerRoot).toMatchObject({
        id: "split-ab",
        fraction: 0.35,
        first: {
          id: "new-split",
          fraction: 0.4,
          direction:
            edge === "left" || edge === "right" ? "horizontal" : "vertical",
          first: { paneId: edge === "left" || edge === "top" ? "new" : "a" },
        },
      });
    },
  );

  it("does not split away the target's only tab or split a dock target", () => {
    for (const targetPaneId of ["b", "dock"])
      expect(() =>
        run({
          type: "split",
          tabId: "b1",
          targetPaneId,
          paneId: "new",
          splitId: "new-split",
          edge: "right",
          fraction: 0.5,
        }),
      ).toThrow(WorkspaceCommandError);
  });

  it("resizes only the specified split", () => {
    expect(
      run({ type: "resize", splitId: "split-ab", fraction: 0.7 }).layout
        .windows[0]!.centerRoot,
    ).toMatchObject({ id: "split-ab", fraction: 0.7 });
    expect(() =>
      run({ type: "resize", splitId: "split-ab", fraction: 1 }),
    ).toThrow();
  });
});

describe("resource opening", () => {
  it("focuses an existing view without duplicating it or altering its metadata", () => {
    const duplicate = { ...tab("a2"), id: "new-view", preview: true };
    const result = run({
      type: "open",
      tab: duplicate,
      target: { kind: "pane", paneId: "b" },
    });
    expect(result.layout.windows[0]!.panes[0]!.tabs).toEqual(
      fixture().windows[0]!.panes[0]!.tabs,
    );
    expect(result.layout.windows[0]!.panes[1]!.tabs).toHaveLength(1);
  });

  it("requests focus of an existing other-window view instead of making a disabled local copy", () => {
    const result = run({
      type: "open",
      tab: { ...tab("p1"), id: "new-view" },
      target: { kind: "pane", paneId: "a" },
    });
    expect(result.focusWindowId).toBe("popout");
    expect(result.layout.windows[0]).toEqual(fixture().windows[0]);
    expect(result.layout.windows[1]!.panes[0]!.tabs).toEqual([tab("p1")]);
  });

  it("opens into an explicit pane with a stable supplied tab identity", () => {
    const pane = run({
      type: "open",
      tab: tab("new"),
      target: { kind: "pane", paneId: "a" },
    }).layout.windows[0]!.panes[0]!;
    expect(pane.tabs.at(-1)).toEqual(tab("new"));
    expect(pane.activeTabId).toBe("new");
  });

  it("creates an explicit center pane without leaving an unrepresented split slot", () => {
    const main = run({
      type: "open",
      tab: tab("new"),
      target: {
        kind: "new-pane",
        paneId: "new-pane",
        region: "center",
        splitId: "new-split",
      },
    }).layout.windows[0]!;
    expect(main.panes.at(-1)).toMatchObject({
      id: "new-pane",
      activeTabId: "new",
    });
    expect(main.centerRoot).toMatchObject({
      id: "new-split",
      first: fixture().windows[0]!.centerRoot,
      second: { kind: "pane", paneId: "new-pane" },
    });
  });
});
