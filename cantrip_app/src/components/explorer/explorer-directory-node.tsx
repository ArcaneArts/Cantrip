import type {
  ExplorerEntry,
  ExplorerLastCommit,
  GitStatus,
} from "@cantrip/protocol";
import { Loader2 } from "lucide-react";

import { ExplorerEntryRow } from "@/components/explorer/explorer-entry-row";
import type { ExplorerChangeSummary } from "@/components/explorer/explorer-entry-metadata";
import { explorerGraphRootForEntry } from "@/components/explorer/explorer-graph-routing";
import { useExplorerDirectory } from "@/components/explorer/use-explorer-directory";

export function ExplorerDirectoryNode({
  changeByPath,
  commit,
  depth,
  entry,
  expandedPaths,
  explorerId,
  gitStatus,
  onOpenFile,
  onShowInGraph,
  onOpenTerminal,
  onToggle,
  revealedPath,
}: {
  changeByPath: ReadonlyMap<string, ExplorerChangeSummary>;
  commit: ExplorerLastCommit | null;
  depth: number;
  entry: ExplorerEntry;
  expandedPaths: ReadonlySet<string>;
  explorerId: string;
  gitStatus: GitStatus | undefined;
  onOpenFile(entry: ExplorerEntry): void;
  onShowInGraph(rootPath: string | null): void;
  onOpenTerminal(entry: ExplorerEntry): void;
  onToggle(path: string): void;
  revealedPath?: string | null;
}) {
  const expanded = expandedPaths.has(entry.path);
  const { commitByPath, directory, entries } = useExplorerDirectory({
    enabled: expanded,
    explorerId,
    gitStatus,
    path: entry.path,
  });
  return (
    <>
      <ExplorerEntryRow
        change={changeByPath.get(entry.path) ?? null}
        commit={commit}
        depth={depth}
        entry={entry}
        expanded={expanded}
        onOpen={() => onToggle(entry.path)}
        onShowInGraph={() => onShowInGraph(explorerGraphRootForEntry(entry))}
        onOpenTerminal={() => onOpenTerminal(entry)}
        revealed={entry.path === revealedPath}
      />
      {expanded ? (
        <div role="group">
          {directory.isLoading ? (
            <div
              className="flex h-9 items-center gap-2 text-xs text-muted-foreground"
              style={{ paddingLeft: `${12 + (depth + 1) * 16}px` }}
            >
              <Loader2 className="size-3.5 animate-spin" />
              Loading {entry.name}
            </div>
          ) : directory.isError && !directory.data ? (
            <button
              type="button"
              className="flex min-h-9 w-full items-center text-left text-xs text-destructive hover:bg-destructive/5"
              onClick={() => void directory.refetch()}
              style={{ paddingLeft: `${12 + (depth + 1) * 16}px` }}
              title={
                directory.error instanceof Error
                  ? directory.error.message
                  : "Folder could not be loaded."
              }
            >
              Folder could not be loaded. Click to retry.
            </button>
          ) : (
            <>
              {entries.map((child) =>
                child.kind === "directory" ? (
                  <ExplorerDirectoryNode
                    changeByPath={changeByPath}
                    commit={commitByPath.get(child.path) ?? null}
                    depth={depth + 1}
                    entry={child}
                    expandedPaths={expandedPaths}
                    explorerId={explorerId}
                    gitStatus={gitStatus}
                    key={child.path}
                    onOpenFile={onOpenFile}
                    onShowInGraph={onShowInGraph}
                    onOpenTerminal={onOpenTerminal}
                    onToggle={onToggle}
                    revealedPath={revealedPath}
                  />
                ) : (
                  <ExplorerEntryRow
                    change={changeByPath.get(child.path) ?? null}
                    commit={commitByPath.get(child.path) ?? null}
                    depth={depth + 1}
                    entry={child}
                    key={child.path}
                    onOpen={() => onOpenFile(child)}
                    onShowInGraph={() =>
                      onShowInGraph(explorerGraphRootForEntry(child))
                    }
                    revealed={child.path === revealedPath}
                  />
                ),
              )}
              {entries.length === 0 ? (
                <p
                  className="flex h-8 items-center text-[10px] text-muted-foreground/60"
                  style={{ paddingLeft: `${44 + (depth + 1) * 16}px` }}
                >
                  Empty folder
                </p>
              ) : null}
              {directory.data?.truncated ? (
                <p
                  className="py-1.5 pr-3 text-[10px] text-muted-foreground"
                  style={{ paddingLeft: `${44 + (depth + 1) * 16}px` }}
                >
                  Showing the first 1,000 entries in {entry.name}.
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </>
  );
}
