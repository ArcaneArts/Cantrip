import { checkpointChatView } from "@/components/chat/chat-transfer-lifecycle";
import { confirmNativeCodeDiscard } from "@/components/code/native-code-lifecycle";
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
import type { WorkspaceCommandClient } from "@/lib/workspace-command-client";
import {
  reconcileWorkspaceSelection,
  type WorkspaceSelection,
} from "@/lib/workspace-selection";

export type StoredProjectSurfaceKind =
  "browser" | "builtin" | "chat" | "code" | "explorer" | "terminal" | "view";

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

interface WorkspaceRemovalObserver {
  getSnapshot(): { disposed: boolean; authoritative: { projectId: string } };
  refresh(): Promise<void>;
}

const entityCollectionByKind: Record<StoredProjectSurfaceKind, string> = {
  browser: "browsers",
  builtin: "project-tab-layout",
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
  workspace,
}: {
  queryClient: QueryClient;
  setWorkspaceSelection: Dispatch<SetStateAction<WorkspaceSelection>>;
  workspace?: WorkspaceRemovalObserver | null;
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

  const refreshOwnedLayout = useCallback(
    (projectId: string) => {
      if (!workspace) return;
      const state = workspace.getSnapshot();
      if (state.disposed || state.authoritative.projectId !== projectId) return;
      // Refresh errors remain on the controller for recovery; a failed observation
      // must not turn a committed deletion into a retry of that destructive action.
      void workspace.refresh().catch(() => {});
    },
    [workspace],
  );

  const begin = useCallback(
    (input: ProjectSurfaceCloseInput) => {
      const tabKey = projectSurfaceTabKey(
        input.kind,
        input.tabId,
        input.projectId,
      );
      const layoutQueryKey = ["project-tab-layout", input.projectId] as const;
      if (input.kind !== "builtin") {
        void queryClient.cancelQueries({ queryKey: entityQueryKey(input) });
      }
      if (workspace !== undefined) return;
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
    [queryClient, setWorkspaceSelection, workspace],
  );

  const commit = useCallback(
    (input: ProjectSurfaceCloseInput) => {
      const tabKey = projectSurfaceTabKey(
        input.kind,
        input.tabId,
        input.projectId,
      );
      if (input.kind !== "builtin") {
        queryClient.setQueryData<Array<{ id: string }>>(
          entityQueryKey(input),
          (current) => current?.filter(({ id }) => id !== input.tabId),
        );
      }
      if (workspace !== undefined) {
        refreshOwnedLayout(input.projectId);
        return;
      }
      queryClient.setQueryData<ProjectTabLayoutSummary>(
        ["project-tab-layout", input.projectId],
        (current) =>
          current ? removeProjectTabFromLayout(current, tabKey) : current,
      );
      selectionBeforeCloseRef.current.delete(tabKey);
      setPendingTabKeys((current) => removePendingTabKey(current, tabKey));
    },
    [queryClient, workspace, refreshOwnedLayout],
  );

  const rollback = useCallback(
    (input: ProjectSurfaceCloseInput) => {
      if (workspace !== undefined) return;
      const tabKey = projectSurfaceTabKey(
        input.kind,
        input.tabId,
        input.projectId,
      );
      const selection = selectionBeforeCloseRef.current.get(tabKey);
      selectionBeforeCloseRef.current.delete(tabKey);
      if (selection) {
        setWorkspaceSelection((current) =>
          current === selection.optimistic ? selection.before : current,
        );
      }
      setPendingTabKeys((current) => removePendingTabKey(current, tabKey));
    },
    [setWorkspaceSelection, workspace],
  );

  const commitView = useCallback(
    (input: ProjectSurfaceCloseInput, layout: ProjectTabLayoutSummary) => {
      if (workspace !== undefined) {
        refreshOwnedLayout(input.projectId);
        return;
      }
      const tabKey = projectSurfaceTabKey(
        input.kind,
        input.tabId,
        input.projectId,
      );
      queryClient.setQueryData(["project-tab-layout", input.projectId], layout);
      setWorkspaceSelection((current) =>
        current.projectId === input.projectId
          ? reconcileWorkspaceSelection(current, layout)
          : current,
      );
      selectionBeforeCloseRef.current.delete(tabKey);
      setPendingTabKeys((current) => removePendingTabKey(current, tabKey));
    },
    [queryClient, setWorkspaceSelection, workspace, refreshOwnedLayout],
  );

  return { begin, commit, commitView, pendingTabKeys, rollback };
}

function closeInputForSurface(
  surface: ProjectSurface,
): ProjectSurfaceCloseInput {
  const kind =
    surface.kind === "unresolved" || surface.kind === "file"
      ? surface.member.tabKind
      : surface.kind;
  return {
    kind:
      kind === "history" ||
      kind === "graph" ||
      kind === "issues" ||
      kind === "prs" ||
      kind === "actions" ||
      kind === "remote-desktop"
        ? "view"
        : kind,
    projectId: surface.projectId,
    tabId: surface.tabId,
  };
}

class SurfaceCloseInProgress extends Error {
  constructor() {
    super("This view is already closing.");
  }
}

const closeOperationKey = (surface: ProjectSurface) =>
  JSON.stringify([surface.projectId, surface.tabKey]);

export function useProjectSurfaceViewOperations({
  beforeClose,
  onCloseError,
  onCloseCleanupError,
  queryClient,
  surfaceClose,
  workspace,
}: {
  beforeClose?: (
    surface: ProjectSurface,
  ) =>
    | Promise<void | (() => void | Promise<void>)>
    | void
    | (() => void | Promise<void>);
  onCloseError?: (surface: ProjectSurface) => void;
  onCloseCleanupError?: (error: unknown, surface: ProjectSurface) => void;
  queryClient: QueryClient;
  surfaceClose: ProjectSurfaceCloseCoordinator;
  workspace?: { controller: WorkspaceCommandClient } | null;
}) {
  const closing = useRef(new Set<string>());
  const closeSurfaceViewMutation = useMutation({
    mutationFn: (surface: ProjectSurface) => {
      if (workspace !== undefined) {
        if (!workspace) throw new Error("Workspace connection is not ready.");
        if (
          workspace.controller.getSnapshot().authoritative.projectId !==
          surface.projectId
        )
          throw new Error("Workspace command belongs to another project.");
        return workspace.controller
          .dispatch(
            surface.conversation
              ? { type: "close-conversation", viewId: surface.tabKey }
              : { type: "close-tab", tabId: surface.tabKey },
          )
          .then(() => null);
      }
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
      const key = closeOperationKey(surface);
      if (closing.current.has(key)) throw new SurfaceCloseInProgress();
      closing.current.add(key);
      if (
        surface.kind === "code" &&
        !(await confirmNativeCodeDiscard(surface.tabId))
      )
        throw new Error("Code tab close canceled.");
      if (workspace === undefined)
        surfaceClose.begin(closeInputForSurface(surface));
      // Retain the prepared renderer's finalizer: authoritative close may
      // unmount it and remove its registry entry before onSuccess runs.
      const release =
        surface.kind === "chat"
          ? await checkpointChatView({
              tabId: surface.tabKey,
              chatId: surface.tabId,
              projectId: surface.projectId,
            })
          : undefined;
      try {
        const finalize = await beforeClose?.(surface);
        return { finalize, release, committed: false };
      } catch (error) {
        release?.();
        throw error;
      }
    },
    onError: (error, surface, preparation) => {
      // The duplicate never prepared this renderer and cannot release another
      // operation's close reservation or roll back its pending placement.
      if (error instanceof SurfaceCloseInProgress) return;
      if (preparation?.committed) {
        // A cleanup failure cannot undo a successful ownership mutation.
        // Keep recovery data and report it separately from a rejected close.
        onCloseCleanupError?.(error, surface);
        return;
      }
      if (workspace === undefined)
        surfaceClose.rollback(closeInputForSurface(surface));
      onCloseError?.(surface);
    },
    onSuccess: async (result, surface, preparation) => {
      if (preparation) preparation.committed = true;
      if (result)
        surfaceClose.commitView(closeInputForSurface(surface), result.layout);
      await preparation?.finalize?.();
    },
    onSettled: (_data, error, surface, preparation) => {
      if (error instanceof SurfaceCloseInProgress) return;
      preparation?.release?.();
      closing.current.delete(closeOperationKey(surface));
      return workspace !== undefined
        ? undefined
        : queryClient.invalidateQueries({
            queryKey: ["project-tab-layout", surface.projectId],
          });
    },
  });
  return { closeSurfaceViewMutation } as const;
}
