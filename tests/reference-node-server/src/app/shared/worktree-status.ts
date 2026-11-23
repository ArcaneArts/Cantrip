import {
  worktreeStatusResultSchema,
  type GitStatus,
  type ProjectWorktreeSummary,
  type WorktreeStatusResult,
} from "@cantrip/protocol";

export function worktreeStatusFromGitStatus(
  worktree: ProjectWorktreeSummary,
  status: GitStatus,
): WorktreeStatusResult {
  return worktreeStatusResultSchema.parse({
    worktree: {
      path: worktree.path,
      head: status.head,
      branch: status.branch || null,
      detached: !status.branch,
      isPrimary: worktree.isPrimary,
      managed: !worktree.isPrimary && worktree.origin !== "external",
      locked: worktree.locked,
      lockReason: worktree.lockReason,
      prunable: worktree.lifecycleState === "prunable",
      pruneReason: null,
      missing: worktree.lifecycleState === "missing",
    },
    status,
  });
}
