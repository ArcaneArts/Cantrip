import type {
  GithubPullRequestCheck,
  GithubPullRequestFile,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  pullRequestCheckLabel,
  pullRequestFileSubtitle,
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
});
