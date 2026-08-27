import type {
  ExplorerEntry,
  ExplorerFile,
  StandaloneChatSummary,
} from "@cantrip/protocol";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Download,
  File,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Markdown } from "@/components/chat/markdown";
import {
  monacoLanguageForPath,
  structuredFileFormatForPath,
} from "@/components/explorer/explorer-file-language";
import { formatExplorerSize } from "@/components/explorer/explorer-entry-metadata";
import { MonacoFileEditor } from "@/components/explorer/monaco-file-editor";
import { StructuredFileVisual } from "@/components/explorer/structured-file-visual";
import { Button } from "@/components/ui/button";
import {
  StyledContextMenuContent,
  StyledContextMenuItem,
} from "@/components/ui/styled-menu";
import {
  deleteStandaloneChatFileEntry,
  downloadStandaloneChatFiles,
  getStandaloneChatFile,
  getStandaloneChatFileDirectory,
  getWorkers,
  loadStandaloneChatFileMedia,
  saveStandaloneChatFile,
} from "@/lib/api";
import {
  chatFilesAreLocalToDesktop,
  chatScratchRevealUsesLocalFolder,
  desktopChatRevealLabel,
  revealChatScratchInNativeFileManager,
} from "@/lib/desktop-chat-files";
import { standaloneChatFileDownloadsVisible } from "@/lib/standalone-chat-file-locality";
import { listDesktopWorkers } from "@/lib/desktop-worker";
import { getActiveServerUrl } from "@/lib/server-connections";
import { cn } from "@/lib/utils";

type PreviewMode = "edit" | "preview" | "visual";

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function entryIcon(entry: ExplorerEntry, expanded: boolean) {
  if (entry.kind === "directory") return expanded ? FolderOpen : Folder;
  if (entry.markdown) return FileText;
  if (entry.viewable) return FileCode2;
  return File;
}

function ChatFileRow({
  depth,
  downloadArchive,
  downloadFile,
  entry,
  expanded,
  local,
  onDelete,
  onDownload,
  onOpen,
  onReveal,
  revealLabel,
  selected,
}: {
  depth: number;
  downloadArchive: boolean;
  downloadFile: boolean;
  entry: ExplorerEntry;
  expanded: boolean;
  local: boolean;
  onDelete(entry: ExplorerEntry): void;
  onDownload(entry: ExplorerEntry): void;
  onOpen(entry: ExplorerEntry): void;
  onReveal(entry: ExplorerEntry, shift: boolean): void;
  revealLabel: string | null;
  selected: boolean;
}) {
  const preferLocalRevealRef = useRef(false);
  const Icon = entryIcon(entry, expanded);
  const row = (
    <button
      aria-expanded={entry.kind === "directory" ? expanded : undefined}
      aria-level={depth + 1}
      aria-selected={selected}
      className={cn(
        "flex min-h-9 w-full items-center gap-1.5 px-2 text-left text-xs text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
        selected && "bg-primary/10 text-foreground",
        entry.symbolicLink && "opacity-55",
      )}
      data-chat-file-path={entry.path}
      onClick={() => onOpen(entry)}
      onContextMenu={(event) => {
        preferLocalRevealRef.current = event.shiftKey;
      }}
      onKeyDown={(event) => {
        const tree = event.currentTarget.closest('[role="tree"]');
        if (!tree) return;
        const rows = Array.from(
          tree.querySelectorAll<HTMLButtonElement>('[role="treeitem"]'),
        );
        const index = rows.indexOf(event.currentTarget);
        let target: HTMLButtonElement | undefined;
        if (event.key === "ArrowDown") target = rows[index + 1];
        else if (event.key === "ArrowUp") target = rows[index - 1];
        else if (event.key === "Home") target = rows[0];
        else if (event.key === "End") target = rows.at(-1);
        else if (event.key === "ArrowRight" && entry.kind === "directory") {
          if (!expanded) onOpen(entry);
          else target = rows[index + 1];
        } else if (event.key === "ArrowLeft") {
          if (entry.kind === "directory" && expanded) onOpen(entry);
          else {
            const parentPath = entry.path.split("/").slice(0, -1).join("/");
            target = rows.find(
              (candidate) => candidate.dataset.chatFilePath === parentPath,
            );
          }
        } else return;
        event.preventDefault();
        target?.focus();
      }}
      role="treeitem"
      title={
        entry.symbolicLink
          ? `${entry.path}\nSymbolic links are not followed.`
          : entry.path
      }
      type="button"
    >
      <span style={{ width: `${depth * 14}px` }} />
      {entry.kind === "directory" ? (
        expanded ? (
          <ChevronDown className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" />
        )
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      <span className="shrink-0 text-[9px] text-muted-foreground/60">
        {entry.size === null ? "" : formatExplorerSize(entry.size)}
      </span>
    </button>
  );
  if (entry.symbolicLink) return row;
  return (
    <ContextMenu.Root
      onOpenChange={(open) => {
        if (!open) preferLocalRevealRef.current = false;
      }}
    >
      <ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <StyledContextMenuContent className="min-w-48">
          {revealLabel ? (
            <StyledContextMenuItem
              onSelect={() => {
                onReveal(entry, preferLocalRevealRef.current);
                preferLocalRevealRef.current = false;
              }}
            >
              <FolderOpen className="size-4" />
              {revealLabel}
            </StyledContextMenuItem>
          ) : null}
          {standaloneChatFileDownloadsVisible(local) &&
          (entry.kind === "directory" ? downloadArchive : downloadFile) ? (
            <StyledContextMenuItem onSelect={() => onDownload(entry)}>
              <Download className="size-4" />
              {entry.kind === "directory"
                ? "Download folder ZIP"
                : "Download file"}
            </StyledContextMenuItem>
          ) : null}
          <StyledContextMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => onDelete(entry)}
          >
            <Trash2 className="size-4" />
            Delete {entry.kind === "directory" ? "folder" : "file"}
          </StyledContextMenuItem>
        </StyledContextMenuContent>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function ChatFileDirectory({
  chatId,
  depth,
  downloadArchive,
  downloadFile,
  enabled,
  expandedPaths,
  local,
  onDelete,
  onDownload,
  onOpen,
  onReveal,
  onToggle,
  path,
  revealLabel,
  selectedPath,
}: {
  chatId: string;
  depth: number;
  downloadArchive: boolean;
  downloadFile: boolean;
  enabled: boolean;
  expandedPaths: ReadonlySet<string>;
  local: boolean;
  onDelete(entry: ExplorerEntry): void;
  onDownload(entry: ExplorerEntry): void;
  onOpen(entry: ExplorerEntry): void;
  onReveal(entry: ExplorerEntry, shift: boolean): void;
  onToggle(path: string): void;
  path: string;
  revealLabel: string | null;
  selectedPath: string | null;
}) {
  const directory = useQuery({
    enabled,
    queryFn: () => getStandaloneChatFileDirectory(chatId, path),
    queryKey: ["standalone-chat-files", chatId, path],
    refetchInterval: enabled ? 3_000 : false,
  });
  if (!enabled) return null;
  if (directory.isLoading && !directory.data) {
    return (
      <div className="flex h-9 items-center gap-2 px-3 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Loading files…
      </div>
    );
  }
  if (directory.isError && !directory.data) {
    return (
      <button
        className="min-h-12 w-full px-3 text-left text-xs text-destructive hover:bg-destructive/5"
        onClick={() => void directory.refetch()}
        type="button"
      >
        Folder could not be loaded. Click to retry.
      </button>
    );
  }
  const entries = directory.data?.entries ?? [];
  return (
    <>
      {entries.map((entry) => {
        const expanded = expandedPaths.has(entry.path);
        return (
          <div key={entry.path} role="none">
            <ChatFileRow
              depth={depth}
              downloadArchive={downloadArchive}
              downloadFile={downloadFile}
              entry={entry}
              expanded={expanded}
              local={local}
              onDelete={onDelete}
              onDownload={onDownload}
              onOpen={(selected) => {
                if (selected.kind === "directory") onToggle(selected.path);
                else onOpen(selected);
              }}
              onReveal={onReveal}
              revealLabel={revealLabel}
              selected={entry.path === selectedPath}
            />
            {entry.kind === "directory" ? (
              <div role="group">
                <ChatFileDirectory
                  chatId={chatId}
                  depth={depth + 1}
                  downloadArchive={downloadArchive}
                  downloadFile={downloadFile}
                  enabled={expanded}
                  expandedPaths={expandedPaths}
                  local={local}
                  onDelete={onDelete}
                  onDownload={onDownload}
                  onOpen={onOpen}
                  onReveal={onReveal}
                  onToggle={onToggle}
                  path={entry.path}
                  revealLabel={revealLabel}
                  selectedPath={selectedPath}
                />
              </div>
            ) : null}
          </div>
        );
      })}
      {entries.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">
          This folder is empty.
        </p>
      ) : null}
      {directory.data?.truncated ? (
        <p className="px-3 py-2 text-[10px] text-muted-foreground">
          Showing the first 1,000 entries.
        </p>
      ) : null}
    </>
  );
}

function ChatFileMediaPreview({
  chatId,
  entry,
}: {
  chatId: string;
  entry: ExplorerEntry;
}) {
  const media = useQuery({
    queryFn: () => loadStandaloneChatFileMedia(chatId, entry.path),
    queryKey: [
      "standalone-chat-file-media",
      chatId,
      entry.path,
      entry.modifiedAt,
    ],
  });
  const source = useMemo(
    () => (media.data ? URL.createObjectURL(media.data) : null),
    [media.data],
  );
  useEffect(
    () => () => {
      if (source) URL.revokeObjectURL(source);
    },
    [source],
  );
  if (media.isLoading) {
    return (
      <Loader2 className="m-auto size-5 animate-spin text-muted-foreground" />
    );
  }
  if (media.isError || !media.data || !source) {
    return (
      <p className="m-auto p-4 text-xs text-destructive">
        Media preview unavailable.
      </p>
    );
  }
  const type = media.data.type;
  if (type.startsWith("image/")) {
    return (
      <img
        alt={entry.name}
        className="m-auto max-h-full max-w-full object-contain p-3"
        src={source}
      />
    );
  }
  if (type.startsWith("audio/")) {
    return (
      <audio
        aria-label={entry.name}
        className="m-auto w-[90%]"
        controls
        src={source}
      />
    );
  }
  return (
    <video
      aria-label={entry.name}
      className="m-auto max-h-full max-w-full p-3"
      controls
      playsInline
      src={source}
    />
  );
}

function ChatFilePreview({
  chatId,
  entry,
  onSaved,
}: {
  chatId: string;
  entry: ExplorerEntry | null;
  onSaved(): void;
}) {
  const query = useQuery({
    enabled: Boolean(
      entry?.viewable &&
      !entry.symbolicLink &&
      !entry.path.match(
        /\.(?:aac|apng|avif|bmp|flac|gif|ico|jpe?g|m4[av]|mov|mp3|mp4|oga|ogg|ogv|opus|png|svg|wav|weba|webm|webp)$/iu,
      ),
    ),
    queryFn: () => getStandaloneChatFile(chatId, entry!.path),
    queryKey: ["standalone-chat-file", chatId, entry?.path, entry?.modifiedAt],
  });
  const [content, setContent] = useState("");
  const [version, setVersion] = useState("");
  const [mode, setMode] = useState<PreviewMode>("edit");
  useEffect(() => {
    if (!query.data) return;
    setContent(query.data.content);
    setVersion(query.data.version);
    setMode(
      structuredFileFormatForPath(query.data.path)
        ? "visual"
        : query.data.markdown
          ? "preview"
          : "edit",
    );
  }, [query.data]);
  const save = useMutation({
    mutationFn: () =>
      saveStandaloneChatFile(chatId, {
        path: entry!.path,
        content,
        version,
      }),
    onSuccess: (saved: ExplorerFile) => {
      setContent(saved.content);
      setVersion(saved.version);
      onSaved();
    },
  });
  if (!entry) {
    return (
      <div className="grid h-full place-items-center p-5 text-center text-xs text-muted-foreground">
        Select a file to preview or edit it.
      </div>
    );
  }
  const media = entry.path.match(
    /\.(?:aac|apng|avif|bmp|flac|gif|ico|jpe?g|m4[av]|mov|mp3|mp4|oga|ogg|ogv|opus|png|svg|wav|weba|webm|webp)$/iu,
  );
  if (media) return <ChatFileMediaPreview chatId={chatId} entry={entry} />;
  if (!entry.viewable) {
    return (
      <div className="grid h-full place-items-center p-5 text-center text-xs text-muted-foreground">
        <div>
          <File className="mx-auto mb-2 size-6" />
          <p className="font-medium text-foreground">Preview unavailable</p>
          <p className="mt-1">
            {formatExplorerSize(entry.size ?? 0)} · {entry.path}
          </p>
        </div>
      </div>
    );
  }
  if (query.isLoading && !query.data) {
    return (
      <Loader2 className="m-auto size-5 animate-spin text-muted-foreground" />
    );
  }
  if (query.isError || !query.data) {
    return (
      <div className="m-auto max-w-full p-5 text-center text-xs text-muted-foreground">
        <File className="mx-auto mb-2 size-6" />
        <p className="font-medium text-destructive">
          {query.error instanceof Error
            ? query.error.message
            : "File preview unavailable."}
        </p>
        <p className="mt-1 break-all">
          {formatExplorerSize(entry.size ?? 0)} · {entry.path}
        </p>
      </div>
    );
  }
  const format = structuredFileFormatForPath(entry.path);
  const language = monacoLanguageForPath(entry.path) ?? "plaintext";
  const dirty = content !== query.data.content;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <span
          className="min-w-0 flex-1 truncate text-[11px] font-medium"
          title={entry.path}
        >
          {entry.name}
        </span>
        {entry.markdown ? (
          <Button
            size="sm"
            variant={mode === "preview" ? "outline" : "ghost"}
            onClick={() => setMode("preview")}
          >
            Preview
          </Button>
        ) : null}
        {format ? (
          <Button
            size="sm"
            variant={mode === "visual" ? "outline" : "ghost"}
            onClick={() => setMode("visual")}
          >
            Visual
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={mode === "edit" ? "outline" : "ghost"}
          onClick={() => setMode("edit")}
        >
          Edit
        </Button>
        <Button
          aria-label="Save Chat file"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
          size="icon"
          title="Save (⌘S / Ctrl+S)"
          variant="ghost"
        >
          {save.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Save className="size-3.5" />
          )}
        </Button>
      </div>
      {save.isError ? (
        <p className="border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-[10px] text-destructive">
          {save.error instanceof Error ? save.error.message : "Save failed."}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === "preview" && entry.markdown ? (
          <div className="h-full overflow-auto">
            <Markdown>{content}</Markdown>
          </div>
        ) : mode === "visual" && format ? (
          <StructuredFileVisual
            content={content}
            format={format}
            onChange={setContent}
            onSave={() => save.mutate()}
            path={entry.path}
          />
        ) : (
          <MonacoFileEditor
            language={language}
            modelPath={`cantrip://chat-files/${encodeURIComponent(chatId)}/${entry.path.split("/").map(encodeURIComponent).join("/")}`}
            onChange={setContent}
            onSave={() => save.mutate()}
            value={content}
          />
        )}
      </div>
    </div>
  );
}

export function StandaloneChatFilesPanel({
  chat,
  desktopRuntime,
  requestedPath,
}: {
  chat: StandaloneChatSummary;
  desktopRuntime: boolean;
  requestedPath: string | null;
}) {
  const queryClient = useQueryClient();
  const workers = useQuery({ queryFn: getWorkers, queryKey: ["workers"] });
  const desktopWorkers = useQuery({
    enabled: desktopRuntime,
    queryFn: listDesktopWorkers,
    queryKey: ["desktop-workers", getActiveServerUrl()],
  });
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [selectedEntry, setSelectedEntry] = useState<ExplorerEntry | null>(
    null,
  );
  const worker = workers.data?.find(
    (candidate) => candidate.workerId === chat.activeWorkerId,
  );
  const workerId = chat.activeWorkerId;
  const capabilities = worker?.standaloneChat.files;
  const local = Boolean(
    workerId &&
    chatFilesAreLocalToDesktop(
      workerId,
      getActiveServerUrl(),
      desktopWorkers.data ?? [],
    ),
  );
  const revealLabel = desktopChatRevealLabel(
    desktopRuntime,
    navigator.userAgent,
  );
  useEffect(() => {
    if (!requestedPath) return;
    const parts = requestedPath.split("/");
    setExpandedPaths(
      new Set(
        parts
          .slice(0, -1)
          .map((_, index) => parts.slice(0, index + 1).join("/")),
      ),
    );
    setSelectedEntry({
      kind: "file",
      markdown: /\.(?:md|markdown|mdx)$/iu.test(requestedPath),
      modifiedAt: new Date(0).toISOString(),
      name: parts.at(-1) ?? requestedPath,
      path: requestedPath,
      size: null,
      symbolicLink: false,
      viewable: true,
    });
  }, [requestedPath]);
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: ["standalone-chat-files", chat.id],
    });
  const remove = useMutation({
    mutationFn: async (entry: ExplorerEntry) => {
      const confirmed = window.confirm(
        entry.kind === "directory"
          ? `Delete ${entry.name} and everything inside it?`
          : `Delete ${entry.name}?`,
      );
      if (!confirmed) return null;
      return deleteStandaloneChatFileEntry(chat.id, {
        path: entry.path,
        recursive: entry.kind === "directory",
      });
    },
    onSuccess: (deleted, entry) => {
      if (!deleted) return;
      if (
        selectedEntry?.path === entry.path ||
        selectedEntry?.path.startsWith(`${entry.path}/`)
      )
        setSelectedEntry(null);
      void invalidate();
    },
  });
  const download = useMutation({
    mutationFn: (input: { kind: "all" | "file" | "folder"; path: string }) =>
      downloadStandaloneChatFiles(chat.id, input),
    onSuccess: ({ blob, fileName }) => downloadBlob(blob, fileName),
  });
  const reveal = useMutation({
    mutationFn: (input: { entry: ExplorerEntry; preferLocal: boolean }) =>
      revealChatScratchInNativeFileManager(
        chat,
        input.preferLocal,
        input.entry.path,
      ),
  });
  const actionError = remove.error ?? download.error ?? reveal.error;
  const ready = Boolean(
    worker?.online &&
    capabilities?.list &&
    capabilities.read &&
    capabilities.write &&
    capabilities.remove,
  );
  const networkShare = Boolean(capabilities?.networkShare);
  const revealSupported = desktopRuntime && (local || networkShare);
  return (
    <div className="flex h-full min-h-0 flex-col pt-11">
      <div className="flex h-9 shrink-0 items-center gap-1 border-y px-2">
        <Button
          aria-label="Refresh Chat files"
          onClick={() => void invalidate()}
          size="icon"
          title="Refresh files"
          variant="ghost"
        >
          <RefreshCw className="size-3.5" />
        </Button>
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
          Scratch workspace
        </span>
        {standaloneChatFileDownloadsVisible(local) && capabilities?.archive ? (
          <Button
            disabled={download.isPending}
            onClick={() => download.mutate({ kind: "all", path: "" })}
            size="sm"
            title="Download all Chat files as ZIP"
            variant="ghost"
          >
            {download.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}{" "}
            All
          </Button>
        ) : null}
      </div>
      {!ready ? (
        <div className="grid min-h-0 flex-1 place-items-center p-5 text-center text-xs text-muted-foreground">
          <div>
            <Folder className="mx-auto mb-2 size-6" />
            <p>
              {worker?.online
                ? "This worker does not support Chat file operations."
                : "The Chat worker is offline. Files remain on that worker."}
            </p>
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(9rem,38%)_minmax(0,1fr)]">
          <div
            className="overflow-auto border-b"
            role="tree"
            aria-label="Chat files"
          >
            <ChatFileDirectory
              chatId={chat.id}
              depth={0}
              downloadArchive={Boolean(capabilities?.archive)}
              downloadFile={Boolean(capabilities?.download)}
              enabled
              expandedPaths={expandedPaths}
              local={local}
              onDelete={(entry) => remove.mutate(entry)}
              onDownload={(entry) =>
                download.mutate({
                  kind: entry.kind === "directory" ? "folder" : "file",
                  path: entry.path,
                })
              }
              onOpen={setSelectedEntry}
              onReveal={(entry, shift) =>
                reveal.mutate({
                  entry,
                  preferLocal: chatScratchRevealUsesLocalFolder(
                    local,
                    networkShare,
                    shift,
                  ),
                })
              }
              onToggle={(path) =>
                setExpandedPaths((current) => {
                  const next = new Set(current);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return next;
                })
              }
              path=""
              revealLabel={revealSupported ? revealLabel : null}
              selectedPath={selectedEntry?.path ?? null}
            />
          </div>
          <ChatFilePreview
            chatId={chat.id}
            entry={selectedEntry}
            onSaved={() => void invalidate()}
          />
        </div>
      )}
      {actionError ? (
        <p className="shrink-0 border-t border-destructive/30 bg-destructive/5 px-3 py-2 text-[10px] text-destructive">
          {actionError instanceof Error
            ? actionError.message
            : "Chat file action failed."}
        </p>
      ) : null}
    </div>
  );
}
