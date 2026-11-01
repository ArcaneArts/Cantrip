import { resolveFileViewer } from "@/components/files/file-viewers";
import { mediaBlobForViewer } from "@/components/files/viewer-media";
import { LogFileView } from "./log-file-view";
import { PagedTextPreview } from "./paged-text-preview";
import { requiresTextPreview, retryFileRead } from "@/lib/file-operation-error";
import { executeExplorerOperation } from "@/lib/api/files";
import { PanelToolbar } from "@/components/workspace/panel-toolbar";
import { usePanelScrollDivider } from "@/lib/use-panel-scroll-divider";
import { useEditorQuit } from "./use-editor-quit";
import {
  ExplorerFileCloseButton,
  ExplorerHeaderActions,
} from "@/components/workspace/content-header-actions";
import {
  type CodeAppearance,
  type ExplorerMediaKind,
  type ExplorerEntry,
  type ExplorerFileMode,
  type ExplorerSummary,
  type GitStatus,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import { ExplorerMarkdown } from "@/components/explorer/explorer-markdown";
import { ExplorerFileBrowser } from "@/components/explorer/explorer-file-browser";
import { explorerSurfaceSelectedPath } from "@/components/explorer/explorer-file-routing";
import { explorerFileEntryForGraphPath } from "@/components/explorer/explorer-graph-routing";
import { ExplorerImageViewport } from "@/components/explorer/explorer-image-viewport";
import { nextExplorerEntryReplayKey } from "@/components/explorer/explorer-lifecycle";
import { validateExplorerTransfer } from "@/components/explorer/explorer-transfer-state";
import {
  EditorSessionStore,
  editorDocumentId,
  type EditorDocumentSession,
  type EditorSessionTransfer,
} from "@/components/editor/document-session";
import { NativeCodeEditor } from "@/components/editor/native-code-editor";
import { LicenseFileView } from "@/components/editor/license-file-view";
import { getClientSession } from "@/lib/client-session";
import { confirmEditorAction } from "@/lib/editor-confirmation";
import { useExplorerWorkerEncryption } from "@/components/explorer/use-explorer-worker-encryption";
import {
  defaultExplorerFileMode,
  markdownPreviewUsesPlainText,
} from "@/components/explorer/explorer-file-language";
import {
  GitRepositoryGraphView,
  type GitRepositoryGraphStatus,
} from "@/components/git/git-graph";
import { Button } from "@/components/ui/button";
import {
  getExplorerFile,
  loadExplorerMedia,
  saveExplorerFile,
  updateExplorerViewState,
} from "@/lib/api";
import { clientLogger } from "@/lib/client-log-relay";
import { explorerFileIntentContext } from "@/lib/explorer-lifecycle-trace";
import { requestGitFileHistory } from "@/lib/git-history-navigation";
import { cn } from "@/lib/utils";
import type { FileAccess } from "@/lib/file-access";

const StructuredFileVisual = lazy(async () => {
  const module = await import("@/components/explorer/structured-file-visual");
  return { default: module.StructuredFileVisual };
});
function RestoredView({ onReady }: { onReady(): void }) {
  useEffect(onReady, [onReady]);
  return null;
}

function ExplorerMediaView({
  explorerId,
  fileAccess,
  kind,
  mimeType,
  forceType = false,
  path,
  revision,
  onReady,
  onError,
}: {
  explorerId: string;
  fileAccess?: FileAccess;
  kind: ExplorerMediaKind;
  mimeType: string;
  forceType?: boolean;
  path: string;
  revision: number;
  onReady?(): void;
  onError?(error: unknown): void;
}) {
  const [failed, setFailed] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    if (failed) onError?.(new Error("Transferred media could not be loaded."));
    else if (source) onReady?.();
  }, [failed, source, onReady, onError]);
  useEffect(() => {
    let disposed = false;
    let objectUrl: string | null = null;
    setFailed(false);
    setSource(null);
    void (
      fileAccess
        ? forceType
          ? fileAccess.media(path, { kind, mimeType })
          : fileAccess.media(path)
        : forceType
          ? loadExplorerMedia(explorerId, path, { kind, mimeType })
          : loadExplorerMedia(explorerId, path)
    )
      .then((blob) =>
        forceType ? mediaBlobForViewer(blob, kind, mimeType) : blob,
      )
      .then((blob) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [explorerId, path, revision, fileAccess, forceType, kind, mimeType]);
  if (failed) {
    return (
      <div className="grid h-full place-items-center p-6">
        <p className="border-y border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          This media file could not be loaded.
        </p>
      </div>
    );
  }
  if (!source) {
    return (
      <div className="grid h-full place-items-center p-6">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (kind === "image") {
    return (
      <ExplorerImageViewport
        alt={path.split("/").at(-1) ?? path}
        onError={() => setFailed(true)}
        source={source}
      />
    );
  }
  if (kind === "audio") {
    return (
      <div className="grid h-full place-items-center p-6">
        <audio
          aria-label={path.split("/").at(-1) ?? path}
          className="w-full max-w-2xl"
          controls
          onError={() => setFailed(true)}
          preload="metadata"
          src={source}
        />
      </div>
    );
  }
  return (
    <div className="grid h-full place-items-center overflow-auto p-4">
      <video
        aria-label={path.split("/").at(-1) ?? path}
        className="max-h-full max-w-full"
        controls
        onError={() => setFailed(true)}
        playsInline
        preload="metadata"
        src={source}
      />
    </div>
  );
}

export interface ExplorerHeaderState {
  backLabel?: string;
  canEdit: boolean;
  canGoBack?: boolean;
  canVisual: boolean;
  directoryPath: string;
  dirty: boolean;
  fileMode: ExplorerFileMode;
  isFetching: boolean;
  isSaving: boolean;
  selectedPath: string | null;
  showFileClose?: boolean;
  back(): void;
  refresh(): void;
  openFileHistory?(): void;
  save(): Promise<boolean>;
  setFileMode(mode: ExplorerFileMode): void;
}

export interface ExplorerTransferState {
  explorerId: string;
  documentId?: string;
  projectId: string;
  worktreeId: string;
  workerId: string;
  selectedPath: string | null;
  fileMode: ExplorerFileMode;
  fileViewer?: string | null;
  documents: EditorSessionTransfer;
}

export interface ExplorerLifecycleActions {
  /** Hold a loaded, clean preview inert until its ownership operation settles. */
  reservePreviewReplacement?(): (() => void) | null;
  /** Freeze source input until ownership commits or cancellation is confirmed. */
  suspendTransfer?(): () => void;
  /** Detach rendered content but retain document sessions until commit/cancel. */
  retireTransfer?(): void;
  captureTransfer?(): Promise<ExplorerTransferState>;
  restoreTransfer?(state: ExplorerTransferState): void;
  cancelClose(): void;
  discard?(): void | Promise<void>;
  dirty: boolean;
  flushViewState(): Promise<boolean>;
  prepareClose(): Promise<void>;
  /** Only after authoritative tab closure, never on unmount or preparation. */
  closeCommitted?(): Promise<void>;
  reconcile(explorer: ExplorerSummary): Promise<void>;
  save(): Promise<boolean>;
}

export interface TransientExplorerFile {
  path: string;
  close(): void;
}

export interface ExplorerGraphRequest {
  explorerId: string;
  requestId: string;
  rootPath: string | null;
}

export interface ExplorerTransferStaging {
  onRestored(): void;
  onError(error: unknown): void;
}
export interface IncomingEditorView<T> {
  tabId: string;
  resource: T;
  state: ExplorerTransferState;
  staging?: ExplorerTransferStaging;
}

/** An editor view model, not an Explorer entity or a mutable tree selection. */
export interface FileDocumentEditorView {
  kind: "file-document";
  id: string;
  documentId: string;
  projectId: string;
  worktreeId: string;
  activeWorkerId: string;
  selectedPath: string;
  fileMode: ExplorerFileMode;
  title: string;
  setMode(mode: ExplorerFileMode): void | Promise<void>;
  openFile(path: string): void;
}
function isDocumentView(
  view: ExplorerSummary | FileDocumentEditorView,
): view is FileDocumentEditorView {
  return "kind" in view && view.kind === "file-document";
}

export function ExplorerView({
  documentRecovery,
  active = true,
  appearance,
  explorer,
  fileAccess,
  fileViewer: requestedViewer,
  graphRequest,
  gitStatus,
  onChanged,
  onHeaderChange,
  onLifecycleChange,
  keepInlineCodeWarm = false,
  onOpenFile,
  onOpenGraphFile,
  onRevealFolder,
  revealLabel,
  onOpenTerminal,
  repositoryGraphAvailable,
  showToolbar = true,
  transientFile,
  workerOnline = true,
  initialTransfer,
  transferStaging,
}: {
  documentRecovery?: import("./use-file-document-recovery").FileDocumentRecovery;
  /** Staged destination state; install before exposing interactive content. */
  initialTransfer?: ExplorerTransferState;
  transferStaging?: ExplorerTransferStaging;
  active?: boolean;
  appearance: CodeAppearance;
  explorer: ExplorerSummary | FileDocumentEditorView;
  fileAccess?: FileAccess;
  fileViewer?: string | null;
  graphRequest?: ExplorerGraphRequest | null;
  gitStatus?: GitStatus;
  onChanged?(explorer: ExplorerSummary): void;
  onHeaderChange?(state: ExplorerHeaderState | null): void;
  onLifecycleChange?(
    explorerId: string,
    actions: ExplorerLifecycleActions | null,
  ): void;
  keepInlineCodeWarm?: boolean;
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
  repositoryGraphAvailable: boolean;
  showToolbar?: boolean;
  transientFile?: TransientExplorerFile;
  workerOnline?: boolean;
}) {
  const surfaceInstanceId = useRef(crypto.randomUUID()).current;
  const transientFilePath = transientFile?.path;
  const transientFileCloseRef = useRef(transientFile?.close);
  transientFileCloseRef.current = transientFile?.close;
  const previousActiveRef = useRef(active);
  const [entryReplayKey, setEntryReplayKey] = useState(0);
  const [selectedPath, setSelectedPath] = useState(() =>
    explorerSurfaceSelectedPath({
      openFilesExternally: Boolean(onOpenFile),
      persistedPath: explorer.selectedPath,
      transientPath: transientFilePath,
    }),
  );
  const previousTransientPathRef = useRef(transientFilePath);
  const transientRestoreRef = useRef<{
    fileMode: ExplorerFileMode;
    selectedPath: string | null;
  } | null>(
    transientFilePath
      ? {
          fileMode: explorer.fileMode,
          selectedPath: explorerSurfaceSelectedPath({
            openFilesExternally: Boolean(onOpenFile),
            persistedPath: explorer.selectedPath,
          }),
        }
      : null,
  );

  useEffect(() => {
    const wasActive = previousActiveRef.current;
    previousActiveRef.current = active;
    if (!wasActive && active) {
      setEntryReplayKey((current) =>
        nextExplorerEntryReplayKey(current, wasActive, active),
      );
    }
  }, [active]);
  const [graphRootPath, setGraphRootPath] = useState<string | null | undefined>(
    undefined,
  );
  const [graphRefreshEpoch, setGraphRefreshEpoch] = useState(0);
  const [graphStatus, setGraphStatus] =
    useState<GitRepositoryGraphStatus | null>(null);
  const [revealedPath, setRevealedPath] = useState<string | null>(null);
  const [fileMode, setFileModeState] = useState<ExplorerFileMode>(() =>
    transientFilePath
      ? defaultExplorerFileMode(transientFilePath)
      : explorer.fileMode,
  );
  const [draft, setDraft] = useState("");
  const [documentViewRevision, setDocumentViewRevision] = useState(0);
  const checkpointDocumentView = useCallback(() => {
    setDocumentViewRevision((revision) => revision + 1);
  }, []);
  const sessions = useRef<EditorSessionStore | null>(null);
  sessions.current ??= new EditorSessionStore();
  const [nativeDocument, setNativeDocument] =
    useState<EditorDocumentSession | null>(null);
  const nativeDocumentRef = useRef<EditorDocumentSession | null>(null);
  nativeDocumentRef.current = nativeDocument;
  const [baselineContent, setBaselineContent] = useState("");
  const [draftVersion, setDraftVersion] = useState<string | null>(null);
  const [mediaRevision, setMediaRevision] = useState(0);
  const [viewStatePending, setViewStatePending] = useState(0);
  const [viewStateError, setViewStateError] = useState<string | null>(null);
  const streamEncryption = useExplorerWorkerEncryption(
    explorer,
    active ||
      keepInlineCodeWarm ||
      selectedPath !== null ||
      nativeDocument !== null,
  );
  const streamEncryptionReady = streamEncryption.ready;
  const workerWasOnlineRef = useRef(workerOnline);
  const onlineEncryptionRecoveryRef = useRef(false);
  useEffect(() => {
    if (!workerOnline) {
      workerWasOnlineRef.current = false;
      return;
    }
    if (!workerWasOnlineRef.current) {
      onlineEncryptionRecoveryRef.current = true;
    }
    workerWasOnlineRef.current = true;
  }, [workerOnline]);
  useEffect(() => {
    if (!onlineEncryptionRecoveryRef.current || !workerOnline) return;
    if (streamEncryptionReady) {
      onlineEncryptionRecoveryRef.current = false;
      return;
    }
    if (!streamEncryption.error) return;
    onlineEncryptionRecoveryRef.current = false;
    streamEncryption.retry();
  }, [
    streamEncryption.error,
    streamEncryption.retry,
    streamEncryptionReady,
    workerOnline,
  ]);
  const streamEncryptionBindingRef = useRef(streamEncryption.bindingKey);
  streamEncryptionBindingRef.current = streamEncryption.bindingKey;
  const streamEncryptionReadyRef = useRef(streamEncryptionReady);
  streamEncryptionReadyRef.current = streamEncryptionReady;
  const queryClient = useQueryClient();
  const mountedRef = useRef(true);
  const transferSuspendedRef = useRef(false);
  const [sourceTransferSuspended, setTransferSuspended] = useState(false);
  const transferSuspended = sourceTransferSuspended || Boolean(transferStaging);
  transferSuspendedRef.current = transferSuspended;
  const stagingRef = useRef(transferStaging);
  stagingRef.current = transferStaging;
  const [transferRetired, setTransferRetired] = useState(false);
  const transferInstallingRef = useRef(Boolean(initialTransfer));
  const [installedTransfer, setInstalledTransfer] = useState<{
    snapshot: ExplorerTransferState;
    resource: object;
  } | null>(null);
  const [transferInstallError, setTransferInstallError] = useState<
    string | null
  >(null);
  const selectedPathRef = useRef(selectedPath);
  const fileModeRef = useRef(fileMode);
  const draftRef = useRef(draft);
  const draftVersionRef = useRef(draftVersion);
  const dirtyRef = useRef(false);
  const [customDocument, setCustomDocument] = useState<{
    key: string;
    session: import("@/components/files/file-viewers").FileViewerSession;
  } | null>(null);
  const customKey = JSON.stringify([
    fileAccess?.cacheKey,
    explorer.projectId,
    explorer.worktreeId,
    selectedPath,
  ]);
  const customSession =
    customDocument?.key === customKey ? customDocument.session : null;
  const customSessionRef = useRef(customSession);
  customSessionRef.current = customSession;
  const reportCustomSession = useCallback(
    (
      session:
        import("@/components/files/file-viewers").FileViewerSession | null,
    ) => setCustomDocument(session ? { key: customKey, session } : null),
    [customKey],
  );
  const worktreeIdRef = useRef(explorer.worktreeId);
  const persistedViewStateRef = useRef({
    selectedPath: explorer.selectedPath,
    fileMode: explorer.fileMode,
  });
  const viewStateQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const [refreshPending, setRefreshPending] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const fileBinding = useMemo(
    () => ({
      workerId: explorer.activeWorkerId,
      projectId: explorer.projectId,
      worktreeId: explorer.worktreeId,
    }),
    [explorer.activeWorkerId, explorer.projectId, explorer.worktreeId],
  );
  const fileViewer =
    requestedViewer !== undefined
      ? requestedViewer
      : initialTransfer?.fileViewer;
  const fileViewerRef = useRef(fileViewer);
  fileViewerRef.current = fileViewer;
  const readingViewer = selectedPath
    ? resolveFileViewer(selectedPath, fileViewer)
    : null;
  const file = useQuery({
    retry: retryFileRead,
    // Once the actual full read selects paging, background filesystem events
    // must not restart it. Refresh explicitly fetches a new snapshot below.
    enabled: (query) =>
      Boolean(
        streamEncryptionReady &&
        selectedPath &&
        !readingViewer?.media &&
        !readingViewer?.custom &&
        !readingViewer?.unavailable &&
        !(readingViewer?.log && fileMode === "preview") &&
        !requiresTextPreview(query.state.error),
      ),
    queryFn: () =>
      fileAccess
        ? fileAccess.read(selectedPath!)
        : getExplorerFile(explorer.id, selectedPath!, fileBinding),
    queryKey: [
      "explorer-file",
      fileAccess?.cacheKey ?? explorer.id,
      selectedPath,
      streamEncryption.bindingKey,
    ],
  });
  const saveFile = useMutation({
    mutationFn: ({
      content,
      explorerId,
      path,
      version,
      binding,
    }: {
      content: string;
      explorerId: string;
      path: string;
      version: string;
      binding: typeof fileBinding;
    }) =>
      fileAccess
        ? fileAccess.save({ content, path, version })
        : saveExplorerFile(explorerId, { content, path, version }, binding),
  });
  const saveFileError = saveFile.error;
  const saveFilePending = saveFile.isPending;
  const mutateSaveFile = saveFile.mutateAsync;
  const resetSaveFile = saveFile.reset;
  const displayedSelectedPath = transientFilePath ?? selectedPath;
  const clientSession = getClientSession();
  const accountScope = JSON.stringify([
    clientSession?.serverId,
    clientSession?.user.id,
  ]);
  // A callback from an earlier checkout must not read the shared session store
  // under its old metadata, even if this component instance was reused.
  const transferResource = useMemo(
    () => ({}),
    [
      accountScope,
      explorer.id,
      explorer.projectId,
      explorer.worktreeId,
      explorer.activeWorkerId,
      isDocumentView(explorer) ? explorer.documentId : null,
      transientFilePath,
      surfaceInstanceId,
    ],
  );
  const liveTransferResourceRef = useRef(transferResource);
  liveTransferResourceRef.current = transferResource;
  // Initial state is consumed once per resource attachment. Ordinary file
  // navigation changes callback scope but must not replay the incoming draft.
  const initialTransferResource = useMemo(
    () => ({}),
    [
      accountScope,
      explorer.id,
      explorer.projectId,
      explorer.worktreeId,
      explorer.activeWorkerId,
      surfaceInstanceId,
      isDocumentView(explorer) ? explorer.documentId : null,
    ],
  );
  const transferInstalling = Boolean(
    initialTransfer &&
    (installedTransfer?.snapshot !== initialTransfer ||
      installedTransfer.resource !== initialTransferResource),
  );
  transferInstallingRef.current = transferInstalling;
  const assertTransferResource = useCallback(() => {
    if (
      !mountedRef.current ||
      liveTransferResourceRef.current !== transferResource
    )
      throw new Error("Editor transfer resource changed or was unmounted.");
  }, [transferResource]);
  const initializedAccountScopeRef = useRef<string | null>(null);
  useEffect(() => {
    if (initializedAccountScopeRef.current === accountScope) return;
    initializedAccountScopeRef.current = accountScope;
    sessions.current!.resetScope(accountScope);
    setNativeDocument(null);
    setDraft("");
    setBaselineContent("");
    setDraftVersion(null);
  }, [accountScope]);
  const nativeDocumentId = displayedSelectedPath
    ? editorDocumentId({
        server: clientSession?.serverId ?? "",
        account: clientSession?.user.id ?? "",
        worker: explorer.activeWorkerId,
        project: explorer.projectId,
        worktree: explorer.worktreeId,
        path: displayedSelectedPath,
      })
    : null;
  const viewer = resolveFileViewer(displayedSelectedPath ?? "", fileViewer);
  const editableLanguage =
    !displayedSelectedPath ||
    viewer.media ||
    viewer.custom ||
    viewer.unavailable
      ? null
      : "text";
  const structuredFormat = viewer.unavailable ? null : viewer.structuredFormat;
  const mediaType = viewer.media;
  const CustomFileViewer = viewer.custom;
  const graphVisible = graphRootPath !== undefined;
  const surfaceLifecycleState = {
    active,
    keepInlineCodeWarm,
    pathPresent: displayedSelectedPath !== null,
    transient: transientFilePath !== undefined,
  };
  const surfaceLifecycleStateRef = useRef(surfaceLifecycleState);
  surfaceLifecycleStateRef.current = surfaceLifecycleState;
  const previousSurfaceLifecycleStateRef = useRef<{
    active: boolean;
    keepInlineCodeWarm: boolean;
    path: string | null;
    transient: boolean;
  } | null>(null);
  const dirty = customSession
    ? customSession.dirty || customSession.pending
    : nativeDocument?.id === nativeDocumentId
      ? nativeDocument.dirty
      : draftVersion !== null && draft !== baselineContent;
  const hasDirtyDocuments = dirty || sessions.current!.hasDirtyDocuments;
  dirtyRef.current = dirty;
  const changeDraft = useCallback((text: string) => {
    if (transferSuspendedRef.current || transferInstallingRef.current) return;
    nativeDocumentRef.current?.editExternal(text);
    setDraft(text);
  }, []);
  draftRef.current = draft;
  draftVersionRef.current = draftVersion;
  selectedPathRef.current = selectedPath;
  fileModeRef.current = fileMode;

  useEffect(() => {
    mountedRef.current = true;
    clientLogger.info("Explorer surface opened", {
      ...explorerFileIntentContext(explorer.id),
      ...surfaceLifecycleStateRef.current,
      event: "explorer.surface.opened",
      lifecycleKind: "mounted",
      operation: "open-surface",
      projectId: explorer.projectId,
      subsystem: "explorer",
      surfaceId: explorer.id,
      surfaceInstanceId,
      worktreeId: explorer.worktreeId,
    });
    return () => {
      mountedRef.current = false;
      clientLogger.info("Explorer surface closed", {
        ...explorerFileIntentContext(explorer.id),
        ...surfaceLifecycleStateRef.current,
        event: "explorer.surface.closed",
        lifecycleKind: "unmounted",
        operation: "close-surface",
        projectId: explorer.projectId,
        subsystem: "explorer",
        surfaceId: explorer.id,
        surfaceInstanceId,
        worktreeId: explorer.worktreeId,
      });
    };
  }, [explorer.id, explorer.projectId, explorer.worktreeId, surfaceInstanceId]);

  useEffect(() => {
    const previous = previousSurfaceLifecycleStateRef.current;
    clientLogger.info("Explorer surface lifecycle state observed", {
      ...explorerFileIntentContext(explorer.id),
      ...surfaceLifecycleStateRef.current,
      event: "explorer.surface.lifecycle",
      lifecycleKind: previous ? "updated" : "initial",
      operation: "observe-surface",
      pathChanged: previous !== null && previous.path !== displayedSelectedPath,
      projectId: explorer.projectId,
      status: "observed",
      subsystem: "explorer",
      surfaceId: explorer.id,
      surfaceInstanceId,
      worktreeId: explorer.worktreeId,
    });
    previousSurfaceLifecycleStateRef.current = {
      ...surfaceLifecycleStateRef.current,
      path: displayedSelectedPath,
    };
  }, [
    active,
    displayedSelectedPath,
    explorer.id,
    explorer.projectId,
    explorer.worktreeId,
    keepInlineCodeWarm,
    surfaceInstanceId,
    transientFilePath,
  ]);

  useEffect(() => {
    setGraphRootPath(undefined);
    setGraphStatus(null);
    setRevealedPath(null);
  }, [explorer.id, explorer.worktreeId]);

  // Apply an explicit graph request after resetting the previous surface.
  // New graph tabs mount with their request already present.
  useEffect(() => {
    if (!graphRequest || graphRequest.explorerId !== explorer.id) return;
    setGraphStatus(null);
    setRevealedPath(null);
    setGraphRootPath(graphRequest.rootPath);
  }, [explorer.id, graphRequest]);

  const recoveryFetching = documentRecovery ? file.isFetching : false;
  useEffect(() => {
    if (
      transferSuspended ||
      transferInstalling ||
      !file.data ||
      requiresTextPreview(file.error) ||
      (selectedPath &&
        resolveFileViewer(selectedPath, fileViewer).log &&
        fileMode === "preview" &&
        !nativeDocument?.dirty) ||
      file.data.path !== selectedPath ||
      file.data.path !== displayedSelectedPath ||
      (draftVersion !== null &&
        nativeDocument?.id === nativeDocumentId &&
        (!documentRecovery ||
          nativeDocument.dirty ||
          nativeDocument.saving ||
          !file.isFetchedAfterMount ||
          recoveryFetching ||
          nativeDocument.version === file.data.version))
    ) {
      return;
    }
    if (!nativeDocumentId) return;
    const document = sessions.current!.open(
      nativeDocumentId,
      file.data.content,
      file.data.version,
    );
    setNativeDocument(document);
    setDraft(document.text);
    setBaselineContent(document.baseline);
    setDraftVersion(document.version);
  }, [
    transferSuspended,
    transferInstalling,
    draftVersion,
    file.data,
    file.error,
    fileMode,
    file.isFetchedAfterMount,
    recoveryFetching,
    documentRecovery,
    selectedPath,
    displayedSelectedPath,
    nativeDocumentId,
    nativeDocument,
  ]);

  const applyViewState = useCallback(
    (next: { selectedPath: string | null; fileMode: ExplorerFileMode }) => {
      const nextFileMode =
        next.selectedPath &&
        resolveFileViewer(next.selectedPath, fileViewerRef.current).media
          ? "preview"
          : next.fileMode;
      selectedPathRef.current = next.selectedPath;
      fileModeRef.current = nextFileMode;
      setSelectedPath(next.selectedPath);
      setFileModeState(nextFileMode);
    },
    [],
  );

  useEffect(() => {
    // A sidebar Open As command can update an already mounted document owner.
    // Reconcile presentation only; its live text session and draft stay intact.
    if (
      isDocumentView(explorer) &&
      !transferInstalling &&
      !transferSuspended &&
      explorer.fileMode !== fileModeRef.current
    ) {
      applyViewState({
        selectedPath: explorer.selectedPath,
        fileMode: explorer.fileMode,
      });
    }
  }, [explorer, applyViewState, transferInstalling, transferSuspended]);

  const persistViewState = useCallback(
    (next: { selectedPath: string | null; fileMode: ExplorerFileMode }) => {
      if (transferSuspendedRef.current || transferInstallingRef.current)
        return Promise.resolve(false);
      if (isDocumentView(explorer)) {
        if (next.selectedPath !== explorer.selectedPath)
          return Promise.resolve(false);
      }
      applyViewState(next);
      if (transientFilePath) return Promise.resolve(true);
      if (mountedRef.current) setViewStatePending((count) => count + 1);
      const operation = viewStateQueueRef.current.then(async () => {
        try {
          const updated = isDocumentView(explorer)
            ? (await explorer.setMode(next.fileMode), null)
            : await updateExplorerViewState(explorer.id, next);
          if (mountedRef.current) {
            setViewStateError(null);
            if (updated) onChanged?.(updated);
          }
          return true;
        } catch (error) {
          clientLogger.warn("Explorer view state failed to save", {
            event: "explorer.view-state.save.failed",
            operation: "save-view-state",
            reasonCode: "api-request-failed",
            subsystem: "explorer",
            surfaceId: explorer.id,
          });
          if (mountedRef.current) {
            setViewStateError(
              error instanceof Error
                ? error.message
                : "Explorer view state could not be saved.",
            );
          }
          return false;
        } finally {
          if (mountedRef.current) {
            setViewStatePending((count) => Math.max(0, count - 1));
          }
        }
      });
      viewStateQueueRef.current = operation;
      return operation;
    },
    [applyViewState, explorer, onChanged, transientFilePath],
  );

  const loadFile = useCallback(
    async (path: string, discardDraft = false) => {
      if (transferSuspendedRef.current || transferInstallingRef.current) return;
      const bindingKey = streamEncryptionBindingRef.current;
      const previous = nativeDocumentRef.current;
      const approvedRevision = previous?.revision;
      if (!streamEncryptionReadyRef.current || !bindingKey) return;
      if (
        resolveFileViewer(path, fileViewerRef.current).log &&
        fileModeRef.current === "preview" &&
        !dirtyRef.current
      ) {
        setPreviewRevision((revision) => revision + 1);
        return;
      }
      const refreshViewer = resolveFileViewer(path, fileViewerRef.current);
      if (refreshViewer.media || refreshViewer.custom) {
        if (refreshViewer.custom && customSessionRef.current) {
          if (
            !discardDraft &&
            (customSessionRef.current.dirty || customSessionRef.current.pending)
          )
            return;
          await customSessionRef.current.reload();
          return;
        }
        setMediaRevision((revision) => revision + 1);
        return;
      }
      await queryClient.invalidateQueries({
        exact: true,
        queryKey: [
          "explorer-file",
          fileAccess?.cacheKey ?? explorer.id,
          path,
          bindingKey,
        ],
        refetchType: "none",
      });
      let previewRequired = false;
      try {
        await queryClient.fetchQuery({
          retry: retryFileRead,
          queryFn: () =>
            fileAccess
              ? fileAccess.read(path)
              : getExplorerFile(explorer.id, path, fileBinding),
          queryKey: [
            "explorer-file",
            fileAccess?.cacheKey ?? explorer.id,
            path,
            bindingKey,
          ],
        });
      } catch (error) {
        if (!requiresTextPreview(error)) throw error;
        previewRequired = true;
      }
      if (
        !mountedRef.current ||
        transferSuspendedRef.current ||
        transferInstallingRef.current ||
        selectedPathRef.current !== path ||
        streamEncryptionBindingRef.current !== bindingKey
      ) {
        return;
      }
      if (previewRequired) setPreviewRevision((revision) => revision + 1);
      if (discardDraft && previous) {
        if (
          nativeDocumentRef.current !== previous ||
          previous.revision !== approvedRevision
        )
          throw new Error(
            "The document changed while reloading. Review the latest edits before discarding them.",
          );
        sessions.current!.discard(previous.id);
      }
      // Keep the live draft (and its recovery checkpoint) until the actual read
      // succeeds. A failed reload must not turn an approved discard into loss.
      setNativeDocument(null);
      setDraft("");
      setBaselineContent("");
      setDraftVersion(null);
      resetSaveFile();
      // The query result is installed by the identity-fenced document effect.
    },
    [explorer.id, queryClient, resetSaveFile, fileBinding, fileAccess],
  );

  useEffect(() => {
    const previousTransientPath = previousTransientPathRef.current;
    previousTransientPathRef.current = transientFilePath;
    if (!transientFilePath && !previousTransientPath) return;
    if (transientFilePath && transientFilePath === previousTransientPath)
      return;
    if (transientFilePath && !previousTransientPath) {
      transientRestoreRef.current = {
        fileMode: fileModeRef.current,
        selectedPath: selectedPathRef.current,
      };
    }
    const persistedViewState = {
      fileMode: explorer.fileMode,
      selectedPath: explorerSurfaceSelectedPath({
        openFilesExternally: Boolean(onOpenFile),
        persistedPath: explorer.selectedPath,
      }),
    };
    const transientWasPinned = Boolean(
      previousTransientPath &&
      !transientFilePath &&
      persistedViewState.selectedPath === previousTransientPath,
    );
    const nextViewState = transientFilePath
      ? {
          fileMode: defaultExplorerFileMode(transientFilePath),
          selectedPath: transientFilePath,
        }
      : transientWasPinned
        ? persistedViewState
        : (transientRestoreRef.current ?? persistedViewState);
    if (!transientFilePath) transientRestoreRef.current = null;
    if (
      nextViewState.selectedPath === selectedPathRef.current &&
      nextViewState.fileMode === fileModeRef.current
    ) {
      return;
    }
    setGraphRootPath(undefined);
    setGraphStatus(null);
    setRevealedPath(null);
    setDraft("");
    setBaselineContent("");
    setDraftVersion(null);
    resetSaveFile();
    applyViewState(nextViewState);
    if (
      nextViewState.selectedPath &&
      resolveFileViewer(nextViewState.selectedPath, fileViewerRef.current).media
    ) {
      setMediaRevision((revision) => revision + 1);
    }
  }, [
    applyViewState,
    explorer.fileMode,
    explorer.selectedPath,
    onOpenFile,
    resetSaveFile,
    transientFilePath,
  ]);

  const saveDraft = useCallback(async (): Promise<boolean> => {
    if (transferSuspendedRef.current || transferInstallingRef.current)
      return false;
    if (customSessionRef.current) return customSessionRef.current.save();
    const bindingKey = streamEncryptionBindingRef.current;
    const path = selectedPathRef.current;
    const version = draftVersionRef.current;
    if (
      !path ||
      !version ||
      (!dirtyRef.current && !nativeDocumentRef.current?.saving)
    )
      return true;
    const startedAt = performance.now();
    clientLogger.info("Explorer file save started", {
      event: "explorer.file.save.started",
      operation: "save-file",
      subsystem: "explorer",
      surfaceId: explorer.id,
    });
    try {
      const document = nativeDocumentRef.current;
      if (!document || document.id !== nativeDocumentId) return false;
      let savedFile: Awaited<ReturnType<typeof saveExplorerFile>> | undefined;
      await document.save(async (input) => {
        savedFile = await mutateSaveFile({
          ...input,
          explorerId: explorer.id,
          path,
          binding: fileBinding,
        });
        return savedFile;
      });
      if (!savedFile) return !document.dirty;
      if (bindingKey)
        queryClient.setQueryData(
          [
            "explorer-file",
            fileAccess?.cacheKey ?? explorer.id,
            savedFile.path,
            bindingKey,
          ],
          savedFile,
        );
      if (
        mountedRef.current &&
        selectedPathRef.current === savedFile.path &&
        streamEncryptionBindingRef.current === bindingKey
      ) {
        setDraft(document.text);
        setBaselineContent(document.baseline);
        setDraftVersion(document.version);
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: [
            "explorer-directory",
            explorer.projectId,
            explorer.worktreeId,
            explorer.id,
          ],
        }),
        queryClient.invalidateQueries({
          queryKey: [
            "explorer-directory-commits",
            explorer.projectId,
            explorer.worktreeId,
            explorer.id,
          ],
        }),
        queryClient.invalidateQueries({
          exact: true,
          queryKey: [
            "worktree-status",
            explorer.projectId,
            explorer.worktreeId,
          ],
        }),
      ]);
      clientLogger.info("Explorer file save completed", {
        durationMs: Math.round(performance.now() - startedAt),
        event: "explorer.file.save.completed",
        operation: "save-file",
        status: "completed",
        subsystem: "explorer",
        surfaceId: explorer.id,
      });
      return !document.dirty;
    } catch {
      clientLogger.warn("Explorer file save failed", {
        durationMs: Math.round(performance.now() - startedAt),
        event: "explorer.file.save.failed",
        operation: "save-file",
        reasonCode: "api-request-failed",
        status: "failed",
        subsystem: "explorer",
        surfaceId: explorer.id,
      });
      return false;
    }
  }, [
    explorer.id,
    explorer.projectId,
    explorer.worktreeId,
    queryClient,
    mutateSaveFile,
    saveFilePending,
    nativeDocumentId,
    fileBinding,
    fileAccess,
  ]);

  const reconcile = useCallback(
    async (persisted: ExplorerSummary) => {
      await viewStateQueueRef.current;
      if (transferSuspendedRef.current || transferInstallingRef.current) return;
      worktreeIdRef.current = persisted.worktreeId;
      const nextSelectedPath = explorerSurfaceSelectedPath({
        openFilesExternally: Boolean(onOpenFile),
        persistedPath: persisted.selectedPath,
        transientPath: transientFilePath,
      });
      applyViewState({
        selectedPath: nextSelectedPath,
        fileMode: transientFilePath ? fileModeRef.current : persisted.fileMode,
      });
      onChanged?.(persisted);
      if (nextSelectedPath) {
        await loadFile(nextSelectedPath).catch(() => undefined);
      } else {
        setDraft("");
        setBaselineContent("");
        setDraftVersion(null);
        resetSaveFile();
      }
    },
    [
      applyViewState,
      loadFile,
      onChanged,
      onOpenFile,
      resetSaveFile,
      transientFilePath,
    ],
  );

  useEffect(() => {
    // Desktop Explorer surfaces remain file browsers. Their editor windows are
    // transient and must not be pulled back inline by legacy saved view state.
    if (
      transferSuspended ||
      transientFilePath ||
      onOpenFile ||
      isDocumentView(explorer)
    )
      return;
    const worktreeChanged = worktreeIdRef.current !== explorer.worktreeId;
    const previous = persistedViewStateRef.current;
    // A local open/mode change can render before the query publishes its saved
    // summary. Only changed persisted state may replace that local intent.
    const viewStateChanged =
      explorer.selectedPath !== previous.selectedPath ||
      explorer.fileMode !== previous.fileMode;
    if (
      viewStatePending > 0 ||
      (!worktreeChanged && (!viewStateChanged || dirtyRef.current))
    ) {
      return;
    }
    persistedViewStateRef.current = {
      selectedPath: explorer.selectedPath,
      fileMode: explorer.fileMode,
    };
    if (
      !worktreeChanged &&
      explorer.selectedPath === selectedPathRef.current &&
      explorer.fileMode === fileModeRef.current
    ) {
      return;
    }
    void reconcile(explorer);
  }, [
    explorer,
    explorer.fileMode,
    explorer.selectedPath,
    explorer.worktreeId,
    onOpenFile,
    reconcile,
    transferSuspended,
    transientFilePath,
    viewStatePending,
  ]);

  const confirmCurrentDocumentDiscard = useCallback(async (message: string) => {
    const resource = liveTransferResourceRef.current;
    const document = nativeDocumentRef.current;
    const revision = document?.revision;
    const custom = customSessionRef.current;
    const customRevision = custom?.revision;
    if (custom?.saving) {
      setViewStateError(
        "Wait for the NBT save to finish before reloading or closing this file.",
      );
      return false;
    }
    if (dirtyRef.current || custom?.dirty || custom?.pending) {
      try {
        if (!(await confirmEditorAction(message))) return false;
      } catch (error) {
        if (mountedRef.current)
          setViewStateError(
            error instanceof Error
              ? error.message
              : "File confirmation failed.",
          );
        return false;
      }
    }
    // A native dialog is asynchronous. Approval for one document revision must
    // never discard edits made later or a newly selected/transferred document.
    return (
      mountedRef.current &&
      liveTransferResourceRef.current === resource &&
      !transferSuspendedRef.current &&
      !transferInstallingRef.current &&
      nativeDocumentRef.current === document &&
      document?.revision === revision &&
      customSessionRef.current?.discard === custom?.discard &&
      customSessionRef.current?.revision === customRevision
    );
  }, []);

  const refreshExplorer = useCallback(async () => {
    if (transferSuspendedRef.current) return;
    if (!streamEncryptionReadyRef.current) return;
    if (
      !(await confirmCurrentDocumentDiscard(
        "Reload this file and discard its unsaved changes?",
      ))
    ) {
      return;
    }
    setRefreshPending(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: [
            "explorer-directory",
            explorer.projectId,
            explorer.worktreeId,
            explorer.id,
          ],
        }),
        queryClient.invalidateQueries({
          queryKey: [
            "explorer-directory-commits",
            explorer.projectId,
            explorer.worktreeId,
            explorer.id,
          ],
        }),
        queryClient.invalidateQueries({
          exact: true,
          queryKey: [
            "worktree-status",
            explorer.projectId,
            explorer.worktreeId,
          ],
        }),
        selectedPathRef.current
          ? loadFile(selectedPathRef.current, true)
          : Promise.resolve(),
      ]);
    } catch (error) {
      setViewStateError(
        error instanceof Error
          ? error.message
          : "The file could not be reloaded.",
      );
      throw error;
    } finally {
      setRefreshPending(false);
    }
  }, [
    confirmCurrentDocumentDiscard,
    explorer.id,
    explorer.projectId,
    explorer.worktreeId,
    loadFile,
    queryClient,
  ]);

  const back = useCallback(async () => {
    if (transferSuspendedRef.current || transferInstallingRef.current) return;
    if (graphRootPath !== undefined) {
      setGraphRootPath(undefined);
      setGraphStatus(null);
      return;
    }
    if (
      !(await confirmCurrentDocumentDiscard(
        "Close this file and discard its unsaved changes?",
      ))
    ) {
      return;
    }
    if (transientFilePath) {
      try {
        if (customSessionRef.current) await customSessionRef.current.discard();
      } catch (error) {
        setViewStateError(
          error instanceof Error
            ? error.message
            : "The draft could not be discarded.",
        );
        return;
      }
      const document = nativeDocumentRef.current;
      if (dirtyRef.current && document) sessions.current!.discard(document.id);
      transientFileCloseRef.current?.();
      return;
    }
    const document = nativeDocumentRef.current;
    try {
      if (customSessionRef.current) await customSessionRef.current.discard();
    } catch (error) {
      setViewStateError(
        error instanceof Error
          ? error.message
          : "The draft could not be discarded.",
      );
      return;
    }
    if (dirtyRef.current && document) sessions.current!.discard(document.id);
    setNativeDocument(null);
    setDraft("");
    setBaselineContent("");
    setDraftVersion(null);
    resetSaveFile();
    void persistViewState({ selectedPath: null, fileMode: "preview" });
  }, [
    confirmCurrentDocumentDiscard,
    graphRootPath,
    persistViewState,
    resetSaveFile,
    transientFilePath,
  ]);

  const changeFileMode = useCallback(
    (mode: ExplorerFileMode) => {
      if (transferSuspendedRef.current) return;
      const path = selectedPathRef.current;
      if (
        !path ||
        (mode === "edit" &&
          resolveFileViewer(path, fileViewer).media !== null) ||
        (mode === "visual" &&
          !resolveFileViewer(path, fileViewer).structuredFormat)
      ) {
        return;
      }
      void (async () => {
        if (selectedPathRef.current !== path) return;
        await persistViewState({ selectedPath: path, fileMode: mode });
      })();
    },
    [persistViewState, fileViewer],
  );

  const largeTextPreview = requiresTextPreview(file.error) && !dirty;
  const panelHeader = useMemo<ExplorerHeaderState>(
    () => ({
      backLabel: graphVisible ? "Close graph" : undefined,
      back,
      canEdit: !graphVisible && !largeTextPreview && editableLanguage !== null,
      canGoBack:
        !isDocumentView(explorer) && (graphVisible || Boolean(selectedPath)),
      canVisual:
        !graphVisible && !largeTextPreview && structuredFormat !== null,
      directoryPath: graphVisible
        ? (graphRootPath ?? "")
        : (selectedPath ?? ""),
      dirty,
      fileMode: graphVisible || largeTextPreview ? "preview" : fileMode,
      isFetching: graphVisible
        ? (graphStatus?.isFetching ?? false)
        : refreshPending,
      isSaving: saveFilePending || Boolean(customSession?.saving),
      refresh: graphVisible
        ? () => setGraphRefreshEpoch((epoch) => epoch + 1)
        : refreshExplorer,
      openFileHistory:
        !graphVisible && selectedPath
          ? () =>
              requestGitFileHistory({
                projectId: explorer.projectId,
                worktreeId: explorer.worktreeId,
                path: selectedPath,
              })
          : undefined,
      save: saveDraft,
      selectedPath: graphVisible ? null : selectedPath,
      // Persisted file selections have their own workspace tab close control.
      // Transient previews still need a way back to their containing Explorer.
      showFileClose: Boolean(transientFilePath) || !explorer.selectedPath,
      setFileMode: changeFileMode,
    }),
    [
      active,
      back,
      changeFileMode,
      dirty,
      editableLanguage,
      largeTextPreview,
      explorer.projectId,
      explorer.selectedPath,
      explorer.worktreeId,
      refreshPending,
      fileMode,
      graphRootPath,
      graphStatus?.isFetching,
      graphVisible,
      refreshExplorer,
      saveDraft,
      saveFilePending,
      customSession?.saving,
      selectedPath,
      structuredFormat,
      transientFilePath,
      mediaType,
    ],
  );

  useEffect(() => {
    if (active) onHeaderChange?.(panelHeader);
  }, [active, onHeaderChange, panelHeader]);

  useEffect(() => {
    return () => {
      if (active) onHeaderChange?.(null);
    };
  }, [active, onHeaderChange]);

  const closePreparedRef = useRef(false);
  const prepareClose = useCallback(async () => {
    if (transferSuspendedRef.current || transferInstallingRef.current)
      throw new Error("Wait for the editor transfer before closing this view.");
    const resource = liveTransferResourceRef.current;
    const isCurrent = sessions.current!.captureCloseGuard();
    const custom = customSessionRef.current;
    const customRevision = custom?.revision;
    if (custom?.saving)
      throw new Error(
        "Wait for the NBT save to finish before closing this view.",
      );
    if (
      (dirtyRef.current ||
        sessions.current!.hasDirtyDocuments ||
        custom?.dirty ||
        custom?.pending) &&
      !(await confirmEditorAction(
        "Close this view with unsaved changes? Cancel to keep editing or save your files first.",
      ))
    )
      throw new Error("Editor view close canceled.");
    if (
      !mountedRef.current ||
      resource !== liveTransferResourceRef.current ||
      transferSuspendedRef.current ||
      transferInstallingRef.current ||
      !isCurrent() ||
      customSessionRef.current?.discard !== custom?.discard ||
      customSessionRef.current?.revision !== customRevision
    )
      throw new Error(
        "Editor changed while confirming close. Try closing again.",
      );
    // Preparation is not a committed close. Keep buffers and recovery intact:
    // a rejected layout mutation must leave the editor exactly as it was.
    // Freeze input so approval cannot silently cover edits made while the
    // authoritative close request is in flight. Cancellation releases only
    // this close's reservation, never an unrelated transfer reservation.
    closePreparedRef.current = true;
    transferSuspendedRef.current = true;
    flushSync(() => setTransferSuspended(true));
  }, []);
  const cancelClose = useCallback(() => {
    if (!closePreparedRef.current) return;
    closePreparedRef.current = false;
    transferSuspendedRef.current = false;
    if (mountedRef.current) flushSync(() => setTransferSuspended(false));
  }, []);
  const lifecycle = useMemo<ExplorerLifecycleActions>(
    () => ({
      reservePreviewReplacement: (): (() => void) | null => {
        const document = nativeDocumentRef.current;
        if (
          !mountedRef.current ||
          transferSuspendedRef.current ||
          transferInstallingRef.current ||
          dirtyRef.current ||
          customSessionRef.current?.saving ||
          customSessionRef.current?.dirty ||
          customSessionRef.current?.pending ||
          sessions.current!.hasDirtyDocuments ||
          (!mediaType &&
            !customSessionRef.current &&
            (!document ||
              document.id !== nativeDocumentId ||
              document.dirty ||
              document.saving))
        )
          return null;
        return transferLifecycleRef.current.suspendTransfer?.() ?? null;
      },
      suspendTransfer: () => {
        assertTransferResource();
        const session = getClientSession();
        if (
          accountScope !== JSON.stringify([session?.serverId, session?.user.id])
        )
          throw new Error("Editor transfer account changed before suspension.");
        if (!mountedRef.current || transferSuspendedRef.current)
          throw new Error("Editor is unavailable or already transferring.");
        transferSuspendedRef.current = true;
        // Commit readOnly/inert before capture, not at a later React batch.
        flushSync(() => setTransferSuspended(true));
        let released = false;
        return () => {
          if (released) return;
          released = true;
          transferSuspendedRef.current = false;
          if (mountedRef.current)
            flushSync(() => {
              setTransferRetired(false);
              setTransferSuspended(false);
            });
        };
      },
      retireTransfer: () => {
        assertTransferResource();
        const session = getClientSession();
        if (
          accountScope !== JSON.stringify([session?.serverId, session?.user.id])
        )
          throw new Error("Editor transfer account changed before retirement.");
        if (!transferSuspendedRef.current)
          throw new Error("Editor must be suspended before retirement.");
        // The parent owns the protected sessions. Unmount only the rendered
        // content, so cancellation can reattach the same dirty documents.
        flushSync(() => setTransferRetired(true));
      },
      captureTransfer: async () => {
        if (
          customSessionRef.current?.dirty ||
          customSessionRef.current?.pending ||
          customSessionRef.current?.saving
        )
          throw new Error(
            "Save this NBT draft before moving or quitting its window.",
          );
        assertTransferResource();
        await viewStateQueueRef.current;
        assertTransferResource();
        const documents = await sessions.current!.captureTransfer();
        assertTransferResource();
        const session = getClientSession();
        if (
          documents.scope !== accountScope ||
          accountScope !== JSON.stringify([session?.serverId, session?.user.id])
        )
          throw new Error("Editor transfer account changed during capture.");
        const state: ExplorerTransferState = {
          explorerId: explorer.id,
          ...(isDocumentView(explorer)
            ? { documentId: explorer.documentId }
            : {}),
          projectId: explorer.projectId,
          worktreeId: explorer.worktreeId,
          workerId: explorer.activeWorkerId,
          selectedPath: transientFilePath ?? selectedPathRef.current,
          fileMode: fileModeRef.current,
          ...(fileViewerRef.current !== undefined
            ? { fileViewer: fileViewerRef.current }
            : {}),
          documents,
        };
        await documentRecovery?.checkpoint(state);
        assertTransferResource();
        return state;
      },
      restoreTransfer: (state) => {
        assertTransferResource();
        const session = getClientSession();
        if (
          state.documents.scope !== accountScope ||
          accountScope !== JSON.stringify([session?.serverId, session?.user.id])
        )
          throw new Error("Editor transfer belongs to another account scope.");
        if (
          state.explorerId !== explorer.id ||
          state.projectId !== explorer.projectId ||
          state.worktreeId !== explorer.worktreeId ||
          state.workerId !== explorer.activeWorkerId
        )
          throw new Error("Editor transfer belongs to another resource scope.");
        state = validateExplorerTransfer(state, {
          serverId: session?.serverId ?? "",
          ownerId: session?.user.id ?? "",
          explorerId: explorer.id,
          ...(isDocumentView(explorer)
            ? {
                documentId: explorer.documentId,
                documentPath: explorer.selectedPath,
              }
            : {}),
          projectId: explorer.projectId,
          workerId: explorer.activeWorkerId,
          worktreeId: explorer.worktreeId,
        });
        sessions.current!.restoreTransfer(state.documents);
        applyViewState({
          selectedPath: state.selectedPath,
          fileMode: state.fileMode,
        });
        const document = state.selectedPath
          ? sessions.current!.get(
              editorDocumentId({
                server: session?.serverId ?? "",
                account: session?.user.id ?? "",
                worker: explorer.activeWorkerId,
                project: explorer.projectId,
                worktree: explorer.worktreeId,
                path: state.selectedPath,
              }),
            )
          : undefined;
        setNativeDocument(document ?? null);
        setDraft(document?.text ?? "");
        setBaselineContent(document?.baseline ?? "");
        setDraftVersion(document?.version ?? null);
      },
      cancelClose,
      discard: async () => {
        if (transferSuspendedRef.current || transferInstallingRef.current)
          return;
        if (customSessionRef.current) {
          await customSessionRef.current.discard();
          return;
        }
        sessions.current!.discardAll();
        setNativeDocument(null);
        setDraft("");
        setBaselineContent("");
        setDraftVersion(null);
        resetSaveFile();
      },
      dirty: hasDirtyDocuments,
      flushViewState: () => viewStateQueueRef.current,
      prepareClose,
      closeCommitted: async () => {
        await customSession?.discard();
        await documentRecovery?.closeCommitted();
      },
      reconcile,
      save: async () => {
        if (!(await saveDraft())) return false;
        if (sessions.current!.hasDirtyDocuments) {
          setViewStateError(
            "Other files in this Explorer still have unsaved changes. Open them to save before closing or switching worktrees.",
          );
          return false;
        }
        return true;
      },
    }),
    [
      documentRecovery,
      assertTransferResource,
      explorer.id,
      explorer.projectId,
      explorer.worktreeId,
      explorer.activeWorkerId,
      transientFilePath,
      applyViewState,
      accountScope,
      cancelClose,
      hasDirtyDocuments,
      customSession,
      explorer,
      mediaType,
      nativeDocumentId,
      prepareClose,
      reconcile,
      saveDraft,
      resetSaveFile,
    ],
  );

  const transferLifecycleRef = useRef(lifecycle);
  useEditorQuit(lifecycle, Boolean(documentRecovery));
  transferLifecycleRef.current = lifecycle;
  useEffect(() => {
    if (
      !documentRecovery ||
      !nativeDocument ||
      transferInstalling ||
      transferStaging ||
      transferSuspended
    )
      return;
    const state: ExplorerTransferState = {
      explorerId: explorer.id,
      ...(isDocumentView(explorer) ? { documentId: explorer.documentId } : {}),
      projectId: explorer.projectId,
      worktreeId: explorer.worktreeId,
      workerId: explorer.activeWorkerId,
      selectedPath: transientFilePath ?? selectedPathRef.current,
      fileMode: fileModeRef.current,
      ...(fileViewerRef.current !== undefined
        ? { fileViewer: fileViewerRef.current }
        : {}),
      documents: sessions.current!.captureRecovery(),
    };
    // The recovery owner surfaces errors and retains the prior ciphertext.
    void documentRecovery.checkpoint(state).catch(() => {});
  }, [
    documentRecovery,
    nativeDocument,
    draft,
    draftVersion,
    baselineContent,
    fileMode,
    documentViewRevision,
    transferInstalling,
    transferStaging,
    transferSuspended,
    explorer.id,
    explorer.projectId,
    explorer.worktreeId,
    explorer.activeWorkerId,
    transientFilePath,
  ]);
  const installedTransferRef = useRef(installedTransfer);
  useEffect(() => {
    if (!initialTransfer) return;
    if (
      installedTransferRef.current?.snapshot === initialTransfer &&
      installedTransferRef.current.resource === initialTransferResource
    )
      return;
    try {
      transferLifecycleRef.current.restoreTransfer!(initialTransfer);
      const installed = {
        snapshot: initialTransfer,
        resource: initialTransferResource,
      };
      installedTransferRef.current = installed;
      setInstalledTransfer(installed);
      setTransferInstallError(null);
    } catch (error) {
      stagingRef.current?.onError(error);
      setTransferInstallError(
        error instanceof Error
          ? error.message
          : "Editor transfer could not be installed.",
      );
    }
  }, [initialTransfer, initialTransferResource]);

  const onTransferredViewReady = useCallback(() => {
    if (
      !mountedRef.current ||
      !initialTransfer ||
      installedTransferRef.current?.snapshot !== initialTransfer ||
      installedTransferRef.current.resource !== initialTransferResource
    )
      return;
    try {
      assertTransferResource();
      stagingRef.current?.onRestored();
    } catch (error) {
      stagingRef.current?.onError(error);
    }
  }, [initialTransfer, initialTransferResource, assertTransferResource]);
  const onTransferredDocumentReady = useCallback(
    (document: EditorDocumentSession) => {
      if (nativeDocumentRef.current === document) onTransferredViewReady();
    },
    [onTransferredViewReady],
  );
  const onTransferredViewError = useCallback((error: unknown) => {
    if (mountedRef.current) stagingRef.current?.onError(error);
  }, []);
  useEffect(() => {
    if (transferInstalling || !transferStaging) return;
    if (viewer.unavailable)
      onTransferredViewError(
        new Error(`The ${viewer.unavailable} viewer is unavailable.`),
      );
    else if (!selectedPath) onTransferredViewReady();
    else if (
      !mediaType &&
      !viewer.custom &&
      !(
        selectedPath &&
        resolveFileViewer(selectedPath, fileViewer).log &&
        fileMode === "preview"
      ) &&
      file.isError &&
      !requiresTextPreview(file.error)
    )
      onTransferredViewError(file.error);
    else if (
      !mediaType &&
      !viewer.custom &&
      file.data &&
      fileMode !== "edit" &&
      !(fileMode === "visual" && structuredFormat) &&
      (viewer.markdown || viewer.license)
    )
      onTransferredViewReady();
  }, [
    transferInstalling,
    transferStaging,
    selectedPath,
    mediaType,
    viewer.custom,
    viewer.unavailable,
    viewer.markdown,
    viewer.license,
    fileViewer,
    file.isError,
    file.error,
    file.data,
    fileMode,
    structuredFormat,
    onTransferredViewReady,
    onTransferredViewError,
  ]);

  useEffect(() => {
    onLifecycleChange?.(explorer.id, lifecycle);
  }, [explorer.id, lifecycle, onLifecycleChange]);
  useEffect(
    () => () => onLifecycleChange?.(explorer.id, null),
    [explorer.id, onLifecycleChange],
  );

  useEffect(() => {
    if (!hasDirtyDocuments) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasDirtyDocuments]);

  const openEntry = (entry: ExplorerEntry) => {
    if (transferSuspendedRef.current) return;
    if (entry.kind !== "file" || !entry.viewable) return;
    if (isDocumentView(explorer)) {
      explorer.openFile(entry.path);
      return;
    }
    if (onOpenFile) {
      setViewStateError(null);
      void Promise.resolve(onOpenFile(explorer, entry)).catch(
        (error: unknown) => {
          if (!mountedRef.current) return;
          setViewStateError(
            error instanceof Error
              ? error.message
              : "The file editor window could not be opened.",
          );
        },
      );
      return;
    }
    setNativeDocument(null);
    setDraft("");
    setBaselineContent("");
    setDraftVersion(null);
    resetSaveFile();
    if (resolveFileViewer(entry.path, fileViewerRef.current).media) {
      setMediaRevision((revision) => revision + 1);
    }
    void persistViewState({
      selectedPath: entry.path,
      fileMode: defaultExplorerFileMode(entry.path),
    });
  };

  const revealEntry = (entry: ExplorerEntry, localFolder: boolean) => {
    if (!onRevealFolder || isDocumentView(explorer)) return;
    setViewStateError(null);
    void Promise.resolve(onRevealFolder(explorer, entry, localFolder)).catch(
      (error: unknown) => {
        if (!mountedRef.current) return;
        setViewStateError(
          error instanceof Error
            ? error.message
            : "The entry could not be revealed.",
        );
      },
    );
  };

  const openGraph = (rootPath: string | null) => {
    setGraphStatus(null);
    setRevealedPath(null);
    setGraphRootPath(rootPath);
  };

  const openGraphFile = (path: string) => {
    if (onOpenGraphFile) {
      if (isDocumentView(explorer)) explorer.openFile(path);
      else onOpenGraphFile(explorer, path);
      return;
    }
    if (!onOpenFile) setGraphRootPath(undefined);
    openEntry(explorerFileEntryForGraphPath(path));
  };

  const panelScrollRef = usePanelScrollDivider(
    `${nativeDocumentId ?? selectedPath ?? ""}:${fileMode}`,
    active && showToolbar && Boolean(selectedPath) && !graphVisible,
  );
  return (
    <div
      ref={panelScrollRef}
      data-panel-scroll-root=""
      aria-hidden={!active}
      inert={
        active && !transferSuspended && !transferInstalling ? undefined : true
      }
      aria-busy={transferSuspended || transferInstalling || undefined}
      className={cn(
        "min-h-0 flex-1 flex-col overflow-hidden",
        active ? "flex" : "pointer-events-none invisible absolute inset-0 flex",
      )}
      data-slot="explorer-view"
    >
      {showToolbar ? (
        <PanelToolbar
          aria-label="File controls"
          scrollDivider={Boolean(selectedPath) && !graphVisible}
        >
          <span
            className="min-w-0 flex-1 truncate text-muted-foreground"
            title={
              graphVisible
                ? (graphRootPath ?? "Repository graph")
                : (selectedPath ?? explorer.title)
            }
          >
            {graphVisible
              ? graphRootPath || "Repository graph"
              : (selectedPath ?? explorer.title)}
          </span>
          <ExplorerHeaderActions compact header={panelHeader} />
          <ExplorerFileCloseButton header={panelHeader} />
        </PanelToolbar>
      ) : null}
      {transferRetired ? (
        <div role="status" className="p-4 text-sm text-muted-foreground">
          Moving editor to another window…
        </div>
      ) : transferInstalling ? (
        <div
          role={transferInstallError ? "alert" : "status"}
          className="p-4 text-sm text-muted-foreground"
        >
          {transferInstallError ?? "Restoring transferred editor…"}
        </div>
      ) : !streamEncryptionReady &&
        !(nativeDocument?.id === nativeDocumentId) ? (
        <div className="grid h-full flex-1 place-items-center p-6 text-sm text-muted-foreground">
          {streamEncryption.error ? (
            <div className="space-y-3 text-center">
              <p>{streamEncryption.error}</p>
              <Button
                onClick={streamEncryption.retry}
                size="sm"
                type="button"
                variant="outline"
              >
                Retry
              </Button>
            </div>
          ) : (
            <Loader2 className="size-5 animate-spin" />
          )}
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {!graphVisible &&
          selectedPath &&
          (saveFileError || viewStateError) ? (
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
              <span className="min-w-0 truncate">
                {saveFileError instanceof Error
                  ? saveFileError.message
                  : (viewStateError ?? "File could not be saved.")}
              </span>
              <Button
                className="h-6 px-2 text-[10px]"
                onClick={() => void refreshExplorer()}
                size="sm"
                type="button"
                variant="outline"
              >
                Reload from disk
              </Button>
            </div>
          ) : null}
          {graphVisible ? (
            <GitRepositoryGraphView
              projectId={explorer.projectId}
              refreshEpoch={graphRefreshEpoch}
              rootPath={graphRootPath}
              worktreeId={explorer.worktreeId}
              onActivateFile={openGraphFile}
              onBack={back}
              onRevealNode={(node) => {
                setRevealedPath(node.path || null);
                setGraphRootPath(undefined);
                setGraphStatus(null);
              }}
              onStatusChange={setGraphStatus}
            />
          ) : selectedPath ? (
            <div className="min-h-0 flex-1 overflow-hidden">
              {viewer.unavailable ? (
                <p role="alert" className="m-4 text-sm text-destructive">
                  The {viewer.unavailable} viewer is unavailable in this
                  version. Choose Open As → Automatic to use the default viewer.
                </p>
              ) : CustomFileViewer ? (
                <CustomFileViewer
                  path={selectedPath}
                  explorerId={explorer.id}
                  documentId={
                    isDocumentView(explorer) ? explorer.documentId : undefined
                  }
                  projectId={explorer.projectId}
                  worktreeId={explorer.worktreeId}
                  workerId={explorer.activeWorkerId}
                  appearance={appearance}
                  fileAccess={fileAccess}
                  active={active && !transferSuspended}
                  readOnly={transferSuspended}
                  onSessionChange={reportCustomSession}
                  onOpenDocument={
                    isDocumentView(explorer) ? explorer.openFile : undefined
                  }
                  revision={mediaRevision}
                  onReady={onTransferredViewReady}
                  onError={onTransferredViewError}
                />
              ) : mediaType ? (
                <ExplorerMediaView
                  explorerId={explorer.id}
                  fileAccess={fileAccess}
                  key={`${selectedPath}:${fileViewer ?? "auto"}:${mediaRevision}`}
                  forceType={Boolean(fileViewer)}
                  kind={mediaType.kind}
                  mimeType={mediaType.mimeType}
                  path={selectedPath}
                  revision={mediaRevision}
                  onReady={onTransferredViewReady}
                  onError={onTransferredViewError}
                />
              ) : resolveFileViewer(selectedPath, fileViewer).log &&
                (fileMode === "preview" || largeTextPreview) &&
                !dirty ? (
                <LogFileView
                  key={`log:${fileAccess?.cacheKey ?? explorer.id}:${selectedPath}:${streamEncryption.bindingKey}:${previewRevision}`}
                  path={selectedPath}
                  active={active && !transferSuspended}
                  staging={Boolean(transferStaging)}
                  readTail={async (cursor) => {
                    if (fileAccess) {
                      if (!fileAccess.tail)
                        throw new Error(
                          "This file source does not support log following.",
                        );
                      return fileAccess.tail(selectedPath, cursor);
                    }
                    const result = await executeExplorerOperation(
                      explorer.id,
                      {
                        type: "explorer.file.tail",
                        path: selectedPath,
                        cursor,
                      },
                      undefined,
                      undefined,
                      fileBinding,
                    );
                    if (result.type !== "explorer.file.tail")
                      throw new Error("Unexpected log tail result.");
                    return result.value;
                  }}
                  onReady={onTransferredViewReady}
                  onError={onTransferredViewError}
                />
              ) : nativeDocument?.id === nativeDocumentId &&
                fileMode === "edit" &&
                !largeTextPreview ? (
                <NativeCodeEditor
                  session={nativeDocument}
                  path={selectedPath}
                  highlightPath={viewer.syntaxPath}
                  active={active && !transferSuspended}
                  readOnly={transferSuspended}
                  onReady={onTransferredDocumentReady}
                  onViewStateChange={checkpointDocumentView}
                  onChange={changeDraft}
                  onSave={() => void saveDraft()}
                />
              ) : file.isLoading ? (
                <div className="grid h-full place-items-center text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                </div>
              ) : file.isError && requiresTextPreview(file.error) ? (
                <PagedTextPreview
                  key={`${fileAccess?.cacheKey ?? explorer.id}:${selectedPath}:${streamEncryption.bindingKey}:${previewRevision}`}
                  path={selectedPath}
                  highlightPath={viewer.syntaxPath}
                  active={active && !transferSuspended}
                  readPage={async (offset, version) => {
                    if (fileAccess) {
                      if (!fileAccess.preview)
                        throw new Error(
                          "This file source does not support paged previews.",
                        );
                      return fileAccess.preview(selectedPath, offset, version);
                    }
                    const result = await executeExplorerOperation(
                      explorer.id,
                      {
                        type: "explorer.file.preview",
                        path: selectedPath,
                        offset,
                        version,
                      },
                      undefined,
                      undefined,
                      fileBinding,
                    );
                    if (result.type !== "explorer.file.preview")
                      throw new Error("Unexpected text preview result.");
                    return result.value;
                  }}
                  onReady={onTransferredViewReady}
                  onError={onTransferredViewError}
                />
              ) : file.isError ? (
                <p className="m-4 border-y border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                  {file.error instanceof Error
                    ? file.error.message
                    : "File could not be loaded."}
                </p>
              ) : file.data && fileMode === "preview" && viewer.license ? (
                <LicenseFileView
                  content={draftVersion === null ? file.data.content : draft}
                  path={file.data.path}
                />
              ) : file.data && fileMode === "visual" && structuredFormat ? (
                <Suspense
                  fallback={
                    <div className="grid h-full place-items-center text-muted-foreground">
                      <Loader2 className="size-5 animate-spin" />
                    </div>
                  }
                >
                  <StructuredFileVisual
                    content={draftVersion === null ? file.data.content : draft}
                    format={structuredFormat}
                    onChange={changeDraft}
                    onSave={() => void saveDraft()}
                    path={file.data.path}
                  />
                  <RestoredView onReady={onTransferredViewReady} />
                </Suspense>
              ) : file.data &&
                (fileMode === "preview" ||
                  editableLanguage === null ||
                  fileMode === "visual") ? (
                viewer.markdown ? (
                  <div className="h-full overflow-auto">
                    {markdownPreviewUsesPlainText(file.data.path) ? (
                      <pre
                        className="min-h-full whitespace-pre-wrap break-words px-4 font-mono text-xs leading-5"
                        data-content-gutter="markdown"
                      >
                        {draft}
                      </pre>
                    ) : (
                      <ExplorerMarkdown
                        path={file.data.path}
                        onOpenFile={(path) => {
                          setViewStateError(null);
                          if (isDocumentView(explorer)) explorer.openFile(path);
                          else if (onOpenGraphFile)
                            onOpenGraphFile(explorer, path);
                          else openEntry(explorerFileEntryForGraphPath(path));
                        }}
                        onError={setViewStateError}
                      >
                        {draft}
                      </ExplorerMarkdown>
                    )}
                  </div>
                ) : nativeDocument?.id === nativeDocumentId ? (
                  <NativeCodeEditor
                    session={nativeDocument}
                    path={file.data.path}
                    highlightPath={viewer.syntaxPath}
                    active={active && !transferSuspended}
                    readOnly
                    onReady={onTransferredDocumentReady}
                    onViewStateChange={checkpointDocumentView}
                  />
                ) : null
              ) : null}
            </div>
          ) : !selectedPath && !isDocumentView(explorer) ? (
            <div className="flex min-h-0 flex-1 flex-col">
              {viewStateError ? (
                <div className="shrink-0 border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
                  {viewStateError}
                </div>
              ) : null}
              <ExplorerFileBrowser
                explorer={explorer}
                gitStatus={gitStatus}
                onOpenFile={openEntry}
                onRevealFolder={onRevealFolder ? revealEntry : undefined}
                revealLabel={revealLabel}
                onShowInGraph={repositoryGraphAvailable ? openGraph : undefined}
                onOpenTerminal={(entry) => {
                  if (!isDocumentView(explorer))
                    onOpenTerminal?.(explorer, entry);
                }}
                queryScope={streamEncryption.bindingKey!}
                replayKey={entryReplayKey}
                revealedPath={revealedPath}
              />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
