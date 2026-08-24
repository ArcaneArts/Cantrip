import type { ExplorerLastCommit, GitStatus } from "@cantrip/protocol";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { sortExplorerEntries } from "@/components/explorer/explorer-entry-metadata";
import { getExplorerDirectory, getExplorerDirectoryCommits } from "@/lib/api";

// Live worktree notifications invalidate these queries immediately. Keep a
// bounded fallback for filesystems where recursive watching is unavailable.
const EXPLORER_DIRECTORY_STALE_TIME_MS = 30_000;

export function useExplorerDirectory({
  enabled,
  explorerId,
  gitStatus,
  path,
  projectId,
  queryScope,
  worktreeId,
}: {
  enabled: boolean;
  explorerId: string;
  gitStatus: GitStatus | undefined;
  path: string;
  projectId: string;
  queryScope: string;
  worktreeId: string;
}) {
  const directory = useQuery({
    enabled,
    queryFn: () => getExplorerDirectory(explorerId, path),
    queryKey: [
      "explorer-directory",
      projectId,
      worktreeId,
      explorerId,
      path,
      queryScope,
    ],
    staleTime: EXPLORER_DIRECTORY_STALE_TIME_MS,
  });
  const commits = useQuery({
    enabled: enabled && directory.isSuccess && gitStatus !== undefined,
    queryFn: () => getExplorerDirectoryCommits(explorerId, path),
    queryKey: [
      "explorer-directory-commits",
      projectId,
      worktreeId,
      explorerId,
      path,
      gitStatus?.head,
      queryScope,
    ],
    retry: false,
    staleTime: EXPLORER_DIRECTORY_STALE_TIME_MS,
  });
  const entries = useMemo(
    () => sortExplorerEntries(directory.data?.entries ?? []),
    [directory.data?.entries],
  );
  const commitByPath = useMemo<ReadonlyMap<string, ExplorerLastCommit | null>>(
    () =>
      new Map(
        (commits.data?.entries ?? []).map((entry) => [
          entry.path,
          entry.lastCommit,
        ]),
      ),
    [commits.data?.entries],
  );
  return { commitByPath, commits, directory, entries };
}
