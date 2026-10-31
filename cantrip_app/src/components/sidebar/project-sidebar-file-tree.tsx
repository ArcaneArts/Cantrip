import {
  explorerEntryNameSchema,
  type ExplorerEntry,
  type ExplorerSummary,
} from "@cantrip/protocol";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  ChevronDown,
  ChevronRight,
  FileClock,
  FilePlus2,
  FolderPlus,
  Link2,
  Loader2,
  Network,
  Pencil,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { useExplorerDirectory } from "@/components/explorer/use-explorer-directory";
import { useExplorerWorkerEncryption } from "@/components/explorer/use-explorer-worker-encryption";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  NativeFolderRevealIcon,
  useShiftKeyHeld,
} from "@/components/ui/native-folder-reveal-icon";
import {
  StyledContextMenuContent,
  StyledContextMenuItem,
} from "@/components/ui/styled-menu";
import { cn } from "@/lib/utils";
import { useFileChangeActivity } from "./use-file-change-activity";
import { useSidebarFolderExpansion } from "./use-sidebar-folder-expansion";
import { requestGitFileHistory } from "@/lib/git-history-navigation";
import { FileTypeIcon } from "@/components/files/file-type-icon";
import {
  SidebarNewFileRow,
  useSidebarNewFile,
  type SidebarNewFileDraft,
} from "./sidebar-new-file";

const SIDEBAR_FILE_TREE_INDENT_PX = 6;
const SIDEBAR_HIDDEN_METADATA_NAMES = new Set([".ds_store", "thumbs.db"]);

function visibleSidebarEntries(
  entries: readonly ExplorerEntry[],
): ExplorerEntry[] {
  return entries.filter(
    (entry) => !SIDEBAR_HIDDEN_METADATA_NAMES.has(entry.name.toLowerCase()),
  );
}

export function sidebarEntryRenameError(value: string): string | null {
  const result = explorerEntryNameSchema.safeParse(value);
  return result.success
    ? null
    : (result.error.issues[0]?.message ?? "Enter a valid name.");
}

export type ExplorerFileMutationAuthorization = {
  bindingKey: string;
  isCurrent(): boolean;
};

function useFileNameMenuAction() {
  const pendingAction = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      pendingAction.current = null;
    },
    [],
  );
  return {
    afterClose(action: () => void) {
      pendingAction.current = action;
    },
    onCloseAutoFocus(event: { preventDefault(): void }) {
      const action = pendingAction.current;
      if (!action) return;
      pendingAction.current = null;
      event.preventDefault();
      // Mount the input after the menu releases its focus trap. Focusing it
      // during selection can blur it immediately and submit the default name.
      action();
    },
  };
}

function SidebarFilesContextMenu({
  children,
  createPending,
  localFolderModifier,
  onCreateFolder,
  onCreateFile,
  onOpenNative,
  revealLabel,
}: {
  children: ReactElement;
  createPending: boolean;
  localFolderModifier: boolean;
  onCreateFolder?(): void;
  onCreateFile?(): void;
  onOpenNative?(localFolder: boolean): void;
  revealLabel?: string;
}) {
  const revealLocalFolder = useRef(false);
  const fileNameAction = useFileNameMenuAction();
  if ((!onOpenNative || !revealLabel) && !onCreateFolder && !onCreateFile)
    return children;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <StyledContextMenuContent
          className="min-w-48"
          onCloseAutoFocus={fileNameAction.onCloseAutoFocus}
        >
          {onOpenNative && revealLabel ? (
            <StyledContextMenuItem
              aria-label={`Open project root in ${revealLabel}`}
              onClick={(event) => {
                revealLocalFolder.current = event.shiftKey;
              }}
              onSelect={() => {
                const localFolder = revealLocalFolder.current;
                revealLocalFolder.current = false;
                onOpenNative(localFolder);
              }}
            >
              <NativeFolderRevealIcon
                className="size-4"
                localFolder={localFolderModifier}
              />
              Open in {revealLabel}
            </StyledContextMenuItem>
          ) : null}
          {onCreateFile ? (
            <StyledContextMenuItem
              aria-label="Create file in project root"
              disabled={createPending}
              onSelect={() => fileNameAction.afterClose(onCreateFile)}
            >
              <FilePlus2 className="size-4" /> New File
            </StyledContextMenuItem>
          ) : null}
          {onCreateFolder ? (
            <StyledContextMenuItem
              aria-label="Create folder in project root"
              disabled={createPending}
              onSelect={() => fileNameAction.afterClose(onCreateFolder)}
            >
              {createPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <FolderPlus className="size-4" />
              )}
              New Folder
            </StyledContextMenuItem>
          ) : null}
        </StyledContextMenuContent>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function SidebarFileRow({
  active,
  depth,
  entry,
  editing,
  expanded = false,
  localFolderModifier,
  onDelete,
  onCreateFolder,
  onCreateFile,
  createPending = false,
  onOpenGraph,
  onOpenHistory,
  onOpenNative,
  onOpen,
  onOpenTerminal,
  onPin,
  onRename,
  onRenameCancel,
  onRenameSubmit,
  onRenameValueChange,
  renamePending,
  renameValue,
  revealLabel,
}: {
  active: boolean;
  depth: number;
  entry: ExplorerEntry;
  editing: boolean;
  expanded?: boolean;
  localFolderModifier: boolean;
  onDelete(): void;
  onCreateFolder?(): void;
  onCreateFile?(): void;
  createPending?: boolean;
  onOpenGraph?(): void;
  onOpenHistory?(): void;
  onOpenNative?(localFolder: boolean): void;
  onOpen(): void;
  onOpenTerminal?(): void;
  onPin?(): void;
  onRename(): void;
  onRenameCancel(): void;
  onRenameSubmit(): void;
  onRenameValueChange(value: string): void;
  renamePending: boolean;
  renameValue: string;
  revealLabel?: string;
}) {
  const openable = entry.kind === "directory" || entry.viewable;
  const renameInputRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const cancelRenameOnBlurRef = useRef(false);
  const fileNameAction = useFileNameMenuAction();
  const revealLocalFolder = useRef(false);
  useEffect(() => {
    if (!editing) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [editing]);
  useEffect(() => {
    if (!active) return;
    rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  const row = (
    <div
      aria-disabled={!openable}
      aria-expanded={entry.kind === "directory" ? expanded : undefined}
      aria-level={depth + 1}
      data-elite-global
      data-elite-ignore={editing ? "" : undefined}
      className={cn(
        "flex h-7 w-full min-w-0 items-center gap-1 rounded px-1 text-left text-xs text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
        active && "bg-muted text-foreground",
        !openable &&
          !editing &&
          "cursor-default opacity-45 hover:bg-transparent hover:text-muted-foreground",
      )}
      onClick={(event) => {
        if (!editing && openable && event.currentTarget === event.target) {
          onOpen();
        }
      }}
      onDoubleClick={(event) => {
        if (editing || !onPin || !openable) return;
        event.preventDefault();
        onPin();
      }}
      onContextMenu={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (
          editing ||
          !openable ||
          (event.key !== "Enter" && event.key !== " ")
        )
          return;
        event.preventDefault();
        onOpen();
      }}
      role="treeitem"
      ref={rowRef}
      tabIndex={editing ? -1 : 0}
    >
      <span
        className="flex min-w-0 flex-1 items-center gap-1.5"
        onClick={() => {
          if (!editing && openable) onOpen();
        }}
        style={{ paddingLeft: `${depth * SIDEBAR_FILE_TREE_INDENT_PX}px` }}
      >
        {entry.kind === "directory" ? (
          expanded ? (
            <ChevronDown className="size-3 shrink-0" />
          ) : (
            <ChevronRight className="size-3 shrink-0" />
          )
        ) : (
          <span className="size-3 shrink-0" aria-hidden="true" />
        )}
        <FileTypeIcon
          path={entry.name}
          kind={entry.kind}
          expanded={expanded}
          className="size-3.5"
        />
        {editing ? (
          <input
            aria-label={`Rename ${entry.name}`}
            className="h-5 min-w-0 flex-1 rounded border bg-background px-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
            disabled={renamePending}
            onBlur={() => {
              if (cancelRenameOnBlurRef.current) {
                cancelRenameOnBlurRef.current = false;
                return;
              }
              onRenameSubmit();
            }}
            onChange={(event) => onRenameValueChange(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                onRenameSubmit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelRenameOnBlurRef.current = true;
                onRenameCancel();
              }
            }}
            ref={renameInputRef}
            value={renameValue}
          />
        ) : (
          <span className="truncate" data-file-change-path={entry.path}>
            {entry.name}
          </span>
        )}
        {editing && renamePending ? (
          <Loader2 className="ml-auto size-3 shrink-0 animate-spin" />
        ) : null}
        {entry.symbolicLink ? (
          <Link2
            className="ml-auto size-3 shrink-0"
            aria-label="Symbolic link"
          />
        ) : null}
      </span>
    </div>
  );
  if (entry.kind !== "directory" && entry.kind !== "file") return row;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <StyledContextMenuContent
          className="min-w-48"
          onCloseAutoFocus={fileNameAction.onCloseAutoFocus}
        >
          {entry.kind === "file" && onOpenHistory ? (
            <StyledContextMenuItem onSelect={onOpenHistory}>
              <FileClock className="size-4" />
              Open File History
            </StyledContextMenuItem>
          ) : null}
          {onOpenNative && revealLabel ? (
            <StyledContextMenuItem
              onClick={(event) => {
                revealLocalFolder.current = event.shiftKey;
              }}
              onSelect={() => {
                const localFolder = revealLocalFolder.current;
                revealLocalFolder.current = false;
                onOpenNative(localFolder);
              }}
            >
              <NativeFolderRevealIcon
                className="size-4"
                localFolder={localFolderModifier}
              />
              {entry.kind === "directory" ? "Open" : "Show"} in {revealLabel}
            </StyledContextMenuItem>
          ) : null}
          {entry.kind === "directory" && onOpenTerminal ? (
            <StyledContextMenuItem onSelect={onOpenTerminal}>
              <SquareTerminal className="size-4" />
              Open in Terminal
            </StyledContextMenuItem>
          ) : null}
          {entry.kind === "directory" && onOpenGraph ? (
            <StyledContextMenuItem onSelect={onOpenGraph}>
              <Network className="size-4" />
              Open in Graph
            </StyledContextMenuItem>
          ) : null}
          {entry.kind === "directory" && onCreateFile ? (
            <StyledContextMenuItem
              aria-label={`Create file in ${entry.path}`}
              disabled={createPending}
              onSelect={() => fileNameAction.afterClose(onCreateFile)}
            >
              <FilePlus2 className="size-4" /> New File
            </StyledContextMenuItem>
          ) : null}
          {entry.kind === "directory" && onCreateFolder ? (
            <StyledContextMenuItem
              aria-label={`Create folder in ${entry.path}`}
              disabled={createPending}
              onSelect={() => fileNameAction.afterClose(onCreateFolder)}
            >
              <FolderPlus className="size-4" />
              New Folder
            </StyledContextMenuItem>
          ) : null}
          {onOpenNative ||
          (entry.kind === "directory" &&
            (onOpenTerminal ||
              onOpenGraph ||
              onCreateFolder ||
              onCreateFile)) ? (
            <ContextMenu.Separator className="my-1 h-px bg-border" />
          ) : null}
          <StyledContextMenuItem
            onSelect={() => fileNameAction.afterClose(onRename)}
          >
            <Pencil className="size-4" />
            Rename
          </StyledContextMenuItem>
          <StyledContextMenuItem
            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            onSelect={onDelete}
          >
            <Trash2 className="size-4" />
            Delete
          </StyledContextMenuItem>
        </StyledContextMenuContent>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function SidebarDirectoryNode({
  activePath,
  continuityKey,
  depth,
  entry,
  expandedPaths,
  explorerId,
  localFolderModifier,
  onCreateFolder,
  onCreateFile,
  createPending,
  newFileDraft,
  onDelete,
  onOpenGraph,
  onOpenHistory,
  onOpenNative,
  onPreview,
  onOpenTerminal,
  onPin,
  onRename,
  onRenameCancel,
  onRenameSubmit,
  onRenameValueChange,
  onExpand,
  onToggle,
  projectId,
  queryEnabled,
  queryScope,
  editingPath,
  renamePending,
  renameValue,
  revealLabel,
  worktreeId,
}: {
  activePath: string | null;
  continuityKey: string | null;
  depth: number;
  entry: ExplorerEntry;
  expandedPaths: ReadonlySet<string>;
  explorerId: string;
  localFolderModifier: boolean;
  onCreateFolder(parentPath: string): void;
  onCreateFile(parentPath: string): void;
  createPending: boolean;
  newFileDraft: SidebarNewFileDraft | null;
  onDelete(entry: ExplorerEntry): void;
  onOpenGraph?(entry: ExplorerEntry): void;
  onOpenHistory(path: string): void;
  onOpenNative?(entry: ExplorerEntry, localFolder: boolean): void;
  onPreview(entry: ExplorerEntry): void;
  onOpenTerminal?(entry: ExplorerEntry): void;
  onPin(entry: ExplorerEntry): void;
  onRename(entry: ExplorerEntry): void;
  onRenameCancel(): void;
  onRenameSubmit(): void;
  onRenameValueChange(value: string): void;
  onExpand(parentPath: string, path: string): void;
  onToggle(path: string): void;
  projectId: string;
  queryEnabled: boolean;
  queryScope: string;
  editingPath: string | null;
  renamePending: boolean;
  renameValue: string;
  revealLabel?: string;
  worktreeId: string;
}) {
  const expanded = expandedPaths.has(entry.path);
  const { directory, entries } = useExplorerDirectory({
    enabled: expanded && queryEnabled,
    explorerId,
    gitStatus: undefined,
    path: entry.path,
    preservePreviousDataKey: continuityKey,
    projectId,
    queryScope,
    worktreeId,
  });
  const visibleEntries = visibleSidebarEntries(entries);
  const expansionHandled = useRef(false);
  useEffect(() => {
    expansionHandled.current = false;
  }, [expanded, projectId, worktreeId]);
  useEffect(() => {
    if (
      !expanded ||
      !queryEnabled ||
      !directory.data ||
      directory.isPlaceholderData ||
      directory.isError ||
      expansionHandled.current
    ) {
      return;
    }
    // Handle each expansion once so a manually collapsed child stays closed.
    // Use the same entries as the UI: hidden OS metadata is not a choice.
    expansionHandled.current = true;
    const child = visibleEntries.length === 1 ? visibleEntries[0] : undefined;
    if (child?.kind === "directory" && !child.symbolicLink) {
      onExpand(entry.path, child.path);
    }
  }, [
    directory.data,
    directory.isError,
    directory.isPlaceholderData,
    entry.path,
    expanded,
    onExpand,
    projectId,
    queryEnabled,
    visibleEntries,
    worktreeId,
  ]);
  return (
    <>
      <SidebarFileRow
        active={activePath === entry.path}
        depth={depth}
        editing={editingPath === entry.path}
        entry={entry}
        expanded={expanded}
        localFolderModifier={localFolderModifier}
        onCreateFolder={() => onCreateFolder(entry.path)}
        onCreateFile={() => onCreateFile(entry.path)}
        createPending={createPending}
        onDelete={() => onDelete(entry)}
        onOpenGraph={onOpenGraph ? () => onOpenGraph(entry) : undefined}
        onOpenNative={
          onOpenNative
            ? (localFolder) => onOpenNative(entry, localFolder)
            : undefined
        }
        onOpen={() => onToggle(entry.path)}
        onOpenTerminal={
          onOpenTerminal ? () => onOpenTerminal(entry) : undefined
        }
        onRename={() => onRename(entry)}
        onRenameCancel={onRenameCancel}
        onRenameSubmit={onRenameSubmit}
        onRenameValueChange={onRenameValueChange}
        renamePending={renamePending}
        renameValue={renameValue}
        revealLabel={revealLabel}
      />
      {expanded ? (
        <div role="group">
          {newFileDraft?.parentPath === entry.path ? (
            <SidebarNewFileRow depth={depth + 1} draft={newFileDraft} />
          ) : null}
          {directory.isLoading ? (
            <div
              className="flex h-7 items-center gap-2 text-[10px] text-muted-foreground"
              style={{
                paddingLeft: `${18 + (depth + 1) * SIDEBAR_FILE_TREE_INDENT_PX}px`,
              }}
            >
              <Loader2 className="size-3 animate-spin" />
              Loading {entry.name}
            </div>
          ) : directory.isError && !directory.data ? (
            <button
              className="h-7 w-full truncate text-left text-[10px] text-destructive hover:bg-destructive/5"
              onClick={() => void directory.refetch()}
              style={{
                paddingLeft: `${18 + (depth + 1) * SIDEBAR_FILE_TREE_INDENT_PX}px`,
              }}
              type="button"
            >
              Could not load folder
            </button>
          ) : (
            visibleEntries.map((child) =>
              child.kind === "directory" ? (
                <SidebarDirectoryNode
                  activePath={activePath}
                  continuityKey={continuityKey}
                  depth={depth + 1}
                  entry={child}
                  expandedPaths={expandedPaths}
                  explorerId={explorerId}
                  key={child.path}
                  localFolderModifier={localFolderModifier}
                  onCreateFolder={onCreateFolder}
                  onCreateFile={onCreateFile}
                  createPending={createPending}
                  newFileDraft={newFileDraft}
                  editingPath={editingPath}
                  onDelete={onDelete}
                  onOpenGraph={onOpenGraph}
                  onOpenHistory={onOpenHistory}
                  onOpenNative={onOpenNative}
                  onPreview={onPreview}
                  onOpenTerminal={onOpenTerminal}
                  onPin={onPin}
                  onRename={onRename}
                  onRenameCancel={onRenameCancel}
                  onRenameSubmit={onRenameSubmit}
                  onRenameValueChange={onRenameValueChange}
                  onExpand={onExpand}
                  onToggle={onToggle}
                  projectId={projectId}
                  queryEnabled={queryEnabled}
                  queryScope={queryScope}
                  renamePending={renamePending}
                  renameValue={renameValue}
                  revealLabel={revealLabel}
                  worktreeId={worktreeId}
                />
              ) : (
                <SidebarFileRow
                  active={activePath === child.path}
                  depth={depth + 1}
                  editing={editingPath === child.path}
                  entry={child}
                  key={child.path}
                  localFolderModifier={localFolderModifier}
                  onDelete={() => onDelete(child)}
                  onOpenNative={
                    onOpenNative
                      ? (localFolder) => onOpenNative(child, localFolder)
                      : undefined
                  }
                  onOpen={() => onPreview(child)}
                  onOpenHistory={() => onOpenHistory(child.path)}
                  onPin={() => onPin(child)}
                  onRename={() => onRename(child)}
                  onRenameCancel={onRenameCancel}
                  onRenameSubmit={onRenameSubmit}
                  onRenameValueChange={onRenameValueChange}
                  renamePending={renamePending}
                  renameValue={renameValue}
                  revealLabel={revealLabel}
                />
              ),
            )
          )}
        </div>
      ) : null}
    </>
  );
}

export function sidebarFileAncestorPaths(path: string | null): string[] {
  if (!path) return [];
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return segments
    .slice(0, -1)
    .map((_, index) => segments.slice(0, index + 1).join("/"));
}

export function ProjectSidebarFileTree({
  visible = true,
  activePath,
  error,
  explorer,
  loading,
  onCreateFolder,
  onCreateFile,
  onDelete,
  onOpenGraph,
  onOpenNative,
  onOpenNativeRoot,
  onPreview,
  onOpenTerminal,
  onPin,
  onRename,
  onRetry,
  pinningPath,
  revealLabel,
  workerId,
  workerOnline,
}: {
  visible?: boolean;
  activePath: string | null;
  error?: string | null;
  explorer: ExplorerSummary | null;
  loading: boolean;
  onCreateFolder(
    parentPath: string,
    authorization: ExplorerFileMutationAuthorization,
  ): Promise<ExplorerEntry>;
  onCreateFile(
    parentPath: string,
    name: string,
    authorization: ExplorerFileMutationAuthorization,
  ): Promise<ExplorerEntry>;
  onDelete(
    entry: ExplorerEntry,
    authorization: ExplorerFileMutationAuthorization,
  ): Promise<void>;
  onOpenGraph?(entry: ExplorerEntry): void;
  onOpenNative?(entry: ExplorerEntry, localFolder: boolean): void;
  onOpenNativeRoot?(localFolder: boolean): void;
  onPreview(entry: ExplorerEntry): void;
  onOpenTerminal?(entry: ExplorerEntry): void;
  onPin(entry: ExplorerEntry): void;
  onRename(
    entry: ExplorerEntry,
    name: string,
    authorization: ExplorerFileMutationAuthorization,
  ): Promise<void>;
  onRetry?(): void;
  pinningPath?: string | null;
  revealLabel?: string;
  workerId: string | null;
  workerOnline: boolean;
}) {
  const shiftKeyHeld = useShiftKeyHeld();
  const openFileHistory = (path: string) => {
    if (!explorer) return;
    requestGitFileHistory({
      projectId: explorer.projectId,
      worktreeId: explorer.worktreeId,
      path,
    });
  };
  const { expandedPaths, setExpandedPaths, toggle, expandChild } =
    useSidebarFolderExpansion(explorer);
  const [renameTarget, setRenameTarget] = useState<ExplorerEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renamePending, setRenamePending] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [createPending, setCreatePending] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ExplorerEntry | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const activityRef = useFileChangeActivity({
    projectId: explorer?.projectId,
    worktreeId: explorer?.worktreeId,
    workerId: explorer?.activeWorkerId,
  });
  useEffect(() => {
    const ancestors = sidebarFileAncestorPaths(activePath);
    if (ancestors.length === 0) return;
    setExpandedPaths((current) => {
      const missing = ancestors.filter((path) => !current.has(path));
      return missing.length > 0 ? new Set([...current, ...missing]) : current;
    });
  }, [activePath, setExpandedPaths]);
  const streamEncryption = useExplorerWorkerEncryption(explorer, visible);
  const mutationBindingKey = streamEncryption.ready
    ? streamEncryption.bindingKey
    : null;
  const mutationBindingKeyRef = useRef(mutationBindingKey);
  mutationBindingKeyRef.current = mutationBindingKey;
  useEffect(
    () => () => {
      mutationBindingKeyRef.current = null;
    },
    [],
  );
  const { directory, entries } = useExplorerDirectory({
    enabled: Boolean(explorer) && visible && streamEncryption.ready,
    explorerId: explorer?.id ?? "unavailable",
    gitStatus: undefined,
    path: "",
    preservePreviousDataKey: streamEncryption.continuityKey,
    projectId: explorer?.projectId ?? "unavailable",
    queryScope: streamEncryption.bindingKey ?? "unavailable",
    worktreeId: explorer?.worktreeId ?? "unavailable",
  });
  const visibleEntries = visibleSidebarEntries(entries);
  const directoryFailed = Boolean(
    explorer && directory.isError && !directory.data,
  );
  const hasRetryableFailure = Boolean(
    error || streamEncryption.error || directoryFailed,
  );
  const fileTreeReady = Boolean(
    explorer && streamEncryption.ready && directory.data,
  );
  const retryCurrentFailure = useCallback(() => {
    if (error) {
      onRetry?.();
      return;
    }
    if (streamEncryption.error) {
      streamEncryption.retry();
      return;
    }
    if (directoryFailed) {
      void directory.refetch();
      return;
    }
    onRetry?.();
  }, [
    directory.refetch,
    directoryFailed,
    error,
    onRetry,
    streamEncryption.error,
    streamEncryption.retry,
  ]);
  const workerRetryStateRef = useRef({
    online: workerOnline,
    pending: !workerOnline,
    workerId,
  });

  useEffect(() => {
    const previous = workerRetryStateRef.current;
    if (previous.workerId !== workerId) {
      workerRetryStateRef.current = {
        online: workerOnline,
        pending: !workerOnline,
        workerId,
      };
      return;
    }

    const pending = !workerOnline || previous.pending || !previous.online;
    workerRetryStateRef.current = {
      online: workerOnline,
      pending,
      workerId,
    };
    if (fileTreeReady) {
      workerRetryStateRef.current.pending = false;
      return;
    }
    if (!workerId || !workerOnline || !pending || !hasRetryableFailure) return;

    workerRetryStateRef.current.pending = false;
    retryCurrentFailure();
  }, [
    fileTreeReady,
    hasRetryableFailure,
    retryCurrentFailure,
    workerId,
    workerOnline,
  ]);

  useEffect(() => {
    setRenameTarget(null);
    setRenameError(null);
    setDeleteTarget(null);
    setDeleteError(null);
  }, [explorer?.id, mutationBindingKey]);

  const currentMutationAuthorization = () => {
    const bindingKey = mutationBindingKeyRef.current;
    if (!bindingKey) return null;
    return {
      bindingKey,
      isCurrent: () => mutationBindingKeyRef.current === bindingKey,
    } satisfies ExplorerFileMutationAuthorization;
  };

  const newFile = useSidebarNewFile({
    explorerId: explorer?.id,
    bindingKey: mutationBindingKey,
    authorize: currentMutationAuthorization,
    onCreate: onCreateFile,
  });
  const beginRename = (entry: ExplorerEntry) => {
    if (newFile.pending) return;
    newFile.cancel();
    setRenameError(null);
    setRenameTarget(entry);
    setRenameValue(entry.name);
  };
  const createFolder = (parentPath: string) => {
    if (createPending || renamePending || newFile.pending) return;
    newFile.cancel();
    const authorization = currentMutationAuthorization();
    if (!authorization) return;
    setCreatePending(true);
    setRenameError(null);
    if (parentPath) {
      setExpandedPaths((current) => new Set([...current, parentPath]));
    }
    void onCreateFolder(parentPath, authorization)
      .then((entry) => {
        if (authorization.isCurrent()) beginRename(entry);
      })
      .catch((error: unknown) => {
        if (!authorization.isCurrent()) return;
        setRenameError(
          error instanceof Error
            ? error.message
            : "The folder could not be created.",
        );
      })
      .finally(() => setCreatePending(false));
  };
  const beginCreateFile = (parentPath: string) => {
    if (createPending || renamePending || !newFile.begin(parentPath)) return;
    setRenameTarget(null);
    setRenameError(null);
    if (parentPath)
      setExpandedPaths((current) => new Set([...current, parentPath]));
  };
  const cancelRename = () => {
    if (renamePending) return;
    setRenameTarget(null);
    setRenameError(null);
  };
  const submitRename = () => {
    if (!renameTarget || renamePending) return;
    const authorization = currentMutationAuthorization();
    if (!authorization) return;
    const error = sidebarEntryRenameError(renameValue);
    if (error) {
      setRenameError(error);
      return;
    }
    const name = renameValue.trim();
    if (name === renameTarget.name) {
      cancelRename();
      return;
    }
    setRenamePending(true);
    setRenameError(null);
    const target = renameTarget;
    void onRename(target, name, authorization)
      .then(() => {
        if (!authorization.isCurrent()) return;
        if (target.kind === "directory") {
          const separator = target.path.lastIndexOf("/");
          const nextPath =
            separator < 0
              ? name
              : `${target.path.slice(0, separator + 1)}${name}`;
          setExpandedPaths(
            (current) =>
              new Set(
                [...current].map((path) =>
                  path === target.path || path.startsWith(`${target.path}/`)
                    ? `${nextPath}${path.slice(target.path.length)}`
                    : path,
                ),
              ),
          );
        }
        setRenameTarget(null);
      })
      .catch((error: unknown) => {
        if (!authorization.isCurrent()) return;
        setRenameError(
          error instanceof Error
            ? error.message
            : "The entry could not be renamed.",
        );
      })
      .finally(() => setRenamePending(false));
  };
  const confirmDelete = () => {
    if (!deleteTarget || deletePending) return;
    const authorization = currentMutationAuthorization();
    if (!authorization) return;
    setDeletePending(true);
    setDeleteError(null);
    void onDelete(deleteTarget, authorization)
      .then(() => {
        if (authorization.isCurrent()) setDeleteTarget(null);
      })
      .catch((error: unknown) => {
        if (!authorization.isCurrent()) return;
        setDeleteError(
          error instanceof Error
            ? error.message
            : "The entry could not be deleted.",
        );
      })
      .finally(() => setDeletePending(false));
  };

  return (
    <>
      <section
        ref={activityRef}
        className="flex min-h-0 flex-1 flex-col"
        aria-label="Files"
      >
        {visible && pinningPath ? (
          <Loader2
            className="m-2 size-3 animate-spin"
            aria-label="Opening file"
          />
        ) : null}
        {visible && renameError ? (
          <p
            className="px-2 pb-1 text-[10px] leading-4 text-destructive"
            role="alert"
          >
            {renameError}
          </p>
        ) : null}
        {!visible ? null : loading ||
          (explorer &&
            !streamEncryption.ready &&
            !streamEncryption.error &&
            !directory.data) ||
          (explorer && directory.isLoading) ? (
          <div className="flex h-16 items-center justify-center text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : error ||
          streamEncryption.error ||
          (explorer && directory.isError && !directory.data) ? (
          <div className="space-y-2 px-2 py-3 text-center">
            <p className="text-[10px] leading-4 text-destructive">
              {error ??
                streamEncryption.error ??
                "Project files could not be loaded."}
            </p>
            {workerId && !workerOnline ? (
              <p className="text-[10px] leading-4 text-muted-foreground">
                Waiting for the worker to reconnect…
              </p>
            ) : streamEncryption.error && !error ? (
              <Button
                className="h-7 text-[10px]"
                onClick={retryCurrentFailure}
                size="sm"
                variant="outline"
              >
                Retry
              </Button>
            ) : onRetry || directoryFailed ? (
              <Button
                className="h-7 text-[10px]"
                onClick={retryCurrentFailure}
                size="sm"
                variant="outline"
              >
                Retry
              </Button>
            ) : null}
          </div>
        ) : explorer ? (
          <>
            <SidebarFilesContextMenu
              createPending={createPending || renamePending || newFile.pending}
              localFolderModifier={shiftKeyHeld}
              onCreateFolder={() => createFolder("")}
              onCreateFile={() => beginCreateFile("")}
              onOpenNative={onOpenNativeRoot}
              revealLabel={revealLabel}
            >
              <div
                className="min-h-16 flex-1"
                role="tree"
                aria-label="Project files"
              >
                {newFile.draft?.parentPath === "" ? (
                  <SidebarNewFileRow depth={0} draft={newFile.draft} />
                ) : null}
                {visibleEntries.map((entry) =>
                  entry.kind === "directory" ? (
                    <SidebarDirectoryNode
                      activePath={activePath}
                      continuityKey={streamEncryption.continuityKey}
                      depth={0}
                      editingPath={renameTarget?.path ?? null}
                      entry={entry}
                      expandedPaths={expandedPaths}
                      explorerId={explorer.id}
                      key={entry.path}
                      localFolderModifier={shiftKeyHeld}
                      onCreateFolder={createFolder}
                      onCreateFile={beginCreateFile}
                      createPending={
                        createPending || renamePending || newFile.pending
                      }
                      newFileDraft={newFile.draft}
                      onDelete={setDeleteTarget}
                      onOpenGraph={onOpenGraph}
                      onOpenHistory={openFileHistory}
                      onOpenNative={onOpenNative}
                      onPreview={onPreview}
                      onOpenTerminal={onOpenTerminal}
                      onPin={onPin}
                      onRename={beginRename}
                      onRenameCancel={cancelRename}
                      onRenameSubmit={submitRename}
                      onRenameValueChange={setRenameValue}
                      onExpand={expandChild}
                      onToggle={toggle}
                      projectId={explorer.projectId}
                      queryEnabled={streamEncryption.ready}
                      queryScope={streamEncryption.bindingKey!}
                      renamePending={renamePending}
                      renameValue={renameValue}
                      revealLabel={revealLabel}
                      worktreeId={explorer.worktreeId}
                    />
                  ) : (
                    <SidebarFileRow
                      active={activePath === entry.path}
                      depth={0}
                      editing={renameTarget?.path === entry.path}
                      entry={entry}
                      key={entry.path}
                      localFolderModifier={shiftKeyHeld}
                      onDelete={() => setDeleteTarget(entry)}
                      onOpenNative={
                        onOpenNative
                          ? (localFolder) => onOpenNative(entry, localFolder)
                          : undefined
                      }
                      onOpen={() => onPreview(entry)}
                      onOpenHistory={() => openFileHistory(entry.path)}
                      onPin={() => onPin(entry)}
                      onRename={() => beginRename(entry)}
                      onRenameCancel={cancelRename}
                      onRenameSubmit={submitRename}
                      onRenameValueChange={setRenameValue}
                      renamePending={renamePending}
                      renameValue={renameValue}
                      revealLabel={revealLabel}
                    />
                  ),
                )}
                {visibleEntries.length === 0 &&
                newFile.draft?.parentPath !== "" ? (
                  <p className="px-3 py-4 text-center text-[10px] text-muted-foreground">
                    This folder is empty.
                  </p>
                ) : null}
              </div>
            </SidebarFilesContextMenu>
          </>
        ) : (
          <p className="px-3 py-4 text-center text-[10px] leading-4 text-muted-foreground">
            Preparing the project files…
          </p>
        )}
      </section>
      <ConfirmDialog
        confirmLabel={
          deleteTarget?.kind === "directory" ? "Delete folder" : "Delete file"
        }
        confirmPendingLabel="Deleting…"
        description={
          deleteTarget?.kind === "directory"
            ? `Delete ${deleteTarget.name} and everything inside it? This cannot be undone.`
            : `Delete ${deleteTarget?.name ?? "this file"}? This cannot be undone.`
        }
        error={deleteError}
        onConfirm={confirmDelete}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
        open={deleteTarget !== null}
        pending={deletePending}
        title={
          deleteTarget?.kind === "directory" ? "Delete folder?" : "Delete file?"
        }
      />
    </>
  );
}
