import type { ProjectSummary } from "@cantrip/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getGitHistory } from "@/lib/api";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function GitHistoryView({
  onClose,
  project,
}: {
  onClose(): void;
  project: ProjectSummary;
}) {
  const history = useQuery({
    queryFn: () => getGitHistory(project.id),
    queryKey: ["git-history", project.id],
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-4 border-b px-5 py-4 sm:px-8">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-semibold tracking-tight">Git history</h1>
            {history.data ? (
              <Badge
                variant="secondary"
                className="gap-1 font-mono font-normal"
              >
                <GitBranch className="size-3" />
                {history.data.branch || "detached HEAD"}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {project.github?.nameWithOwner ?? project.name}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            disabled={history.isFetching}
            onClick={() => history.refetch()}
          >
            <RefreshCw
              className={history.isFetching ? "size-4 animate-spin" : "size-4"}
            />
            <span className="sr-only">Refresh Git history</span>
          </Button>
          <Button size="icon" variant="ghost" onClick={onClose}>
            <X className="size-4" />
            <span className="sr-only">Close Git history</span>
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-5 sm:p-8">
        {history.isLoading ? (
          <div className="grid min-h-64 place-items-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : history.isError ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
            {history.error instanceof Error
              ? history.error.message
              : "Git history could not be loaded."}
          </div>
        ) : history.data?.commits.length === 0 ? (
          <div className="grid min-h-64 place-items-center text-center">
            <div>
              <GitCommitHorizontal className="mx-auto size-6 text-muted-foreground" />
              <p className="mt-3 font-medium">No commits yet</p>
            </div>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="sticky top-0 bg-muted/90 text-xs text-muted-foreground backdrop-blur">
                <tr>
                  <th className="px-4 py-3 font-medium">Commit</th>
                  <th className="px-4 py-3 font-medium">Message</th>
                  <th className="hidden px-4 py-3 font-medium md:table-cell">
                    Author
                  </th>
                  <th className="hidden px-4 py-3 font-medium sm:table-cell">
                    Date
                  </th>
                </tr>
              </thead>
              <tbody>
                {(history.data?.commits ?? []).map((commit) => (
                  <tr
                    key={commit.hash}
                    className="border-t align-top hover:bg-muted/40"
                  >
                    <td className="px-4 py-3">
                      <code className="font-mono text-xs text-muted-foreground">
                        {commit.shortHash}
                      </code>
                    </td>
                    <td className="min-w-48 px-4 py-3">
                      <p className="font-medium leading-5">{commit.subject}</p>
                      {commit.refs.length > 0 ? (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {commit.refs.map((ref) => (
                            <Badge
                              key={ref}
                              variant="outline"
                              className="h-5 font-mono text-[10px] font-normal"
                            >
                              {ref}
                            </Badge>
                          ))}
                        </div>
                      ) : null}
                      <p className="mt-1 text-xs text-muted-foreground md:hidden">
                        {commit.authorName}
                      </p>
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      <p>{commit.authorName}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {commit.authorEmail}
                      </p>
                    </td>
                    <td className="hidden whitespace-nowrap px-4 py-3 text-xs text-muted-foreground sm:table-cell">
                      {dateFormatter.format(new Date(commit.authoredAt))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
