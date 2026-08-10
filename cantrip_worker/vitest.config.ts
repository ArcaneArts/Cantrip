import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Worker integration tests exercise real Git repositories, PTYs, and
    // filesystem worktrees while the monorepo test command runs packages in
    // parallel. Keep the timeout above transient CI I/O contention without
    // changing production operation timeouts.
    testTimeout: 15_000,
  },
});
