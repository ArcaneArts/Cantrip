import type {
  GithubPullRequestCheck,
  GithubPullRequestFile,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  isFailedPullRequestCheck,
  pullRequestCheckLabel,
  pullRequestFileSubtitle,
  mergeCheckedOutWorktree,
} from "./github-pull-request-dialog";

describe("GitHub pull request review presentation", () => {
  it("describes running and completed checks", () => {
    const check = {
      id: "1",
      name: "test",
      source: "check-run",
      status: "in-progress",
      conclusion: null,
      url: null,
      startedAt: null,
      completedAt: null,
      summary: null,
    } satisfies GithubPullRequestCheck;
    expect(pullRequestCheckLabel(check)).toBe("Running");
    expect(
      pullRequestCheckLabel({
        ...check,
        status: "completed",
        conclusion: "timed_out",
      }),
    ).toBe("timed out");
    expect(
      isFailedPullRequestCheck({
        ...check,
        status: "completed",
        conclusion: "timed_out",
      }),
    ).toBe(true);
    expect(
      isFailedPullRequestCheck({
        ...check,
        status: "completed",
        conclusion: "success",
      }),
    ).toBe(false);
  });

  it("includes rename and bounded change stats in file subtitles", () => {
    const file = {
      sha: "1".repeat(40),
      path: "src/new.ts",
      previousPath: "src/old.ts",
      status: "renamed",
      additions: 5,
      deletions: 2,
      changes: 7,
      blobUrl: "https://github.com/ArcaneArts/Cantrip/blob/main/src/new.ts",
      rawUrl: null,
      patch: "@@ -1 +1 @@\n-old\n+new",
      patchTruncated: false,
    } satisfies GithubPullRequestFile;
    expect(pullRequestFileSubtitle(file)).toBe("src/old.ts → renamed · +5 −2");
  });

  it("authoritatively inserts or replaces a checked-out PR worktree", () => {
    const worktree = {
      id: "pr-worktree",
      projectSourceId: "source",
      projectId: "project",
      rootKind: "git-worktree",
      workerId: "worker",
      name: "PR #44 Review",
      path: "/repo/pr-44",
      displayPath: "PR #44 Review",
      isPrimary: false,
      isDefault: false,
      origin: "user",
      lifecycleState: "ready",
      branch: "cantrip/pr/44-review-11111111",
      head: "1".repeat(40),
      detached: false,
      locked: false,
      lockReason: null,
      lastScannedAt: "2026-08-10T12:00:00.000Z",
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:00.000Z",
    } satisfies ProjectWorktreeSummary;
    expect(mergeCheckedOutWorktree([], worktree)).toEqual([worktree]);
    expect(
      mergeCheckedOutWorktree([{ ...worktree, name: "Stale" }], worktree),
    ).toEqual([worktree]);
  });
});
