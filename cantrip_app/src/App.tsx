import type {
  AgentInteractionResponse,
  BrowserSummary,
  BrowserFleetService,
  ChatAttachmentSummary,
  ChatMessage,
  ChatPlanAnswer,
  ChatRelocationJobSummary,
  ChatSummary,
  ChatTurnMode,
  CodeAppearance,
  CodeTabSummary,
  ExecutionTarget,
  ExplorerEntry,
  ExplorerSummary,
  GithubRepository,
  ModelProfileSummary,
  ProjectReplicaJobSummary,
  ProjectSummary,
  ProjectTabLayoutSummary,
  ProjectWorkspaceSummary,
  ProjectWorktreeCreate,
  ProjectWorktreeSummary,
  ProjectViewKind,
  ProjectViewSummary,
  QueuedPrompt,
  ReasoningEffort,
  RemoteDesktopTarget,
  SettingsBundle,
  SkillSummary,
  TerminalSummary,
  TunnelSummary,
} from "@cantrip/protocol";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ArrowDown,
  Bot,
  Check,
  CircleAlert,
  Code2,
  Copy,
  ExternalLink,
  FolderGit2,
  FolderTree,
  GitFork,
  GitBranch,
  Globe2,
  Loader2,
  Lock,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Plus,
  RefreshCw,
  Settings,
  SquareTerminal,
  User,
  WandSparkles,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { Activity, ActivityGroup } from "@/components/chat/activity";
import {
  AttachmentPreview,
  AttachmentViewerDialog,
} from "@/components/chat/attachment-preview";
import {
  attachmentKind,
  insertComposerText,
  MAX_ATTACHMENT_BYTES,
  MAX_COMPOSER_ATTACHMENTS,
  largePasteFileName,
  shouldAttachPastedText,
} from "@/components/chat/attachment-utils";
import { AgentInteractionPanel } from "@/components/chat/agent-interaction-panel";
import {
  AgentInspectContent,
  agentInspectorActive,
} from "@/components/chat/agent-inspect-content";
import {
  AgentInspectPanelShell,
  readAgentInspectWidth,
  updateAgentInspectOpenChats,
} from "@/components/chat/agent-inspect-panel";
import { useStickyChatScroll } from "@/components/chat/use-sticky-chat-scroll";
import { CustomizationPanel } from "@/components/chat/customization-panel";
import { GoalPanel } from "@/components/chat/goal-panel";
import { ChatModeControl } from "@/components/chat/chat-mode-control";
import { ChatComposerPrimaryActions } from "@/components/chat/chat-composer-primary-actions";
import { ChatRunStatus } from "@/components/chat/chat-run-status";
import { ModelReasoningPicker } from "@/components/chat/model-reasoning-picker";
import { PermissionProfileControl } from "@/components/chat/permission-profile-control";
import {
  activeChatRelocationJob,
  ChatRelocationDialog,
  ChatRelocationStatus,
  isChatRelocationActive,
  latestChatRelocationJob,
} from "@/components/chat/chat-relocation-dialog";
import { PlanPanel } from "@/components/chat/plan-panel";
import { Markdown } from "@/components/chat/markdown";
import {
  filterCommandPalette,
  type CommandPaletteSuggestion,
} from "@/components/chat/command-palette";
import { PromptQueue } from "@/components/chat/prompt-queue";
import type { CodeHeaderState } from "@/components/code/code-view";
import {
  activeSkillMention,
  filterSkills,
  insertSkillMention,
  skillMentionSegments,
} from "@/components/chat/skill-mentions";
import {
  buildChatTimeline,
  formatTurnMetadata,
} from "@/components/chat/timeline";
import {
  slashCommandQuery,
  type SlashCommandSuggestion,
} from "@/components/chat/slash-commands";
import {
  GitHistoryView,
  type GitHistoryHeaderState,
} from "@/components/git/git-history";
import { ExplorerFilePopout } from "@/components/explorer/explorer-file-popout";
import type {
  ExplorerHeaderState,
  ExplorerLifecycleActions,
} from "@/components/explorer/explorer-view";
import {
  confirmExplorerDiscard,
  prepareExplorerPopout as prepareExplorerPopoutLifecycle,
  prepareExplorerRebind as prepareExplorerRebindLifecycle,
} from "@/components/explorer/explorer-lifecycle";
import { ProjectChatList } from "@/components/sidebar/project-chat-list";
import { ProjectTabBar } from "@/components/workspace/project-tab-bar";
import type { ProjectSurfaceCreateKind } from "@/components/workspace/project-surface-create-menu";
import type { ProjectSurfacePlacementContext } from "@/components/workspace/project-surface-create-menu";
import {
  ContentHeaderActions,
  ExplorerFileCloseButton,
  type ContentHeaderActionsProps,
} from "@/components/workspace/content-header-actions";
import { WorkspaceDndProvider } from "@/components/workspace/workspace-dnd-provider";
import { WorkspaceMembershipPicker } from "@/components/workspaces/workspace-membership-picker";
import { WorkspaceSwitcher } from "@/components/workspaces/workspace-switcher";
import { MobileBottomNavigation } from "@/components/mobile/mobile-bottom-navigation";
import { MobileProjectHeader } from "@/components/mobile/mobile-project-header";
import { MobileProjectSelector } from "@/components/mobile/mobile-project-selector";
import { MobileProjectTabGrid } from "@/components/mobile/mobile-project-tab-grid";
import { ProjectSettingsPage } from "@/components/projects/project-settings-page";
import { ProjectOverview } from "@/components/projects/project-overview";
import { taskChatIsInspectOnly } from "@/components/tasks/task-chat-access";
import { GithubRepositoryCreateDialog } from "@/components/projects/github-repository-create-dialog";
import {
  SettingsPage,
  type SettingsSection,
} from "@/components/settings/settings-page";
import { ServerAdminPage } from "@/components/servers/server-admin-page";
import { ServerSwitcher } from "@/components/servers/server-switcher";
import {
  WorktreeControl,
  WorktreeCreateDialog,
  type WorktreeStatusMap,
} from "@/components/worktrees/worktree-control";
import { hasScrolledContent } from "@/lib/scroll-divider";
import { errorMessage as errorText } from "@/lib/error-message";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";
import { githubRepositoryOnboardingAction } from "@/lib/github-repository-onboarding";
import {
  assignMobileBottomTab,
  initialMobileBottomTabs,
  mobileBottomTabConfiguration,
  mobileBottomTabsFromConfiguration,
  PRIMARY_MOBILE_BOTTOM_TAB_ID,
  projectSelectionAction,
  reconcileMobileBottomTabs,
  removeMobileBottomTab,
} from "@/lib/mobile-navigation";
import {
  shouldUseCompactLayout,
  shouldUseDesktopSidebarDrawer,
  useNarrowViewport,
} from "@/lib/use-compact-layout";
import { useAppLiveScope, useAppLiveStatus } from "@/lib/app-live-react";
import {
  chatResourceRefreshIntervalMs,
  chatTranscriptNeedsFastRefresh,
} from "@/lib/chat-resource-refresh";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  createBrowser,
  createCodeTab,
  chatAttachmentContentUrl,
  answerChatPlan,
  createChat,
  createTask,
  createChatConsole,
  createExplorer,
  createGithubProject,
  createProjectWorktree,
  createProjectView,
  createProjectWorkspace,
  createRemoteDesktop,
  createTerminal,
  compactChat,
  clearChatGoal,
  cleanupArchivedChats,
  deleteChat,
  deleteChatAttachment,
  deleteBrowser,
  deleteCodeTab,
  deleteExplorer,
  deleteProjectView,
  deleteTerminal,
  deleteQueuedPrompt,
  forkChat,
  getChats,
  getChatGoal,
  getChatPermissionProfiles,
  getChatPlan,
  getChatReasoning,
  getChatRelocations,
  getBrowsers,
  getCodeTabs,
  getCachedGithubRepositories,
  getExplorers,
  getGithubRepositories,
  getGithubStatus,
  getMessages,
  getAgentInteractionRequests,
  getProjects,
  getProjectReplicaJobs,
  getProjectWorkspaces,
  getProjectTabLayout,
  getProjectWorktrees,
  getProjectWorktreeStatus,
  getProjectViews,
  getProjectRepositoryStats,
  getProjectTokenUsage,
  getRemoteDesktop,
  getQueuedPrompts,
  getServerBootstrap,
  getSettings,
  getSkills,
  getTask,
  getTerminals,
  getWorkers,
  getWorkflows,
  getWorkflowAutomationTriggers,
  invokeSavedWorkflowCommand,
  interruptChat,
  renameChat,
  renameExplorer,
  renameProjectView,
  renameTerminal,
  removeProject,
  moveProjectTabGroupMember,
  reorderProjectTabGroupMembers,
  reorderProjectTabGroups,
  reorderProjects,
  reorderQueuedPrompts,
  respondToAgentInteractionRequest,
  setChatPaused,
  startTurn,
  steerQueuedPrompt,
  syncChat,
  updateChatModel,
  updateChatPermissionProfile,
  updateChatGoal,
  updateChatReasoning,
  updateChatWorktree,
  updateBrowser,
  updateCodeTab,
  updateCodeTabWorktree,
  updateExplorerWorktree,
  updateProjectViewWorktree,
  updateQueuedPrompt,
  updateSettings,
  updateTerminalWorktree,
  uploadChatAttachment,
} from "@/lib/api";
import {
  closeCurrentDesktopWindow,
  desktopPopoutTitlebarLeftInset,
  focusDesktopPopoutGroup,
  isDesktopRuntime,
  isMacosDesktopRuntime,
  openDesktopExplorerFile,
  openDesktopPopoutGroup,
  parseDesktopExplorerFileTarget,
  parseDesktopPopoutGroupTarget,
  shouldUseOverlayTitlebar,
  updateDesktopWindowTheme,
  updateMacosProMode,
  updateDesktopWindowTitle,
  watchDesktopPopoutGroup,
} from "@/lib/desktop-popout";
import {
  desktopProjectRevealLabel,
  revealProjectInNativeFileManager,
} from "@/lib/desktop-project-share";
import { browserUpdateForPageState } from "@/lib/browser-page-state";
import { scopedClientStorageKey } from "@/lib/client-session";
import { useDesktopDirectTransportTelemetry } from "@/lib/direct-transport-telemetry";
import {
  buildProjectSurfaceIndex,
  type ProjectSurface,
  projectSurfaceTabId,
  projectSurfaceTabKey,
} from "@/lib/project-surface";
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  sidebarWidthFromKey,
  sidebarWidthFromPointer,
} from "@/lib/sidebar-resize";
import { cn } from "@/lib/utils";
import {
  applyOptimisticTabLayoutToCache,
  restoreOptimisticTabLayoutCache,
} from "@/lib/project-tab-layout-optimistic";
import {
  projectsInWorkspace,
  resolveProjectWorkspace,
} from "@/lib/project-workspaces";
import {
  latestProjectProvisionJob,
  projectSetupPercent,
} from "@/lib/project-setup-progress";
import type {
  TabLayoutCommand,
  WorkspaceDropOperation,
} from "@/lib/workspace-dnd-model";
import {
  emptyWorkspaceSelection,
  reconcileWorkspaceSelection,
  selectedWorkspaceTabKey,
  selectWorkspaceGroup,
  selectWorkspaceOverview,
  selectWorkspaceTab,
} from "@/lib/workspace-selection";

function modelDisplayName(model: ModelProfileSummary): string {
  const routeCount = model.routes.filter((route) => route.enabled).length;
  return `${model.name}${routeCount > 1 ? ` · Auto (${routeCount} routes)` : ""}`;
}

function codeAppearanceFor(
  dark: boolean,
  highContrast: boolean,
  proMode: boolean,
): CodeAppearance {
  if (proMode) {
    if (highContrast) {
      return dark ? "pro-high-contrast-dark" : "pro-high-contrast-light";
    }
    return dark ? "pro-dark" : "pro-light";
  }
  if (highContrast) {
    return dark ? "high-contrast-dark" : "high-contrast-light";
  }
  return dark ? "dark" : "light";
}

const TerminalView = lazy(() =>
  import("@/components/terminal/terminal-view").then((module) => ({
    default: module.TerminalView,
  })),
);
const PersistentExplorerViews = lazy(() =>
  import("@/components/explorer/persistent-explorer-views").then((module) => ({
    default: module.PersistentExplorerViews,
  })),
);
const BrowserView = lazy(() =>
  import("@/components/browser/browser-view").then((module) => ({
    default: module.BrowserView,
  })),
);
const PersistentCodeViews = lazy(() =>
  import("@/components/code/persistent-code-views").then((module) => ({
    default: module.PersistentCodeViews,
  })),
);
const PersistentTaskViews = lazy(() =>
  import("@/components/tasks/persistent-task-views").then((module) => ({
    default: module.PersistentTaskViews,
  })),
);
const RemoteDesktopView = lazy(() =>
  import("@/components/remote-desktop/remote-desktop-view").then((module) => ({
    default: module.RemoteDesktopView,
  })),
);

type WorktreeBindingTarget =
  | {
      kind: "chat";
      projectId: string;
      tabId: string;
      mode: "agent-managed" | "pinned";
    }
  | {
      kind: "code" | "explorer" | "history" | "terminal";
      projectId: string;
      tabId: string;
    };

interface ComposerAttachmentState {
  attachment: ChatAttachmentSummary;
  contentUrl: string;
  error: string | null;
  localPreview: boolean;
  uploading: boolean;
}

function MessageContent({ message }: { message: ChatMessage }) {
  const [viewingAttachment, setViewingAttachment] =
    useState<ChatAttachmentSummary | null>(null);
  return (
    <>
      <div className="min-w-0 max-w-full space-y-3">
        {message.content.map((item, index) =>
          item.type === "text" ? (
            item.phase === "commentary" ? (
              <div key={`text:${index}`} className="text-muted-foreground">
                <Markdown>{item.text}</Markdown>
              </div>
            ) : (
              <Markdown key={`text:${index}`}>{item.text}</Markdown>
            )
          ) : item.type === "attachment" ? (
            <AttachmentPreview
              key={`attachment:${item.attachment.id}`}
              attachment={item.attachment}
              contentUrl={chatAttachmentContentUrl(item.attachment.id)}
              onOpen={() => setViewingAttachment(item.attachment)}
            />
          ) : (
            <Activity
              key={`activity:${item.activity.id}`}
              activity={item.activity}
            />
          ),
        )}
      </div>
      <AttachmentViewerDialog
        attachment={viewingAttachment}
        contentUrl={
          viewingAttachment
            ? chatAttachmentContentUrl(viewingAttachment.id)
            : null
        }
        open={viewingAttachment !== null}
        onOpenChange={(open) => {
          if (!open) setViewingAttachment(null);
        }}
      />
    </>
  );
}

function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      className={cn(
        "size-2 rounded-full",
        online ? "bg-emerald-500" : "bg-muted-foreground/40",
      )}
    />
  );
}

function RepositoryImporter({
  activeWorkspaceId,
  onCreatedProject,
  projectSetupJobs,
  projects,
  workerId,
  workspaces,
}: {
  activeWorkspaceId: string | null;
  onCreatedProject(project: ProjectSummary): void;
  projectSetupJobs: ReadonlyMap<string, ProjectReplicaJobSummary>;
  projects: ProjectSummary[];
  workerId: string | null;
  workspaces: ProjectWorkspaceSummary[];
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [createRepositoryOpen, setCreateRepositoryOpen] = useState(false);
  const [pendingRepositoryIds, setPendingRepositoryIds] = useState<Set<string>>(
    new Set(),
  );
  const pendingRepositoryIdsRef = useRef(new Set<string>());
  const [importErrors, setImportErrors] = useState<Map<string, string>>(
    new Map(),
  );
  const [selectedWorkspaceIds, setSelectedWorkspaceIds] = useState(
    () => new Set(activeWorkspaceId ? [activeWorkspaceId] : []),
  );
  useEffect(() => {
    setSelectedWorkspaceIds(
      new Set(activeWorkspaceId ? [activeWorkspaceId] : []),
    );
  }, [activeWorkspaceId]);
  const github = useQuery({
    enabled: Boolean(workerId),
    queryFn: () => getGithubStatus(workerId!),
    queryKey: ["github-status", workerId],
  });
  const repositories = useQuery({
    enabled: Boolean(workerId && github.data?.authenticated),
    queryFn: () => getGithubRepositories(workerId!),
    queryKey: ["github-repositories", workerId],
  });
  const cachedRepositories = useQuery({
    enabled: Boolean(
      workerId && github.data?.authenticated && github.data.login,
    ),
    queryFn: () => getCachedGithubRepositories(workerId!, github.data!.login!),
    queryKey: ["github-repositories-cache", workerId, github.data?.login],
    staleTime: 30_000,
  });
  const importRepository = async (repository: GithubRepository) => {
    if (
      !workerId ||
      !activeWorkspaceId ||
      pendingRepositoryIdsRef.current.has(repository.id)
    )
      throw new Error("The repository cannot be added right now.");
    pendingRepositoryIdsRef.current.add(repository.id);
    setPendingRepositoryIds(new Set(pendingRepositoryIdsRef.current));
    setImportErrors((current) => {
      const next = new Map(current);
      next.delete(repository.id);
      return next;
    });

    const workspaceIds = new Set(selectedWorkspaceIds);
    workspaceIds.add(activeWorkspaceId);
    try {
      const project = await createGithubProject({
        workerId,
        repositoryId: repository.id,
        nameWithOwner: repository.nameWithOwner,
        url: repository.url,
        workspaceIds: [...workspaceIds],
      });
      queryClient.setQueryData<ProjectSummary[]>(["projects"], (current = []) =>
        [...current.filter((item) => item.id !== project.id), project].sort(
          (left, right) => left.position - right.position,
        ),
      );
      queryClient.setQueryData<ProjectWorkspaceSummary[]>(
        ["project-workspaces"],
        (current) =>
          current?.map((workspace) =>
            workspaceIds.has(workspace.id) &&
            !workspace.projectIds.includes(project.id)
              ? {
                  ...workspace,
                  projectIds: [...workspace.projectIds, project.id],
                }
              : workspace,
          ),
      );
      const markImported = (queryKey: readonly unknown[]) =>
        queryClient.setQueryData<GithubRepository[]>(queryKey, (current) =>
          current?.map((item) =>
            item.id === repository.id ? { ...item, imported: true } : item,
          ),
        );
      markImported(["github-repositories", workerId]);
      if (github.data?.login) {
        markImported([
          "github-repositories-cache",
          workerId,
          github.data.login,
        ]);
      }
      void queryClient.invalidateQueries({
        queryKey: ["project-workspaces"],
      });
      return project;
    } catch (error) {
      setImportErrors((current) =>
        new Map(current).set(repository.id, errorText(error)),
      );
      throw error;
    } finally {
      pendingRepositoryIdsRef.current.delete(repository.id);
      setPendingRepositoryIds(new Set(pendingRepositoryIdsRef.current));
    }
  };
  const queueImport = (repository: GithubRepository) => {
    void importRepository(repository).catch(() => undefined);
  };
  const rememberRepository = (repository: GithubRepository) => {
    const addRepository = (queryKey: readonly unknown[]) =>
      queryClient.setQueryData<GithubRepository[]>(queryKey, (current = []) => [
        repository,
        ...current.filter((item) => item.id !== repository.id),
      ]);
    addRepository(["github-repositories", workerId]);
    if (github.data?.login) {
      addRepository(["github-repositories-cache", workerId, github.data.login]);
    }
  };

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (repositories.data ?? cachedRepositories.data ?? []).filter(
      (repository) =>
        needle
          ? `${repository.nameWithOwner} ${repository.description ?? ""}`
              .toLowerCase()
              .includes(needle)
          : true,
    );
  }, [cachedRepositories.data, repositories.data, search]);
  const hasRepositoryData = Boolean(
    repositories.data || cachedRepositories.data?.length,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex w-full flex-1 flex-col gap-4 overflow-hidden p-5 sm:p-8">
        {!workerId ? (
          <Card>
            <CardHeader>
              <CardTitle>No worker available</CardTitle>
              <CardDescription>
                Start the local worker before importing a repository.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : github.isLoading && !github.data ? (
          <div className="grid flex-1 place-items-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : !github.data?.authenticated ? (
          <Card>
            <CardHeader>
              <div className="mb-2 grid size-10 place-items-center rounded-lg border">
                <GitBranch className="size-5" />
              </div>
              <CardTitle>Connect GitHub on the worker</CardTitle>
              <CardDescription className="max-w-xl leading-6">
                For the local MVP, Cantrip reuses GitHub CLI authentication. Run{" "}
                <code className="rounded bg-muted px-1.5 py-0.5">
                  gh auth login
                </code>{" "}
                or start the worker with a fine-grained token in{" "}
                <code className="rounded bg-muted px-1.5 py-0.5">GH_TOKEN</code>
                . The credential never enters the browser or server database.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={() => void github.refetch()}>
                <RefreshCw className="size-4" />
                Check again
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <GitBranch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search repositories"
                  className="h-10 w-full rounded-md border bg-background pl-10 pr-3 text-sm outline-none ring-ring focus:ring-2"
                />
              </div>
              <div className="flex items-center justify-between gap-2 sm:justify-end">
                <Badge variant="secondary" className="gap-2 px-3 py-2">
                  <StatusDot online />@{github.data.login}
                </Badge>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {filtered.length} repositories
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={repositories.isFetching}
                  onClick={() => void repositories.refetch()}
                >
                  <RefreshCw
                    className={cn(
                      "size-4",
                      repositories.isFetching && "animate-spin",
                    )}
                  />
                  {repositories.isFetching ? "Refreshing" : "Refresh"}
                </Button>
              </div>
            </div>

            {activeWorkspaceId ? (
              <WorkspaceMembershipPicker
                requiredWorkspaceId={activeWorkspaceId}
                selectedIds={selectedWorkspaceIds}
                trailingAction={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setCreateRepositoryOpen(true)}
                  >
                    <Plus className="size-3.5" />
                    Repository
                  </Button>
                }
                workspaces={workspaces}
                onChange={setSelectedWorkspaceIds}
              />
            ) : null}

            {!hasRepositoryData &&
            (repositories.isLoading || cachedRepositories.isLoading) ? (
              <div className="grid flex-1 place-items-center text-muted-foreground">
                <div className="flex items-center gap-2 text-sm">
                  <Loader2 className="size-4 animate-spin" />
                  Loading repositories…
                </div>
              </div>
            ) : repositories.isError && !hasRepositoryData ? (
              <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                {errorText(repositories.error)}
              </p>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto rounded-xl border bg-card/20">
                <table className="w-full table-fixed border-collapse text-left text-sm">
                  <thead
                    data-slot="table-header-surface"
                    className="sticky top-0 z-10 bg-background/95 text-[11px] uppercase tracking-wide text-muted-foreground backdrop-blur-xl"
                  >
                    <tr className="border-b">
                      <th className="w-[42%] px-3 py-2 font-medium sm:w-[34%]">
                        Repository
                      </th>
                      <th className="hidden w-[34%] px-3 py-2 font-medium md:table-cell">
                        Description
                      </th>
                      <th className="hidden w-24 px-3 py-2 font-medium sm:table-cell">
                        Type
                      </th>
                      <th className="hidden w-28 px-3 py-2 font-medium lg:table-cell">
                        Updated
                      </th>
                      <th className="w-24 px-3 py-2 text-right font-medium">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((repository) => {
                      const project = projects.find(
                        (candidate) =>
                          candidate.github?.repositoryId === repository.id,
                      );
                      const importing =
                        pendingRepositoryIds.has(repository.id) ||
                        project?.setupStatus === "cloning";
                      const failed = project?.setupStatus === "failed";
                      const setupJob = project
                        ? projectSetupJobs.get(project.id)
                        : undefined;
                      const disabled = Boolean(
                        !activeWorkspaceId ||
                        repository.imported ||
                        project ||
                        importing,
                      );
                      const importError =
                        project?.setupError ?? importErrors.get(repository.id);
                      return (
                        <tr
                          key={repository.id}
                          role="button"
                          tabIndex={disabled ? -1 : 0}
                          aria-disabled={disabled}
                          title={importError}
                          onClick={() => {
                            if (!disabled) queueImport(repository);
                          }}
                          onKeyDown={(event) => {
                            if (
                              !disabled &&
                              (event.key === "Enter" || event.key === " ")
                            ) {
                              event.preventDefault();
                              queueImport(repository);
                            }
                          }}
                          className={cn(
                            "h-10 outline-none odd:bg-muted/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                            disabled
                              ? "cursor-default text-muted-foreground"
                              : "cursor-pointer hover:bg-muted/40",
                          )}
                        >
                          <td className="px-3 py-1.5">
                            <div className="flex min-w-0 items-center gap-2">
                              {repository.isPrivate ? (
                                <Lock className="size-3.5 shrink-0" />
                              ) : repository.isFork ? (
                                <GitFork className="size-3.5 shrink-0" />
                              ) : (
                                <FolderGit2 className="size-3.5 shrink-0" />
                              )}
                              <span className="truncate font-medium">
                                {repository.nameWithOwner}
                              </span>
                            </div>
                          </td>
                          <td className="hidden truncate px-3 py-1.5 text-xs text-muted-foreground md:table-cell">
                            {repository.description ?? "No description"}
                          </td>
                          <td className="hidden px-3 py-1.5 text-xs text-muted-foreground sm:table-cell">
                            {repository.isPrivate
                              ? "Private"
                              : repository.isFork
                                ? "Fork"
                                : "Public"}
                          </td>
                          <td className="hidden whitespace-nowrap px-3 py-1.5 text-xs text-muted-foreground lg:table-cell">
                            {new Date(repository.updatedAt).toLocaleDateString(
                              undefined,
                              {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              },
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-right text-xs">
                            <span className="inline-flex items-center justify-end gap-1.5">
                              {failed ? (
                                <CircleAlert className="size-3.5 text-destructive" />
                              ) : importing ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : repository.imported ? (
                                <Check className="size-3.5" />
                              ) : (
                                <Plus className="size-3.5" />
                              )}
                              {failed
                                ? "Failed"
                                : importing
                                  ? setupJob
                                    ? `${setupJob.progress.percent}%`
                                    : "Starting"
                                  : repository.imported
                                    ? "Added"
                                    : "Add"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {filtered.length === 0 ? (
                  <div className="grid min-h-40 place-items-center p-8 text-center text-sm text-muted-foreground">
                    No matching repositories.
                  </div>
                ) : null}
              </div>
            )}

            {repositories.isError && hasRepositoryData ? (
              <p className="text-xs text-destructive">
                Refresh failed; showing the last cached repository list.{" "}
                {errorText(repositories.error)}
              </p>
            ) : null}

            {importErrors.size > 0 ? (
              <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {Array.from(importErrors.values()).at(-1)}
              </p>
            ) : null}

            <GithubRepositoryCreateDialog
              login={github.data.login!}
              open={createRepositoryOpen}
              workerId={workerId}
              onOpenChange={setCreateRepositoryOpen}
              onCreated={async (repository) => {
                rememberRepository(repository);
                try {
                  const project = await importRepository(repository);
                  onCreatedProject(project);
                } catch {
                  // The new repository remains in the list so Add can be retried.
                }
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

function ChatTranscript({
  chat,
  inspectOnly = false,
  inspectOpen,
  inspectOverlay,
  onCreateChat,
  onDelete,
  onForked,
  onInspectOpenChange,
  onOpenWorkflow,
  onRename,
  onOpenRelocation,
  relocationJob,
  settings,
  syncEnabled,
}: {
  chat: ChatSummary;
  inspectOnly?: boolean;
  inspectOpen: boolean;
  inspectOverlay: boolean;
  onCreateChat(): void;
  onDelete(): void;
  onForked(chat: ChatSummary): void;
  onInspectOpenChange(open: boolean): void;
  onOpenWorkflow(workflowId: string): void;
  onRename(title: string): void;
  onOpenRelocation(): void;
  relocationJob: ChatRelocationJobSummary | null;
  settings: SettingsBundle | undefined;
  syncEnabled: boolean;
}) {
  const queryClient = useQueryClient();
  const liveStatus = useAppLiveStatus();
  const chatResourcesLive = liveStatus === "live";
  const relocationActive = isChatRelocationActive(relocationJob);
  const relocationNeedsAttention =
    relocationJob?.state === "blocked" || relocationJob?.state === "failed";
  const inspectActive = agentInspectorActive(chat.status);
  const chatRefreshInterval = chatResourceRefreshIntervalMs(
    chat.status,
    chatResourcesLive,
  );
  const [draft, setDraft] = useState("");
  const [composerMode, setComposerMode] = useState<ChatTurnMode>("default");
  const [composerReasoningEffort, setComposerReasoningEffort] =
    useState<ReasoningEffort | null>(chat.reasoningEffort);
  const [editingPrompt, setEditingPrompt] = useState<{
    id: string;
    frozen: boolean;
  } | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const [skillMenuDismissed, setSkillMenuDismissed] = useState(false);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
  const [composerCaret, setComposerCaret] = useState(0);
  const [composerScrollTop, setComposerScrollTop] = useState(0);
  const [draftAttachments, setDraftAttachments] = useState<
    ComposerAttachmentState[]
  >([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [inspectWidth, setInspectWidth] = useState(readAgentInspectWidth);
  const [viewingAttachment, setViewingAttachment] =
    useState<ChatAttachmentSummary | null>(null);
  const commandListRef = useRef<HTMLDivElement>(null);
  const skillListRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
    contentRef: transcriptContentRef,
    onScroll: handleTranscriptScroll,
    scrollToBottom: scrollTranscriptToBottom,
    showScrollToBottom,
    viewportRef: transcriptViewportRef,
  } = useStickyChatScroll(chat.id);
  const selectedModelId =
    chat.modelId ?? settings?.preferences.defaultModelId ?? "";
  const selectedModel = settings?.models.find(
    (model) => model.id === selectedModelId,
  );
  const imageSupportUncertain =
    draftAttachments.some(({ attachment }) => attachment.kind === "image") &&
    selectedModel?.routes.some((route) => {
      if (!route.enabled) return false;
      return (
        settings?.providers.find(({ id }) => id === route.providerId)?.kind !==
        "chatgpt"
      );
    });
  const taskState = useQuery({
    enabled: inspectOnly && chat.experience === "task",
    queryFn: () => getTask(chat.id),
    queryKey: ["task", chat.id],
  });
  const effectiveInspectOnly =
    inspectOnly && taskChatIsInspectOnly(taskState.data);
  const messages = useQuery({
    queryFn: () => getMessages(chat.id),
    queryKey: ["messages", chat.id],
    refetchInterval: (query) =>
      chatResourceRefreshIntervalMs(
        chat.status,
        chatResourcesLive,
        chatTranscriptNeedsFastRefresh(query.state.data),
      ),
  });
  useQuery({
    enabled: syncEnabled,
    queryFn: async () => {
      const result = await syncChat(chat.id);
      if (result.turns.length > 0) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["messages", chat.id] }),
          queryClient.invalidateQueries({
            queryKey: ["chats", chat.projectId],
          }),
        ]);
      }
      return result;
    },
    queryKey: ["chat-sync", chat.id],
    refetchInterval: chatRefreshInterval,
    retry: false,
  });
  const queuedPrompts = useQuery({
    queryFn: () => getQueuedPrompts(chat.id),
    queryKey: ["prompt-queue", chat.id],
    refetchInterval: chatRefreshInterval,
  });
  const goalState = useQuery({
    queryFn: () => getChatGoal(chat.id),
    queryKey: ["goal", chat.id],
    refetchInterval: chatRefreshInterval,
    retry: false,
  });
  const planState = useQuery({
    queryFn: () => getChatPlan(chat.id),
    queryKey: ["plan", chat.id],
    refetchInterval: chatRefreshInterval,
    retry: false,
  });
  const interactionRequests = useQuery({
    queryFn: () =>
      getAgentInteractionRequests({ chatId: chat.id, status: "pending" }),
    queryKey: ["agent-requests", chat.id, "pending"],
    refetchInterval: chatRefreshInterval,
    retry: false,
  });
  const reasoningState = useQuery({
    enabled: Boolean(selectedModelId),
    queryFn: () => getChatReasoning(chat.id),
    queryKey: ["chat-reasoning", chat.id, selectedModelId],
    retry: false,
    staleTime: 30_000,
  });
  const permissionProfiles = useQuery({
    enabled: Boolean(selectedModelId),
    queryFn: () => getChatPermissionProfiles(chat.id),
    queryKey: ["permission-profiles", chat.id, selectedModelId],
    retry: false,
    staleTime: 30_000,
  });
  const skills = useQuery({
    enabled: Boolean(
      selectedModelId &&
      (draft.includes("$") || slashCommandQuery(draft) !== null),
    ),
    queryFn: () => getSkills(chat.id),
    queryKey: ["skills", chat.id, selectedModelId],
    retry: false,
    staleTime: 30_000,
  });
  const commandWorkflows = useQuery({
    enabled: slashCommandQuery(draft) !== null,
    queryFn: () => getWorkflows({ limit: 500 }),
    queryKey: ["workflows"],
    retry: false,
    staleTime: 30_000,
  });
  const commandTriggers = useQuery({
    enabled: slashCommandQuery(draft) !== null,
    queryFn: () =>
      getWorkflowAutomationTriggers({
        projectId: chat.projectId,
        enabled: true,
        type: "saved-command",
        limit: 500,
      }),
    queryKey: ["workflow-triggers", chat.projectId, "saved-command", true],
    retry: false,
    staleTime: 30_000,
  });
  const timeline = useMemo(
    () => buildChatTimeline(messages.data ?? []),
    [messages.data],
  );
  const slashQuery = slashCommandQuery(draft);
  const slashSuggestions = useMemo(
    () =>
      slashQuery === null
        ? []
        : filterCommandPalette(
            slashQuery,
            skills.data ?? [],
            commandWorkflows.data ?? [],
            chat.projectId,
            commandTriggers.data ?? [],
          ),
    [
      chat.projectId,
      commandTriggers.data,
      commandWorkflows.data,
      skills.data,
      slashQuery,
    ],
  );
  const slashMenuOpen =
    !slashMenuDismissed && slashQuery !== null && slashSuggestions.length > 0;
  const skillMention = useMemo(
    () => activeSkillMention(draft, composerCaret),
    [composerCaret, draft],
  );
  const skillSuggestions = useMemo(
    () =>
      skillMention ? filterSkills(skills.data ?? [], skillMention.query) : [],
    [skillMention, skills.data],
  );
  const skillMenuOpen =
    !skillMenuDismissed && skillMention !== null && skillSuggestions.length > 0;
  const skillMenuLoading =
    !skillMenuDismissed && skillMention !== null && skills.isFetching;
  const skillMenuVisible = skillMenuOpen || skillMenuLoading;
  const highlightedDraft = useMemo(
    () => skillMentionSegments(draft, skills.data ?? []),
    [draft, skills.data],
  );
  const latestAssistantText = useMemo(
    () =>
      [...(messages.data ?? [])]
        .reverse()
        .find((message) => message.role === "assistant")
        ?.content.flatMap((item) => (item.type === "text" ? [item.text] : []))
        .join("\n\n") ?? "",
    [messages.data],
  );
  const clearDraftAttachments = () => {
    setDraftAttachments((current) => {
      for (const item of current) {
        if (item.localPreview) URL.revokeObjectURL(item.contentUrl);
      }
      return [];
    });
  };
  const attachFiles = async (
    requestedFiles: File[],
    source: "file" | "paste" = "file",
  ) => {
    if (relocationActive) return;
    setAttachmentNotice(null);
    const slots = Math.max(
      0,
      MAX_COMPOSER_ATTACHMENTS - draftAttachments.length,
    );
    const accepted = requestedFiles
      .slice(0, slots)
      .filter((file) => file.size <= MAX_ATTACHMENT_BYTES);
    if (requestedFiles.length > slots) {
      setAttachmentNotice(
        `A prompt can include up to ${MAX_COMPOSER_ATTACHMENTS} attachments.`,
      );
    } else if (accepted.length !== requestedFiles.length) {
      setAttachmentNotice("Attachments must be 25 MB or smaller.");
    }
    const pending = await Promise.all(
      accepted.map(async (file): Promise<ComposerAttachmentState> => {
        const kind = attachmentKind(file.name, file.type);
        const previewText =
          kind === "text"
            ? (await file.slice(0, 16_000).text()).slice(0, 8_000)
            : null;
        return {
          attachment: {
            id: `local-${crypto.randomUUID()}`,
            chatId: chat.id,
            fileName: file.name,
            mimeType: file.type || "application/octet-stream",
            sizeBytes: file.size,
            kind,
            source,
            status: "ready",
            previewText,
            createdAt: new Date().toISOString(),
          },
          contentUrl: URL.createObjectURL(file),
          error: null,
          localPreview: true,
          uploading: true,
        };
      }),
    );
    setDraftAttachments((current) => [...current, ...pending]);
    await Promise.all(
      pending.map(async (pendingItem, index) => {
        const file = accepted[index]!;
        try {
          const uploaded = await uploadChatAttachment(
            chat.id,
            file,
            pendingItem.attachment.kind,
            source,
          );
          URL.revokeObjectURL(pendingItem.contentUrl);
          setDraftAttachments((current) =>
            current.map((item) =>
              item.attachment.id === pendingItem.attachment.id
                ? {
                    attachment: uploaded,
                    contentUrl: chatAttachmentContentUrl(uploaded.id),
                    error: null,
                    localPreview: false,
                    uploading: false,
                  }
                : item,
            ),
          );
        } catch (error) {
          setDraftAttachments((current) =>
            current.map((item) =>
              item.attachment.id === pendingItem.attachment.id
                ? { ...item, error: errorText(error), uploading: false }
                : item,
            ),
          );
        }
      }),
    );
  };
  const removeDraftAttachment = (item: ComposerAttachmentState) => {
    setDraftAttachments((current) =>
      current.filter(({ attachment }) => attachment.id !== item.attachment.id),
    );
    if (item.localPreview) URL.revokeObjectURL(item.contentUrl);
    if (!item.attachment.id.startsWith("local-")) {
      void deleteChatAttachment(item.attachment.id).catch((error: unknown) =>
        setAttachmentNotice(errorText(error)),
      );
    }
  };
  const send = useMutation({
    mutationFn: ({
      attachmentIds,
      mode,
      reasoningEffort,
      text,
    }: {
      attachmentIds: string[];
      mode: ChatTurnMode;
      reasoningEffort: ReasoningEffort | null;
      text: string;
    }) => {
      const startedAt = performance.now();
      clientLogger.info("Chat turn submission started", {
        chatId: chat.id,
        counts: { attachments: attachmentIds.length },
        event: "chat.turn.submit.started",
        mode,
        operation: "submit-turn",
        projectId: chat.projectId,
        subsystem: "chat",
      });
      return startTurn(
        chat.id,
        text,
        selectedModelId,
        attachmentIds,
        mode,
        reasoningEffort,
      ).then(
        (result) => {
          clientLogger.info("Chat turn submission accepted", {
            chatId: chat.id,
            durationMs: Math.round(performance.now() - startedAt),
            event: "chat.turn.submit.completed",
            operation: "submit-turn",
            projectId: chat.projectId,
            status: "accepted",
            subsystem: "chat",
          });
          return result;
        },
        (error: unknown) => {
          clientLogger.error("Chat turn submission failed", {
            chatId: chat.id,
            durationMs: Math.round(performance.now() - startedAt),
            ...operationalErrorMetadata(error),
            event: "chat.turn.submit.failed",
            operation: "submit-turn",
            projectId: chat.projectId,
            reasonCode: "request-failed",
            status: "failed",
            subsystem: "chat",
          });
          throw error;
        },
      );
    },
    onSuccess: async () => {
      setDraft("");
      setComposerMode("default");
      clearDraftAttachments();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["messages", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["chats", chat.projectId] }),
        queryClient.invalidateQueries({ queryKey: ["prompt-queue", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["goal", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["plan", chat.id] }),
      ]);
    },
  });
  const updatePrompt = useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: {
        attachmentIds?: string[];
        text?: string;
        mode?: ChatTurnMode;
        reasoningEffort?: ReasoningEffort | null;
        frozen?: boolean;
      };
    }) => updateQueuedPrompt(id, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["prompt-queue", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["chats", chat.projectId] }),
      ]);
    },
  });
  const removePrompt = useMutation({
    mutationFn: (id: string) => deleteQueuedPrompt(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["prompt-queue", chat.id] }),
  });
  const steerPrompt = useMutation({
    mutationFn: (id: string) => steerQueuedPrompt(id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["prompt-queue", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["messages", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["chats", chat.projectId] }),
      ]);
    },
  });
  const reorderPrompts = useMutation({
    mutationFn: (ids: string[]) => reorderQueuedPrompts(chat.id, ids),
    onError: () =>
      queryClient.invalidateQueries({ queryKey: ["prompt-queue", chat.id] }),
  });
  const selectModel = useMutation({
    mutationFn: (modelId: string) => updateChatModel(chat.id, modelId),
    onSuccess: async (updated) => {
      setComposerReasoningEffort(updated.reasoningEffort);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["chats", chat.projectId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["chat-reasoning", chat.id],
        }),
      ]);
    },
  });
  const selectReasoning = useMutation({
    mutationFn: (reasoningEffort: ReasoningEffort | null) =>
      updateChatReasoning(chat.id, reasoningEffort),
    onMutate: (reasoningEffort) => {
      setComposerReasoningEffort(reasoningEffort);
    },
    onSuccess: async (state) => {
      setComposerReasoningEffort(state.reasoningEffort);
      await queryClient.invalidateQueries({
        queryKey: ["chats", chat.projectId],
      });
    },
    onError: () => {
      setComposerReasoningEffort(
        reasoningState.data?.reasoningEffort ?? chat.reasoningEffort,
      );
    },
  });
  const selectPermissionProfile = useMutation({
    mutationFn: (id: string | null) => updateChatPermissionProfile(chat.id, id),
    onSuccess: async (state) => {
      queryClient.setQueryData(
        ["permission-profiles", chat.id, selectedModelId],
        state,
      );
      await queryClient.invalidateQueries({
        queryKey: ["chats", chat.projectId],
      });
    },
  });
  const fork = useMutation({
    mutationFn: (messageId?: string) => forkChat(chat.id, messageId),
    onSuccess: async (forked) => {
      await queryClient.invalidateQueries({
        queryKey: ["chats", chat.projectId],
      });
      onForked(forked);
    },
  });
  const compact = useMutation({
    mutationFn: () => compactChat(chat.id),
    onSuccess: () => setCommandNotice("Conversation context compacted."),
  });
  const updateGoal = useMutation({
    mutationFn: (status: "active" | "paused") =>
      updateChatGoal(chat.id, { status }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["goal", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["messages", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["chats", chat.projectId] }),
      ]);
    },
  });
  const clearGoal = useMutation({
    mutationFn: () => clearChatGoal(chat.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["goal", chat.id] });
    },
  });
  const setAutomationPaused = useMutation({
    mutationFn: (paused: boolean) => setChatPaused(chat.id, paused),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["chats", chat.projectId] }),
        queryClient.invalidateQueries({ queryKey: ["goal", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["messages", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["prompt-queue", chat.id] }),
      ]);
    },
  });
  const interrupt = useMutation({
    mutationFn: async () => {
      const startedAt = performance.now();
      clientLogger.info("Chat interruption requested", {
        chatId: chat.id,
        event: "chat.turn.interrupt.started",
        operation: "interrupt-turn",
        projectId: chat.projectId,
        subsystem: "chat",
      });
      try {
        const result = await interruptChat(chat.id);
        clientLogger.info("Chat interruption completed", {
          chatId: chat.id,
          durationMs: Math.round(performance.now() - startedAt),
          event: "chat.turn.interrupt.completed",
          operation: "interrupt-turn",
          projectId: chat.projectId,
          status: "completed",
          subsystem: "chat",
        });
        return result;
      } catch (error) {
        clientLogger.warn("Chat interruption failed", {
          chatId: chat.id,
          durationMs: Math.round(performance.now() - startedAt),
          ...operationalErrorMetadata(error),
          event: "chat.turn.interrupt.failed",
          operation: "interrupt-turn",
          projectId: chat.projectId,
          reasonCode: "request-failed",
          status: "failed",
          subsystem: "chat",
        });
        throw error;
      }
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["chats", chat.projectId] }),
        queryClient.invalidateQueries({ queryKey: ["messages", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["prompt-queue", chat.id] }),
      ]);
    },
  });
  const [answerPlanPending, setAnswerPlanPending] = useState(false);
  const [answerPlanError, setAnswerPlanError] = useState<string | null>(null);
  const submitPlanAnswer = async (answers: ChatPlanAnswer["answers"]) => {
    setAnswerPlanPending(true);
    setAnswerPlanError(null);
    try {
      await answerChatPlan(chat.id, { answers });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["plan", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["messages", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["chats", chat.projectId] }),
      ]);
    } catch (error) {
      setAnswerPlanError(errorText(error));
    } finally {
      setAnswerPlanPending(false);
    }
  };
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(
    null,
  );
  const [interactionResponseError, setInteractionResponseError] = useState<
    string | null
  >(null);
  const interactionIdempotencyKeys = useRef(new Map<string, string>());
  const submitInteractionResponse = async (
    requestId: string,
    response: AgentInteractionResponse,
  ) => {
    setRespondingRequestId(requestId);
    setInteractionResponseError(null);
    const idempotencyKey =
      interactionIdempotencyKeys.current.get(requestId) ?? crypto.randomUUID();
    interactionIdempotencyKeys.current.set(requestId, idempotencyKey);
    let delivered = false;
    try {
      await respondToAgentInteractionRequest(requestId, {
        idempotencyKey,
        response,
      });
      delivered = true;
    } catch (error) {
      setInteractionResponseError(errorText(error));
    } finally {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["agent-requests", chat.id],
        }),
        queryClient.invalidateQueries({ queryKey: ["plan", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["chats", chat.projectId] }),
      ]);
      if (delivered) interactionIdempotencyKeys.current.delete(requestId);
      setRespondingRequestId(null);
    }
  };
  useEffect(() => {
    setSelectedCommandIndex(0);
  }, [slashQuery]);

  useEffect(() => {
    if (!editingPrompt) {
      setComposerReasoningEffort(chat.reasoningEffort);
    }
  }, [chat.id, chat.reasoningEffort, editingPrompt]);

  useEffect(() => {
    if (!editingPrompt && reasoningState.data) {
      setComposerReasoningEffort(reasoningState.data.reasoningEffort);
    }
  }, [editingPrompt, reasoningState.data]);

  useEffect(() => {
    setSelectedSkillIndex(0);
  }, [skillMention?.query]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    commandListRef.current
      ?.querySelector<HTMLElement>(
        `[data-command-index="${selectedCommandIndex}"]`,
      )
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedCommandIndex, slashMenuOpen]);

  useEffect(() => {
    if (!skillMenuOpen) return;
    skillListRef.current
      ?.querySelector<HTMLElement>(`[data-skill-index="${selectedSkillIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedSkillIndex, skillMenuOpen]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    const readyAttachments = draftAttachments.filter(
      ({ error, uploading }) => !error && !uploading,
    );
    if (
      relocationActive ||
      (!text && readyAttachments.length === 0) ||
      !selectedModelId ||
      send.isPending ||
      selectModel.isPending ||
      selectReasoning.isPending ||
      selectPermissionProfile.isPending ||
      updatePrompt.isPending ||
      draftAttachments.some(({ error, uploading }) => error || uploading)
    ) {
      return;
    }
    if (editingPrompt) {
      updatePrompt.mutate(
        {
          id: editingPrompt.id,
          input: {
            text,
            mode: composerMode,
            reasoningEffort: composerReasoningEffort,
            attachmentIds: readyAttachments.map(
              ({ attachment }) => attachment.id,
            ),
            frozen: editingPrompt.frozen,
          },
        },
        {
          onSuccess: () => {
            setEditingPrompt(null);
            setDraft("");
            setComposerMode("default");
            setComposerReasoningEffort(chat.reasoningEffort);
            clearDraftAttachments();
          },
        },
      );
      return;
    }
    send.mutate({
      text,
      mode: composerMode,
      reasoningEffort: composerReasoningEffort,
      attachmentIds: readyAttachments.map(({ attachment }) => attachment.id),
    });
  };

  const executeSlashCommand = async ({ command }: SlashCommandSuggestion) => {
    const name = command.name;
    setDraft("");
    setSlashMenuDismissed(true);
    setCommandNotice(null);

    if (name === "compact") {
      compact.mutate();
    } else if (name === "goal") {
      setComposerMode("goal");
      setCommandNotice("Goal mode selected for the next message.");
    } else if (name === "plan") {
      setComposerMode("plan");
      setCommandNotice("Plan mode selected for the next message.");
    } else if (name === "pause") {
      setAutomationPaused.mutate(!chat.automationPaused);
    } else if (name === "copy") {
      if (!latestAssistantText) {
        setCommandNotice("There is no completed response to copy yet.");
      } else {
        await navigator.clipboard.writeText(latestAssistantText);
        setCommandNotice("Latest response copied.");
      }
    } else if (name === "fork") {
      fork.mutate(undefined);
    } else if (name === "new" || name === "clear") {
      onCreateChat();
    } else if (name === "rename") {
      const title = window.prompt("Rename agent", chat.title)?.trim();
      if (title) onRename(title);
    } else if (name === "delete") {
      if (chat.status === "running" || chat.status === "waiting-for-approval") {
        setCommandNotice("Stop the active agent before removing this tab.");
      } else if (
        window.confirm(
          `Remove “${chat.title}”? Agents with conversation history remain in Archive for 90 days.`,
        )
      ) {
        onDelete();
      }
    } else if (name === "status") {
      setCommandNotice(
        `${selectedModel ? modelDisplayName(selectedModel) : "No model selected"} · ${chat.status}`,
      );
    } else {
      const prompts: Record<string, string> = {
        diff: "Inspect the current Git working-tree diff and summarize every change. Do not modify files.",
        init: "Create an AGENTS.md scaffold for this repository, based on its existing conventions.",
        review:
          "Review the current working tree for defects, regressions, and missing tests. Do not modify files.",
      };
      const prompt = prompts[name];
      if (prompt) {
        send.mutate({
          text: prompt,
          attachmentIds: [],
          mode: composerMode,
          reasoningEffort: composerReasoningEffort,
        });
      }
    }
  };

  const chooseSkill = (skill: SkillSummary) => {
    if (!skillMention) return;
    const inserted = insertSkillMention(draft, skillMention, skill.name);
    setDraft(inserted.text);
    setComposerCaret(inserted.caret);
    setSkillMenuDismissed(true);
    setCommandNotice(null);
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(inserted.caret, inserted.caret);
    });
  };

  const executeCommandPalette = async (
    suggestion: CommandPaletteSuggestion,
  ) => {
    if (suggestion.kind === "builtin") {
      await executeSlashCommand(suggestion.command);
      return;
    }
    setSlashMenuDismissed(true);
    setCommandNotice(null);
    if (suggestion.kind === "workflow") {
      setDraft("");
      onOpenWorkflow(suggestion.workflow.id);
      return;
    }
    if (suggestion.kind === "saved-command") {
      setDraft("");
      try {
        const result = await invokeSavedWorkflowCommand(suggestion.trigger.id, {
          idempotencyKey: `saved-command-${crypto.randomUUID()}`,
          structuredInput: {},
        });
        setCommandNotice(
          `Started ${suggestion.label} as run ${result.run.run.id.slice(0, 8)}.`,
        );
        void queryClient.invalidateQueries({
          queryKey: ["workflow-runs", chat.projectId],
        });
        onOpenWorkflow(suggestion.trigger.workflowId);
      } catch (error) {
        setCommandNotice(errorText(error));
      }
      return;
    }
    const text = `$${suggestion.skill.name} `;
    setDraft(text);
    setComposerCaret(text.length);
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(text.length, text.length);
    });
  };

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden transition-[padding-right] duration-150 ease-out motion-reduce:transition-none"
      style={{
        paddingRight: inspectOpen && !inspectOverlay ? inspectWidth : 0,
      }}
    >
      <div
        ref={transcriptViewportRef}
        className={cn(
          "chat-message-scroll flex-1 overflow-y-auto px-4 pt-6 sm:px-8",
          effectiveInspectOnly ? "pb-10" : "pb-72",
        )}
        onScroll={handleTranscriptScroll}
      >
        <div ref={transcriptContentRef} className="flex w-full flex-col gap-5">
          {messages.data?.length === 0 ? (
            <div className="grid min-h-[45vh] place-items-center text-center">
              <div>
                <div className="mx-auto grid size-12 place-items-center rounded-2xl border bg-card">
                  <WandSparkles className="size-5" />
                </div>
                <h2 className="mt-4 font-semibold">Start working</h2>
                <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                  Ask Cantrip to inspect, explain, or change this repository.
                </p>
              </div>
            </div>
          ) : null}

          {timeline.map((entry) => {
            if (entry.type === "activityGroup") {
              return (
                <ActivityGroup
                  key={entry.key}
                  startedAt={entry.startedAt}
                  endedAt={entry.endedAt}
                >
                  {entry.messages.map((message) => (
                    <MessageContent key={message.id} message={message} />
                  ))}
                </ActivityGroup>
              );
            }
            const message = entry.message;
            const turnMetadata = formatTurnMetadata(entry.turnMetadata);
            const user = message.role === "user";
            const system = message.role === "system";
            const assistantText =
              message.role === "assistant"
                ? message.content
                    .flatMap((item) =>
                      item.type === "text" ? [item.text] : [],
                    )
                    .join("\n\n")
                : "";
            return (
              <div
                key={message.id}
                className={cn("flex gap-3", user && "justify-end")}
              >
                {!user ? (
                  <div
                    className={cn(
                      "mt-1 grid size-7 shrink-0 place-items-center rounded-lg border bg-card",
                      system && "border-destructive/30 text-destructive",
                    )}
                  >
                    <Bot className="size-3.5" />
                  </div>
                ) : null}
                <div
                  className={cn(
                    "min-w-0",
                    user &&
                      "max-w-[85%] overflow-hidden rounded-2xl bg-muted/80 px-4 py-3 text-foreground sm:max-w-[42rem]",
                    !user && !system && "flex-1 py-1",
                    system &&
                      "max-w-[85%] overflow-hidden rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-destructive",
                  )}
                >
                  {user && message.mode !== "default" ? (
                    <Badge
                      variant="outline"
                      className={cn(
                        "mb-2 h-5 capitalize",
                        message.mode === "goal"
                          ? "border-violet-500/30 text-violet-600 dark:text-violet-400"
                          : "border-sky-500/30 text-sky-600 dark:text-sky-400",
                      )}
                    >
                      {message.mode} mode
                    </Badge>
                  ) : null}
                  <MessageContent message={message} />
                  {user && message.providerName ? (
                    <p className="mt-1.5 truncate text-[10px] text-muted-foreground">
                      {message.providerName}
                      {message.providerModelName
                        ? ` · ${message.providerModelName}`
                        : ""}
                    </p>
                  ) : null}
                  {assistantText ? (
                    <div className="mt-2 flex items-center gap-1 text-muted-foreground">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        title="Copy response"
                        onClick={async () => {
                          await navigator.clipboard.writeText(assistantText);
                          setCopiedMessageId(message.id);
                          window.setTimeout(
                            () => setCopiedMessageId(null),
                            1_500,
                          );
                        }}
                      >
                        {copiedMessageId === message.id ? (
                          <Check className="size-3.5" />
                        ) : (
                          <Copy className="size-3.5" />
                        )}
                        <span className="sr-only">Copy response</span>
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        title="Fork agent from this response"
                        disabled={fork.isPending}
                        onClick={() => fork.mutate(message.id)}
                      >
                        <GitFork className="size-3.5" />
                        <span className="sr-only">
                          Fork agent from this response
                        </span>
                      </Button>
                      {turnMetadata ? (
                        <span className="ml-1 text-[10px] tabular-nums text-muted-foreground/70">
                          {turnMetadata}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {user ? (
                  <div className="mt-1 grid size-7 shrink-0 place-items-center rounded-lg bg-muted">
                    <User className="size-3.5" />
                  </div>
                ) : null}
              </div>
            );
          })}

          <ChatRunStatus
            automationPaused={chat.automationPaused}
            status={chat.status}
            waitingForPlanAnswer={Boolean(planState.data?.question)}
          />
        </div>
      </div>

      <div
        aria-hidden="true"
        className={cn(
          "chat-composer-fade pointer-events-none absolute bottom-0 left-0 z-10 h-56 transition-[right] duration-150 ease-out motion-reduce:transition-none",
          effectiveInspectOnly && "hidden",
        )}
        style={{ right: inspectOpen && !inspectOverlay ? inspectWidth : 0 }}
      />
      <form
        onSubmit={submit}
        className={cn(
          "pointer-events-none absolute bottom-0 left-0 z-20 px-4 pb-3 transition-[right] duration-150 ease-out motion-reduce:transition-none sm:px-8 sm:pb-4",
          effectiveInspectOnly && "hidden",
        )}
        style={{ right: inspectOpen && !inspectOverlay ? inspectWidth : 0 }}
      >
        <div className="pointer-events-auto relative w-full">
          {showScrollToBottom ? (
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="absolute bottom-[calc(100%+0.75rem)] left-1/2 z-30 size-9 -translate-x-1/2 rounded-full bg-popover text-popover-foreground shadow-lg backdrop-blur-xl"
              title="Scroll to latest message"
              aria-label="Scroll to latest message"
              onClick={scrollTranscriptToBottom}
            >
              <ArrowDown className="size-4" />
            </Button>
          ) : null}
          {slashMenuOpen ? (
            <div
              id="slash-command-menu"
              ref={commandListRef}
              role="listbox"
              aria-label="Commands, workflows, and skills"
              className="chat-composer-surface absolute inset-x-0 bottom-[calc(100%+0.5rem)] max-h-72 overflow-y-auto rounded-xl border p-1.5 shadow-2xl"
            >
              {slashSuggestions.map((suggestion, index) => (
                <button
                  key={`${suggestion.kind}:${
                    suggestion.kind === "saved-command"
                      ? suggestion.trigger.id
                      : suggestion.invocation
                  }`}
                  id={`slash-command-${index}`}
                  data-command-index={index}
                  role="option"
                  aria-selected={index === selectedCommandIndex}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left",
                    index === selectedCommandIndex
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground hover:bg-accent/60",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setSelectedCommandIndex(index)}
                  onClick={() => void executeCommandPalette(suggestion)}
                >
                  <span
                    className="w-36 shrink-0 truncate font-mono text-sm font-medium"
                    title={suggestion.invocation}
                  >
                    {suggestion.invocation}
                  </span>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {suggestion.description}
                  </span>
                  <Badge
                    variant="outline"
                    className="ml-auto hidden capitalize sm:inline-flex"
                  >
                    {suggestion.kind}
                  </Badge>
                </button>
              ))}
            </div>
          ) : null}
          {skillMenuVisible ? (
            <div
              id="skill-mention-menu"
              ref={skillListRef}
              role="listbox"
              aria-label="Skills"
              className="chat-composer-surface absolute inset-x-0 bottom-[calc(100%+0.5rem)] max-h-72 overflow-y-auto rounded-xl border p-1.5 shadow-2xl"
            >
              {skillMenuLoading && skillSuggestions.length === 0 ? (
                <div
                  role="status"
                  className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
                >
                  <Loader2 className="size-3.5 animate-spin" />
                  Loading project skills…
                </div>
              ) : null}
              {skillSuggestions.map((skill, index) => (
                <button
                  key={skill.name}
                  id={`skill-mention-${index}`}
                  data-skill-index={index}
                  role="option"
                  aria-selected={index === selectedSkillIndex}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left",
                    index === selectedSkillIndex
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground hover:bg-accent/60",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setSelectedSkillIndex(index)}
                  onClick={() => chooseSkill(skill)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate font-mono text-sm font-medium text-violet-500 dark:text-violet-400">
                        ${skill.name}
                      </span>
                      {skill.displayName && skill.displayName !== skill.name ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {skill.displayName}
                        </span>
                      ) : null}
                    </span>
                    {skill.description ? (
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {skill.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {chat.automationPaused ? (
            <div
              role="status"
              className="mb-2 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
            >
              <Pause className="size-3.5 shrink-0" />
              <span>
                {chat.status === "running"
                  ? "Paused. The current step will finish, then Codex will wait here until Resume."
                  : "Paused. Queued prompts, goals, and automatic continuations will wait for Resume."}
              </span>
            </div>
          ) : null}
          {relocationJob && (relocationActive || relocationNeedsAttention) ? (
            <ChatRelocationStatus
              job={relocationJob}
              onOpen={onOpenRelocation}
            />
          ) : null}
          <GoalPanel
            error={
              updateGoal.isError
                ? errorText(updateGoal.error)
                : clearGoal.isError
                  ? errorText(clearGoal.error)
                  : null
            }
            goal={goalState.data?.goal ?? null}
            pending={updateGoal.isPending || clearGoal.isPending}
            onClear={() => clearGoal.mutate()}
            onUpdate={(status) => updateGoal.mutate(status)}
          />
          <AgentInteractionPanel
            requests={interactionRequests.data ?? []}
            pendingRequestId={respondingRequestId}
            planQuestionId={planState.data?.question?.id}
            error={
              interactionResponseError ??
              (interactionRequests.isError
                ? errorText(interactionRequests.error)
                : null)
            }
            onRespond={(requestId, response) =>
              void submitInteractionResponse(requestId, response)
            }
          />
          {planState.data ? (
            <PlanPanel
              state={planState.data}
              pending={answerPlanPending}
              error={answerPlanError}
              onAnswer={(answers) => void submitPlanAnswer(answers)}
            />
          ) : null}
          <PromptQueue
            prompts={queuedPrompts.data ?? []}
            editingPromptId={editingPrompt?.id ?? null}
            executing={
              chat.status === "running" ||
              chat.status === "waiting-for-approval"
            }
            disabled={
              relocationActive ||
              updatePrompt.isPending ||
              removePrompt.isPending ||
              steerPrompt.isPending ||
              reorderPrompts.isPending
            }
            onDelete={(prompt) => removePrompt.mutate(prompt.id)}
            onEdit={(prompt) => {
              setEditingPrompt({ id: prompt.id, frozen: prompt.frozen });
              setDraft(prompt.text);
              setComposerMode(prompt.mode);
              setComposerReasoningEffort(prompt.reasoningEffort);
              clearDraftAttachments();
              setDraftAttachments(
                prompt.attachments.map((attachment) => ({
                  attachment,
                  contentUrl: chatAttachmentContentUrl(attachment.id),
                  error: null,
                  localPreview: false,
                  uploading: false,
                })),
              );
              updatePrompt.mutate({
                id: prompt.id,
                input: { frozen: true },
              });
            }}
            onFreeze={(prompt) =>
              updatePrompt.mutate({
                id: prompt.id,
                input: { frozen: !prompt.frozen },
              })
            }
            onSteer={(prompt) => steerPrompt.mutate(prompt.id)}
            onReorder={(ids) => {
              const current = queuedPrompts.data ?? [];
              const byId = new Map(
                current.map((prompt) => [prompt.id, prompt]),
              );
              queryClient.setQueryData<QueuedPrompt[]>(
                ["prompt-queue", chat.id],
                ids.flatMap((id, position) => {
                  const prompt = byId.get(id);
                  return prompt ? [{ ...prompt, position }] : [];
                }),
              );
              reorderPrompts.mutate(ids);
            }}
          />
          <div
            className={cn(
              "chat-composer-surface relative flex items-end gap-2 rounded-2xl border p-2 shadow-xl shadow-background/20 focus-within:ring-2 focus-within:ring-ring",
              draggingFiles && "ring-2 ring-primary",
            )}
            onDragEnter={(event) => {
              if (event.dataTransfer.types.includes("Files")) {
                event.preventDefault();
                setDraggingFiles(true);
              }
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                setDraggingFiles(false);
              }
            }}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("Files")) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDraggingFiles(false);
              if (event.dataTransfer.files.length > 0) {
                void attachFiles([...event.dataTransfer.files]);
              }
            }}
          >
            {draggingFiles ? (
              <div className="pointer-events-none absolute inset-1 z-20 grid place-items-center rounded-xl bg-background/85 text-sm font-medium backdrop-blur-sm">
                Drop files to attach
              </div>
            ) : null}
            <div className="min-w-0 flex-1">
              {draftAttachments.length > 0 ? (
                <div className="flex max-h-44 flex-wrap gap-2 overflow-y-auto px-1 pb-2">
                  {draftAttachments.map((item) => (
                    <AttachmentPreview
                      key={item.attachment.id}
                      attachment={item.attachment}
                      contentUrl={item.contentUrl}
                      error={item.error}
                      uploading={item.uploading}
                      onOpen={() => {
                        if (!item.uploading && !item.error) {
                          setViewingAttachment(item.attachment);
                        }
                      }}
                      onRemove={() => removeDraftAttachment(item)}
                    />
                  ))}
                </div>
              ) : null}
              <div className="relative min-h-10 overflow-hidden">
                {draft ? (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 overflow-hidden px-2 py-2 text-sm leading-5 text-foreground whitespace-pre-wrap break-words"
                  >
                    <div
                      style={{
                        transform: `translateY(-${composerScrollTop}px)`,
                      }}
                    >
                      {highlightedDraft.map((segment, index) =>
                        segment.skill ? (
                          <span
                            key={`${index}:${segment.text}`}
                            className="rounded-sm bg-violet-500/15 text-violet-600 dark:text-violet-400"
                          >
                            {segment.text}
                          </span>
                        ) : (
                          <span key={`${index}:${segment.text}`}>
                            {segment.text}
                          </span>
                        ),
                      )}
                      {draft.endsWith("\n") ? "\u00a0" : null}
                    </div>
                  </div>
                ) : null}
                <textarea
                  ref={composerRef}
                  rows={1}
                  value={draft}
                  disabled={relocationActive}
                  aria-autocomplete="list"
                  aria-controls={
                    skillMenuVisible
                      ? "skill-mention-menu"
                      : slashMenuOpen
                        ? "slash-command-menu"
                        : undefined
                  }
                  aria-activedescendant={
                    skillMenuOpen
                      ? `skill-mention-${selectedSkillIndex}`
                      : slashMenuOpen
                        ? `slash-command-${selectedCommandIndex}`
                        : undefined
                  }
                  onPaste={(event) => {
                    const files = [...event.clipboardData.files];
                    if (files.length > 0) {
                      event.preventDefault();
                      void attachFiles(files);
                      return;
                    }
                    const pastedText =
                      event.clipboardData.getData("text/plain");
                    if (!shouldAttachPastedText(pastedText)) return;
                    event.preventDefault();
                    const fileName = largePasteFileName();
                    const file = new File([pastedText], fileName, {
                      type: "text/plain",
                    });
                    const inserted = insertComposerText(
                      draft,
                      `Read attachment ${fileName}`,
                      event.currentTarget.selectionStart,
                      event.currentTarget.selectionEnd,
                    );
                    setDraft(inserted.text);
                    setComposerCaret(inserted.caret);
                    window.requestAnimationFrame(() => {
                      composerRef.current?.setSelectionRange(
                        inserted.caret,
                        inserted.caret,
                      );
                    });
                    void attachFiles([file], "paste");
                  }}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setComposerCaret(event.target.selectionStart);
                    setSlashMenuDismissed(false);
                    setSkillMenuDismissed(false);
                    setCommandNotice(null);
                  }}
                  onSelect={(event) => {
                    setComposerCaret(event.currentTarget.selectionStart);
                  }}
                  onScroll={(event) => {
                    setComposerScrollTop(event.currentTarget.scrollTop);
                  }}
                  onKeyDown={(event) => {
                    if (skillMenuOpen && event.key === "ArrowDown") {
                      event.preventDefault();
                      setSelectedSkillIndex((index) =>
                        Math.min(index + 1, skillSuggestions.length - 1),
                      );
                      return;
                    }
                    if (skillMenuOpen && event.key === "ArrowUp") {
                      event.preventDefault();
                      setSelectedSkillIndex((index) => Math.max(index - 1, 0));
                      return;
                    }
                    if (skillMenuOpen && event.key === "Escape") {
                      event.preventDefault();
                      setSkillMenuDismissed(true);
                      return;
                    }
                    if (
                      skillMenuOpen &&
                      (event.key === "Tab" ||
                        (event.key === "Enter" && !event.shiftKey))
                    ) {
                      event.preventDefault();
                      const skill = skillSuggestions[selectedSkillIndex];
                      if (skill) chooseSkill(skill);
                      return;
                    }
                    if (slashMenuOpen && event.key === "ArrowDown") {
                      event.preventDefault();
                      setSelectedCommandIndex((index) =>
                        Math.min(index + 1, slashSuggestions.length - 1),
                      );
                      return;
                    }
                    if (slashMenuOpen && event.key === "ArrowUp") {
                      event.preventDefault();
                      setSelectedCommandIndex((index) =>
                        Math.max(index - 1, 0),
                      );
                      return;
                    }
                    if (slashMenuOpen && event.key === "Escape") {
                      event.preventDefault();
                      setSlashMenuDismissed(true);
                      return;
                    }
                    if (
                      slashMenuOpen &&
                      (event.key === "Tab" ||
                        (event.key === "Enter" && !event.shiftKey))
                    ) {
                      event.preventDefault();
                      const suggestion = slashSuggestions[selectedCommandIndex];
                      if (suggestion) void executeCommandPalette(suggestion);
                      return;
                    }
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                  placeholder={
                    relocationActive
                      ? "Agent relocation is in progress…"
                      : editingPrompt
                        ? "Edit queued prompt…"
                        : composerMode === "goal"
                          ? "Describe the goal Codex should pursue…"
                          : composerMode === "plan"
                            ? "Describe what Codex should plan…"
                            : chat.automationPaused
                              ? "Queue a prompt while paused…"
                              : chat.status === "running"
                                ? "Queue a follow-up…"
                                : "Ask Cantrip to work on this repository…"
                  }
                  className={cn(
                    "relative max-h-48 min-h-10 w-full resize-none bg-transparent px-2 py-2 text-sm leading-5 outline-none placeholder:text-muted-foreground",
                    draft && "text-transparent caret-foreground",
                  )}
                />
              </div>
              <div className="flex min-w-0 items-center gap-1 px-1 pt-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  disabled={relocationActive}
                  className="hidden"
                  onChange={(event) => {
                    if (event.target.files?.length) {
                      void attachFiles([...event.target.files]);
                    }
                    event.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0 text-muted-foreground"
                  disabled={relocationActive}
                  title="Attach files"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Plus className="size-4" />
                  <span className="sr-only">Attach files</span>
                </Button>
                <ModelReasoningPicker
                  disabled={relocationActive}
                  models={settings?.models ?? []}
                  selectedModelId={selectedModelId}
                  modelSelectionDisabled={
                    chat.status === "running" ||
                    chat.status === "waiting-for-approval"
                  }
                  modelPending={selectModel.isPending}
                  reasoningEffort={composerReasoningEffort}
                  reasoningPending={
                    reasoningState.isLoading || selectReasoning.isPending
                  }
                  reasoningState={reasoningState.data}
                  onSelectModel={(modelId) => selectModel.mutate(modelId)}
                  onSelectReasoning={(reasoningEffort) => {
                    setComposerReasoningEffort(reasoningEffort);
                    if (!editingPrompt) {
                      selectReasoning.mutate(reasoningEffort);
                    }
                  }}
                />
                <PermissionProfileControl
                  pending={
                    permissionProfiles.isLoading ||
                    selectPermissionProfile.isPending
                  }
                  state={permissionProfiles.data}
                  onChange={(id) => selectPermissionProfile.mutate(id)}
                />
                <ChatModeControl
                  mode={composerMode}
                  disabled={relocationActive}
                  onChange={setComposerMode}
                />
              </div>
            </div>
            <ChatComposerPrimaryActions
              active={
                chat.status === "running" ||
                chat.status === "waiting-for-approval"
              }
              paused={chat.automationPaused}
              pausePending={setAutomationPaused.isPending}
              pauseDisabled={relocationActive || setAutomationPaused.isPending}
              stopPending={interrupt.isPending}
              stopDisabled={relocationActive || interrupt.isPending}
              sendPending={send.isPending}
              sendDisabled={
                relocationActive ||
                (!draft.trim() &&
                  !draftAttachments.some(
                    ({ error, uploading }) => !error && !uploading,
                  )) ||
                draftAttachments.some(
                  ({ error, uploading }) => Boolean(error) || uploading,
                ) ||
                !selectedModelId ||
                send.isPending ||
                selectModel.isPending ||
                selectReasoning.isPending ||
                selectPermissionProfile.isPending ||
                updatePrompt.isPending
              }
              onPauseChange={(paused) => setAutomationPaused.mutate(paused)}
              onStop={() => interrupt.mutate()}
            />
          </div>
          <AttachmentViewerDialog
            attachment={viewingAttachment}
            contentUrl={
              viewingAttachment
                ? (draftAttachments.find(
                    ({ attachment }) => attachment.id === viewingAttachment.id,
                  )?.contentUrl ??
                  chatAttachmentContentUrl(viewingAttachment.id))
                : null
            }
            open={viewingAttachment !== null}
            onOpenChange={(open) => {
              if (!open) setViewingAttachment(null);
            }}
          />
          {imageSupportUncertain ? (
            <p className="mt-2 text-center text-[11px] text-amber-700 dark:text-amber-300">
              Image support will be detected for this model. If unavailable, the
              agent will receive the worker-local file path instead.
            </p>
          ) : null}
          {attachmentNotice ? (
            <p className="mt-2 text-center text-[11px] text-destructive">
              {attachmentNotice}
            </p>
          ) : null}
          {send.isError ||
          selectModel.isError ||
          selectReasoning.isError ||
          selectPermissionProfile.isError ||
          compact.isError ||
          updatePrompt.isError ||
          removePrompt.isError ||
          steerPrompt.isError ||
          reorderPrompts.isError ||
          setAutomationPaused.isError ||
          interrupt.isError ? (
            <p className="mt-2 text-xs text-destructive">
              {errorText(
                send.error ??
                  selectModel.error ??
                  selectReasoning.error ??
                  selectPermissionProfile.error ??
                  compact.error ??
                  updatePrompt.error ??
                  removePrompt.error ??
                  steerPrompt.error ??
                  reorderPrompts.error ??
                  setAutomationPaused.error ??
                  interrupt.error,
              )}
            </p>
          ) : editingPrompt ? (
            <p className="mt-2 text-center text-[11px] text-muted-foreground">
              Enter re-queues this prompt in its original position
            </p>
          ) : commandNotice ? (
            <p className="mt-2 text-center text-[11px] text-muted-foreground">
              {commandNotice}
            </p>
          ) : null}
        </div>
      </form>
      {effectiveInspectOnly ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 border-t bg-background/95 px-4 py-2 text-center text-[11px] text-muted-foreground backdrop-blur">
          Task planning controls are available in Task view.
        </div>
      ) : null}
      <AgentInspectPanelShell
        active={inspectActive}
        className="absolute inset-y-0 right-0 z-30"
        onOpenChange={onInspectOpenChange}
        onWidthChange={setInspectWidth}
        open={inspectOpen}
        overlay={inspectOverlay}
      >
        <AgentInspectContent
          active={inspectActive}
          messages={messages.data ?? []}
          visible={inspectOpen}
        />
      </AgentInspectPanelShell>
    </div>
  );
}

export function App() {
  useDesktopDirectTransportTelemetry();
  const queryClient = useQueryClient();
  const activeProjectWorkspaceStorageKey = useMemo(
    () => scopedClientStorageKey("cantrip:active-project-workspace"),
    [],
  );
  const liveStatus = useAppLiveStatus();
  const projectResourcesLive = liveStatus === "live";
  const desktopRuntime = useMemo(() => isDesktopRuntime(), []);
  const projectRevealLabel = useMemo(
    () => desktopProjectRevealLabel(desktopRuntime, navigator.userAgent),
    [desktopRuntime],
  );
  const overlayTitlebar = useMemo(
    () => shouldUseOverlayTitlebar(desktopRuntime, navigator.userAgent),
    [desktopRuntime],
  );
  const popoutTarget = useMemo(
    () =>
      desktopRuntime
        ? parseDesktopPopoutGroupTarget(window.location.search)
        : null,
    [desktopRuntime],
  );
  const explorerFileTarget = useMemo(
    () =>
      desktopRuntime
        ? parseDesktopExplorerFileTarget(window.location.search)
        : null,
    [desktopRuntime],
  );
  const popoutProjectId =
    popoutTarget?.projectId ?? explorerFileTarget?.projectId ?? null;
  const isPopout = popoutTarget !== null || explorerFileTarget !== null;
  const narrowViewport = useNarrowViewport();
  const compactLayout = shouldUseCompactLayout(narrowViewport, desktopRuntime);
  const compactShell = compactLayout && !isPopout;
  const desktopSidebarDrawer = shouldUseDesktopSidebarDrawer(
    narrowViewport,
    desktopRuntime,
    isPopout,
  );
  const showContentTitlebar = !isPopout || desktopRuntime;
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    popoutProjectId,
  );
  const [createdRepositoryOnboarding, setCreatedRepositoryOnboarding] =
    useState<{ openInitialChat: boolean; projectId: string } | null>(null);
  const [workspaceSelection, setWorkspaceSelection] = useState(() =>
    emptyWorkspaceSelection(popoutProjectId),
  );
  const [pendingSurfaceSelection, setPendingSurfaceSelection] = useState<{
    groupId?: string;
    projectId: string;
    tabKey: string;
  } | null>(
    popoutTarget
      ? {
          groupId: popoutTarget.groupId,
          projectId: popoutTarget.projectId,
          tabKey: popoutTarget.activeTabKey,
        }
      : null,
  );
  const [chatConsoleChatId, setChatConsoleChatId] = useState<string | null>(
    null,
  );
  const [agentInspectOpenChats, setAgentInspectOpenChats] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [taskChatViewIds, setTaskChatViewIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const setAgentInspectOpen = useCallback((chatId: string, open: boolean) => {
    setAgentInspectOpenChats((current) =>
      updateAgentInspectOpenChats(current, chatId, open),
    );
  }, []);
  const [workspaceDragError, setWorkspaceDragError] = useState<string | null>(
    null,
  );
  const selectedTabKey = selectedWorkspaceTabKey(workspaceSelection);
  const selectedChatId = projectSurfaceTabId(selectedTabKey, "chat");
  const selectedTerminalId = projectSurfaceTabId(selectedTabKey, "terminal");
  const selectedExplorerId = projectSurfaceTabId(selectedTabKey, "explorer");
  const selectedBrowserId = projectSurfaceTabId(selectedTabKey, "browser");
  const selectedCodeTabId = projectSurfaceTabId(selectedTabKey, "code");
  const selectedProjectViewId = projectSurfaceTabId(selectedTabKey, "view");
  useAppLiveScope(
    selectedProjectId
      ? { kind: "project", projectId: selectedProjectId }
      : null,
  );
  useAppLiveScope(
    selectedChatId ? { kind: "chat", chatId: selectedChatId } : null,
  );
  const [showImporter, setShowImporter] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showServerAdmin, setShowServerAdmin] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("general");
  const [settingsPolicyId, setSettingsPolicyId] = useState<string | null>(null);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const projectOverviewSelected =
    !isPopout &&
    !showImporter &&
    !showSettings &&
    !showServerAdmin &&
    !showProjectSettings &&
    workspaceSelection.destination === "overview";
  const [activeProjectWorkspaceId, setActiveProjectWorkspaceId] = useState<
    string | null
  >(() => window.localStorage.getItem(activeProjectWorkspaceStorageKey));
  const [selectedWorkflowIntentId, setSelectedWorkflowIntentId] = useState<
    string | null
  >(null);
  const [showCustomizations, setShowCustomizations] = useState(false);
  const [chatRelocationOpen, setChatRelocationOpen] = useState(false);
  const [mobileTabGridOpen, setMobileTabGridOpen] = useState(false);
  const [mobileBottomTabs, setMobileBottomTabs] = useState(
    initialMobileBottomTabs,
  );
  const [mobileBottomTabsProjectId, setMobileBottomTabsProjectId] = useState<
    string | null
  >(null);
  const [activeMobileBottomTabId, setActiveMobileBottomTabId] = useState(
    PRIMARY_MOBILE_BOTTOM_TAB_ID,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [desktopSidebarDrawerOpen, setDesktopSidebarDrawerOpen] =
    useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [contentScrolled, setContentScrolled] = useState(false);
  const [gitHistoryHeader, setGitHistoryHeader] =
    useState<GitHistoryHeaderState | null>(null);
  const [explorerHeader, setExplorerHeader] =
    useState<ExplorerHeaderState | null>(null);
  const [codeHeader, setCodeHeader] = useState<CodeHeaderState | null>(null);
  const [popoutPending, setPopoutPending] = useState(false);
  const [popoutError, setPopoutError] = useState<string | null>(null);
  const [
    terminalCommandPaletteTerminalId,
    setTerminalCommandPaletteTerminalId,
  ] = useState<string | null>(null);
  const [terminalServiceTerminalId, setTerminalServiceTerminalId] = useState<
    string | null
  >(null);
  const [detachedGroupId, setDetachedGroupId] = useState<string | null>(null);
  const detachedExplorerIdRef = useRef<string | null>(null);
  const explorerLifecycleRef = useRef(
    new Map<string, ExplorerLifecycleActions>(),
  );
  const archiveCleanupRequestedRef = useRef(false);
  const appResourcesLoggedRef = useRef(false);
  const projectResourcesLoggedRef = useRef<string | null>(null);
  const [worktreeCreateTarget, setWorktreeCreateTarget] =
    useState<WorktreeBindingTarget | null>(null);
  const [worktreeActionError, setWorktreeActionError] = useState<string | null>(
    null,
  );
  const [codeAppearance, setCodeAppearance] = useState<CodeAppearance>(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
  );
  const [proModeActive, setProModeActive] = useState(false);
  const contentRootRef = useRef<HTMLElement>(null);
  const mobileBottomTabSequenceRef = useRef(0);
  const persistedMobileBottomTabsRef = useRef<{
    projectId: string;
    signature: string;
  } | null>(null);
  const scrolledContentRef = useRef(new Set<EventTarget>());
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);
  const sidebarResizePointerIdRef = useRef<number | null>(null);
  const sidebarResizeLeftRef = useRef(0);
  const sidebarResizeStartWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);
  const sidebarResizeBodyStyleRef = useRef<{
    cursor: string;
    userSelect: string;
  } | null>(null);

  useEffect(() => {
    if (!desktopSidebarDrawer) setDesktopSidebarDrawerOpen(false);
  }, [desktopSidebarDrawer]);

  useEffect(() => {
    if (!desktopSidebarDrawerOpen) return;
    sidebarRef.current?.focus();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setDesktopSidebarDrawerOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [desktopSidebarDrawerOpen]);

  const handleExplorerLifecycleChange = useCallback(
    (explorerId: string, actions: ExplorerLifecycleActions | null) => {
      if (actions) explorerLifecycleRef.current.set(explorerId, actions);
      else explorerLifecycleRef.current.delete(explorerId);
    },
    [],
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
      );
    },
    [],
  );

  const resetMobileBottomTabs = () => {
    setMobileBottomTabs(initialMobileBottomTabs());
    setMobileBottomTabsProjectId(null);
    setActiveMobileBottomTabId(PRIMARY_MOBILE_BOTTOM_TAB_ID);
    setMobileTabGridOpen(false);
    mobileBottomTabSequenceRef.current = 0;
    persistedMobileBottomTabsRef.current = null;
  };

  const openCreatedTab = (
    projectId: string,
    kind: "browser" | "chat" | "code" | "explorer" | "terminal" | "view",
    tabId: string,
  ) => {
    setDesktopSidebarDrawerOpen(false);
    const tabKey = projectSurfaceTabKey(kind, tabId);
    setSelectedProjectId(projectId);
    setPendingSurfaceSelection({ projectId, tabKey });
    setMobileTabGridOpen(false);
    setChatConsoleChatId(null);
    void queryClient.invalidateQueries({
      queryKey: ["project-tab-layout", projectId],
    });
    setShowImporter(false);
    setShowSettings(false);
    setShowServerAdmin(false);
    setShowProjectSettings(false);
    setSelectedWorkflowIntentId(null);
  };

  const openProjectSettings = (
    projectId: string,
    workflowId: string | null = null,
  ) => {
    setDesktopSidebarDrawerOpen(false);
    setSelectedProjectId(projectId);
    setChatConsoleChatId(null);
    setShowImporter(false);
    setShowSettings(false);
    setShowServerAdmin(false);
    setShowProjectSettings(true);
    setSelectedWorkflowIntentId(workflowId);
    setMobileTabGridOpen(false);
  };

  const openTunnelOwner = (tunnel: TunnelSummary) => {
    if (!tunnel.managedBy || !tunnel.projectId) return;
    if (tunnel.managedBy.kind === "browser") {
      openCreatedTab(tunnel.projectId, "browser", tunnel.managedBy.id);
      return;
    }
    if (tunnel.managedBy.kind === "code") {
      openCreatedTab(tunnel.projectId, "code", tunnel.managedBy.id);
      return;
    }
    openProjectSettings(
      tunnel.projectId,
      tunnel.managedBy.kind === "workflow" ? tunnel.managedBy.id : null,
    );
  };

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
  const saveMobileBottomTabs = useMutation({
    mutationFn: async ({
      groupIds,
      projectId,
    }: {
      groupIds: (string | null)[];
      projectId: string;
    }) =>
      updateSettings({
        mobileProjectTabConfigurations: {
          [projectId]: groupIds,
        },
      }),
    onError: (error) => {
      clientLogger.warn("Mobile project tab state failed to save", {
        ...operationalErrorMetadata(error),
        event: "tabs.mobile.save.failed",
        operation: "save-layout",
        reasonCode: "request-failed",
        status: "rolled-back",
        subsystem: "tabs",
      });
    },
    onSuccess: (bundle) => queryClient.setQueryData(["settings"], bundle),
    retry: 2,
    scope: { id: "mobile-project-tab-configurations" },
  });
  const saveSidebarWidth = useMutation({
    mutationFn: (width: number) => updateSettings({ sidebarWidth: width }),
    onSuccess: (bundle) => queryClient.setQueryData(["settings"], bundle),
    onError: (error) => {
      clientLogger.warn("Sidebar width failed to save", {
        ...operationalErrorMetadata(error),
        event: "settings.sidebar-width.save.failed",
        operation: "save-setting",
        reasonCode: "request-failed",
        status: "rolled-back",
        subsystem: "settings",
      });
    },
  });
  const projects = useQuery({
    queryFn: getProjects,
    queryKey: ["projects"],
    refetchInterval: (query) =>
      query.state.data?.some((project) => project.setupStatus === "cloning")
        ? 3_000
        : projectResourcesLive
          ? false
          : 15_000,
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
    bootstrap.isSuccess,
    projects.data,
    projects.isSuccess,
    settings.isSuccess,
    workers.data,
    workers.isSuccess,
  ]);
  const cloningProjectIds = (projects.data ?? [])
    .filter((project) => project.setupStatus === "cloning")
    .map((project) => project.id);
  const projectSetupJobQueries = useQueries({
    queries: cloningProjectIds.map((projectId) => ({
      queryFn: () => getProjectReplicaJobs(projectId),
      queryKey: ["project-replica-jobs", projectId],
      refetchInterval: projectResourcesLive ? false : 2_000,
    })),
  });
  const projectSetupJobs = new Map<string, ProjectReplicaJobSummary>();
  cloningProjectIds.forEach((projectId, index) => {
    const job = latestProjectProvisionJob(projectSetupJobQueries[index]?.data);
    if (job) projectSetupJobs.set(projectId, job);
  });
  const projectWorkspaces = useQuery({
    queryFn: getProjectWorkspaces,
    queryKey: ["project-workspaces"],
  });
  const createWorkspaceMutation = useMutation({
    mutationFn: (name: string) => createProjectWorkspace({ name }),
    onSuccess: (workspace) => {
      queryClient.setQueryData<ProjectWorkspaceSummary[]>(
        ["project-workspaces"],
        (current = []) => [...current, workspace],
      );
      setActiveProjectWorkspaceId(workspace.id);
      window.localStorage.setItem(
        activeProjectWorkspaceStorageKey,
        workspace.id,
      );
      setSelectedProjectId(null);
      setWorkspaceSelection(emptyWorkspaceSelection());
      resetMobileBottomTabs();
      setShowImporter(!compactShell);
      setShowSettings(false);
      setShowServerAdmin(false);
      setShowProjectSettings(false);
    },
  });
  const tabLayout = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getProjectTabLayout(selectedProjectId!),
    queryKey: ["project-tab-layout", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 10_000,
  });
  const worktrees = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getProjectWorktrees(selectedProjectId!),
    queryKey: ["worktrees", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 15_000,
  });
  const worktreeStatusQueries = useQueries({
    queries: (worktrees.data ?? []).map((worktree) => ({
      enabled: worktree.lifecycleState === "ready",
      queryFn: () =>
        getProjectWorktreeStatus(worktree.projectId, worktree.id).then(
          ({ status }) => status,
        ),
      queryKey: ["worktree-status", worktree.projectId, worktree.id],
      refetchInterval:
        projectResourcesLive ||
        !workers.data?.find(({ workerId }) => workerId === worktree.workerId)
          ?.online
          ? false
          : 15_000,
      retry: false,
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
      !worktrees.isSuccess ||
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
        tabGroups: tabLayout.data.groups.length,
        terminals: terminals.data.length,
        views: projectViews.data.length,
        worktrees: worktrees.data.length,
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
      Boolean(
        projects.data?.some(
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
    enabled: Boolean(selectedProjectId) && projectOverviewSelected,
    queryFn: () => getProjectTokenUsage(selectedProjectId!),
    queryKey: ["project-token-usage", selectedProjectId],
    refetchInterval: 15_000,
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
  const newChat = useMutation({
    mutationFn: ({
      projectId,
      tabGroupId,
      worktreeId,
      worktreeMode,
      target,
    }: {
      open?: boolean;
      projectId: string;
      tabGroupId?: string;
      worktreeId?: string;
      worktreeMode?: "agent-managed" | "pinned";
      target?: ExecutionTarget;
    }) =>
      createChat(
        projectId,
        "New agent",
        worktreeId,
        worktreeMode,
        tabGroupId,
        target,
      ),
    onSuccess: (chat, { open }) => {
      queryClient.setQueryData<ChatSummary[]>(
        ["chats", chat.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== chat.id), chat].sort(
            (left, right) => left.position - right.position,
          ),
      );
      if (open !== false) {
        openCreatedTab(chat.projectId, "chat", chat.id);
      } else {
        void queryClient.invalidateQueries({
          queryKey: ["project-tab-layout", chat.projectId],
        });
      }
      void queryClient.invalidateQueries({
        queryKey: ["chats", chat.projectId],
      });
    },
  });
  const newTask = useMutation({
    mutationFn: ({
      projectId,
      tabGroupId,
      worktreeId,
      worktreeMode,
      target,
    }: {
      projectId: string;
      tabGroupId?: string;
      worktreeId?: string;
      worktreeMode?: "agent-managed" | "pinned";
      target?: ExecutionTarget;
    }) =>
      createTask(
        projectId,
        "New task",
        worktreeId,
        worktreeMode,
        tabGroupId,
        target,
      ),
    onSuccess: ({ chat, task }) => {
      queryClient.setQueryData<ChatSummary[]>(
        ["chats", chat.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== chat.id), chat].sort(
            (left, right) => left.position - right.position,
          ),
      );
      queryClient.setQueryData(["task", chat.id], task);
      setTaskChatViewIds((current) => {
        const next = new Set(current);
        next.delete(chat.id);
        return next;
      });
      openCreatedTab(chat.projectId, "chat", chat.id);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["chats", chat.projectId] }),
        queryClient.invalidateQueries({
          queryKey: ["project-tab-layout", chat.projectId],
        }),
      ]);
    },
  });
  const newTerminal = useMutation({
    mutationFn: ({
      projectId,
      directoryPath,
      tabGroupId,
      title,
      worktreeId,
      target,
    }: {
      projectId: string;
      directoryPath?: string;
      tabGroupId?: string;
      title?: string;
      worktreeId?: string;
      target?: ExecutionTarget;
    }) =>
      createTerminal(
        projectId,
        title ?? "Terminal",
        worktreeId,
        tabGroupId,
        target,
        directoryPath,
      ),
    onSuccess: (terminal) => {
      queryClient.setQueryData<TerminalSummary[]>(
        ["terminals", terminal.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== terminal.id), terminal].sort(
            (left, right) => left.position - right.position,
          ),
      );
      openCreatedTab(terminal.projectId, "terminal", terminal.id);
      void queryClient.invalidateQueries({
        queryKey: ["terminals", terminal.projectId],
      });
    },
  });
  const openChatConsole = useMutation({
    mutationFn: (chatId: string) => createChatConsole(chatId),
    onError: (error, chatId) => {
      clientLogger.error("Codex console failed to open", {
        chatId,
        ...operationalErrorMetadata(error),
        event: "surface.codex-console.open.failed",
        operation: "open-console",
        reasonCode: "request-failed",
        status: "failed",
        subsystem: "codex-console",
      });
    },
    onSuccess: (terminal) => {
      queryClient.setQueryData<TerminalSummary[]>(
        ["terminals", terminal.projectId],
        (current = []) => [
          ...current.filter((item) => item.id !== terminal.id),
          terminal,
        ],
      );
      setChatConsoleChatId(terminal.linkedChatId);
    },
  });
  const newExplorer = useMutation({
    mutationFn: ({
      projectId,
      tabGroupId,
      worktreeId,
      target,
    }: {
      projectId: string;
      tabGroupId?: string;
      worktreeId?: string;
      target?: ExecutionTarget;
    }) => createExplorer(projectId, "Explorer", worktreeId, tabGroupId, target),
    onSuccess: (explorer) => {
      queryClient.setQueryData<ExplorerSummary[]>(
        ["explorers", explorer.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== explorer.id), explorer].sort(
            (left, right) => left.position - right.position,
          ),
      );
      openCreatedTab(explorer.projectId, "explorer", explorer.id);
      void queryClient.invalidateQueries({
        queryKey: ["explorers", explorer.projectId],
      });
    },
  });
  const newBrowser = useMutation({
    mutationFn: ({
      projectId,
      tabGroupId,
      target,
      title,
      url,
    }: {
      projectId: string;
      tabGroupId?: string;
      target?: ExecutionTarget;
      title?: string;
      url?: string;
    }) => createBrowser(projectId, title ?? "Browser", tabGroupId, target, url),
    onSuccess: (browser) => {
      queryClient.setQueryData<BrowserSummary[]>(
        ["browsers", browser.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== browser.id), browser].sort(
            (left, right) => left.position - right.position,
          ),
      );
      openCreatedTab(browser.projectId, "browser", browser.id);
      void queryClient.invalidateQueries({
        queryKey: ["browsers", browser.projectId],
      });
    },
  });
  const newCodeTab = useMutation({
    mutationFn: ({
      projectId,
      tabGroupId,
      worktreeId,
      target,
    }: {
      projectId: string;
      tabGroupId?: string;
      worktreeId?: string;
      target?: ExecutionTarget;
    }) => createCodeTab(projectId, "Code", worktreeId, tabGroupId, target),
    onSuccess: (codeTab) => {
      queryClient.setQueryData<CodeTabSummary[]>(
        ["code-tabs", codeTab.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== codeTab.id), codeTab].sort(
            (left, right) => left.position - right.position,
          ),
      );
      openCreatedTab(codeTab.projectId, "code", codeTab.id);
      void queryClient.invalidateQueries({
        queryKey: ["code-tabs", codeTab.projectId],
      });
    },
  });
  const newProjectView = useMutation({
    mutationFn: ({
      projectId,
      kind,
      tabGroupId,
      worktreeId,
    }: {
      projectId: string;
      kind: ProjectViewKind;
      tabGroupId?: string;
      worktreeId?: string;
    }) =>
      createProjectView(
        projectId,
        kind,
        kind === "history"
          ? "Git"
          : kind === "issues"
            ? "Issues"
            : "Remote Desktop",
        worktreeId,
        tabGroupId,
      ),
    onSuccess: (view) => {
      queryClient.setQueryData<ProjectViewSummary[]>(
        ["project-views", view.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== view.id), view].sort(
            (left, right) => left.position - right.position,
          ),
      );
      openCreatedTab(view.projectId, "view", view.id);
      void queryClient.invalidateQueries({
        queryKey: ["project-views", view.projectId],
      });
    },
  });
  const bindWorktreeMutation = useMutation({
    mutationFn: async ({
      target,
      worktreeId,
      mode,
    }: {
      target: WorktreeBindingTarget;
      worktreeId: string;
      mode?: "agent-managed" | "pinned";
    }) => {
      if (target.kind === "chat") {
        return {
          kind: "chat" as const,
          value: await updateChatWorktree(target.tabId, {
            worktreeId,
            mode: mode ?? target.mode,
          }),
        };
      }
      if (target.kind === "terminal") {
        return {
          kind: "terminal" as const,
          value: await updateTerminalWorktree(target.tabId, worktreeId),
        };
      }
      if (target.kind === "explorer") {
        return {
          kind: "explorer" as const,
          value: await updateExplorerWorktree(target.tabId, worktreeId),
        };
      }
      if (target.kind === "code") {
        return {
          kind: "code" as const,
          value: await updateCodeTabWorktree(target.tabId, worktreeId),
        };
      }
      return {
        kind: "history" as const,
        value: await updateProjectViewWorktree(target.tabId, worktreeId),
      };
    },
    onMutate: async ({ target, worktreeId, mode }) => {
      setWorktreeActionError(null);
      if (target.kind !== "chat") return {};
      const queryKey = ["chats", target.projectId] as const;
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ChatSummary[]>(queryKey);
      queryClient.setQueryData<ChatSummary[]>(queryKey, (current = []) =>
        current.map((chat) =>
          chat.id === target.tabId
            ? {
                ...chat,
                activeWorktreeId: worktreeId,
                worktreeMode: mode ?? target.mode,
              }
            : chat,
        ),
      );
      return { previous, queryKey };
    },
    onSuccess: ({ kind, value }) => {
      if (kind === "chat") {
        queryClient.setQueryData<ChatSummary[]>(
          ["chats", value.projectId],
          (current = []) =>
            current.map((chat) => (chat.id === value.id ? value : chat)),
        );
        void queryClient.invalidateQueries({
          queryKey: ["terminals", value.projectId],
        });
      } else if (kind === "terminal") {
        queryClient.setQueryData<TerminalSummary[]>(
          ["terminals", value.projectId],
          (current = []) =>
            current.map((terminal) =>
              terminal.id === value.id ? value : terminal,
            ),
        );
      } else if (kind === "explorer") {
        queryClient.setQueryData<ExplorerSummary[]>(
          ["explorers", value.projectId],
          (current = []) =>
            current.map((explorer) =>
              explorer.id === value.id ? value : explorer,
            ),
        );
        void Promise.all([
          queryClient.invalidateQueries({
            queryKey: ["explorer-directory", value.id],
          }),
          queryClient.invalidateQueries({
            queryKey: ["explorer-file", value.id],
          }),
        ]);
      } else if (kind === "code") {
        queryClient.setQueryData<CodeTabSummary[]>(
          ["code-tabs", value.projectId],
          (current = []) =>
            current.map((codeTab) =>
              codeTab.id === value.id ? value : codeTab,
            ),
        );
      } else {
        queryClient.setQueryData<ProjectViewSummary[]>(
          ["project-views", value.projectId],
          (current = []) =>
            current.map((view) => (view.id === value.id ? value : view)),
        );
      }
    },
    onError: (error, input, context) => {
      if (context?.queryKey) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
      if (input.target.kind === "history") {
        void queryClient.invalidateQueries({
          queryKey: ["project-views", input.target.projectId],
        });
      }
      if (input.target.kind === "code") {
        void queryClient.invalidateQueries({
          queryKey: ["code-tabs", input.target.projectId],
        });
      }
      setWorktreeActionError(errorText(error));
    },
  });
  const prepareExplorerRebind = async (target: WorktreeBindingTarget) => {
    if (target.kind !== "explorer") return true;
    const lifecycle = explorerLifecycleRef.current.get(target.tabId);
    const result = await prepareExplorerRebindLifecycle(lifecycle, () =>
      window.confirm(
        "Switch this Explorer to another worktree and discard its unsaved changes?",
      ),
    );
    if (result === "state-failed") {
      setWorktreeActionError(
        "Explorer view state could not be saved before switching worktrees.",
      );
    }
    return result === "ready";
  };
  const requestBindWorktree = async (input: {
    target: WorktreeBindingTarget;
    worktreeId: string;
    mode?: "agent-managed" | "pinned";
  }) => {
    if (!(await prepareExplorerRebind(input.target))) return false;
    try {
      await bindWorktreeMutation.mutateAsync(input);
      return true;
    } catch {
      return false;
    }
  };
  const createWorktreeMutation = useMutation({
    mutationFn: ({
      projectId,
      input,
    }: {
      projectId: string;
      input: ProjectWorktreeCreate;
    }) => createProjectWorktree(projectId, input),
    onSuccess: (created) => {
      queryClient.setQueryData<ProjectWorktreeSummary[]>(
        ["worktrees", created.projectId],
        (current = []) => [
          ...current.filter((worktree) => worktree.id !== created.id),
          created,
        ],
      );
    },
  });
  const newRemoteDesktop = useMutation({
    mutationFn: ({
      projectId,
      tabGroupId,
      target,
      desktopTarget,
    }: {
      projectId: string;
      tabGroupId?: string;
      target?: ExecutionTarget;
      desktopTarget?: RemoteDesktopTarget;
    }) => createRemoteDesktop(projectId, tabGroupId, target, desktopTarget),
    onSuccess: (desktop) => {
      queryClient.setQueryData<ProjectViewSummary[]>(
        ["project-views", desktop.projectId],
        (current = []) =>
          [
            ...current.filter((item) => item.id !== desktop.id),
            {
              id: desktop.id,
              projectId: desktop.projectId,
              title: desktop.title,
              kind: "remote-desktop" as const,
              worktreeId: null,
              position: desktop.position,
              createdAt: desktop.createdAt,
              updatedAt: desktop.updatedAt,
            },
          ].sort((left, right) => left.position - right.position),
      );
      queryClient.setQueryData(["remote-desktop", desktop.id], desktop);
      void queryClient.invalidateQueries({
        queryKey: ["remote-desktop-fleet", desktop.projectId],
      });
      openCreatedTab(desktop.projectId, "view", desktop.id);
      void queryClient.invalidateQueries({
        queryKey: ["project-views", desktop.projectId],
      });
    },
  });
  const renameChatMutation = useMutation({
    mutationFn: ({ chatId, title }: { chatId: string; title: string }) =>
      renameChat(chatId, title),
    onSuccess: (renamed) =>
      queryClient.setQueryData<ChatSummary[]>(
        ["chats", renamed.projectId],
        (current = []) =>
          current.map((chat) => (chat.id === renamed.id ? renamed : chat)),
      ),
  });
  const forkChatMutation = useMutation({
    mutationFn: (chatId: string) => forkChat(chatId),
    onSuccess: async (forked) => {
      await queryClient.invalidateQueries({
        queryKey: ["chats", forked.projectId],
      });
      openCreatedTab(forked.projectId, "chat", forked.id);
    },
  });
  const deleteChatMutation = useMutation({
    mutationFn: deleteChat,
    onSuccess: async (_value, deletedId) => {
      if (selectedChatId === deletedId) setChatConsoleChatId(null);
      setTaskChatViewIds((current) => {
        const next = new Set(current);
        next.delete(deletedId);
        return next;
      });
      await queryClient.invalidateQueries({
        queryKey: ["chats", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["archived-chats", selectedProjectId],
      });
    },
  });
  const renameTerminalMutation = useMutation({
    mutationFn: ({
      terminalId,
      title,
    }: {
      terminalId: string;
      title: string;
    }) => renameTerminal(terminalId, title),
    onSuccess: (renamed) =>
      queryClient.setQueryData<TerminalSummary[]>(
        ["terminals", renamed.projectId],
        (current = []) =>
          current.map((terminal) =>
            terminal.id === renamed.id ? renamed : terminal,
          ),
      ),
  });
  const deleteTerminalMutation = useMutation({
    mutationFn: deleteTerminal,
    onSuccess: async (_value, deletedId) => {
      if (terminalServiceTerminalId === deletedId) {
        setTerminalServiceTerminalId(null);
      }
      await queryClient.invalidateQueries({
        queryKey: ["terminals", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", selectedProjectId],
      });
    },
  });
  const renameExplorerMutation = useMutation({
    mutationFn: ({
      explorerId,
      title,
    }: {
      explorerId: string;
      title: string;
    }) => renameExplorer(explorerId, title),
    onSuccess: (renamed) =>
      queryClient.setQueryData<ExplorerSummary[]>(
        ["explorers", renamed.projectId],
        (current = []) =>
          current.map((explorer) =>
            explorer.id === renamed.id ? renamed : explorer,
          ),
      ),
  });
  const deleteExplorerMutation = useMutation({
    mutationFn: deleteExplorer,
    onSuccess: async (_value, deletedId) => {
      explorerLifecycleRef.current.delete(deletedId);
      await queryClient.invalidateQueries({
        queryKey: ["explorers", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", selectedProjectId],
      });
    },
  });
  const requestDeleteExplorer = (explorerId: string) => {
    const lifecycle = explorerLifecycleRef.current.get(explorerId);
    if (
      !confirmExplorerDiscard(lifecycle, () =>
        window.confirm(
          "Delete this Explorer and discard its unsaved file changes?",
        ),
      )
    ) {
      return;
    }
    deleteExplorerMutation.mutate(explorerId);
  };
  const updateBrowserMutation = useMutation({
    mutationFn: ({
      browserId,
      input,
    }: {
      browserId: string;
      input: { title?: string; url?: string };
    }) => updateBrowser(browserId, input),
    onSuccess: (updated) =>
      queryClient.setQueryData<BrowserSummary[]>(
        ["browsers", updated.projectId],
        (current = []) =>
          current.map((browser) =>
            browser.id === updated.id ? updated : browser,
          ),
      ),
  });
  const deleteBrowserMutation = useMutation({
    mutationFn: deleteBrowser,
    onSuccess: async (_value, deletedId) => {
      await queryClient.invalidateQueries({
        queryKey: ["browsers", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", selectedProjectId],
      });
    },
  });
  const updateCodeTabMutation = useMutation({
    mutationFn: ({ codeTabId, title }: { codeTabId: string; title: string }) =>
      updateCodeTab(codeTabId, { title }),
    onSuccess: (updated) =>
      queryClient.setQueryData<CodeTabSummary[]>(
        ["code-tabs", updated.projectId],
        (current = []) =>
          current.map((codeTab) =>
            codeTab.id === updated.id ? updated : codeTab,
          ),
      ),
  });
  const deleteCodeTabMutation = useMutation({
    mutationFn: deleteCodeTab,
    onSuccess: async (_value, deletedId) => {
      await queryClient.invalidateQueries({
        queryKey: ["code-tabs", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", selectedProjectId],
      });
    },
  });
  const renameProjectViewMutation = useMutation({
    mutationFn: ({ viewId, title }: { viewId: string; title: string }) =>
      renameProjectView(viewId, title),
    onSuccess: (renamed) =>
      queryClient.setQueryData<ProjectViewSummary[]>(
        ["project-views", renamed.projectId],
        (current = []) =>
          current.map((view) => (view.id === renamed.id ? renamed : view)),
      ),
  });
  const deleteProjectViewMutation = useMutation({
    mutationFn: deleteProjectView,
    onSuccess: async (_value, deletedId) => {
      await queryClient.invalidateQueries({
        queryKey: ["project-views", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", selectedProjectId],
      });
    },
  });
  const removeProjectMutation = useMutation({
    mutationFn: ({
      projectId,
      deleteLocalFiles,
    }: {
      projectId: string;
      deleteLocalFiles: boolean;
    }) => removeProject(projectId, deleteLocalFiles),
    onSuccess: async (_value, { projectId }) => {
      if (selectedProjectId === projectId) {
        setSelectedProjectId(null);
        setWorkspaceSelection(emptyWorkspaceSelection());
        setPendingSurfaceSelection(null);
        setChatConsoleChatId(null);
        setShowProjectSettings(false);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({ queryKey: ["project-workspaces"] }),
        queryClient.invalidateQueries({ queryKey: ["github-repositories"] }),
      ]);
    },
  });
  const reorderProjectsMutation = useMutation({
    mutationFn: (ids: string[]) => reorderProjects(ids),
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: ["projects"] });
      const previous = queryClient.getQueryData<ProjectSummary[]>(["projects"]);
      queryClient.setQueryData<ProjectSummary[]>(["projects"], (current = []) =>
        ids.flatMap((id, position) => {
          const project = current.find((item) => item.id === id);
          return project ? [{ ...project, position }] : [];
        }),
      );
      return { previous };
    },
    onError: (_error, _ids, context) =>
      queryClient.setQueryData(["projects"], context?.previous),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["projects"] }),
  });
  const tabLayoutMutation = useMutation({
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
      if (command.type === "reorder-groups") {
        return reorderProjectTabGroups(
          projectId,
          current.revision,
          command.groupIds,
        );
      }
      if (command.type === "reorder-members") {
        return reorderProjectTabGroupMembers(
          projectId,
          command.groupId,
          current.revision,
          command.tabKeys,
        );
      }
      return moveProjectTabGroupMember(projectId, {
        revision: current.revision,
        tabKey: command.tabKey,
        targetGroupId: command.targetGroupId,
        targetMemberPosition: command.targetMemberPosition,
        ...(command.targetGroupPosition === undefined
          ? {}
          : { targetGroupPosition: command.targetGroupPosition }),
      });
    },
    onMutate: async ({ command, projectId }) => {
      setWorkspaceDragError(null);
      const queryKey = ["project-tab-layout", projectId] as const;
      await queryClient.cancelQueries({ queryKey });
      return applyOptimisticTabLayoutToCache(queryClient, projectId, command);
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

  const onlineWorker = workers.data?.find((worker) => worker.online) ?? null;
  const activeProjectWorkspace = resolveProjectWorkspace(
    projectWorkspaces.data ?? [],
    activeProjectWorkspaceId,
  );
  const visibleProjects = useMemo(
    () => projectsInWorkspace(projects.data ?? [], activeProjectWorkspace),
    [activeProjectWorkspace, projects.data],
  );
  const selectedProject = projects.data?.find(
    (project) => project.id === selectedProjectId,
  );
  const selectedProjectSetupJob = selectedProject
    ? projectSetupJobs.get(selectedProject.id)
    : undefined;
  const mobileProjectSelectorOpen =
    compactShell &&
    selectedProjectId === null &&
    !showImporter &&
    !showSettings &&
    !showServerAdmin &&
    !showProjectSettings;
  const compactManagedHeader =
    compactShell &&
    (mobileProjectSelectorOpen ||
      showImporter ||
      showSettings ||
      showServerAdmin ||
      showProjectSettings ||
      mobileTabGridOpen ||
      (projectOverviewSelected && Boolean(selectedProject)));
  const projectSurfaceIndex = useMemo(
    () =>
      buildProjectSurfaceIndex(tabLayout.data, {
        browsers: browsers.data ?? [],
        chats: chats.data ?? [],
        codeTabs: codeTabs.data ?? [],
        explorers: explorers.data ?? [],
        projectViews: projectViews.data ?? [],
        terminals: terminals.data ?? [],
      }),
    [
      browsers.data,
      chats.data,
      codeTabs.data,
      explorers.data,
      projectViews.data,
      tabLayout.data,
      terminals.data,
    ],
  );
  const selectedSurface = selectedTabKey
    ? projectSurfaceIndex.byTabKey.get(selectedTabKey)
    : undefined;
  const validMobileGroupIds = useMemo(
    () =>
      new Set(
        tabLayout.data?.projectId === selectedProjectId
          ? tabLayout.data.groups.map(({ id }) => id)
          : [],
      ),
    [selectedProjectId, tabLayout.data],
  );
  const projectSurfaces = useMemo(
    () => [...projectSurfaceIndex.byTabKey.values()],
    [projectSurfaceIndex],
  );
  const selectedTabGroup = tabLayout.data?.groups.find(
    (group) => group.id === workspaceSelection.selectedGroupId,
  );
  const selectedGroupSurfaces = workspaceSelection.selectedGroupId
    ? (projectSurfaceIndex.byGroupId.get(workspaceSelection.selectedGroupId) ??
      [])
    : [];
  const activeMobileBottomTab = mobileBottomTabs.find(
    ({ id }) => id === activeMobileBottomTabId,
  );
  const mobileBottomNavigationItems = mobileBottomTabs.map((tab) => {
    const group = tabLayout.data?.groups.find(({ id }) => id === tab.groupId);
    const tabKey = group
      ? (workspaceSelection.activeTabByGroup[group.id] ?? group.anchorTabKey)
      : null;
    return {
      id: tab.id,
      surface: tabKey ? projectSurfaceIndex.byTabKey.get(tabKey) : undefined,
    };
  });
  const selectedProjectView =
    selectedSurface?.kind === "history" ||
    selectedSurface?.kind === "issues" ||
    selectedSurface?.kind === "remote-desktop"
      ? selectedSurface.entity
      : undefined;
  const gitHistoryProject =
    selectedProjectView?.kind === "history" ||
    selectedProjectView?.kind === "issues"
      ? selectedProject
      : undefined;
  const selectedChat =
    selectedSurface?.kind === "chat" ? selectedSurface.entity : undefined;
  const selectedTaskView = Boolean(
    selectedChat?.experience === "task" &&
    !taskChatViewIds.has(selectedChat.id),
  );
  const setSelectedTaskView = (view: "task" | "chat") => {
    if (selectedChat?.experience !== "task") return;
    setTaskChatViewIds((current) => {
      const next = new Set(current);
      if (view === "chat") next.add(selectedChat.id);
      else next.delete(selectedChat.id);
      return next;
    });
  };
  const selectedStandaloneTerminal =
    selectedSurface?.kind === "terminal" ? selectedSurface.entity : undefined;
  const linkedConsoleTerminal =
    selectedChat && chatConsoleChatId === selectedChat.id
      ? terminals.data?.find(
          (terminal) => terminal.linkedChatId === selectedChat.id,
        )
      : undefined;
  const selectedTerminal = selectedStandaloneTerminal ?? linkedConsoleTerminal;
  const linkedConsoleChat = linkedConsoleTerminal ? selectedChat : undefined;
  const activeChat = selectedChat;
  const chatRelocations = useQuery({
    enabled: Boolean(
      activeChat && bootstrap.data?.capabilities.workerSwitching,
    ),
    queryFn: () => getChatRelocations(activeChat!.id),
    queryKey: ["chat-relocation-jobs", activeChat?.id],
    refetchInterval: (query) =>
      projectResourcesLive
        ? false
        : query.state.data?.some((job) => isChatRelocationActive(job))
          ? 2_000
          : 10_000,
    retry: false,
  });
  const activeRelocation = activeChatRelocationJob(chatRelocations.data ?? []);
  const latestRelocation = latestChatRelocationJob(chatRelocations.data ?? []);
  const currentRelocation = activeRelocation ?? latestRelocation;
  const selectedExplorer =
    selectedSurface?.kind === "explorer" ? selectedSurface.entity : undefined;
  const selectedBrowser =
    selectedSurface?.kind === "browser" ? selectedSurface.entity : undefined;
  const selectedCodeTab =
    selectedSurface?.kind === "code" ? selectedSurface.entity : undefined;
  const activeWorktreeTarget: WorktreeBindingTarget | null = activeChat
    ? {
        kind: "chat",
        projectId: activeChat.projectId,
        tabId: activeChat.id,
        mode: activeChat.worktreeMode,
      }
    : selectedTerminal
      ? {
          kind: "terminal",
          projectId: selectedTerminal.projectId,
          tabId: selectedTerminal.id,
        }
      : selectedExplorer
        ? {
            kind: "explorer",
            projectId: selectedExplorer.projectId,
            tabId: selectedExplorer.id,
          }
        : selectedCodeTab
          ? {
              kind: "code",
              projectId: selectedCodeTab.projectId,
              tabId: selectedCodeTab.id,
            }
          : selectedProjectView?.kind === "history"
            ? {
                kind: "history",
                projectId: selectedProjectView.projectId,
                tabId: selectedProjectView.id,
              }
            : null;
  const activeWorktreeId = activeChat
    ? activeChat.activeWorktreeId
    : selectedTerminal
      ? selectedTerminal.worktreeId
      : selectedExplorer
        ? selectedExplorer.worktreeId
        : selectedCodeTab
          ? selectedCodeTab.worktreeId
          : selectedProjectView?.kind === "history"
            ? selectedProjectView.worktreeId
            : null;
  const activeWorktree = worktrees.data?.find(
    (worktree) => worktree.id === activeWorktreeId,
  );
  const selectedWorkerId =
    selectedProjectView?.kind === "remote-desktop"
      ? remoteDesktop.data?.workerId
      : (selectedCodeTab?.activeWorkerId ??
        selectedBrowser?.workerId ??
        activeWorktree?.workerId ??
        selectedProject?.source?.workerId);
  const selectedWorker = workers.data?.find(
    (worker) => worker.workerId === selectedWorkerId,
  );
  const explorerDisplayPath = selectedExplorer
    ? `${activeWorktree?.displayPath ?? selectedProject?.source?.displayPath ?? "Explorer"}${explorerHeader?.directoryPath ? `/${explorerHeader.directoryPath}` : ""}`
    : null;
  const bindChatWorktree = (
    chat: ChatSummary,
    worktreeId: string,
    mode = chat.worktreeMode,
  ) =>
    bindWorktreeMutation.mutate({
      target: {
        kind: "chat",
        projectId: chat.projectId,
        tabId: chat.id,
        mode: chat.worktreeMode,
      },
      worktreeId,
      mode,
    });
  const openChatTerminalHere = (chat: ChatSummary) =>
    newTerminal.mutate({
      projectId: chat.projectId,
      worktreeId: chat.activeWorktreeId,
    });
  const openChatExplorerHere = (chat: ChatSummary) =>
    newExplorer.mutate({
      projectId: chat.projectId,
      worktreeId: chat.activeWorktreeId,
    });
  const openChatHistoryHere = (chat: ChatSummary) =>
    newProjectView.mutate({
      projectId: chat.projectId,
      kind: "history",
      worktreeId: chat.activeWorktreeId,
    });
  const currentSurface = useMemo<{
    tabKey: string;
    title: string;
  } | null>(() => {
    if (
      showImporter ||
      showSettings ||
      showServerAdmin ||
      showProjectSettings
    ) {
      return null;
    }
    if (!selectedSurface) return null;
    return {
      tabKey: selectedSurface.tabKey,
      title:
        selectedSurface.kind === "chat" && linkedConsoleTerminal
          ? `${selectedSurface.title} · Codex console`
          : selectedSurface.title,
    };
  }, [
    linkedConsoleTerminal,
    selectedSurface,
    showImporter,
    showProjectSettings,
    showServerAdmin,
    showSettings,
  ]);
  const activePopout =
    desktopRuntime &&
    !isPopout &&
    currentSurface &&
    selectedProject &&
    selectedTabGroup
      ? {
          target: {
            activeTabKey: currentSurface.tabKey,
            groupId: selectedTabGroup.id,
            projectId: selectedProject.id,
          },
          title: currentSurface.title,
        }
      : null;
  const groupOwnedElsewhere =
    !isPopout &&
    detachedGroupId !== null &&
    detachedGroupId === selectedTabGroup?.id;
  const activeContentKey = showImporter
    ? "importer"
    : showSettings
      ? "settings"
      : showServerAdmin
        ? "server-admin"
        : showProjectSettings
          ? `project-settings:${selectedProjectId ?? "none"}`
          : currentSurface
            ? `${currentSurface.tabKey}:${gitHistoryHeader?.section ?? "content"}`
            : `project:${selectedProjectId ?? "none"}`;
  const resumeDetachedGroup = useCallback(
    async (groupId: string) => {
      const explorerId = detachedExplorerIdRef.current;
      try {
        if (explorerId && selectedProjectId) {
          const refreshed = await getExplorers(selectedProjectId);
          queryClient.setQueryData(["explorers", selectedProjectId], refreshed);
          const persisted = refreshed.find(({ id }) => id === explorerId);
          const lifecycle = explorerLifecycleRef.current.get(explorerId);
          if (persisted && lifecycle) {
            await lifecycle.reconcile(persisted);
          } else {
            await queryClient.invalidateQueries({
              queryKey: ["explorer-file", explorerId],
            });
          }
        }
      } catch (error) {
        clientLogger.warn("Explorer state recovery after pop-out failed", {
          ...operationalErrorMetadata(error),
          event: "surface.explorer.popout-recovery.failed",
          operation: "recover-state",
          reasonCode: "refresh-failed",
          status: "failed",
          subsystem: "explorer",
          surfaceId: explorerId ?? undefined,
        });
      } finally {
        detachedExplorerIdRef.current = null;
        setDetachedGroupId((current) => (current === groupId ? null : current));
      }
    },
    [queryClient, selectedProjectId],
  );
  const popOutActiveView = () => {
    if (!activePopout || popoutPending) return;
    void (async () => {
      const startedAt = performance.now();
      clientLogger.info("Desktop pop-out preparation started", {
        event: "window.popout.open.started",
        operation: "open-popout",
        projectId: activePopout.target.projectId,
        subsystem: "desktop-window",
      });
      const explorerLifecycle = selectedExplorer
        ? explorerLifecycleRef.current.get(selectedExplorer.id)
        : null;
      const preparation = await prepareExplorerPopoutLifecycle(
        explorerLifecycle,
        () =>
          window.confirm(
            "This Explorer has unsaved changes. Save and continue opening it in a new window?\n\nChoose Cancel to keep editing in this window.",
          ),
      );
      if (preparation === "cancelled") return;
      if (preparation === "save-failed") {
        setPopoutError("Save the Explorer file before opening a pop-out.");
        return;
      }
      if (preparation === "state-failed") {
        setPopoutError(
          "Explorer view state could not be saved before opening the pop-out.",
        );
        return;
      }
      setPopoutPending(true);
      setPopoutError(null);
      try {
        await openDesktopPopoutGroup(activePopout.target, activePopout.title);
        detachedExplorerIdRef.current = selectedExplorer?.id ?? null;
        setDetachedGroupId(activePopout.target.groupId);
        clientLogger.info("Desktop pop-out opened", {
          durationMs: Math.round(performance.now() - startedAt),
          event: "window.popout.open.completed",
          operation: "open-popout",
          projectId: activePopout.target.projectId,
          status: "opened",
          subsystem: "desktop-window",
        });
      } catch (error) {
        clientLogger.error("Desktop pop-out failed to open", {
          durationMs: Math.round(performance.now() - startedAt),
          ...operationalErrorMetadata(error),
          event: "window.popout.open.failed",
          operation: "open-popout",
          projectId: activePopout.target.projectId,
          reasonCode: "native-window-error",
          status: "failed",
          subsystem: "desktop-window",
        });
        setPopoutError(errorText(error));
      } finally {
        setPopoutPending(false);
      }
    })();
  };

  useEffect(() => {
    setChatRelocationOpen(false);
  }, [activeChat?.id]);
  useEffect(() => {
    if (!isPopout || !currentSurface) return;
    const projectTitle =
      selectedProject?.github?.nameWithOwner ?? selectedProject?.name;
    const title = [currentSurface.title, projectTitle, "Cantrip"]
      .filter(Boolean)
      .join(" — ");
    void updateDesktopWindowTitle(title).catch((error: unknown) => {
      clientLogger.warn("Desktop pop-out title update failed", {
        ...operationalErrorMetadata(error),
        event: "window.popout.title.failed",
        operation: "set-title",
        reasonCode: "native-window-error",
        status: "failed",
        subsystem: "desktop-window",
      });
    });
  }, [currentSurface, isPopout, selectedProject]);
  useEffect(() => {
    if (!desktopRuntime || isPopout || !detachedGroupId) return;
    const observedGroupId = detachedGroupId;
    let mounted = true;
    let stopObserving: (() => void) | null = null;
    const resumeLocally = () => {
      if (!mounted) return;
      void resumeDetachedGroup(observedGroupId);
    };
    void watchDesktopPopoutGroup(observedGroupId, resumeLocally)
      .then((stop) => {
        if (mounted) stopObserving = stop;
        else stop();
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        clientLogger.warn("Desktop pop-out observer failed", {
          ...operationalErrorMetadata(error),
          event: "window.popout.observe.failed",
          operation: "observe-window",
          reasonCode: "native-window-error",
          status: "recovering",
          subsystem: "desktop-window",
        });
        resumeLocally();
      });
    return () => {
      mounted = false;
      stopObserving?.();
    };
  }, [desktopRuntime, detachedGroupId, isPopout, resumeDetachedGroup]);
  useEffect(() => {
    scrolledContentRef.current.clear();
    setContentScrolled(false);
  }, [activeContentKey]);
  useEffect(() => {
    const root = contentRootRef.current;
    if (!root || isPopout) return;
    const update = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || !root.contains(target)) return;
      const scrolled = scrolledContentRef.current;
      for (const candidate of scrolled) {
        if (!(candidate instanceof Node) || !root.contains(candidate)) {
          scrolled.delete(candidate);
        }
      }
      if (hasScrolledContent(target)) scrolled.add(target);
      else scrolled.delete(target);
      setContentScrolled(scrolled.size > 0);
    };
    root.addEventListener("scroll", update, true);
    return () => root.removeEventListener("scroll", update, true);
  }, [isPopout]);
  useEffect(() => {
    if (
      sidebarResizePointerIdRef.current !== null ||
      settings.data?.preferences.sidebarWidth === undefined
    ) {
      return;
    }
    const width = clampSidebarWidth(settings.data.preferences.sidebarWidth);
    sidebarWidthRef.current = width;
    setSidebarWidth(width);
  }, [settings.data?.preferences.sidebarWidth]);
  useEffect(
    () => () => {
      const previous = sidebarResizeBodyStyleRef.current;
      if (!previous) return;
      document.body.style.cursor = previous.cursor;
      document.body.style.userSelect = previous.userSelect;
    },
    [],
  );

  const applySidebarWidth = (width: number) => {
    const next = clampSidebarWidth(width);
    sidebarWidthRef.current = next;
    setSidebarWidth(next);
    return next;
  };

  const restoreSidebarResizeBodyStyle = () => {
    const previous = sidebarResizeBodyStyleRef.current;
    if (!previous) return;
    document.body.style.cursor = previous.cursor;
    document.body.style.userSelect = previous.userSelect;
    sidebarResizeBodyStyleRef.current = null;
  };

  const beginSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    sidebarResizePointerIdRef.current = event.pointerId;
    sidebarResizeLeftRef.current =
      sidebarRef.current?.getBoundingClientRect().left ?? 0;
    sidebarResizeStartWidthRef.current = sidebarWidthRef.current;
    sidebarResizeBodyStyleRef.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    event.currentTarget.setPointerCapture(event.pointerId);
    setSidebarResizing(true);
  };

  const moveSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (sidebarResizePointerIdRef.current !== event.pointerId) return;
    applySidebarWidth(
      sidebarWidthFromPointer(event.clientX, sidebarResizeLeftRef.current),
    );
  };

  const finishSidebarResize = (
    event: ReactPointerEvent<HTMLDivElement>,
    persist: boolean,
  ) => {
    if (sidebarResizePointerIdRef.current !== event.pointerId) return;
    sidebarResizePointerIdRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    restoreSidebarResizeBodyStyle();
    setSidebarResizing(false);
    if (!persist) {
      applySidebarWidth(sidebarResizeStartWidthRef.current);
      return;
    }
    if (sidebarWidthRef.current !== sidebarResizeStartWidthRef.current) {
      saveSidebarWidth.mutate(sidebarWidthRef.current);
    }
  };

  const resizeSidebarWithKeyboard = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const next = sidebarWidthFromKey(sidebarWidthRef.current, event.key);
    if (next === null) return;
    event.preventDefault();
    if (next === sidebarWidthRef.current) return;
    applySidebarWidth(next);
    saveSidebarWidth.mutate(next);
  };

  const showChatConsole = (chat: ChatSummary) => {
    const existing = terminals.data?.find(
      (terminal) => terminal.linkedChatId === chat.id,
    );
    if (existing) {
      setChatConsoleChatId(chat.id);
    } else {
      openChatConsole.mutate(chat.id);
    }
  };
  useEffect(() => {
    const preference = settings.data?.preferences.theme ?? "system";
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark =
        preference === "dark" || (preference === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.classList.toggle(
        "high-contrast",
        settings.data?.preferences.highContrast ?? false,
      );
      setCodeAppearance(
        codeAppearanceFor(
          dark,
          settings.data?.preferences.highContrast ?? false,
          proModeActive,
        ),
      );
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
      void updateDesktopWindowTheme(dark ? "dark" : "light").catch(
        (error: unknown) => {
          clientLogger.warn("Desktop window theme update failed", {
            ...operationalErrorMetadata(error),
            event: "window.theme.failed",
            operation: "set-theme",
            reasonCode: "native-window-error",
            status: "failed",
            subsystem: "desktop-window",
          });
        },
      );
    };
    apply();
    if (preference === "system") {
      media.addEventListener("change", apply);
      return () => media.removeEventListener("change", apply);
    }
  }, [
    settings.data?.preferences.highContrast,
    settings.data?.preferences.theme,
    proModeActive,
  ]);

  useEffect(() => {
    const opacity = settings.data?.preferences.proModeOpacity ?? 80;
    document.documentElement.style.setProperty(
      "--pro-mode-opacity",
      `${opacity}%`,
    );
  }, [settings.data?.preferences.proModeOpacity]);

  useEffect(() => {
    const requested = settings.data?.preferences.proMode ?? false;
    const supported = isMacosDesktopRuntime();
    let active = true;
    document.documentElement.classList.toggle(
      "pro-mode",
      supported && requested,
    );
    setProModeActive(supported && requested);
    if (!supported) return;
    void updateMacosProMode(requested)
      .then((enabled) => {
        if (active) {
          document.documentElement.classList.toggle("pro-mode", enabled);
          setProModeActive(enabled);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          document.documentElement.classList.remove("pro-mode");
          setProModeActive(false);
        }
        clientLogger.warn("macOS Pro Mode update failed", {
          ...operationalErrorMetadata(error),
          event: "window.pro-mode.failed",
          operation: "set-pro-mode",
          reasonCode: "native-window-error",
          status: "failed",
          subsystem: "desktop-window",
        });
      });
    return () => {
      active = false;
    };
  }, [settings.data?.preferences.proMode]);

  useEffect(() => {
    if (!projectWorkspaces.data?.length) return;
    const resolved =
      projectWorkspaces.data.find(
        ({ id }) => id === activeProjectWorkspaceId,
      ) ??
      projectWorkspaces.data.find(({ isDefault }) => isDefault) ??
      projectWorkspaces.data[0]!;
    if (resolved.id === activeProjectWorkspaceId) return;
    setActiveProjectWorkspaceId(resolved.id);
    window.localStorage.setItem(activeProjectWorkspaceStorageKey, resolved.id);
  }, [
    activeProjectWorkspaceId,
    activeProjectWorkspaceStorageKey,
    projectWorkspaces.data,
  ]);

  useEffect(() => {
    if (!projects.data) return;
    if (explorerFileTarget) return;
    const action = projectSelectionAction({
      compact: compactShell,
      preserveCurrentDestination: showServerAdmin || showSettings,
      projects: projects.data,
      selectedProjectId,
      visibleProjects,
    });
    if (!action) return;
    if (action.showImporter !== undefined) {
      setShowImporter(action.showImporter);
    }
    if (!compactShell && projects.data.length === 0) {
      setShowSettings(false);
      setShowProjectSettings(false);
    } else if (compactShell) {
      setShowProjectSettings(false);
      setSelectedWorkflowIntentId(null);
    }
    setSelectedProjectId(action.projectId);
    setWorkspaceSelection(emptyWorkspaceSelection(action.projectId));
    setPendingSurfaceSelection(null);
    setChatConsoleChatId(null);
  }, [
    compactShell,
    explorerFileTarget,
    projects.data,
    selectedProjectId,
    showServerAdmin,
    showSettings,
    visibleProjects,
  ]);

  useEffect(() => {
    if (!createdRepositoryOnboarding) return;
    const action = githubRepositoryOnboardingAction(
      createdRepositoryOnboarding.projectId,
      projects.data,
    );
    if (action === "wait") return;
    const { openInitialChat, projectId } = createdRepositoryOnboarding;
    setCreatedRepositoryOnboarding(null);
    if (action === "create-chat") {
      newChat.mutate({ open: openInitialChat, projectId });
    }
  }, [createdRepositoryOnboarding, projects.data]);

  useEffect(() => {
    if (!selectedProjectId) {
      setWorkspaceSelection(emptyWorkspaceSelection());
      return;
    }
    const layout = tabLayout.data;
    if (!layout || layout.projectId !== selectedProjectId) return;
    const pendingGroup = pendingSurfaceSelection?.groupId
      ? layout.groups.find(({ id }) => id === pendingSurfaceSelection.groupId)
      : undefined;
    const pendingTabKey =
      pendingSurfaceSelection?.projectId === selectedProjectId &&
      layout.groups.some(({ members }) =>
        members.some(({ tabKey }) => tabKey === pendingSurfaceSelection.tabKey),
      )
        ? pendingSurfaceSelection.tabKey
        : (pendingGroup?.anchorTabKey ?? null);
    setWorkspaceSelection((current) => {
      const reconciled = reconcileWorkspaceSelection(
        current,
        layout,
        pendingTabKey,
      );
      return pendingTabKey
        ? selectWorkspaceTab(reconciled, layout, pendingTabKey)
        : reconciled;
    });
    if (pendingTabKey) setPendingSurfaceSelection(null);
  }, [pendingSurfaceSelection, selectedProjectId, tabLayout.data]);

  useEffect(() => {
    if (!selectedProjectId) {
      if (mobileBottomTabsProjectId !== null) resetMobileBottomTabs();
      return;
    }
    if (mobileBottomTabsProjectId === selectedProjectId || !settings.data) {
      return;
    }
    const restored = mobileBottomTabsFromConfiguration(
      settings.data.preferences.mobileProjectTabConfigurations[
        selectedProjectId
      ],
    );
    mobileBottomTabSequenceRef.current = restored.length - 1;
    persistedMobileBottomTabsRef.current = {
      projectId: selectedProjectId,
      signature: JSON.stringify(mobileBottomTabConfiguration(restored)),
    };
    setMobileBottomTabs(restored);
    setMobileBottomTabsProjectId(selectedProjectId);
    setActiveMobileBottomTabId(PRIMARY_MOBILE_BOTTOM_TAB_ID);
    setMobileTabGridOpen(false);
  }, [mobileBottomTabsProjectId, selectedProjectId, settings.data]);

  useEffect(() => {
    if (
      !compactShell ||
      !selectedProjectId ||
      mobileBottomTabsProjectId !== selectedProjectId ||
      !settings.isSuccess
    ) {
      return;
    }
    const groupIds = mobileBottomTabConfiguration(mobileBottomTabs);
    const signature = JSON.stringify(groupIds);
    if (
      persistedMobileBottomTabsRef.current?.projectId === selectedProjectId &&
      persistedMobileBottomTabsRef.current.signature === signature
    ) {
      return;
    }
    persistedMobileBottomTabsRef.current = {
      projectId: selectedProjectId,
      signature,
    };
    saveMobileBottomTabs.mutate({ groupIds, projectId: selectedProjectId });
  }, [
    compactShell,
    mobileBottomTabs,
    mobileBottomTabsProjectId,
    selectedProjectId,
    settings.isSuccess,
  ]);

  useEffect(() => {
    if (!compactShell) {
      setMobileTabGridOpen(false);
      return;
    }
    if (
      mobileTabGridOpen ||
      workspaceSelection.destination !== "surface" ||
      !workspaceSelection.selectedGroupId ||
      tabLayout.data?.projectId !== selectedProjectId
    ) {
      return;
    }
    setMobileBottomTabs((current) =>
      assignMobileBottomTab(
        current,
        activeMobileBottomTabId,
        workspaceSelection.selectedGroupId!,
      ),
    );
  }, [
    activeMobileBottomTabId,
    compactShell,
    mobileTabGridOpen,
    selectedProjectId,
    tabLayout.data?.projectId,
    workspaceSelection.destination,
    workspaceSelection.selectedGroupId,
  ]);

  useEffect(() => {
    if (!compactShell || tabLayout.data?.projectId !== selectedProjectId) {
      return;
    }
    const activeTab = mobileBottomTabs.find(
      ({ id }) => id === activeMobileBottomTabId,
    );
    if (activeTab?.groupId && !validMobileGroupIds.has(activeTab.groupId)) {
      setMobileTabGridOpen(true);
    }
    setMobileBottomTabs((current) =>
      reconcileMobileBottomTabs(current, validMobileGroupIds),
    );
  }, [
    activeMobileBottomTabId,
    compactShell,
    mobileBottomTabs,
    selectedProjectId,
    tabLayout.data?.projectId,
    validMobileGroupIds,
  ]);

  useEffect(() => {
    if (!popoutTarget || !tabLayout.isSuccess || tabLayoutMutation.isPending) {
      return;
    }
    if (tabLayout.data?.groups.some(({ id }) => id === popoutTarget.groupId)) {
      return;
    }
    void closeCurrentDesktopWindow().catch((error: unknown) => {
      clientLogger.warn("Orphaned desktop pop-out failed to close", {
        ...operationalErrorMetadata(error),
        event: "window.popout.close.failed",
        operation: "close-popout",
        reasonCode: "native-window-error",
        status: "failed",
        subsystem: "desktop-window",
      });
    });
  }, [
    popoutTarget,
    tabLayout.data,
    tabLayout.isSuccess,
    tabLayoutMutation.isPending,
  ]);

  const revealWorkspace = () => {
    setDesktopSidebarDrawerOpen(false);
    setShowImporter(false);
    setShowSettings(false);
    setShowServerAdmin(false);
    setShowProjectSettings(false);
  };
  const selectProjectWorkspace = (workspaceId: string) => {
    const workspace = projectWorkspaces.data?.find(
      ({ id }) => id === workspaceId,
    );
    if (!workspace) return;
    setDesktopSidebarDrawerOpen(false);
    setActiveProjectWorkspaceId(workspace.id);
    window.localStorage.setItem(activeProjectWorkspaceStorageKey, workspace.id);
    if (compactShell) {
      setSelectedProjectId(null);
      setWorkspaceSelection(emptyWorkspaceSelection());
      resetMobileBottomTabs();
      setPendingSurfaceSelection(null);
      setChatConsoleChatId(null);
      setShowImporter(false);
      setShowSettings(false);
      setShowServerAdmin(false);
      setShowProjectSettings(false);
      return;
    }
    const projectIds = new Set(workspace.projectIds);
    const nextProjectId = projectIds.has(selectedProjectId ?? "")
      ? selectedProjectId
      : (projects.data?.find(({ id }) => projectIds.has(id))?.id ?? null);
    setSelectedProjectId(nextProjectId);
    setWorkspaceSelection(emptyWorkspaceSelection(nextProjectId));
    setPendingSurfaceSelection(null);
    setChatConsoleChatId(null);
    setShowImporter(!nextProjectId);
    setShowSettings(false);
    setShowServerAdmin(false);
    setShowProjectSettings(false);
  };
  const selectProjectFromSidebar = (projectId: string) => {
    setSelectedProjectId(projectId);
    setWorkspaceSelection(emptyWorkspaceSelection(projectId));
    resetMobileBottomTabs();
    setPendingSurfaceSelection(null);
    setChatConsoleChatId(null);
    setDetachedGroupId(null);
    revealWorkspace();
  };
  const closeCompactProject = () => {
    setSelectedProjectId(null);
    setWorkspaceSelection(emptyWorkspaceSelection());
    resetMobileBottomTabs();
    setPendingSurfaceSelection(null);
    setChatConsoleChatId(null);
    setDetachedGroupId(null);
    setShowImporter(false);
    setShowSettings(false);
    setShowServerAdmin(false);
    setShowProjectSettings(false);
    setSelectedWorkflowIntentId(null);
  };
  const openCompactRootSettings = (section: SettingsSection = "general") => {
    setSelectedProjectId(null);
    setWorkspaceSelection(emptyWorkspaceSelection());
    resetMobileBottomTabs();
    setPendingSurfaceSelection(null);
    setSettingsSection(section);
    setShowSettings(true);
    setShowServerAdmin(false);
    setShowImporter(false);
    setShowProjectSettings(false);
  };
  const openServerAdmin = () => {
    setDesktopSidebarDrawerOpen(false);
    setShowServerAdmin(true);
    setShowImporter(false);
    setShowSettings(false);
    setShowProjectSettings(false);
    setMobileTabGridOpen(false);
  };
  const returnToCompactProjectOverview = () => {
    setShowProjectSettings(false);
    setSelectedWorkflowIntentId(null);
    setMobileTabGridOpen(false);
    setWorkspaceSelection((current) =>
      selectWorkspaceOverview(current, selectedProjectId),
    );
  };
  const selectTopTab = (tabKey: string) => {
    const layout = tabLayout.data;
    if (layout) {
      setWorkspaceSelection((current) =>
        selectWorkspaceTab(current, layout, tabKey),
      );
    } else if (selectedProjectId) {
      setPendingSurfaceSelection({ projectId: selectedProjectId, tabKey });
    }
    setMobileTabGridOpen(false);
    setChatConsoleChatId(null);
    setDetachedGroupId(null);
    revealWorkspace();
  };
  const selectMobileOverview = () => {
    setMobileTabGridOpen(false);
    setChatConsoleChatId(null);
    setWorkspaceSelection((current) =>
      selectWorkspaceOverview(current, selectedProjectId),
    );
  };
  const selectGroupFromSidebar = (groupId: string) => {
    const layout = tabLayout.data;
    if (!layout) return;
    const selectLocally = () => {
      setWorkspaceSelection((current) =>
        selectWorkspaceGroup(current, layout, groupId),
      );
      setDetachedGroupId(null);
      setChatConsoleChatId(null);
      revealWorkspace();
    };
    if (!desktopRuntime || isPopout) {
      selectLocally();
      return;
    }
    void focusDesktopPopoutGroup(groupId)
      .then((focused) => {
        if (focused) {
          setWorkspaceSelection((current) =>
            selectWorkspaceGroup(current, layout, groupId),
          );
          setDetachedGroupId(groupId);
          setChatConsoleChatId(null);
          revealWorkspace();
        } else {
          selectLocally();
        }
      })
      .catch(() => selectLocally());
  };
  const selectMobileBottomTab = (tabId: string) => {
    setActiveMobileBottomTabId(tabId);
    const tab = mobileBottomTabs.find(({ id }) => id === tabId);
    if (!tab?.groupId) {
      setMobileTabGridOpen(true);
      return;
    }
    setMobileTabGridOpen(false);
    selectGroupFromSidebar(tab.groupId);
  };
  const openMobileBottomTabSwitcher = (tabId: string) => {
    setActiveMobileBottomTabId(tabId);
    setMobileTabGridOpen(true);
  };
  const addMobileBottomTab = () => {
    const tabId = `mobile-${++mobileBottomTabSequenceRef.current}`;
    setMobileBottomTabs((current) => [
      ...current,
      { groupId: null, id: tabId },
    ]);
    setActiveMobileBottomTabId(tabId);
    setMobileTabGridOpen(true);
  };
  const selectGroupFromMobileSwitcher = (groupId: string) => {
    setMobileBottomTabs((current) =>
      assignMobileBottomTab(current, activeMobileBottomTabId, groupId),
    );
    setMobileTabGridOpen(false);
    selectGroupFromSidebar(groupId);
  };
  const removeActiveMobileBottomTab = () => {
    const removal = removeMobileBottomTab(
      mobileBottomTabs,
      activeMobileBottomTabId,
    );
    if (!removal) return;
    setMobileBottomTabs(removal.tabs);
    setActiveMobileBottomTabId(removal.activeTabId);
    const next = removal.tabs.find(({ id }) => id === removal.activeTabId);
    if (next?.groupId) {
      setMobileTabGridOpen(false);
      selectGroupFromSidebar(next.groupId);
    } else {
      setMobileTabGridOpen(true);
    }
  };
  const createProjectSurface = (
    projectId: string,
    kind: ProjectSurfaceCreateKind,
    tabGroupId?: string,
    target?: ExecutionTarget,
  ) => {
    const input: {
      projectId: string;
      tabGroupId?: string;
      target?: ExecutionTarget;
    } = { projectId };
    if (tabGroupId) input.tabGroupId = tabGroupId;
    if (target) input.target = target;
    if (kind === "chat") newChat.mutate(input);
    else if (kind === "task") newTask.mutate(input);
    else if (kind === "terminal") newTerminal.mutate(input);
    else if (kind === "explorer") newExplorer.mutate(input);
    else if (kind === "browser") newBrowser.mutate(input);
    else if (kind === "code") newCodeTab.mutate(input);
    else if (kind === "remote-desktop") {
      if (!tabGroupId) newRemoteDesktop.reset();
      newRemoteDesktop.mutate(input);
    } else {
      newProjectView.mutate({ projectId, tabGroupId, kind });
    }
  };
  const createSurfaceInSelectedGroup = (
    kind: ProjectSurfaceCreateKind,
    target?: ExecutionTarget,
  ) => {
    if (!selectedProject || !selectedTabGroup) return;
    createProjectSurface(selectedProject.id, kind, selectedTabGroup.id, target);
  };
  const renameSurface = (surface: ProjectSurface, title: string) => {
    if (surface.kind === "chat") {
      renameChatMutation.mutate({ chatId: surface.tabId, title });
    } else if (surface.kind === "terminal") {
      renameTerminalMutation.mutate({ terminalId: surface.tabId, title });
    } else if (surface.kind === "explorer") {
      renameExplorerMutation.mutate({ explorerId: surface.tabId, title });
    } else if (surface.kind === "browser") {
      updateBrowserMutation.mutate({
        browserId: surface.tabId,
        input: { title },
      });
    } else if (surface.kind === "code") {
      updateCodeTabMutation.mutate({ codeTabId: surface.tabId, title });
    } else {
      renameProjectViewMutation.mutate({ viewId: surface.tabId, title });
    }
  };
  const deleteSurface = (surface: ProjectSurface) => {
    if (surface.kind === "chat") deleteChatMutation.mutate(surface.tabId);
    else if (surface.kind === "terminal")
      deleteTerminalMutation.mutate(surface.tabId);
    else if (surface.kind === "explorer") requestDeleteExplorer(surface.tabId);
    else if (surface.kind === "browser")
      deleteBrowserMutation.mutate(surface.tabId);
    else if (surface.kind === "code")
      deleteCodeTabMutation.mutate(surface.tabId);
    else deleteProjectViewMutation.mutate(surface.tabId);
  };
  const deleteSurfaceImmediately = (surface: ProjectSurface) => {
    if (surface.kind === "explorer") {
      deleteExplorerMutation.mutate(surface.tabId);
      return;
    }
    deleteSurface(surface);
  };
  const creatingSurfaceKinds = new Set<ProjectSurfaceCreateKind>([
    ...(newChat.isPending ? (["chat"] as const) : []),
    ...(newTask.isPending ? (["task"] as const) : []),
    ...(newTerminal.isPending ? (["terminal"] as const) : []),
    ...(newExplorer.isPending ? (["explorer"] as const) : []),
    ...(newBrowser.isPending ? (["browser"] as const) : []),
    ...(newCodeTab.isPending ? (["code"] as const) : []),
    ...(newProjectView.isPending ? (["history", "issues"] as const) : []),
    ...(newRemoteDesktop.isPending ? (["remote-desktop"] as const) : []),
  ]);
  const selectedPlacementContext: ProjectSurfacePlacementContext | undefined =
    selectedProject
      ? {
          projectId: selectedProject.id,
          replicas: selectedProject.replicas,
          workers: workers.data ?? [],
          worktrees: worktrees.data ?? [],
        }
      : undefined;
  const surfaceCreationFailure = newChat.isError
    ? { label: "Agent", error: newChat.error }
    : newTask.isError
      ? { label: "Task", error: newTask.error }
      : newTerminal.isError
        ? { label: "terminal", error: newTerminal.error }
        : newExplorer.isError
          ? { label: "Explorer", error: newExplorer.error }
          : newBrowser.isError
            ? { label: "Browser", error: newBrowser.error }
            : newCodeTab.isError
              ? { label: "Code tab", error: newCodeTab.error }
              : newRemoteDesktop.isError
                ? {
                    label: "Remote Desktop",
                    error: newRemoteDesktop.error,
                  }
                : null;
  const handleWorkspaceDrop = (operation: WorkspaceDropOperation) => {
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
    const current = projects.data ?? [];
    const from = current.findIndex(
      ({ id }) => id === operation.sourceProjectId,
    );
    const to = current.findIndex(({ id }) => id === operation.targetProjectId);
    if (from < 0 || to < 0) return;
    const reordered = [...current];
    const [moved] = reordered.splice(from, 1);
    if (!moved) return;
    reordered.splice(to, 0, moved);
    reorderProjectsMutation.mutate(reordered.map(({ id }) => id));
  };
  const contentHeaderActions = {
    git:
      gitHistoryProject && gitHistoryHeader?.section === "history"
        ? gitHistoryHeader
        : null,
    explorer: selectedExplorer ? explorerHeader : null,
    code: selectedCodeTab ? { header: codeHeader } : null,
    terminalService:
      !showImporter &&
      !showSettings &&
      !showServerAdmin &&
      !showProjectSettings &&
      selectedStandaloneTerminal
        ? {
            active: terminalServiceTerminalId === selectedStandaloneTerminal.id,
            open: () =>
              setTerminalServiceTerminalId((current) =>
                current === selectedStandaloneTerminal.id
                  ? null
                  : selectedStandaloneTerminal.id,
              ),
          }
        : null,
    terminalCommandPalette:
      !showImporter &&
      !showSettings &&
      !showServerAdmin &&
      !showProjectSettings &&
      selectedStandaloneTerminal
        ? {
            active:
              terminalCommandPaletteTerminalId ===
              selectedStandaloneTerminal.id,
            open: () =>
              setTerminalCommandPaletteTerminalId(
                selectedStandaloneTerminal.id,
              ),
          }
        : null,
    popout: activePopout
      ? {
          error: popoutError,
          pending: popoutPending,
          open: popOutActiveView,
        }
      : null,
    task:
      activeChat?.experience === "task"
        ? {
            change: setSelectedTaskView,
            view: selectedTaskView ? ("task" as const) : ("chat" as const),
          }
        : null,
    chat:
      activeChat &&
      !showImporter &&
      !showSettings &&
      !showServerAdmin &&
      !showProjectSettings
        ? {
            consoleActive: Boolean(linkedConsoleChat),
            consolePending: openChatConsole.isPending,
            inspectActive: agentInspectOpenChats.has(activeChat.id),
            inspectCustomizations: () => setShowCustomizations(true),
            relocation: {
              active: Boolean(activeRelocation),
              available: Boolean(
                bootstrap.data?.capabilities.workerSwitching &&
                selectedPlacementContext &&
                (selectedPlacementContext.workers.length > 1 ||
                  currentRelocation),
              ),
              open: chatRelocationOpen,
              problem: Boolean(
                currentRelocation &&
                (currentRelocation.state === "blocked" ||
                  currentRelocation.state === "failed"),
              ),
              show: () => setChatRelocationOpen(true),
            },
            toggleConsole: () =>
              linkedConsoleChat
                ? setChatConsoleChatId(null)
                : showChatConsole(activeChat),
            toggleInspect: () =>
              setAgentInspectOpen(
                activeChat.id,
                !agentInspectOpenChats.has(activeChat.id),
              ),
          }
        : null,
  } satisfies Omit<ContentHeaderActionsProps, "compact">;
  const codeSurfaceVisible = Boolean(
    selectedCodeTab &&
    !mobileProjectSelectorOpen &&
    !showImporter &&
    !showSettings &&
    !showServerAdmin &&
    !showProjectSettings &&
    !(compactShell && mobileTabGridOpen) &&
    !groupOwnedElsewhere,
  );
  const explorerSurfaceVisible = Boolean(
    selectedExplorer &&
    !mobileProjectSelectorOpen &&
    !showImporter &&
    !showSettings &&
    !showServerAdmin &&
    !showProjectSettings &&
    !(compactShell && mobileTabGridOpen) &&
    !groupOwnedElsewhere,
  );
  const taskSurfaceVisible = Boolean(
    selectedChat?.experience === "task" &&
    selectedTaskView &&
    !mobileProjectSelectorOpen &&
    !showImporter &&
    !showSettings &&
    !showServerAdmin &&
    !showProjectSettings &&
    !(compactShell && mobileTabGridOpen) &&
    !groupOwnedElsewhere,
  );
  if (explorerFileTarget) {
    const explorer =
      explorers.data?.find(({ id }) => id === explorerFileTarget.explorerId) ??
      null;
    const explorerError = explorers.isError
      ? errorText(explorers.error)
      : explorers.isSuccess && !explorer
        ? "This Explorer is no longer available."
        : null;
    return (
      <ExplorerFilePopout
        error={explorerError}
        explorer={explorer}
        gitStatus={explorer ? worktreeStatuses[explorer.worktreeId] : undefined}
        loading={explorers.isLoading}
        overlayTitlebar={overlayTitlebar}
        path={explorerFileTarget.path}
        projectTitle={
          selectedProject?.github?.nameWithOwner ?? selectedProject?.name
        }
      />
    );
  }
  const sidebarExpanded = desktopSidebarDrawer
    ? desktopSidebarDrawerOpen
    : !sidebarCollapsed;
  const sidebarToggleVisible =
    !isPopout && (desktopSidebarDrawer || sidebarCollapsed);
  return (
    <WorkspaceDndProvider
      className="flex h-svh overflow-hidden bg-background text-foreground"
      layout={tabLayout.data}
      projects={visibleProjects}
      onOperation={handleWorkspaceDrop}
      tauriTitlebar={overlayTitlebar ? "overlay" : undefined}
    >
      {!isPopout ? (
        <div
          data-slot="app-sidebar-shell"
          role={desktopSidebarDrawer ? "dialog" : undefined}
          aria-label={desktopSidebarDrawer ? "Cantrip sidebar" : undefined}
          aria-modal={desktopSidebarDrawer ? true : undefined}
          className={cn(
            "group/sidebar-shell shrink-0",
            desktopSidebarDrawer
              ? desktopSidebarDrawerOpen
                ? "fixed inset-0 z-[80] block"
                : "hidden"
              : "relative hidden md:block",
            sidebarResizing
              ? "transition-none"
              : "transition-[width] duration-150 ease-out motion-reduce:transition-none",
          )}
          style={{
            width: desktopSidebarDrawer
              ? undefined
              : sidebarCollapsed
                ? 0
                : sidebarWidth,
          }}
        >
          {desktopSidebarDrawer ? (
            <button
              type="button"
              aria-label="Close sidebar"
              className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
              onClick={() => setDesktopSidebarDrawerOpen(false)}
              tabIndex={-1}
            />
          ) : null}
          <aside
            ref={sidebarRef}
            data-slot="app-sidebar"
            data-state={sidebarExpanded ? "expanded" : "collapsed"}
            aria-hidden={!sidebarExpanded}
            inert={!sidebarExpanded}
            tabIndex={desktopSidebarDrawer ? -1 : undefined}
            className={cn(
              "group/sidebar absolute inset-y-0 left-0 z-10 flex flex-col bg-background transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
              desktopSidebarDrawer &&
                "max-w-[calc(100vw-3rem)] border-r shadow-2xl",
              sidebarExpanded
                ? "translate-x-0 opacity-100"
                : "pointer-events-none -translate-x-2 opacity-0",
            )}
            style={{ width: sidebarWidth }}
          >
            <div
              className={
                overlayTitlebar
                  ? "flex h-8 items-center gap-1.5 pl-20 pr-2"
                  : "flex h-16 items-center gap-3 px-4"
              }
              data-slot="sidebar-titlebar"
              data-tauri-drag-region={overlayTitlebar ? "" : undefined}
            >
              <div
                className={
                  overlayTitlebar
                    ? "grid size-5 place-items-center"
                    : "grid size-9 place-items-center"
                }
                data-tauri-drag-region={overlayTitlebar ? "" : undefined}
              >
                <WandSparkles
                  className={overlayTitlebar ? "size-3" : "size-4"}
                  data-tauri-drag-region={overlayTitlebar ? "" : undefined}
                />
              </div>
              <div
                className="min-w-0 flex-1"
                data-tauri-drag-region={overlayTitlebar ? "" : undefined}
              >
                <p
                  className={cn(
                    "font-semibold tracking-tight",
                    overlayTitlebar && "text-xs leading-none",
                  )}
                  data-tauri-drag-region={overlayTitlebar ? "" : undefined}
                >
                  Cantrip
                </p>
              </div>
              {!overlayTitlebar ? (
                <StatusDot online={Boolean(onlineWorker)} />
              ) : null}
              <Button
                size="icon"
                variant="ghost"
                className={overlayTitlebar ? "size-6" : "size-8"}
                onClick={() =>
                  desktopSidebarDrawer
                    ? setDesktopSidebarDrawerOpen(false)
                    : setSidebarCollapsed(true)
                }
                title={
                  desktopSidebarDrawer ? "Close sidebar" : "Collapse sidebar"
                }
              >
                <PanelLeftClose
                  className={overlayTitlebar ? "size-3" : "size-4"}
                />
                <span className="sr-only">
                  {desktopSidebarDrawer ? "Close sidebar" : "Collapse sidebar"}
                </span>
              </Button>
            </div>

            <div className="px-3 pb-2 pt-4">
              <WorkspaceSwitcher
                activeWorkspaceId={activeProjectWorkspace?.id ?? null}
                workspaces={projectWorkspaces.data ?? []}
                onSelect={selectProjectWorkspace}
                onCreate={async (name) => {
                  await createWorkspaceMutation.mutateAsync(name);
                }}
                onAddProject={() => {
                  setDesktopSidebarDrawerOpen(false);
                  setShowImporter(true);
                  setShowSettings(false);
                  setShowServerAdmin(false);
                  setShowProjectSettings(false);
                }}
                onManage={() => {
                  setDesktopSidebarDrawerOpen(false);
                  setSettingsSection("workspaces");
                  setShowSettings(true);
                  setShowServerAdmin(false);
                  setShowImporter(false);
                  setShowProjectSettings(false);
                }}
              />
            </div>

            <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
              <ProjectChatList
                browsers={browsers.data ?? []}
                projects={visibleProjects}
                projectSetupJobs={projectSetupJobs}
                chats={chats.data ?? []}
                codeTabs={codeTabs.data ?? []}
                explorers={explorers.data ?? []}
                projectViews={projectViews.data ?? []}
                terminals={terminals.data ?? []}
                workers={workers.data ?? []}
                worktrees={worktrees.data ?? []}
                worktreeStatuses={worktreeStatuses}
                selectedProjectId={selectedProjectId}
                selectedTabKey={selectedTabKey}
                tabLayout={tabLayout.data ?? null}
                creatingKinds={creatingSurfaceKinds}
                onCreateSurface={(projectId, kind, target) => {
                  setDesktopSidebarDrawerOpen(false);
                  createProjectSurface(projectId, kind, undefined, target);
                }}
                onChangeChatWorktree={(chatId, worktreeId, mode) => {
                  const chat = chats.data?.find(({ id }) => id === chatId);
                  if (chat) bindChatWorktree(chat, worktreeId, mode);
                }}
                onRequestChatWorktreeCreate={(chat) =>
                  setWorktreeCreateTarget({
                    kind: "chat",
                    projectId: chat.projectId,
                    tabId: chat.id,
                    mode: chat.worktreeMode,
                  })
                }
                onOpenChatTerminal={openChatTerminalHere}
                onOpenChatExplorer={openChatExplorerHere}
                onOpenChatHistory={openChatHistoryHere}
                onRenameChat={(chatId, title) =>
                  renameChatMutation.mutate({ chatId, title })
                }
                onDuplicateChat={(chatId) => forkChatMutation.mutate(chatId)}
                onDeleteChat={(chatId) => deleteChatMutation.mutate(chatId)}
                onRenameCode={(codeTabId, title) =>
                  updateCodeTabMutation.mutate({ codeTabId, title })
                }
                onDeleteCode={(codeTabId) =>
                  deleteCodeTabMutation.mutate(codeTabId)
                }
                onRenameBrowser={(browserId, title) =>
                  updateBrowserMutation.mutate({
                    browserId,
                    input: { title },
                  })
                }
                onDeleteBrowser={(browserId) =>
                  deleteBrowserMutation.mutate(browserId)
                }
                onRenameExplorer={(explorerId, title) =>
                  renameExplorerMutation.mutate({ explorerId, title })
                }
                onDeleteExplorer={requestDeleteExplorer}
                onCloseExplorer={(explorerId) =>
                  deleteExplorerMutation.mutate(explorerId)
                }
                onRenameProjectView={(viewId, title) =>
                  renameProjectViewMutation.mutate({ viewId, title })
                }
                onDeleteProjectView={(viewId) =>
                  deleteProjectViewMutation.mutate(viewId)
                }
                onRenameTerminal={(terminalId, title) =>
                  renameTerminalMutation.mutate({ terminalId, title })
                }
                onDeleteTerminal={(terminalId) =>
                  deleteTerminalMutation.mutate(terminalId)
                }
                onRemoveProject={(projectId, deleteLocalFiles) =>
                  removeProjectMutation.mutate({
                    projectId,
                    deleteLocalFiles,
                  })
                }
                onOpenProjectSettings={openProjectSettings}
                projectRevealLabel={projectRevealLabel ?? undefined}
                onRevealProject={revealProjectInNativeFileManager}
                onSelectProject={selectProjectFromSidebar}
                onSelectGroup={selectGroupFromSidebar}
              />
            </nav>

            <div className="p-3">
              <div className="flex items-center gap-1">
                <ServerSwitcher
                  currentUserName={
                    bootstrap.data?.auth.currentUser?.displayName ??
                    "Cantrip User"
                  }
                  onOpenAdmin={openServerAdmin}
                  workerName={onlineWorker?.name ?? "Worker offline"}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  onClick={() => {
                    setDesktopSidebarDrawerOpen(false);
                    setSettingsSection("general");
                    setShowSettings(true);
                    setShowServerAdmin(false);
                    setShowImporter(false);
                    setShowProjectSettings(false);
                  }}
                >
                  <Settings className="size-4" />
                  <span className="sr-only">Open settings</span>
                </Button>
              </div>
            </div>
          </aside>
          {!desktopSidebarDrawer ? (
            <div
              data-slot="sidebar-resize-handle"
              role="separator"
              aria-label="Resize sidebar"
              aria-orientation="vertical"
              aria-valuemin={MIN_SIDEBAR_WIDTH}
              aria-valuemax={MAX_SIDEBAR_WIDTH}
              aria-valuenow={sidebarWidth}
              tabIndex={sidebarCollapsed ? -1 : 0}
              title="Drag to resize sidebar"
              className={cn(
                "absolute inset-y-0 -right-1 z-40 w-2 cursor-col-resize touch-none outline-none",
                "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-border after:opacity-0 after:transition-opacity after:duration-150",
                "group-hover/sidebar-shell:after:opacity-100 hover:after:opacity-100 focus-visible:after:opacity-100",
                sidebarCollapsed && "pointer-events-none opacity-0",
                sidebarResizing && "after:opacity-100",
              )}
              onKeyDown={resizeSidebarWithKeyboard}
              onPointerDown={beginSidebarResize}
              onPointerMove={moveSidebarResize}
              onPointerUp={(event) => finishSidebarResize(event, true)}
              onPointerCancel={(event) => finishSidebarResize(event, false)}
            />
          ) : null}
        </div>
      ) : null}

      <section
        ref={contentRootRef}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {workspaceDragError ? (
          <button
            type="button"
            className="absolute right-3 top-3 z-50 flex max-w-sm items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-left text-xs text-destructive shadow-lg backdrop-blur-xl"
            onClick={() => setWorkspaceDragError(null)}
            title="Dismiss"
          >
            <CircleAlert className="size-4 shrink-0" />
            <span className="truncate">{workspaceDragError}</span>
          </button>
        ) : null}
        {compactShell && showImporter ? (
          <MobileProjectHeader
            context={activeProjectWorkspace?.name ?? "Choose a repository"}
            onBack={closeCompactProject}
            title="New project"
          />
        ) : compactShell && showSettings ? (
          <MobileProjectHeader
            context="Account preferences"
            onBack={closeCompactProject}
            title="Settings"
          />
        ) : compactShell && showServerAdmin ? (
          <MobileProjectHeader
            context="Account access and server policy"
            onBack={closeCompactProject}
            title="Server administration"
          />
        ) : compactShell && showProjectSettings && selectedProject ? (
          <MobileProjectHeader
            context={
              selectedProject.github?.nameWithOwner ??
              selectedProject.source?.displayPath
            }
            onBack={returnToCompactProjectOverview}
            title="Project settings"
          />
        ) : compactShell && mobileTabGridOpen && selectedProject ? (
          <MobileProjectHeader
            context={`Tabs · ${
              selectedProject.github?.nameWithOwner ??
              selectedProject.source?.displayPath ??
              selectedProject.name
            }`}
            title={selectedProject.name}
          />
        ) : compactShell && projectOverviewSelected && selectedProject ? (
          <MobileProjectHeader
            context={
              selectedProject.github?.nameWithOwner ??
              selectedProject.source?.displayPath
            }
            onCloseProject={closeCompactProject}
            onOpenProjectSettings={() =>
              openProjectSettings(selectedProject.id)
            }
            title={selectedProject.name}
          />
        ) : null}
        {showContentTitlebar && !compactManagedHeader ? (
          <header
            className={cn(
              "relative z-30 flex shrink-0 items-center justify-between",
              compactShell && "mobile-safe-top",
              overlayTitlebar
                ? "h-8 gap-2 px-3 text-[11px] sm:px-4 [&_[data-slot=badge]]:h-5 [&_[data-slot=badge]]:gap-1 [&_[data-slot=badge]]:px-1.5 [&_[data-slot=badge]]:text-[10px] [&_[data-slot=button]]:h-6 [&_[data-slot=button]]:min-w-6 [&_[data-slot=button]]:w-auto [&_[data-slot=button]]:gap-1 [&_[data-slot=button]]:px-1.5 [&_[data-slot=button]]:py-0 [&_[data-slot=button]]:text-[11px] [&_svg]:size-3"
                : "h-16 gap-4 px-4 sm:px-6",
            )}
            data-slot="content-titlebar"
            data-tauri-drag-region={overlayTitlebar ? "" : undefined}
            style={{
              paddingLeft: desktopPopoutTitlebarLeftInset(
                isPopout,
                overlayTitlebar,
              ),
            }}
          >
            {sidebarToggleVisible ? (
              <Button
                size="icon"
                variant="ghost"
                className={cn(
                  "absolute size-8",
                  overlayTitlebar ? "left-20 top-1" : "left-4 top-4",
                )}
                onClick={() =>
                  desktopSidebarDrawer
                    ? setDesktopSidebarDrawerOpen(true)
                    : setSidebarCollapsed(false)
                }
                title={desktopSidebarDrawer ? "Open sidebar" : "Expand sidebar"}
              >
                <PanelLeftOpen className="size-4" />
                <span className="sr-only">
                  {desktopSidebarDrawer ? "Open sidebar" : "Expand sidebar"}
                </span>
              </Button>
            ) : null}
            <div
              className={cn(
                "min-w-0",
                overlayTitlebar &&
                  "flex flex-1 items-center gap-2 overflow-hidden",
                sidebarToggleVisible &&
                  (overlayTitlebar ? "pl-[6.25rem]" : "pl-10"),
              )}
              data-tauri-drag-region={overlayTitlebar ? "" : undefined}
            >
              <div
                className={cn(
                  "flex min-w-0 items-center font-medium",
                  overlayTitlebar ? "gap-1.5 text-xs" : "gap-2 text-sm",
                )}
                data-tauri-drag-region={overlayTitlebar ? "" : undefined}
              >
                {selectedExplorer ? (
                  <ExplorerFileCloseButton
                    compact={overlayTitlebar}
                    header={explorerHeader}
                  />
                ) : null}
                <span
                  className="truncate"
                  data-tauri-drag-region={overlayTitlebar ? "" : undefined}
                >
                  {showImporter
                    ? "GitHub repositories"
                    : showSettings
                      ? "Settings"
                      : showServerAdmin
                        ? "Server administration"
                        : showProjectSettings
                          ? "Project settings"
                          : projectOverviewSelected && selectedProject
                            ? selectedProject.name
                            : gitHistoryProject
                              ? (selectedProjectView?.title ?? "Git")
                              : selectedProjectView?.kind === "remote-desktop"
                                ? selectedProjectView.title
                                : selectedCodeTab
                                  ? selectedCodeTab.title
                                  : selectedBrowser
                                    ? selectedBrowser.title
                                    : selectedExplorer
                                      ? selectedExplorer.title
                                      : selectedTerminal
                                        ? selectedTerminal.linkedChatId
                                          ? (linkedConsoleChat?.title ??
                                            "Agent")
                                          : selectedTerminal.title
                                        : selectedChat
                                          ? selectedChat.title
                                          : (selectedProject?.github
                                              ?.nameWithOwner ?? "Cantrip")}
                </span>
                {!showImporter &&
                !showSettings &&
                !showServerAdmin &&
                activeWorktreeTarget &&
                activeWorktreeId &&
                (!gitHistoryProject ||
                  gitHistoryHeader?.section === "history") ? (
                  <WorktreeControl
                    currentWorktreeId={activeWorktreeId}
                    worktrees={worktrees.data ?? []}
                    statuses={worktreeStatuses}
                    workers={workers.data ?? []}
                    leaseOwner={activeChat?.title}
                    actions={{
                      chatMode: activeChat?.worktreeMode,
                      pending: bindWorktreeMutation.isPending,
                      disabled:
                        bindWorktreeMutation.isPending ||
                        activeChat?.status === "running" ||
                        selectedTerminal?.status === "running" ||
                        selectedCodeTab?.status === "running" ||
                        selectedCodeTab?.status === "starting",
                      error: worktreeActionError,
                      onCreate: () =>
                        setWorktreeCreateTarget(activeWorktreeTarget),
                      onSelect: (worktreeId) =>
                        void requestBindWorktree({
                          target: activeWorktreeTarget,
                          worktreeId,
                        }),
                      onSetChatMode: activeChat
                        ? (mode) =>
                            bindWorktreeMutation.mutate({
                              target: activeWorktreeTarget,
                              worktreeId: activeChat.activeWorktreeId,
                              mode,
                            })
                        : undefined,
                      onOpenTerminal: activeChat
                        ? () => openChatTerminalHere(activeChat)
                        : undefined,
                      onOpenExplorer: activeChat
                        ? () => openChatExplorerHere(activeChat)
                        : undefined,
                      onOpenHistory: activeChat
                        ? () => openChatHistoryHere(activeChat)
                        : undefined,
                    }}
                  />
                ) : null}
                {gitHistoryProject &&
                gitHistoryHeader?.section === "history" ? (
                  <>
                    <Badge
                      variant="secondary"
                      className="hidden shrink-0 gap-1 font-mono font-normal sm:flex"
                    >
                      <GitBranch className="size-3" />
                      {gitHistoryHeader.branch || "detached HEAD"}
                    </Badge>
                    {gitHistoryHeader.head ? (
                      <code className="hidden shrink-0 text-[11px] font-normal text-muted-foreground sm:block">
                        @ {gitHistoryHeader.head.slice(0, 8)}
                      </code>
                    ) : null}
                  </>
                ) : null}
              </div>
              <p
                className={cn(
                  "truncate text-muted-foreground",
                  overlayTitlebar
                    ? "hidden min-w-0 flex-1 text-[10px] leading-none lg:block"
                    : "text-xs",
                )}
                data-tauri-drag-region={overlayTitlebar ? "" : undefined}
              >
                {showImporter ? (
                  "Add a worker-owned source"
                ) : showSettings ? (
                  "Account preferences"
                ) : showServerAdmin ? (
                  "Account access and server policy"
                ) : showProjectSettings ? (
                  (selectedProject?.github?.nameWithOwner ??
                  selectedProject?.name ??
                  "Project preferences")
                ) : projectOverviewSelected && selectedProject ? (
                  `Project overview · ${selectedProject.source?.displayPath ?? selectedProject.github?.nameWithOwner ?? selectedProject.name}`
                ) : gitHistoryProject ? (
                  <>
                    {gitHistoryProject.github?.nameWithOwner ??
                      gitHistoryProject.name}
                    {gitHistoryHeader ? (
                      gitHistoryHeader.section !== "history" ? (
                        ` · ${gitHistoryHeader.issueCount ?? "…"} ${gitHistoryHeader.issueState} ${gitHistoryHeader.section === "prs" ? "PRs" : "issues"}`
                      ) : (
                        <>
                          <span className="sm:hidden">
                            {` · ${gitHistoryHeader.branch || "detached HEAD"}${gitHistoryHeader.head ? ` @ ${gitHistoryHeader.head.slice(0, 8)}` : ""}`}
                          </span>
                          {` · ${gitHistoryHeader.commitsLoaded} commits loaded`}
                        </>
                      )
                    ) : null}
                  </>
                ) : selectedProjectView?.kind === "remote-desktop" ? (
                  "Managed project-worker desktop"
                ) : selectedCodeTab ? (
                  `${activeWorktree?.displayPath ?? selectedProject?.source?.displayPath ?? "Code"} · ${selectedCodeTab.profileId}`
                ) : selectedBrowser ? (
                  selectedBrowser.url
                ) : selectedExplorer ? (
                  explorerDisplayPath
                ) : selectedTerminal ? (
                  selectedTerminal.linkedChatId ? (
                    (activeWorktree?.displayPath ??
                    selectedProject?.source?.displayPath ??
                    "Agent")
                  ) : (
                    (activeWorktree?.displayPath ??
                    selectedProject?.source?.displayPath ??
                    "Terminal")
                  )
                ) : selectedChat ? (
                  (activeWorktree?.displayPath ??
                  selectedProject?.source?.displayPath ??
                  "Agent")
                ) : (
                  (selectedProject?.source?.displayPath ??
                  "Choose a project to begin")
                )}
              </p>
            </div>
            <div
              className={cn(
                "flex items-center md:hidden",
                overlayTitlebar ? "gap-1" : "gap-2",
              )}
              data-tauri-drag-region={overlayTitlebar ? "" : undefined}
            >
              <ContentHeaderActions {...contentHeaderActions} compact />
              {!isPopout && !compactShell ? (
                <>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => {
                      setSettingsSection("general");
                      setShowSettings(true);
                      setShowServerAdmin(false);
                      setShowImporter(false);
                      setShowProjectSettings(false);
                    }}
                  >
                    <Settings className="size-4" />
                    <span className="sr-only">Open settings</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setShowImporter(true);
                      setShowSettings(false);
                      setShowServerAdmin(false);
                      setShowProjectSettings(false);
                    }}
                  >
                    <Plus className="size-4" />
                    Project
                  </Button>
                </>
              ) : null}
            </div>
            <div
              className={cn(
                "ml-auto hidden items-center md:flex",
                overlayTitlebar ? "gap-1" : "gap-2",
              )}
              data-tauri-drag-region={overlayTitlebar ? "" : undefined}
            >
              <ContentHeaderActions {...contentHeaderActions} />
              {!isPopout &&
              !showImporter &&
              !showSettings &&
              !showServerAdmin &&
              selectedProject ? (
                <span
                  className={cn(
                    "flex items-center",
                    overlayTitlebar
                      ? "gap-1.5 px-1 text-[10px]"
                      : "gap-2 px-2 text-xs",
                  )}
                >
                  <StatusDot online={Boolean(selectedWorker?.online)} />
                  {selectedWorker?.name ?? "Worker offline"}
                </span>
              ) : null}
            </div>
            <span
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-x-0 bottom-0 h-px bg-border transition-opacity duration-200",
                contentScrolled && !gitHistoryProject
                  ? "opacity-100"
                  : "opacity-0",
              )}
            />
          </header>
        ) : null}

        {(!compactShell || !mobileTabGridOpen) &&
        !showImporter &&
        !showSettings &&
        !showServerAdmin &&
        !showProjectSettings &&
        !groupOwnedElsewhere &&
        selectedTabKey &&
        selectedTabGroup &&
        selectedGroupSurfaces.length > 0 ? (
          <ProjectTabBar
            activeTabKey={selectedTabKey}
            creatingKinds={creatingSurfaceKinds}
            surfaces={selectedGroupSurfaces}
            onCreate={createSurfaceInSelectedGroup}
            onClose={deleteSurfaceImmediately}
            onDelete={deleteSurface}
            onDuplicate={(surface) => {
              if (surface.kind === "chat") {
                forkChatMutation.mutate(surface.tabId);
              }
            }}
            onRename={renameSurface}
            onSelect={selectTopTab}
            placement={selectedPlacementContext}
          />
        ) : null}

        <Suspense
          fallback={
            codeSurfaceVisible ? (
              <div className="grid flex-1 place-items-center text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
              </div>
            ) : null
          }
        >
          <PersistentCodeViews
            activeTab={codeSurfaceVisible ? (selectedCodeTab ?? null) : null}
            appearance={codeAppearance}
            onChanged={(codeTab) =>
              void queryClient.invalidateQueries({
                queryKey: ["code-tabs", codeTab.projectId],
              })
            }
            onHeaderChange={setCodeHeader}
          />
        </Suspense>

        <Suspense
          fallback={
            explorerSurfaceVisible ? (
              <div className="grid flex-1 place-items-center text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
              </div>
            ) : null
          }
        >
          <PersistentExplorerViews
            activeExplorer={
              explorerSurfaceVisible ? (selectedExplorer ?? null) : null
            }
            gitStatuses={worktreeStatuses}
            onChanged={handleExplorerChanged}
            onHeaderChange={setExplorerHeader}
            onLifecycleChange={handleExplorerLifecycleChange}
            onOpenFile={desktopRuntime ? openExplorerFileWindow : undefined}
            onOpenTerminal={(explorer, entry) => {
              if (!selectedSurface || selectedSurface.kind !== "explorer") {
                return;
              }
              newTerminal.mutate({
                projectId: explorer.projectId,
                directoryPath: entry.path,
                tabGroupId: selectedSurface.groupId,
                title: `Terminal · ${entry.name}`,
                target: {
                  kind: "worktree",
                  projectId: explorer.projectId,
                  worktreeId: explorer.worktreeId,
                },
              });
            }}
          />
        </Suspense>

        <Suspense
          fallback={
            taskSurfaceVisible ? (
              <div className="grid flex-1 place-items-center text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
              </div>
            ) : null
          }
        >
          <PersistentTaskViews
            activeTask={
              taskSurfaceVisible && selectedChat
                ? {
                    chat: selectedChat,
                    workerName: selectedWorker?.name,
                    workerOnline:
                      selectedWorker?.online ??
                      selectedChat.status !== "offline",
                  }
                : null
            }
            settings={settings.data}
            onRename={(chatId, title) =>
              renameChatMutation.mutate({ chatId, title })
            }
          />
        </Suspense>

        {mobileProjectSelectorOpen ? (
          <MobileProjectSelector
            activeWorkspace={activeProjectWorkspace}
            currentUserName={
              bootstrap.data?.auth.currentUser?.displayName ?? "Cantrip User"
            }
            error={projects.isError ? errorText(projects.error) : null}
            loading={projects.isLoading || projectWorkspaces.isLoading}
            projects={projects.data ?? []}
            projectSetupJobs={projectSetupJobs}
            workers={workers.data ?? []}
            workspaces={projectWorkspaces.data ?? []}
            onCreateWorkspace={async (name) => {
              await createWorkspaceMutation.mutateAsync(name);
            }}
            onManageWorkspaces={() => openCompactRootSettings("workspaces")}
            onNewProject={() => {
              setSelectedProjectId(null);
              setWorkspaceSelection(emptyWorkspaceSelection());
              resetMobileBottomTabs();
              setPendingSurfaceSelection(null);
              setShowImporter(true);
              setShowSettings(false);
              setShowServerAdmin(false);
              setShowProjectSettings(false);
            }}
            onOpenAdmin={openServerAdmin}
            onOpenSettings={() => openCompactRootSettings()}
            onSelectProject={selectProjectFromSidebar}
            onSelectWorkspace={selectProjectWorkspace}
          />
        ) : showSettings ? (
          <SettingsPage
            initialSection={settingsSection}
            initialPolicyId={settingsPolicyId}
            onPolicyOpenHandled={() => setSettingsPolicyId(null)}
            onOpenTunnelOwner={openTunnelOwner}
          />
        ) : showServerAdmin ? (
          <ServerAdminPage />
        ) : showProjectSettings && selectedProject ? (
          <ProjectSettingsPage
            desktopRuntime={desktopRuntime && projectRevealLabel !== null}
            initialWorkflowId={selectedWorkflowIntentId}
            project={selectedProject}
            chats={chats.data ?? []}
            codeTabs={codeTabs.data ?? []}
            terminals={terminals.data ?? []}
            explorers={explorers.data ?? []}
            projectViews={projectViews.data ?? []}
            workers={workers.data ?? []}
            worktrees={worktrees.data ?? []}
            statuses={worktreeStatuses}
            onCreateChat={(worktreeId) =>
              newChat.mutate({
                projectId: selectedProject.id,
                worktreeId,
                worktreeMode: "pinned",
              })
            }
            onCreateCode={(worktreeId) =>
              newCodeTab.mutate({
                projectId: selectedProject.id,
                worktreeId,
              })
            }
            onCreateTerminal={(worktreeId) =>
              newTerminal.mutate({
                projectId: selectedProject.id,
                worktreeId,
              })
            }
            onCreateExplorer={(worktreeId) =>
              newExplorer.mutate({
                projectId: selectedProject.id,
                worktreeId,
              })
            }
            onCreateHistory={(worktreeId) =>
              newProjectView.mutate({
                projectId: selectedProject.id,
                kind: "history",
                worktreeId,
              })
            }
            onRestoreChat={(chat) =>
              openCreatedTab(chat.projectId, "chat", chat.id)
            }
            onOpenTunnelOwner={openTunnelOwner}
            onOpenImportedChat={(chatId) =>
              openCreatedTab(selectedProject.id, "chat", chatId)
            }
            onOpenPolicySettings={(policyId) => {
              setSettingsPolicyId(policyId ?? null);
              setSettingsSection("policies");
              setShowSettings(true);
              setShowServerAdmin(false);
              setShowImporter(false);
              setShowProjectSettings(false);
            }}
          />
        ) : showImporter ? (
          <RepositoryImporter
            activeWorkspaceId={activeProjectWorkspace?.id ?? null}
            onCreatedProject={(project) => {
              setSelectedProjectId(project.id);
              setWorkspaceSelection(emptyWorkspaceSelection(project.id));
              resetMobileBottomTabs();
              setPendingSurfaceSelection(null);
              setChatConsoleChatId(null);
              setShowImporter(false);
              setShowSettings(false);
              setShowServerAdmin(false);
              setShowProjectSettings(false);
              setCreatedRepositoryOnboarding({
                openInitialChat: !compactShell,
                projectId: project.id,
              });
            }}
            projects={projects.data ?? []}
            projectSetupJobs={projectSetupJobs}
            workerId={onlineWorker?.workerId ?? null}
            workspaces={projectWorkspaces.data ?? []}
          />
        ) : compactShell && mobileTabGridOpen && selectedProject ? (
          <MobileProjectTabGrid
            activeGroupId={activeMobileBottomTab?.groupId}
            activeTabByGroup={workspaceSelection.activeTabByGroup}
            creatingKinds={creatingSurfaceKinds}
            layout={tabLayout.data}
            surfaces={projectSurfaces}
            onCreate={(kind, target) =>
              createProjectSurface(selectedProject.id, kind, undefined, target)
            }
            placement={selectedPlacementContext}
            onRemoveBottomTab={
              activeMobileBottomTabId === PRIMARY_MOBILE_BOTTOM_TAB_ID
                ? undefined
                : removeActiveMobileBottomTab
            }
            onSelectGroup={selectGroupFromMobileSwitcher}
          />
        ) : groupOwnedElsewhere && selectedTabGroup ? (
          <div className="grid flex-1 place-items-center p-6 text-center">
            <div>
              <div className="mx-auto grid size-12 place-items-center rounded-2xl border bg-card">
                <ExternalLink className="size-5" />
              </div>
              <h1 className="mt-4 font-semibold">Open in another window</h1>
              <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                This tab group is attached to its desktop pop-out.
              </p>
              <Button
                className="mt-5"
                variant="outline"
                onClick={() =>
                  void focusDesktopPopoutGroup(selectedTabGroup.id)
                    .then((focused) => {
                      if (!focused) {
                        void resumeDetachedGroup(selectedTabGroup.id);
                      }
                    })
                    .catch((error: unknown) => setPopoutError(errorText(error)))
                }
              >
                <ExternalLink className="size-4" />
                Focus window
              </Button>
            </div>
          </div>
        ) : selectedProjectView?.kind === "remote-desktop" ? (
          remoteDesktop.data ? (
            <Suspense
              fallback={
                <div className="grid flex-1 place-items-center text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                </div>
              }
            >
              <RemoteDesktopView
                desktop={remoteDesktop.data}
                fleetDiscovery={
                  bootstrap.data?.capabilities.remoteDesktopFleet ?? false
                }
                workerName={selectedWorker?.name}
                onOpenFleetTarget={(
                  workerId: string,
                  desktopTarget: RemoteDesktopTarget,
                ) =>
                  newRemoteDesktop.mutate({
                    projectId: remoteDesktop.data.projectId,
                    tabGroupId: selectedTabGroup?.id,
                    target: {
                      kind: "worker",
                      projectId: remoteDesktop.data.projectId,
                      workerId,
                    },
                    desktopTarget,
                  })
                }
              />
            </Suspense>
          ) : remoteDesktop.isError ? (
            <div className="grid flex-1 place-items-center p-6 text-center text-sm text-destructive">
              {errorText(remoteDesktop.error)}
            </div>
          ) : (
            <div className="grid flex-1 place-items-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          )
        ) : gitHistoryProject ? (
          <GitHistoryView
            key={selectedProjectView?.id}
            chats={chats.data ?? []}
            contentScrolled={contentScrolled}
            view={selectedProjectView?.kind ?? "history"}
            standalone={isPopout}
            project={gitHistoryProject}
            worktreeId={
              selectedProjectView?.worktreeId ??
              worktrees.data?.find(({ isPrimary }) => isPrimary)?.id ??
              ""
            }
            worktrees={worktrees.data ?? []}
            statuses={worktreeStatuses}
            workers={workers.data ?? []}
            onSelectWorktree={(worktreeId) => {
              if (
                !selectedProjectView ||
                selectedProjectView.kind !== "history"
              )
                return;
              queryClient.setQueryData<ProjectViewSummary[]>(
                ["project-views", selectedProjectView.projectId],
                (current = []) =>
                  current.map((view) =>
                    view.id === selectedProjectView.id
                      ? { ...view, worktreeId }
                      : view,
                  ),
              );
              bindWorktreeMutation.mutate({
                target: {
                  kind: "history",
                  projectId: selectedProjectView.projectId,
                  tabId: selectedProjectView.id,
                },
                worktreeId,
              });
            }}
            onCreateChat={(worktreeId) =>
              newChat.mutate({
                projectId: gitHistoryProject.id,
                worktreeId,
                worktreeMode: "pinned",
              })
            }
            onCreateTerminal={(worktreeId) =>
              newTerminal.mutate({
                projectId: gitHistoryProject.id,
                worktreeId,
              })
            }
            onCreateExplorer={(worktreeId) =>
              newExplorer.mutate({
                projectId: gitHistoryProject.id,
                worktreeId,
              })
            }
            onCreateHistory={(worktreeId) =>
              newProjectView.mutate({
                projectId: gitHistoryProject.id,
                kind: "history",
                worktreeId,
              })
            }
            onOpenChat={(chatId) =>
              openCreatedTab(gitHistoryProject.id, "chat", chatId)
            }
            onHeaderChange={setGitHistoryHeader}
          />
        ) : selectedCodeTab ? null : selectedBrowser ? (
          <Suspense
            fallback={
              <div className="grid flex-1 place-items-center text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
              </div>
            }
          >
            <BrowserView
              browser={selectedBrowser}
              fleetDiscovery={
                bootstrap.data?.capabilities.browserFleetDiscovery ?? false
              }
              onOpenService={(service: BrowserFleetService) =>
                newBrowser.mutate({
                  projectId: selectedBrowser.projectId,
                  tabGroupId: selectedTabGroup?.id,
                  target: {
                    kind: "worker",
                    projectId: selectedBrowser.projectId,
                    workerId: service.workerId,
                  },
                  title:
                    service.title ??
                    service.processName ??
                    `Port ${service.port}`,
                  url: service.url,
                })
              }
              onPageState={(state) => {
                const input = browserUpdateForPageState(selectedBrowser, state);
                if (input) {
                  updateBrowserMutation.mutate({
                    browserId: selectedBrowser.id,
                    input,
                  });
                }
              }}
            />
          </Suspense>
        ) : selectedExplorer ? null : selectedTerminal ? (
          <Suspense
            fallback={
              <div className="grid flex-1 place-items-center text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
              </div>
            }
          >
            {linkedConsoleChat ? (
              <TerminalView
                terminal={selectedTerminal}
                onExit={() => setChatConsoleChatId(null)}
              />
            ) : (
              <TerminalView
                terminal={selectedTerminal}
                commandPaletteOpen={
                  terminalCommandPaletteTerminalId === selectedTerminal.id
                }
                onCommandPaletteOpenChange={(open) =>
                  setTerminalCommandPaletteTerminalId(
                    open ? selectedTerminal.id : null,
                  )
                }
                servicePanelOpen={
                  terminalServiceTerminalId === selectedTerminal.id
                }
                onServicePanelOpenChange={(open) =>
                  setTerminalServiceTerminalId(
                    open ? selectedTerminal.id : null,
                  )
                }
              />
            )}
          </Suspense>
        ) : selectedChat?.experience === "task" &&
          selectedTaskView ? null : selectedChat ? (
          <ChatTranscript
            key={selectedChat.id}
            chat={selectedChat}
            inspectOnly={selectedChat.experience === "task"}
            inspectOpen={agentInspectOpenChats.has(selectedChat.id)}
            inspectOverlay={narrowViewport}
            settings={settings.data}
            syncEnabled
            onCreateChat={() =>
              newChat.mutate({ projectId: selectedChat.projectId })
            }
            onDelete={() => {
              setAgentInspectOpen(selectedChat.id, false);
              deleteChatMutation.mutate(selectedChat.id);
            }}
            onForked={(forked) =>
              openCreatedTab(forked.projectId, "chat", forked.id)
            }
            onInspectOpenChange={(open) =>
              setAgentInspectOpen(selectedChat.id, open)
            }
            onOpenWorkflow={(workflowId) =>
              openProjectSettings(selectedChat.projectId, workflowId)
            }
            onOpenRelocation={() => setChatRelocationOpen(true)}
            onRename={(title) =>
              renameChatMutation.mutate({ chatId: selectedChat.id, title })
            }
            relocationJob={currentRelocation}
          />
        ) : selectedProject ? (
          selectedProject.setupStatus !== "ready" ? (
            <div className="grid flex-1 place-items-center p-6 text-center">
              <div>
                <div className="mx-auto grid size-12 place-items-center rounded-2xl border bg-card">
                  {selectedProject.setupStatus === "cloning" ? (
                    <Loader2 className="size-5 animate-spin" />
                  ) : (
                    <CircleAlert className="size-5 text-destructive" />
                  )}
                </div>
                <h1 className="mt-4 font-semibold">
                  {selectedProject.setupStatus === "cloning"
                    ? "Cloning repository…"
                    : "Repository setup failed"}
                </h1>
                <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                  {selectedProject.setupStatus === "cloning"
                    ? `${selectedProject.github?.nameWithOwner ?? selectedProject.name} is being prepared on the worker. You can keep adding other projects while it finishes.`
                    : (selectedProject.setupError ??
                      "The worker could not prepare this repository.")}
                </p>
                {selectedProject.setupStatus === "cloning" ? (
                  <div className="mx-auto mt-4 w-full max-w-sm text-left">
                    <div
                      aria-label="Repository clone progress"
                      aria-valuemax={100}
                      aria-valuemin={0}
                      aria-valuenow={projectSetupPercent(
                        selectedProjectSetupJob,
                      )}
                      className="h-1.5 overflow-hidden rounded-full bg-muted"
                      role="progressbar"
                    >
                      <div
                        className={cn(
                          "h-full rounded-full bg-primary transition-[width] duration-500",
                          !selectedProjectSetupJob && "animate-pulse",
                        )}
                        style={{
                          width: `${projectSetupPercent(selectedProjectSetupJob)}%`,
                        }}
                      />
                    </div>
                    <div className="mt-2 flex items-start justify-between gap-3 text-xs text-muted-foreground">
                      <span>
                        {selectedProjectSetupJob?.progress.message ??
                          "Waiting for the worker to start cloning."}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {selectedProjectSetupJob
                          ? `${selectedProjectSetupJob.progress.percent}%`
                          : "Starting"}
                      </span>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : projectOverviewSelected ? (
            <ProjectOverview
              compact={compactShell}
              creatingKinds={creatingSurfaceKinds}
              project={selectedProject}
              stats={repositoryStats.data}
              statsError={
                repositoryStats.isError
                  ? errorText(repositoryStats.error)
                  : null
              }
              statsLoading={repositoryStats.isLoading}
              usage={projectTokenUsage.data}
              usageError={
                projectTokenUsage.isError
                  ? errorText(projectTokenUsage.error)
                  : null
              }
              usageLoading={projectTokenUsage.isLoading}
              surfaces={projectSurfaces}
              workerOnline={Boolean(
                workers.data?.find(
                  ({ workerId }) =>
                    workerId === selectedProject.source?.workerId,
                )?.online,
              )}
              worktrees={worktrees.data ?? []}
              onCreateSurface={(kind, target) =>
                createProjectSurface(
                  selectedProject.id,
                  kind,
                  undefined,
                  target,
                )
              }
              placement={selectedPlacementContext}
              onOpenSurface={selectTopTab}
              onOpenTabs={() => setMobileTabGridOpen(true)}
            />
          ) : (
            <div className="grid flex-1 place-items-center p-6 text-center">
              <div>
                <div className="mx-auto grid size-12 place-items-center rounded-2xl border bg-card">
                  <SquareTerminal className="size-5" />
                </div>
                <h1 className="mt-4 font-semibold">No tabs yet</h1>
                <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                  Start a Codex agent, shell, file explorer, Code workspace, or
                  browser in {selectedProject.name}.
                </p>
                <div className="mt-5 flex justify-center gap-2">
                  <Button
                    disabled={newChat.isPending || !selectedProject.source}
                    onClick={() =>
                      newChat.mutate({ projectId: selectedProject.id })
                    }
                  >
                    {newChat.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Plus className="size-4" />
                    )}
                    Agent
                  </Button>
                  <Button
                    variant="outline"
                    disabled={newTerminal.isPending || !selectedProject.source}
                    onClick={() =>
                      newTerminal.mutate({ projectId: selectedProject.id })
                    }
                  >
                    {newTerminal.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Plus className="size-4" />
                    )}
                    Terminal
                  </Button>
                  <Button
                    variant="outline"
                    disabled={newExplorer.isPending || !selectedProject.source}
                    onClick={() =>
                      newExplorer.mutate({ projectId: selectedProject.id })
                    }
                  >
                    {newExplorer.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <FolderTree className="size-4" />
                    )}
                    Explorer
                  </Button>
                  <Button
                    variant="outline"
                    disabled={newBrowser.isPending || !selectedProject.source}
                    onClick={() =>
                      newBrowser.mutate({ projectId: selectedProject.id })
                    }
                  >
                    {newBrowser.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Globe2 className="size-4" />
                    )}
                    Browser
                  </Button>
                  <Button
                    variant="outline"
                    disabled={newCodeTab.isPending || !selectedProject.source}
                    onClick={() =>
                      newCodeTab.mutate({ projectId: selectedProject.id })
                    }
                  >
                    {newCodeTab.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Code2 className="size-4" />
                    )}
                    Code
                  </Button>
                </div>
                {newChat.isError ? (
                  <p className="mt-3 text-xs text-destructive">
                    {errorText(newChat.error)}
                  </p>
                ) : null}
              </div>
            </div>
          )
        ) : (
          <div className="grid flex-1 place-items-center p-6 text-center">
            <div>
              <div className="mx-auto grid size-12 place-items-center rounded-2xl border bg-card">
                <GitBranch className="size-5" />
              </div>
              <h1 className="mt-4 font-semibold">Add your first project</h1>
              <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                Choose an accessible GitHub repository and Cantrip will clone it
                onto the local worker.
              </p>
              <Button
                className="mt-5"
                onClick={() => {
                  setShowImporter(true);
                  setShowSettings(false);
                  setShowServerAdmin(false);
                  setShowProjectSettings(false);
                }}
              >
                <Plus className="size-4" />
                Add from GitHub
              </Button>
            </div>
          </div>
        )}
        {compactShell &&
        selectedProject &&
        !showImporter &&
        !showSettings &&
        !showServerAdmin &&
        !showProjectSettings ? (
          <MobileBottomNavigation
            activeItemId={activeMobileBottomTabId}
            gridOpen={mobileTabGridOpen}
            items={mobileBottomNavigationItems}
            onAdd={addMobileBottomTab}
            onOverview={selectMobileOverview}
            onReset={openMobileBottomTabSwitcher}
            onSelect={selectMobileBottomTab}
            overviewSelected={
              !mobileTabGridOpen &&
              workspaceSelection.destination === "overview"
            }
          />
        ) : null}
      </section>

      <WorktreeCreateDialog
        open={Boolean(worktreeCreateTarget)}
        pending={
          createWorktreeMutation.isPending || bindWorktreeMutation.isPending
        }
        onOpenChange={(open) => {
          if (!open) setWorktreeCreateTarget(null);
        }}
        onSubmit={async (input) => {
          const target = worktreeCreateTarget;
          if (!target) return;
          if (!(await prepareExplorerRebind(target))) return;
          const created = await createWorktreeMutation.mutateAsync({
            projectId: target.projectId,
            input,
          });
          await bindWorktreeMutation.mutateAsync({
            target,
            worktreeId: created.id,
          });
          await queryClient.invalidateQueries({
            queryKey: ["worktrees", target.projectId],
          });
        }}
      />

      {activeChat ? (
        <CustomizationPanel
          key={`customization:${activeChat.id}`}
          chatId={activeChat.id}
          chatTitle={activeChat.title}
          open={showCustomizations}
          onOpenChange={setShowCustomizations}
        />
      ) : null}

      {activeChat && selectedPlacementContext ? (
        <ChatRelocationDialog
          key={`relocation:${activeChat.id}`}
          available={Boolean(bootstrap.data?.capabilities.workerSwitching)}
          chat={activeChat}
          jobs={chatRelocations.data ?? []}
          jobsError={chatRelocations.error}
          jobsLoading={chatRelocations.isLoading}
          open={chatRelocationOpen}
          onOpenChange={setChatRelocationOpen}
          placement={selectedPlacementContext}
          statuses={worktreeStatuses}
          synchronizationPolicy={
            settings.data?.preferences.automaticReplicaSynchronization ?? "off"
          }
        />
      ) : null}

      {surfaceCreationFailure ? (
        <div className="fixed bottom-5 right-5 z-50 max-w-md rounded-lg bg-destructive px-4 py-3 text-sm text-destructive-foreground shadow-xl">
          Could not create {surfaceCreationFailure.label}:{" "}
          {errorText(surfaceCreationFailure.error)}
        </div>
      ) : null}
    </WorkspaceDndProvider>
  );
}
