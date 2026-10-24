import { useMemo } from "react";
import type { CodeAppearance, ExplorerFileMode } from "@cantrip/protocol";
import type { FileDocument } from "@/lib/api/file-documents";
import { documentFileAccess } from "@/lib/file-access";
import {
  ExplorerView,
  type ExplorerHeaderState,
  type ExplorerLifecycleActions,
  type ExplorerTransferState,
  type ExplorerTransferStaging,
  type FileDocumentEditorView,
} from "./explorer-view";

/** Shared editor machinery with a view identity distinct from its document. */
export function FileDocumentView({
  tabId,
  document,
  mode,
  onModeChange,
  onOpenFile,
  ...presentation
}: {
  tabId: string;
  document: FileDocument;
  mode: ExplorerFileMode;
  onModeChange(mode: ExplorerFileMode): void | Promise<void>;
  onOpenFile(path: string): void;
  appearance: CodeAppearance;
  active?: boolean;
  workerOnline?: boolean;
  showToolbar?: boolean;
  initialTransfer?: ExplorerTransferState;
  transferStaging?: ExplorerTransferStaging;
  onHeaderChange?(state: ExplorerHeaderState | null): void;
  onLifecycleChange?(
    tabId: string,
    actions: ExplorerLifecycleActions | null,
  ): void;
}) {
  const fileAccess = useMemo(() => documentFileAccess(document), [document]);
  const view = useMemo<FileDocumentEditorView>(
    () => ({
      kind: "file-document",
      id: tabId,
      documentId: document.id,
      projectId: document.projectId,
      worktreeId: document.worktreeId,
      activeWorkerId: document.workerId,
      selectedPath: document.path,
      title: document.path.split("/").at(-1) || document.path,
      fileMode: mode,
      setMode: onModeChange,
      openFile: onOpenFile,
    }),
    [tabId, document, mode, onModeChange, onOpenFile],
  );
  return (
    <ExplorerView
      {...presentation}
      explorer={view}
      fileAccess={fileAccess}
      repositoryGraphAvailable={false}
    />
  );
}
