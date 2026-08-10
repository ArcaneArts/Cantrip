import { describe, expect, it, vi } from "vitest";

import { buildGitAgentPrompt } from "../src/git-agent.js";

describe("Git agent context", () => {
  it("collects staged and unstaged evidence with bounded argument arrays", async () => {
    const runner = vi.fn(async (_cwd: string, args: string[]) =>
      args.includes("--cached") ? "staged evidence" : "working evidence",
    );
    const prompt = await buildGitAgentPrompt(
      "/repo",
      "draft-commit-message",
      "Focus on the public API.",
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
      "summarize-changes",
      null,
      async () => "x".repeat(50_000),
    );

    expect(prompt).toContain("[truncated by Cantrip]");
    expect(prompt.length).toBeLessThan(190_000);
  });
});
