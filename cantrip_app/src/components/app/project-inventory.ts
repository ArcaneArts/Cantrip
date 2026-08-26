import type {
  AppMode,
  ProjectFolderSetupJobSummary,
  ProjectReplicaJobSummary,
} from "@cantrip/protocol";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  cleanupArchivedChats,
  getArchivedStandaloneChats,
  getProjectFolderSetupJob,
  getProjectReplicaJobs,
  getServerBootstrap,
  getSettings,
  getStandaloneChats,
  getWorkers,
} from "@/lib/api";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";
import {
  latestProjectProvisionJob,
  projectListRefreshInterval,
  projectSetupJobRefreshInterval,
} from "@/lib/project-setup-progress";
import { getProjects } from "@/lib/project-encryption";
import { getProjectWorkspaces } from "@/lib/workspace-encryption";

export function useApplicationInventory({
  isPopout,
  projectResourcesLive,
}: {
  isPopout: boolean;
  projectResourcesLive: boolean;
}) {
  const queryClient = useQueryClient();
  const archiveCleanupRequestedRef = useRef(false);
  const appResourcesLoggedRef = useRef(false);
  const bootstrap = useQuery({
    queryFn: getServerBootstrap,
    queryKey: ["server-bootstrap"],
  });
  useEffect(() => {
    if (
      isPopout ||
      !bootstrap.isSuccess ||
      archiveCleanupRequestedRef.current
    ) {
      return;
    }
    archiveCleanupRequestedRef.current = true;
    const startedAt = performance.now();
    void cleanupArchivedChats()
      .then(({ deleted }) => {
        clientLogger.info("Archived chat cleanup completed", {
          counts: { deleted },
          durationMs: Math.round(performance.now() - startedAt),
          event: "archive.cleanup.completed",
          operation: "cleanup",
          status: "completed",
          subsystem: "archive",
        });
        if (deleted > 0) {
          void queryClient.invalidateQueries({ queryKey: ["archived-chats"] });
        }
      })
      .catch((error) => {
        clientLogger.warn("Archived chat cleanup failed", {
          durationMs: Math.round(performance.now() - startedAt),
          ...operationalErrorMetadata(error),
          event: "archive.cleanup.failed",
          operation: "cleanup",
          reasonCode: "request-failed",
          status: "failed",
          subsystem: "archive",
        });
      });
  }, [bootstrap.isSuccess, isPopout, queryClient]);
  const workers = useQuery({
    queryFn: getWorkers,
    queryKey: ["workers"],
    refetchInterval: projectResourcesLive ? false : 10_000,
  });
  const settings = useQuery({ queryFn: getSettings, queryKey: ["settings"] });
  return {
    appResourcesLoggedRef,
    bootstrap,
    settings,
    workers,
  } as const;
}

export type ApplicationInventory = ReturnType<typeof useApplicationInventory>;

export function useProjectInventory({
  appMode,
  foundation,
  isPopout,
  projectResourcesLive,
  selectedProjectId,
  selectedStandaloneChatId,
}: {
  appMode: AppMode | null;
  foundation: ApplicationInventory;
  isPopout: boolean;
  projectResourcesLive: boolean;
  selectedProjectId: string | null;
  selectedStandaloneChatId: string | null;
}) {
  const { appResourcesLoggedRef, bootstrap, settings, workers } = foundation;
  const projects = useQuery({
    queryFn: getProjects,
    queryKey: ["projects"],
    refetchInterval: (query) =>
      projectListRefreshInterval(projectResourcesLive, query.state.data),
  });
  const standaloneChats = useQuery({
    enabled: !isPopout,
    queryFn: getStandaloneChats,
    queryKey: ["standalone-chats"],
    refetchInterval: projectResourcesLive ? false : 10_000,
  });
  const archivedStandaloneChats = useQuery({
    enabled: !isPopout && appMode === "chat",
    queryFn: getArchivedStandaloneChats,
    queryKey: ["archived-standalone-chats"],
    refetchInterval: projectResourcesLive ? false : 30_000,
  });
  useEffect(() => {
    if (
      appResourcesLoggedRef.current ||
      !bootstrap.isSuccess ||
      !workers.isSuccess ||
      !settings.isSuccess ||
      !projects.isSuccess
    ) {
      return;
    }
    appResourcesLoggedRef.current = true;
    clientLogger.info("Cantrip application resources loaded", {
      counts: {
        projects: projects.data.length,
        workers: workers.data.length,
      },
      event: "client.resources.loaded",
      operation: "load-resources",
      status: "ready",
      subsystem: "bootstrap",
    });
  }, [
    appResourcesLoggedRef,
    bootstrap.isSuccess,
    projects.data,
    projects.isSuccess,
    settings.isSuccess,
    workers.data,
    workers.isSuccess,
  ]);
  const repositorySetupProjects = (projects.data ?? []).filter(
    (project) =>
      project.originKind === "github" &&
      (project.setupStatus === "cloning" || project.setupStatus === "failed"),
  );
  const projectSetupJobQueries = useQueries({
    queries: repositorySetupProjects.map((project) => ({
      queryFn: () => getProjectReplicaJobs(project.id),
      queryKey: ["project-replica-jobs", project.id],
      refetchInterval: projectSetupJobRefreshInterval(project.setupStatus),
    })),
  });
  const projectSetupJobs = new Map<string, ProjectReplicaJobSummary>();
  repositorySetupProjects.forEach((project, index) => {
    const job = latestProjectProvisionJob(projectSetupJobQueries[index]?.data);
    if (job) projectSetupJobs.set(project.id, job);
  });
  const folderSetupProjects = (projects.data ?? []).filter(
    (project) =>
      project.originKind === "managed-folder" &&
      project.setupStatus !== "ready",
  );
  const folderSetupJobQueries = useQueries({
    queries: folderSetupProjects.map((project) => ({
      queryFn: () => getProjectFolderSetupJob(project.id),
      queryKey: ["project-folder-setup", project.id],
      refetchInterval: projectSetupJobRefreshInterval(project.setupStatus),
      retry: false,
    })),
  });
  const folderSetupJobs = new Map<string, ProjectFolderSetupJobSummary>();
  folderSetupProjects.forEach((project, index) => {
    const job = folderSetupJobQueries[index]?.data;
    if (job) folderSetupJobs.set(project.id, job);
  });
  const projectWorkspaces = useQuery({
    queryFn: getProjectWorkspaces,
    queryKey: ["project-workspaces"],
  });
  const selectedProject = projects.data?.find(
    (project) => project.id === selectedProjectId,
  );
  const selectedStandaloneChat = standaloneChats.data?.find(
    (chat) => chat.id === selectedStandaloneChatId,
  );
  const standaloneChatWorkerAvailable = (workers.data ?? []).some(
    (worker) =>
      worker.online &&
      worker.standaloneChat.scratch.provision &&
      worker.standaloneChat.scratch.resolve &&
      worker.standaloneChat.scratch.remove,
  );
  const standaloneChatCreationUnavailableReason = !bootstrap.isSuccess
    ? "Checking standalone Chat availability…"
    : bootstrap.data.capabilities.standaloneChat.available === false
      ? (bootstrap.data.capabilities.standaloneChat.reason ??
        "Standalone Chat is unavailable on this server.")
      : !standaloneChatWorkerAvailable
        ? "Connect an online worker with standalone Chat scratch support first."
        : null;

  return {
    archivedStandaloneChats,
    folderSetupJobs,
    projectSetupJobs,
    projects,
    projectWorkspaces,
    selectedProject,
    selectedStandaloneChat,
    standaloneChatCreationAvailable:
      standaloneChatCreationUnavailableReason === null,
    standaloneChatCreationUnavailableReason,
    standaloneChatWorkerAvailable,
    standaloneChats,
  } as const;
}

export type ProjectInventory = ReturnType<typeof useProjectInventory>;
