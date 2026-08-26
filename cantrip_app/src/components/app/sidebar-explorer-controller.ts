import type {
  ChatSummary,
  CodeAppearance,
  ExplorerEntry,
  ExplorerSummary,
  ProjectSummary,
  ProjectTabLayoutSummary,
  ProjectWorktreeSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import { useMutation, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  SIDEBAR_FILE_PIN_HANDOFF_TIMEOUT_MS,
  type SidebarFilePinHandoffState,
} from "@/components/app/application-shell-model";
import type { ShellEnvironment } from "@/components/app/shell-environment";
import { projectFilePath } from "@/components/chat/markdown-file-link";
import { defaultExplorerFileMode } from "@/components/explorer/explorer-file-language";
import type {
  ExplorerGraphRequest,
  ExplorerLifecycleActions,
} from "@/components/explorer/explorer-view";
import type { AppToastInput } from "@/components/ui/app-toast";
import {
  createExplorer,
  pinExplorer,
  updateExplorerViewState,
} from "@/lib/api";
import { openDesktopExplorerFile } from "@/lib/desktop-popout";
import { errorMessage as errorText } from "@/lib/error-message";
import type { ProjectSurface } from "@/lib/project-surface";
import {
  dedicatedSidebarExplorer,
  preferredSidebarExplorer,
  primaryWorktreeId,
  sidebarFileName,
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
  const [sidebarFilePinHandoff, setSidebarFilePinHandoff] =
    useState<SidebarFilePinHandoffState | null>(null);
  const sidebarFilePinHandoffRef = useRef(sidebarFilePinHandoff);
  sidebarFilePinHandoffRef.current = sidebarFilePinHandoff;
  const [explorerGraphRequest, setExplorerGraphRequest] =
    useState<ExplorerGraphRequest | null>(null);
  return {
    explorerGraphRequest,
    setExplorerGraphRequest,
    setSidebarFilePinHandoff,
    setSidebarFilePreview,
    sidebarFilePinHandoff,
    sidebarFilePinHandoffRef,
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
  codeAppearance,
  lifecycle,
  queryClient,
}: {
  codeAppearance: CodeAppearance;
  lifecycle: ExplorerLifecycleRefs;
  queryClient: QueryClient;
}) {
  const { explorerLifecycleRef, sidebarFilePreviewLifecycleRef } = lifecycle;
  const handleExplorerLifecycleChange = useCallback(
    (explorerId: string, actions: ExplorerLifecycleActions | null) => {
      if (actions) explorerLifecycleRef.current.set(explorerId, actions);
      else explorerLifecycleRef.current.delete(explorerId);
    },
    [explorerLifecycleRef],
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
  const openExplorerFileWindow = useCallback(
    async (explorer: ExplorerSummary, entry: ExplorerEntry) => {
      await openDesktopExplorerFile(
        {
          explorerId: explorer.id,
          path: entry.path,
          projectId: explorer.projectId,
        },
        entry.name,
        { appearance: codeAppearance, explorer },
      );
    },
    [codeAppearance],
  );
  return {
    handleExplorerChanged,
    handleExplorerLifecycleChange,
    handleSidebarFilePreviewLifecycleChange,
    openExplorerFileWindow,
  } as const;
}

export function useSidebarExplorerMutations({
  fileState,
  lifecycle,
  queryClient,
  setPopoutError,
}: {
  fileState: Pick<
    SidebarFileState,
    "setSidebarFilePinHandoff" | "sidebarFilePinHandoffRef"
  >;
  lifecycle: Pick<ExplorerLifecycleRefs, "sidebarExplorerCreationKeyRef">;
  queryClient: QueryClient;
  setPopoutError: (error: string | null) => void;
}) {
  const { setSidebarFilePinHandoff, sidebarFilePinHandoffRef } = fileState;
  const { sidebarExplorerCreationKeyRef } = lifecycle;
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
    onError: (_error, input) => {
      sidebarExplorerCreationKeyRef.current = `${input.projectId}:${input.worktreeId ?? "default"}`;
    },
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
  const pinSidebarFileMutation = useMutation({
    mutationFn: async ({
      destinationExplorerId,
      groupId,
      path,
    }: {
      destinationExplorerId: string;
      groupId: string | null;
      path: string;
      transactionId: string;
    }) => {
      return pinExplorer(
        destinationExplorerId,
        sidebarFileName(path),
        {
          fileMode: defaultExplorerFileMode(path),
          selectedPath: path,
        },
        groupId ?? undefined,
      );
    },
    onSuccess: (explorer, input) => {
      const handoff = sidebarFilePinHandoffRef.current;
      if (!handoff || handoff.transactionId !== input.transactionId) {
        void queryClient.invalidateQueries({
          queryKey: ["explorers", explorer.projectId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["project-tab-layout", explorer.projectId],
        });
        return;
      }
      const expectedFileMode = defaultExplorerFileMode(input.path);
      if (
        explorer.id !== input.destinationExplorerId ||
        explorer.selectedPath !== input.path ||
        explorer.fileMode !== expectedFileMode
      ) {
        sidebarFilePinHandoffRef.current = null;
        setSidebarFilePinHandoff(null);
        void queryClient.invalidateQueries({
          queryKey: ["explorers", explorer.projectId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["project-tab-layout", explorer.projectId],
        });
        setPopoutError(
          "The pinned Explorer did not preserve the requested file state.",
        );
        return;
      }
      const nextHandoff = {
        ...handoff,
        destinationExplorer: explorer,
        ready: true,
      };
      // This Explorer is now a tab. Permit the creation effect to provision
      // and prewarm the next dedicated sidebar Explorer for this worktree.
      sidebarExplorerCreationKeyRef.current = null;
      sidebarFilePinHandoffRef.current = nextHandoff;
      setSidebarFilePinHandoff(nextHandoff);
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
      void queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", explorer.projectId],
      });
    },
    onError: (error, input) => {
      const handoff = sidebarFilePinHandoffRef.current;
      if (handoff?.transactionId === input.transactionId) {
        sidebarFilePinHandoffRef.current = null;
        setSidebarFilePinHandoff(null);
        void queryClient.invalidateQueries({
          queryKey: ["explorers", handoff.sourceExplorer.projectId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["project-tab-layout", handoff.sourceExplorer.projectId],
        });
      }
      setPopoutError(errorText(error));
    },
  });
  return { createSidebarExplorerMutation, pinSidebarFileMutation } as const;
}

export type SidebarExplorerMutations = ReturnType<
  typeof useSidebarExplorerMutations
>;

export function createProjectExplorerFileOpening({
  codeAppearance,
  desktopRuntime,
  explorers,
  explorerLifecycleRef,
  openCreatedTab,
  queryClient,
  selectedProject,
  setPopoutError,
  showAppToast,
  worktrees,
}: {
  codeAppearance: CodeAppearance;
  desktopRuntime: boolean;
  explorers: ExplorerSummary[] | undefined;
  explorerLifecycleRef: ExplorerLifecycleRefs["explorerLifecycleRef"];
  openCreatedTab: OpenCreatedTab;
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
    void (async () => {
      let explorer = (explorers ?? []).find(
        (candidate) =>
          candidate.worktreeId === worktreeId &&
          (desktopRuntime ||
            !explorerLifecycleRef.current.get(candidate.id)?.dirty),
      );
      if (!explorer) {
        const created = await createExplorer(projectId, "Explorer", worktreeId);
        explorer = created;
        queryClient.setQueryData<ExplorerSummary[]>(
          ["explorers", created.projectId],
          (current = []) =>
            [
              ...current.filter((candidate) => candidate.id !== created.id),
              created,
            ].sort((left, right) => left.position - right.position),
        );
        void queryClient.invalidateQueries({
          queryKey: ["explorers", created.projectId],
        });
      }
      if (desktopRuntime) {
        await openDesktopExplorerFile(
          {
            explorerId: explorer.id,
            path,
            projectId: explorer.projectId,
          },
          path.split("/").at(-1) ?? path,
          { appearance: codeAppearance, explorer },
        );
        return;
      }
      const updated = await updateExplorerViewState(explorer.id, {
        fileMode: defaultExplorerFileMode(path),
        selectedPath: path,
      });
      queryClient.setQueryData<ExplorerSummary[]>(
        ["explorers", updated.projectId],
        (current = []) =>
          current.map((candidate) =>
            candidate.id === updated.id ? updated : candidate,
          ),
      );
      openCreatedTab(updated.projectId, "explorer", updated.id);
    })().catch((error: unknown) => setPopoutError(errorText(error)));
  };
  const openChatFileLink = (chat: ChatSummary, reference: string) => {
    const worktree = (worktrees ?? []).find(
      (candidate) => candidate.id === chat.activeWorktreeId,
    );
    const projectRoot =
      worktree?.path ??
      (selectedProject?.id === chat.projectId
        ? selectedProject.source?.path
        : null);
    const path = projectRoot ? projectFilePath(reference, projectRoot) : null;
    if (!projectRoot || !path) {
      showAppToast({
        message: projectRoot
          ? "The link points outside the active project folder."
          : "The active worktree is not available.",
        title: "Could not open file link",
        tone: "error",
      });
      return;
    }
    openProjectExplorerFile(chat.projectId, chat.activeWorktreeId, path);
  };
  return { openChatFileLink, openProjectExplorerFile } as const;
}

export function useSidebarExplorerModel({
  detachedGroupId,
  environment,
  explorers,
  fileState,
  openCreatedTab,
  selectedProjectId,
  selectedSurface,
  tabLayout,
  worktrees,
}: {
  detachedGroupId: string | null;
  environment: Pick<
    ShellEnvironment,
    "explorerFileTarget" | "popoutTarget" | "projectOverviewPopoutTarget"
  >;
  explorers: ExplorerSummary[] | undefined;
  fileState: Pick<
    SidebarFileState,
    "sidebarFilePinHandoff" | "sidebarFilePreview"
  >;
  openCreatedTab: OpenCreatedTab;
  selectedProjectId: string | null;
  selectedSurface: ProjectSurface | undefined;
  tabLayout: ProjectTabLayoutSummary | undefined;
  worktrees: ProjectWorktreeSummary[] | undefined;
}) {
  const { explorerFileTarget, popoutTarget, projectOverviewPopoutTarget } =
    environment;
  const { sidebarFilePinHandoff, sidebarFilePreview } = fileState;
  const sidebarDesiredWorktreeId =
    surfaceWorktreeId(selectedSurface) ?? primaryWorktreeId(worktrees ?? []);
  const queriedSidebarPreviewExplorer = sidebarFilePreview
    ? (explorers?.find(
        (explorer) => explorer.id === sidebarFilePreview.explorerId,
      ) ?? null)
    : null;
  const sidebarPreviewExplorer =
    queriedSidebarPreviewExplorer ??
    (sidebarFilePreview &&
    sidebarFilePinHandoff?.sourceExplorer.id ===
      sidebarFilePreview.explorerId &&
    sidebarFilePinHandoff.sourcePath === sidebarFilePreview.path
      ? sidebarFilePinHandoff.sourceExplorer
      : null);
  const sidebarExplorer = preferredSidebarExplorer({
    desiredWorktreeId: sidebarDesiredWorktreeId,
    explorers: explorers ?? [],
    layout: tabLayout,
    previewExplorerId: sidebarFilePreview?.active
      ? sidebarFilePreview.explorerId
      : null,
  });
  // The active preview already owns its warm workbench. Keep a different
  // unpinned Explorer warm so promoting this preview never makes the next
  // file click pay for a fresh embedded workbench.
  const sidebarInlineExplorer = dedicatedSidebarExplorer({
    desiredWorktreeId: sidebarDesiredWorktreeId,
    excludeExplorerId: sidebarFilePreview?.explorerId,
    explorers: explorers ?? [],
    layout: tabLayout,
  });
  const connectedExplorerGroupIds = useMemo(() => {
    if (projectOverviewPopoutTarget || explorerFileTarget) {
      return new Set<string>();
    }
    if (popoutTarget) return new Set([popoutTarget.groupId]);
    return new Set(
      tabLayout?.groups
        .filter(({ id }) => id !== detachedGroupId)
        .map(({ id }) => id) ?? [],
    );
  }, [
    detachedGroupId,
    explorerFileTarget,
    popoutTarget,
    projectOverviewPopoutTarget,
    tabLayout,
  ]);
  const openExplorerIds = useMemo(
    () => tabbedExplorerIds(tabLayout, connectedExplorerGroupIds),
    [connectedExplorerGroupIds, tabLayout],
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
  sidebarInlineExplorer,
  sidebarPreviewExplorerId,
}: {
  onlineWorkerIds: ReadonlySet<string>;
  selectedProject: ProjectSummary | undefined;
  selectedProjectWorkerId: string | null;
  sidebarDesiredWorktreeId: string | null;
  sidebarExplorer: ExplorerSummary | null;
  sidebarInlineExplorer: ExplorerSummary | null;
  sidebarPreviewExplorerId?: string | null;
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
  // A preview consumes the primary slot, so its reserve is a distinct
  // provisioning generation even though the worktree is unchanged.
  const sidebarExplorerCreationKey = sidebarExplorerCreationInput
    ? `${sidebarExplorerCreationInput.projectId}:${sidebarExplorerCreationInput.worktreeId ?? "default"}${
        sidebarPreviewExplorerId ? `:reserve:${sidebarPreviewExplorerId}` : ""
      }`
    : null;
  const sidebarHasDesiredExplorer = Boolean(
    sidebarExplorerCreationInput && sidebarInlineExplorer,
  );
  return {
    sidebarExplorerCreationInput,
    sidebarExplorerCreationKey,
    sidebarFileWorkerId,
    sidebarFileWorkerOnline,
    sidebarHasDesiredExplorer,
  } as const;
}

export function useSidebarFilePinHandoffLifecycle({
  fileState,
  lifecycle,
  model,
  queryClient,
  selectedProjectId,
  setPopoutError,
}: {
  fileState: Pick<
    SidebarFileState,
    | "setSidebarFilePinHandoff"
    | "setSidebarFilePreview"
    | "sidebarFilePinHandoff"
    | "sidebarFilePinHandoffRef"
  >;
  lifecycle: Pick<ExplorerLifecycleRefs, "sidebarFilePreviewLifecycleRef">;
  model: Pick<
    SidebarExplorerModel,
    | "openCreatedTabRef"
    | "openExplorerIds"
    | "selectedProjectIdRef"
    | "sidebarFilePreviewRef"
  >;
  queryClient: QueryClient;
  selectedProjectId: string | null;
  setPopoutError: (error: string | null) => void;
}) {
  const {
    setSidebarFilePinHandoff,
    setSidebarFilePreview,
    sidebarFilePinHandoff,
    sidebarFilePinHandoffRef,
  } = fileState;
  const { sidebarFilePreviewLifecycleRef } = lifecycle;
  const {
    openCreatedTabRef,
    openExplorerIds,
    selectedProjectIdRef,
    sidebarFilePreviewRef,
  } = model;
  const abandonSidebarFilePinHandoff = useCallback(
    (handoff: SidebarFilePinHandoffState, message?: string) => {
      if (
        sidebarFilePinHandoffRef.current?.transactionId !==
        handoff.transactionId
      ) {
        return;
      }
      sidebarFilePinHandoffRef.current = null;
      setSidebarFilePinHandoff(null);
      void queryClient.invalidateQueries({
        queryKey: ["explorers", handoff.sourceExplorer.projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", handoff.sourceExplorer.projectId],
      });
      if (message) setPopoutError(message);
    },
    [
      queryClient,
      setPopoutError,
      setSidebarFilePinHandoff,
      sidebarFilePinHandoffRef,
    ],
  );
  const completeSidebarFilePinHandoff = useCallback(
    (explorerId: string) => {
      const handoff = sidebarFilePinHandoffRef.current;
      if (!handoff || handoff.destinationExplorerId !== explorerId) return;
      const readyHandoff = handoff.ready
        ? handoff
        : { ...handoff, ready: true };
      if (!handoff.ready) {
        sidebarFilePinHandoffRef.current = readyHandoff;
        setSidebarFilePinHandoff(readyHandoff);
      }
      const destination = readyHandoff.destinationExplorer;
      if (!destination) return;
      const preview = sidebarFilePreviewRef.current;
      if (
        preview?.active &&
        selectedProjectIdRef.current === destination.projectId &&
        preview.explorerId === readyHandoff.sourceExplorer.id &&
        preview.path === readyHandoff.sourcePath
      ) {
        sidebarFilePreviewLifecycleRef.current = null;
        sidebarFilePreviewRef.current = null;
        setSidebarFilePreview(null);
        openCreatedTabRef.current(
          destination.projectId,
          "explorer",
          destination.id,
        );
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", destination.projectId],
      });
    },
    [
      openCreatedTabRef,
      queryClient,
      selectedProjectIdRef,
      setSidebarFilePinHandoff,
      setSidebarFilePreview,
      sidebarFilePinHandoffRef,
      sidebarFilePreviewLifecycleRef,
      sidebarFilePreviewRef,
    ],
  );
  useEffect(() => {
    if (!sidebarFilePinHandoff) return;
    if (sidebarFilePinHandoff.sourceExplorer.projectId === selectedProjectId) {
      return;
    }
    abandonSidebarFilePinHandoff(sidebarFilePinHandoff);
  }, [abandonSidebarFilePinHandoff, selectedProjectId, sidebarFilePinHandoff]);
  useEffect(() => {
    if (
      !sidebarFilePinHandoff ||
      (sidebarFilePinHandoff.ready && sidebarFilePinHandoff.destinationExplorer)
    ) {
      return;
    }
    const timeout = setTimeout(() => {
      abandonSidebarFilePinHandoff(
        sidebarFilePinHandoff,
        "The file could not be pinned before the request timed out.",
      );
    }, SIDEBAR_FILE_PIN_HANDOFF_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [
    abandonSidebarFilePinHandoff,
    sidebarFilePinHandoff,
    sidebarFilePinHandoff?.destinationExplorerId,
    sidebarFilePinHandoff?.ready,
  ]);
  useEffect(() => {
    if (
      !sidebarFilePinHandoff?.ready ||
      !sidebarFilePinHandoff.destinationExplorer
    ) {
      return;
    }
    completeSidebarFilePinHandoff(sidebarFilePinHandoff.destinationExplorerId);
  }, [
    completeSidebarFilePinHandoff,
    sidebarFilePinHandoff?.destinationExplorer,
    sidebarFilePinHandoff?.destinationExplorerId,
    sidebarFilePinHandoff?.ready,
  ]);
  useEffect(() => {
    if (
      !sidebarFilePinHandoff?.ready ||
      !sidebarFilePinHandoff.destinationExplorer ||
      !openExplorerIds.has(sidebarFilePinHandoff.destinationExplorerId)
    ) {
      return;
    }
    sidebarFilePinHandoffRef.current = null;
    setSidebarFilePinHandoff(null);
  }, [
    openExplorerIds,
    setSidebarFilePinHandoff,
    sidebarFilePinHandoff,
    sidebarFilePinHandoffRef,
  ]);
  return {
    abandonSidebarFilePinHandoff,
    completeSidebarFilePinHandoff,
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
    sidebarInlineExplorer,
    sidebarPreviewExplorerId: sidebarFilePreview?.explorerId,
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
