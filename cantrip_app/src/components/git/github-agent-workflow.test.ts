import { describe, expect, it } from "vitest";

import {
  issueAgentWorkflowDraft,
  mergeGithubAgentDraft,
  pullRequestAgentWorkflowDraft,
} from "./github-agent-workflow";

describe("GitHub agent workflow drafts", () => {
  it("preserves an existing reviewed draft when adding another task", () => {
    expect(mergeGithubAgentDraft("Keep this note", "New task")).toBe(
      "Keep this note\n\n---\n\nNew task",
    );
  });

  it("creates a safe deterministic issue branch and review draft", () => {
    const result = issueAgentWorkflowDraft(
      {
        number: 42,
        title: "Fix spaces & Unicode ⚡ in startup",
        state: "open",
        url: "https://github.com/acme/repo/issues/42",
        author: "octocat",
        commentCount: 1,
        labels: [],
        assignees: [],
        milestone: null,
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
        closedAt: null,
        body: "Please fix it.",
        comments: [
          {
            id: "1",
            author: "reviewer",
            body: "Reproduction details",
            createdAt: "2026-09-03T00:00:00.000Z",
            updatedAt: "2026-09-03T00:00:00.000Z",
            url: "https://github.com/acme/repo/issues/42#issuecomment-1",
          },
        ],
      },
      "a".repeat(40),
    );

    expect(result.branch).toBe(
      "cantrip/issue-42-fix-spaces-unicode-in-startup",
    );
    expect(result.prompt).toContain(`Exact starting commit: ${"a".repeat(40)}`);
    expect(result.prompt).toContain("Do not push, merge, close the item");
    expect(result.prompt).toContain("@reviewer");
  });

  it("includes failed logs and exact PR identity without auto-publishing", () => {
    const prompt = pullRequestAgentWorkflowDraft({
      intent: "fix-checks",
      pullRequest: {
        number: 8,
        title: "Repair CI",
        state: "open",
        url: "https://github.com/acme/repo/pull/8",
        author: "octocat",
        commentCount: 0,
        labels: [],
        assignees: [],
        milestone: null,
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
        closedAt: null,
        body: "PR body",
        nodeId: "PR_8",
        viewerLogin: "reviewer",
        pendingReview: null,
        autoMerge: null,
        mergeQueueEnabled: false,
        mergeQueueEntry: null,
        draft: false,
        merged: false,
        headRef: "feature",
        headSha: "b".repeat(40),
        baseRef: "main",
        baseSha: "a".repeat(40),
        comments: [],
        commentsTruncated: false,
        requestedReviewers: [],
        mergeable: true,
        mergeableState: "clean",
        reviewDecision: "none",
        checksState: "failure",
        additions: 1,
        deletions: 0,
        changedFileCount: 1,
        commitCount: 1,
        commits: [],
        commitsTruncated: false,
        files: [],
        filesTruncated: false,
        checks: [],
        checksTruncated: false,
        reviews: [],
        reviewsTruncated: false,
        reviewThreads: [],
        reviewThreadsTruncated: false,
        warnings: [],
      },
      activeReviewThreads: [],
      failedChecks: [
        {
          checkId: "99",
          name: "test",
          url: "https://github.com/acme/repo/actions/runs/12/job/13",
          summary: "One test failed",
          logExcerpt: "FAIL expected true",
          logUnavailableReason: null,
        },
      ],
    }).prompt;

    expect(prompt).toContain(`Exact pull-request head: ${"b".repeat(40)}`);
    expect(prompt).toContain("FAIL expected true");
    expect(prompt).toContain("Do not publish or merge anything");
  });
});
