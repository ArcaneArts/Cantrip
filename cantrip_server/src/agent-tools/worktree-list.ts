type WorktreeIdentity = {
  id: string;
  isPrimary: boolean;
};

type WorktreeLease = {
  state: "active" | "suspended" | "delivering" | "released";
  worktreeId: string;
};

export function visibleWorktreeLeases<Lease extends WorktreeLease>(
  worktrees: readonly WorktreeIdentity[],
  leases: readonly Lease[],
  includeHistory: boolean,
): Lease[] {
  if (includeHistory) return [...leases];

  const primaryWorktreeIds = new Set(
    worktrees.filter(({ isPrimary }) => isPrimary).map(({ id }) => id),
  );
  return leases.filter(
    ({ state, worktreeId }) =>
      state !== "released" &&
      (state !== "suspended" || !primaryWorktreeIds.has(worktreeId)),
  );
}
