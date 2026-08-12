import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A production build compiles colocated and integration tests into dist.
    // Restrict discovery to source inputs so a local build cannot make Vitest
    // execute stale JavaScript copies alongside the TypeScript suite.
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Worker integration tests exercise real Git repositories, PTYs, and
    // filesystem worktrees while the monorepo test command runs packages in
    // parallel. Keep the timeout above transient CI I/O contention without
    // changing production operation timeouts.
    testTimeout: 15_000,
  },
});
