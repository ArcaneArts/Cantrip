import type {
  CodeAppearance,
  CodeTabSummary,
  ExplorerEntry,
  ExplorerSummary,
} from "@cantrip/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ExplorerView,
  type ExplorerHeaderState,
  type ExplorerLifecycleActions,
} from "@/components/explorer/explorer-view";
import {
  nativeCodeOwnerKey,
  nativeCodeScope,
  setNativeCodeLifecycle,
} from "./native-code-lifecycle";

export interface CodeHeaderState {
  explorer: ExplorerHeaderState | null;
}

/** Project Code tabs now own a native file browser and editor, without a runtime. */
export function CodeView({
  active = true,
  appearance,
  codeTab,
  onHeaderChange,
}: {
  active?: boolean;
  appearance: CodeAppearance;
  codeTab: CodeTabSummary;
  onChanged?(): void;
  onHeaderChange?(state: CodeHeaderState | null): void;
}) {
  const scope = nativeCodeScope();
  return (
    <NativeProjectEditor
      key={nativeCodeOwnerKey(codeTab.id, scope)}
      active={active}
      appearance={appearance}
      codeTab={codeTab}
      onHeaderChange={onHeaderChange}
    />
  );
}
function NativeProjectEditor({
  active,
  appearance,
  codeTab,
  onHeaderChange,
}: {
  active: boolean;
  appearance: CodeAppearance;
  codeTab: CodeTabSummary;
  onHeaderChange?(state: CodeHeaderState | null): void;
}) {
  const [path, setPath] = useState<string | null>(null);
  const [header, setHeader] = useState<ExplorerHeaderState | null>(null);
  const lifecycle = useRef<ExplorerLifecycleActions | null>(null);
  const ownerKey = nativeCodeOwnerKey(codeTab.id);
  const [boundTab, setBoundTab] = useState(codeTab);
  const moved =
    boundTab.worktreeId !== codeTab.worktreeId ||
    boundTab.activeWorkerId !== codeTab.activeWorkerId;
  useEffect(() => {
    if (moved && lifecycle.current?.dirty) return;
    if (moved) setPath(null);
    setBoundTab(codeTab);
  }, [codeTab, header?.dirty, moved]);
  const explorer = useMemo<ExplorerSummary>(
    () => ({ ...boundTab, fileMode: "preview", selectedPath: null }),
    [boundTab],
  );
  const onLifecycleChange = useCallback(
    (_id: string, actions: ExplorerLifecycleActions | null) => {
      lifecycle.current = actions;
      setNativeCodeLifecycle(ownerKey, actions);
    },
    [ownerKey],
  );
  useEffect(() => () => setNativeCodeLifecycle(ownerKey, null), [ownerKey]);
  const onOpenFile = useCallback(
    (_explorer: ExplorerSummary, entry: ExplorerEntry) => setPath(entry.path),
    [],
  );
  const close = useCallback(() => setPath(null), []);
  useEffect(() => {
    if (!active) return;
    onHeaderChange?.({
      explorer: header,
    });
  }, [active, header, onHeaderChange]);
  useEffect(
    () => () => {
      if (active) onHeaderChange?.(null);
    },
    [active, onHeaderChange],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {moved && lifecycle.current?.dirty ? (
        <p role="alert" className="border-b px-3 py-2 text-xs text-destructive">
          This tab moved to another checkout. Your draft is kept in this editor;
          copy it before closing.
        </p>
      ) : null}
      <ExplorerView
        active={active}
        appearance={appearance}
        explorer={explorer}
        onHeaderChange={setHeader}
        onLifecycleChange={onLifecycleChange}
        onOpenFile={onOpenFile}
        transientFile={path ? { path, close } : undefined}
        repositoryGraphAvailable={false}
      />
    </div>
  );
}
