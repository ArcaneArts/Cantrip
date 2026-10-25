import { useEffect, useMemo, useState } from "react";
import type { CodeAppearance, ExplorerFileMode } from "@cantrip/protocol";
import type { FileDocument } from "@/lib/api/file-documents";
import { documentFileAccess } from "@/lib/file-access";
import {
  getClientSessionIdentitySnapshot,
  onClientSessionIdentityChanged,
} from "@/lib/client-session";
import { useFileDocumentRecovery } from "./use-file-document-recovery";
import {
  ExplorerView,
  type ExplorerHeaderState,
  type ExplorerLifecycleActions,
  type ExplorerTransferState,
  type ExplorerTransferStaging,
  type FileDocumentEditorView,
} from "./explorer-view";

/** Shared editor machinery with a view identity distinct from its document. */
export function FileDocumentView(props: FileDocumentViewProps) {
  const [identity, setIdentity] = useState(getClientSessionIdentitySnapshot);
  useEffect(
    () =>
      onClientSessionIdentityChanged(() =>
        setIdentity(getClientSessionIdentitySnapshot()),
      ),
    [],
  );
  return (
    <ScopedFileDocumentView
      key={JSON.stringify([
        identity?.serverId,
        identity?.userId,
        identity?.accountId,
        props.tabId,
        props.document.id,
      ])}
      {...props}
    />
  );
}

function ScopedFileDocumentView({
  tabId,
  document,
  mode,
  onModeChange,
  onOpenFile,
  ...presentation
}: FileDocumentViewProps) {
  const [incoming] = useState(presentation.initialTransfer);
  const recovery = useFileDocumentRecovery(
    document,
    tabId,
    Boolean(presentation.transferStaging),
  );
  const recoveryActions = useMemo(
    () => ({
      checkpoint: recovery.checkpoint,
      closeCommitted: recovery.closeCommitted,
    }),
    [recovery.checkpoint, recovery.closeCommitted],
  );
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
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-document-recovery={
        recovery.error
          ? "error"
          : !recovery.loaded
            ? "loading"
            : recovery.pending
              ? "saving"
              : "ready"
      }
    >
      {recovery.error ? (
        <div role="alert" className="p-3 text-sm text-destructive">
          Document recovery: {recovery.error}{" "}
          <button type="button" onClick={recovery.retry}>
            Retry recovery
          </button>
        </div>
      ) : null}
      {incoming || recovery.loaded ? (
        <ExplorerView
          {...presentation}
          initialTransfer={incoming ?? recovery.initial}
          documentRecovery={recoveryActions}
          explorer={view}
          fileAccess={fileAccess}
          repositoryGraphAvailable={false}
        />
      ) : !recovery.error ? (
        <div role="status" className="p-3 text-sm">
          Restoring document…
        </div>
      ) : null}
    </div>
  );
}

interface FileDocumentViewProps {
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
}
