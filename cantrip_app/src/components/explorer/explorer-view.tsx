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

import { Markdown } from "@/components/chat/markdown";
import { ExplorerCodeEditor } from "@/components/explorer/explorer-code-editor";
import { ExplorerFileBrowser } from "@/components/explorer/explorer-file-browser";
import { explorerSurfaceSelectedPath } from "@/components/explorer/explorer-file-routing";
import { explorerFileEntryForGraphPath } from "@/components/explorer/explorer-graph-routing";
import { nextExplorerEntryReplayKey } from "@/components/explorer/explorer-lifecycle";
import { useExplorerWorkerEncryption } from "@/components/explorer/use-explorer-worker-encryption";
import { useRetainedInlineWorkbench } from "@/components/explorer/use-retained-inline-workbench";
import {
  defaultExplorerFileMode,
  markdownPreviewUsesPlainText,
  monacoLanguageForPath,
  structuredFileFormatForPath,
  usesCantripCodeEditor,
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
import { cn } from "@/lib/utils";

const StructuredFileVisual = lazy(async () => {
  const module = await import("@/components/explorer/structured-file-visual");
  return { default: module.StructuredFileVisual };
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
      <div className="grid h-full place-items-center overflow-auto p-4">
        <img
          alt={path.split("/").at(-1) ?? path}
          className="max-h-full max-w-full object-contain"
          onError={() => setFailed(true)}
          src={source}
        />
      </div>
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
  save(): Promise<boolean>;
  setFileMode(mode: ExplorerFileMode): void;
}

export interface ExplorerLifecycleActions {
  dirty: boolean;
  flushViewState(): Promise<boolean>;
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
  onLifecycleChange,
  onOpenFile,
  onRevealFolder,
  revealLabel,
  onOpenTerminal,
  repositoryGraphAvailable,
  transientFile,
}: {
  active?: boolean;
  appearance: CodeAppearance;
  explorer: ExplorerSummary;
  graphRequest?: ExplorerGraphRequest | null;
  gitStatus?: GitStatus;
  onChanged?(explorer: ExplorerSummary): void;
  onHeaderChange?(state: ExplorerHeaderState | null): void;
  onLifecycleChange?(
    explorerId: string,
    actions: ExplorerLifecycleActions | null,
  ): void;
  onOpenFile?(
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
  ): void | Promise<void>;
  onRevealFolder?(
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
    localFolder: boolean,
  ): void | Promise<void>;
  revealLabel?: string;
  onOpenTerminal?(explorer: ExplorerSummary, entry: ExplorerEntry): void;
  repositoryGraphAvailable: boolean;
  transientFile?: TransientExplorerFile;
}) {
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
  const [baselineContent, setBaselineContent] = useState("");
  const [draftVersion, setDraftVersion] = useState<string | null>(null);
  const [mediaRevision, setMediaRevision] = useState(0);
  const [viewStatePending, setViewStatePending] = useState(0);
  const [viewStateError, setViewStateError] = useState<string | null>(null);
  // Inactive Explorer surfaces stay mounted. Keep their authorization gate
  // open for the same bounded window so the Code iframe stays mounted too.
  const retainInlineWorkbench = useRetainedInlineWorkbench(active);
  const streamEncryption = useExplorerWorkerEncryption(
    explorer,
    retainInlineWorkbench,
  );
  const streamEncryptionReady = streamEncryption.ready;
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
    queryKey: ["explorer-directory", explorer.id],
  });

  useEffect(() => {
    if (!graphRequest || graphRequest.explorerId !== explorer.id) return;
    setGraphStatus(null);
    setRevealedPath(null);
    setGraphRootPath(graphRequest.rootPath);
  }, [explorer.id, graphRequest]);
  const commitFetches = useIsFetching({
    queryKey: ["explorer-directory-commits", explorer.id],
  });
  const file = useQuery({
    enabled: Boolean(
      streamEncryptionReady &&
      selectedPath &&
      !usesCantripCodeEditor(selectedPath, fileMode) &&
      explorerMediaTypeForPath(selectedPath) === null,
    ),
    queryFn: () => getExplorerFile(explorer.id, selectedPath!),
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
    }: {
      content: string;
      explorerId: string;
      path: string;
      version: string;
    }) => saveExplorerFile(explorerId, { content, path, version }),
  });
  const saveFileError = saveFile.error;
  const saveFilePending = saveFile.isPending;
  const mutateSaveFile = saveFile.mutateAsync;
  const resetSaveFile = saveFile.reset;
  const editableLanguage = selectedPath
    ? explorerMediaTypeForPath(selectedPath) === null
      ? monacoLanguageForPath(selectedPath)
      : null
    : null;
  const structuredFormat = selectedPath
    ? explorerMediaTypeForPath(selectedPath) === null
      ? structuredFileFormatForPath(selectedPath)
      : null
    : null;
  const mediaType = selectedPath
    ? explorerMediaTypeForPath(selectedPath)
    : null;
  const codeEditorVisible = selectedPath
    ? usesCantripCodeEditor(selectedPath, fileMode)
    : false;
  const graphVisible = graphRootPath !== undefined;
  const dirty = draftVersion !== null && draft !== baselineContent;
  dirtyRef.current = dirty;
  draftRef.current = draft;
  draftVersionRef.current = draftVersion;
  selectedPathRef.current = selectedPath;
  fileModeRef.current = fileMode;

  useEffect(() => {
    mountedRef.current = true;
    clientLogger.info("Explorer surface opened", {
      event: "explorer.surface.opened",
      operation: "open-surface",
      projectId: explorer.projectId,
      subsystem: "explorer",
      surfaceId: explorer.id,
      worktreeId: explorer.worktreeId,
    });
    return () => {
      mountedRef.current = false;
      clientLogger.info("Explorer surface closed", {
        event: "explorer.surface.closed",
        operation: "close-surface",
        projectId: explorer.projectId,
        subsystem: "explorer",
        surfaceId: explorer.id,
        worktreeId: explorer.worktreeId,
      });
    };
  }, [explorer.id, explorer.projectId, explorer.worktreeId]);

  useEffect(() => {
    setGraphRootPath(undefined);
    setGraphStatus(null);
    setRevealedPath(null);
  }, [explorer.id, explorer.worktreeId]);

  useEffect(() => {
    if (
      !file.data ||
      file.data.path !== selectedPath ||
      draftVersion !== null
    ) {
      return;
    }
    setDraft(file.data.content);
    setBaselineContent(file.data.content);
    setDraftVersion(file.data.version);
  }, [draftVersion, file.data, selectedPath]);

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
    async (path: string) => {
      const bindingKey = streamEncryptionBindingRef.current;
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
      const loaded = await queryClient.fetchQuery({
        queryFn: () => getExplorerFile(explorer.id, path),
        queryKey: ["explorer-file", explorer.id, path, bindingKey],
      });
      if (
        !mountedRef.current ||
        selectedPathRef.current !== path ||
        streamEncryptionBindingRef.current !== bindingKey
      ) {
        return;
      }
      setDraft(loaded.content);
      setBaselineContent(loaded.content);
      setDraftVersion(loaded.version);
    },
    [explorer.id, queryClient, resetSaveFile],
  );

  useEffect(() => {
    if (!transientFilePath || transientFilePath === selectedPathRef.current) {
      return;
    }
    setGraphRootPath(undefined);
    setGraphStatus(null);
    setRevealedPath(null);
    setDraft("");
    setBaselineContent("");
    setDraftVersion(null);
    resetSaveFile();
    applyViewState({
      selectedPath: transientFilePath,
      fileMode: defaultExplorerFileMode(transientFilePath),
    });
    if (explorerMediaTypeForPath(transientFilePath)) {
      setMediaRevision((revision) => revision + 1);
    }
  }, [applyViewState, resetSaveFile, transientFilePath]);

  const saveDraft = useCallback(async (): Promise<boolean> => {
    const bindingKey = streamEncryptionBindingRef.current;
    if (!streamEncryptionReadyRef.current || !bindingKey) return false;
    const path = selectedPathRef.current;
    const version = draftVersionRef.current;
    if (!path || !version || !dirtyRef.current) return true;
    if (saveFilePending) return false;
    const startedAt = performance.now();
    clientLogger.info("Explorer file save started", {
      event: "explorer.file.save.started",
      operation: "save-file",
      subsystem: "explorer",
      surfaceId: explorer.id,
    });
    try {
      const savedFile = await mutateSaveFile({
        content: draftRef.current,
        explorerId: explorer.id,
        path,
        version,
      });
      queryClient.setQueryData(
        ["explorer-file", explorer.id, savedFile.path, bindingKey],
        savedFile,
      );
      if (
        mountedRef.current &&
        selectedPathRef.current === savedFile.path &&
        streamEncryptionBindingRef.current === bindingKey
      ) {
        setDraft(savedFile.content);
        setBaselineContent(savedFile.content);
        setDraftVersion(savedFile.version);
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["explorer-directory", explorer.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["explorer-directory-commits", explorer.id],
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
      return true;
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
      !window.confirm(
        "Reload this Explorer and discard its unsaved file changes?",
      )
    ) {
      return;
    }
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["explorer-directory", explorer.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ["explorer-directory-commits", explorer.id],
      }),
      queryClient.invalidateQueries({
        exact: true,
        queryKey: ["worktree-status", explorer.projectId, explorer.worktreeId],
      }),
      selectedPathRef.current
        ? loadFile(selectedPathRef.current)
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
      transientFileCloseRef.current?.();
      return;
    }
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
        (mode === "edit" && !monacoLanguageForPath(path)) ||
        (mode === "visual" && !structuredFileFormatForPath(path))
      ) {
        return;
      }
      void (async () => {
        if (mode === "edit" && !(await saveDraft())) return;
        if (selectedPathRef.current !== path) return;
        if (mode === "edit") {
          setDraft("");
          setBaselineContent("");
          setDraftVersion(null);
          resetSaveFile();
        }
        await persistViewState({ selectedPath: path, fileMode: mode });
      })();
    },
    [persistViewState, resetSaveFile, saveDraft],
  );

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
      save: saveDraft,
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
  ]);

  useEffect(() => {
    return () => {
      if (active) onHeaderChange?.(null);
    };
  }, [active, onHeaderChange]);

  const lifecycle = useMemo<ExplorerLifecycleActions>(
    () => ({
      dirty,
      flushViewState: () => viewStateQueueRef.current,
      reconcile,
      save: saveDraft,
    }),
    [dirty, reconcile, saveDraft],
  );

  useEffect(() => {
    onLifecycleChange?.(explorer.id, lifecycle);
  }, [explorer.id, lifecycle, onLifecycleChange]);
  useEffect(
    () => () => onLifecycleChange?.(explorer.id, null),
    [explorer.id, onLifecycleChange],
  );

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

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
    if (!onOpenFile) setGraphRootPath(undefined);
    openEntry(explorerFileEntryForGraphPath(path));
  };

  return (
    <div
      aria-hidden={!active}
      className={cn(
        "min-h-0 flex-1 overflow-hidden bg-background",
        active ? "flex" : "hidden",
      )}
      data-slot="explorer-view"
    >
      {!streamEncryptionReady ? (
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
      ) : graphVisible ? (
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
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {saveFileError || viewStateError ? (
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
            ) : codeEditorVisible ? (
              <div className="flex h-full min-h-0">
                <ExplorerCodeEditor
                  appearance={appearance}
                  explorerId={explorer.id}
                  path={selectedPath}
                  worktreeId={explorer.worktreeId}
                  workerId={explorer.activeWorkerId}
                />
              </div>
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
                  onChange={setDraft}
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
                  <pre className="min-h-full whitespace-pre-wrap break-words p-6 font-mono text-xs leading-5 sm:p-10">
                    {draft}
                  </pre>
                ) : file.data.markdown ? (
                  <article
                    className="mx-auto max-w-4xl p-6 sm:p-10"
                    data-elite-ignore=""
                  >
                    <Markdown>{draft}</Markdown>
                  </article>
                ) : (
                  <SourceView code={draft} path={file.data.path} />
                )}
              </div>
            ) : null}
          </div>
        </div>
      ) : (
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
      )}
    </div>
  );
}
