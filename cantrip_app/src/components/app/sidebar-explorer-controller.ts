import {
  surfaceOsFilePlacement,
  sameOsFilePlacement,
  type OsFilePlacement,
} from "@/lib/os-file-placement";
import type {
  ChatSummary,
  ExplorerSummary,
  ProjectSummary,
  ProjectTabLayoutSummary,
  ProjectWorktreeSummary,
  RemoteDesktopSummary,
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
import { getCantripOsBindings } from "@/lib/api/cantrip-os";
import { projectFilePath } from "@/components/chat/markdown-file-link";
import { errorMessage as errorText } from "@/lib/error-message";
import type { ProjectSurface } from "@/lib/project-surface";
import {
  preferredSidebarExplorer,
  primaryWorktreeId,
  surfaceWorktreeId,
  tabbedExplorerIds,
} from "@/lib/sidebar-file-tabs";

type OpenCreatedTab = (
  projectId: string,
  kind: "explorer",
  tabId: string,
) => void;

export function useSidebarFileState() {
  const [explorerGraphRequest, setExplorerGraphRequest] =
    useState<ExplorerGraphRequest | null>(null);
  return {
    explorerGraphRequest,
    setExplorerGraphRequest,
  } as const;
}

export type SidebarFileState = ReturnType<typeof useSidebarFileState>;

export function useExplorerLifecycleRefs() {
  const explorerLifecycleRef = useRef(
    new Map<string, ExplorerLifecycleActions>(),
  );
  const sidebarExplorerCreationKeyRef = useRef<string | null>(null);
  return {
    explorerLifecycleRef,
    sidebarExplorerCreationKeyRef,
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
  const { explorerLifecycleRef } = lifecycle;
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
      cantripOsBindingId,
      cantripOsRuntimeGeneration,
    }: {
      projectId: string;
      worktreeId?: string;
      cantripOsBindingId?: string;
      cantripOsRuntimeGeneration?: string;
    }) =>
      createExplorer(
        projectId,
        "Project files",
        worktreeId,
        undefined,
        undefined,
        {
          attachToTabLayout: false,
          cantripOsBindingId,
          cantripOsRuntimeGeneration,
        },
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
  showAppToast,
  worktrees,
}: {
  openOwnedFile: (
    projectId: string,
    worktreeId: string,
    path: string,
    placement?: OsFilePlacement & { workerId?: string },
  ) => Promise<void>;
  queryClient: QueryClient;
  selectedProject: ProjectSummary | undefined;
  showAppToast: (toast: AppToastInput) => void;
  worktrees: ProjectWorktreeSummary[] | undefined;
}) {
  const openProjectExplorerFile = (
    projectId: string,
    worktreeId: string,
    path: string,
    placement?: OsFilePlacement & { workerId?: string },
  ) => {
    void (
      placement
        ? openOwnedFile(projectId, worktreeId, path, placement)
        : openOwnedFile(projectId, worktreeId, path)
    ).catch((error: unknown) =>
      showAppToast({
        title: "Could not open file",
        message: errorText(error),
        tone: "error",
      }),
    );
  };
  const openChatFileLink = (
    chat: ChatSummary,
    reference: string,
    messageWorktreeId?: string | null,
  ) => {
    const resolvedTarget = chat.cantripOsBindingId
      ? (async () => {
          const tree = messageWorktreeId ?? chat.activeWorktreeId;
          const binding = (await getCantripOsBindings(chat.projectId)).find(
            (item) =>
              item.id === chat.cantripOsBindingId && item.worktreeId === tree,
          );
          if (!binding) return null;
          const path = projectFilePath(reference, binding.guestPath);
          return path ? { path, worktreeId: tree } : null;
        })()
      : resolveChatFileReferenceTarget({
          reference,
          projectId: chat.projectId,
          activeWorktreeId: chat.activeWorktreeId,
          messageWorktreeId,
          source:
            selectedProject?.id === chat.projectId
              ? selectedProject.source
              : null,
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
        });
    void resolvedTarget
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
        return chat.cantripOsBindingId
          ? openOwnedFile(chat.projectId, resolved.worktreeId, resolved.path, {
              cantripOsBindingId: chat.cantripOsBindingId,
              cantripOsRuntimeGeneration: chat.cantripOsRuntimeGeneration,
              workerId: chat.activeWorkerId ?? undefined,
            })
          : openOwnedFile(chat.projectId, resolved.worktreeId, resolved.path);
      })
      .catch((error: unknown) =>
        showAppToast({
          title: "Could not open file link",
          message: errorText(error),
          tone: "error",
        }),
      );
  };
  return { openChatFileLink, openProjectExplorerFile } as const;
}

export function useSidebarExplorerModel({
  revealedWorktreeId,
  unavailablePaneIds,
  environment,
  explorers,
  openCreatedTab,
  selectedProjectId,
  selectedSurface,
  remoteDesktop,
  tabLayout,
  worktrees,
}: {
  revealedWorktreeId?: string;
  unavailablePaneIds: ReadonlySet<string>;
  environment: Pick<
    ShellEnvironment,
    "explorerFileTarget" | "popoutTarget" | "projectOverviewPopoutTarget"
  >;
  explorers: ExplorerSummary[] | undefined;
  openCreatedTab: OpenCreatedTab;
  selectedProjectId: string | null;
  selectedSurface: ProjectSurface | undefined;
  remoteDesktop?: RemoteDesktopSummary;
  tabLayout: ProjectTabLayoutSummary | undefined;
  worktrees: ProjectWorktreeSummary[] | undefined;
}) {
  const { explorerFileTarget, popoutTarget, projectOverviewPopoutTarget } =
    environment;
  const selectedWorktreeId = surfaceWorktreeId(selectedSurface, remoteDesktop);
  const sidebarDesiredWorktreeId =
    revealedWorktreeId ??
    selectedWorktreeId ??
    primaryWorktreeId(worktrees ?? []);
  const sidebarOsPlacement =
    revealedWorktreeId && revealedWorktreeId !== selectedWorktreeId
      ? {}
      : surfaceOsFilePlacement(selectedSurface, remoteDesktop);
  const sidebarDesiredWorkerId = sidebarOsPlacement?.cantripOsBindingId
    ? selectedSurface?.kind === "file"
      ? selectedSurface.entity.workerId
      : selectedSurface?.kind === "chat" ||
          selectedSurface?.kind === "explorer" ||
          selectedSurface?.kind === "terminal"
        ? selectedSurface.entity.activeWorkerId
        : selectedSurface?.kind === "remote-desktop"
          ? remoteDesktop?.workerId
          : null
    : null;
  const sidebarExplorer =
    sidebarOsPlacement === null
      ? null
      : preferredSidebarExplorer({
          desiredOsPlacement: sidebarOsPlacement,
          desiredWorktreeId: sidebarDesiredWorktreeId,
          explorers: explorers ?? [],
          layout: tabLayout,
        });
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
    sidebarOsPlacement,
    sidebarDesiredWorkerId,
    sidebarFileDestinationError:
      sidebarOsPlacement === null
        ? "The selected surface's file destination is unavailable."
        : null,
  } as const;
}

type SidebarExplorerModel = ReturnType<typeof useSidebarExplorerModel>;

export function sidebarExplorerProvisioningDetails({
  sidebarOsPlacement = {},
  sidebarDesiredWorkerId,
  onlineWorkerIds,
  selectedProject,
  selectedProjectWorkerId,
  sidebarDesiredWorktreeId,
  sidebarExplorer,
}: {
  sidebarOsPlacement?: OsFilePlacement | null;
  sidebarDesiredWorkerId?: string | null;
  onlineWorkerIds: ReadonlySet<string>;
  selectedProject: ProjectSummary | undefined;
  selectedProjectWorkerId: string | null;
  sidebarDesiredWorktreeId: string | null;
  sidebarExplorer: ExplorerSummary | null;
}) {
  const sidebarFileWorkerId =
    sidebarExplorer?.activeWorkerId ??
    sidebarDesiredWorkerId ??
    selectedProjectWorkerId;
  const sidebarFileWorkerOnline = Boolean(
    sidebarFileWorkerId && onlineWorkerIds.has(sidebarFileWorkerId),
  );
  const sidebarExplorerCreationInput =
    sidebarOsPlacement !== null &&
    selectedProject?.setupStatus === "ready" &&
    selectedProject.source &&
    (!selectedProject.capabilities.worktrees || sidebarDesiredWorktreeId)
      ? {
          projectId: selectedProject.id,
          ...sidebarOsPlacement,
          ...(sidebarDesiredWorktreeId
            ? { worktreeId: sidebarDesiredWorktreeId }
            : {}),
        }
      : null;
  const sidebarExplorerCreationKey = sidebarExplorerCreationInput
    ? `${sidebarExplorerCreationInput.projectId}:${sidebarExplorerCreationInput.worktreeId ?? "default"}${sidebarOsPlacement?.cantripOsBindingId ? `:${sidebarOsPlacement.cantripOsBindingId}:${sidebarOsPlacement.cantripOsRuntimeGeneration}` : ""}`
    : null;
  const sidebarHasDesiredExplorer = Boolean(
    sidebarExplorerCreationInput &&
    sidebarExplorer &&
    sidebarOsPlacement &&
    sameOsFilePlacement(sidebarExplorer, sidebarOsPlacement) &&
    (!sidebarDesiredWorktreeId ||
      sidebarExplorer.worktreeId === sidebarDesiredWorktreeId),
  );
  return {
    sidebarExplorerCreationInput,
    sidebarExplorerCreationKey,
    sidebarFileWorkerId,
    sidebarFileWorkerOnline,
    sidebarHasDesiredExplorer,
  } as const;
}

export function useSidebarExplorerProvisioning({
  visible = true,
  explorers,
  explorersIsSuccess,
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
  visible?: boolean;
  explorers: ExplorerSummary[] | undefined;
  explorersIsSuccess: boolean;
  isPopout: boolean;
  lifecycle: Pick<ExplorerLifecycleRefs, "sidebarExplorerCreationKeyRef">;
  model: Pick<
    SidebarExplorerModel,
    "sidebarDesiredWorktreeId" | "sidebarExplorer"
  > &
    Partial<
      Pick<
        SidebarExplorerModel,
        "sidebarOsPlacement" | "sidebarDesiredWorkerId"
      >
    >;
  mutations: Pick<SidebarExplorerMutations, "createSidebarExplorerMutation">;
  selectedProject: ProjectSummary | undefined;
  selectedProjectId: string | null;
  selectedProjectWorkerId: string | null;
  tabLayoutIsSuccess: boolean;
  workers: WorkerSummary[] | undefined;
}) {
  const { sidebarExplorerCreationKeyRef } = lifecycle;
  const {
    sidebarDesiredWorktreeId,
    sidebarExplorer,
    sidebarOsPlacement,
    sidebarDesiredWorkerId,
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
    sidebarOsPlacement,
    sidebarDesiredWorkerId,
  });
  useEffect(() => {
    if (
      !visible ||
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
    visible,
    isPopout,
    sidebarExplorerCreationInput,
    sidebarExplorerCreationKey,
    sidebarHasDesiredExplorer,
    sidebarExplorerCreationKeyRef,
    tabLayoutIsSuccess,
  ]);
  return {
    onlineWorkerIds,
    sidebarExplorerCreationInput,
    sidebarExplorerCreationKey,
    sidebarFileWorkerId,
    sidebarFileWorkerOnline,
  } as const;
}
