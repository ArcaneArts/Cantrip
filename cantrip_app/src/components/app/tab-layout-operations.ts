import type {
  ProjectSummary,
  ProjectTabLayoutSummary,
} from "@cantrip/protocol";
import { useMutation, type QueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import {
  moveProjectPaneMember,
  reorderProjectPaneMembers,
  reorderProjectPanes,
  updateProjectPane,
} from "@/lib/api";
import { errorMessage as errorText } from "@/lib/error-message";
import {
  applyOptimisticTabLayoutToCache,
  restoreOptimisticTabLayoutCache,
  type OptimisticTabLayoutSnapshot,
} from "@/lib/project-tab-layout-optimistic";
import type {
  TabLayoutCommand,
  WorkspaceDropOperation,
} from "@/lib/workspace-dnd-model";

interface TabLayoutMutationInput {
  projectId: string;
  command: TabLayoutCommand;
}

interface PreparedTabLayoutMutation {
  cancellation: Promise<void>;
  snapshot: OptimisticTabLayoutSnapshot;
}

export function prepareOptimisticTabLayoutMutation(
  queryClient: QueryClient,
  input: TabLayoutMutationInput,
): PreparedTabLayoutMutation {
  const queryKey = ["project-tab-layout", input.projectId] as const;
  const cancellation = queryClient.cancelQueries({ queryKey });
  // dnd-kit measures the drop destination as soon as onDragEnd returns. Keep
  // this projection synchronous so its overlay lands on the reordered tab.
  const snapshot = applyOptimisticTabLayoutToCache(
    queryClient,
    input.projectId,
    input.command,
  );
  return { cancellation, snapshot };
}

export function useTabLayoutOperations({
  queryClient,
  setWorkspaceDragError,
}: {
  queryClient: QueryClient;
  setWorkspaceDragError: (error: string | null) => void;
}) {
  const preparedTabLayouts = useRef(
    new WeakMap<TabLayoutMutationInput, PreparedTabLayoutMutation>(),
  );
  const baseTabLayoutMutation = useMutation({
    mutationFn: ({
      command,
      projectId,
    }: {
      projectId: string;
      command: TabLayoutCommand;
    }) => {
      const current = queryClient.getQueryData<ProjectTabLayoutSummary>([
        "project-tab-layout",
        projectId,
      ]);
      if (!current) throw new Error("The project tab layout is not loaded.");
      if (command.type === "reorder-panes") {
        return reorderProjectPanes(
          projectId,
          current.revision,
          command.region,
          command.paneIds,
        );
      }
      if (command.type === "reorder-members") {
        return reorderProjectPaneMembers(
          projectId,
          command.paneId,
          current.revision,
          command.tabKeys,
        );
      }
      return moveProjectPaneMember(projectId, {
        revision: current.revision,
        tabKey: command.tabKey,
        targetPaneId: command.targetPaneId,
        targetMemberPosition: command.targetMemberPosition,
        ...(command.targetPanePosition === undefined
          ? {}
          : { targetPanePosition: command.targetPanePosition }),
        ...(command.targetRegion === undefined
          ? {}
          : { targetRegion: command.targetRegion }),
      });
    },
    onMutate: async (input: TabLayoutMutationInput) => {
      setWorkspaceDragError(null);
      const prepared = preparedTabLayouts.current.get(input);
      if (prepared) {
        preparedTabLayouts.current.delete(input);
        await prepared.cancellation;
        return prepared.snapshot;
      }
      const next = prepareOptimisticTabLayoutMutation(queryClient, input);
      await next.cancellation;
      return next.snapshot;
    },
    onError: (error, _input, context) => {
      restoreOptimisticTabLayoutCache(queryClient, context);
      setWorkspaceDragError(errorText(error));
    },
    onSuccess: (layout) =>
      queryClient.setQueryData(
        ["project-tab-layout", layout.projectId],
        layout,
      ),
    onSettled: (_data, _error, input) =>
      queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", input.projectId],
      }),
  });
  const tabLayoutMutation = {
    isPending: baseTabLayoutMutation.isPending,
    mutate: (input: TabLayoutMutationInput) => {
      const prepared = prepareOptimisticTabLayoutMutation(queryClient, input);
      preparedTabLayouts.current.set(input, prepared);
      baseTabLayoutMutation.mutate(input);
    },
  };
  const renamePaneMutation = useMutation({
    mutationFn: ({
      paneId,
      projectId,
      title,
    }: {
      paneId: string;
      projectId: string;
      title: string;
    }) => {
      const current = queryClient.getQueryData<ProjectTabLayoutSummary>([
        "project-tab-layout",
        projectId,
      ]);
      if (!current) throw new Error("The project tab layout is not loaded.");
      return updateProjectPane(projectId, paneId, current.revision, title);
    },
    onSuccess: (layout) =>
      queryClient.setQueryData(
        ["project-tab-layout", layout.projectId],
        layout,
      ),
    onSettled: (_data, _error, input) =>
      queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", input.projectId],
      }),
  });
  return { renamePaneMutation, tabLayoutMutation } as const;
}

interface WorkspaceDropMutation<Input> {
  isPending?: boolean;
  mutate(input: Input): void;
}

export function createWorkspaceDropHandler({
  projects,
  reorderProjectsMutation,
  setWorkspaceDragError,
  tabLayoutMutation,
}: {
  projects: readonly ProjectSummary[];
  reorderProjectsMutation: WorkspaceDropMutation<string[]>;
  setWorkspaceDragError: (error: string | null) => void;
  tabLayoutMutation: WorkspaceDropMutation<{
    command: TabLayoutCommand;
    projectId: string;
  }>;
}) {
  return (operation: WorkspaceDropOperation) => {
    setWorkspaceDragError(null);
    if (operation.type === "tab-layout") {
      if (tabLayoutMutation.isPending) {
        setWorkspaceDragError("Wait for the current tab move to finish.");
        return;
      }
      tabLayoutMutation.mutate({
        projectId: operation.projectId,
        command: operation.command,
      });
      return;
    }
    const from = projects.findIndex(
      ({ id }) => id === operation.sourceProjectId,
    );
    const to = projects.findIndex(({ id }) => id === operation.targetProjectId);
    if (from < 0 || to < 0) return;
    const reordered = [...projects];
    const [moved] = reordered.splice(from, 1);
    if (!moved) return;
    reordered.splice(to, 0, moved);
    reorderProjectsMutation.mutate(reordered.map(({ id }) => id));
  };
}
