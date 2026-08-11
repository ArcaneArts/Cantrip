import { describe, expect, it } from "vitest";

import {
  DEFAULT_GIT_HISTORY_DRAWER_WIDTH,
  MAX_GIT_HISTORY_DRAWER_WIDTH,
  MIN_GIT_HISTORY_DRAWER_WIDTH,
  clampGitHistoryDrawerWidth,
  gitHistoryDrawerWidthFromKey,
  gitHistoryDrawerWidthFromPointer,
  toggleGitHistoryToolDrawer,
  type GitHistoryDrawer,
} from "./git-history-drawer";

describe("Git History drawer", () => {
  it("replaces the current drawer and toggles the active tool closed", () => {
    const commit = {
      kind: "commit",
      revision: "abc123",
    } satisfies GitHistoryDrawer;

    expect(toggleGitHistoryToolDrawer(commit, "operations")).toEqual({
      kind: "operations",
    });
    expect(
      toggleGitHistoryToolDrawer({ kind: "operations" }, "repository"),
    ).toEqual({ kind: "repository" });
    expect(
      toggleGitHistoryToolDrawer({ kind: "repository" }, "repository"),
    ).toBeNull();
  });

  it("clamps pointer resizing from the drawer's left edge", () => {
    expect(gitHistoryDrawerWidthFromPointer(600, 1_400)).toBe(800);
    expect(gitHistoryDrawerWidthFromPointer(1_300, 1_400)).toBe(
      MIN_GIT_HISTORY_DRAWER_WIDTH,
    );
    expect(gitHistoryDrawerWidthFromPointer(-100, 1_400)).toBe(
      MAX_GIT_HISTORY_DRAWER_WIDTH,
    );
    expect(clampGitHistoryDrawerWidth(Number.NaN)).toBe(
      DEFAULT_GIT_HISTORY_DRAWER_WIDTH,
    );
  });

  it("supports accessible keyboard resizing", () => {
    expect(gitHistoryDrawerWidthFromKey(600, "ArrowLeft")).toBe(616);
    expect(gitHistoryDrawerWidthFromKey(600, "ArrowRight")).toBe(584);
    expect(gitHistoryDrawerWidthFromKey(600, "Home")).toBe(
      MIN_GIT_HISTORY_DRAWER_WIDTH,
    );
    expect(gitHistoryDrawerWidthFromKey(600, "End")).toBe(
      MAX_GIT_HISTORY_DRAWER_WIDTH,
    );
    expect(gitHistoryDrawerWidthFromKey(600, "Enter")).toBeNull();
  });
});
