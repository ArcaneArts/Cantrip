import type { ProjectWorktreeSummary } from "@cantrip/protocol";

/** History belongs to the repository even after its selected checkout is gone. */
export function resolveGitHistoryWorktreeId(
  requestedId: string,
  worktrees: readonly ProjectWorktreeSummary[],
): string {
  const selected = worktrees.find(({ id }) => id === requestedId);
  if (
    selected &&
    (selected.lifecycleState === "ready" ||
      selected.lifecycleState === "creating")
  ) {
    return requestedId;
  }
  const available = worktrees.filter(
    ({ lifecycleState }) => lifecycleState === "ready",
  );
  return (
    available.find(
      ({ isPrimary, projectSourceId }) =>
        isPrimary && projectSourceId === selected?.projectSourceId,
    )?.id ??
    available.find(({ isPrimary, isDefault }) => isPrimary && isDefault)?.id ??
    available.find(({ isPrimary }) => isPrimary)?.id ??
    available.find(({ isDefault }) => isDefault)?.id ??
    available[0]?.id ??
    requestedId
  );
}
