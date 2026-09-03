import type { ProjectTabLayoutSummary } from "@cantrip/protocol";
import type { QueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { removeProjectTabFromLayout } from "@/lib/project-tab-layout-optimistic";
import { projectSurfaceTabKey } from "@/lib/project-surface";
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
      setWorkspaceSelection((current) =>
        reconcileWorkspaceSelection(current, projectedLayout),
      );
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
      setPendingTabKeys((current) => removePendingTabKey(current, tabKey));
    },
    [queryClient],
  );

  const rollback = useCallback((input: ProjectSurfaceCloseInput) => {
    const tabKey = projectSurfaceTabKey(input.kind, input.tabId);
    setPendingTabKeys((current) => removePendingTabKey(current, tabKey));
  }, []);

  return { begin, commit, pendingTabKeys, rollback };
}
