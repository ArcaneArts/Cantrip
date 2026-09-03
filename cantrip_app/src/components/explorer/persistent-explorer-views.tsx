import type {
  CodeAppearance,
  ExplorerEntry,
  ExplorerSummary,
  GitStatus,
} from "@cantrip/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ExplorerView,
  type ExplorerGraphRequest,
  type ExplorerHeaderState,
  type ExplorerLifecycleActions,
  type TransientExplorerFile,
} from "@/components/explorer/explorer-view";
import { clientLogger } from "@/lib/client-log-relay";
import { explorerFileIntentContext } from "@/lib/explorer-lifecycle-trace";

export const MAX_RETAINED_EXPLORER_VIEWS = 8;

interface ExplorerOwnershipDiagnostic {
  active: boolean;
  explorerId: string;
  handoffDestination: boolean;
  handoffSource: boolean;
  openOwner: boolean;
  ownershipKind: string;
  prewarm: boolean;
  projectId: string;
  transient: boolean;
  worktreeId: string;
}

function sameExplorerOwnershipDiagnostic(
  left: ExplorerOwnershipDiagnostic | undefined,
  right: ExplorerOwnershipDiagnostic,
): boolean {
  return (
    left?.active === right.active &&
    left.explorerId === right.explorerId &&
    left.handoffDestination === right.handoffDestination &&
    left.handoffSource === right.handoffSource &&
    left.openOwner === right.openOwner &&
    left.ownershipKind === right.ownershipKind &&
    left.prewarm === right.prewarm &&
    left.projectId === right.projectId &&
    left.transient === right.transient &&
    left.worktreeId === right.worktreeId
  );
}

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
  prewarmSuccessor?: ExplorerSummary | null,
): ExplorerSummary[] {
  const requested = [prewarm, prewarmSuccessor, active].filter(
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
  handoffSource?: ExplorerSummary | null,
  prewarmSuccessor?: ExplorerSummary | null,
): ExplorerSummary[] {
  const owned: ExplorerSummary[] = [];
  const indexById = new Map<string, number>();
  for (const explorer of [
    ...openExplorers,
    prewarm,
    prewarmSuccessor,
    handoffSource,
    handoff,
    active,
  ]) {
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
  handoffSourceExplorer,
  onlineWorkerIds,
  onChanged,
  onHeaderChange,
  onInlineCodeReady,
  onLifecycleChange,
  onTransientLifecycleChange,
  onOpenFile,
  onOpenGraphFile,
  onRevealFolder,
  revealLabel,
  onOpenTerminal,
  openExplorers,
  prewarmExplorer,
  prewarmSuccessorExplorer,
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
  handoffSourceExplorer?: ExplorerSummary | null;
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
  onOpenGraphFile?(explorer: ExplorerSummary, path: string): void;
  onRevealFolder?(
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
    localFolder: boolean,
  ): void | Promise<void>;
  revealLabel?: string;
  onOpenTerminal?(explorer: ExplorerSummary, entry: ExplorerEntry): void;
  openExplorers?: readonly ExplorerSummary[];
  prewarmExplorer?: ExplorerSummary | null;
  prewarmSuccessorExplorer?: ExplorerSummary | null;
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
    if (!activeExplorer && !prewarmExplorer && !prewarmSuccessorExplorer) {
      return;
    }
    setRetainedExplorers((current) =>
      retainRequestedExplorerSurfaceTabs(
        current,
        activeExplorer,
        prewarmExplorer,
        dirtyIds,
        transientFile ? new Set([transientFile.explorerId]) : undefined,
        prewarmSuccessorExplorer,
      ),
    );
  }, [
    activeExplorer,
    dirtyIds,
    openExplorers,
    prewarmExplorer,
    prewarmSuccessorExplorer,
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
            handoffSourceExplorer,
            prewarmSuccessorExplorer,
          )
        : ownedExplorerSurfaceTabs(
            retainRequestedExplorerSurfaceTabs(
              retainedExplorers,
              activeExplorer,
              prewarmExplorer,
              dirtyIds,
              transientFile ? new Set([transientFile.explorerId]) : undefined,
              prewarmSuccessorExplorer,
            ),
            activeExplorer,
            prewarmExplorer,
            handoffExplorer,
            handoffSourceExplorer,
            prewarmSuccessorExplorer,
          ),
    [
      activeExplorer,
      dirtyIds,
      handoffExplorer,
      handoffSourceExplorer,
      openExplorers,
      prewarmExplorer,
      prewarmSuccessorExplorer,
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
        // The source is captured before the pin request so query/layout
        // reconciliation cannot release the Code owner during promotion.
        ...(handoffSourceExplorer ? [handoffSourceExplorer.id] : []),
      ]),
    [handoffExplorer, handoffSourceExplorer, openExplorers],
  );
  const ownershipDiagnostics = useMemo<ExplorerOwnershipDiagnostic[]>(
    () =>
      renderedExplorers.map((explorer) => {
        const active = activeExplorer?.id === explorer.id;
        const handoffDestination = handoffExplorer?.id === explorer.id;
        const handoffSource = handoffSourceExplorer?.id === explorer.id;
        const openOwner = Boolean(
          openExplorers?.some(({ id }) => id === explorer.id),
        );
        const prewarm =
          prewarmExplorer?.id === explorer.id ||
          prewarmSuccessorExplorer?.id === explorer.id;
        const transient = transientFile?.explorerId === explorer.id;
        const roles = [
          active ? "active" : null,
          openOwner ? "open" : null,
          transient ? "transient" : null,
          prewarm ? "prewarm" : null,
          handoffSource ? "handoff-source" : null,
          handoffDestination ? "handoff-destination" : null,
        ].filter((role): role is string => role !== null);
        return {
          active,
          explorerId: explorer.id,
          handoffDestination,
          handoffSource,
          openOwner,
          ownershipKind: roles.join("+") || "retained-only",
          prewarm,
          projectId: explorer.projectId,
          transient,
          worktreeId: explorer.worktreeId,
        };
      }),
    [
      activeExplorer?.id,
      handoffExplorer?.id,
      handoffSourceExplorer?.id,
      openExplorers,
      prewarmExplorer?.id,
      prewarmSuccessorExplorer?.id,
      renderedExplorers,
      transientFile?.explorerId,
    ],
  );
  const previousOwnershipRef = useRef(
    new Map<string, ExplorerOwnershipDiagnostic>(),
  );

  useEffect(() => {
    const current = new Map(
      ownershipDiagnostics.map((diagnostic) => [
        diagnostic.explorerId,
        diagnostic,
      ]),
    );
    for (const diagnostic of ownershipDiagnostics) {
      if (
        sameExplorerOwnershipDiagnostic(
          previousOwnershipRef.current.get(diagnostic.explorerId),
          diagnostic,
        )
      ) {
        continue;
      }
      clientLogger.info("Explorer retained ownership observed", {
        ...explorerFileIntentContext(diagnostic.explorerId),
        ...diagnostic,
        counts: { renderedExplorers: ownershipDiagnostics.length },
        event: "explorer.retention.observed",
        operation: "retain-surface",
        status: "observed",
        subsystem: "explorer",
        surfaceId: diagnostic.explorerId,
      });
    }
    for (const [explorerId, previous] of previousOwnershipRef.current) {
      if (current.has(explorerId)) continue;
      clientLogger.info("Explorer retained ownership removed", {
        ...explorerFileIntentContext(explorerId),
        ...previous,
        counts: { renderedExplorers: ownershipDiagnostics.length },
        event: "explorer.retention.removed",
        operation: "release-surface",
        reasonCode: "ownership-removed",
        status: "completed",
        subsystem: "explorer",
        surfaceId: explorerId,
      });
    }
    previousOwnershipRef.current = current;
  }, [ownershipDiagnostics]);

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
    const prewarm =
      prewarmExplorer?.id === explorer.id ||
      prewarmSuccessorExplorer?.id === explorer.id;
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
        onOpenGraphFile={onOpenGraphFile}
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
