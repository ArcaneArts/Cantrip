import type {
  GitBranchList,
  GitManagedBranch,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  branchActionDescription,
  branchStateLabel,
  filterManagedBranches,
  worktreeCreateInputForBranch,
} from "./git-branch-panel";

function worktree(id: string, branchName: string): ProjectWorktreeSummary {
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
    detached: false,
    locked: false,
    lockReason: null,
    lastScannedAt: null,
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:00:00.000Z",
  };
}

function branch(
  name: string,
  kind: "local" | "remote",
  overrides: Partial<GitManagedBranch> = {},
): GitManagedBranch {
  const hash = kind === "local" ? "a".repeat(40) : "b".repeat(40);
  return {
    name,
    fullRef: kind === "local" ? `refs/heads/${name}` : `refs/remotes/${name}`,
    kind,
    current: false,
    hash,
    upstream: null,
    upstreamGone: false,
    ahead: 0,
    behind: 0,
    mergedIntoHead: false,
    remoteName: kind === "remote" ? name.split("/")[0]! : null,
    remoteAvailable: kind === "remote",
    trackingLocalBranches: [],
    worktree: null,
    lastCommit: {
      hash,
      shortHash: hash.slice(0, 8),
      subject: "Improve branch management",
      authorName: "Cantrip",
      authoredAt: "2026-08-10T12:00:00.000Z",
    },
    ...overrides,
  };
}

describe("Git branch panel helpers", () => {
  it("filters large branch lists by kind, name, upstream, commit, and author", () => {
    const branches = [
      branch("main", "local", { upstream: "origin/main" }),
      branch("feature/search", "local", {
        lastCommit: {
          hash: "c".repeat(40),
          shortHash: "c".repeat(8),
          subject: "Needle commit",
          authorName: "Avery",
          authoredAt: "2026-08-10T12:00:00.000Z",
        },
      }),
      branch("origin/main", "remote"),
    ];
    expect(filterManagedBranches(branches, "local", "origin/main")).toEqual([
      expect.objectContaining({ name: "main" }),
    ]);
    expect(filterManagedBranches(branches, "local", "needle")).toEqual([
      expect.objectContaining({ name: "feature/search" }),
    ]);
    expect(filterManagedBranches(branches, "remote", "main")).toEqual([
      expect.objectContaining({ name: "origin/main" }),
    ]);
  });

  it("makes ownership, tracking, divergence, and destructive actions explicit", () => {
    expect(
      branchStateLabel(
        branch("owned", "local", {
          worktree: { label: "review-lane", current: false },
        }),
      ),
    ).toBe("owned by review-lane");
    expect(
      branchStateLabel(branch("topic", "local", { ahead: 3, behind: 2 })),
    ).toBe("3 ahead · 2 behind");
    expect(
      branchStateLabel(
        branch("origin/topic", "remote", {
          trackingLocalBranches: ["topic"],
        }),
      ),
    ).toBe("tracked by topic");
    expect(
      branchActionDescription({
        type: "deleteRemote",
        remote: "origin",
        name: "topic",
      }),
    ).toContain("origin/topic");
    expect(
      branchActionDescription({
        type: "deleteLocal",
        name: "topic",
        force: true,
      }),
    ).toContain("Force-delete");
  });

  it("creates or derives worktree checkouts without stealing owned branches", () => {
    const local = branch("feature/search", "local");
    const remote = branch("origin/review/fix", "remote", {
      remoteName: "origin",
    });
    const inventory = {
      currentBranch: "main",
      head: "a".repeat(40),
      detached: false,
      defaultRemote: "origin",
      remotes: ["origin"],
      pullStrategy: { mode: "fast-forward-only", description: "ff-only" },
      branches: [branch("main", "local", { current: true }), local, remote],
      truncated: false,
      generatedAt: "2026-08-10T12:00:00.000Z",
    } satisfies GitBranchList;

    expect(worktreeCreateInputForBranch(local, inventory, [])).toEqual({
      name: "search",
      mode: { type: "existingBranch", branch: "feature/search" },
    });
    expect(worktreeCreateInputForBranch(remote, inventory, [])).toEqual({
      name: "fix",
      mode: {
        type: "newBranch",
        branch: "review/fix",
        startPoint: "refs/remotes/origin/review/fix",
      },
    });
    expect(
      worktreeCreateInputForBranch(local, inventory, [
        worktree("feature-lane", "feature/search"),
      ]),
    ).toEqual({
      name: "search",
      mode: {
        type: "newBranch",
        branch: "",
        startPoint: "refs/heads/feature/search",
      },
    });
  });
});
