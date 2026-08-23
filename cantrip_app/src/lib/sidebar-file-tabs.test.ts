import type {
  ExplorerSummary,
  ProjectTabLayoutSummary,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  pinnedExplorerForPath,
  preferredSidebarExplorer,
  moveSidebarPath,
  sidebarFileName,
  sidebarFilePreviewViewKey,
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
    groups: [
      {
        members: explorerIds.map((id) => ({
          tabId: id,
          tabKind: "explorer",
        })),
      },
    ],
  } as ProjectTabLayoutSummary;
}

describe("sidebar file tabs", () => {
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
