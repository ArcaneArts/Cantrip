import type { GitStatus, ProjectWorktreeSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { worktreeHasConflicts, worktreeTooltip } from "./worktree-control";

const worktree: ProjectWorktreeSummary = {
  id: "worktree-2",
  projectSourceId: "source-1",
  projectId: "project-1",
  workerId: "worker-1",
  name: "Fix auth",
  path: "/managed/worktrees/fix-auth",
  displayPath: "worktrees/fix-auth",
  isPrimary: false,
  isDefault: false,
  origin: "agent",
  lifecycleState: "ready",
  branch: "agent/manual/fix-auth",
  head: "0123456789abcdef",
  detached: false,
  locked: false,
  lockReason: null,
  lastScannedAt: "2026-08-08T12:00:00.000Z",
  createdAt: "2026-08-08T12:00:00.000Z",
  updatedAt: "2026-08-08T12:00:00.000Z",
};

const cleanStatus: GitStatus = {
  branch: "agent/manual/fix-auth",
  head: "0123456789abcdef",
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [],
  branches: [],
};

describe("worktree presentation", () => {
  it("describes the checkout, worker, state, path, and lease", () => {
    expect(
      worktreeTooltip({
        worktree,
        workerName: "Local Worker",
        online: true,
        status: cleanStatus,
        leaseOwner: "Fix auth chat",
      }),
    ).toBe(
      "Fix auth\nagent/manual/fix-auth\nLocal Worker\nClean\nworktrees/fix-auth\nLease: Fix auth chat",
    );
  });

  it("distinguishes conflicts from ordinary dirty state", () => {
    const status: GitStatus = {
      ...cleanStatus,
      files: [
        {
          path: "src/auth.ts",
          originalPath: null,
          indexStatus: "U",
          worktreeStatus: "U",
          staged: true,
          unstaged: true,
        },
      ],
    };
    expect(worktreeHasConflicts(status)).toBe(true);
    expect(
      worktreeTooltip({
        worktree,
        workerName: "Local Worker",
        online: true,
        status,
      }),
    ).toContain("Conflicts");
  });
});
