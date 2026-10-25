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
  type ExplorerTransferState,
  type ExplorerTransferStaging,
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
  onOpenFile,
  initialTransfer,
  transferStaging,
  filesMigrated = false,
}: {
  initialTransfer?: ExplorerTransferState;
  filesMigrated?: boolean;
  transferStaging?: ExplorerTransferStaging;
  active?: boolean;
  appearance: CodeAppearance;
  codeTab: CodeTabSummary;
  onChanged?(): void;
  onHeaderChange?(state: CodeHeaderState | null): void;
  onOpenFile(tab: CodeTabSummary, entry: ExplorerEntry): void | Promise<void>;
}) {
  const scope = nativeCodeScope();
  const restored = useMemo(
    () =>
      filesMigrated && initialTransfer
        ? {
            ...initialTransfer,
            selectedPath: null,
            documents: { ...initialTransfer.documents, documents: [] },
          }
        : initialTransfer,
    [filesMigrated, initialTransfer],
  );
  return (
    <NativeProjectEditor
      key={`${nativeCodeOwnerKey(codeTab.id, scope)}:${filesMigrated ? "browser" : "legacy"}`}
      active={active}
      appearance={appearance}
      codeTab={codeTab}
      initialTransfer={restored}
      transferStaging={transferStaging}
      onHeaderChange={onHeaderChange}
      onOpenFile={onOpenFile}
    />
  );
}
function NativeProjectEditor({
  active,
  appearance,
  codeTab,
  onHeaderChange,
  onOpenFile,
  initialTransfer,
  transferStaging,
}: {
  initialTransfer?: ExplorerTransferState;
  transferStaging?: ExplorerTransferStaging;
  active: boolean;
  appearance: CodeAppearance;
  codeTab: CodeTabSummary;
  onHeaderChange?(state: CodeHeaderState | null): void;
  onOpenFile(tab: CodeTabSummary, entry: ExplorerEntry): void | Promise<void>;
}) {
  // Retain only restored legacy buffers here. New browser file requests use
  // workspace-owned document tabs, not another mutable Code selection.
  const [path, setPath] = useState<string | null>(
    initialTransfer?.selectedPath ?? null,
  );
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
  const openFile = useCallback(
    (_explorer: ExplorerSummary, entry: ExplorerEntry) =>
      onOpenFile(boundTab, entry),
    [boundTab, onOpenFile],
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
        initialTransfer={initialTransfer}
        transferStaging={transferStaging}
        onHeaderChange={setHeader}
        onLifecycleChange={onLifecycleChange}
        onOpenFile={openFile}
        transientFile={path ? { path, close } : undefined}
        repositoryGraphAvailable={false}
      />
    </div>
  );
}
