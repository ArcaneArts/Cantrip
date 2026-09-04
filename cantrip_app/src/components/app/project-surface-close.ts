import type { ProjectTabLayoutSummary } from "@cantrip/protocol";
import { useMutation, type QueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { removeProjectTabFromLayout } from "@/lib/project-tab-layout-optimistic";
import {
  projectSurfaceTabKey,
  type ProjectSurface,
} from "@/lib/project-surface";
import { closeProjectSurfaceView } from "@/lib/api";
import {
  reconcileWorkspaceSelection,
  type WorkspaceSelection,
} from "@/lib/workspace-selection";

export type StoredProjectSurfaceKind =
  "browser" | "chat" | "code" | "explorer" | "terminal" | "view";

export interface ProjectSurfaceCloseInput {
  kind: StoredProjectSurfaceKind;
  projectId: string;
  tabId: string;
}

export interface ProjectSurfaceCloseCoordinator {
  begin(input: ProjectSurfaceCloseInput): void;
  commit(input: ProjectSurfaceCloseInput): void;
  commitView(
    input: ProjectSurfaceCloseInput,
    layout: ProjectTabLayoutSummary,
  ): void;
  pendingTabKeys: ReadonlySet<string>;
  rollback(input: ProjectSurfaceCloseInput): void;
}

const entityCollectionByKind: Record<StoredProjectSurfaceKind, string> = {
  browser: "browsers",
  chat: "chats",
  code: "code-tabs",
  explorer: "explorers",
  terminal: "terminals",
  view: "project-views",
};

function entityQueryKey(input: ProjectSurfaceCloseInput) {
  return [entityCollectionByKind[input.kind], input.projectId] as const;
}

function removePendingTabKey(
  current: ReadonlySet<string>,
  tabKey: string,
): ReadonlySet<string> {
  if (!current.has(tabKey)) return current;
  const next = new Set(current);
  next.delete(tabKey);
  return next;
}

export function useProjectSurfaceCloseCoordinator({
  queryClient,
  setWorkspaceSelection,
}: {
  queryClient: QueryClient;
  setWorkspaceSelection: Dispatch<SetStateAction<WorkspaceSelection>>;
}): ProjectSurfaceCloseCoordinator {
  const [pendingTabKeys, setPendingTabKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const selectionBeforeCloseRef = useRef(
    new Map<
      string,
      { before: WorkspaceSelection; optimistic: WorkspaceSelection }
    >(),
  );

  const begin = useCallback(
    (input: ProjectSurfaceCloseInput) => {
      const tabKey = projectSurfaceTabKey(input.kind, input.tabId);
      const layoutQueryKey = ["project-tab-layout", input.projectId] as const;
      void queryClient.cancelQueries({ queryKey: entityQueryKey(input) });
      void queryClient.cancelQueries({ queryKey: layoutQueryKey });
      setPendingTabKeys((current) => {
        if (current.has(tabKey)) return current;
        return new Set(current).add(tabKey);
      });
      const layout =
        queryClient.getQueryData<ProjectTabLayoutSummary>(layoutQueryKey);
      if (!layout) return;
      const projectedLayout = removeProjectTabFromLayout(layout, tabKey);
      setWorkspaceSelection((current) => {
        if (current.projectId !== input.projectId) return current;
        const optimistic = reconcileWorkspaceSelection(
          current,
          projectedLayout,
        );
        selectionBeforeCloseRef.current.set(tabKey, {
          before: current,
          optimistic,
        });
        return optimistic;
      });
    },
    [queryClient, setWorkspaceSelection],
  );

  const commit = useCallback(
    (input: ProjectSurfaceCloseInput) => {
      const tabKey = projectSurfaceTabKey(input.kind, input.tabId);
      queryClient.setQueryData<Array<{ id: string }>>(
        entityQueryKey(input),
        (current) => current?.filter(({ id }) => id !== input.tabId),
      );
      queryClient.setQueryData<ProjectTabLayoutSummary>(
        ["project-tab-layout", input.projectId],
        (current) =>
          current ? removeProjectTabFromLayout(current, tabKey) : current,
      );
      selectionBeforeCloseRef.current.delete(tabKey);
      setPendingTabKeys((current) => removePendingTabKey(current, tabKey));
    },
    [queryClient],
  );

  const rollback = useCallback(
    (input: ProjectSurfaceCloseInput) => {
      const tabKey = projectSurfaceTabKey(input.kind, input.tabId);
      const selection = selectionBeforeCloseRef.current.get(tabKey);
      selectionBeforeCloseRef.current.delete(tabKey);
      if (selection) {
        setWorkspaceSelection((current) =>
          current === selection.optimistic ? selection.before : current,
        );
      }
      setPendingTabKeys((current) => removePendingTabKey(current, tabKey));
    },
    [setWorkspaceSelection],
  );

  const commitView = useCallback(
    (input: ProjectSurfaceCloseInput, layout: ProjectTabLayoutSummary) => {
      const tabKey = projectSurfaceTabKey(input.kind, input.tabId);
      queryClient.setQueryData(["project-tab-layout", input.projectId], layout);
      setWorkspaceSelection((current) =>
        current.projectId === input.projectId
          ? reconcileWorkspaceSelection(current, layout)
          : current,
      );
      selectionBeforeCloseRef.current.delete(tabKey);
      setPendingTabKeys((current) => removePendingTabKey(current, tabKey));
    },
    [queryClient, setWorkspaceSelection],
  );

  return { begin, commit, commitView, pendingTabKeys, rollback };
}

function closeInputForSurface(
  surface: ProjectSurface,
): ProjectSurfaceCloseInput {
  return {
    kind:
      surface.kind === "history" ||
      surface.kind === "issues" ||
      surface.kind === "remote-desktop"
        ? "view"
        : surface.kind,
    projectId: surface.projectId,
    tabId: surface.tabId,
  };
}

export function useProjectSurfaceViewOperations({
  beforeClose,
  onCloseError,
  queryClient,
  surfaceClose,
}: {
  beforeClose?: (surface: ProjectSurface) => Promise<void> | void;
  onCloseError?: (surface: ProjectSurface) => void;
  queryClient: QueryClient;
  surfaceClose: ProjectSurfaceCloseCoordinator;
}) {
  const closeSurfaceViewMutation = useMutation({
    mutationFn: (surface: ProjectSurface) => {
      const layout = queryClient.getQueryData<ProjectTabLayoutSummary>([
        "project-tab-layout",
        surface.projectId,
      ]);
      if (!layout) throw new Error("The project tab layout is not loaded.");
      return closeProjectSurfaceView(
        surface.projectId,
        layout.revision,
        surface.view.id,
      );
    },
    onMutate: async (surface) => {
      surfaceClose.begin(closeInputForSurface(surface));
      await beforeClose?.(surface);
    },
    onError: (_error, surface) => {
      surfaceClose.rollback(closeInputForSurface(surface));
      onCloseError?.(surface);
    },
    onSuccess: (result, surface) => {
      surfaceClose.commitView(closeInputForSurface(surface), result.layout);
    },
    onSettled: (_data, _error, surface) =>
      queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", surface.projectId],
      }),
  });
  return { closeSurfaceViewMutation } as const;
}
