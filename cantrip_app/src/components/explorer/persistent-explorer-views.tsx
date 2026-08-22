import type {
  ExplorerEntry,
  ExplorerSummary,
  GitStatus,
} from "@cantrip/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ExplorerView,
  type ExplorerHeaderState,
  type ExplorerLifecycleActions,
} from "@/components/explorer/explorer-view";

export const MAX_RETAINED_EXPLORER_VIEWS = 8;

export function retainExplorerSurfaceTabs(
  retained: ExplorerSummary[],
  active: ExplorerSummary,
  dirtyIds: ReadonlySet<string> = new Set(),
  limit = MAX_RETAINED_EXPLORER_VIEWS,
): ExplorerSummary[] {
  const next = [
    ...retained.filter((explorer) => explorer.id !== active.id),
    active,
  ];
  let excess = next.length - Math.max(1, limit);
  if (excess <= 0) return next;
  return next.filter((explorer) => {
    if (excess > 0 && explorer.id !== active.id && !dirtyIds.has(explorer.id)) {
      excess -= 1;
      return false;
    }
    return true;
  });
}

export function PersistentExplorerViews({
  activeExplorer,
  gitStatuses,
  onChanged,
  onHeaderChange,
  onLifecycleChange,
  onOpenFile,
  onOpenTerminal,
  repositoryGraphAvailable,
}: {
  activeExplorer: ExplorerSummary | null;
  gitStatuses: Readonly<Record<string, GitStatus | undefined>>;
  onChanged?(explorer: ExplorerSummary): void;
  onHeaderChange?(state: ExplorerHeaderState | null): void;
  onLifecycleChange?(
    explorerId: string,
    actions: ExplorerLifecycleActions | null,
  ): void;
  onOpenFile?(
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
  ): void | Promise<void>;
  onOpenTerminal?(explorer: ExplorerSummary, entry: ExplorerEntry): void;
  repositoryGraphAvailable: boolean;
}) {
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [retainedExplorers, setRetainedExplorers] = useState<ExplorerSummary[]>(
    [],
  );

  useEffect(() => {
    if (!activeExplorer) return;
    setRetainedExplorers((current) =>
      retainExplorerSurfaceTabs(current, activeExplorer, dirtyIds),
    );
  }, [activeExplorer, dirtyIds]);

  const renderedExplorers = useMemo(
    () =>
      activeExplorer
        ? retainExplorerSurfaceTabs(retainedExplorers, activeExplorer, dirtyIds)
        : retainedExplorers,
    [activeExplorer, dirtyIds, retainedExplorers],
  );

  const handleLifecycleChange = useCallback(
    (explorerId: string, actions: ExplorerLifecycleActions | null) => {
      setDirtyIds((current) => {
        const nextDirty = actions?.dirty ?? false;
        if (current.has(explorerId) === nextDirty) return current;
        const next = new Set(current);
        if (nextDirty) next.add(explorerId);
        else next.delete(explorerId);
        return next;
      });
      onLifecycleChange?.(explorerId, actions);
    },
    [onLifecycleChange],
  );

  return renderedExplorers.map((explorer) => {
    const active = activeExplorer?.id === explorer.id;
    return (
      <ExplorerView
        active={active}
        explorer={explorer}
        gitStatus={gitStatuses[explorer.worktreeId]}
        key={explorer.id}
        onChanged={onChanged}
        onHeaderChange={active ? onHeaderChange : undefined}
        onLifecycleChange={handleLifecycleChange}
        onOpenFile={onOpenFile}
        onOpenTerminal={onOpenTerminal}
        repositoryGraphAvailable={repositoryGraphAvailable}
      />
    );
  });
}
