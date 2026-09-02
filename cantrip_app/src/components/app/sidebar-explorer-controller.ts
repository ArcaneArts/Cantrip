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
  getProjectTabLayout,
  getProjectWorktreeStatus,
  pinExplorer,
  updateExplorerViewState,
} from "@/lib/api";
import { clientLogger } from "@/lib/client-log-relay";
import { openDesktopExplorerFile } from "@/lib/desktop-popout";
import { errorMessage as errorText } from "@/lib/error-message";
import { explorerFileIntentContext } from "@/lib/explorer-lifecycle-trace";
import type { ProjectSurface } from "@/lib/project-surface";
import {
  dedicatedSidebarExplorers,
  preferredSidebarExplorer,
  primaryWorktreeId,
  SIDEBAR_EXPLORER_POOL_SIZE,
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

export type SidebarFilePinCompletion =
  | { action: "wait" }
  | {
      action: "activate";
      clearPreview: boolean;
      destination: ExplorerSummary;
    }
  | { action: "refresh"; destination: ExplorerSummary };

export function sidebarFilePinCompletion(
  handoff: SidebarFilePinHandoffState,
  preview: SidebarFilePreviewState | null,
  selectedProjectId: string | null,
): SidebarFilePinCompletion {
  const destination = handoff.destinationExplorer;
  if (!destination) return { action: "wait" };
  if (selectedProjectId !== destination.projectId) {
    return { action: "refresh", destination };
  }
  return {
    action: "activate",
    clearPreview: Boolean(
      preview?.explorerId === handoff.sourceExplorer.id &&
      preview.path === handoff.sourcePath,
    ),
    destination,
  };
}

export function useSidebarFileState() {
  const [sidebarFilePreview, setSidebarFilePreview] =
    useState<SidebarFilePreviewState | null>(null);
  const [sidebarFilePinHandoff, setSidebarFilePinHandoff] =
    useState<SidebarFilePinHandoffState | null>(null);
  const sidebarFilePinHandoffRef = useRef(sidebarFilePinHandoff);
  sidebarFilePinHandoffRef.current = sidebarFilePinHandoff;
  const sidebarExplorerPoolRef = useRef<readonly ExplorerSummary[]>([]);
  const sidebarSuccessorWaitersRef = useRef(new Set<() => void>());
  const notifySidebarSuccessorWaiters = useCallback(() => {
    for (const waiter of sidebarSuccessorWaitersRef.current) waiter();
  }, []);
  const updateSidebarExplorerPool = useCallback(
    (pool: readonly ExplorerSummary[]) => {
      sidebarExplorerPoolRef.current = pool.slice(
        0,
        SIDEBAR_EXPLORER_POOL_SIZE,
      );
      notifySidebarSuccessorWaiters();
    },
    [notifySidebarSuccessorWaiters],
  );
  const waitForSidebarFileSuccessor = useCallback(
    (
      sourceExplorerId: string,
      timeoutMs = SIDEBAR_FILE_PIN_HANDOFF_TIMEOUT_MS,
    ): Promise<ExplorerSummary | null> => {
      const availableSuccessor = () =>
        sidebarExplorerPoolRef.current.find(
          ({ id }) => id !== sourceExplorerId,
        ) ?? null;
      const immediate = availableSuccessor();
      if (immediate) return Promise.resolve(immediate);
      return new Promise((resolve) => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout>;
        let check: () => void;
        const finish = (successor: ExplorerSummary | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          sidebarSuccessorWaitersRef.current.delete(check);
          resolve(successor);
        };
        check = () => {
          const successor = availableSuccessor();
          if (successor) finish(successor);
        };
        timeout = setTimeout(() => finish(null), timeoutMs);
        sidebarSuccessorWaitersRef.current.add(check);
        check();
      });
    },
    [],
  );
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
    updateSidebarExplorerPool,
    waitForSidebarFileSuccessor,
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
      transactionId,
    }: {
      destinationExplorerId: string;
      groupId: string | null;
      path: string;
      transactionId: string;
    }) => {
      clientLogger.info("Explorer file pin mutation started", {
        ...explorerFileIntentContext(destinationExplorerId),
        event: "explorer.file.pin.phase",
        explorerId: destinationExplorerId,
        operation: "pin-file",
        phase: "mutation-started",
        status: "started",
        subsystem: "explorer",
        transactionId,
      });
      const explorer = await pinExplorer(
        destinationExplorerId,
        sidebarFileName(path),
        {
          fileMode: defaultExplorerFileMode(path),
          selectedPath: path,
        },
        groupId ?? undefined,
      );
      clientLogger.info("Explorer file pin mutation updated surface", {
        ...explorerFileIntentContext(destinationExplorerId),
        event: "explorer.file.pin.phase",
        explorerId: destinationExplorerId,
        operation: "pin-file",
        phase: "surface-pinned",
        projectId: explorer.projectId,
        samePath: explorer.selectedPath === path,
        status: "completed",
        subsystem: "explorer",
        transactionId,
        worktreeId: explorer.worktreeId,
      });
      const layout = await getProjectTabLayout(explorer.projectId);
      return { explorer, layout };
    },
    onSuccess: ({ explorer, layout }, input) => {
      queryClient.setQueryData<ExplorerSummary[]>(
        ["explorers", explorer.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== explorer.id), explorer].sort(
            (left, right) => left.position - right.position,
          ),
      );
      queryClient.setQueryData<ProjectTabLayoutSummary>(
        ["project-tab-layout", explorer.projectId],
        layout,
      );
      const handoff = sidebarFilePinHandoffRef.current;
      if (!handoff || handoff.transactionId !== input.transactionId) {
        return;
      }
      const expectedFileMode = defaultExplorerFileMode(input.path);
      if (
        explorer.id !== input.destinationExplorerId ||
        explorer.selectedPath !== input.path ||
        explorer.fileMode !== expectedFileMode
      ) {
        clientLogger.warn("Explorer file pin mutation returned invalid state", {
          ...explorerFileIntentContext(input.destinationExplorerId),
          event: "explorer.file.pin.phase",
          explorerId: input.destinationExplorerId,
          operation: "pin-file",
          phase: "mutation-validation",
          projectId: explorer.projectId,
          reasonCode: "destination-state-mismatch",
          samePath: explorer.selectedPath === input.path,
          status: "failed",
          subsystem: "explorer",
          transactionId: input.transactionId,
          worktreeId: explorer.worktreeId,
        });
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
      // This Explorer is now a tab. Permit the creation effect to replenish
      // the bounded pool with a retained, prewarmed successor.
      sidebarExplorerCreationKeyRef.current = null;
      sidebarFilePinHandoffRef.current = nextHandoff;
      setSidebarFilePinHandoff(nextHandoff);
      clientLogger.info("Explorer file pin handoff destination ready", {
        ...explorerFileIntentContext(explorer.id),
        event: "explorer.file.pin.phase",
        explorerId: explorer.id,
        operation: "pin-file",
        phase: "destination-ready",
        projectId: explorer.projectId,
        ready: true,
        status: "completed",
        subsystem: "explorer",
        transactionId: input.transactionId,
        worktreeId: explorer.worktreeId,
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
      clientLogger.warn("Explorer file pin mutation failed", {
        ...explorerFileIntentContext(input.destinationExplorerId),
        errorClass: error instanceof Error ? error.name : typeof error,
        event: "explorer.file.pin.phase",
        explorerId: input.destinationExplorerId,
        operation: "pin-file",
        phase: "mutation",
        reasonCode: "mutation-failed",
        status: "failed",
        subsystem: "explorer",
        transactionId: input.transactionId,
      });
      setPopoutError(errorText(error));
    },
  });
  return { createSidebarExplorerMutation, pinSidebarFileMutation } as const;
}

export type SidebarExplorerMutations = ReturnType<
  typeof useSidebarExplorerMutations
>;

const PROTECTED_PATH_UNAVAILABLE = "Protected path unavailable";

export async function resolveChatFileReferencePath({
  reference,
  sourcePath,
  worktreePath,
  refreshWorktreePath,
}: {
  reference: string;
  sourcePath: string | null;
  worktreePath: string | null;
  refreshWorktreePath(): Promise<string | null>;
}): Promise<{ path: string; refreshedWorktreePath: string | null } | null> {
  const relative = projectFilePath(reference, null);
  if (relative) return { path: relative, refreshedWorktreePath: null };
  for (const root of [worktreePath, sourcePath]) {
    if (!root || root === PROTECTED_PATH_UNAVAILABLE) continue;
    const path = projectFilePath(reference, root);
    if (path) return { path, refreshedWorktreePath: null };
  }
  const refreshedWorktreePath = await refreshWorktreePath().catch(() => null);
  if (!refreshedWorktreePath) return null;
  const path = projectFilePath(reference, refreshedWorktreePath);
  return path ? { path, refreshedWorktreePath } : null;
}

export function createProjectExplorerFileOpening({
  codeAppearance,
  desktopRuntime,
  explorers,
  explorerLifecycleRef,
  openCreatedTab,
  openSidebarFilePreviewPath,
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
  openSidebarFilePreviewPath?: (worktreeId: string, path: string) => boolean;
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
    void resolveChatFileReferencePath({
      reference,
      sourcePath:
        selectedProject?.id === chat.projectId
          ? (selectedProject.source?.path ?? null)
          : null,
      worktreePath: worktree?.path ?? null,
      refreshWorktreePath: async () => {
        const refreshed = await getProjectWorktreeStatus(
          chat.projectId,
          chat.activeWorktreeId,
        );
        queryClient.setQueryData<ProjectWorktreeSummary[]>(
          ["worktrees", chat.projectId],
          (current = []) =>
            current.map((candidate) =>
              candidate.id === chat.activeWorktreeId
                ? {
                    ...candidate,
                    path: refreshed.worktree.path,
                    displayPath: refreshed.worktree.path,
                  }
                : candidate,
            ),
        );
        return refreshed.worktree.path;
      },
    })
      .then((resolved) => {
        if (!resolved) {
          showAppToast({
            message:
              "The worker could not resolve this link inside the active project folder.",
            title: "Could not open file link",
            tone: "error",
          });
          return;
        }
        if (
          openSidebarFilePreviewPath?.(chat.activeWorktreeId, resolved.path)
        ) {
          return;
        }
        openProjectExplorerFile(
          chat.projectId,
          chat.activeWorktreeId,
          resolved.path,
        );
      })
      .catch((error: unknown) => setPopoutError(errorText(error)));
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
      clientLogger.info("Explorer file pin handoff completion evaluated", {
        ...explorerFileIntentContext(explorerId),
        event: "explorer.file.pin.phase",
        explorerId,
        operation: "pin-file",
        phase: "completion-evaluated",
        projectId: handoff.sourceExplorer.projectId,
        ready: readyHandoff.ready,
        status: "completed",
        subsystem: "explorer",
        transactionId: handoff.transactionId,
        worktreeId: handoff.sourceExplorer.worktreeId,
      });
      const completion = sidebarFilePinCompletion(
        readyHandoff,
        sidebarFilePreviewRef.current,
        selectedProjectIdRef.current,
      );
      if (completion.action === "wait") return;
      if (completion.action === "activate") {
        if (completion.clearPreview) {
          sidebarFilePreviewLifecycleRef.current = null;
          sidebarFilePreviewRef.current = null;
          setSidebarFilePreview(null);
        }
        clientLogger.info("Explorer file pin handoff activated destination", {
          ...explorerFileIntentContext(explorerId),
          event: "explorer.file.pin.phase",
          explorerId,
          operation: "pin-file",
          phase: "destination-activated",
          projectId: completion.destination.projectId,
          status: "completed",
          subsystem: "explorer",
          transactionId: handoff.transactionId,
          worktreeId: completion.destination.worktreeId,
        });
        openCreatedTabRef.current(
          completion.destination.projectId,
          "explorer",
          completion.destination.id,
        );
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", completion.destination.projectId],
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
    clientLogger.info("Explorer file pin handoff ownership settled", {
      ...explorerFileIntentContext(sidebarFilePinHandoff.destinationExplorerId),
      event: "explorer.file.pin.phase",
      explorerId: sidebarFilePinHandoff.destinationExplorerId,
      operation: "pin-file",
      phase: "handoff-cleared",
      projectId: sidebarFilePinHandoff.sourceExplorer.projectId,
      status: "completed",
      subsystem: "explorer",
      transactionId: sidebarFilePinHandoff.transactionId,
      worktreeId: sidebarFilePinHandoff.sourceExplorer.worktreeId,
    });
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
    "setSidebarFilePreview" | "sidebarFilePreview" | "updateSidebarExplorerPool"
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
  const {
    setSidebarFilePreview,
    sidebarFilePreview,
    updateSidebarExplorerPool,
  } = fileState;
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
    updateSidebarExplorerPool(sidebarInlineExplorers);
  }, [sidebarInlineExplorers, updateSidebarExplorerPool]);
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
