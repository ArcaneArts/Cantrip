import type {
  GithubPullRequestCheck,
  GithubPullRequestDetail,
  GithubPullRequestFile,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  isFailedPullRequestCheck,
  PullRequestFiles,
  nextUnresolvedReviewThread,
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
      viewed: false,
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

  it("uses a mobile file chooser while retaining the desktop file rail", () => {
    const file = {
      sha: "1".repeat(40),
      path: "src/mobile-responsive.tsx",
      previousPath: null,
      status: "modified",
      additions: 12,
      deletions: 3,
      changes: 15,
      blobUrl:
        "https://github.com/ArcaneArts/Cantrip/blob/main/src/mobile-responsive.tsx",
      rawUrl: null,
      patch: "@@ -1 +1 @@\n-old\n+new",
      patchTruncated: false,
      viewed: true,
    } satisfies GithubPullRequestFile;
    const markup = renderToStaticMarkup(
      createElement(PullRequestFiles, {
        detail: {
          files: [file],
          filesTruncated: false,
        } as GithubPullRequestDetail,
        error: null,
        pending: false,
        onAction: async () => undefined,
      }),
    );

    expect(markup).toContain(">1 files<");
    expect(markup).toContain(file.path);
    expect(markup).toContain("md:hidden");
    expect(markup).toContain("hidden w-72");
    expect(markup).toContain("md:block");
    expect(markup).not.toContain('w-72 shrink-0 overflow-y-auto border-r"');
  });

  it("cycles through unresolved, current review threads", () => {
    const thread = (
      id: string,
      path: string,
      resolved = false,
      outdated = false,
    ) => ({
      id,
      path,
      line: 2,
      side: "RIGHT" as const,
      startLine: null,
      startSide: null,
      resolved,
      outdated,
      viewerCanResolve: true,
      viewerCanUnresolve: false,
      comments: [
        {
          id: Number(id),
          reviewId: 1,
          author: "reviewer",
          body: "Review this",
          url: `https://github.com/example/repo/pull/1#discussion_r${id}`,
          path,
          line: 2,
          side: "RIGHT" as const,
          startLine: null,
          startSide: null,
          diffHunk: "@@ -1 +1 @@",
          inReplyToId: null,
          createdAt: "2026-09-03T12:00:00.000Z",
          updatedAt: "2026-09-03T12:00:00.000Z",
          pending: false,
        },
      ],
    });
    const threads = [
      thread("1", "first.ts"),
      thread("2", "resolved.ts", true),
      thread("3", "outdated.ts", false, true),
      thread("4", "last.ts"),
    ];

    expect(nextUnresolvedReviewThread(null, threads)?.id).toBe("1");
    expect(nextUnresolvedReviewThread("1", threads)?.id).toBe("4");
    expect(nextUnresolvedReviewThread("4", threads)?.id).toBe("1");
  });
});
