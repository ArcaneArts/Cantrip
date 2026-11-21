import { describe, expect, it, vi } from "vitest";
import type { GithubPullRequestDetail } from "@cantrip/protocol";

import {
  buildGitAgentPrompt,
  failedPullRequestChecksEvidence,
} from "../src/git-agent.js";

describe("Git agent context", () => {
  it("collects staged and unstaged evidence with bounded argument arrays", async () => {
    const runner = vi.fn(async (_cwd: string, args: string[]) =>
      args.includes("--cached") ? "staged evidence" : "working evidence",
    );
    const prompt = await buildGitAgentPrompt(
      "/repo",
      {
        task: "draft-commit-message",
        instructions: "Focus on the public API.",
        baseRevision: null,
        headRevision: null,
        pullRequestNumber: null,
      },
      null,
      runner,
    );

    expect(runner).toHaveBeenCalledTimes(5);
    expect(runner.mock.calls).toEqual(
      expect.arrayContaining([
        ["/repo", ["status", "--short", "--branch", "--untracked-files=all"]],
        ["/repo", ["diff", "--cached", "--no-ext-diff", "--unified=3", "--"]],
      ]),
    );
    expect(prompt).toContain("Draft a concise Git commit message");
    expect(prompt).toContain("Focus on the public API.");
    expect(prompt).toContain("untrusted evidence");
    expect(prompt).toContain("staged evidence");
  });

  it("truncates oversized patches before they reach the model", async () => {
    const prompt = await buildGitAgentPrompt(
      "/repo",
      {
        task: "summarize-changes",
        instructions: null,
        baseRevision: null,
        headRevision: null,
        pullRequestNumber: null,
      },
      null,
      async () => "x".repeat(50_000),
    );

    expect(prompt).toContain("[truncated by Cantrip]");
    expect(prompt.length).toBeLessThan(190_000);
  });

  it("collects a bounded commit range with fixed Git argument arrays", async () => {
    const runner = vi.fn(async () => "range evidence");
    const prompt = await buildGitAgentPrompt(
      "/repo",
      {
        task: "review-commit-range",
        instructions: null,
        baseRevision: "origin/main",
        headRevision: "feature/review",
        pullRequestNumber: null,
      },
      null,
      runner,
    );

    expect(runner.mock.calls).toContainEqual([
      "/repo",
      [
        "log",
        "--max-count=200",
        "--format=%H%x09%an%x09%s",
        "origin/main..feature/review",
        "--",
      ],
    ]);
    expect(prompt).toContain("Review the supplied commit range");
    expect(prompt).toContain("origin/main → feature/review");
  });

  it("collects conflict evidence without mutating the repository", async () => {
    const runner = vi.fn(async () => "conflict evidence");
    await buildGitAgentPrompt(
      "/repo",
      {
        task: "explain-conflicts",
        instructions: null,
        baseRevision: null,
        headRevision: null,
        pullRequestNumber: null,
      },
      null,
      runner,
    );

    expect(runner.mock.calls).toContainEqual([
      "/repo",
      ["ls-files", "--unmerged"],
    ]);
    expect(runner.mock.calls.flatMap(([, args]) => args)).not.toContain("add");
  });

  it("includes only failed GitHub checks and preserves their links", () => {
    const evidence = failedPullRequestChecksEvidence({
      number: 42,
      title: "Safer Git reviews",
      headRef: "feature/review",
      headSha: "1".repeat(40),
      baseRef: "main",
      checksTruncated: false,
      checks: [
        {
          id: "failed",
          name: "unit tests",
          source: "check-run",
          status: "completed",
          conclusion: "failure",
          url: "https://github.com/ArcaneArts/Cantrip/actions/runs/1",
          startedAt: null,
          completedAt: null,
          summary: "One assertion failed.",
        },
        {
          id: "passed",
          name: "format",
          source: "check-run",
          status: "completed",
          conclusion: "success",
          url: null,
          startedAt: null,
          completedAt: null,
          summary: "Formatting passed.",
        },
      ],
    } as GithubPullRequestDetail);

    expect(evidence).toContain("unit tests");
    expect(evidence).toContain("actions/runs/1");
    expect(evidence).not.toContain("Formatting passed");
  });
});
