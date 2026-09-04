import type { CodeAppearance, CodeTabSummary } from "@cantrip/protocol";
import { useEffect, useMemo, useState } from "react";

import { CodeView, type CodeHeaderState } from "./code-view";

export const MAX_RETAINED_CODE_VIEWS = 8;

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
}: {
  activeTab: CodeTabSummary | null;
  appearance: CodeAppearance;
  onChanged?(codeTab: CodeTabSummary): void;
  onHeaderChange?(state: CodeHeaderState | null): void;
  visiblePlacements?: readonly {
    focused: boolean;
    gridArea: string;
    paneId: string;
    tab: CodeTabSummary;
  }[];
}) {
  const [retainedTabs, setRetainedTabs] = useState<CodeTabSummary[]>([]);
  const requestedTabs = useMemo(
    () =>
      visiblePlacements?.map(({ tab }) => tab) ??
      (activeTab ? [activeTab] : []),
    [activeTab, visiblePlacements],
  );

  useEffect(() => {
    if (requestedTabs.length === 0) return;
    setRetainedTabs((current) =>
      requestedTabs.reduce(
        (retained, tab) => retainCodeSurfaceTabs(retained, tab),
        current,
      ),
    );
  }, [requestedTabs]);

  const renderedTabs = useMemo(
    () =>
      requestedTabs.reduce(
        (retained, tab) => retainCodeSurfaceTabs(retained, tab),
        retainedTabs,
      ),
    [requestedTabs, retainedTabs],
  );
  const placementById = new Map(
    visiblePlacements?.map((placement) => [placement.tab.id, placement]) ?? [],
  );

  return renderedTabs.map((tab) => {
    const placement = placementById.get(tab.id);
    const active = visiblePlacements
      ? Boolean(placement)
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
    return (
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
  });
}
