import type { GithubPullRequestLifecyclePreview } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  lifecycleConfirmationMatches,
  pullRequestLifecycleLabel,
} from "./github-pull-request-lifecycle-dialog";

const preview: GithubPullRequestLifecyclePreview = {
  action: {
    type: "merge",
    method: "squash",
    commitTitle: null,
    commitMessage: null,
  },
  number: 44,
  title: "Lifecycle",
  state: "open",
  draft: false,
  headRef: "feature/lifecycle",
  headSha: "1".repeat(40),
  baseRef: "main",
  baseSha: "2".repeat(40),
  mergeable: true,
  mergeableState: "clean",
  checksState: "success",
  reviewDecision: "approved",
  destructive: true,
  confirmationPhrase: "squash #44",
  warnings: [],
  token: "3".repeat(64),
};

describe("pull request lifecycle confirmation", () => {
  it("labels every lifecycle action precisely", () => {
    expect(pullRequestLifecycleLabel({ type: "close" })).toBe(
      "Close pull request",
    );
    expect(pullRequestLifecycleLabel({ type: "mark-ready" })).toBe(
      "Mark ready for review",
    );
    expect(pullRequestLifecycleLabel({ type: "convert-draft" })).toBe(
      "Convert pull request to draft",
    );
    expect(pullRequestLifecycleLabel({ type: "update-branch" })).toBe(
      "Update pull request branch",
    );
    expect(
      pullRequestLifecycleLabel({
        type: "enable-auto-merge",
        method: "squash",
        commitTitle: null,
        commitMessage: null,
      }),
    ).toBe("Enable auto-merge");
    expect(pullRequestLifecycleLabel({ type: "enqueue-merge-queue" })).toBe(
      "Enter merge queue",
    );
    expect(pullRequestLifecycleLabel(preview.action)).toBe(
      "Squash pull request",
    );
  });

  it("requires the exact destructive confirmation phrase", () => {
    expect(lifecycleConfirmationMatches(preview, "squash #44")).toBe(true);
    expect(lifecycleConfirmationMatches(preview, "merge #44")).toBe(false);
    expect(
      lifecycleConfirmationMatches(
        { ...preview, confirmationPhrase: null, destructive: false },
        "",
      ),
    ).toBe(true);
  });
});
