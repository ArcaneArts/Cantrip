import type {
  GitManagedBranch,
  GitStatus,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  compactWorktreePath,
  worktreeExistingBranchOptions,
  worktreeHasConflicts,
  worktreeSwitchBranchOptions,
  worktreeTooltip,
} from "./worktree-control";

const worktree: ProjectWorktreeSummary = {
  id: "worktree-2",
  projectSourceId: "source-1",
  projectId: "project-1",
  rootKind: "git-worktree",
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

function branch(
  name: string,
  kind: GitManagedBranch["kind"],
): GitManagedBranch {
  return {
    name,
    fullRef: `refs/${kind === "local" ? "heads" : "remotes/origin"}/${name}`,
    kind,
    current: false,
    hash: "a".repeat(40),
    upstream: null,
    upstreamGone: false,
    ahead: 0,
    behind: 0,
    mergedIntoHead: null,
    remoteName: kind === "remote" ? "origin" : null,
    remoteAvailable: kind === "remote",
    trackingLocalBranches: [],
    worktree: null,
    lastCommit: {
      hash: "a".repeat(40),
      shortHash: "aaaaaaa",
      subject: "Test",
      authorName: "Cantrip",
      authoredAt: "2026-08-19T00:00:00.000Z",
    },
  };
}

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

describe("worktree existing branch options", () => {
  it("offers sorted local branches without duplicating remote refs", () => {
    expect(
      worktreeExistingBranchOptions([
        branch("topic/zeta", "local"),
        branch("main", "remote"),
        branch("main", "local"),
      ]).map(({ name }) => name),
    ).toEqual(["main", "topic/zeta"]);
  });
});

describe("worktree switcher presentation", () => {
  it("compacts long POSIX and Windows paths to their useful tail", () => {
    expect(
      compactWorktreePath(
        "/Users/me/Library/Application Support/art.cantrip/repositories/Cantrip",
      ),
    ).toBe("…/art.cantrip/repositories/Cantrip");
    expect(compactWorktreePath("Z:\\workers\\Org\\Cantrip", 2)).toBe(
      "…\\Org\\Cantrip",
    );
    expect(compactWorktreePath("worktrees/fix-auth")).toBe(
      "worktrees/fix-auth",
    );
  });

  it("puts the current branch first, followed by local then remote branches", () => {
    const remote = branch("main", "remote");
    const topic = branch("topic/zeta", "local");
    const current = { ...branch("main", "local"), current: true };
    expect(
      worktreeSwitchBranchOptions([remote, topic, current]).map(
        ({ fullRef }) => fullRef,
      ),
    ).toEqual([current.fullRef, topic.fullRef, remote.fullRef]);
  });
});
