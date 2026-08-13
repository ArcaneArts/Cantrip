import type { ExplorerLastCommit, GitStatus } from "@cantrip/protocol";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { sortExplorerEntries } from "@/components/explorer/explorer-entry-metadata";
import { getExplorerDirectory, getExplorerDirectoryCommits } from "@/lib/api";

export function useExplorerDirectory({
  enabled,
  explorerId,
  gitStatus,
  path,
}: {
  enabled: boolean;
  explorerId: string;
  gitStatus: GitStatus | undefined;
  path: string;
}) {
  const directory = useQuery({
    enabled,
    queryFn: () => getExplorerDirectory(explorerId, path),
    queryKey: ["explorer-directory", explorerId, path],
  });
  const commits = useQuery({
    enabled: enabled && directory.isSuccess && gitStatus !== undefined,
    queryFn: () => getExplorerDirectoryCommits(explorerId, path),
    queryKey: ["explorer-directory-commits", explorerId, path, gitStatus?.head],
    retry: false,
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
