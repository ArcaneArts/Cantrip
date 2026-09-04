import type { ProjectSummary, WorkerSummary } from "@cantrip/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import type { WorktreeStatusMap } from "@/components/worktrees/worktree-control";
import {
  getBrowsers,
  getChats,
  getCodeTabs,
  getExplorers,
  getProjectRepositoryStats,
  getProjectSurfaceLaunchers,
  getProjectTabLayout,
  getProjectTokenUsage,
  getProjectViews,
  getProjectWorktrees,
  getProjectWorktreeStatus,
  getRemoteDesktop,
  getTerminals,
} from "@/lib/api";
import { clientLogger } from "@/lib/client-log-relay";
import {
  listRunConfigurationRuntimes,
  listRunConfigurations,
} from "@/lib/run-configuration-api";
import { installRunConfigurationFocusRecovery } from "@/lib/run-configuration-focus-recovery";
import type { ProjectOverviewSection } from "@/lib/project-overview-section";

export function useProjectWorkspaceResources({
  activeProjectOverviewSection,
  projectOverviewSelected,
  projectResourcesLive,
  projects,
  queryClient,
  selectedProject,
  selectedProjectId,
  selectedProjectViewId,
  workers,
}: {
  activeProjectOverviewSection: ProjectOverviewSection;
  projectOverviewSelected: boolean;
  projectResourcesLive: boolean;
  projects: ProjectSummary[] | undefined;
  queryClient: QueryClient;
  selectedProject: ProjectSummary | undefined;
  selectedProjectId: string | null;
  selectedProjectViewId: string | null;
  workers: WorkerSummary[] | undefined;
}) {
  const projectResourcesLoggedRef = useRef<string | null>(null);
  const tabLayout = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getProjectTabLayout(selectedProjectId!),
    queryKey: ["project-tab-layout", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 10_000,
  });
  const surfaceLaunchers = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getProjectSurfaceLaunchers(selectedProjectId!),
    queryKey: ["project-surface-launchers", selectedProjectId],
  });
  const worktrees = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () =>
      getProjectWorktrees(selectedProjectId!, {
        onStatus: (worktreeId, result) => {
          queryClient.setQueryData(
            ["worktree-status", selectedProjectId!, worktreeId],
            result.status,
          );
        },
      }),
    queryKey: ["worktrees", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 15_000,
  });
  const worktreeStatusQueries = useQueries({
    queries: (worktrees.data ?? []).map((worktree) => ({
      enabled:
        worktree.rootKind === "git-worktree" &&
        worktree.lifecycleState === "ready",
      queryFn: () =>
        getProjectWorktreeStatus(worktree.projectId, worktree.id).then(
          ({ status }) => status,
        ),
      queryKey: ["worktree-status", worktree.projectId, worktree.id],
      refetchInterval:
        projectResourcesLive ||
        !workers?.find(({ workerId }) => workerId === worktree.workerId)?.online
          ? false
          : 15_000,
      retry: false,
      staleTime: 15_000,
    })),
  });
  const worktreeStatuses = useMemo<WorktreeStatusMap>(
    () =>
      Object.fromEntries(
        (worktrees.data ?? []).map((worktree, index) => [
          worktree.id,
          worktreeStatusQueries[index]?.data,
        ]),
      ),
    [worktreeStatusQueries, worktrees.data],
  );
  const chats = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getChats(selectedProjectId!),
    queryKey: ["chats", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 10_000,
  });
  const terminals = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getTerminals(selectedProjectId!),
    queryKey: ["terminals", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 10_000,
  });
  const runConfigurations = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => listRunConfigurations(selectedProjectId!),
    queryKey: ["run-configurations", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 10_000,
    retry: false,
  });
  const runConfigurationRuntimes = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => listRunConfigurationRuntimes(selectedProjectId!),
    queryKey: ["run-configuration-runtimes", selectedProjectId],
    refetchInterval: (query) =>
      projectResourcesLive
        ? false
        : query.state.data?.some((runtime) =>
              ["starting", "running", "restarting", "stopping"].includes(
                runtime.state,
              ),
            )
          ? 1_000
          : 10_000,
    retry: false,
  });
  useEffect(() => {
    if (!selectedProjectId) return;
    return installRunConfigurationFocusRecovery(
      queryClient,
      selectedProjectId,
      { document, window },
    );
  }, [queryClient, selectedProjectId]);
  const explorers = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getExplorers(selectedProjectId!),
    queryKey: ["explorers", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 10_000,
  });
  const browsers = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getBrowsers(selectedProjectId!),
    queryKey: ["browsers", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 10_000,
  });
  const codeTabs = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getCodeTabs(selectedProjectId!),
    queryKey: ["code-tabs", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 10_000,
  });
  const projectViews = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getProjectViews(selectedProjectId!),
    queryKey: ["project-views", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 10_000,
  });
  useEffect(() => {
    if (!selectedProjectId) {
      projectResourcesLoggedRef.current = null;
      return;
    }
    if (
      projectResourcesLoggedRef.current === selectedProjectId ||
      !tabLayout.isSuccess ||
      (selectedProject?.capabilities.worktrees && !worktrees.isSuccess) ||
      !chats.isSuccess ||
      !terminals.isSuccess ||
      !explorers.isSuccess ||
      !browsers.isSuccess ||
      !codeTabs.isSuccess ||
      !projectViews.isSuccess
    ) {
      return;
    }
    projectResourcesLoggedRef.current = selectedProjectId;
    clientLogger.info("Project surfaces loaded", {
      counts: {
        browsers: browsers.data.length,
        chats: chats.data.length,
        codeTabs: codeTabs.data.length,
        explorers: explorers.data.length,
        panes: tabLayout.data.panes.length,
        terminals: terminals.data.length,
        views: projectViews.data.length,
        worktrees: (worktrees.data ?? []).length,
      },
      event: "project.resources.loaded",
      operation: "load-project",
      projectId: selectedProjectId,
      status: "ready",
      subsystem: "projects",
    });
  }, [
    browsers.data,
    browsers.isSuccess,
    chats.data,
    chats.isSuccess,
    codeTabs.data,
    codeTabs.isSuccess,
    explorers.data,
    explorers.isSuccess,
    projectViews.data,
    projectViews.isSuccess,
    selectedProjectId,
    selectedProject?.capabilities.worktrees,
    tabLayout.data,
    tabLayout.isSuccess,
    terminals.data,
    terminals.isSuccess,
    worktrees.data,
    worktrees.isSuccess,
  ]);
  const repositoryStats = useQuery({
    enabled:
      Boolean(selectedProjectId) &&
      projectOverviewSelected &&
      activeProjectOverviewSection === "overview" &&
      Boolean(
        projects?.some(
          (project) =>
            project.id === selectedProjectId &&
            project.setupStatus === "ready" &&
            project.source,
        ),
      ),
    queryFn: () => getProjectRepositoryStats(selectedProjectId!),
    queryKey: ["project-repository-stats", selectedProjectId],
    retry: false,
    staleTime: 30_000,
  });
  const projectTokenUsage = useQuery({
    enabled:
      Boolean(selectedProjectId) &&
      projectOverviewSelected &&
      activeProjectOverviewSection === "overview",
    queryFn: () => getProjectTokenUsage(selectedProjectId!),
    queryKey: ["project-token-usage", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 15_000,
    staleTime: 10_000,
  });
  const selectedProjectViewForQuery = projectViews.data?.find(
    (view) => view.id === selectedProjectViewId,
  );
  const remoteDesktop = useQuery({
    enabled: selectedProjectViewForQuery?.kind === "remote-desktop",
    queryFn: () => getRemoteDesktop(selectedProjectViewId!),
    queryKey: ["remote-desktop", selectedProjectViewId],
    refetchInterval: projectResourcesLive ? false : 10_000,
  });

  return {
    browsers,
    chats,
    codeTabs,
    explorers,
    projectTokenUsage,
    projectViews,
    remoteDesktop,
    repositoryStats,
    runConfigurationRuntimes,
    runConfigurations,
    surfaceLaunchers,
    tabLayout,
    terminals,
    worktreeStatuses,
    worktrees,
  } as const;
}

export type ProjectWorkspaceResources = ReturnType<
  typeof useProjectWorkspaceResources
>;
