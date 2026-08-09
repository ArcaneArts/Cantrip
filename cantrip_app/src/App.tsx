import type {
  AgentInteractionResponse,
  BrowserSummary,
  ChatAttachmentSummary,
  ChatMessage,
  ChatPlanAnswer,
  ChatSummary,
  ChatTurnMode,
  CodeAppearance,
  CodeTabSummary,
  ExplorerSummary,
  GithubRepository,
  ModelProfileSummary,
  ProjectSummary,
  ProjectTabLayoutSummary,
  ProjectWorktreeCreate,
  ProjectWorktreeSummary,
  ProjectViewKind,
  ProjectViewSummary,
  QueuedPrompt,
  SettingsBundle,
  SkillSummary,
  TerminalSummary,
} from "@cantrip/protocol";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
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
  MessageSquare,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  Power,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  Settings,
  SquareTerminal,
  User,
  WandSparkles,
} from "lucide-react";
import {
  lazy,
  Suspense,
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
import { CustomizationPanel } from "@/components/chat/customization-panel";
import { GoalPanel } from "@/components/chat/goal-panel";
import { PlanPanel } from "@/components/chat/plan-panel";
import { Markdown } from "@/components/chat/markdown";
import {
  filterCommandPalette,
  type CommandPaletteSuggestion,
} from "@/components/chat/command-palette";
import { PromptQueue } from "@/components/chat/prompt-queue";
import type { CodeHeaderState } from "@/components/code/code-view";
import { PermissionProfileControl } from "@/components/chat/permission-profile-control";
import {
  activeSkillMention,
  filterSkills,
  insertSkillMention,
  skillMentionSegments,
} from "@/components/chat/skill-mentions";
import { buildChatTimeline } from "@/components/chat/timeline";
import {
  slashCommandQuery,
  type SlashCommandSuggestion,
} from "@/components/chat/slash-commands";
import {
  GitHistoryView,
  type GitHistoryHeaderState,
} from "@/components/git/git-history";
import type { ExplorerHeaderState } from "@/components/explorer/explorer-view";
import { ProjectChatList } from "@/components/sidebar/project-chat-list";
import { ProjectSettingsPage } from "@/components/projects/project-settings-page";
import { SettingsPage } from "@/components/settings/settings-page";
import { ServerSwitcher } from "@/components/servers/server-switcher";
import {
  WorktreeControl,
  WorktreeCreateDialog,
  type WorktreeStatusMap,
} from "@/components/worktrees/worktree-control";
import { hasScrolledContent } from "@/lib/scroll-divider";
import { useAppLiveScope, useAppLiveStatus } from "@/lib/app-live-react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createBrowser,
  createCodeTab,
  chatAttachmentContentUrl,
  answerChatPlan,
  createChat,
  createChatConsole,
  createExplorer,
  createGithubProject,
  createProjectWorktree,
  createProjectView,
  createRemoteDesktop,
  createTerminal,
  compactChat,
  clearChatGoal,
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
  getChatPlan,
  getChatPermissionProfiles,
  getBrowsers,
  getCodeTabs,
  getCachedGithubRepositories,
  getExplorers,
  getGithubRepositories,
  getGithubStatus,
  getMessages,
  getAgentInteractionRequests,
  getProjects,
  getProjectTabLayout,
  getProjectWorktrees,
  getProjectWorktreeStatus,
  getProjectViews,
  getRemoteDesktop,
  getQueuedPrompts,
  getServerBootstrap,
  getSettings,
  getSkills,
  getTerminals,
  getWorkers,
  getWorkflows,
  getWorkflowAutomationTriggers,
  invokeSavedWorkflowCommand,
  renameChat,
  renameExplorer,
  renameProjectView,
  renameTerminal,
  removeProject,
  reorderProjectTabGroups,
  reorderProjects,
  reorderQueuedPrompts,
  respondToAgentInteractionRequest,
  setChatPaused,
  startTurn,
  steerQueuedPrompt,
  syncChat,
  updateChatModel,
  updateChatGoal,
  updateChatPermissionProfile,
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
  isDesktopRuntime,
  openDesktopPopout,
  parseDesktopPopoutTarget,
  shouldUseOverlayTitlebar,
  updateDesktopWindowTheme,
  updateDesktopWindowTitle,
  type DesktopPopoutTarget,
} from "@/lib/desktop-popout";
import { browserUpdateForPageState } from "@/lib/browser-page-state";
import {
  buildProjectSurfaceIndex,
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
  emptyWorkspaceSelection,
  reconcileWorkspaceSelection,
  selectedWorkspaceTabKey,
  selectWorkspaceTab,
} from "@/lib/workspace-selection";

function modelDisplayName(model: ModelProfileSummary): string {
  const routeCount = model.routes.filter((route) => route.enabled).length;
  return `${model.name}${routeCount > 1 ? ` · Auto (${routeCount} routes)` : ""}`;
}

const TerminalView = lazy(() =>
  import("@/components/terminal/terminal-view").then((module) => ({
    default: module.TerminalView,
  })),
);
const ExplorerView = lazy(() =>
  import("@/components/explorer/explorer-view").then((module) => ({
    default: module.ExplorerView,
  })),
);
const BrowserView = lazy(() =>
  import("@/components/browser/browser-view").then((module) => ({
    default: module.BrowserView,
  })),
);
const CodeView = lazy(() =>
  import("@/components/code/code-view").then((module) => ({
    default: module.CodeView,
  })),
);
const RemoteDesktopView = lazy(() =>
  import("@/components/remote-desktop/remote-desktop-view").then((module) => ({
    default: module.RemoteDesktopView,
  })),
);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

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
              <div
                key={`text:${index}`}
                className="rounded-lg border-l-2 border-muted-foreground/30 bg-muted/30 px-3 py-2 text-muted-foreground"
              >
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide">
                  Commentary
                </p>
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

function CodeHeaderActions({
  floating = false,
  header,
}: {
  floating?: boolean;
  header: CodeHeaderState | null;
}) {
  const controlClass = floating
    ? "bg-background/75 shadow-md backdrop-blur-xl"
    : undefined;
  const runtimeIssue =
    header?.error ??
    (header?.status === "failed" || header?.status === "offline"
      ? `Editor ${header.status}.`
      : null);
  return (
    <div className="flex items-center gap-1.5">
      {runtimeIssue ? (
        <span
          className={cn(
            "grid size-8 place-items-center text-destructive",
            controlClass,
          )}
          role="status"
          title={runtimeIssue}
        >
          <CircleAlert className="size-4" />
          <span className="sr-only">{runtimeIssue}</span>
        </span>
      ) : header?.isBusy ? (
        <span
          className={cn(
            "grid size-8 place-items-center text-muted-foreground",
            controlClass,
          )}
          role="status"
          title="Connecting to editor"
        >
          <Loader2 className="size-4 animate-spin" />
          <span className="sr-only">Connecting to editor</span>
        </span>
      ) : null}
      <Button
        size="icon"
        variant={floating ? "outline" : "ghost"}
        className={cn("size-8", controlClass)}
        disabled={!header || header.isBusy || !header.runtime}
        onClick={() => void header?.saveAll()}
        title="Save all editors"
      >
        <Save className="size-4" />
        <span className="sr-only">Save all editors</span>
      </Button>
      <Button
        size="icon"
        variant={floating ? "outline" : "ghost"}
        className={cn("size-8", controlClass)}
        disabled={!header || header.isBusy}
        onClick={header?.reload}
        title="Reload editor surface"
      >
        <RefreshCw className="size-4" />
        <span className="sr-only">Reload editor surface</span>
      </Button>
      <Button
        size="icon"
        variant={floating ? "outline" : "ghost"}
        className={cn("size-8", controlClass)}
        disabled={!header || header.isBusy}
        onClick={() => void header?.restart()}
        title="Restart editor"
      >
        <RotateCcw className="size-4" />
        <span className="sr-only">Restart editor</span>
      </Button>
      <Button
        size="icon"
        variant={floating ? "outline" : "ghost"}
        className={cn("size-8", controlClass)}
        disabled={!header || header.isBusy || !header.runtime}
        onClick={() => void header?.stop()}
        title="Stop editor"
      >
        <Power className="size-4" />
        <span className="sr-only">Stop editor</span>
      </Button>
    </div>
  );
}

function RepositoryImporter({
  projects,
  workerId,
}: {
  projects: ProjectSummary[];
  workerId: string | null;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [pendingRepositoryIds, setPendingRepositoryIds] = useState<Set<string>>(
    new Set(),
  );
  const pendingRepositoryIdsRef = useRef(new Set<string>());
  const [importErrors, setImportErrors] = useState<Map<string, string>>(
    new Map(),
  );
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
  const queueImport = (repository: GithubRepository) => {
    if (!workerId || pendingRepositoryIdsRef.current.has(repository.id)) return;
    pendingRepositoryIdsRef.current.add(repository.id);
    setPendingRepositoryIds(new Set(pendingRepositoryIdsRef.current));
    setImportErrors((current) => {
      const next = new Map(current);
      next.delete(repository.id);
      return next;
    });

    void createGithubProject({
      workerId: workerId!,
      repositoryId: repository.id,
      nameWithOwner: repository.nameWithOwner,
      url: repository.url,
    })
      .then((project) => {
        queryClient.setQueryData<ProjectSummary[]>(
          ["projects"],
          (current = []) =>
            [...current.filter((item) => item.id !== project.id), project].sort(
              (left, right) => left.position - right.position,
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
      })
      .catch((error: unknown) => {
        setImportErrors((current) =>
          new Map(current).set(repository.id, errorText(error)),
        );
      })
      .finally(() => {
        pendingRepositoryIdsRef.current.delete(repository.id);
        setPendingRepositoryIds(new Set(pendingRepositoryIdsRef.current));
      });
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
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 overflow-hidden p-5 sm:p-8">
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
                  <thead className="sticky top-0 z-10 bg-background/95 text-[11px] uppercase tracking-wide text-muted-foreground backdrop-blur-xl">
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
                      const disabled = Boolean(
                        repository.imported || project || importing,
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
                                  ? "Cloning"
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
          </>
        )}
      </div>
    </div>
  );
}

function ChatTranscript({
  chat,
  onCreateChat,
  onDelete,
  onForked,
  onOpenWorkflow,
  onRename,
  settings,
  syncEnabled,
}: {
  chat: ChatSummary;
  onCreateChat(): void;
  onDelete(): void;
  onForked(chat: ChatSummary): void;
  onOpenWorkflow(workflowId: string): void;
  onRename(title: string): void;
  settings: SettingsBundle | undefined;
  syncEnabled: boolean;
}) {
  const queryClient = useQueryClient();
  const liveStatus = useAppLiveStatus();
  const chatResourcesLive = liveStatus === "live";
  const chatExecuting =
    chat.status === "running" || chat.status === "waiting-for-approval";
  const chatFallbackInterval = chatExecuting ? 3_000 : 10_000;
  const [draft, setDraft] = useState("");
  const [composerMode, setComposerMode] = useState<ChatTurnMode>("default");
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
  const [viewingAttachment, setViewingAttachment] =
    useState<ChatAttachmentSummary | null>(null);
  const commandListRef = useRef<HTMLDivElement>(null);
  const skillListRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
  const messages = useQuery({
    queryFn: () => getMessages(chat.id),
    queryKey: ["messages", chat.id],
    refetchInterval: chatResourcesLive ? false : chatFallbackInterval,
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
    refetchInterval: chatResourcesLive ? false : chatFallbackInterval,
    retry: false,
  });
  const queuedPrompts = useQuery({
    queryFn: () => getQueuedPrompts(chat.id),
    queryKey: ["prompt-queue", chat.id],
    refetchInterval: chatResourcesLive ? false : chatFallbackInterval,
  });
  const goalState = useQuery({
    queryFn: () => getChatGoal(chat.id),
    queryKey: ["goal", chat.id],
    refetchInterval: chatResourcesLive ? false : chatFallbackInterval,
    retry: false,
  });
  const planState = useQuery({
    queryFn: () => getChatPlan(chat.id),
    queryKey: ["plan", chat.id],
    refetchInterval: chatResourcesLive ? false : chatFallbackInterval,
    retry: false,
  });
  const interactionRequests = useQuery({
    queryFn: () =>
      getAgentInteractionRequests({ chatId: chat.id, status: "pending" }),
    queryKey: ["agent-requests", chat.id, "pending"],
    refetchInterval: chatResourcesLive ? false : chatFallbackInterval,
    retry: false,
  });
  const permissionProfiles = useQuery({
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
      text,
    }: {
      attachmentIds: string[];
      mode: ChatTurnMode;
      text: string;
    }) => startTurn(chat.id, text, selectedModelId, attachmentIds, mode),
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
    onSuccess: async () => {
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
  const selectPermissionProfile = useMutation({
    mutationFn: (id: string) => updateChatPermissionProfile(chat.id, id),
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

  useEffect(() => {
    setSelectedCommandIndex(0);
  }, [slashQuery]);

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
      (!text && readyAttachments.length === 0) ||
      !selectedModelId ||
      send.isPending ||
      selectModel.isPending ||
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
            clearDraftAttachments();
          },
        },
      );
      return;
    }
    send.mutate({
      text,
      mode: composerMode,
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
      const title = window.prompt("Rename chat", chat.title)?.trim();
      if (title) onRename(title);
    } else if (name === "delete") {
      if (window.confirm(`Delete “${chat.title}”? This cannot be undone.`)) {
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
        send.mutate({ text: prompt, attachmentIds: [], mode: composerMode });
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
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-4 pb-72 pt-6 sm:px-8">
        <div className="mx-auto flex max-w-3xl flex-col gap-5">
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
                  activities={entry.activities}
                  startedAt={entry.startedAt}
                  endedAt={entry.endedAt}
                />
              );
            }
            const message = entry.message;
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
                        title="Fork chat from this response"
                        disabled={fork.isPending}
                        onClick={() => fork.mutate(message.id)}
                      >
                        <GitFork className="size-3.5" />
                        <span className="sr-only">
                          Fork chat from this response
                        </span>
                      </Button>
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

          {chat.status === "running" ||
          chat.status === "waiting-for-approval" ? (
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <div className="grid size-7 place-items-center rounded-lg border bg-card">
                {chat.automationPaused ? (
                  <Pause className="size-3.5 text-amber-500" />
                ) : (
                  <Loader2 className="size-3.5 animate-spin" />
                )}
              </div>
              {chat.status === "waiting-for-approval"
                ? "Codex is waiting for your approval…"
                : chat.automationPaused
                  ? "Pause requested — Codex will hold at its next safe boundary…"
                  : planState.data?.question
                    ? "Codex is waiting for your plan answer…"
                    : `${selectedModel?.name ?? "Agent"} is working through Codex…`}
            </div>
          ) : null}
        </div>
      </div>

      <div
        aria-hidden="true"
        className="chat-composer-fade pointer-events-none absolute inset-x-0 bottom-0 z-10 h-56"
      />
      <form
        onSubmit={submit}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-4 pb-3 sm:px-8 sm:pb-4"
      >
        <div className="pointer-events-auto relative mx-auto max-w-3xl">
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
                  ? "Pausing when possible. The current turn may finish, but nothing automatic will advance."
                  : "Paused. Queued prompts, goals, and automatic continuations will wait for Resume."}
              </span>
            </div>
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
                    editingPrompt
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
              <div className="flex min-w-0 items-center gap-2 border-t px-1 pt-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
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
                  title="Attach files"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Plus className="size-4" />
                  <span className="sr-only">Attach files</span>
                </Button>
                <select
                  aria-label="Chat model"
                  value={selectedModelId}
                  disabled={
                    chat.status === "running" ||
                    chat.status === "waiting-for-approval" ||
                    selectModel.isPending
                  }
                  onChange={(event) => selectModel.mutate(event.target.value)}
                  className="min-w-0 max-w-64 truncate rounded-md bg-transparent px-1 py-1 text-xs font-medium outline-none disabled:cursor-not-allowed"
                >
                  {(settings?.models ?? []).map((model) => (
                    <option key={model.id} value={model.id}>
                      {modelDisplayName(model)}
                      {model.reasoningEffort
                        ? ` (${model.reasoningEffort})`
                        : ""}
                    </option>
                  ))}
                </select>
                <PermissionProfileControl
                  state={permissionProfiles.data}
                  disabled={
                    chat.status === "running" ||
                    chat.status === "waiting-for-approval"
                  }
                  pending={selectPermissionProfile.isPending}
                  onChange={(id) => selectPermissionProfile.mutate(id)}
                />
                <select
                  aria-label="Message mode"
                  value={composerMode}
                  onChange={(event) =>
                    setComposerMode(event.target.value as ChatTurnMode)
                  }
                  className={cn(
                    "h-7 shrink-0 rounded-md border bg-transparent px-2 text-xs font-medium outline-none",
                    composerMode === "goal"
                      ? "border-violet-500/30 text-violet-600 dark:text-violet-400"
                      : composerMode === "plan"
                        ? "border-sky-500/30 text-sky-600 dark:text-sky-400"
                        : "text-muted-foreground",
                  )}
                >
                  <option value="default">Mode: Default</option>
                  <option value="plan">Mode: Plan</option>
                  <option value="goal">Mode: Goal</option>
                </select>
                <Button
                  type="button"
                  size="sm"
                  variant={chat.automationPaused ? "outline" : "ghost"}
                  className={cn(
                    "h-7 px-2 text-xs",
                    chat.automationPaused
                      ? "border-amber-500/40 text-amber-700 dark:text-amber-300"
                      : "text-muted-foreground",
                  )}
                  disabled={setAutomationPaused.isPending}
                  onClick={() =>
                    setAutomationPaused.mutate(!chat.automationPaused)
                  }
                  title={
                    chat.automationPaused
                      ? "Resume automatic chat work"
                      : "Pause after the current safe boundary"
                  }
                >
                  {setAutomationPaused.isPending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : chat.automationPaused ? (
                    <Play className="size-3.5" />
                  ) : (
                    <Pause className="size-3.5" />
                  )}
                  {chat.automationPaused ? "Resume" : "Pause"}
                </Button>
              </div>
            </div>
            <Button
              size="icon"
              type="submit"
              disabled={
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
                updatePrompt.isPending
              }
            >
              {send.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              <span className="sr-only">Send prompt</span>
            </Button>
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
          compact.isError ||
          updatePrompt.isError ||
          removePrompt.isError ||
          steerPrompt.isError ||
          reorderPrompts.isError ||
          setAutomationPaused.isError ||
          selectPermissionProfile.isError ? (
            <p className="mt-2 text-xs text-destructive">
              {errorText(
                send.error ??
                  selectModel.error ??
                  compact.error ??
                  updatePrompt.error ??
                  removePrompt.error ??
                  steerPrompt.error ??
                  reorderPrompts.error ??
                  setAutomationPaused.error ??
                  selectPermissionProfile.error,
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
    </div>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const liveStatus = useAppLiveStatus();
  const projectResourcesLive = liveStatus === "live";
  const desktopRuntime = useMemo(() => isDesktopRuntime(), []);
  const overlayTitlebar = useMemo(
    () => shouldUseOverlayTitlebar(desktopRuntime, navigator.userAgent),
    [desktopRuntime],
  );
  const popoutTarget = useMemo(
    () =>
      desktopRuntime ? parseDesktopPopoutTarget(window.location.search) : null,
    [desktopRuntime],
  );
  const isPopout = popoutTarget !== null;
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    popoutTarget?.projectId ?? null,
  );
  const popoutTabKey = popoutTarget
    ? projectSurfaceTabKey(popoutTarget.kind, popoutTarget.tabId)
    : null;
  const [workspaceSelection, setWorkspaceSelection] = useState(() =>
    emptyWorkspaceSelection(popoutTarget?.projectId ?? null),
  );
  const [pendingSurfaceSelection, setPendingSurfaceSelection] = useState<{
    projectId: string;
    tabKey: string;
  } | null>(
    popoutTarget
      ? { projectId: popoutTarget.projectId, tabKey: popoutTabKey! }
      : null,
  );
  const [chatConsoleChatId, setChatConsoleChatId] = useState<string | null>(
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
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [selectedWorkflowIntentId, setSelectedWorkflowIntentId] = useState<
    string | null
  >(null);
  const [showCustomizations, setShowCustomizations] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
  const contentRootRef = useRef<HTMLElement>(null);
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

  const openCreatedTab = (
    projectId: string,
    kind: "browser" | "chat" | "code" | "explorer" | "terminal" | "view",
    tabId: string,
  ) => {
    const tabKey = projectSurfaceTabKey(kind, tabId);
    setSelectedProjectId(projectId);
    setPendingSurfaceSelection({ projectId, tabKey });
    setChatConsoleChatId(null);
    void queryClient.invalidateQueries({
      queryKey: ["project-tab-layout", projectId],
    });
    setShowImporter(false);
    setShowSettings(false);
    setShowProjectSettings(false);
    setSelectedWorkflowIntentId(null);
    setMobileNavigationOpen(false);
  };

  const openProjectSettings = (
    projectId: string,
    workflowId: string | null = null,
  ) => {
    setSelectedProjectId(projectId);
    setChatConsoleChatId(null);
    setShowImporter(false);
    setShowSettings(false);
    setShowProjectSettings(true);
    setSelectedWorkflowIntentId(workflowId);
    setMobileNavigationOpen(false);
  };

  const bootstrap = useQuery({
    queryFn: getServerBootstrap,
    queryKey: ["server-bootstrap"],
  });
  const workers = useQuery({
    queryFn: getWorkers,
    queryKey: ["workers"],
    refetchInterval: projectResourcesLive ? false : 10_000,
  });
  const settings = useQuery({ queryFn: getSettings, queryKey: ["settings"] });
  const saveSidebarWidth = useMutation({
    mutationFn: (width: number) => updateSettings({ sidebarWidth: width }),
    onSuccess: (bundle) => queryClient.setQueryData(["settings"], bundle),
    onError: (error) => {
      console.error("Could not save the sidebar width", error);
    },
  });
  const projects = useQuery({
    queryFn: getProjects,
    queryKey: ["projects"],
    refetchInterval: projectResourcesLive
      ? false
      : (query) =>
          query.state.data?.some((project) => project.setupStatus === "cloning")
            ? 3_000
            : 15_000,
  });
  const tabLayout = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getProjectTabLayout(selectedProjectId!),
    queryKey: ["project-tab-layout", selectedProjectId],
    refetchInterval: 1_000,
  });
  const worktrees = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getProjectWorktrees(selectedProjectId!),
    queryKey: ["worktrees", selectedProjectId],
    refetchInterval: projectResourcesLive ? false : 15_000,
  });
  const worktreeStatusQueries = useQueries({
    queries: (worktrees.data ?? []).map((worktree) => ({
      enabled: Boolean(
        workers.data?.find(({ workerId }) => workerId === worktree.workerId)
          ?.online && worktree.lifecycleState === "ready",
      ),
      queryFn: () =>
        getProjectWorktreeStatus(worktree.projectId, worktree.id).then(
          ({ status }) => status,
        ),
      queryKey: ["worktree-status", worktree.projectId, worktree.id],
      refetchInterval: 3_000,
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
      worktreeId,
      worktreeMode,
    }: {
      projectId: string;
      worktreeId?: string;
      worktreeMode?: "agent-managed" | "pinned";
    }) => createChat(projectId, "New chat", worktreeId, worktreeMode),
    onSuccess: (chat) => {
      queryClient.setQueryData<ChatSummary[]>(
        ["chats", chat.projectId],
        (current = []) =>
          [...current.filter((item) => item.id !== chat.id), chat].sort(
            (left, right) => left.position - right.position,
          ),
      );
      openCreatedTab(chat.projectId, "chat", chat.id);
      void queryClient.invalidateQueries({
        queryKey: ["chats", chat.projectId],
      });
    },
  });
  const newTerminal = useMutation({
    mutationFn: ({
      projectId,
      worktreeId,
    }: {
      projectId: string;
      worktreeId?: string;
    }) => createTerminal(projectId, "Terminal", worktreeId),
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
      worktreeId,
    }: {
      projectId: string;
      worktreeId?: string;
    }) => createExplorer(projectId, "Explorer", worktreeId),
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
    mutationFn: (projectId: string) => createBrowser(projectId, "Browser"),
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
      worktreeId,
    }: {
      projectId: string;
      worktreeId?: string;
    }) => createCodeTab(projectId, "Code", worktreeId),
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
      worktreeId,
    }: {
      projectId: string;
      kind: ProjectViewKind;
      worktreeId?: string;
    }) =>
      createProjectView(
        projectId,
        kind,
        kind === "remote-desktop" ? "Remote Desktop" : "Git",
        worktreeId,
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
    mutationFn: (projectId: string) => createRemoteDesktop(projectId),
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
      await queryClient.invalidateQueries({
        queryKey: ["chats", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", selectedProjectId],
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
      await queryClient.invalidateQueries({
        queryKey: ["explorers", selectedProjectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-tab-layout", selectedProjectId],
      });
    },
  });
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
  const reorderGroupsMutation = useMutation({
    mutationFn: ({
      projectId,
      groupIds,
    }: {
      projectId: string;
      groupIds: string[];
    }) => {
      const current = queryClient.getQueryData<ProjectTabLayoutSummary>([
        "project-tab-layout",
        projectId,
      ]);
      if (!current) throw new Error("The project tab layout is not loaded.");
      return reorderProjectTabGroups(projectId, current.revision, groupIds);
    },
    onMutate: async ({ projectId, groupIds }) => {
      const queryKey = ["project-tab-layout", projectId] as const;
      await queryClient.cancelQueries({ queryKey });
      const previous =
        queryClient.getQueryData<ProjectTabLayoutSummary>(queryKey);
      if (previous) {
        const groupById = new Map(
          previous.groups.map((group) => [group.id, group]),
        );
        queryClient.setQueryData<ProjectTabLayoutSummary>(queryKey, {
          ...previous,
          groups: groupIds.flatMap((id, position) => {
            const group = groupById.get(id);
            return group ? [{ ...group, position }] : [];
          }),
        });
      }
      return { previous, queryKey };
    },
    onError: (_error, _input, context) =>
      queryClient.setQueryData(context?.queryKey ?? [], context?.previous),
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
  const selectedProject = projects.data?.find(
    (project) => project.id === selectedProjectId,
  );
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
  const selectedWorker = workers.data?.find(
    (worker) =>
      worker.workerId ===
      (selectedCodeTab?.activeWorkerId ??
        activeWorktree?.workerId ??
        selectedProject?.source?.workerId),
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
    target: DesktopPopoutTarget;
    title: string;
  } | null>(() => {
    if (showImporter || showSettings || showProjectSettings) return null;
    if (selectedProjectView && selectedProject) {
      return {
        target: {
          kind: "view",
          projectId: selectedProject.id,
          tabId: selectedProjectView.id,
        },
        title: selectedProjectView.title,
      };
    }
    if (selectedCodeTab) {
      return {
        target: {
          kind: "code",
          projectId: selectedCodeTab.projectId,
          tabId: selectedCodeTab.id,
        },
        title: selectedCodeTab.title,
      };
    }
    if (selectedBrowser) {
      return {
        target: {
          kind: "browser",
          projectId: selectedBrowser.projectId,
          tabId: selectedBrowser.id,
        },
        title: selectedBrowser.title,
      };
    }
    if (selectedExplorer) {
      return {
        target: {
          kind: "explorer",
          projectId: selectedExplorer.projectId,
          tabId: selectedExplorer.id,
        },
        title: selectedExplorer.title,
      };
    }
    if (selectedChat) {
      return {
        target: {
          kind: "chat",
          projectId: selectedChat.projectId,
          tabId: selectedChat.id,
        },
        title: linkedConsoleTerminal
          ? `${selectedChat.title} · Codex console`
          : selectedChat.title,
      };
    }
    if (selectedTerminal) {
      return {
        target: {
          kind: "terminal",
          projectId: selectedTerminal.projectId,
          tabId: selectedTerminal.id,
        },
        title: selectedTerminal.title,
      };
    }
    return null;
  }, [
    linkedConsoleTerminal,
    selectedBrowser,
    selectedChat,
    selectedCodeTab,
    selectedExplorer,
    selectedProjectView,
    selectedTerminal,
    showImporter,
    showProjectSettings,
    showSettings,
  ]);
  const activePopout = desktopRuntime && !isPopout ? currentSurface : null;
  const activeContentKey = showImporter
    ? "importer"
    : showSettings
      ? "settings"
      : showProjectSettings
        ? `project-settings:${selectedProjectId ?? "none"}`
        : currentSurface
          ? `${currentSurface.target.kind}:${currentSurface.target.tabId}:${gitHistoryHeader?.section ?? "content"}`
          : `project:${selectedProjectId ?? "none"}`;
  const popOutActiveView = () => {
    if (!activePopout || popoutPending) return;
    setPopoutPending(true);
    setPopoutError(null);
    void openDesktopPopout(activePopout.target, activePopout.title)
      .catch((error: unknown) => setPopoutError(errorText(error)))
      .finally(() => setPopoutPending(false));
  };

  useEffect(() => {
    if (!isPopout || !currentSurface) return;
    const projectTitle =
      selectedProject?.github?.nameWithOwner ?? selectedProject?.name;
    const title = [currentSurface.title, projectTitle, "Cantrip"]
      .filter(Boolean)
      .join(" — ");
    void updateDesktopWindowTitle(title).catch((error: unknown) => {
      console.error("Could not update the pop-out window title", error);
    });
  }, [currentSurface, isPopout, selectedProject]);
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
        settings.data?.preferences.highContrast
          ? dark
            ? "high-contrast-dark"
            : "high-contrast-light"
          : dark
            ? "dark"
            : "light",
      );
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
      void updateDesktopWindowTheme(dark ? "dark" : "light").catch(
        (error: unknown) => {
          console.error("Could not update the desktop window theme", error);
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
  ]);

  useEffect(() => {
    if (!projects.data) return;
    if (projects.data.length === 0) {
      setShowImporter(true);
      setShowSettings(false);
      setShowProjectSettings(false);
      setSelectedProjectId(null);
      return;
    }
    if (!projects.data.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(projects.data[0]?.id ?? null);
    }
  }, [projects.data, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setWorkspaceSelection(emptyWorkspaceSelection());
      return;
    }
    const layout = tabLayout.data;
    if (!layout || layout.projectId !== selectedProjectId) return;
    const pendingTabKey =
      pendingSurfaceSelection?.projectId === selectedProjectId &&
      layout.groups.some(({ members }) =>
        members.some(({ tabKey }) => tabKey === pendingSurfaceSelection.tabKey),
      )
        ? pendingSurfaceSelection.tabKey
        : null;
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

  const revealWorkspace = () => {
    setMobileNavigationOpen(false);
    setShowImporter(false);
    setShowSettings(false);
    setShowProjectSettings(false);
  };
  const selectProjectFromSidebar = (projectId: string) => {
    setSelectedProjectId(projectId);
    setChatConsoleChatId(null);
    if (workspaceSelection.projectId !== projectId) {
      setWorkspaceSelection(emptyWorkspaceSelection(projectId));
    }
    revealWorkspace();
  };
  const selectTabFromSidebar = (tabKey: string) => {
    const layout = tabLayout.data;
    if (layout) {
      setWorkspaceSelection((current) =>
        selectWorkspaceTab(current, layout, tabKey),
      );
    } else if (selectedProjectId) {
      setPendingSurfaceSelection({ projectId: selectedProjectId, tabKey });
    }
    setChatConsoleChatId(null);
    revealWorkspace();
  };

  return (
    <main
      className="flex h-svh overflow-hidden bg-background text-foreground"
      data-tauri-titlebar={overlayTitlebar ? "overlay" : undefined}
    >
      {!isPopout ? (
        <div
          data-slot="app-sidebar-shell"
          className={cn(
            "group/sidebar-shell relative hidden shrink-0 md:block",
            sidebarResizing
              ? "transition-none"
              : "transition-[width] duration-150 ease-out motion-reduce:transition-none",
          )}
          style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
        >
          <aside
            ref={sidebarRef}
            data-slot="app-sidebar"
            data-state={sidebarCollapsed ? "collapsed" : "expanded"}
            aria-hidden={sidebarCollapsed}
            inert={sidebarCollapsed}
            className={cn(
              "group/sidebar absolute inset-y-0 left-0 flex flex-col bg-background transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
              sidebarCollapsed
                ? "pointer-events-none -translate-x-2 opacity-0"
                : "translate-x-0 opacity-100",
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
                onClick={() => setSidebarCollapsed(true)}
                title="Collapse sidebar"
              >
                <PanelLeftClose
                  className={overlayTitlebar ? "size-3" : "size-4"}
                />
                <span className="sr-only">Collapse sidebar</span>
              </Button>
            </div>

            <div className="flex items-center justify-between px-4 pb-2 pt-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Projects
              </p>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                onClick={() => {
                  setShowImporter(true);
                  setShowSettings(false);
                  setShowProjectSettings(false);
                }}
              >
                <Plus className="size-4" />
                <span className="sr-only">Add project</span>
              </Button>
            </div>

            <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
              <ProjectChatList
                browsers={browsers.data ?? []}
                projects={projects.data ?? []}
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
                creatingChat={newChat.isPending}
                creatingCode={newCodeTab.isPending}
                creatingBrowser={newBrowser.isPending}
                creatingExplorer={newExplorer.isPending}
                creatingRemoteDesktop={newRemoteDesktop.isPending}
                creatingTerminal={newTerminal.isPending}
                creatingView={newProjectView.isPending}
                onCreateChat={(projectId) => newChat.mutate({ projectId })}
                onCreateCode={(projectId) => newCodeTab.mutate({ projectId })}
                onCreateBrowser={(projectId) => newBrowser.mutate(projectId)}
                onCreateExplorer={(projectId) =>
                  newExplorer.mutate({ projectId })
                }
                onCreateGit={(projectId) =>
                  newProjectView.mutate({ projectId, kind: "history" })
                }
                onCreateRemoteDesktop={(projectId) => {
                  newRemoteDesktop.reset();
                  newRemoteDesktop.mutate(projectId);
                }}
                onCreateTerminal={(projectId) =>
                  newTerminal.mutate({ projectId })
                }
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
                  updateBrowserMutation.mutate({ browserId, input: { title } })
                }
                onDeleteBrowser={(browserId) =>
                  deleteBrowserMutation.mutate(browserId)
                }
                onRenameExplorer={(explorerId, title) =>
                  renameExplorerMutation.mutate({ explorerId, title })
                }
                onDeleteExplorer={(explorerId) =>
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
                  removeProjectMutation.mutate({ projectId, deleteLocalFiles })
                }
                onOpenProjectSettings={openProjectSettings}
                onReorderProjects={(ids) => reorderProjectsMutation.mutate(ids)}
                onReorderGroups={(projectId, groupIds) =>
                  reorderGroupsMutation.mutate({ projectId, groupIds })
                }
                onSelectProject={selectProjectFromSidebar}
                onSelectTab={selectTabFromSidebar}
              />
            </nav>

            <div className="p-3">
              <div className="flex items-center gap-1">
                <ServerSwitcher
                  currentUserName={
                    bootstrap.data?.auth.currentUser.displayName ??
                    "Cantrip User"
                  }
                  workerName={onlineWorker?.name ?? "Worker offline"}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  onClick={() => {
                    setShowSettings(true);
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
        </div>
      ) : null}

      <section
        ref={contentRootRef}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {!isPopout ? (
          <header
            className={cn(
              "relative z-30 flex shrink-0 items-center justify-between",
              overlayTitlebar
                ? "h-8 gap-2 px-3 text-[11px] sm:px-4 [&_[data-slot=badge]]:h-5 [&_[data-slot=badge]]:gap-1 [&_[data-slot=badge]]:px-1.5 [&_[data-slot=badge]]:text-[10px] [&_[data-slot=button]]:h-6 [&_[data-slot=button]]:min-w-6 [&_[data-slot=button]]:w-auto [&_[data-slot=button]]:gap-1 [&_[data-slot=button]]:px-1.5 [&_[data-slot=button]]:py-0 [&_[data-slot=button]]:text-[11px] [&_svg]:size-3"
                : "h-16 gap-4 px-4 sm:px-6",
            )}
            data-slot="content-titlebar"
            data-tauri-drag-region={overlayTitlebar ? "" : undefined}
          >
            {sidebarCollapsed ? (
              <Button
                size="icon"
                variant="ghost"
                className={cn(
                  "absolute hidden size-8 md:inline-flex",
                  overlayTitlebar ? "left-20 top-1" : "left-4 top-4",
                )}
                onClick={() => setSidebarCollapsed(false)}
                title="Expand sidebar"
              >
                <PanelLeftOpen className="size-4" />
                <span className="sr-only">Expand sidebar</span>
              </Button>
            ) : null}
            <div
              className={cn(
                "min-w-0",
                overlayTitlebar &&
                  "flex flex-1 items-center gap-2 overflow-hidden",
                sidebarCollapsed &&
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
                <span
                  className="truncate"
                  data-tauri-drag-region={overlayTitlebar ? "" : undefined}
                >
                  {showImporter
                    ? "GitHub repositories"
                    : showSettings
                      ? "Settings"
                      : showProjectSettings
                        ? "Project settings"
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
                                      ? (linkedConsoleChat?.title ?? "Chat")
                                      : selectedTerminal.title
                                    : selectedChat
                                      ? selectedChat.title
                                      : (selectedProject?.github
                                          ?.nameWithOwner ?? "Cantrip")}
                </span>
                {!showImporter &&
                !showSettings &&
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
                        bindWorktreeMutation.mutate({
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
                ) : showProjectSettings ? (
                  (selectedProject?.github?.nameWithOwner ??
                  selectedProject?.name ??
                  "Project preferences")
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
                    "Chat")
                  ) : (
                    (activeWorktree?.displayPath ??
                    selectedProject?.source?.displayPath ??
                    "Terminal")
                  )
                ) : selectedChat ? (
                  (activeWorktree?.displayPath ??
                  selectedProject?.source?.displayPath ??
                  "Chat")
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
              {!isPopout ? (
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setMobileNavigationOpen(true)}
                >
                  <PanelLeft className="size-4" />
                  <span className="sr-only">Open projects and chats</span>
                </Button>
              ) : null}
              {gitHistoryProject &&
              gitHistoryHeader?.section === "history" &&
              gitHistoryHeader ? (
                <>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={gitHistoryHeader.isGitActionPending}
                    onClick={gitHistoryHeader.pull}
                  >
                    <ArrowDownToLine className="size-4" />
                    <span className="sr-only">Fetch and pull</span>
                  </Button>
                  {gitHistoryHeader.canPush ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={gitHistoryHeader.isGitActionPending}
                      onClick={gitHistoryHeader.push}
                    >
                      <ArrowUpFromLine className="size-4" />
                      <span className="sr-only">Push</span>
                    </Button>
                  ) : null}
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={gitHistoryHeader.isFetching}
                    onClick={gitHistoryHeader.refresh}
                  >
                    <RefreshCw
                      className={cn(
                        "size-4",
                        gitHistoryHeader.isFetching && "animate-spin",
                      )}
                    />
                    <span className="sr-only">Refresh Git history</span>
                  </Button>
                </>
              ) : null}
              {selectedExplorer && explorerHeader ? (
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={explorerHeader.isFetching}
                  onClick={explorerHeader.refresh}
                >
                  <RefreshCw
                    className={cn(
                      "size-4",
                      explorerHeader.isFetching && "animate-spin",
                    )}
                  />
                  <span className="sr-only">Refresh folder</span>
                </Button>
              ) : null}
              {selectedCodeTab ? (
                <CodeHeaderActions header={codeHeader} />
              ) : null}
              {activePopout ? (
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={popoutPending}
                  className={cn(popoutError && "text-destructive")}
                  onClick={popOutActiveView}
                  title={popoutError ?? "Open this tab in a new window"}
                >
                  {popoutPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ExternalLink className="size-4" />
                  )}
                  <span className="sr-only">Open this tab in a new window</span>
                </Button>
              ) : null}
              {activeChat && !showImporter && !showSettings ? (
                <>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setShowCustomizations(true)}
                  >
                    <WandSparkles className="size-4" />
                    <span className="sr-only">
                      Inspect Codex customizations
                    </span>
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-pressed={Boolean(linkedConsoleChat)}
                    disabled={!linkedConsoleChat && openChatConsole.isPending}
                    onClick={() =>
                      linkedConsoleChat
                        ? setChatConsoleChatId(null)
                        : showChatConsole(activeChat)
                    }
                  >
                    {linkedConsoleChat ? (
                      <MessageSquare className="size-4" />
                    ) : openChatConsole.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <SquareTerminal className="size-4" />
                    )}
                    <span className="sr-only">
                      {linkedConsoleChat ? "Show chat" : "Show Codex console"}
                    </span>
                  </Button>
                </>
              ) : null}
              {!isPopout ? (
                <>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => {
                      setShowSettings(true);
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
              {gitHistoryProject &&
              gitHistoryHeader?.section === "history" &&
              gitHistoryHeader ? (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={gitHistoryHeader.isGitActionPending}
                    onClick={gitHistoryHeader.pull}
                    title="Fetch remotes and pull"
                  >
                    <ArrowDownToLine className="size-4" /> Pull
                  </Button>
                  {gitHistoryHeader.canPush ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={gitHistoryHeader.isGitActionPending}
                      onClick={gitHistoryHeader.push}
                      title="Push local commits"
                    >
                      <ArrowUpFromLine className="size-4" /> Push
                    </Button>
                  ) : null}
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={gitHistoryHeader.isFetching}
                    onClick={gitHistoryHeader.refresh}
                    title="Refresh Git history"
                  >
                    <RefreshCw
                      className={cn(
                        "size-4",
                        gitHistoryHeader.isFetching && "animate-spin",
                      )}
                    />
                    <span className="sr-only">Refresh Git history</span>
                  </Button>
                </>
              ) : null}
              {selectedExplorer && explorerHeader ? (
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={explorerHeader.isFetching}
                  onClick={explorerHeader.refresh}
                  title="Refresh folder"
                >
                  <RefreshCw
                    className={cn(
                      "size-4",
                      explorerHeader.isFetching && "animate-spin",
                    )}
                  />
                  <span className="sr-only">Refresh folder</span>
                </Button>
              ) : null}
              {selectedCodeTab ? (
                <CodeHeaderActions header={codeHeader} />
              ) : null}
              {activePopout ? (
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={popoutPending}
                  className={cn(popoutError && "text-destructive")}
                  onClick={popOutActiveView}
                  title={popoutError ?? "Open this tab in a new window"}
                >
                  {popoutPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ExternalLink className="size-4" />
                  )}
                  <span className="sr-only">Open this tab in a new window</span>
                </Button>
              ) : null}
              {activeChat && !showImporter && !showSettings ? (
                <>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setShowCustomizations(true)}
                    title="Inspect Codex customizations"
                  >
                    <WandSparkles className="size-4" />
                    <span className="sr-only">
                      Inspect Codex customizations
                    </span>
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-pressed={Boolean(linkedConsoleChat)}
                    disabled={!linkedConsoleChat && openChatConsole.isPending}
                    onClick={() =>
                      linkedConsoleChat
                        ? setChatConsoleChatId(null)
                        : showChatConsole(activeChat)
                    }
                    title={
                      linkedConsoleChat ? "Show chat" : "Show Codex console"
                    }
                  >
                    {linkedConsoleChat ? (
                      <MessageSquare className="size-4" />
                    ) : openChatConsole.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <SquareTerminal className="size-4" />
                    )}
                    <span className="sr-only">
                      {linkedConsoleChat ? "Show chat" : "Show Codex console"}
                    </span>
                  </Button>
                </>
              ) : null}
              {!showImporter && !showSettings && selectedProject ? (
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

        {isPopout && activeChat && !showImporter && !showSettings ? (
          <div className="absolute right-3 top-3 z-40 flex gap-2">
            <Button
              size="icon"
              variant="outline"
              className="size-9 bg-background/75 shadow-md backdrop-blur-xl"
              onClick={() => setShowCustomizations(true)}
              title="Inspect Codex customizations"
            >
              <WandSparkles className="size-4" />
              <span className="sr-only">Inspect Codex customizations</span>
            </Button>
            <Button
              size="icon"
              variant="outline"
              className="size-9 bg-background/75 shadow-md backdrop-blur-xl"
              aria-pressed={Boolean(linkedConsoleChat)}
              disabled={!linkedConsoleChat && openChatConsole.isPending}
              onClick={() =>
                linkedConsoleChat
                  ? setChatConsoleChatId(null)
                  : showChatConsole(activeChat)
              }
              title={linkedConsoleChat ? "Show chat" : "Show Codex console"}
            >
              {linkedConsoleChat ? (
                <MessageSquare className="size-4" />
              ) : openChatConsole.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <SquareTerminal className="size-4" />
              )}
              <span className="sr-only">
                {linkedConsoleChat ? "Show chat" : "Show Codex console"}
              </span>
            </Button>
          </div>
        ) : null}

        {isPopout && selectedExplorer && explorerHeader ? (
          <div className="absolute right-3 top-3 z-40">
            <Button
              size="icon"
              variant="outline"
              className="size-9 bg-background/75 shadow-md backdrop-blur-xl"
              disabled={explorerHeader.isFetching}
              onClick={explorerHeader.refresh}
              title="Refresh folder"
            >
              <RefreshCw
                className={cn(
                  "size-4",
                  explorerHeader.isFetching && "animate-spin",
                )}
              />
              <span className="sr-only">Refresh folder</span>
            </Button>
          </div>
        ) : null}

        {isPopout && selectedCodeTab ? (
          <div className="absolute right-3 top-3 z-40">
            <CodeHeaderActions floating header={codeHeader} />
          </div>
        ) : null}

        {showSettings ? (
          <SettingsPage />
        ) : showProjectSettings && selectedProject ? (
          <ProjectSettingsPage
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
              newTerminal.mutate({ projectId: selectedProject.id, worktreeId })
            }
            onCreateExplorer={(worktreeId) =>
              newExplorer.mutate({ projectId: selectedProject.id, worktreeId })
            }
            onCreateHistory={(worktreeId) =>
              newProjectView.mutate({
                projectId: selectedProject.id,
                kind: "history",
                worktreeId,
              })
            }
          />
        ) : showImporter ? (
          <RepositoryImporter
            projects={projects.data ?? []}
            workerId={onlineWorker?.workerId ?? null}
          />
        ) : selectedProjectView?.kind === "remote-desktop" ? (
          remoteDesktop.data ? (
            <Suspense
              fallback={
                <div className="grid flex-1 place-items-center text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                </div>
              }
            >
              <RemoteDesktopView desktop={remoteDesktop.data} />
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
        ) : selectedCodeTab ? (
          <Suspense
            fallback={
              <div className="grid flex-1 place-items-center text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
              </div>
            }
          >
            <CodeView
              appearance={codeAppearance}
              codeTab={selectedCodeTab}
              onChanged={() =>
                void queryClient.invalidateQueries({
                  queryKey: ["code-tabs", selectedCodeTab.projectId],
                })
              }
              onHeaderChange={setCodeHeader}
            />
          </Suspense>
        ) : selectedBrowser ? (
          <Suspense
            fallback={
              <div className="grid flex-1 place-items-center text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
              </div>
            }
          >
            <BrowserView
              browser={selectedBrowser}
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
        ) : selectedExplorer ? (
          <Suspense
            fallback={
              <div className="grid flex-1 place-items-center text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
              </div>
            }
          >
            <ExplorerView
              explorer={selectedExplorer}
              onHeaderChange={setExplorerHeader}
            />
          </Suspense>
        ) : selectedTerminal ? (
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
              <TerminalView terminal={selectedTerminal} />
            )}
          </Suspense>
        ) : selectedChat ? (
          <ChatTranscript
            key={selectedChat.id}
            chat={selectedChat}
            settings={settings.data}
            syncEnabled={
              terminals.data?.some(
                (terminal) => terminal.linkedChatId === selectedChat.id,
              ) ?? false
            }
            onCreateChat={() =>
              newChat.mutate({ projectId: selectedChat.projectId })
            }
            onDelete={() => deleteChatMutation.mutate(selectedChat.id)}
            onForked={(forked) =>
              openCreatedTab(forked.projectId, "chat", forked.id)
            }
            onOpenWorkflow={(workflowId) =>
              openProjectSettings(selectedChat.projectId, workflowId)
            }
            onRename={(title) =>
              renameChatMutation.mutate({ chatId: selectedChat.id, title })
            }
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
              </div>
            </div>
          ) : (
            <div className="grid flex-1 place-items-center p-6 text-center">
              <div>
                <div className="mx-auto grid size-12 place-items-center rounded-2xl border bg-card">
                  <SquareTerminal className="size-5" />
                </div>
                <h1 className="mt-4 font-semibold">No tabs yet</h1>
                <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                  Start a Codex chat, shell, file explorer, Code workspace, or
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
                    Chat
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
                    onClick={() => newBrowser.mutate(selectedProject.id)}
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
                  setShowProjectSettings(false);
                }}
              >
                <Plus className="size-4" />
                Add from GitHub
              </Button>
            </div>
          </div>
        )}
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
          key={activeChat.id}
          chatId={activeChat.id}
          chatTitle={activeChat.title}
          open={showCustomizations}
          onOpenChange={setShowCustomizations}
        />
      ) : null}

      <Dialog
        open={mobileNavigationOpen}
        onOpenChange={setMobileNavigationOpen}
      >
        <DialogContent className="max-h-[calc(100svh-2rem)] p-4 md:hidden">
          <DialogHeader>
            <DialogTitle>Projects and chats</DialogTitle>
            <DialogDescription>
              Tap and hold a chat for actions, or use its menu button.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto">
            <ProjectChatList
              browsers={browsers.data ?? []}
              projects={projects.data ?? []}
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
              creatingChat={newChat.isPending}
              creatingCode={newCodeTab.isPending}
              creatingBrowser={newBrowser.isPending}
              creatingExplorer={newExplorer.isPending}
              creatingRemoteDesktop={newRemoteDesktop.isPending}
              creatingTerminal={newTerminal.isPending}
              creatingView={newProjectView.isPending}
              onCreateChat={(projectId) => newChat.mutate({ projectId })}
              onCreateCode={(projectId) => newCodeTab.mutate({ projectId })}
              onCreateBrowser={(projectId) => newBrowser.mutate(projectId)}
              onCreateExplorer={(projectId) =>
                newExplorer.mutate({ projectId })
              }
              onCreateGit={(projectId) =>
                newProjectView.mutate({ projectId, kind: "history" })
              }
              onCreateRemoteDesktop={(projectId) => {
                newRemoteDesktop.reset();
                newRemoteDesktop.mutate(projectId);
              }}
              onCreateTerminal={(projectId) =>
                newTerminal.mutate({ projectId })
              }
              onChangeChatWorktree={(chatId, worktreeId, mode) => {
                const chat = chats.data?.find(({ id }) => id === chatId);
                if (chat) bindChatWorktree(chat, worktreeId, mode);
              }}
              onRequestChatWorktreeCreate={(chat) => {
                setMobileNavigationOpen(false);
                setWorktreeCreateTarget({
                  kind: "chat",
                  projectId: chat.projectId,
                  tabId: chat.id,
                  mode: chat.worktreeMode,
                });
              }}
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
                updateBrowserMutation.mutate({ browserId, input: { title } })
              }
              onDeleteBrowser={(browserId) =>
                deleteBrowserMutation.mutate(browserId)
              }
              onRenameExplorer={(explorerId, title) =>
                renameExplorerMutation.mutate({ explorerId, title })
              }
              onDeleteExplorer={(explorerId) =>
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
              onRemoveProject={(projectId, deleteLocalFiles) => {
                removeProjectMutation.mutate({ projectId, deleteLocalFiles });
                setMobileNavigationOpen(false);
              }}
              onOpenProjectSettings={openProjectSettings}
              onReorderProjects={(ids) => reorderProjectsMutation.mutate(ids)}
              onReorderGroups={(projectId, groupIds) =>
                reorderGroupsMutation.mutate({ projectId, groupIds })
              }
              onSelectProject={selectProjectFromSidebar}
              onSelectTab={selectTabFromSidebar}
            />
          </div>
        </DialogContent>
      </Dialog>

      {newRemoteDesktop.isError ? (
        <div className="fixed bottom-5 right-5 z-50 max-w-md rounded-lg bg-destructive px-4 py-3 text-sm text-destructive-foreground shadow-xl">
          Could not start Remote Desktop: {errorText(newRemoteDesktop.error)}
        </div>
      ) : null}
      {newCodeTab.isError ? (
        <div className="fixed bottom-5 right-5 z-50 max-w-md rounded-lg bg-destructive px-4 py-3 text-sm text-destructive-foreground shadow-xl">
          Could not create Code tab: {errorText(newCodeTab.error)}
        </div>
      ) : null}
    </main>
  );
}
