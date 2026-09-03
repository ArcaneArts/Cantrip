import type {
  GitBranchList,
  GitManagedBranch,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { planGitWorktreeCleanup } from "./git-worktree-cleanup";

function branch(
  name: string,
  overrides: Partial<GitManagedBranch> = {},
): GitManagedBranch {
  return {
    name,
    fullRef: `refs/heads/${name}`,
    kind: "local",
    current: false,
    hash: "a".repeat(40),
    upstream: null,
    upstreamGone: false,
    ahead: 0,
    behind: 0,
    mergedIntoHead: true,
    remoteName: null,
    remoteAvailable: false,
    trackingLocalBranches: [],
    worktree: null,
    lastCommit: {
      hash: "a".repeat(40),
      shortHash: "a".repeat(8),
      subject: name,
      authorName: "Cantrip",
      authoredAt: "2026-08-10T12:00:00.000Z",
    },
    ...overrides,
  };
}

function worktree(
  id: string,
  branchName: string | null,
  overrides: Partial<ProjectWorktreeSummary> = {},
): ProjectWorktreeSummary {
  return {
    id,
    projectSourceId: "source-one",
    projectId: "project-one",
    rootKind: "git-worktree",
    workerId: "worker-one",
    name: id,
    path: `/tmp/${id}`,
    displayPath: `/tmp/${id}`,
    isPrimary: id === "primary",
    isDefault: id === "primary",
    origin: "cantrip",
    lifecycleState: "ready",
    branch: branchName,
    head: "a".repeat(40),
    detached: branchName === null,
    locked: false,
    lockReason: null,
    lastScannedAt: null,
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:00:00.000Z",
    ...overrides,
  };
}

describe("Git worktree cleanup planning", () => {
  it("pairs merged branches with removable worktrees and excludes unsafe ownership", () => {
    const inventory = {
      currentBranch: "main",
      head: "a".repeat(40),
      detached: false,
      defaultRemote: "origin",
      remotes: ["origin"],
      pullStrategy: { mode: "fast-forward-only", description: "ff-only" },
      branches: [
        branch("main", { current: true }),
        branch("merged"),
        branch("standalone"),
        branch("unmerged", { mergedIntoHead: false }),
        branch("external"),
      ],
      truncated: false,
      generatedAt: "2026-08-10T12:00:00.000Z",
    } satisfies GitBranchList;
    const plan = planGitWorktreeCleanup(inventory, [
      worktree("primary", "main"),
      worktree("merged-lane", "merged"),
      worktree("unmerged-lane", "unmerged"),
      worktree("external-lane", "external", { origin: "external" }),
      worktree("stale-lane", "stale", { lifecycleState: "prunable" }),
    ]);

    expect(plan.mergedWorktrees.map(({ id }) => id)).toEqual(["merged-lane"]);
    expect(plan.staleWorktrees.map(({ id }) => id)).toEqual(["stale-lane"]);
    expect(plan.branches.map(({ name }) => name)).toEqual([
      "merged",
      "standalone",
    ]);
  });
});
