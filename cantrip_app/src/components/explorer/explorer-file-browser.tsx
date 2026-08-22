import type {
  ExplorerEntry,
  ExplorerSummary,
  GitStatus,
} from "@cantrip/protocol";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Loader2, Network } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ExplorerDirectoryNode } from "@/components/explorer/explorer-directory-node";
import { ExplorerEntryRow } from "@/components/explorer/explorer-entry-row";
import { buildExplorerChangeIndex } from "@/components/explorer/explorer-entry-metadata";
import {
  explorerExpandedPathsForReveal,
  explorerGraphRootForEntry,
} from "@/components/explorer/explorer-graph-routing";
import { useExplorerDirectory } from "@/components/explorer/use-explorer-directory";
import {
  StyledContextMenuContent,
  StyledContextMenuItem,
} from "@/components/ui/styled-menu";

export function ExplorerFileBrowser({
  explorer,
  gitStatus,
  onOpenFile,
  onRevealFolder,
  revealLabel,
  onShowInGraph,
  onOpenTerminal,
  replayKey,
  revealedPath,
}: {
  explorer: ExplorerSummary;
  gitStatus: GitStatus | undefined;
  onOpenFile(entry: ExplorerEntry): void;
  onRevealFolder?(entry: ExplorerEntry, localFolder: boolean): void;
  revealLabel?: string;
  onShowInGraph?(rootPath: string | null): void;
  onOpenTerminal(entry: ExplorerEntry): void;
  replayKey: number;
  revealedPath?: string | null;
}) {
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const changeByPath = useMemo(
    () => buildExplorerChangeIndex(gitStatus),
    [gitStatus],
  );
  const { commitByPath, directory, entries } = useExplorerDirectory({
    enabled: true,
    explorerId: explorer.id,
    gitStatus,
    path: "",
  });

  useEffect(() => {
    setExpandedPaths(new Set());
  }, [explorer.id, explorer.worktreeId]);

  useEffect(() => {
    if (!revealedPath) return;
    setExpandedPaths((current) => {
      const next = new Set(current);
      for (const path of explorerExpandedPathsForReveal(revealedPath)) {
        next.add(path);
      }
      return next;
    });
  }, [revealedPath]);

  const toggle = (path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const header = (
    <div
      className="sticky top-0 z-10 flex h-7 items-center border-b bg-background px-3 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70"
      title={onShowInGraph ? "Right-click for repository actions" : undefined}
    >
      <span className="min-w-0 flex-1">Name</span>
      <span className="hidden w-[40%] min-w-0 md:block">Last change</span>
      <span className="w-16 shrink-0 text-right">Size</span>
    </div>
  );

  return (
    <div className="min-h-0 flex-1 overflow-auto p-2 sm:p-3">
      {onShowInGraph ? (
        <ContextMenu.Root>
          <ContextMenu.Trigger asChild>{header}</ContextMenu.Trigger>
          <ContextMenu.Portal>
            <StyledContextMenuContent className="min-w-48">
              <StyledContextMenuItem onSelect={() => onShowInGraph(null)}>
                <Network className="size-4" />
                Show repository in Graph
              </StyledContextMenuItem>
            </StyledContextMenuContent>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      ) : (
        header
      )}
      {directory.isLoading ? (
        <div className="grid h-32 place-items-center text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      ) : directory.isError && !directory.data ? (
        <button
          type="button"
          className="flex min-h-20 w-full items-center justify-center p-3 text-xs leading-5 text-destructive hover:bg-destructive/5"
          onClick={() => void directory.refetch()}
        >
          Folder could not be loaded. Click to retry.
        </button>
      ) : (
        <div key={replayKey} role="tree" aria-label="Project files">
          {entries.map((entry) =>
            entry.kind === "directory" ? (
              <ExplorerDirectoryNode
                changeByPath={changeByPath}
                commit={commitByPath.get(entry.path) ?? null}
                depth={0}
                entry={entry}
                expandedPaths={expandedPaths}
                explorerId={explorer.id}
                gitStatus={gitStatus}
                key={entry.path}
                onOpenFile={onOpenFile}
                onReveal={onRevealFolder}
                revealLabel={revealLabel}
                onShowInGraph={onShowInGraph}
                onOpenTerminal={onOpenTerminal}
                onToggle={toggle}
                revealedPath={revealedPath}
              />
            ) : (
              <ExplorerEntryRow
                change={changeByPath.get(entry.path) ?? null}
                commit={commitByPath.get(entry.path) ?? null}
                depth={0}
                entry={entry}
                key={entry.path}
                onOpen={() => onOpenFile(entry)}
                onShowInGraph={
                  onShowInGraph
                    ? () => onShowInGraph(explorerGraphRootForEntry(entry))
                    : undefined
                }
                revealed={entry.path === revealedPath}
              />
            ),
          )}
          {entries.length === 0 ? (
            <div className="grid h-32 place-items-center text-sm text-muted-foreground">
              This folder is empty.
            </div>
          ) : null}
          {directory.data?.truncated ? (
            <p className="px-3 py-2 text-[10px] text-muted-foreground">
              Showing the first 1,000 entries in the project root.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
