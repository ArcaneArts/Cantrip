import type { ExplorerEntry, ExplorerSummary } from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  File,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  Save,
} from "lucide-react";
import { Highlight, themes, type Language } from "prism-react-renderer";
import { lazy, Suspense, useEffect, useState } from "react";

import { Markdown } from "@/components/chat/markdown";
import {
  defaultExplorerFileMode,
  monacoLanguageForPath,
  monacoModelPath,
  type ExplorerFileMode,
} from "@/components/explorer/explorer-file-language";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getExplorerDirectory,
  getExplorerFile,
  saveExplorerFile,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const MonacoFileEditor = lazy(async () => {
  const module = await import("@/components/explorer/monaco-file-editor");
  return { default: module.MonacoFileEditor };
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

function entryIcon(entry: ExplorerEntry) {
  if (entry.kind === "directory") return Folder;
  if (entry.markdown) return FileText;
  if (entry.viewable) return FileCode2;
  return File;
}

function formatSize(size: number): string {
  if (size < 1_024) return `${size} B`;
  if (size < 1_048_576) return `${(size / 1_024).toFixed(1)} KB`;
  return `${(size / 1_048_576).toFixed(1)} MB`;
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
  directoryPath: string;
  isFetching: boolean;
  refresh(): void;
}

export function ExplorerView({
  explorer,
  onHeaderChange,
}: {
  explorer: ExplorerSummary;
  onHeaderChange(state: ExplorerHeaderState | null): void;
}) {
  const [directoryPath, setDirectoryPath] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileMode, setFileMode] = useState<ExplorerFileMode>("preview");
  const [draft, setDraft] = useState("");
  const [baselineContent, setBaselineContent] = useState("");
  const [draftVersion, setDraftVersion] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const directory = useQuery({
    queryFn: () => getExplorerDirectory(explorer.id, directoryPath),
    queryKey: ["explorer-directory", explorer.id, directoryPath],
  });
  const file = useQuery({
    enabled: Boolean(selectedFile),
    queryFn: () => getExplorerFile(explorer.id, selectedFile!),
    queryKey: ["explorer-file", explorer.id, selectedFile],
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
    onSuccess: (savedFile, variables) => {
      queryClient.setQueryData(
        ["explorer-file", variables.explorerId, savedFile.path],
        savedFile,
      );
      if (
        explorer.id !== variables.explorerId ||
        selectedFile !== savedFile.path
      ) {
        return;
      }
      setDraft(savedFile.content);
      setBaselineContent(savedFile.content);
      setDraftVersion(savedFile.version);
      void directory.refetch();
    },
  });
  const editableLanguage = selectedFile
    ? monacoLanguageForPath(selectedFile)
    : null;
  const dirty = draftVersion !== null && draft !== baselineContent;

  useEffect(() => {
    setDirectoryPath("");
    setSelectedFile(null);
    setFileMode("preview");
    setDraft("");
    setBaselineContent("");
    setDraftVersion(null);
  }, [explorer.id]);

  useEffect(() => {
    if (!file.data || draftVersion !== null) return;
    setDraft(file.data.content);
    setBaselineContent(file.data.content);
    setDraftVersion(file.data.version);
  }, [draftVersion, file.data]);

  useEffect(() => {
    onHeaderChange({
      directoryPath,
      isFetching: directory.isFetching,
      refresh: () => {
        void directory.refetch();
      },
    });
  }, [directory.isFetching, directory.refetch, directoryPath, onHeaderChange]);

  useEffect(() => {
    return () => onHeaderChange(null);
  }, [explorer.id, onHeaderChange]);

  const openEntry = (entry: ExplorerEntry) => {
    if (entry.kind === "directory") {
      setDirectoryPath(entry.path);
      return;
    }
    if (!entry.viewable) return;
    setDraft("");
    setBaselineContent("");
    setDraftVersion(null);
    saveFile.reset();
    setSelectedFile(entry.path);
    setFileMode(defaultExplorerFileMode(entry.path, entry.markdown));
  };

  const saveDraft = () => {
    if (!selectedFile || !draftVersion || !dirty || saveFile.isPending) return;
    saveFile.mutate({
      content: draft,
      explorerId: explorer.id,
      path: selectedFile,
      version: draftVersion,
    });
  };

  const reloadFile = async () => {
    saveFile.reset();
    const result = await file.refetch();
    if (!result.data) return;
    setDraft(result.data.content);
    setBaselineContent(result.data.content);
    setDraftVersion(result.data.version);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2 sm:p-3">
      {directory.isLoading ? (
        <div className="grid h-32 place-items-center text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      ) : directory.isError ? (
        <p className="p-3 text-xs leading-5 text-destructive">
          {directory.error instanceof Error
            ? directory.error.message
            : "Folder could not be loaded."}
        </p>
      ) : (
        <>
          {directoryPath ? (
            <button
              type="button"
              className="flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-muted-foreground hover:bg-muted/70 hover:text-foreground"
              onClick={() =>
                setDirectoryPath(
                  directoryPath.split("/").slice(0, -1).join("/"),
                )
              }
            >
              <FolderOpen className="size-4 shrink-0" />
              <span>..</span>
            </button>
          ) : null}
          {directory.data?.entries.map((entry) => {
            const Icon = entryIcon(entry);
            return (
              <button
                key={entry.path}
                type="button"
                className={cn(
                  "flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                  entry.kind === "file" &&
                    !entry.viewable &&
                    "cursor-default opacity-45 hover:bg-transparent hover:text-muted-foreground",
                )}
                onClick={() => openEntry(entry)}
                title={
                  entry.viewable || entry.kind === "directory"
                    ? entry.path
                    : `${entry.path} · Preview unavailable`
                }
              >
                <Icon className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.size !== null ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground/60">
                    {formatSize(entry.size)}
                  </span>
                ) : null}
              </button>
            );
          })}
          {directory.data?.entries.length === 0 ? (
            <div className="grid h-32 place-items-center text-sm text-muted-foreground">
              This folder is empty.
            </div>
          ) : null}
          {directory.data?.truncated ? (
            <p className="px-3 py-2 text-[10px] text-muted-foreground">
              Showing the first 1,000 entries.
            </p>
          ) : null}
        </>
      )}

      <Dialog
        open={Boolean(selectedFile)}
        onOpenChange={(open) => {
          if (open) return;
          if (
            dirty &&
            !window.confirm("Discard the unsaved changes to this file?")
          ) {
            return;
          }
          setSelectedFile(null);
          setDraftVersion(null);
          saveFile.reset();
        }}
      >
        <DialogContent className="flex h-[min(86svh,900px)] max-w-5xl flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12">
            <div className="flex min-w-0 items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-2">
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <DialogTitle className="truncate text-sm">
                  {selectedFile ?? "File preview"}
                </DialogTitle>
                {file.data ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {formatSize(file.data.size)}
                  </span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {file.data && editableLanguage ? (
                  <div className="flex rounded-md border bg-muted/30 p-0.5">
                    {(["preview", "edit"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={cn(
                          "rounded px-2 py-1 text-[10px] capitalize text-muted-foreground",
                          fileMode === mode &&
                            "bg-background text-foreground shadow-sm",
                        )}
                        onClick={() => setFileMode(mode)}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                ) : null}
                {file.data && editableLanguage && fileMode === "edit" ? (
                  <Button
                    aria-keyshortcuts="Meta+S Control+S"
                    className="h-7 gap-1.5 px-2 text-[11px]"
                    disabled={!dirty || saveFile.isPending}
                    onClick={saveDraft}
                    size="sm"
                    type="button"
                  >
                    {saveFile.isPending ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Save className="size-3" />
                    )}
                    {saveFile.isPending ? "Saving" : dirty ? "Save" : "Saved"}
                  </Button>
                ) : null}
              </div>
            </div>
            <DialogDescription className="sr-only">
              Preview or edit the selected project file.
            </DialogDescription>
          </DialogHeader>
          {saveFile.isError ? (
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
              <span className="min-w-0 truncate">
                {saveFile.error instanceof Error
                  ? saveFile.error.message
                  : "File could not be saved."}
              </span>
              <Button
                className="h-6 px-2 text-[10px]"
                onClick={() => void reloadFile()}
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
              <p className="m-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                {file.error instanceof Error
                  ? file.error.message
                  : "File could not be loaded."}
              </p>
            ) : file.data && fileMode === "preview" ? (
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
                  onSave={saveDraft}
                  value={draft}
                />
              </Suspense>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
