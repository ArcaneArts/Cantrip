import type {
  GitBranchList,
  GitManagedBranch,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";

export interface GitWorktreeCleanupPlan {
  branches: GitManagedBranch[];
  mergedWorktrees: ProjectWorktreeSummary[];
  staleWorktrees: ProjectWorktreeSummary[];
}

export function planGitWorktreeCleanup(
  inventory: GitBranchList,
  worktrees: readonly ProjectWorktreeSummary[],
): GitWorktreeCleanupPlan {
  const mergedBranchNames = new Set(
    inventory.branches
      .filter(
        ({ current, kind, mergedIntoHead }) =>
          kind === "local" && !current && mergedIntoHead === true,
      )
      .map(({ name }) => name),
  );
  const staleWorktrees = worktrees.filter(
    (worktree) =>
      !worktree.isPrimary &&
      worktree.origin !== "external" &&
      ["missing", "prunable"].includes(worktree.lifecycleState),
  );
  const mergedWorktrees = worktrees.filter(
    (worktree) =>
      !worktree.isPrimary &&
      worktree.origin !== "external" &&
      worktree.lifecycleState === "ready" &&
      Boolean(worktree.branch && mergedBranchNames.has(worktree.branch)),
  );
  const removableWorktreeBranches = new Set(
    mergedWorktrees.flatMap(({ branch }) => (branch ? [branch] : [])),
  );
  const branches = inventory.branches.filter((branch) => {
    if (
      branch.kind !== "local" ||
      branch.current ||
      branch.mergedIntoHead !== true
    ) {
      return false;
    }
    const owner = worktrees.find(
      (worktree) => !worktree.detached && worktree.branch === branch.name,
    );
    return !owner || removableWorktreeBranches.has(branch.name);
  });
  return { branches, mergedWorktrees, staleWorktrees };
}
