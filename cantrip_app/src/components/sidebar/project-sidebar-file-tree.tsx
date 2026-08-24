import {
  explorerEntryNameSchema,
  type ExplorerEntry,
  type ExplorerSummary,
} from "@cantrip/protocol";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Link2,
  Loader2,
  Network,
  Pencil,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useExplorerDirectory } from "@/components/explorer/use-explorer-directory";
import { useExplorerWorkerEncryption } from "@/components/explorer/use-explorer-worker-encryption";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  StyledContextMenuContent,
  StyledContextMenuItem,
} from "@/components/ui/styled-menu";
import { cn } from "@/lib/utils";

const SIDEBAR_FILE_TREE_INDENT_PX = 6;

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

function entryIcon(entry: ExplorerEntry, expanded: boolean) {
  if (entry.kind === "directory") return expanded ? FolderOpen : Folder;
  if (entry.markdown) return FileText;
  if (entry.viewable) return FileCode2;
  return File;
}

function SidebarFileRow({
  active,
  depth,
  entry,
  editing,
  expanded = false,
  onDelete,
  onOpenGraph,
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
  onDelete(): void;
  onOpenGraph?(): void;
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
  const Icon = entryIcon(entry, expanded);
  const openable = entry.kind === "directory" || entry.viewable;
  const renameInputRef = useRef<HTMLInputElement>(null);
  const cancelRenameOnBlurRef = useRef(false);
  const revealLocalFolder = useRef(false);
  useEffect(() => {
    if (!editing) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [editing]);
  const row = (
    <div
      aria-disabled={!openable}
      aria-expanded={entry.kind === "directory" ? expanded : undefined}
      aria-level={depth + 1}
      data-elite-global
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
        <Icon className="size-3.5 shrink-0" />
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
          <span className="truncate">{entry.name}</span>
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
        <StyledContextMenuContent className="min-w-48">
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
              <FolderOpen className="size-4" />
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
          {onOpenNative ||
          (entry.kind === "directory" && (onOpenTerminal || onOpenGraph)) ? (
            <ContextMenu.Separator className="my-1 h-px bg-border" />
          ) : null}
          <StyledContextMenuItem onSelect={onRename}>
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
  depth,
  entry,
  expandedPaths,
  explorerId,
  onDelete,
  onOpenGraph,
  onOpenNative,
  onPreview,
  onOpenTerminal,
  onPin,
  onRename,
  onRenameCancel,
  onRenameSubmit,
  onRenameValueChange,
  onToggle,
  projectId,
  queryScope,
  editingPath,
  renamePending,
  renameValue,
  revealLabel,
  worktreeId,
}: {
  activePath: string | null;
  depth: number;
  entry: ExplorerEntry;
  expandedPaths: ReadonlySet<string>;
  explorerId: string;
  onDelete(entry: ExplorerEntry): void;
  onOpenGraph?(entry: ExplorerEntry): void;
  onOpenNative?(entry: ExplorerEntry, localFolder: boolean): void;
  onPreview(entry: ExplorerEntry): void;
  onOpenTerminal?(entry: ExplorerEntry): void;
  onPin(entry: ExplorerEntry): void;
  onRename(entry: ExplorerEntry): void;
  onRenameCancel(): void;
  onRenameSubmit(): void;
  onRenameValueChange(value: string): void;
  onToggle(path: string): void;
  projectId: string;
  queryScope: string;
  editingPath: string | null;
  renamePending: boolean;
  renameValue: string;
  revealLabel?: string;
  worktreeId: string;
}) {
  const expanded = expandedPaths.has(entry.path);
  const { directory, entries } = useExplorerDirectory({
    enabled: expanded,
    explorerId,
    gitStatus: undefined,
    path: entry.path,
    projectId,
    queryScope,
    worktreeId,
  });
  return (
    <>
      <SidebarFileRow
        active={activePath === entry.path}
        depth={depth}
        editing={editingPath === entry.path}
        entry={entry}
        expanded={expanded}
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
            entries.map((child) =>
              child.kind === "directory" ? (
                <SidebarDirectoryNode
                  activePath={activePath}
                  depth={depth + 1}
                  entry={child}
                  expandedPaths={expandedPaths}
                  explorerId={explorerId}
                  key={child.path}
                  editingPath={editingPath}
                  onDelete={onDelete}
                  onOpenGraph={onOpenGraph}
                  onOpenNative={onOpenNative}
                  onPreview={onPreview}
                  onOpenTerminal={onOpenTerminal}
                  onPin={onPin}
                  onRename={onRename}
                  onRenameCancel={onRenameCancel}
                  onRenameSubmit={onRenameSubmit}
                  onRenameValueChange={onRenameValueChange}
                  onToggle={onToggle}
                  projectId={projectId}
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
                  onDelete={() => onDelete(child)}
                  onOpenNative={
                    onOpenNative
                      ? (localFolder) => onOpenNative(child, localFolder)
                      : undefined
                  }
                  onOpen={() => onPreview(child)}
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

export function ProjectSidebarFileTree({
  activePath,
  error,
  explorer,
  loading,
  onDelete,
  onOpenGraph,
  onOpenNative,
  onPreview,
  onOpenTerminal,
  onPin,
  onRename,
  onRetry,
  pinningPath,
  revealLabel,
}: {
  activePath: string | null;
  error?: string | null;
  explorer: ExplorerSummary | null;
  loading: boolean;
  onDelete(
    entry: ExplorerEntry,
    authorization: ExplorerFileMutationAuthorization,
  ): Promise<void>;
  onOpenGraph?(entry: ExplorerEntry): void;
  onOpenNative?(entry: ExplorerEntry, localFolder: boolean): void;
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
}) {
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [renameTarget, setRenameTarget] = useState<ExplorerEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renamePending, setRenamePending] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ExplorerEntry | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const streamEncryption = useExplorerWorkerEncryption(
    explorer,
    !filesCollapsed,
  );
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
    enabled: Boolean(explorer) && !filesCollapsed && streamEncryption.ready,
    explorerId: explorer?.id ?? "unavailable",
    gitStatus: undefined,
    path: "",
    projectId: explorer?.projectId ?? "unavailable",
    queryScope: streamEncryption.bindingKey ?? "unavailable",
    worktreeId: explorer?.worktreeId ?? "unavailable",
  });

  useEffect(() => {
    setExpandedPaths(new Set());
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

  const toggle = (path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const beginRename = (entry: ExplorerEntry) => {
    setRenameError(null);
    setRenameTarget(entry);
    setRenameValue(entry.name);
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
        className="mt-2 border-t border-border/70 pt-2"
        aria-label="Files"
      >
        <button
          aria-expanded={!filesCollapsed}
          className="mb-1 flex h-6 w-full items-center gap-2 rounded px-2 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70 hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
          onClick={() => setFilesCollapsed((collapsed) => !collapsed)}
          type="button"
        >
          <span className="min-w-0 flex-1 truncate">Files</span>
          {!filesCollapsed && pinningPath ? (
            <Loader2 className="size-3 animate-spin" />
          ) : null}
        </button>
        {!filesCollapsed && renameError ? (
          <p
            className="px-2 pb-1 text-[10px] leading-4 text-destructive"
            role="alert"
          >
            {renameError}
          </p>
        ) : null}
        {filesCollapsed ? null : loading ||
          (explorer && !streamEncryption.ready && !streamEncryption.error) ||
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
            {streamEncryption.error && !error ? (
              <Button
                className="h-7 text-[10px]"
                onClick={streamEncryption.retry}
                size="sm"
                variant="outline"
              >
                Retry
              </Button>
            ) : onRetry ? (
              <Button
                className="h-7 text-[10px]"
                onClick={onRetry}
                size="sm"
                variant="outline"
              >
                Retry
              </Button>
            ) : null}
          </div>
        ) : explorer ? (
          <div role="tree" aria-label="Project files">
            {entries.map((entry) =>
              entry.kind === "directory" ? (
                <SidebarDirectoryNode
                  activePath={activePath}
                  depth={0}
                  editingPath={renameTarget?.path ?? null}
                  entry={entry}
                  expandedPaths={expandedPaths}
                  explorerId={explorer.id}
                  key={entry.path}
                  onDelete={setDeleteTarget}
                  onOpenGraph={onOpenGraph}
                  onOpenNative={onOpenNative}
                  onPreview={onPreview}
                  onOpenTerminal={onOpenTerminal}
                  onPin={onPin}
                  onRename={beginRename}
                  onRenameCancel={cancelRename}
                  onRenameSubmit={submitRename}
                  onRenameValueChange={setRenameValue}
                  onToggle={toggle}
                  projectId={explorer.projectId}
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
                  onDelete={() => setDeleteTarget(entry)}
                  onOpenNative={
                    onOpenNative
                      ? (localFolder) => onOpenNative(entry, localFolder)
                      : undefined
                  }
                  onOpen={() => onPreview(entry)}
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
            {entries.length === 0 ? (
              <p className="px-3 py-4 text-center text-[10px] text-muted-foreground">
                This folder is empty.
              </p>
            ) : null}
          </div>
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
