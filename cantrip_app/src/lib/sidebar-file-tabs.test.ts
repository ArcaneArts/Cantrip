import type {
  ExplorerSummary,
  ProjectTabLayoutSummary,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  dedicatedSidebarExplorer,
  dedicatedSidebarExplorers,
  pinnedExplorerForPath,
  preferredSidebarExplorer,
  moveSidebarPath,
  sidebarExplorerCanOwnPreview,
  sidebarExplorerPrewarmTarget,
  sidebarFileName,
  sidebarFilePreviewMatches,
  sidebarFilePreviewIsVisible,
  sidebarFilePreviewViewKey,
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
  it("recognizes an already-active preview without reopening it", () => {
    const preview = {
      active: true,
      explorerId: "explorer-1",
      paneId: "group-1",
      path: "src/index.ts",
      projectId: "project-1",
    };

    expect(sidebarFilePreviewMatches(preview, preview)).toBe(true);
    expect(
      sidebarFilePreviewMatches(preview, {
        ...preview,
        path: "src/other.ts",
      }),
    ).toBe(false);
    expect(
      sidebarFilePreviewMatches({ ...preview, active: false }, preview),
    ).toBe(false);
  });

  it("keeps sidebar workbenches prewarmed through pinning and open tabs", () => {
    const sidebarExplorer = explorer("sidebar", "worktree-1");
    const initial = {
      hasOpenExplorer: false,
      isPopout: false,
      pinInProgress: false,
      sidebarExplorer,
    };

    expect(sidebarExplorerPrewarmTarget(initial)).toBe(sidebarExplorer);
    expect(
      sidebarExplorerPrewarmTarget({ ...initial, pinInProgress: true }),
    ).toBe(sidebarExplorer);
    expect(
      sidebarExplorerPrewarmTarget({ ...initial, hasOpenExplorer: true }),
    ).toBe(sidebarExplorer);
    expect(
      sidebarExplorerPrewarmTarget({ ...initial, isPopout: true }),
    ).toBeNull();
  });

  it("hides an active file preview while a managed screen owns the content area", () => {
    const visible = {
      previewActive: true,
      previewExplorerAvailable: true,
      showImporter: false,
      showProjectSettings: false,
      showServerAdmin: false,
      showSettings: false,
    };

    expect(sidebarFilePreviewIsVisible(visible)).toBe(true);
    for (const managedScreen of [
      "showImporter",
      "showProjectSettings",
      "showServerAdmin",
      "showSettings",
    ] as const) {
      expect(
        sidebarFilePreviewIsVisible({
          ...visible,
          [managedScreen]: true,
        }),
      ).toBe(false);
    }
    expect(
      sidebarFilePreviewIsVisible({
        ...visible,
        previewExplorerAvailable: false,
      }),
    ).toBe(false);
    expect(
      sidebarFilePreviewIsVisible({ ...visible, previewActive: false }),
    ).toBe(false);
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
        previewExplorerId: pinnedFile.id,
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
        previewExplorerId: pinned.id,
      }),
    ).toBeNull();
    expect(
      preferredSidebarExplorer({
        desiredWorktreeId: "worktree-1",
        explorers: [pinned, otherWorktree, replacement],
        layout: tabLayout,
        previewExplorerId: pinned.id,
      }),
    ).toBe(replacement);
  });

  it("blocks stale preview interactions during pin handoff or for a tabbed owner", () => {
    expect(
      sidebarExplorerCanOwnPreview({
        explorerId: "preview",
        layout: layout(),
        pinInProgress: false,
      }),
    ).toBe(true);
    expect(
      sidebarExplorerCanOwnPreview({
        explorerId: "preview",
        layout: layout(),
        pinInProgress: true,
      }),
    ).toBe(false);
    expect(
      sidebarExplorerCanOwnPreview({
        explorerId: "pinned",
        layout: layout("pinned"),
        pinInProgress: false,
      }),
    ).toBe(false);
  });

  it("requires a non-tabbed Explorer for inline sidebar prewarm", () => {
    const visible = explorer("visible", "worktree-1");
    const hidden = explorer("hidden", "worktree-1");

    expect(
      dedicatedSidebarExplorer({
        desiredWorktreeId: "worktree-1",
        explorers: [visible],
        layout: layout("visible"),
      }),
    ).toBeNull();
    expect(
      dedicatedSidebarExplorer({
        desiredWorktreeId: "worktree-1",
        explorers: [visible, hidden],
        layout: layout("visible"),
      }),
    ).toBe(hidden);

    expect(
      dedicatedSidebarExplorers({
        desiredWorktreeId: "worktree-1",
        explorers: [visible, hidden, explorer("second", "worktree-1")],
        layout: layout("visible"),
      }).map(({ id }) => id),
    ).toEqual(["hidden", "second"]);
  });

  it("keeps the preview Explorer stable across worktree selection", () => {
    const preview = explorer("preview", "worktree-1");
    const other = explorer("other", "worktree-2");

    expect(
      preferredSidebarExplorer({
        desiredWorktreeId: "worktree-2",
        explorers: [preview, other],
        layout: layout("other"),
        previewExplorerId: preview.id,
      }),
    ).toBe(preview);
  });

  it("keeps one preview view while its temporary file changes", () => {
    expect(
      sidebarFilePreviewViewKey({
        explorerId: "explorer-1",
        path: "src/first.ts",
      }),
    ).toBe(
      sidebarFilePreviewViewKey({
        explorerId: "explorer-1",
        path: "README.md",
      }),
    );
    expect(
      sidebarFilePreviewViewKey({
        explorerId: "explorer-1",
        path: "src/index.ts",
      }),
    ).not.toBe(
      sidebarFilePreviewViewKey({
        explorerId: "explorer-2",
        path: "src/index.ts",
      }),
    );
  });

  it("places sidebar files in the active pane before a stale preview pane", () => {
    const preview = {
      active: false,
      explorerId: "sidebar-explorer",
      paneId: "previous-group",
      path: "src/previous.ts",
      projectId: "project-1",
    };

    expect(
      sidebarFileTargetPaneId({
        activePaneId: "current-group",
        explorerId: "sidebar-explorer",
        fallbackPaneId: "fallback-group",
        preview,
      }),
    ).toBe("current-group");
    expect(
      sidebarFileTargetPaneId({
        activePaneId: null,
        explorerId: "sidebar-explorer",
        fallbackPaneId: "fallback-group",
        preview,
      }),
    ).toBe("previous-group");
    expect(
      sidebarFileTargetPaneId({
        activePaneId: null,
        explorerId: "other-explorer",
        fallbackPaneId: "fallback-group",
        preview,
      }),
    ).toBe("fallback-group");
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
