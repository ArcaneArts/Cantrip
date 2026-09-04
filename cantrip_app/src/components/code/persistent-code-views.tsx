import type { CodeAppearance, CodeTabSummary } from "@cantrip/protocol";
import { useEffect, useMemo, useState } from "react";

import { CodeView, type CodeHeaderState } from "./code-view";
import { PersistentSurfacePortal } from "@/components/app/persistent-surface-portal";

export const MAX_RETAINED_CODE_VIEWS = 8;
const EMPTY_EXCLUDED_CODE_IDS: ReadonlySet<string> = new Set();

export function retainCodeSurfaceTabs(
  retained: CodeTabSummary[],
  active: CodeTabSummary,
  limit = MAX_RETAINED_CODE_VIEWS,
): CodeTabSummary[] {
  const withoutActive = retained.filter((tab) => tab.id !== active.id);
  return [...withoutActive, active].slice(-Math.max(1, limit));
}

export function PersistentCodeViews({
  activeTab,
  appearance,
  onChanged,
  onHeaderChange,
  visiblePlacements,
  excludedIds = EMPTY_EXCLUDED_CODE_IDS,
}: {
  activeTab: CodeTabSummary | null;
  appearance: CodeAppearance;
  onChanged?(codeTab: CodeTabSummary): void;
  onHeaderChange?(state: CodeHeaderState | null): void;
  excludedIds?: ReadonlySet<string>;
  visiblePlacements?: readonly {
    focused: boolean;
    gridArea: string;
    paneId: string;
    portalTarget?: Element | null;
    tab: CodeTabSummary;
  }[];
}) {
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
    setRetainedTabs((current) =>
      requestedTabs.reduce(
        (retained, tab) => retainCodeSurfaceTabs(retained, tab),
        current.filter(({ id }) => !excludedIds.has(id)),
      ),
    );
  }, [excludedIds, requestedTabs]);

  const renderedTabs = useMemo(
    () =>
      requestedTabs.reduce(
        (retained, tab) => retainCodeSurfaceTabs(retained, tab),
        retainedTabs.filter(({ id }) => !excludedIds.has(id)),
      ),
    [excludedIds, requestedTabs, retainedTabs],
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
        onChanged={() => onChanged?.(tab)}
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
