import type { ExplorerEntry, ExplorerSummary } from "@cantrip/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  File,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Highlight, themes, type Language } from "prism-react-renderer";
import { useEffect, useMemo, useState } from "react";

import { Markdown } from "@/components/chat/markdown";
import { Button } from "@/components/ui/button";
import { getExplorerDirectory, getExplorerFile } from "@/lib/api";
import { cn } from "@/lib/utils";

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

export function ExplorerView({ explorer }: { explorer: ExplorerSummary }) {
  const [directoryPath, setDirectoryPath] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [markdownMode, setMarkdownMode] = useState<"preview" | "source">(
    "preview",
  );
  const directory = useQuery({
    queryFn: () => getExplorerDirectory(explorer.id, directoryPath),
    queryKey: ["explorer-directory", explorer.id, directoryPath],
  });
  const file = useQuery({
    enabled: Boolean(selectedFile),
    queryFn: () => getExplorerFile(explorer.id, selectedFile!),
    queryKey: ["explorer-file", explorer.id, selectedFile],
  });
  const breadcrumbs = useMemo(() => {
    const parts = directoryPath.split("/").filter(Boolean);
    return [
      { label: "Project", path: "" },
      ...parts.map((part, index) => ({
        label: part,
        path: parts.slice(0, index + 1).join("/"),
      })),
    ];
  }, [directoryPath]);

  useEffect(() => {
    setDirectoryPath("");
    setSelectedFile(null);
    setMarkdownMode("preview");
  }, [explorer.id]);

  const openEntry = (entry: ExplorerEntry) => {
    if (entry.kind === "directory") {
      setDirectoryPath(entry.path);
      setSelectedFile(null);
      return;
    }
    if (!entry.viewable) return;
    setSelectedFile(entry.path);
    setMarkdownMode(entry.markdown ? "preview" : "source");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
      <aside className="flex h-60 shrink-0 flex-col border-b bg-background sm:h-auto sm:w-72 sm:border-b-0 sm:border-r">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
          <div className="flex min-w-0 flex-1 items-center overflow-hidden text-xs">
            {breadcrumbs.map((crumb, index) => (
              <div
                key={crumb.path || "root"}
                className="flex min-w-0 items-center"
              >
                {index > 0 ? (
                  <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                ) : null}
                <button
                  type="button"
                  className="truncate rounded px-1 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => {
                    setDirectoryPath(crumb.path);
                    setSelectedFile(null);
                  }}
                >
                  {crumb.label}
                </button>
              </div>
            ))}
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            disabled={directory.isFetching}
            onClick={() => directory.refetch()}
          >
            <RefreshCw
              className={cn("size-3.5", directory.isFetching && "animate-spin")}
            />
            <span className="sr-only">Refresh folder</span>
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {directory.isLoading ? (
            <div className="grid h-24 place-items-center text-muted-foreground">
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
                  className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => {
                    setDirectoryPath(
                      directoryPath.split("/").slice(0, -1).join("/"),
                    );
                    setSelectedFile(null);
                  }}
                >
                  <FolderOpen className="size-4" /> ..
                </button>
              ) : null}
              {directory.data?.entries.map((entry) => {
                const Icon = entryIcon(entry);
                const selected = selectedFile === entry.path;
                return (
                  <button
                    key={entry.path}
                    type="button"
                    className={cn(
                      "flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs",
                      selected
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
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
                    <span className="min-w-0 flex-1 truncate">
                      {entry.name}
                    </span>
                    {entry.size !== null ? (
                      <span className="shrink-0 text-[9px] text-muted-foreground/60">
                        {formatSize(entry.size)}
                      </span>
                    ) : null}
                  </button>
                );
              })}
              {directory.data?.truncated ? (
                <p className="p-2 text-[10px] text-muted-foreground">
                  Showing the first 1,000 entries.
                </p>
              ) : null}
            </>
          )}
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selectedFile ? (
          <>
            <header className="flex h-10 shrink-0 items-center justify-between gap-3 border-b px-3">
              <div className="flex min-w-0 items-center gap-2">
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-xs font-medium">
                  {selectedFile}
                </span>
                {file.data ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {formatSize(file.data.size)}
                  </span>
                ) : null}
              </div>
              {file.data?.markdown ? (
                <div className="flex rounded-md border bg-muted/30 p-0.5">
                  {(["preview", "source"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={cn(
                        "rounded px-2 py-1 text-[10px] capitalize text-muted-foreground",
                        markdownMode === mode &&
                          "bg-background text-foreground shadow-sm",
                      )}
                      onClick={() => setMarkdownMode(mode)}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              ) : null}
            </header>
            <div className="min-h-0 flex-1 overflow-auto">
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
              ) : file.data?.markdown && markdownMode === "preview" ? (
                <article className="mx-auto max-w-4xl p-6 sm:p-10">
                  <Markdown>{file.data.content}</Markdown>
                </article>
              ) : file.data ? (
                <SourceView code={file.data.content} path={file.data.path} />
              ) : null}
            </div>
          </>
        ) : (
          <div className="grid flex-1 place-items-center p-6 text-center">
            <div>
              <div className="mx-auto grid size-11 place-items-center rounded-xl border bg-card">
                <FolderOpen className="size-5" />
              </div>
              <p className="mt-3 text-sm font-medium">Choose a text file</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Markdown opens in preview mode. Other supported text files use
                syntax highlighting.
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
