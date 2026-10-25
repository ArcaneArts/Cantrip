import { nativeCodeDirty } from "./native-code-lifecycle";
import type {
  ExplorerTransferState,
  IncomingEditorView,
} from "@/components/explorer/explorer-view";
import type {
  CodeAppearance,
  CodeTabSummary,
  ExplorerEntry,
} from "@cantrip/protocol";
import { useEffect, useMemo, useState } from "react";

import { CodeView, type CodeHeaderState } from "./code-view";
import { PersistentSurfacePortal } from "@/components/app/persistent-surface-portal";

export const MAX_RETAINED_CODE_VIEWS = 8;
const EMPTY_EXCLUDED_CODE_IDS: ReadonlySet<string> = new Set();

function ownedCodeTabs(
  known: readonly CodeTabSummary[],
  resolved: readonly CodeTabSummary[],
  unresolvedIds: ReadonlySet<string>,
): CodeTabSummary[] {
  const tabs = new Map(resolved.map((tab) => [tab.id, tab]));
  for (const tab of known)
    if (unresolvedIds.has(tab.id) && !tabs.has(tab.id)) tabs.set(tab.id, tab);
  return [...tabs.values()];
}

export function retainCodeSurfaceTabs(
  retained: CodeTabSummary[],
  active: CodeTabSummary,
  limit = MAX_RETAINED_CODE_VIEWS,
  protectedIds: ReadonlySet<string> = new Set(),
): CodeTabSummary[] {
  const withoutActive = retained.filter((tab) => tab.id !== active.id);
  const candidates = [...withoutActive, active];
  const keep = new Set([...protectedIds, active.id]);
  const clean = candidates.filter((tab) => !keep.has(tab.id));
  const available = Math.max(
    0,
    limit - candidates.filter((tab) => keep.has(tab.id)).length,
  );
  for (const tab of available ? clean.slice(-available) : []) keep.add(tab.id);
  return candidates.filter((tab) => keep.has(tab.id));
}

function retainOwnedCodeTabs(
  retained: CodeTabSummary[],
  active: CodeTabSummary,
): CodeTabSummary[] {
  return retainCodeSurfaceTabs(
    retained,
    active,
    MAX_RETAINED_CODE_VIEWS,
    new Set(
      retained.filter((tab) => nativeCodeDirty(tab.id)).map((tab) => tab.id),
    ),
  );
}

export function PersistentCodeViews({
  activeTab,
  appearance,
  onChanged,
  onHeaderChange,
  onOpenFile,
  visiblePlacements,
  excludedIds = EMPTY_EXCLUDED_CODE_IDS,
  initialTransfers,
  openTabs: providedOpenTabs,
  incomingViews,
  unresolvedIds = EMPTY_EXCLUDED_CODE_IDS,
}: {
  incomingViews?: readonly IncomingEditorView<CodeTabSummary>[];
  unresolvedIds?: ReadonlySet<string>;
  /** Explicit window ownership. An empty list releases every retained owner. */
  openTabs?: readonly CodeTabSummary[];
  initialTransfers?: ReadonlyMap<string, ExplorerTransferState>;
  activeTab: CodeTabSummary | null;
  appearance: CodeAppearance;
  onChanged?(codeTab: CodeTabSummary): void;
  onHeaderChange?(state: CodeHeaderState | null): void;
  onOpenFile(tab: CodeTabSummary, entry: ExplorerEntry): void | Promise<void>;
  excludedIds?: ReadonlySet<string>;
  visiblePlacements?: readonly {
    focused: boolean;
    gridArea: string;
    paneId: string;
    portalTarget?: Element | null;
    tab: CodeTabSummary;
  }[];
}) {
  const openTabs = useMemo(
    () =>
      incomingViews
        ? [
            ...new Map(
              [
                ...incomingViews.map(({ resource }) => resource),
                ...(providedOpenTabs ?? []),
              ].map((resource) => [resource.id, resource]),
            ).values(),
          ]
        : providedOpenTabs,
    [incomingViews, providedOpenTabs],
  );
  const incomingById = new Map(
    incomingViews?.map((view) => [view.resource.id, view]) ?? [],
  );
  const [retainedTabs, setRetainedTabs] = useState<CodeTabSummary[]>([]);
  const requestedTabs = useMemo(
    () =>
      (
        visiblePlacements?.map(({ tab }) => tab) ??
        (activeTab ? [activeTab] : [])
      ).filter(({ id }) => !excludedIds.has(id)),
    [activeTab, excludedIds, visiblePlacements],
  );

  useEffect(() => {
    if (openTabs) {
      setRetainedTabs((current) =>
        ownedCodeTabs(current, openTabs, unresolvedIds).filter(
          ({ id }) => !excludedIds.has(id),
        ),
      );
      return;
    }
    setRetainedTabs((current) =>
      requestedTabs.reduce(
        (retained, tab) => retainOwnedCodeTabs(retained, tab),
        current.filter(({ id }) => !excludedIds.has(id)),
      ),
    );
  }, [excludedIds, requestedTabs, openTabs, unresolvedIds]);

  const renderedTabs = useMemo(
    () =>
      openTabs
        ? ownedCodeTabs(retainedTabs, openTabs, unresolvedIds).filter(
            ({ id }) => !excludedIds.has(id),
          )
        : requestedTabs.reduce(
            (retained, tab) => retainOwnedCodeTabs(retained, tab),
            retainedTabs.filter(({ id }) => !excludedIds.has(id)),
          ),
    [excludedIds, requestedTabs, retainedTabs, openTabs, unresolvedIds],
  );
  const placementById = new Map(
    visiblePlacements?.map((placement) => [placement.tab.id, placement]) ?? [],
  );

  return renderedTabs.map((tab) => {
    const placement = placementById.get(tab.id);
    const active = visiblePlacements
      ? Boolean(placement && placement.portalTarget !== null)
      : activeTab?.id === tab.id;
    const view = (
      <CodeView
        active={active}
        appearance={appearance}
        codeTab={tab}
        initialTransfer={
          incomingById.get(tab.id)?.state ?? initialTransfers?.get(tab.id)
        }
        transferStaging={incomingById.get(tab.id)?.staging}
        onChanged={() => onChanged?.(tab)}
        onOpenFile={onOpenFile}
        onHeaderChange={
          visiblePlacements
            ? placement?.focused
              ? onHeaderChange
              : undefined
            : active
              ? onHeaderChange
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
        data-code-pane={placement?.gridArea}
        data-project-pane-id={placement?.paneId}
        key={tab.id}
        style={placement ? { gridArea: placement.gridArea } : undefined}
      >
        {view}
      </div>
    );
    return visiblePlacements ? (
      <PersistentSurfacePortal
        host={placement?.portalTarget ?? null}
        key={tab.id}
        portalKey={tab.id}
      >
        {owner}
      </PersistentSurfacePortal>
    ) : (
      owner
    );
  });
}
