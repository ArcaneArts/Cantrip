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
}: {
  activeTab: CodeTabSummary | null;
  appearance: CodeAppearance;
  onChanged?(codeTab: CodeTabSummary): void;
  onHeaderChange?(state: CodeHeaderState | null): void;
}) {
  const [retainedTabs, setRetainedTabs] = useState<CodeTabSummary[]>([]);

  useEffect(() => {
    if (!activeTab) return;
    setRetainedTabs((current) => retainCodeSurfaceTabs(current, activeTab));
  }, [activeTab]);

  const renderedTabs = useMemo(
    () =>
      activeTab ? retainCodeSurfaceTabs(retainedTabs, activeTab) : retainedTabs,
    [activeTab, retainedTabs],
  );

  return renderedTabs.map((tab) => {
    const active = activeTab?.id === tab.id;
    return (
      <CodeView
        active={active}
        appearance={appearance}
        codeTab={tab}
        key={tab.id}
        onChanged={() => onChanged?.(tab)}
        onHeaderChange={active ? onHeaderChange : undefined}
      />
    );
  });
}
