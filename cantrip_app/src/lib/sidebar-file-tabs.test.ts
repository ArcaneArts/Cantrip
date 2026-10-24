import type {
  ExplorerSummary,
  ProjectTabLayoutSummary,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  pinnedExplorerForPath,
  preferredSidebarExplorer,
  moveSidebarPath,
  surfaceWorktreeId,
  sidebarFileName,
  sidebarFileTargetPaneId,
  sidebarPathAtOrBelow,
  tabbedExplorerIds,
} from "./sidebar-file-tabs";

function explorer(
  id: string,
  worktreeId: string,
  selectedPath: string | null = null,
): ExplorerSummary {
  return { id, selectedPath, worktreeId } as ExplorerSummary;
}

function layout(...explorerIds: string[]): ProjectTabLayoutSummary {
  return {
    panes: [
      {
        members: explorerIds.map((id) => ({
          tabId: id,
          tabKind: "explorer",
        })),
      },
    ],
  } as unknown as ProjectTabLayoutSummary;
}

describe("sidebar file tabs", () => {
  it("follows the selected file document's worktree", () => {
    expect(
      surfaceWorktreeId({
        kind: "file",
        entity: { worktreeId: "feature" },
      } as Parameters<typeof surfaceWorktreeId>[0]),
    ).toBe("feature");
    expect(surfaceWorktreeId(undefined)).toBeNull();
  });

  it("prefers the hidden Explorer for the active worktree", () => {
    const hidden = explorer("hidden", "worktree-1");
    const visible = explorer("visible", "worktree-1");

    expect(
      preferredSidebarExplorer({
        desiredWorktreeId: "worktree-1",
        explorers: [visible, hidden],
        layout: layout("visible"),
      }),
    ).toBe(hidden);
  });

  it("never falls back to a tabbed Explorer while a dedicated preview owner is provisioning", () => {
    const pinnedEmpty = explorer("pinned-empty", "worktree-1");
    const pinnedFile = explorer("pinned-file", "worktree-1", "src/existing.ts");
    const tabLayout = layout(pinnedEmpty.id, pinnedFile.id);

    expect(
      preferredSidebarExplorer({
        desiredWorktreeId: "worktree-1",
        explorers: [pinnedEmpty, pinnedFile],
        layout: tabLayout,
      }),
    ).toBeNull();
    expect(
      preferredSidebarExplorer({
        desiredWorktreeId: "worktree-1",
        explorers: [pinnedEmpty, pinnedFile],
        layout: tabLayout,
      }),
    ).toBeNull();
  });

  it("hands sidebar ownership to the first dedicated replacement after pinning", () => {
    const pinned = explorer("pinned", "worktree-1", "src/first.ts");
    const replacement = explorer("replacement", "worktree-1");
    const otherWorktree = explorer("other", "worktree-2");
    const tabLayout = layout(pinned.id);

    expect(
      preferredSidebarExplorer({
        desiredWorktreeId: "worktree-1",
        explorers: [pinned, otherWorktree],
        layout: tabLayout,
      }),
    ).toBeNull();
    expect(
      preferredSidebarExplorer({
        desiredWorktreeId: "worktree-1",
        explorers: [pinned, otherWorktree, replacement],
        layout: tabLayout,
      }),
    ).toBe(replacement);
  });

  it("requires a non-tabbed Explorer for sidebar tree navigation", () => {
    const visible = explorer("visible", "worktree-1");
    const hidden = explorer("hidden", "worktree-1");

    expect(
      preferredSidebarExplorer({
        desiredWorktreeId: "worktree-1",
        explorers: [visible],
        layout: layout("visible"),
      }),
    ).toBeNull();
    expect(
      preferredSidebarExplorer({
        desiredWorktreeId: "worktree-1",
        explorers: [visible, hidden],
        layout: layout("visible"),
      }),
    ).toBe(hidden);

    expect(
      preferredSidebarExplorer({
        desiredWorktreeId: "worktree-1",
        explorers: [visible, hidden, explorer("second", "worktree-1")],
        layout: layout("visible"),
      }),
    ).toBe(hidden);
  });

  it("does not retain a tree from a different selected worktree", () => {
    const preview = explorer("preview", "worktree-1");
    const other = explorer("other", "worktree-2");

    expect(
      preferredSidebarExplorer({
        desiredWorktreeId: "worktree-2",
        explorers: [preview, other],
        layout: layout("other"),
      }),
    ).toBeNull();
  });

  it("keeps sidebar files in center panes when a dock is focused", () => {
    const panes = [
      { id: "current-group", region: "center" as const },
      { id: "previous-group", region: "center" as const },
      { id: "right-dock", region: "right" as const },
      { id: "bottom-dock", region: "bottom" as const },
    ];

    expect(
      sidebarFileTargetPaneId({
        activePaneId: "current-group",
        panes,
      }),
    ).toBe("current-group");
    expect(
      sidebarFileTargetPaneId({
        activePaneId: "right-dock",
        panes,
      }),
    ).toBe("current-group");
    expect(
      sidebarFileTargetPaneId({
        activePaneId: "bottom-dock",
        panes,
      }),
    ).toBe("current-group");
  });

  it("only treats layout-backed matching files as pinned", () => {
    const hidden = explorer("hidden", "worktree-1", "src/index.ts");
    const pinned = explorer("pinned", "worktree-1", "src/index.ts");

    expect(
      pinnedExplorerForPath({
        explorers: [hidden, pinned],
        layout: layout("pinned"),
        path: "src/index.ts",
        worktreeId: "worktree-1",
      }),
    ).toBe(pinned);
    expect(tabbedExplorerIds(layout("pinned"))).toEqual(new Set(["pinned"]));
    expect(sidebarFileName("src/index.ts")).toBe("index.ts");
  });

  it("uses the first center pane when the remembered pane no longer exists", () => {
    expect(
      sidebarFileTargetPaneId({
        activePaneId: "removed",
        panes: [
          { id: "dock", region: "right" },
          { id: "center", region: "center" },
        ],
      }),
    ).toBe("center");
  });

  it("does not invent a center target for an empty or dock-only layout", () => {
    expect(
      sidebarFileTargetPaneId({ activePaneId: null, panes: [] }),
    ).toBeNull();
    expect(
      sidebarFileTargetPaneId({
        activePaneId: "dock",
        panes: [{ id: "dock", region: "right" }],
      }),
    ).toBeNull();
  });

  it("scopes connected Explorer tabs to the panes owned by this window", () => {
    const groupedLayout = {
      panes: [
        {
          id: "main-group",
          members: [{ tabId: "main-explorer", tabKind: "explorer" }],
        },
        {
          id: "popout-group",
          members: [{ tabId: "popout-explorer", tabKind: "explorer" }],
        },
      ],
    } as unknown as ProjectTabLayoutSummary;

    expect(tabbedExplorerIds(groupedLayout, new Set(["main-group"]))).toEqual(
      new Set(["main-explorer"]),
    );
    expect(tabbedExplorerIds(groupedLayout, new Set(["popout-group"]))).toEqual(
      new Set(["popout-explorer"]),
    );
    expect(tabbedExplorerIds(groupedLayout, new Set())).toEqual(new Set());
  });

  it("moves a preview path when its file or ancestor folder is renamed", () => {
    expect(moveSidebarPath("src/index.ts", "src", "source")).toBe(
      "source/index.ts",
    );
    expect(moveSidebarPath("README.md", "src", "source")).toBe("README.md");
  });

  it("matches only the mutated entry and paths below it", () => {
    expect(sidebarPathAtOrBelow("src", "src")).toBe(true);
    expect(sidebarPathAtOrBelow("src/app/index.ts", "src")).toBe(true);
    expect(sidebarPathAtOrBelow("source/index.ts", "src")).toBe(false);
  });
});
