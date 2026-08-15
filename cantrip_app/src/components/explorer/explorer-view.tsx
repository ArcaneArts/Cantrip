import type {
  ExplorerEntry,
  ExplorerFileMode,
  ExplorerSummary,
  GitStatus,
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
import { ExplorerFileBrowser } from "@/components/explorer/explorer-file-browser";
import { explorerSurfaceSelectedPath } from "@/components/explorer/explorer-file-routing";
import {
  defaultExplorerFileMode,
  monacoLanguageForPath,
  monacoModelPath,
  structuredFileFormatForPath,
} from "@/components/explorer/explorer-file-language";
import { Button } from "@/components/ui/button";
import {
  getExplorerFile,
  saveExplorerFile,
  updateExplorerViewState,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const MonacoFileEditor = lazy(async () => {
  const module = await import("@/components/explorer/monaco-file-editor");
  return { default: module.MonacoFileEditor };
});

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

export interface ExplorerHeaderState {
  canEdit: boolean;
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

export function ExplorerView({
  active = true,
  explorer,
  gitStatus,
  onChanged,
  onHeaderChange,
  onLifecycleChange,
  onOpenFile,
  onOpenTerminal,
  transientFile,
}: {
  active?: boolean;
  explorer: ExplorerSummary;
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
  onOpenTerminal?(explorer: ExplorerSummary, entry: ExplorerEntry): void;
  transientFile?: TransientExplorerFile;
}) {
  const [selectedPath, setSelectedPath] = useState(() =>
    explorerSurfaceSelectedPath({
      openFilesExternally: Boolean(onOpenFile),
      persistedPath: explorer.selectedPath,
      transientPath: transientFile?.path,
    }),
  );
  const [fileMode, setFileModeState] = useState<ExplorerFileMode>(() =>
    transientFile
      ? monacoLanguageForPath(transientFile.path)
        ? "edit"
        : "preview"
      : explorer.fileMode,
  );
  const [draft, setDraft] = useState("");
  const [baselineContent, setBaselineContent] = useState("");
  const [draftVersion, setDraftVersion] = useState<string | null>(null);
  const [viewStatePending, setViewStatePending] = useState(0);
  const [viewStateError, setViewStateError] = useState<string | null>(null);
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
  const commitFetches = useIsFetching({
    queryKey: ["explorer-directory-commits", explorer.id],
  });
  const file = useQuery({
    enabled: Boolean(selectedPath),
    queryFn: () => getExplorerFile(explorer.id, selectedPath!),
    queryKey: ["explorer-file", explorer.id, selectedPath],
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
    ? monacoLanguageForPath(selectedPath)
    : null;
  const structuredFormat = selectedPath
    ? structuredFileFormatForPath(selectedPath)
    : null;
  const dirty = draftVersion !== null && draft !== baselineContent;
  dirtyRef.current = dirty;
  draftRef.current = draft;
  draftVersionRef.current = draftVersion;
  selectedPathRef.current = selectedPath;
  fileModeRef.current = fileMode;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
      selectedPathRef.current = next.selectedPath;
      fileModeRef.current = next.fileMode;
      setSelectedPath(next.selectedPath);
      setFileModeState(next.fileMode);
    },
    [],
  );

  const persistViewState = useCallback(
    (next: { selectedPath: string | null; fileMode: ExplorerFileMode }) => {
      applyViewState(next);
      if (transientFile) return Promise.resolve(true);
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
    [applyViewState, explorer.id, onChanged, transientFile],
  );

  const loadFile = useCallback(
    async (path: string) => {
      setDraft("");
      setBaselineContent("");
      setDraftVersion(null);
      resetSaveFile();
      await queryClient.invalidateQueries({
        exact: true,
        queryKey: ["explorer-file", explorer.id, path],
        refetchType: "none",
      });
      const loaded = await queryClient.fetchQuery({
        queryFn: () => getExplorerFile(explorer.id, path),
        queryKey: ["explorer-file", explorer.id, path],
      });
      if (!mountedRef.current || selectedPathRef.current !== path) return;
      setDraft(loaded.content);
      setBaselineContent(loaded.content);
      setDraftVersion(loaded.version);
    },
    [explorer.id, queryClient, resetSaveFile],
  );

  const saveDraft = useCallback(async (): Promise<boolean> => {
    const path = selectedPathRef.current;
    const version = draftVersionRef.current;
    if (!path || !version || !dirtyRef.current) return true;
    if (saveFilePending) return false;
    try {
      const savedFile = await mutateSaveFile({
        content: draftRef.current,
        explorerId: explorer.id,
        path,
        version,
      });
      queryClient.setQueryData(
        ["explorer-file", explorer.id, savedFile.path],
        savedFile,
      );
      if (mountedRef.current && selectedPathRef.current === savedFile.path) {
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
      return true;
    } catch {
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
        transientPath: transientFile?.path,
      });
      applyViewState({
        selectedPath: nextSelectedPath,
        fileMode: transientFile ? fileModeRef.current : persisted.fileMode,
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
      transientFile,
    ],
  );

  useEffect(() => {
    // Desktop Explorer surfaces remain file browsers. Their editor windows are
    // transient and must not be pulled back inline by legacy saved view state.
    if (transientFile || onOpenFile) return;
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
    transientFile,
    viewStatePending,
  ]);

  const refreshExplorer = useCallback(async () => {
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
    if (
      dirtyRef.current &&
      !window.confirm("Close this file and discard its unsaved changes?")
    ) {
      return;
    }
    if (transientFile) {
      transientFile.close();
      return;
    }
    setDraft("");
    setBaselineContent("");
    setDraftVersion(null);
    resetSaveFile();
    void persistViewState({ selectedPath: null, fileMode: "preview" });
  }, [persistViewState, resetSaveFile, transientFile]);

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
      void persistViewState({ selectedPath: path, fileMode: mode });
    },
    [persistViewState],
  );

  useEffect(() => {
    if (!active) return;
    onHeaderChange?.({
      back,
      canEdit: editableLanguage !== null,
      canVisual: structuredFormat !== null,
      directoryPath: selectedPath ?? "",
      dirty,
      fileMode,
      isFetching:
        directoryFetches + commitFetches > 0 ||
        file.isFetching ||
        viewStatePending > 0,
      isSaving: saveFilePending,
      refresh: refreshExplorer,
      save: saveDraft,
      selectedPath,
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
    void persistViewState({
      selectedPath: entry.path,
      fileMode: defaultExplorerFileMode(entry.path),
    });
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
      {selectedPath ? (
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
            {file.isLoading ? (
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
                {file.data.markdown ? (
                  <article className="mx-auto max-w-4xl p-6 sm:p-10">
                    <Markdown>{draft}</Markdown>
                  </article>
                ) : (
                  <SourceView code={draft} path={file.data.path} />
                )}
              </div>
            ) : file.data && editableLanguage ? (
              <Suspense
                fallback={
                  <div className="grid h-full place-items-center text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" />
                  </div>
                }
              >
                <MonacoFileEditor
                  language={editableLanguage}
                  modelPath={monacoModelPath(explorer.id, file.data.path)}
                  onChange={setDraft}
                  onSave={() => void saveDraft()}
                  value={draft}
                />
              </Suspense>
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
            onOpenTerminal={(entry) => onOpenTerminal?.(explorer, entry)}
          />
        </div>
      )}
    </div>
  );
}
