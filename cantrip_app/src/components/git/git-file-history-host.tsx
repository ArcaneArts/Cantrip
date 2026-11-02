import type { ProjectSummary, ProjectWorktreeSummary } from "@cantrip/protocol";
import { useEffect, useState } from "react";

import type { WorktreeStatusMap } from "@/components/worktrees/worktree-control";
import {
  defaultGitHistoryOptions,
  openGitFileHistoryEvent,
  type GitHistoryRouteState,
  type OpenGitFileHistoryRequest,
} from "@/lib/git-history-navigation";

import {
  GitCommitActionDialog,
  type CommitActionRequest,
} from "./git-commit-action-dialog";
import { GitCommitInspector } from "./git-commit-inspector";
import { GitFileHistoryDialog } from "./git-file-history-dialog";
import type { GitViewSection } from "./git-history";

type Selection = OpenGitFileHistoryRequest &
  ({ kind: "file" } | { kind: "commit"; revision: string });

/** File-history requests are overlays, independent of workspace navigation. */
export function GitFileHistoryHost({
  onOpenFile,
  onOpenHistory,
  projects,
  statuses,
  worktrees,
}: {
  onOpenFile(projectId: string, worktreeId: string, path: string): void;
  onOpenHistory(
    route: GitHistoryRouteState & { projectId: string; worktreeId: string },
    section?: GitViewSection,
  ): void;
  projects: readonly ProjectSummary[];
  statuses: WorktreeStatusMap;
  worktrees: readonly ProjectWorktreeSummary[];
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [action, setAction] = useState<CommitActionRequest | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      const request = (event as CustomEvent<OpenGitFileHistoryRequest>).detail;
      setSelection({ ...request, kind: "file" });
      setAction(null);
    };
    window.addEventListener(openGitFileHistoryEvent, open);
    return () => window.removeEventListener(openGitFileHistoryEvent, open);
  }, []);

  if (!selection) return null;
  const { projectId, worktreeId } = selection;
  const close = () => setSelection(null);
  const openFile = (path: string) => {
    close();
    onOpenFile(projectId, worktreeId, path);
  };
  const openHistory = (
    options = defaultGitHistoryOptions,
    commit: string | null = null,
    section: GitViewSection = "history",
    targetWorktreeId = worktreeId,
  ) => {
    close();
    onOpenHistory(
      {
        projectId,
        worktreeId: targetWorktreeId,
        commit,
        selectedCommits: [],
        comparison: null,
        filePath: null,
        options,
      },
      section,
    );
  };
  return (
    <>
      {selection.kind === "file" ? (
        <GitFileHistoryDialog
          key={`${projectId}:${worktreeId}:${selection.path}`}
          initialPath={selection.path}
          open
          onOpenChange={(open) => !open && close()}
          projectId={projectId}
          worktreeId={worktreeId}
          onOpenFile={openFile}
          onOpenCommit={(revision) =>
            setSelection({ ...selection, kind: "commit", revision })
          }
        />
      ) : (
        <GitCommitInspector
          currentHead={statuses[worktreeId]?.head ?? null}
          githubUrl={projects.find(({ id }) => id === projectId)?.github?.url}
          projectId={projectId}
          worktreeId={worktreeId}
          revision={selection.revision}
          onClose={close}
          onOpenFile={openFile}
          onNavigate={(revision) => setSelection({ ...selection, revision })}
          onFilter={(filters) =>
            openHistory({
              ...defaultGitHistoryOptions,
              filters: { ...defaultGitHistoryOptions.filters, ...filters },
            })
          }
          onViewInGraph={(revision) =>
            openHistory(defaultGitHistoryOptions, revision, "graph")
          }
          onAction={setAction}
        />
      )}
      {action ? (
        <GitCommitActionDialog
          projectId={projectId}
          worktreeId={worktreeId}
          worktrees={worktrees}
          request={action}
          onOpenChange={(open) => !open && setAction(null)}
          onConflict={(targetWorktreeId) =>
            openHistory(
              defaultGitHistoryOptions,
              null,
              "history",
              targetWorktreeId,
            )
          }
        />
      ) : null}
    </>
  );
}
