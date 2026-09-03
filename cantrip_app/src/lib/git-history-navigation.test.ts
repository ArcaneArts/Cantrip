import { describe, expect, it } from "vitest";

import {
  defaultGitHistoryOptions,
  gitHistoryRouteSearch,
  parseGitHistoryRoute,
} from "./git-history-navigation";

describe("Git History navigation", () => {
  it("round-trips selected commits, comparisons, files, and filters", () => {
    const search = gitHistoryRouteSearch("?unrelated=kept", {
      projectId: "project-1",
      worktreeId: "worktree-1",
      commit: null,
      selectedCommits: ["c".repeat(40), "d".repeat(40)],
      comparison: {
        left: "a".repeat(40),
        right: "b".repeat(40),
        mode: "merge-base",
      },
      filePath: "src/app.ts",
      options: {
        filters: {
          ...defaultGitHistoryOptions.filters,
          author: "Dev <dev@example.test>",
          branch: "origin/main",
          path: "src/app.ts",
        },
        firstParent: true,
        hideMerges: true,
      },
    });

    expect(parseGitHistoryRoute(search)).toEqual({
      projectId: "project-1",
      worktreeId: "worktree-1",
      commit: null,
      selectedCommits: ["c".repeat(40), "d".repeat(40)],
      comparison: {
        left: "a".repeat(40),
        right: "b".repeat(40),
        mode: "merge-base",
      },
      filePath: "src/app.ts",
      options: {
        filters: {
          ...defaultGitHistoryOptions.filters,
          author: "Dev <dev@example.test>",
          branch: "origin/main",
          path: "src/app.ts",
        },
        firstParent: true,
        hideMerges: true,
      },
    });
    expect(search).toContain("unrelated=kept");
  });
});
