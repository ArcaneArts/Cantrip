import type { ExplorerEntry, ExplorerSummary } from "@cantrip/protocol";
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
  RefreshCw,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useExplorerDirectory } from "@/components/explorer/use-explorer-directory";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
  expanded = false,
  onOpen,
  onPin,
}: {
  active: boolean;
  depth: number;
  entry: ExplorerEntry;
  expanded?: boolean;
  onOpen(): void;
  onPin?(): void;
}) {
  const Icon = entryIcon(entry, expanded);
  const openable = entry.kind === "directory" || entry.viewable;
  return (
    <button
      aria-disabled={!openable}
      aria-expanded={entry.kind === "directory" ? expanded : undefined}
      aria-level={depth + 1}
      className={cn(
        "flex h-7 w-full min-w-0 items-center gap-1 rounded px-1 text-left text-xs text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
        active && "bg-muted text-foreground",
        !openable &&
          "cursor-default opacity-45 hover:bg-transparent hover:text-muted-foreground",
      )}
      onClick={() => {
        if (openable) onOpen();
      }}
      onDoubleClick={(event) => {
        if (!onPin || !openable) return;
        event.preventDefault();
        onPin();
      }}
      role="treeitem"
      title={
        entry.kind === "file" && entry.viewable
          ? `${entry.path}\nDouble-click to keep open`
          : entry.path
      }
      type="button"
    >
      <span
        className="flex min-w-0 flex-1 items-center gap-1.5"
        style={{ paddingLeft: `${depth * 12}px` }}
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
        <span className="truncate">{entry.name}</span>
        {entry.symbolicLink ? (
          <Link2
            className="ml-auto size-3 shrink-0"
            aria-label="Symbolic link"
          />
        ) : null}
      </span>
    </button>
  );
}

function SidebarDirectoryNode({
  activePath,
  depth,
  entry,
  expandedPaths,
  explorerId,
  onPreview,
  onPin,
  onToggle,
}: {
  activePath: string | null;
  depth: number;
  entry: ExplorerEntry;
  expandedPaths: ReadonlySet<string>;
  explorerId: string;
  onPreview(entry: ExplorerEntry): void;
  onPin(entry: ExplorerEntry): void;
  onToggle(path: string): void;
}) {
  const expanded = expandedPaths.has(entry.path);
  const { directory, entries } = useExplorerDirectory({
    enabled: expanded,
    explorerId,
    gitStatus: undefined,
    path: entry.path,
  });
  return (
    <>
      <SidebarFileRow
        active={activePath === entry.path}
        depth={depth}
        entry={entry}
        expanded={expanded}
        onOpen={() => onToggle(entry.path)}
      />
      {expanded ? (
        <div role="group">
          {directory.isLoading ? (
            <div
              className="flex h-7 items-center gap-2 text-[10px] text-muted-foreground"
              style={{ paddingLeft: `${18 + (depth + 1) * 12}px` }}
            >
              <Loader2 className="size-3 animate-spin" />
              Loading {entry.name}
            </div>
          ) : directory.isError && !directory.data ? (
            <button
              className="h-7 w-full truncate text-left text-[10px] text-destructive hover:bg-destructive/5"
              onClick={() => void directory.refetch()}
              style={{ paddingLeft: `${18 + (depth + 1) * 12}px` }}
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
                  onPreview={onPreview}
                  onPin={onPin}
                  onToggle={onToggle}
                />
              ) : (
                <SidebarFileRow
                  active={activePath === child.path}
                  depth={depth + 1}
                  entry={child}
                  key={child.path}
                  onOpen={() => onPreview(child)}
                  onPin={() => onPin(child)}
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
  onPreview,
  onPin,
  onRetry,
  pinningPath,
}: {
  activePath: string | null;
  error?: string | null;
  explorer: ExplorerSummary | null;
  loading: boolean;
  onPreview(entry: ExplorerEntry): void;
  onPin(entry: ExplorerEntry): void;
  onRetry?(): void;
  pinningPath?: string | null;
}) {
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const { directory, entries } = useExplorerDirectory({
    enabled: Boolean(explorer),
    explorerId: explorer?.id ?? "unavailable",
    gitStatus: undefined,
    path: "",
  });

  useEffect(() => setExpandedPaths(new Set()), [explorer?.id]);

  const toggle = (path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <section className="mt-2 border-t border-border/70 pt-2" aria-label="Files">
      <div className="mb-1 flex h-6 items-center gap-2 px-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
        <span className="min-w-0 flex-1 truncate">Files</span>
        {pinningPath ? <Loader2 className="size-3 animate-spin" /> : null}
        {explorer ? (
          <button
            aria-label="Refresh files"
            className="grid size-5 place-items-center rounded hover:bg-muted hover:text-foreground"
            onClick={() => void directory.refetch()}
            title="Refresh files"
            type="button"
          >
            <RefreshCw
              className={cn("size-3", directory.isFetching && "animate-spin")}
            />
          </button>
        ) : null}
      </div>
      {loading || (explorer && directory.isLoading) ? (
        <div className="flex h-16 items-center justify-center text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      ) : error || (explorer && directory.isError && !directory.data) ? (
        <div className="space-y-2 px-2 py-3 text-center">
          <p className="text-[10px] leading-4 text-destructive">
            {error ?? "Project files could not be loaded."}
          </p>
          {onRetry ? (
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
                entry={entry}
                expandedPaths={expandedPaths}
                explorerId={explorer.id}
                key={entry.path}
                onPreview={onPreview}
                onPin={onPin}
                onToggle={toggle}
              />
            ) : (
              <SidebarFileRow
                active={activePath === entry.path}
                depth={0}
                entry={entry}
                key={entry.path}
                onOpen={() => onPreview(entry)}
                onPin={() => onPin(entry)}
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
  );
}
