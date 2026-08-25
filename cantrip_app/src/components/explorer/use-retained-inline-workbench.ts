import { useEffect, useRef, useState } from "react";

export const INLINE_CODE_WORKBENCH_RETENTION_MS = 30 * 60 * 1_000;

/**
 * Keeps an already-mounted inline workbench authorized while its Explorer is
 * hidden. The caller's worker-encryption binding remains authoritative: a
 * worker, worktree, server, account, or encryption-key change still closes the
 * current binding immediately.
 */
export function useRetainedInlineWorkbench(
  active: boolean,
  retentionMs = INLINE_CODE_WORKBENCH_RETENTION_MS,
  prewarm = false,
  prewarmIdentity = "default",
  owned = false,
): boolean {
  const [retained, setRetained] = useState(active || prewarm || owned);
  const prewarmToken = prewarm ? prewarmIdentity : null;
  const previousPrewarmTokenRef = useRef(prewarmToken);

  useEffect(() => {
    const prewarmActivated =
      prewarmToken !== null && prewarmToken !== previousPrewarmTokenRef.current;
    previousPrewarmTokenRef.current = prewarmToken;
    if (active || owned) {
      setRetained(true);
      return;
    }
    if (prewarmActivated && !retained) {
      setRetained(true);
      return;
    }
    if (!retained) return;

    const timeout = setTimeout(() => setRetained(false), retentionMs);
    return () => clearTimeout(timeout);
  }, [active, owned, prewarmToken, retained, retentionMs]);

  return active || owned || retained;
}
