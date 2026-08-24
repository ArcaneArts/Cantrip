import { useEffect, useState } from "react";

export const INLINE_CODE_WORKBENCH_RETENTION_MS = 15 * 60 * 1_000;

/**
 * Keeps an already-mounted inline workbench authorized while its Explorer is
 * hidden. The caller's worker-encryption binding remains authoritative: a
 * worker, worktree, server, account, or encryption-key change still closes the
 * current binding immediately.
 */
export function useRetainedInlineWorkbench(
  active: boolean,
  retentionMs = INLINE_CODE_WORKBENCH_RETENTION_MS,
): boolean {
  const [retained, setRetained] = useState(active);

  useEffect(() => {
    if (active) {
      setRetained(true);
      return;
    }
    if (!retained) return;

    const timeout = setTimeout(() => setRetained(false), retentionMs);
    return () => clearTimeout(timeout);
  }, [active, retained, retentionMs]);

  return active || retained;
}
