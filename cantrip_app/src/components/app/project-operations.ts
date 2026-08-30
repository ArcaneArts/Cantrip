import type {
  ProjectReplicaJobSummary,
  ProjectSummary,
  ProjectWorkspaceSummary,
} from "@cantrip/protocol";
import { useMutation, type QueryClient } from "@tanstack/react-query";
import { flushSync } from "react-dom";

import type { PendingSurfaceSelection } from "@/components/app/shell-navigation";
import {
  removeProject,
  reorderProjects,
  retryProjectFolderSetup,
  retryProjectReplicaJob,
} from "@/lib/api";
import { projectSetupFailureKey } from "@/lib/project-setup-progress";
import { createProjectWorkspace } from "@/lib/workspace-encryption";
import {
  emptyWorkspaceSelection,
  type WorkspaceSelection,
} from "@/lib/workspace-selection";

export function useProjectSetupOperations({
  activeProjectWorkspaceStorageKey,
  queryClient,
  setActiveProjectWorkspaceId,
  setDismissedLongPathFailure,
  setSelectedProjectId,
  setShowArchivedStandaloneChats,
  setShowImporter,
  setShowProjectSettings,
  setShowServerAdmin,
  setShowSettings,
  setWorkspaceSelection,
}: {
  activeProjectWorkspaceStorageKey: string;
  queryClient: QueryClient;
  setActiveProjectWorkspaceId: (workspaceId: string | null) => void;
  setDismissedLongPathFailure: (failure: string | null) => void;
  setSelectedProjectId: (projectId: string | null) => void;
  setShowArchivedStandaloneChats: (show: boolean) => void;
  setShowImporter: (show: boolean) => void;
  setShowProjectSettings: (show: boolean) => void;
  setShowServerAdmin: (show: boolean) => void;
  setShowSettings: (show: boolean) => void;
  setWorkspaceSelection: (selection: WorkspaceSelection) => void;
}) {
  const retryLongPathSetupMutation = useMutation({
    mutationFn: (job: ProjectReplicaJobSummary) =>
      retryProjectReplicaJob(job.id, { stateRevision: job.stateRevision }),
    onSuccess: async (_updated, job) => {
      setDismissedLongPathFailure(projectSetupFailureKey(job));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({
          queryKey: ["project-replica-jobs", job.projectId],
        }),
      ]);
    },
  });
  const createWorkspaceMutation = useMutation({
    mutationFn: (name: string) => createProjectWorkspace({ name }),
    onSuccess: (workspace) => {
      queryClient.setQueryData<ProjectWorkspaceSummary[]>(
        ["project-workspaces"],
        (current = []) => [...current, workspace],
      );
      setActiveProjectWorkspaceId(workspace.id);
      window.localStorage.setItem(
        activeProjectWorkspaceStorageKey,
        workspace.id,
      );
      setSelectedProjectId(null);
      setWorkspaceSelection(emptyWorkspaceSelection());
      setShowImporter(false);
      setShowSettings(false);
      setShowArchivedStandaloneChats(false);
      setShowServerAdmin(false);
      setShowProjectSettings(false);
    },
  });
  return { createWorkspaceMutation, retryLongPathSetupMutation } as const;
}

export function useProjectListOperations({
  pendingSurfaceSelection,
  queryClient,
  selectedProjectId,
  setPendingSurfaceSelection,
  setSelectedProjectId,
  setShowProjectSettings,
  setWorkspaceSelection,
  showProjectSettings,
  workspaceSelection,
}: {
  pendingSurfaceSelection: PendingSurfaceSelection | null;
  queryClient: QueryClient;
  selectedProjectId: string | null;
  setPendingSurfaceSelection: (
    selection: PendingSurfaceSelection | null,
  ) => void;
  setSelectedProjectId: (projectId: string | null) => void;
  setShowProjectSettings: (show: boolean) => void;
  setWorkspaceSelection: (selection: WorkspaceSelection) => void;
  showProjectSettings: boolean;
  workspaceSelection: WorkspaceSelection;
}) {
  const removeProjectMutation = useMutation({
    mutationFn: ({
      projectId,
      deleteLocalFiles,
    }: {
      projectId: string;
      deleteLocalFiles: boolean;
    }) => removeProject(projectId, deleteLocalFiles),
    onMutate: async ({ projectId }) => {
      await queryClient.cancelQueries({ queryKey: ["projects"] });
      const previousProjects = queryClient.getQueryData<ProjectSummary[]>([
        "projects",
      ]);
      const restoreSelection =
        selectedProjectId === projectId
          ? {
              pendingSurfaceSelection,
              showProjectSettings,
              workspaceSelection,
            }
          : null;
      flushSync(() => {
        queryClient.setQueryData<ProjectSummary[]>(
          ["projects"],
          (current = []) =>
            current.filter((project) => project.id !== projectId),
        );
        if (restoreSelection) {
          setSelectedProjectId(null);
          setWorkspaceSelection(emptyWorkspaceSelection());
          setPendingSurfaceSelection(null);
          setShowProjectSettings(false);
        }
      });
      return { previousProjects, restoreSelection };
    },
    onError: (_error, { projectId }, context) => {
      if (context?.previousProjects) {
        queryClient.setQueryData(["projects"], context.previousProjects);
      }
      if (context?.restoreSelection) {
        setSelectedProjectId(projectId);
        setWorkspaceSelection(context.restoreSelection.workspaceSelection);
        setPendingSurfaceSelection(
          context.restoreSelection.pendingSurfaceSelection,
        );
        setShowProjectSettings(context.restoreSelection.showProjectSettings);
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project-workspaces"] }),
        queryClient.invalidateQueries({ queryKey: ["github-repositories"] }),
      ]);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["projects"] }),
  });
  const retryFolderSetupMutation = useMutation({
    mutationFn: ({
      projectId,
      stateRevision,
    }: {
      projectId: string;
      stateRevision: number;
    }) => retryProjectFolderSetup(projectId, stateRevision),
    onSuccess: (job) => {
      queryClient.setQueryData(["project-folder-setup", job.projectId], job);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const reorderProjectsMutation = useMutation({
    mutationFn: (ids: string[]) => reorderProjects(ids),
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: ["projects"] });
      const previous = queryClient.getQueryData<ProjectSummary[]>(["projects"]);
      queryClient.setQueryData<ProjectSummary[]>(["projects"], (current = []) =>
        ids.flatMap((id, position) => {
          const project = current.find((item) => item.id === id);
          return project ? [{ ...project, position }] : [];
        }),
      );
      return { previous };
    },
    onError: (_error, _ids, context) =>
      queryClient.setQueryData(["projects"], context?.previous),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["projects"] }),
  });
  return {
    removeProjectMutation,
    reorderProjectsMutation,
    retryFolderSetupMutation,
  } as const;
}
