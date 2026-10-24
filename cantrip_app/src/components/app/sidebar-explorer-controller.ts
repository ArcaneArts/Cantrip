import type {
  ChatSummary,
  ExplorerSummary,
  ProjectSummary,
  ProjectTabLayoutSummary,
  ProjectWorktreeSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import { useMutation, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ShellEnvironment } from "@/components/app/shell-environment";
import { resolveChatFileReferenceTarget } from "@/components/app/chat-file-reference-target";
import type {
  ExplorerGraphRequest,
  ExplorerLifecycleActions,
} from "@/components/explorer/explorer-view";
import type { AppToastInput } from "@/components/ui/app-toast";
import { createExplorer, getProjectWorktrees } from "@/lib/api";
import { errorMessage as errorText } from "@/lib/error-message";
import type { ProjectSurface } from "@/lib/project-surface";
import {
  dedicatedSidebarExplorers,
  preferredSidebarExplorer,
  primaryWorktreeId,
  SIDEBAR_EXPLORER_POOL_SIZE,
  surfaceWorktreeId,
  tabbedExplorerIds,
  type SidebarFilePreviewState,
} from "@/lib/sidebar-file-tabs";

type OpenCreatedTab = (
  projectId: string,
  kind: "explorer",
  tabId: string,
) => void;

export function useSidebarFileState() {
  const [sidebarFilePreview, setSidebarFilePreview] =
    useState<SidebarFilePreviewState | null>(null);
  const [explorerGraphRequest, setExplorerGraphRequest] =
    useState<ExplorerGraphRequest | null>(null);
  return {
    explorerGraphRequest,
    setExplorerGraphRequest,
    setSidebarFilePreview,
    sidebarFilePreview,
  } as const;
}

export type SidebarFileState = ReturnType<typeof useSidebarFileState>;

export function useExplorerLifecycleRefs() {
  const explorerLifecycleRef = useRef(
    new Map<string, ExplorerLifecycleActions>(),
  );
  const sidebarFilePreviewLifecycleRef =
    useRef<ExplorerLifecycleActions | null>(null);
  const sidebarExplorerCreationKeyRef = useRef<string | null>(null);
  return {
    explorerLifecycleRef,
    sidebarExplorerCreationKeyRef,
    sidebarFilePreviewLifecycleRef,
  } as const;
}

export type ExplorerLifecycleRefs = ReturnType<typeof useExplorerLifecycleRefs>;

export function useExplorerLifecycleRegistration({
  lifecycle,
  queryClient,
  onDirtyFile,
  onRegistered,
}: {
  lifecycle: ExplorerLifecycleRefs;
  queryClient: QueryClient;
  onDirtyFile?: (explorerId: string) => void;
  onRegistered?: () => void;
}) {
  const { explorerLifecycleRef, sidebarFilePreviewLifecycleRef } = lifecycle;
  const handleExplorerLifecycleChange = useCallback(
    (explorerId: string, actions: ExplorerLifecycleActions | null) => {
      const wasRegistered = explorerLifecycleRef.current.has(explorerId);
      if (actions) explorerLifecycleRef.current.set(explorerId, actions);
      else explorerLifecycleRef.current.delete(explorerId);
      if (actions?.dirty) onDirtyFile?.(explorerId);
      if (wasRegistered !== Boolean(actions)) onRegistered?.();
    },
    [explorerLifecycleRef, onDirtyFile, onRegistered],
  );
  const handleSidebarFilePreviewLifecycleChange = useCallback(
    (_explorerId: string, actions: ExplorerLifecycleActions | null) => {
      sidebarFilePreviewLifecycleRef.current = actions;
    },
    [sidebarFilePreviewLifecycleRef],
  );
  const handleExplorerChanged = useCallback(
    (updated: ExplorerSummary) => {
      queryClient.setQueryData<ExplorerSummary[]>(
        ["explorers", updated.projectId],
        (current = []) =>
          current.map((explorer) =>
            explorer.id === updated.id ? updated : explorer,
          ),
      );
    },
    [queryClient],
  );
  return {
    handleExplorerChanged,
    handleExplorerLifecycleChange,
    handleSidebarFilePreviewLifecycleChange,
  } as const;
}

export function useSidebarExplorerMutations({
  queryClient,
}: {
  queryClient: QueryClient;
}) {
  const createSidebarExplorerMutation = useMutation({
    mutationFn: ({
      projectId,
      worktreeId,
    }: {
      projectId: string;
      worktreeId?: string;
    }) =>
      createExplorer(
        projectId,
        "Project files",
        worktreeId,
        undefined,
        undefined,
        { attachToTabLayout: false },
      ),
    onSuccess: (explorer) => {
      queryClient.setQueryData<ExplorerSummary[]>(
        ["explorers", explorer.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== explorer.id), explorer].sort(
            (left, right) => left.position - right.position,
          ),
      );
      void queryClient.invalidateQueries({
        queryKey: ["explorers", explorer.projectId],
      });
    },
  });
  return { createSidebarExplorerMutation } as const;
}

export type SidebarExplorerMutations = ReturnType<
  typeof useSidebarExplorerMutations
>;

export function createProjectExplorerFileOpening({
  openOwnedFile,
  queryClient,
  selectedProject,
  setPopoutError,
  showAppToast,
  worktrees,
}: {
  openOwnedFile: (
    projectId: string,
    worktreeId: string,
    path: string,
  ) => Promise<void>;
  queryClient: QueryClient;
  selectedProject: ProjectSummary | undefined;
  setPopoutError: (error: string | null) => void;
  showAppToast: (toast: AppToastInput) => void;
  worktrees: ProjectWorktreeSummary[] | undefined;
}) {
  const openProjectExplorerFile = (
    projectId: string,
    worktreeId: string,
    path: string,
  ) => {
    void openOwnedFile(projectId, worktreeId, path).catch((error: unknown) =>
      setPopoutError(errorText(error)),
    );
  };
  const openChatFileLink = (
    chat: ChatSummary,
    reference: string,
    messageWorktreeId?: string | null,
  ) => {
    void resolveChatFileReferenceTarget({
      reference,
      projectId: chat.projectId,
      activeWorktreeId: chat.activeWorktreeId,
      messageWorktreeId,
      source:
        selectedProject?.id === chat.projectId ? selectedProject.source : null,
      worktrees:
        queryClient.getQueryData<ProjectWorktreeSummary[]>([
          "worktrees",
          chat.projectId,
        ]) ??
        worktrees ??
        [],
      refreshWorktrees: async () => {
        const refreshed = await getProjectWorktrees(chat.projectId);
        queryClient.setQueryData<ProjectWorktreeSummary[]>(
          ["worktrees", chat.projectId],
          refreshed,
        );
        return refreshed;
      },
    })
      .then((resolved) => {
        if (!resolved) {
          showAppToast({
            message:
              "This link could not be matched to a checkout of this project. Its original worktree may no longer be available.",
            title: "Could not open file link",
            tone: "error",
          });
          return;
        }
        openProjectExplorerFile(
          chat.projectId,
          resolved.worktreeId,
          resolved.path,
        );
      })
      .catch((error: unknown) => setPopoutError(errorText(error)));
  };
  return { openChatFileLink, openProjectExplorerFile } as const;
}

export function useSidebarExplorerModel({
  unavailablePaneIds,
  environment,
  explorers,
  fileState,
  openCreatedTab,
  selectedProjectId,
  selectedSurface,
  tabLayout,
  worktrees,
}: {
  unavailablePaneIds: ReadonlySet<string>;
  environment: Pick<
    ShellEnvironment,
    "explorerFileTarget" | "popoutTarget" | "projectOverviewPopoutTarget"
  >;
  explorers: ExplorerSummary[] | undefined;
  fileState: Pick<SidebarFileState, "sidebarFilePreview">;
  openCreatedTab: OpenCreatedTab;
  selectedProjectId: string | null;
  selectedSurface: ProjectSurface | undefined;
  tabLayout: ProjectTabLayoutSummary | undefined;
  worktrees: ProjectWorktreeSummary[] | undefined;
}) {
  const { explorerFileTarget, popoutTarget, projectOverviewPopoutTarget } =
    environment;
  const { sidebarFilePreview } = fileState;
  const sidebarDesiredWorktreeId =
    surfaceWorktreeId(selectedSurface) ?? primaryWorktreeId(worktrees ?? []);
  const sidebarPreviewExplorer = sidebarFilePreview
    ? (explorers?.find(
        (explorer) => explorer.id === sidebarFilePreview.explorerId,
      ) ?? null)
    : null;
  const sidebarExplorer = preferredSidebarExplorer({
    desiredWorktreeId: sidebarDesiredWorktreeId,
    explorers: explorers ?? [],
    layout: tabLayout,
    previewExplorerId: sidebarFilePreview?.active
      ? sidebarFilePreview.explorerId
      : null,
  });
  const sidebarInlineExplorers = useMemo(
    () =>
      dedicatedSidebarExplorers({
        desiredWorktreeId: sidebarDesiredWorktreeId,
        explorers: explorers ?? [],
        layout: tabLayout,
      }),
    [explorers, sidebarDesiredWorktreeId, tabLayout],
  );
  const sidebarInlineExplorer = sidebarInlineExplorers[0] ?? null;
  const sidebarPreviewSuccessorExplorer = sidebarInlineExplorers[1] ?? null;
  const connectedExplorerPaneIds = useMemo(() => {
    if (projectOverviewPopoutTarget || explorerFileTarget) {
      return new Set<string>();
    }
    if (popoutTarget) return new Set([popoutTarget.paneId]);
    return new Set(
      tabLayout?.panes
        .filter(({ id }) => !unavailablePaneIds.has(id))
        .map(({ id }) => id) ?? [],
    );
  }, [
    explorerFileTarget,
    popoutTarget,
    projectOverviewPopoutTarget,
    tabLayout,
    unavailablePaneIds,
  ]);
  const openExplorerIds = useMemo(
    () => tabbedExplorerIds(tabLayout, connectedExplorerPaneIds),
    [connectedExplorerPaneIds, tabLayout],
  );
  const openExplorers = useMemo(
    () =>
      (explorers ?? []).filter((explorer) => openExplorerIds.has(explorer.id)),
    [explorers, openExplorerIds],
  );
  const sidebarFilePreviewRef = useRef(sidebarFilePreview);
  sidebarFilePreviewRef.current = sidebarFilePreview;
  const selectedProjectIdRef = useRef(selectedProjectId);
  selectedProjectIdRef.current = selectedProjectId;
  const openCreatedTabRef = useRef(openCreatedTab);
  openCreatedTabRef.current = openCreatedTab;
  return {
    openCreatedTabRef,
    openExplorerIds,
    openExplorers,
    selectedProjectIdRef,
    sidebarDesiredWorktreeId,
    sidebarExplorer,
    sidebarFilePreviewRef,
    sidebarInlineExplorer,
    sidebarInlineExplorers,
    sidebarPreviewSuccessorExplorer,
    sidebarPreviewExplorer,
  } as const;
}

type SidebarExplorerModel = ReturnType<typeof useSidebarExplorerModel>;

export function sidebarExplorerProvisioningDetails({
  onlineWorkerIds,
  selectedProject,
  selectedProjectWorkerId,
  sidebarDesiredWorktreeId,
  sidebarExplorer,
  sidebarInlineExplorers,
}: {
  onlineWorkerIds: ReadonlySet<string>;
  selectedProject: ProjectSummary | undefined;
  selectedProjectWorkerId: string | null;
  sidebarDesiredWorktreeId: string | null;
  sidebarExplorer: ExplorerSummary | null;
  sidebarInlineExplorers: readonly ExplorerSummary[];
}) {
  const sidebarFileWorkerId =
    sidebarExplorer?.activeWorkerId ?? selectedProjectWorkerId;
  const sidebarFileWorkerOnline = Boolean(
    sidebarFileWorkerId && onlineWorkerIds.has(sidebarFileWorkerId),
  );
  const sidebarExplorerCreationInput =
    selectedProject?.setupStatus === "ready" &&
    selectedProject.source &&
    (!selectedProject.capabilities.worktrees || sidebarDesiredWorktreeId)
      ? {
          projectId: selectedProject.id,
          ...(sidebarDesiredWorktreeId
            ? { worktreeId: sidebarDesiredWorktreeId }
            : {}),
        }
      : null;
  const sidebarExplorerCreationKey = sidebarExplorerCreationInput
    ? `${sidebarExplorerCreationInput.projectId}:${sidebarExplorerCreationInput.worktreeId ?? "default"}:${sidebarInlineExplorers.length}`
    : null;
  const sidebarHasDesiredExplorer = Boolean(
    sidebarExplorerCreationInput &&
    sidebarInlineExplorers.length >= SIDEBAR_EXPLORER_POOL_SIZE,
  );
  return {
    sidebarExplorerCreationInput,
    sidebarExplorerCreationKey,
    sidebarFileWorkerId,
    sidebarFileWorkerOnline,
    sidebarHasDesiredExplorer,
    sidebarExplorerPoolSize: sidebarInlineExplorers.length,
  } as const;
}

export function useSidebarExplorerProvisioning({
  explorers,
  explorersIsSuccess,
  fileState,
  isPopout,
  lifecycle,
  model,
  mutations,
  selectedProject,
  selectedProjectId,
  selectedProjectWorkerId,
  tabLayoutIsSuccess,
  workers,
}: {
  explorers: ExplorerSummary[] | undefined;
  explorersIsSuccess: boolean;
  fileState: Pick<
    SidebarFileState,
    "setSidebarFilePreview" | "sidebarFilePreview"
  >;
  isPopout: boolean;
  lifecycle: Pick<
    ExplorerLifecycleRefs,
    "sidebarExplorerCreationKeyRef" | "sidebarFilePreviewLifecycleRef"
  >;
  model: Pick<
    SidebarExplorerModel,
    | "sidebarDesiredWorktreeId"
    | "sidebarExplorer"
    | "sidebarInlineExplorer"
    | "sidebarInlineExplorers"
    | "sidebarPreviewExplorer"
  >;
  mutations: Pick<SidebarExplorerMutations, "createSidebarExplorerMutation">;
  selectedProject: ProjectSummary | undefined;
  selectedProjectId: string | null;
  selectedProjectWorkerId: string | null;
  tabLayoutIsSuccess: boolean;
  workers: WorkerSummary[] | undefined;
}) {
  const { setSidebarFilePreview, sidebarFilePreview } = fileState;
  const { sidebarExplorerCreationKeyRef, sidebarFilePreviewLifecycleRef } =
    lifecycle;
  const {
    sidebarDesiredWorktreeId,
    sidebarExplorer,
    sidebarInlineExplorer,
    sidebarInlineExplorers,
    sidebarPreviewExplorer,
  } = model;
  const { createSidebarExplorerMutation } = mutations;
  const onlineWorkerIds = useMemo(
    () =>
      new Set(
        (workers ?? [])
          .filter(({ online }) => online)
          .map(({ workerId }) => workerId),
      ),
    [workers],
  );
  const {
    sidebarExplorerCreationInput,
    sidebarExplorerCreationKey,
    sidebarFileWorkerId,
    sidebarFileWorkerOnline,
    sidebarHasDesiredExplorer,
  } = sidebarExplorerProvisioningDetails({
    onlineWorkerIds,
    selectedProject,
    selectedProjectWorkerId,
    sidebarDesiredWorktreeId,
    sidebarExplorer,
    sidebarInlineExplorers,
  });
  useEffect(() => {
    if (
      isPopout ||
      !explorersIsSuccess ||
      !tabLayoutIsSuccess ||
      !sidebarExplorerCreationInput ||
      !sidebarExplorerCreationKey ||
      sidebarHasDesiredExplorer ||
      createSidebarExplorerMutation.isPending ||
      sidebarExplorerCreationKeyRef.current === sidebarExplorerCreationKey
    ) {
      return;
    }
    sidebarExplorerCreationKeyRef.current = sidebarExplorerCreationKey;
    createSidebarExplorerMutation.mutate(sidebarExplorerCreationInput);
  }, [
    createSidebarExplorerMutation,
    explorersIsSuccess,
    isPopout,
    sidebarExplorerCreationInput,
    sidebarExplorerCreationKey,
    sidebarHasDesiredExplorer,
    sidebarExplorerCreationKeyRef,
    tabLayoutIsSuccess,
  ]);
  useEffect(() => {
    if (
      sidebarFilePreview &&
      (sidebarFilePreview.projectId !== selectedProjectId ||
        (explorersIsSuccess && !sidebarPreviewExplorer))
    ) {
      sidebarFilePreviewLifecycleRef.current = null;
      setSidebarFilePreview(null);
    }
  }, [
    explorersIsSuccess,
    selectedProjectId,
    setSidebarFilePreview,
    sidebarFilePreview,
    sidebarFilePreviewLifecycleRef,
    sidebarPreviewExplorer,
  ]);
  return {
    onlineWorkerIds,
    sidebarExplorerCreationInput,
    sidebarExplorerCreationKey,
    sidebarFileWorkerId,
    sidebarFileWorkerOnline,
  } as const;
}
