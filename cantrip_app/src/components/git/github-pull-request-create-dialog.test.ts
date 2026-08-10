import type { GitStatus } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  parseLinkedIssueNumbers,
  parsePullRequestCsv,
  pullRequestBranchChoices,
} from "./github-pull-request-create-dialog";

const status: GitStatus = {
  branch: "feature/pull-requests",
  head: "1".repeat(40),
  upstream: "origin/feature/pull-requests",
  ahead: 0,
  behind: 0,
  files: [],
  branches: [
    {
      name: "feature/pull-requests",
      kind: "local",
      current: true,
      hash: "1".repeat(40),
      upstream: "origin/feature/pull-requests",
    },
    {
      name: "release",
      kind: "local",
      current: false,
      hash: "2".repeat(40),
      upstream: null,
    },
    {
      name: "origin/main",
      kind: "remote",
      current: false,
      hash: "3".repeat(40),
      upstream: null,
    },
  ],
};

describe("GitHub pull request creation helpers", () => {
  it("normalizes comma-separated labels and reviewers", () => {
    expect(parsePullRequestCsv(" feature, needs-review, feature,  ")).toEqual([
      "feature",
      "needs-review",
    ]);
  });

  it("parses and deduplicates linked issue numbers", () => {
    expect(parseLinkedIssueNumbers("#42, 7, #42")).toEqual([42, 7]);
    expect(parseLinkedIssueNumbers("#42, invalid")).toBeNull();
  });

  it("selects the current local branch as head and main as base", () => {
    expect(pullRequestBranchChoices(status)).toEqual({
      bases: ["feature/pull-requests", "release", "main"],
      heads: ["feature/pull-requests", "release"],
      initialBase: "main",
      initialHead: "feature/pull-requests",
    });
  });
});
