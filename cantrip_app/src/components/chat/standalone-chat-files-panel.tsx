import type { ExplorerEntry, StandaloneChatSummary } from "@cantrip/protocol";
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
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChatFilePreview } from "./standalone-chat-file-preview";
import { NativeFileWindowCloseGuard } from "@/components/app/native-file-window-close-guard";
import { chatEditorSessions } from "./standalone-chat-editor-sessions";
import type { EditorDocumentSession } from "@/components/editor/document-session";
import { formatExplorerSize } from "@/components/explorer/explorer-entry-metadata";
import { Button } from "@/components/ui/button";
import {
  NativeFolderRevealIcon,
  useShiftKeyHeld,
} from "@/components/ui/native-folder-reveal-icon";
import {
  StyledContextMenuContent,
  StyledContextMenuItem,
} from "@/components/ui/styled-menu";
import {
  deleteStandaloneChatFileEntry,
  downloadStandaloneChatFiles,
  getStandaloneChatFileDirectory,
  getWorkers,
} from "@/lib/api";
import {
  chatFilesAreLocalToDesktop,
  chatScratchRevealUsesLocalFolder,
  desktopChatRevealLabel,
  revealChatScratchInNativeFileManager,
} from "@/lib/desktop-chat-files";
import { standaloneChatFileDownloadsVisible } from "@/lib/standalone-chat-file-locality";
import {
  desktopPopoutTitlebarLeftInset,
  isMacosDesktopRuntime,
  openDesktopStandaloneChatFile,
  updateDesktopWindowTitle,
} from "@/lib/desktop-popout";
import { listDesktopWorkers } from "@/lib/desktop-worker";
import { getActiveServerUrl } from "@/lib/server-connections";
import { cn } from "@/lib/utils";

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
  localFolderModifier,
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
  localFolderModifier: boolean;
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
              onClick={(event) => {
                preferLocalRevealRef.current = event.shiftKey;
              }}
              onSelect={() => {
                onReveal(entry, preferLocalRevealRef.current);
                preferLocalRevealRef.current = false;
              }}
            >
              <NativeFolderRevealIcon
                className="size-4"
                localFolder={localFolderModifier}
              />
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
  localFolderModifier,
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
  localFolderModifier: boolean;
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
              localFolderModifier={localFolderModifier}
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
                  localFolderModifier={localFolderModifier}
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

function chatFileEntry(path: string): ExplorerEntry {
  const parts = path.split("/");
  return {
    kind: "file",
    markdown: /\.(?:md|markdown|mdx)$/iu.test(path),
    modifiedAt: new Date(0).toISOString(),
    name: parts.at(-1) ?? path,
    path,
    size: null,
    symbolicLink: false,
    viewable: true,
  };
}

export function StandaloneChatFileWindow({
  chatId,
  path,
}: {
  chatId: string;
  path: string;
}) {
  const entry = useMemo(() => chatFileEntry(path), [path]);
  useEffect(() => {
    void updateDesktopWindowTitle(`${entry.name} — Cantrip`);
  }, [entry.name]);
  return (
    <main className="flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <NativeFileWindowCloseGuard
        hasUnsavedChanges={() => chatEditorSessions.hasDirtyDocuments}
      />
      <header
        className="relative flex h-9 shrink-0 items-center border-b border-border/70 bg-background pr-2"
        data-tauri-drag-region=""
        style={{
          paddingLeft:
            desktopPopoutTitlebarLeftInset(true, isMacosDesktopRuntime()) ??
            "0.5rem",
        }}
      >
        <span
          className="min-w-0 flex-1 truncate px-2 text-xs text-muted-foreground"
          data-tauri-drag-region=""
          title={path}
        >
          {path}
        </span>
      </header>
      <div className="min-h-0 flex-1">
        <ChatFilePreview
          chatId={chatId}
          entry={entry}
          onSaved={() => undefined}
        />
      </div>
    </main>
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
  const shiftKeyHeld = useShiftKeyHeld();
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
  const [openError, setOpenError] = useState<unknown>(null);
  const fileDirty = useRef(false);
  const fileDocument = useRef<EditorDocumentSession | null>(null);
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
  const openFile = useCallback(
    (entry: ExplorerEntry) => {
      if (
        !desktopRuntime &&
        fileDirty.current &&
        !window.confirm("Open another file and discard its unsaved changes?")
      )
        return;
      if (!desktopRuntime && fileDocument.current) {
        chatEditorSessions.discard(fileDocument.current.id);
        fileDocument.current = null;
        fileDirty.current = false;
      }
      setSelectedEntry(entry);
      if (!desktopRuntime) return;
      setOpenError(null);
      void openDesktopStandaloneChatFile(
        { chatId: chat.id, path: entry.path },
        entry.name,
      ).catch(setOpenError);
    },
    [chat.id, desktopRuntime],
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
    openFile(chatFileEntry(requestedPath));
  }, [openFile, requestedPath]);
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
  const actionError =
    remove.error ?? download.error ?? reveal.error ?? openError;
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
        <div className="min-h-0 flex-1 overflow-auto">
          <div role="tree" aria-label="Chat files">
            <ChatFileDirectory
              chatId={chat.id}
              depth={0}
              downloadArchive={Boolean(capabilities?.archive)}
              downloadFile={Boolean(capabilities?.download)}
              enabled
              expandedPaths={expandedPaths}
              local={local}
              localFolderModifier={shiftKeyHeld}
              onDelete={(entry) => remove.mutate(entry)}
              onDownload={(entry) =>
                download.mutate({
                  kind: entry.kind === "directory" ? "folder" : "file",
                  path: entry.path,
                })
              }
              onOpen={openFile}
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
        </div>
      )}
      {!desktopRuntime && selectedEntry ? (
        <div className="mobile-safe-top fixed inset-0 z-[100] flex min-h-0 flex-col bg-background text-foreground">
          <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
            <span
              className="min-w-0 flex-1 truncate text-xs font-medium"
              title={selectedEntry.path}
            >
              {selectedEntry.path}
            </span>
            <Button
              aria-label="Close Chat file"
              onClick={() => {
                if (
                  fileDirty.current &&
                  !window.confirm(
                    "Close this file and discard its unsaved changes?",
                  )
                )
                  return;
                fileDirty.current = false;
                if (fileDocument.current)
                  chatEditorSessions.discard(fileDocument.current.id);
                fileDocument.current = null;
                setSelectedEntry(null);
              }}
              size="icon"
              title="Close file"
              variant="ghost"
            >
              <X className="size-4" />
            </Button>
          </header>
          <div className="min-h-0 flex-1">
            <ChatFilePreview
              chatId={chat.id}
              chat={chat}
              key={selectedEntry.path}
              entry={selectedEntry}
              onDirtyChange={(dirty, document) => {
                fileDirty.current = dirty;
                fileDocument.current = document;
              }}
              onSaved={() => void invalidate()}
            />
          </div>
        </div>
      ) : null}
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
