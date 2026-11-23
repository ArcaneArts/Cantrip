import { ProjectOverview } from "@/components/projects/project-overview";
import { revealProjectInNativeFileManager } from "@/lib/desktop-project-share";
import { errorMessage } from "@/lib/error-message";
import { ProjectOverviewDialog } from "./project-overview-dialog";

export function ProjectOverviewWorkspace({
  bindings: b,
}: {
  bindings: Readonly<Record<string, any>>;
}) {
  const exit = () => b.setShowProjectOverview(false);
  return (
    <ProjectOverviewDialog onClose={exit}>
      <ProjectOverview
        compact={b.compactShell}
        creatingKinds={b.creatingSurfaceKinds}
        project={b.selectedProject}
        stats={b.repositoryStats.data}
        statsError={
          b.repositoryStats.isError
            ? errorMessage(b.repositoryStats.error)
            : null
        }
        statsLoading={b.repositoryStats.isLoading}
        usage={b.projectTokenUsage.data}
        usageError={
          b.projectTokenUsage.isError
            ? errorMessage(b.projectTokenUsage.error)
            : null
        }
        usageLoading={b.projectTokenUsage.isLoading}
        surfaces={b.projectSurfaces}
        workerOnline={Boolean(
          b.workers.data?.find(
            (worker: any) => worker.workerId === b.selectedProjectWorkerId,
          )?.online,
        )}
        worktrees={b.worktrees.data ?? []}
        placement={b.selectedPlacementContext}
        onCreateSurface={(kind, target) => {
          exit();
          b.createProjectSurface(b.selectedProject.id, kind, undefined, target);
        }}
        onOpenSurface={(tabKey) => {
          exit();
          b.selectTopTab(tabKey);
        }}
        onRevealProject={(local) =>
          revealProjectInNativeFileManager(
            b.selectedProject,
            local,
            "",
            b.worktrees.data?.find(
              (worktree: any) =>
                worktree.id === b.resolvedProjectOverviewWorktreeId,
            ),
          )
        }
        revealLabel={b.projectRevealButtonLabel}
      />
    </ProjectOverviewDialog>
  );
}
