import type { ExplorerEntry, ExplorerLastCommit } from "@cantrip/protocol";
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
  Network,
  SquareTerminal,
} from "lucide-react";
import { useEffect, useRef } from "react";

import {
  explorerCommitMetadata,
  formatExplorerSize,
  type ExplorerChangeSummary,
} from "@/components/explorer/explorer-entry-metadata";
import {
  StyledContextMenuContent,
  StyledContextMenuItem,
} from "@/components/ui/styled-menu";
import { NativeFolderRevealIcon } from "@/components/ui/native-folder-reveal-icon";
import { cn } from "@/lib/utils";

function entryIcon(entry: ExplorerEntry, expanded: boolean) {
  if (entry.kind === "directory") return expanded ? FolderOpen : Folder;
  if (entry.markdown) return FileText;
  if (entry.viewable) return FileCode2;
  return File;
}

function changeTone(change: ExplorerChangeSummary): string {
  if (change.kind === "added") {
    return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300";
  }
  if (change.kind === "conflict" || change.kind === "deleted") {
    return "bg-destructive/15 text-destructive";
  }
  if (change.kind === "untracked") {
    return "bg-amber-500/15 text-amber-600 dark:text-amber-300";
  }
  return "bg-blue-500/15 text-blue-600 dark:text-blue-300";
}

export function ExplorerEntryRow({
  change,
  commit,
  depth,
  entry,
  expanded = false,
  localFolderModifier,
  onOpen,
  onReveal,
  revealLabel,
  onShowInGraph,
  onOpenTerminal,
  revealed = false,
}: {
  change: ExplorerChangeSummary | null;
  commit: ExplorerLastCommit | null;
  depth: number;
  entry: ExplorerEntry;
  expanded?: boolean;
  localFolderModifier: boolean;
  onOpen(): void;
  onReveal?(localFolder: boolean): void;
  revealLabel?: string;
  onShowInGraph?(): void;
  onOpenTerminal?(): void;
  revealed?: boolean;
}) {
  const rowRef = useRef<HTMLButtonElement>(null);
  const revealLocalFolder = useRef(false);
  const Icon = entryIcon(entry, expanded);
  const metadata = commit ? explorerCommitMetadata(commit) : null;
  const openable = entry.kind === "directory" || entry.viewable;
  const title = [
    entry.path,
    entry.symbolicLink ? "Symbolic link" : null,
    openable ? null : "Preview unavailable",
    change?.label,
    metadata?.tooltip,
  ]
    .filter(Boolean)
    .join("\n");
  useEffect(() => {
    if (!revealed) return;
    rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [revealed]);
  const row = (
    <button
      data-elite-global
      ref={rowRef}
      type="button"
      aria-disabled={!openable}
      aria-expanded={entry.kind === "directory" ? expanded : undefined}
      aria-level={depth + 1}
      className={cn(
        "group flex min-h-10 w-full items-center gap-2 px-3 py-1 text-left text-sm text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 md:min-h-9 md:py-0",
        !openable &&
          "cursor-default opacity-45 hover:bg-transparent hover:text-muted-foreground",
        revealed &&
          "bg-primary/10 text-foreground ring-1 ring-inset ring-primary/40",
      )}
      data-high-contrast-row
      onClick={() => {
        if (openable) onOpen();
      }}
      title={title}
      role="treeitem"
    >
      <span
        className="flex min-w-0 flex-1 items-center gap-1.5"
        style={{ paddingLeft: `${depth * 16}px` }}
      >
        {entry.kind === "directory" ? (
          expanded ? (
            <ChevronDown className="size-3.5 shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0" />
          )
        ) : (
          <span className="size-3.5 shrink-0" aria-hidden="true" />
        )}
        <Icon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            {entry.symbolicLink ? (
              <span className="shrink-0" title="Symbolic link">
                <Link2 className="size-3 text-muted-foreground/70" />
                <span className="sr-only">Symbolic link</span>
              </span>
            ) : null}
            {change ? (
              <span
                className={cn(
                  "inline-flex min-w-4 shrink-0 items-center justify-center rounded px-1 font-mono text-[9px] font-semibold",
                  changeTone(change),
                )}
                title={change.label}
              >
                {change.code}
              </span>
            ) : null}
          </span>
          {metadata ? (
            <span className="block truncate text-[9px] leading-3 text-muted-foreground/60 md:hidden">
              {metadata.compactLabel}
            </span>
          ) : null}
        </span>
      </span>
      <span className="hidden w-[40%] min-w-0 items-center gap-2 text-[10px] text-muted-foreground/70 md:flex">
        {metadata ? (
          <>
            <span className="min-w-0 flex-1 truncate">{metadata.subject}</span>
            <span className="shrink-0">{metadata.age}</span>
          </>
        ) : (
          <span aria-hidden="true">—</span>
        )}
      </span>
      <span className="w-16 shrink-0 text-right text-[10px] text-muted-foreground/60">
        {entry.size !== null ? formatExplorerSize(entry.size) : "—"}
      </span>
    </button>
  );
  if (
    !onShowInGraph &&
    !onReveal &&
    (entry.kind !== "directory" || !onOpenTerminal)
  )
    return row;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <StyledContextMenuContent className="min-w-44">
          {onShowInGraph ? (
            <StyledContextMenuItem onSelect={onShowInGraph}>
              <Network className="size-4" />
              {entry.kind === "directory"
                ? "Show in Graph"
                : "Show containing folder in Graph"}
            </StyledContextMenuItem>
          ) : null}
          {entry.kind === "directory" && onOpenTerminal ? (
            <StyledContextMenuItem onSelect={onOpenTerminal}>
              <SquareTerminal className="size-4" />
              Open in Terminal
            </StyledContextMenuItem>
          ) : null}
          {onReveal && revealLabel ? (
            <StyledContextMenuItem
              onClick={(event) => {
                revealLocalFolder.current = event.shiftKey;
              }}
              onSelect={() => {
                const localFolder = revealLocalFolder.current;
                revealLocalFolder.current = false;
                onReveal(localFolder);
              }}
            >
              <NativeFolderRevealIcon
                className="size-4"
                localFolder={localFolderModifier}
              />
              {revealLabel}
            </StyledContextMenuItem>
          ) : null}
        </StyledContextMenuContent>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
