import { useEffect, useState } from "react";

export const INLINE_CODE_WORKBENCH_RETENTION_MS = 30 * 60 * 1_000;

/**
 * Keeps an already-mounted inline workbench authorized while its Explorer is
 * hidden. The caller's worker-encryption binding remains authoritative: a
 * worker, worktree, server, account, or encryption-key change still closes the
 * current binding immediately.
 */
export function useRetainedInlineWorkbench(
  active: boolean,
  identity: string,
  owned = false,
  retentionMs = INLINE_CODE_WORKBENCH_RETENTION_MS,
): boolean {
  const [lease, setLease] = useState({ identity, retained: active });
  const retained = lease.identity === identity && lease.retained;

  useEffect(() => {
    if (lease.identity !== identity) {
      setLease({ identity, retained: active });
      return;
    }
    if (active) {
      if (!retained) setLease({ identity, retained: true });
      return;
    }
    if (!retained || owned) return;

    const timeout = setTimeout(
      () => setLease({ identity, retained: false }),
      retentionMs,
    );
    return () => clearTimeout(timeout);
  }, [active, identity, lease.identity, owned, retained, retentionMs]);

  return active || retained;
}
