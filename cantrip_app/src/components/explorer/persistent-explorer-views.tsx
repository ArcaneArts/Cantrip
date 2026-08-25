import type {
  CodeAppearance,
  ExplorerEntry,
  ExplorerSummary,
  GitStatus,
} from "@cantrip/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ExplorerView,
  type ExplorerGraphRequest,
  type ExplorerHeaderState,
  type ExplorerLifecycleActions,
  type TransientExplorerFile,
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

export function retainRequestedExplorerSurfaceTabs(
  retained: ExplorerSummary[],
  active: ExplorerSummary | null,
  prewarm: ExplorerSummary | null | undefined,
  dirtyIds: ReadonlySet<string>,
  protectedIds: ReadonlySet<string> = new Set(),
): ExplorerSummary[] {
  const requested = [prewarm, active].filter(
    (explorer): explorer is ExplorerSummary =>
      explorer !== null && explorer !== undefined,
  );
  const requestedIds = new Set(requested.map((explorer) => explorer.id));
  const retainedProtectionIds = new Set([...protectedIds, ...requestedIds]);
  const next = [
    ...retained.filter((explorer) => !requestedIds.has(explorer.id)),
    ...requested.filter(
      (explorer, index) =>
        requested.findIndex((candidate) => candidate.id === explorer.id) ===
        index,
    ),
  ];
  let excess = next.length - MAX_RETAINED_EXPLORER_VIEWS;
  if (excess <= 0) return next;
  return next.filter((explorer) => {
    if (
      excess > 0 &&
      !retainedProtectionIds.has(explorer.id) &&
      !dirtyIds.has(explorer.id)
    ) {
      excess -= 1;
      return false;
    }
    return true;
  });
}

export function ownedExplorerSurfaceTabs(
  openExplorers: readonly ExplorerSummary[],
  active: ExplorerSummary | null,
  prewarm: ExplorerSummary | null | undefined,
  handoff?: ExplorerSummary | null,
): ExplorerSummary[] {
  const owned: ExplorerSummary[] = [];
  const indexById = new Map<string, number>();
  for (const explorer of [...openExplorers, prewarm, handoff, active]) {
    if (!explorer) continue;
    const existingIndex = indexById.get(explorer.id);
    if (existingIndex === undefined) {
      indexById.set(explorer.id, owned.length);
      owned.push(explorer);
    } else {
      owned[existingIndex] = explorer;
    }
  }
  return owned;
}

export function PersistentExplorerViews({
  activeExplorer,
  transientFile,
  appearance,
  graphRequest,
  gitStatuses,
  handoffExplorer,
  onlineWorkerIds,
  onChanged,
  onHeaderChange,
  onInlineCodeReady,
  onLifecycleChange,
  onTransientLifecycleChange,
  onOpenFile,
  onRevealFolder,
  revealLabel,
  onOpenTerminal,
  openExplorers,
  prewarmExplorer,
  repositoryGraphAvailable,
}: {
  activeExplorer: ExplorerSummary | null;
  transientFile?: {
    explorerId: string;
    file: TransientExplorerFile;
  };
  appearance: CodeAppearance;
  graphRequest?: ExplorerGraphRequest | null;
  gitStatuses: Readonly<Record<string, GitStatus | undefined>>;
  handoffExplorer?: ExplorerSummary | null;
  onlineWorkerIds?: ReadonlySet<string>;
  onChanged?(explorer: ExplorerSummary): void;
  onHeaderChange?(state: ExplorerHeaderState | null): void;
  onInlineCodeReady?(explorerId: string): void;
  onLifecycleChange?(
    explorerId: string,
    actions: ExplorerLifecycleActions | null,
  ): void;
  onTransientLifecycleChange?(
    explorerId: string,
    actions: ExplorerLifecycleActions | null,
  ): void;
  onOpenFile?(
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
  ): void | Promise<void>;
  onRevealFolder?(
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
    localFolder: boolean,
  ): void | Promise<void>;
  revealLabel?: string;
  onOpenTerminal?(explorer: ExplorerSummary, entry: ExplorerEntry): void;
  openExplorers?: readonly ExplorerSummary[];
  prewarmExplorer?: ExplorerSummary | null;
  repositoryGraphAvailable: boolean;
}) {
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [retainedExplorers, setRetainedExplorers] = useState<ExplorerSummary[]>(
    [],
  );

  useEffect(() => {
    if (openExplorers) return;
    if (!activeExplorer && !prewarmExplorer) return;
    setRetainedExplorers((current) =>
      retainRequestedExplorerSurfaceTabs(
        current,
        activeExplorer,
        prewarmExplorer,
        dirtyIds,
        transientFile ? new Set([transientFile.explorerId]) : undefined,
      ),
    );
  }, [
    activeExplorer,
    dirtyIds,
    openExplorers,
    prewarmExplorer,
    transientFile?.explorerId,
  ]);

  const renderedExplorers = useMemo(
    () =>
      openExplorers
        ? ownedExplorerSurfaceTabs(
            openExplorers,
            activeExplorer,
            prewarmExplorer,
            handoffExplorer,
          )
        : ownedExplorerSurfaceTabs(
            retainRequestedExplorerSurfaceTabs(
              retainedExplorers,
              activeExplorer,
              prewarmExplorer,
              dirtyIds,
              transientFile ? new Set([transientFile.explorerId]) : undefined,
            ),
            activeExplorer,
            prewarmExplorer,
            handoffExplorer,
          ),
    [
      activeExplorer,
      dirtyIds,
      handoffExplorer,
      openExplorers,
      prewarmExplorer,
      retainedExplorers,
      transientFile?.explorerId,
    ],
  );
  const inlineCodeOwnerIds = useMemo(
    () =>
      new Set([
        ...(openExplorers?.map(({ id }) => id) ?? []),
        // A pin handoff becomes an ordinary open owner after the layout
        // refresh, without changing the keyed ExplorerView instance.
        ...(handoffExplorer ? [handoffExplorer.id] : []),
      ]),
    [handoffExplorer, openExplorers],
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
      if (transientFile?.explorerId === explorerId) {
        onTransientLifecycleChange?.(explorerId, actions);
      }
    },
    [onLifecycleChange, onTransientLifecycleChange, transientFile?.explorerId],
  );

  return renderedExplorers.map((explorer) => {
    const active = activeExplorer?.id === explorer.id;
    const explorerTransientFile =
      transientFile?.explorerId === explorer.id
        ? transientFile.file
        : undefined;
    const transient = Boolean(explorerTransientFile);
    const prewarm = prewarmExplorer?.id === explorer.id;
    return (
      <ExplorerView
        active={active}
        appearance={appearance}
        explorer={explorer}
        graphRequest={
          !transient && graphRequest?.explorerId === explorer.id
            ? graphRequest
            : null
        }
        gitStatus={gitStatuses[explorer.worktreeId]}
        keepInlineCodeWarm={inlineCodeOwnerIds.has(explorer.id)}
        key={explorer.id}
        onChanged={onChanged}
        onHeaderChange={active ? onHeaderChange : undefined}
        onInlineCodeReady={
          onInlineCodeReady ? () => onInlineCodeReady(explorer.id) : undefined
        }
        onLifecycleChange={handleLifecycleChange}
        onOpenFile={
          transient || prewarm || explorer.selectedPath ? undefined : onOpenFile
        }
        onRevealFolder={onRevealFolder}
        revealLabel={revealLabel}
        onOpenTerminal={onOpenTerminal}
        prewarmInlineCode={prewarm}
        repositoryGraphAvailable={transient ? false : repositoryGraphAvailable}
        transientFile={explorerTransientFile}
        workerOnline={
          onlineWorkerIds
            ? onlineWorkerIds.has(explorer.activeWorkerId)
            : undefined
        }
      />
    );
  });
}
