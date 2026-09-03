import { describe, expect, it } from "vitest";

import {
  githubInboxViewIsAvailable,
  githubInboxViews,
  visibleGithubInboxAttention,
} from "./github-inbox";

describe("GitHub inbox views", () => {
  it("offers pull request attention views only while they are actionable", () => {
    expect(
      githubInboxViews("pull-request", "open").map(({ id }) => id),
    ).toEqual([
      "all",
      "needs-review",
      "failed-checks",
      "merge-conflicts",
      "approved-ready",
      "assigned-to-me",
      "activity",
      "stale",
    ]);
    expect(
      githubInboxViewIsAvailable("needs-review", "pull-request", "closed"),
    ).toBe(false);
    expect(githubInboxViewIsAvailable("failed-checks", "issue", "open")).toBe(
      false,
    );
  });

  it("orders actionable attention before informational state", () => {
    expect(
      visibleGithubInboxAttention({
        number: 42,
        title: "Inbox",
        state: "open",
        url: "https://github.com/ArcaneArts/Cantrip/pull/42",
        author: "octocat",
        commentCount: 0,
        labels: [],
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        closedAt: null,
        kind: "pull-request",
        assignees: ["octocat"],
        attention: ["stale", "assigned", "failed-checks", "unread"],
        pullRequest: {
          draft: false,
          headRef: "feature/inbox",
          baseRef: "main",
          mergeable: "mergeable",
          reviewDecision: "review-required",
          checksState: "failure",
        },
      }),
    ).toEqual(["unread", "failed-checks", "assigned", "stale"]);
  });
});
