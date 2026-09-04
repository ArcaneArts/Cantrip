import { useCallback, useState } from "react";

export type DetachedDesktopPaneClaim = {
  explorerId: string | null;
  phase: "detaching" | "detached";
  projectId: string;
};

export function useDetachedDesktopPaneState() {
  const [claims, setClaims] = useState<
    ReadonlyMap<string, DetachedDesktopPaneClaim>
  >(() => new Map());
  const [inspectedPaneIds, setInspectedPaneIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const claimPane = useCallback(
    (paneId: string, projectId: string, explorerId: string | null) => {
      setClaims((current) => {
        const next = new Map(current);
        next.set(paneId, { explorerId, phase: "detaching", projectId });
        return next;
      });
      setInspectedPaneIds((current) => new Set(current).add(paneId));
    },
    [],
  );
  const completePaneClaim = useCallback((paneId: string) => {
    setClaims((current) => {
      const claim = current.get(paneId);
      if (!claim || claim.phase === "detached") return current;
      const next = new Map(current);
      next.set(paneId, { ...claim, phase: "detached" });
      return next;
    });
  }, []);
  const releasePane = useCallback((paneId: string) => {
    setClaims((current) => {
      if (!current.has(paneId)) return current;
      const next = new Map(current);
      next.delete(paneId);
      return next;
    });
    setInspectedPaneIds((current) => new Set(current).add(paneId));
  }, []);
  const reconcileDiscovery = useCallback(
    (
      projectId: string,
      paneIds: readonly string[],
      discoveredPaneIds: ReadonlySet<string>,
    ) => {
      setClaims((current) => {
        const next = new Map(current);
        for (const paneId of discoveredPaneIds) {
          if (!next.has(paneId)) {
            next.set(paneId, {
              explorerId: null,
              phase: "detached",
              projectId,
            });
          }
        }
        return next;
      });
      setInspectedPaneIds((current) => new Set([...current, ...paneIds]));
    },
    [],
  );
  return {
    claimPane,
    claims,
    completePaneClaim,
    inspectedPaneIds,
    ownedPaneIds: new Set(claims.keys()),
    reconcileDiscovery,
    releasePane,
  } as const;
}

export type DetachedDesktopPaneState = ReturnType<
  typeof useDetachedDesktopPaneState
>;
