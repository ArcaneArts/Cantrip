import type {
  CodeAppearance,
  ExplorerEntry,
  ExplorerSummary,
  GitStatus,
} from "@cantrip/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PersistentSurfacePortal } from "@/components/app/persistent-surface-portal";
import {
  ExplorerView,
  type ExplorerGraphRequest,
  type ExplorerHeaderState,
  type ExplorerLifecycleActions,
  type ExplorerTransferState,
  type IncomingEditorView,
} from "@/components/explorer/explorer-view";
import { clientLogger } from "@/lib/client-log-relay";
import { explorerFileIntentContext } from "@/lib/explorer-lifecycle-trace";

export const MAX_RETAINED_EXPLORER_VIEWS = 8;
const EMPTY_EXCLUDED_EXPLORER_IDS: ReadonlySet<string> = new Set();

interface ExplorerOwnershipDiagnostic {
  active: boolean;
  explorerId: string;
  openOwner: boolean;
  ownershipKind: string;
  prewarm: boolean;
  projectId: string;
  worktreeId: string;
}

function sameExplorerOwnershipDiagnostic(
  left: ExplorerOwnershipDiagnostic | undefined,
  right: ExplorerOwnershipDiagnostic,
): boolean {
  return (
    left?.active === right.active &&
    left.explorerId === right.explorerId &&
    left.openOwner === right.openOwner &&
    left.ownershipKind === right.ownershipKind &&
    left.prewarm === right.prewarm &&
    left.projectId === right.projectId &&
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
  prewarmSuccessor?: ExplorerSummary | null,
): ExplorerSummary[] {
  const requested = [prewarm, prewarmSuccessor, active].filter(
    (explorer): explorer is ExplorerSummary =>
      explorer !== null && explorer !== undefined,
  );
  const requestedIds = new Set(requested.map((explorer) => explorer.id));
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
      !requestedIds.has(explorer.id) &&
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
  prewarmSuccessor?: ExplorerSummary | null,
): ExplorerSummary[] {
  const owned: ExplorerSummary[] = [];
  const indexById = new Map<string, number>();
  for (const explorer of [
    ...openExplorers,
    prewarm,
    prewarmSuccessor,
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
  appearance,
  graphRequest,
  gitStatuses,
  onlineWorkerIds,
  onChanged,
  onHeaderChange,
  onLifecycleChange,
  onOpenFile,
  onOpenGraphFile,
  onRevealFolder,
  revealLabel,
  onOpenTerminal,
  openExplorers: providedOpenExplorers,
  prewarmExplorer,
  prewarmSuccessorExplorer,
  repositoryGraphAvailable,
  visiblePlacements,
  excludedIds = EMPTY_EXCLUDED_EXPLORER_IDS,
  initialTransfers,
  incomingViews,
}: {
  incomingViews?: readonly IncomingEditorView<ExplorerSummary>[];
  initialTransfers?: ReadonlyMap<string, ExplorerTransferState>;
  activeExplorer: ExplorerSummary | null;
  appearance: CodeAppearance;
  graphRequest?: ExplorerGraphRequest | null;
  gitStatuses: Readonly<Record<string, GitStatus | undefined>>;
  onlineWorkerIds?: ReadonlySet<string>;
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
  excludedIds?: ReadonlySet<string>;
  visiblePlacements?: readonly {
    explorer: ExplorerSummary;
    focused: boolean;
    gridArea: string;
    paneId: string;
    portalTarget?: Element | null;
  }[];
}) {
  const openExplorers = useMemo(
    () =>
      incomingViews
        ? [
            ...new Map(
              [
                ...incomingViews.map(({ resource }) => resource),
                ...(providedOpenExplorers ?? []),
              ].map((resource) => [resource.id, resource]),
            ).values(),
          ]
        : providedOpenExplorers,
    [incomingViews, providedOpenExplorers],
  );
  const incomingById = new Map(
    incomingViews?.map((view) => [view.resource.id, view]) ?? [],
  );
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
        prewarmSuccessorExplorer,
      ),
    );
  }, [
    activeExplorer,
    dirtyIds,
    openExplorers,
    prewarmExplorer,
    prewarmSuccessorExplorer,
  ]);

  const renderedExplorers = useMemo(
    () =>
      (openExplorers
        ? ownedExplorerSurfaceTabs(
            openExplorers,
            activeExplorer,
            prewarmExplorer,
            prewarmSuccessorExplorer,
          )
        : ownedExplorerSurfaceTabs(
            retainRequestedExplorerSurfaceTabs(
              retainedExplorers,
              activeExplorer,
              prewarmExplorer,
              dirtyIds,
              prewarmSuccessorExplorer,
            ),
            activeExplorer,
            prewarmExplorer,
            prewarmSuccessorExplorer,
          )
      ).filter(({ id }) => !excludedIds.has(id)),
    [
      activeExplorer,
      dirtyIds,
      excludedIds,
      openExplorers,
      prewarmExplorer,
      prewarmSuccessorExplorer,
      retainedExplorers,
    ],
  );
  const inlineCodeOwnerIds = useMemo(
    () => new Set(openExplorers?.map(({ id }) => id) ?? []),
    [openExplorers],
  );
  const placementById = useMemo(
    () =>
      new Map(
        visiblePlacements?.map((placement) => [
          placement.explorer.id,
          placement,
        ]) ?? [],
      ),
    [visiblePlacements],
  );
  const ownershipDiagnostics = useMemo<ExplorerOwnershipDiagnostic[]>(
    () =>
      renderedExplorers.map((explorer) => {
        const active = visiblePlacements
          ? placementById.has(explorer.id)
          : activeExplorer?.id === explorer.id;
        const openOwner = Boolean(
          openExplorers?.some(({ id }) => id === explorer.id),
        );
        const prewarm =
          prewarmExplorer?.id === explorer.id ||
          prewarmSuccessorExplorer?.id === explorer.id;
        const roles = [
          active ? "active" : null,
          openOwner ? "open" : null,
          prewarm ? "prewarm" : null,
        ].filter((role): role is string => role !== null);
        return {
          active,
          explorerId: explorer.id,
          openOwner,
          ownershipKind: roles.join("+") || "retained-only",
          prewarm,
          projectId: explorer.projectId,
          worktreeId: explorer.worktreeId,
        };
      }),
    [
      activeExplorer?.id,
      openExplorers,
      prewarmExplorer?.id,
      prewarmSuccessorExplorer?.id,
      renderedExplorers,
      placementById,
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
    },
    [onLifecycleChange],
  );

  return renderedExplorers.map((explorer) => {
    const placement = placementById.get(explorer.id);
    const active = visiblePlacements
      ? Boolean(placement && placement.portalTarget !== null)
      : activeExplorer?.id === explorer.id;
    const prewarm =
      prewarmExplorer?.id === explorer.id ||
      prewarmSuccessorExplorer?.id === explorer.id;
    const view = (
      <ExplorerView
        active={active}
        appearance={appearance}
        explorer={explorer}
        initialTransfer={
          incomingById.get(explorer.id)?.state ??
          initialTransfers?.get(explorer.id)
        }
        transferStaging={incomingById.get(explorer.id)?.staging}
        graphRequest={
          graphRequest?.explorerId === explorer.id ? graphRequest : null
        }
        gitStatus={gitStatuses[explorer.worktreeId]}
        keepInlineCodeWarm={inlineCodeOwnerIds.has(explorer.id)}
        onChanged={onChanged}
        onHeaderChange={
          visiblePlacements
            ? placement?.focused
              ? onHeaderChange
              : undefined
            : active
              ? onHeaderChange
              : undefined
        }
        onLifecycleChange={handleLifecycleChange}
        onOpenFile={prewarm || explorer.selectedPath ? undefined : onOpenFile}
        onOpenGraphFile={onOpenGraphFile}
        onRevealFolder={onRevealFolder}
        revealLabel={revealLabel}
        onOpenTerminal={onOpenTerminal}
        prewarmInlineCode={prewarm}
        repositoryGraphAvailable={repositoryGraphAvailable}
        workerOnline={
          onlineWorkerIds
            ? onlineWorkerIds.has(explorer.activeWorkerId)
            : undefined
        }
      />
    );
    const owner = (
      <div
        aria-hidden={!active}
        className={
          active ? "flex min-h-0 min-w-0 flex-1 overflow-hidden" : "hidden"
        }
        data-explorer-pane={placement?.gridArea}
        data-project-pane-id={placement?.paneId}
        key={explorer.id}
        style={placement ? { gridArea: placement.gridArea } : undefined}
      >
        {view}
      </div>
    );
    return visiblePlacements ? (
      <PersistentSurfacePortal
        host={placement?.portalTarget ?? null}
        key={explorer.id}
        portalKey={explorer.id}
      >
        {owner}
      </PersistentSurfacePortal>
    ) : (
      owner
    );
  });
}
