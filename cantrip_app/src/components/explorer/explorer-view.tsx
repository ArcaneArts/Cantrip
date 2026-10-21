import {
  explorerMediaTypeForPath,
  type CodeAppearance,
  type ExplorerMediaKind,
  type ExplorerEntry,
  type ExplorerFileMode,
  type ExplorerSummary,
  type GitStatus,
} from "@cantrip/protocol";
import {
  useIsFetching,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Highlight, themes, type Language } from "prism-react-renderer";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ExplorerMarkdown } from "@/components/explorer/explorer-markdown";
import { ExplorerFileBrowser } from "@/components/explorer/explorer-file-browser";
import { explorerSurfaceSelectedPath } from "@/components/explorer/explorer-file-routing";
import { explorerFileEntryForGraphPath } from "@/components/explorer/explorer-graph-routing";
import { ExplorerImageViewport } from "@/components/explorer/explorer-image-viewport";
import { nextExplorerEntryReplayKey } from "@/components/explorer/explorer-lifecycle";
import type { ExplorerCodeEditorLifecycleActions } from "@/components/explorer/explorer-code-editor";
import {
  EditorSessionStore,
  editorDocumentId,
  type EditorDocumentSession,
} from "@/components/editor/document-session";
import { NativeCodeEditor } from "@/components/editor/native-code-editor";
import { getClientSession } from "@/lib/client-session";
import { useExplorerWorkerEncryption } from "@/components/explorer/use-explorer-worker-encryption";
import {
  defaultExplorerFileMode,
  markdownPreviewUsesPlainText,
  structuredFileFormatForPath,
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

const StructuredFileVisual = lazy(async () => {
  const module = await import("@/components/explorer/structured-file-visual");
  return { default: module.StructuredFileVisual };
});
const RetainedExplorerCodeEditor = lazy(async () => {
  const module =
    await import("@/components/explorer/retained-explorer-code-editor");
  return { default: module.RetainedExplorerCodeEditor };
});

const languageByExtension: Record<string, Language> = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  dart: "dart",
  go: "go",
  graphql: "graphql",
  h: "c",
  hpp: "cpp",
  html: "markup",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  kt: "kotlin",
  kts: "kotlin",
  lua: "lua",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  sol: "solidity",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  vue: "markup",
  xml: "markup",
  yaml: "yaml",
  yml: "yaml",
};

function fileLanguage(path: string): Language {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  return languageByExtension[extension] ?? "plain";
}

function SourceView({ code, path }: { code: string; path: string }) {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains("dark")),
    );
    observer.observe(document.documentElement, {
      attributeFilter: ["class"],
      attributes: true,
    });
    return () => observer.disconnect();
  }, []);
  return (
    <Highlight
      code={code}
      language={fileLanguage(path)}
      theme={dark ? themes.vsDark : themes.github}
    >
      {({ className, getLineProps, getTokenProps, style, tokens }) => (
        <pre
          className={cn(
            className,
            "min-h-full min-w-max p-4 font-mono text-xs leading-5",
          )}
          style={{ ...style, margin: 0, background: "transparent" }}
        >
          {tokens.map((line, lineIndex) => (
            <div key={lineIndex} {...getLineProps({ line })}>
              <span className="mr-5 inline-block w-8 select-none text-right text-muted-foreground/50">
                {lineIndex + 1}
              </span>
              {line.map((token, tokenIndex) => (
                <span key={tokenIndex} {...getTokenProps({ token })} />
              ))}
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  );
}

function ExplorerMediaView({
  explorerId,
  kind,
  mimeType,
  path,
  revision,
}: {
  explorerId: string;
  kind: ExplorerMediaKind;
  mimeType: string;
  path: string;
  revision: number;
}) {
  const [failed, setFailed] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let objectUrl: string | null = null;
    setFailed(false);
    setSource(null);
    void loadExplorerMedia(explorerId, path)
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
  }, [explorerId, path, revision]);
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
      >
        <source src={source} type={mimeType} />
      </video>
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
  back(): void;
  refresh(): void;
  openFileHistory?(): void;
  openInVsCode?(): void;
  save(): Promise<boolean>;
  setFileMode(mode: ExplorerFileMode): void;
}

export interface ExplorerLifecycleActions {
  cancelClose(): void;
  discard?(): void;
  dirty: boolean;
  flushViewState(): Promise<boolean>;
  prepareClose(): Promise<void>;
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

export function ExplorerView({
  active = true,
  appearance,
  explorer,
  graphRequest,
  gitStatus,
  onChanged,
  onHeaderChange,
  onInlineCodeReady,
  onLifecycleChange,
  keepInlineCodeWarm = false,
  onOpenFile,
  onOpenGraphFile,
  onRevealFolder,
  revealLabel,
  onOpenTerminal,
  prewarmInlineCode = false,
  repositoryGraphAvailable,
  transientFile,
  workerOnline = true,
}: {
  active?: boolean;
  appearance: CodeAppearance;
  explorer: ExplorerSummary;
  graphRequest?: ExplorerGraphRequest | null;
  gitStatus?: GitStatus;
  onChanged?(explorer: ExplorerSummary): void;
  onHeaderChange?(state: ExplorerHeaderState | null): void;
  onInlineCodeReady?(): void;
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
  prewarmInlineCode?: boolean;
  repositoryGraphAvailable: boolean;
  transientFile?: TransientExplorerFile;
  workerOnline?: boolean;
}) {
  const surfaceInstanceId = useRef(crypto.randomUUID()).current;
  const transientFilePath = transientFile?.path;
  const transientFileCloseRef = useRef(transientFile?.close);
  transientFileCloseRef.current = transientFile?.close;
  const codeEditorLifecycleRef =
    useRef<ExplorerCodeEditorLifecycleActions | null>(null);
  const handleCodeEditorLifecycleChange = useCallback(
    (actions: ExplorerCodeEditorLifecycleActions | null) => {
      codeEditorLifecycleRef.current = actions;
    },
    [],
  );
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
  const sessions = useRef<EditorSessionStore | null>(null);
  sessions.current ??= new EditorSessionStore();
  const [nativeDocument, setNativeDocument] =
    useState<EditorDocumentSession | null>(null);
  const nativeDocumentRef = useRef<EditorDocumentSession | null>(null);
  nativeDocumentRef.current = nativeDocument;
  const [explicitVsCode, setExplicitVsCode] = useState(false);
  const [baselineContent, setBaselineContent] = useState("");
  const [draftVersion, setDraftVersion] = useState<string | null>(null);
  const [mediaRevision, setMediaRevision] = useState(0);
  const [viewStatePending, setViewStatePending] = useState(0);
  const [viewStateError, setViewStateError] = useState<string | null>(null);
  // Sidebar prewarming may prepare file authorization. A workbench belongs
  // only to a file explicitly opened in VS Code.
  const retainInlineWorkbench = explicitVsCode;
  const streamEncryption = useExplorerWorkerEncryption(
    explorer,
    active ||
      prewarmInlineCode ||
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
  const selectedPathRef = useRef(selectedPath);
  const fileModeRef = useRef(fileMode);
  const draftRef = useRef(draft);
  const draftVersionRef = useRef(draftVersion);
  const dirtyRef = useRef(false);
  const worktreeIdRef = useRef(explorer.worktreeId);
  const viewStateQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const directoryFetches = useIsFetching({
    queryKey: [
      "explorer-directory",
      explorer.projectId,
      explorer.worktreeId,
      explorer.id,
    ],
  });

  useEffect(() => {
    if (!graphRequest || graphRequest.explorerId !== explorer.id) return;
    setGraphStatus(null);
    setRevealedPath(null);
    setGraphRootPath(graphRequest.rootPath);
  }, [explorer.id, graphRequest]);
  const commitFetches = useIsFetching({
    queryKey: [
      "explorer-directory-commits",
      explorer.projectId,
      explorer.worktreeId,
      explorer.id,
    ],
  });
  const fileBinding = useMemo(
    () => ({
      workerId: explorer.activeWorkerId,
      projectId: explorer.projectId,
      worktreeId: explorer.worktreeId,
    }),
    [explorer.activeWorkerId, explorer.projectId, explorer.worktreeId],
  );
  const file = useQuery({
    enabled: Boolean(
      streamEncryptionReady &&
      selectedPath &&
      explorerMediaTypeForPath(selectedPath) === null,
    ),
    queryFn: () => getExplorerFile(explorer.id, selectedPath!, fileBinding),
    queryKey: [
      "explorer-file",
      explorer.id,
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
    }) => saveExplorerFile(explorerId, { content, path, version }, binding),
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
  useEffect(() => {
    sessions.current!.resetScope(accountScope);
    setNativeDocument(null);
    setDraft("");
    setBaselineContent("");
    setDraftVersion(null);
    setExplicitVsCode(false);
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
  const editableLanguage = displayedSelectedPath
    ? explorerMediaTypeForPath(displayedSelectedPath) === null
      ? "text"
      : null
    : null;
  const structuredFormat = displayedSelectedPath
    ? explorerMediaTypeForPath(displayedSelectedPath) === null
      ? structuredFileFormatForPath(displayedSelectedPath)
      : null
    : null;
  const mediaType = displayedSelectedPath
    ? explorerMediaTypeForPath(displayedSelectedPath)
    : null;
  const codeEditorVisible = displayedSelectedPath
    ? explicitVsCode && fileMode === "edit" && !mediaType
    : false;
  const graphVisible = graphRootPath !== undefined;
  const codeEditorPath =
    !graphVisible && codeEditorVisible ? displayedSelectedPath : null;
  const codeEditorVisibleOnSurface = Boolean(active && codeEditorPath);
  const surfaceLifecycleState = {
    active,
    codeEditorVisible: codeEditorVisibleOnSurface,
    keepInlineCodeWarm,
    pathPresent: displayedSelectedPath !== null,
    transient: transientFilePath !== undefined,
  };
  const surfaceLifecycleStateRef = useRef(surfaceLifecycleState);
  surfaceLifecycleStateRef.current = surfaceLifecycleState;
  const previousSurfaceLifecycleStateRef = useRef<{
    active: boolean;
    codeEditorVisible: boolean;
    keepInlineCodeWarm: boolean;
    path: string | null;
    transient: boolean;
  } | null>(null);
  const dirty = draftVersion !== null && draft !== baselineContent;
  const hasDirtyDocuments = dirty || sessions.current!.hasDirtyDocuments;
  dirtyRef.current = dirty;
  const changeDraft = useCallback((text: string) => {
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
    codeEditorVisibleOnSurface,
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

  useEffect(() => {
    if (
      !file.data ||
      file.data.path !== selectedPath ||
      file.data.path !== displayedSelectedPath ||
      (draftVersion !== null && nativeDocument?.id === nativeDocumentId)
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
    draftVersion,
    file.data,
    selectedPath,
    displayedSelectedPath,
    nativeDocumentId,
    nativeDocument,
  ]);
  useEffect(() => {
    if (
      nativeDocument?.id === nativeDocumentId &&
      !explicitVsCode &&
      streamEncryptionReady
    )
      onInlineCodeReady?.();
  }, [
    nativeDocument,
    nativeDocumentId,
    explicitVsCode,
    streamEncryptionReady,
    onInlineCodeReady,
  ]);

  const applyViewState = useCallback(
    (next: { selectedPath: string | null; fileMode: ExplorerFileMode }) => {
      const nextFileMode =
        next.selectedPath && explorerMediaTypeForPath(next.selectedPath)
          ? "preview"
          : next.fileMode;
      selectedPathRef.current = next.selectedPath;
      fileModeRef.current = nextFileMode;
      setSelectedPath(next.selectedPath);
      setFileModeState(nextFileMode);
    },
    [],
  );

  const persistViewState = useCallback(
    (next: { selectedPath: string | null; fileMode: ExplorerFileMode }) => {
      applyViewState(next);
      if (transientFilePath) return Promise.resolve(true);
      if (mountedRef.current) setViewStatePending((count) => count + 1);
      const operation = viewStateQueueRef.current.then(async () => {
        try {
          const updated = await updateExplorerViewState(explorer.id, next);
          if (mountedRef.current) {
            setViewStateError(null);
            onChanged?.(updated);
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
    [applyViewState, explorer.id, onChanged, transientFilePath],
  );

  const loadFile = useCallback(
    async (path: string, discardDraft = false) => {
      const bindingKey = streamEncryptionBindingRef.current;
      const previous = nativeDocumentRef.current;
      if (previous && discardDraft) sessions.current!.discard(previous.id);
      setNativeDocument(null);
      setExplicitVsCode(false);
      setDraft("");
      setBaselineContent("");
      setDraftVersion(null);
      resetSaveFile();
      if (!streamEncryptionReadyRef.current || !bindingKey) return;
      if (explorerMediaTypeForPath(path)) {
        setMediaRevision((revision) => revision + 1);
        return;
      }
      await queryClient.invalidateQueries({
        exact: true,
        queryKey: ["explorer-file", explorer.id, path, bindingKey],
        refetchType: "none",
      });
      await queryClient.fetchQuery({
        queryFn: () => getExplorerFile(explorer.id, path, fileBinding),
        queryKey: ["explorer-file", explorer.id, path, bindingKey],
      });
      if (
        !mountedRef.current ||
        selectedPathRef.current !== path ||
        streamEncryptionBindingRef.current !== bindingKey
      ) {
        return;
      }
      // The query result is installed by the identity-fenced document effect.
    },
    [explorer.id, queryClient, resetSaveFile, fileBinding],
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
      explorerMediaTypeForPath(nextViewState.selectedPath)
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
          ["explorer-file", explorer.id, savedFile.path, bindingKey],
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
  ]);

  const reconcile = useCallback(
    async (persisted: ExplorerSummary) => {
      await viewStateQueueRef.current;
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
    if (transientFilePath || onOpenFile) return;
    const worktreeChanged = worktreeIdRef.current !== explorer.worktreeId;
    const viewStateChanged =
      explorer.selectedPath !== selectedPathRef.current ||
      explorer.fileMode !== fileModeRef.current;
    if (
      viewStatePending > 0 ||
      (!worktreeChanged && (!viewStateChanged || dirtyRef.current))
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
    transientFilePath,
    viewStatePending,
  ]);

  const refreshExplorer = useCallback(async () => {
    if (!streamEncryptionReadyRef.current) return;
    if (
      dirtyRef.current &&
      !window.confirm("Reload this file and discard its unsaved changes?")
    ) {
      return;
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
        queryKey: ["worktree-status", explorer.projectId, explorer.worktreeId],
      }),
      selectedPathRef.current
        ? loadFile(selectedPathRef.current, true)
        : Promise.resolve(),
    ]);
  }, [
    explorer.id,
    explorer.projectId,
    explorer.worktreeId,
    loadFile,
    queryClient,
  ]);

  const back = useCallback(() => {
    if (graphRootPath !== undefined) {
      setGraphRootPath(undefined);
      setGraphStatus(null);
      return;
    }
    if (
      dirtyRef.current &&
      !window.confirm("Close this file and discard its unsaved changes?")
    ) {
      return;
    }
    if (transientFilePath) {
      const document = nativeDocumentRef.current;
      if (dirtyRef.current && document) sessions.current!.discard(document.id);
      transientFileCloseRef.current?.();
      return;
    }
    const document = nativeDocumentRef.current;
    if (dirtyRef.current && document) sessions.current!.discard(document.id);
    setNativeDocument(null);
    setExplicitVsCode(false);
    setDraft("");
    setBaselineContent("");
    setDraftVersion(null);
    resetSaveFile();
    void persistViewState({ selectedPath: null, fileMode: "preview" });
  }, [graphRootPath, persistViewState, resetSaveFile, transientFilePath]);

  const changeFileMode = useCallback(
    (mode: ExplorerFileMode) => {
      const path = selectedPathRef.current;
      if (
        !path ||
        (mode === "edit" && explorerMediaTypeForPath(path) !== null) ||
        (mode === "visual" && !structuredFileFormatForPath(path))
      ) {
        return;
      }
      void (async () => {
        if (selectedPathRef.current !== path) return;
        await persistViewState({ selectedPath: path, fileMode: mode });
      })();
    },
    [persistViewState],
  );

  const openInVsCode = useCallback(() => {
    void (async () => {
      if (
        dirtyRef.current &&
        !window.confirm(
          "Save this file's changes before opening it in VS Code?",
        )
      )
        return;
      if (!(await saveDraft())) return;
      setExplicitVsCode(true);
      if (selectedPathRef.current)
        await persistViewState({
          selectedPath: selectedPathRef.current,
          fileMode: "edit",
        });
    })();
  }, [persistViewState, saveDraft]);

  useEffect(() => {
    if (!active) return;
    onHeaderChange?.({
      backLabel: graphVisible ? "Close graph" : undefined,
      back,
      canEdit: !graphVisible && editableLanguage !== null,
      canGoBack: graphVisible || Boolean(selectedPath),
      canVisual: !graphVisible && structuredFormat !== null,
      directoryPath: graphVisible
        ? (graphRootPath ?? "")
        : (selectedPath ?? ""),
      dirty,
      fileMode: graphVisible ? "preview" : fileMode,
      isFetching: graphVisible
        ? (graphStatus?.isFetching ?? false)
        : directoryFetches + commitFetches > 0 ||
          file.isFetching ||
          viewStatePending > 0,
      isSaving: saveFilePending,
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
      openInVsCode:
        !graphVisible && !mediaType && selectedPath && !explicitVsCode
          ? openInVsCode
          : undefined,
      selectedPath: graphVisible ? null : selectedPath,
      setFileMode: changeFileMode,
    });
  }, [
    active,
    back,
    changeFileMode,
    commitFetches,
    directoryFetches,
    dirty,
    editableLanguage,
    explorer.projectId,
    explorer.worktreeId,
    file.isFetching,
    fileMode,
    graphRootPath,
    graphStatus?.isFetching,
    graphVisible,
    onHeaderChange,
    refreshExplorer,
    saveDraft,
    saveFilePending,
    selectedPath,
    structuredFormat,
    viewStatePending,
    explicitVsCode,
    mediaType,
    openInVsCode,
  ]);

  useEffect(() => {
    return () => {
      if (active) onHeaderChange?.(null);
    };
  }, [active, onHeaderChange]);

  const prepareClose = useCallback(
    () => codeEditorLifecycleRef.current?.prepareClose() ?? Promise.resolve(),
    [],
  );
  const cancelClose = useCallback(
    () => codeEditorLifecycleRef.current?.cancelClose(),
    [],
  );
  const lifecycle = useMemo<ExplorerLifecycleActions>(
    () => ({
      cancelClose,
      discard: () => {
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
      cancelClose,
      hasDirtyDocuments,
      prepareClose,
      reconcile,
      saveDraft,
      resetSaveFile,
    ],
  );

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
    if (entry.kind !== "file" || !entry.viewable) return;
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
    setExplicitVsCode(false);
    setDraft("");
    setBaselineContent("");
    setDraftVersion(null);
    resetSaveFile();
    if (explorerMediaTypeForPath(entry.path)) {
      setMediaRevision((revision) => revision + 1);
    }
    void persistViewState({
      selectedPath: entry.path,
      fileMode: defaultExplorerFileMode(entry.path),
    });
  };

  const revealEntry = (entry: ExplorerEntry, localFolder: boolean) => {
    if (!onRevealFolder) return;
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
      onOpenGraphFile(explorer, path);
      return;
    }
    if (!onOpenFile) setGraphRootPath(undefined);
    openEntry(explorerFileEntryForGraphPath(path));
  };

  return (
    <div
      aria-hidden={!active}
      inert={active ? undefined : true}
      className={cn(
        "min-h-0 flex-1 overflow-hidden",
        active ? "flex" : "pointer-events-none invisible absolute inset-0 flex",
      )}
      data-slot="explorer-view"
    >
      {!streamEncryptionReady &&
      !(nativeDocument?.id === nativeDocumentId && !explicitVsCode) ? (
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
          {explicitVsCode ? (
            <Suspense
              fallback={<Loader2 className="m-auto size-5 animate-spin" />}
            >
              <RetainedExplorerCodeEditor
                appearance={appearance}
                explorerId={explorer.id}
                onLifecycleChange={handleCodeEditorLifecycleChange}
                onReady={onInlineCodeReady}
                path={codeEditorPath}
                prewarm={false}
                retained={retainInlineWorkbench}
                visible={codeEditorVisibleOnSurface}
                workerOnline={workerOnline}
                worktreeId={explorer.worktreeId}
                workerId={explorer.activeWorkerId}
              />
            </Suspense>
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
          ) : selectedPath && !codeEditorVisible ? (
            <div className="min-h-0 flex-1 overflow-hidden">
              {mediaType ? (
                <ExplorerMediaView
                  explorerId={explorer.id}
                  key={`${selectedPath}:${mediaRevision}`}
                  kind={mediaType.kind}
                  mimeType={mediaType.mimeType}
                  path={selectedPath}
                  revision={mediaRevision}
                />
              ) : nativeDocument?.id === nativeDocumentId &&
                fileMode === "edit" ? (
                <NativeCodeEditor
                  session={nativeDocument}
                  path={selectedPath}
                  active={active}
                  onChange={changeDraft}
                  onSave={() => void saveDraft()}
                />
              ) : file.isLoading ? (
                <div className="grid h-full place-items-center text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                </div>
              ) : file.isError ? (
                <p className="m-4 border-y border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                  {file.error instanceof Error
                    ? file.error.message
                    : "File could not be loaded."}
                </p>
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
                </Suspense>
              ) : file.data &&
                (fileMode === "preview" ||
                  editableLanguage === null ||
                  fileMode === "visual") ? (
                <div className="h-full overflow-auto">
                  {file.data.markdown &&
                  markdownPreviewUsesPlainText(file.data.path) ? (
                    <pre
                      className="min-h-full whitespace-pre-wrap break-words px-4 font-mono text-xs leading-5"
                      data-content-gutter="markdown"
                    >
                      {draft}
                    </pre>
                  ) : file.data.markdown ? (
                    <ExplorerMarkdown
                      path={file.data.path}
                      onOpenFile={(path) => {
                        setViewStateError(null);
                        if (onOpenGraphFile) onOpenGraphFile(explorer, path);
                        else openEntry(explorerFileEntryForGraphPath(path));
                      }}
                      onError={setViewStateError}
                    >
                      {draft}
                    </ExplorerMarkdown>
                  ) : (
                    <SourceView code={draft} path={file.data.path} />
                  )}
                </div>
              ) : null}
            </div>
          ) : !selectedPath ? (
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
                onOpenTerminal={(entry) => onOpenTerminal?.(explorer, entry)}
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
