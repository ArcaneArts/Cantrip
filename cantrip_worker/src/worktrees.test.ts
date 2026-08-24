import { describe, expect, it } from "vitest";

import { worktreeWatchEventTouchesFiles } from "./worktrees.js";

describe("worktree filesystem observation", () => {
  it("distinguishes project files from private Git metadata", () => {
    expect(worktreeWatchEventTouchesFiles("src/index.ts")).toBe(true);
    expect(worktreeWatchEventTouchesFiles(".gitignore")).toBe(true);
    expect(worktreeWatchEventTouchesFiles(null)).toBe(true);
    expect(worktreeWatchEventTouchesFiles(".git")).toBe(false);
    expect(worktreeWatchEventTouchesFiles(".git/HEAD")).toBe(false);
    expect(worktreeWatchEventTouchesFiles(".git\\index")).toBe(false);
  });
});
