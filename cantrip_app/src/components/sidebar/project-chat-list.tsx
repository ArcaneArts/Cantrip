import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type {
  BrowserSummary,
  ChatSummary,
  CodeTabSummary,
  ExplorerEntry,
  ExplorerSummary,
  ProjectFolderSetupJobSummary,
  ProjectSummary,
  ProjectReplicaJobSummary,
  ProjectTabLayoutSummary,
  ProjectWorktreeSummary,
  ProjectViewSummary,
  TerminalSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import {
  CircleAlert,
  Code2,
  CopyPlus,
  FileCode2,
  FolderOpen,
  FolderTree,
  GitCommitHorizontal,
  Globe2,
  LayoutDashboard,
  Loader2,
  MonitorUp,
  MoreHorizontal,
  Pencil,
  Play,
  Settings,
  SquareTerminal,
  Trash2,
  WifiOff,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import {
  projectFolderSetupErrorMessage,
  projectReplicaJobMessage,
  projectSetupErrorMessage,
} from "@/lib/job-status-message";

import {
  ChatContextMenu,
  ChatDropdownMenu,
  type ChatWorktreeActions,
} from "@/components/chat/chat-menu";
import { ChatActivityStatus } from "@/components/chat/chat-activity-status";
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import {
  openSidebarActionsMenu,
  SortableSidebarSurfaceRow,
} from "@/components/sidebar/sortable-sidebar-surface-row";
import {
  ProjectSidebarFileTree,
  type ExplorerFileMutationAuthorization,
} from "@/components/sidebar/project-sidebar-file-tree";
import { ProjectSurfaceIcon } from "@/components/workspace/project-surface-icon";
import { SurfaceActionsMenu } from "@/components/workspace/surface-tab-controls";
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { projectRemovalAction } from "@/lib/project-removal";
import type { ProjectSurface } from "@/lib/project-surface";
import {
  type WorkspaceDndData,
  workspaceSidebarDropId,
} from "@/lib/workspace-dnd-model";
import {
  WorkerPlacementIndicator,
  WorktreeIndicator,
  type WorktreeStatusMap,
} from "@/components/worktrees/worktree-control";

const projectId = (id: string) => `project:${id}`;
const chatId = (id: string) => `chat:${id}`;
const terminalId = (id: string) => `terminal:${id}`;
const explorerId = (id: string) => `explorer:${id}`;
const browserId = (id: string) => `browser:${id}`;
const codeId = (id: string) => `code:${id}`;
const viewId = (id: string) => `view:${id}`;

function SortableChat({
  active,
  chat,
  dndData,
  editing,
  onClose,
  onDelete,
  onDuplicate,
  onRename,
  onSelect,
  renameValue,
  setRenameValue,
  submitRename,
  workers,
  worktree,
  worktreeActions,
  worktreeStatus,
}: {
  active: boolean;
  chat: ChatSummary;
  dndData: WorkspaceDndData;
  editing: boolean;
  onClose(): void;
  onDelete(): void;
  onDuplicate(): void;
  onRename(): void;
  onSelect(): void;
  renameValue: string;
  setRenameValue(value: string): void;
  submitRename(): void;
  workers: WorkerSummary[];
  worktree?: ProjectWorktreeSummary;
  worktreeActions?: ChatWorktreeActions;
  worktreeStatus?: WorktreeStatusMap[string];
}) {
  const actions = {
    deleteDisabled:
      chat.status === "running" || chat.status === "waiting-for-approval",
    onDelete,
    onDuplicate,
    onRename,
    worktree: worktreeActions,
  };
  return (
    <SortableSidebarSurfaceRow
      active={active}
      dndData={dndData}
      editing={editing}
      icon={
        <ProjectSurfaceIcon
          kind={chat.experience === "task" ? "task" : "chat"}
          className="size-3.5 shrink-0"
        />
      }
      sortId={chatId(chat.id)}
      status={<ChatActivityStatus chat={chat} />}
      title={chat.title}
      renameValue={renameValue}
      onCancelRename={onRename}
      onClose={onClose}
      onRename={setRenameValue}
      onSelect={onSelect}
      onSubmitRename={submitRename}
      openActionsOnContextMenu={false}
      trailing={
        worktreeActions ? (
          <WorktreeIndicator
            leaseOwner={chat.title}
            status={worktreeStatus}
            workers={workers}
            worktree={worktree}
          />
        ) : undefined
      }
      actions={<ChatDropdownMenu actions={actions} title={chat.title} />}
      renderContextMenu={(row) => (
        <ChatContextMenu actions={actions}>{row}</ChatContextMenu>
      )}
    />
  );
}

function StandardSidebarSurfaceTab({
  active,
  dndData,
  editing,
  icon,
  onClose,
  onDelete,
  onRename,
  onSelect,
  renameValue,
  setRenameValue,
  sortId,
  status,
  submitRename,
  title,
  trailing,
}: {
  active: boolean;
  dndData: WorkspaceDndData;
  editing: boolean;
  icon: ReactNode;
  onClose(): void;
  onDelete(): void;
  onRename?: () => void;
  onSelect(): void;
  renameValue: string;
  setRenameValue(value: string): void;
  sortId: string;
  status?: ReactNode;
  submitRename(): void;
  title: string;
  trailing?: ReactNode;
}) {
  return (
    <SortableSidebarSurfaceRow
      actions={
        <SurfaceActionsMenu
          title={title}
          onDelete={onDelete}
          onRename={onRename}
          contentClassName="min-w-36"
        />
      }
      active={active}
      dndData={dndData}
      editing={editing}
      icon={icon}
      sortId={sortId}
      status={status}
      title={title}
      trailing={trailing}
      renameValue={renameValue}
      onCancelRename={onRename ?? (() => undefined)}
      onClose={onClose}
      onRename={setRenameValue}
      onSelect={onSelect}
      onSubmitRename={submitRename}
    />
  );
}

export function ProjectOverviewTab({
  active,
  children,
  onOpenSettings,
  onReveal,
  onRemove,
  onSelect,
  project,
  folderSetupJob,
  setupJob,
  projectRevealLabel,
  revealDisabled,
}: {
  active: boolean;
  children?: ReactNode;
  onOpenSettings(): void;
  onReveal?: (localFolder: boolean) => void;
  onRemove(): void;
  onSelect(): void;
  project: ProjectSummary;
  folderSetupJob?: ProjectFolderSetupJobSummary;
  setupJob?: ProjectReplicaJobSummary;
  projectRevealLabel?: string;
  revealDisabled: boolean;
}) {
  const cloning = project.setupStatus === "cloning";
  const preparing = project.setupStatus === "preparing";
  const settingUp = cloning || preparing;
  const failed = project.setupStatus === "failed";
  const folderBlocked = preparing && folderSetupJob?.state === "blocked";
  const revealLocalFolder = useRef(false);
  return (
    <div className="group mb-1 flex min-h-full flex-col">
      <div
        title={
          failed
            ? (projectSetupErrorMessage(project.setupError) ?? undefined)
            : folderSetupJob?.error
              ? projectFolderSetupErrorMessage(folderSetupJob.error.code)
              : setupJob
                ? projectReplicaJobMessage(setupJob)
                : undefined
        }
        onContextMenu={openSidebarActionsMenu}
        className={cn(
          "flex h-8 items-center rounded-md hover:bg-muted",
          active && "bg-muted font-medium",
        )}
      >
        <button
          type="button"
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
            settingUp && "cursor-default",
          )}
          onClick={onSelect}
        >
          {folderBlocked ? (
            <WifiOff className="size-3.5 shrink-0 text-amber-500" />
          ) : settingUp ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
          ) : failed ? (
            <CircleAlert className="size-3.5 shrink-0 text-destructive" />
          ) : (
            <LayoutDashboard className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">Overview</span>
          {settingUp || failed ? (
            <span
              className={cn(
                "ml-auto shrink-0 text-[10px] font-normal text-muted-foreground",
                failed && "text-destructive",
              )}
            >
              {folderBlocked
                ? "Worker offline"
                : cloning
                  ? setupJob
                    ? `${setupJob.progress.percent}%`
                    : "Starting"
                  : preparing
                    ? "Preparing"
                    : "Failed"}
            </span>
          ) : null}
        </button>
        {settingUp && !folderBlocked ? null : (
          <DropdownMenuPrimitive.Root>
            <DropdownMenuPrimitive.Trigger asChild>
              <button
                data-actions-trigger
                type="button"
                aria-label={`Project actions for ${project.name}`}
                onClick={(event) => event.stopPropagation()}
                className="mr-1 grid size-7 shrink-0 place-items-center rounded text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover:opacity-100 focus:opacity-100 [@media(pointer:coarse)]:opacity-100"
              >
                <MoreHorizontal className="size-3.5" />
                <span className="sr-only">
                  Project actions for {project.name}
                </span>
              </button>
            </DropdownMenuPrimitive.Trigger>
            <DropdownMenuPrimitive.Portal>
              <StyledDropdownMenuContent
                align="end"
                sideOffset={4}
                className="min-w-36"
              >
                <StyledDropdownMenuItem onSelect={onOpenSettings}>
                  <Settings className="size-4" /> Settings
                </StyledDropdownMenuItem>
                {onReveal ? (
                  <StyledDropdownMenuItem
                    disabled={revealDisabled}
                    onClick={(event) => {
                      revealLocalFolder.current = event.shiftKey;
                    }}
                    onSelect={() => {
                      const localFolder = revealLocalFolder.current;
                      revealLocalFolder.current = false;
                      onReveal(localFolder);
                    }}
                  >
                    <FolderOpen className="size-4" /> {projectRevealLabel}
                  </StyledDropdownMenuItem>
                ) : null}
                <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
                <StyledDropdownMenuItem
                  className="text-destructive focus:bg-destructive/10"
                  onSelect={onRemove}
                >
                  <Trash2 className="size-4" /> Remove project
                </StyledDropdownMenuItem>
              </StyledDropdownMenuContent>
            </DropdownMenuPrimitive.Portal>
          </DropdownMenuPrimitive.Root>
        )}
      </div>
      {children}
    </div>
  );
}

export function ProjectChatList({
  browsers,
  chats,
  codeTabs,
  explorers,
  fileExplorer,
  filePreviewPath,
  fileTreeError,
  fileGraphAvailable,
  fileTreeLoading,
  fileTreePinningPath,
  fileTreeWorkerId,
  fileTreeWorkerOnline,
  fileRevealLabel,
  onChangeChatWorktree,
  overviewSelected,
  projectViews,
  onFilePin,
  onFileCreateFolder,
  onFileDelete,
  onFileOpenGraph,
  onFileOpenNative,
  onFileOpenNativeRoot,
  onFileOpenTerminal,
  onFilePreview,
  onFileRename,
  onFileTreeRetry,
  onDeleteChat,
  onDeleteBrowser,
  onDeleteCode,
  onDeleteExplorer,
  onCloseExplorer,
  onDeleteProjectView,
  onDuplicateChat,
  onOpenChatExplorer,
  onOpenChatHistory,
  onOpenChatTerminal,
  onOpenProjectSettings,
  onRevealProject,
  onDeleteTerminal,
  onStopAndCloseRunTerminal,
  onRemoveProject,
  onRequestChatWorktreeCreate,
  onRenameChat,
  onRenameBrowser,
  onRenameCode,
  onRenameExplorer,
  onRenameProjectView,
  onRenameTerminal,
  onSelectTab,
  onSelectProject,
  folderSetupJobs,
  projects,
  projectSetupJobs,
  projectRevealLabel,
  selectedTabKey,
  selectedProjectId,
  surfaces,
  tabLayout,
  terminals,
  workers,
  worktrees,
  worktreeStatuses,
}: {
  browsers: BrowserSummary[];
  chats: ChatSummary[];
  codeTabs: CodeTabSummary[];
  explorers: ExplorerSummary[];
  fileExplorer: ExplorerSummary | null;
  filePreviewPath: string | null;
  fileTreeError?: string | null;
  fileGraphAvailable: boolean;
  fileTreeLoading: boolean;
  fileTreePinningPath?: string | null;
  fileTreeWorkerId: string | null;
  fileTreeWorkerOnline: boolean;
  fileRevealLabel?: string;
  onChangeChatWorktree(
    chatId: string,
    worktreeId: string,
    mode: "agent-managed" | "pinned",
  ): void;
  overviewSelected: boolean;
  projectViews: ProjectViewSummary[];
  onFilePin(explorer: ExplorerSummary, entry: ExplorerEntry): void;
  onFileCreateFolder(
    explorer: ExplorerSummary,
    parentPath: string,
    authorization: ExplorerFileMutationAuthorization,
  ): Promise<ExplorerEntry>;
  onFileDelete(
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
    authorization: ExplorerFileMutationAuthorization,
  ): Promise<void>;
  onFileOpenGraph(explorer: ExplorerSummary, entry: ExplorerEntry): void;
  onFileOpenNative(
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
    localFolder: boolean,
  ): void;
  onFileOpenNativeRoot(explorer: ExplorerSummary, localFolder: boolean): void;
  onFileOpenTerminal(explorer: ExplorerSummary, entry: ExplorerEntry): void;
  onFilePreview(explorer: ExplorerSummary, entry: ExplorerEntry): void;
  onFileRename(
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
    name: string,
    authorization: ExplorerFileMutationAuthorization,
  ): Promise<void>;
  onFileTreeRetry?(): void;
  onDeleteChat(chatId: string): void;
  onDeleteBrowser(browserId: string): void;
  onDeleteCode(codeTabId: string): void;
  onDeleteExplorer(explorerId: string): void;
  onCloseExplorer(explorerId: string): void;
  onDeleteProjectView(viewId: string): void;
  onDuplicateChat(chatId: string): void;
  onOpenChatExplorer(chat: ChatSummary): void;
  onOpenChatHistory(chat: ChatSummary): void;
  onOpenChatTerminal(chat: ChatSummary): void;
  onOpenProjectSettings(projectId: string): void;
  onRevealProject?: (
    project: ProjectSummary,
    localFolder: boolean,
  ) => Promise<void>;
  onDeleteTerminal(terminalId: string): void;
  onStopAndCloseRunTerminal(terminal: TerminalSummary): Promise<void>;
  onRemoveProject(projectId: string, deleteLocalFiles: boolean): Promise<void>;
  onRequestChatWorktreeCreate(chat: ChatSummary): void;
  onRenameChat(chatId: string, title: string): void;
  onRenameBrowser(browserId: string, title: string): void;
  onRenameCode(codeTabId: string, title: string): void;
  onRenameExplorer(explorerId: string, title: string): void;
  onRenameProjectView(viewId: string, title: string): void;
  onRenameTerminal(terminalId: string, title: string): void;
  onSelectTab(tabKey: string): void;
  onSelectProject(projectId: string): void;
  folderSetupJobs: ReadonlyMap<string, ProjectFolderSetupJobSummary>;
  projects: ProjectSummary[];
  projectSetupJobs: ReadonlyMap<string, ProjectReplicaJobSummary>;
  projectRevealLabel?: string;
  selectedTabKey: string | null;
  selectedProjectId: string | null;
  surfaces: readonly ProjectSurface[];
  tabLayout: ProjectTabLayoutSummary | null;
  terminals: TerminalSummary[];
  workers: WorkerSummary[];
  worktrees: ProjectWorktreeSummary[];
  worktreeStatuses: WorktreeStatusMap;
}) {
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingBrowserId, setEditingBrowserId] = useState<string | null>(null);
  const [editingCodeId, setEditingCodeId] = useState<string | null>(null);
  const [editingExplorerId, setEditingExplorerId] = useState<string | null>(
    null,
  );
  const [editingTerminalId, setEditingTerminalId] = useState<string | null>(
    null,
  );
  const [editingProjectViewId, setEditingProjectViewId] = useState<
    string | null
  >(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ChatSummary | null>(null);
  const [deleteBrowserTarget, setDeleteBrowserTarget] =
    useState<BrowserSummary | null>(null);
  const [deleteCodeTarget, setDeleteCodeTarget] =
    useState<CodeTabSummary | null>(null);
  const [deleteExplorerTarget, setDeleteExplorerTarget] =
    useState<ExplorerSummary | null>(null);
  const [deleteTerminalTarget, setDeleteTerminalTarget] =
    useState<TerminalSummary | null>(null);
  const [deleteTerminalPending, setDeleteTerminalPending] = useState(false);
  const [deleteTerminalError, setDeleteTerminalError] = useState<string | null>(
    null,
  );
  const [deleteProjectViewTarget, setDeleteProjectViewTarget] =
    useState<ProjectViewSummary | null>(null);
  const [removeProjectTarget, setRemoveProjectTarget] =
    useState<ProjectSummary | null>(null);
  const [deleteLocalFiles, setDeleteLocalFiles] = useState(false);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [removeProjectPending, setRemoveProjectPending] = useState(false);
  const [removeProjectError, setRemoveProjectError] = useState<string | null>(
    null,
  );
  const [revealingProjectId, setRevealingProjectId] = useState<string | null>(
    null,
  );
  const [projectRevealError, setProjectRevealError] = useState<string | null>(
    null,
  );
  const standaloneTerminals = terminals.filter(
    (terminal) => terminal.linkedChatId === null,
  );
  const closeRemoveProject = () => {
    if (removeProjectPending) return;
    setRemoveProjectTarget(null);
    setDeleteLocalFiles(false);
    setDeleteConfirmationOpen(false);
    setRemoveProjectError(null);
  };
  const submitRemoveProject = async (deleteFiles: boolean) => {
    if (!removeProjectTarget || removeProjectPending) return;
    setRemoveProjectPending(true);
    setRemoveProjectError(null);
    try {
      await onRemoveProject(removeProjectTarget.id, deleteFiles);
      setRemoveProjectTarget(null);
      setDeleteLocalFiles(false);
      setDeleteConfirmationOpen(false);
    } catch (error) {
      setRemoveProjectError(
        error instanceof Error
          ? error.message
          : "Could not remove the project.",
      );
    } finally {
      setRemoveProjectPending(false);
    }
  };
  type SidebarTab =
    | { id: string; kind: "chat"; chat: ChatSummary }
    | {
        id: string;
        kind: "terminal";
        terminal: TerminalSummary;
      }
    | {
        id: string;
        kind: "explorer";
        explorer: ExplorerSummary;
      }
    | {
        id: string;
        kind: "browser";
        browser: BrowserSummary;
      }
    | {
        id: string;
        kind: "code";
        codeTab: CodeTabSummary;
      }
    | {
        id: string;
        kind: "view";
        view: ProjectViewSummary;
      };
  const tabs: SidebarTab[] = [
    ...chats
      .filter(({ experience }) => experience !== "task")
      .map((chat) => ({
        id: chatId(chat.id),
        kind: "chat" as const,
        chat,
      })),
    ...standaloneTerminals.map((terminal) => ({
      id: terminalId(terminal.id),
      kind: "terminal" as const,
      terminal,
    })),
    ...explorers.map((explorer) => ({
      id: explorerId(explorer.id),
      kind: "explorer" as const,
      explorer,
    })),
    ...browsers.map((browser) => ({
      id: browserId(browser.id),
      kind: "browser" as const,
      browser,
    })),
    ...codeTabs.map((codeTab) => ({
      id: codeId(codeTab.id),
      kind: "code" as const,
      codeTab,
    })),
    ...projectViews.map((view) => ({
      id: viewId(view.id),
      kind: "view" as const,
      view,
    })),
  ];
  const tabByKey = new Map(tabs.map((tab) => [tab.id, tab]));
  const sidebarSurfaceRows = surfaces.flatMap((surface, lanePosition) => {
    const tab = tabByKey.get(surface.tabKey);
    return tab ? [{ lanePosition, surface, tab }] : [];
  });
  const worktreeById = new Map(
    worktrees.map((worktree) => [worktree.id, worktree]),
  );

  const beginRename = (chat: ChatSummary) => {
    if (editingChatId === chat.id) {
      setEditingChatId(null);
      return;
    }
    setEditingChatId(chat.id);
    setRenameValue(chat.title);
  };
  const finishRename = (chat: ChatSummary) => {
    const title = renameValue.trim();
    setEditingChatId(null);
    if (title && title !== chat.title) onRenameChat(chat.id, title);
  };
  const beginTerminalRename = (terminal: TerminalSummary) => {
    if (editingTerminalId === terminal.id) {
      setEditingTerminalId(null);
      return;
    }
    setEditingTerminalId(terminal.id);
    setRenameValue(terminal.title);
  };
  const finishTerminalRename = (terminal: TerminalSummary) => {
    const title = renameValue.trim();
    setEditingTerminalId(null);
    if (title && title !== terminal.title) onRenameTerminal(terminal.id, title);
  };
  const beginExplorerRename = (explorer: ExplorerSummary) => {
    if (editingExplorerId === explorer.id) {
      setEditingExplorerId(null);
      return;
    }
    setEditingExplorerId(explorer.id);
    setRenameValue(explorer.title);
  };
  const finishExplorerRename = (explorer: ExplorerSummary) => {
    const title = renameValue.trim();
    setEditingExplorerId(null);
    if (title && title !== explorer.title) onRenameExplorer(explorer.id, title);
  };
  const beginBrowserRename = (browser: BrowserSummary) => {
    if (editingBrowserId === browser.id) {
      setEditingBrowserId(null);
      return;
    }
    setEditingBrowserId(browser.id);
    setRenameValue(browser.title);
  };
  const beginCodeRename = (codeTab: CodeTabSummary) => {
    if (editingCodeId === codeTab.id) {
      setEditingCodeId(null);
      return;
    }
    setEditingCodeId(codeTab.id);
    setRenameValue(codeTab.title);
  };
  const finishCodeRename = (codeTab: CodeTabSummary) => {
    const title = renameValue.trim();
    setEditingCodeId(null);
    if (title && title !== codeTab.title) onRenameCode(codeTab.id, title);
  };
  const finishBrowserRename = (browser: BrowserSummary) => {
    const title = renameValue.trim();
    setEditingBrowserId(null);
    if (title && title !== browser.title) onRenameBrowser(browser.id, title);
  };
  const beginProjectViewRename = (view: ProjectViewSummary) => {
    if (editingProjectViewId === view.id) {
      setEditingProjectViewId(null);
      return;
    }
    setEditingProjectViewId(view.id);
    setRenameValue(view.title);
  };
  const finishProjectViewRename = (view: ProjectViewSummary) => {
    const title = renameValue.trim();
    setEditingProjectViewId(null);
    if (title && title !== view.title) onRenameProjectView(view.id, title);
  };
  const closeTabImmediately = (tab: SidebarTab) => {
    if (
      tab.kind === "chat" &&
      (tab.chat.status === "running" ||
        tab.chat.status === "waiting-for-approval")
    ) {
      setDeleteTarget(tab.chat);
    } else if (tab.kind === "chat") onDeleteChat(tab.chat.id);
    else if (
      tab.kind === "terminal" &&
      tab.terminal.kind === "run-configuration" &&
      tab.terminal.status === "running"
    ) {
      setDeleteTerminalError(null);
      setDeleteTerminalTarget(tab.terminal);
    } else if (tab.kind === "terminal") onDeleteTerminal(tab.terminal.id);
    else if (tab.kind === "explorer") onCloseExplorer(tab.explorer.id);
    else if (tab.kind === "browser") onDeleteBrowser(tab.browser.id);
    else if (tab.kind === "code") onDeleteCode(tab.codeTab.id);
    else onDeleteProjectView(tab.view.id);
  };
  const sidebarDrop = useDroppable({
    id: workspaceSidebarDropId(selectedProjectId ?? "none"),
    disabled: !selectedProjectId || !tabLayout,
    data: {
      drop:
        selectedProjectId && tabLayout
          ? {
              type: "sidebar-project" as const,
              projectId: selectedProjectId,
              groupPosition: tabLayout.groups.length,
              lanePosition: sidebarSurfaceRows.length,
            }
          : undefined,
    } satisfies WorkspaceDndData,
  });

  return (
    <>
      <div className="contents">
        <SortableContext
          items={projects.map((project) => projectId(project.id))}
          strategy={verticalListSortingStrategy}
        >
          {projects.map((project) => {
            const active = project.id === selectedProjectId;
            if (!active) return null;
            return (
              <ProjectOverviewTab
                key={project.id}
                project={project}
                folderSetupJob={folderSetupJobs.get(project.id)}
                setupJob={projectSetupJobs.get(project.id)}
                active={overviewSelected}
                onOpenSettings={() => onOpenProjectSettings(project.id)}
                onReveal={
                  project.source && projectRevealLabel && onRevealProject
                    ? (localFolder) => {
                        if (revealingProjectId) return;
                        setProjectRevealError(null);
                        setRevealingProjectId(project.id);
                        void onRevealProject(project, localFolder)
                          .catch((error: unknown) => {
                            setProjectRevealError(
                              error instanceof Error
                                ? error.message
                                : "Could not reveal this project.",
                            );
                          })
                          .finally(() => setRevealingProjectId(null));
                      }
                    : undefined
                }
                projectRevealLabel={projectRevealLabel}
                revealDisabled={revealingProjectId !== null}
                onSelect={() => onSelectProject(project.id)}
                onRemove={() => {
                  setDeleteLocalFiles(false);
                  setDeleteConfirmationOpen(false);
                  setRemoveProjectError(null);
                  setRemoveProjectTarget(project);
                }}
              >
                {active ? (
                  <div
                    ref={sidebarDrop.setNodeRef}
                    className={cn(
                      "flex min-h-8 flex-1 flex-col rounded-md transition-colors",
                      sidebarDrop.isOver && "bg-muted/40",
                    )}
                  >
                    <SortableContext
                      items={sidebarSurfaceRows.map(({ tab }) => tab.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {sidebarSurfaceRows.map(
                        ({ lanePosition, surface, tab }) => {
                          const selectTab = () => onSelectTab(tab.id);
                          const dndData = {
                            drag: {
                              type: "surface" as const,
                              lane: "sidebar" as const,
                              projectId: surface.projectId,
                              groupId: surface.groupId,
                              tabKey: surface.tabKey,
                              label: surface.title,
                              lanePosition,
                              visualKind: surface.kind,
                            },
                            drop: {
                              type: "sidebar-tab" as const,
                              projectId: surface.projectId,
                              groupId: surface.groupId,
                              tabKey: surface.tabKey,
                              lanePosition,
                              memberPosition: surface.member.position,
                            },
                          } satisfies WorkspaceDndData;
                          return tab.kind === "chat" ? (
                            <SortableChat
                              key={tab.id}
                              chat={tab.chat}
                              active={tab.id === selectedTabKey}
                              editing={editingChatId === tab.chat.id}
                              renameValue={renameValue}
                              setRenameValue={setRenameValue}
                              submitRename={() => finishRename(tab.chat)}
                              onSelect={selectTab}
                              onRename={() => beginRename(tab.chat)}
                              onDuplicate={() => onDuplicateChat(tab.chat.id)}
                              onClose={() => closeTabImmediately(tab)}
                              onDelete={() => setDeleteTarget(tab.chat)}
                              workers={workers}
                              worktree={worktreeById.get(
                                tab.chat.activeWorktreeId,
                              )}
                              worktreeStatus={
                                worktreeStatuses[tab.chat.activeWorktreeId]
                              }
                              worktreeActions={
                                project.capabilities.worktrees
                                  ? {
                                      currentWorktreeId:
                                        tab.chat.activeWorktreeId,
                                      disabled: tab.chat.status === "running",
                                      mode: tab.chat.worktreeMode,
                                      worktrees,
                                      onCreate: () =>
                                        onRequestChatWorktreeCreate(tab.chat),
                                      onSelect: (worktreeId) =>
                                        onChangeChatWorktree(
                                          tab.chat.id,
                                          worktreeId,
                                          tab.chat.worktreeMode,
                                        ),
                                      onSetMode: (mode) =>
                                        onChangeChatWorktree(
                                          tab.chat.id,
                                          tab.chat.activeWorktreeId,
                                          mode,
                                        ),
                                      onOpenTerminal: () =>
                                        onOpenChatTerminal(tab.chat),
                                      onOpenExplorer: () =>
                                        onOpenChatExplorer(tab.chat),
                                      onOpenHistory: () =>
                                        onOpenChatHistory(tab.chat),
                                    }
                                  : undefined
                              }
                              dndData={dndData}
                            />
                          ) : tab.kind === "terminal" ? (
                            <StandardSidebarSurfaceTab
                              key={tab.id}
                              dndData={dndData}
                              sortId={tab.id}
                              title={tab.terminal.title}
                              icon={
                                tab.terminal.kind === "run-configuration" ? (
                                  <Play className="size-3.5 shrink-0 fill-current" />
                                ) : (
                                  <SquareTerminal className="size-3.5 shrink-0" />
                                )
                              }
                              status={
                                <span
                                  className={cn(
                                    "ml-auto size-[5px] rounded-full bg-muted-foreground/40",
                                    tab.terminal.status === "running" &&
                                      "bg-emerald-400",
                                    tab.terminal.status === "failed" &&
                                      "bg-red-400",
                                  )}
                                />
                              }
                              active={tab.id === selectedTabKey}
                              editing={editingTerminalId === tab.terminal.id}
                              renameValue={renameValue}
                              setRenameValue={setRenameValue}
                              submitRename={() =>
                                finishTerminalRename(tab.terminal)
                              }
                              onSelect={selectTab}
                              onRename={
                                tab.terminal.kind === "run-configuration"
                                  ? undefined
                                  : () => beginTerminalRename(tab.terminal)
                              }
                              onClose={() => closeTabImmediately(tab)}
                              onDelete={() =>
                                setDeleteTerminalTarget(tab.terminal)
                              }
                              trailing={
                                project.capabilities.worktrees ? (
                                  <WorktreeIndicator
                                    status={
                                      worktreeStatuses[tab.terminal.worktreeId]
                                    }
                                    workers={workers}
                                    worktree={worktreeById.get(
                                      tab.terminal.worktreeId,
                                    )}
                                  />
                                ) : undefined
                              }
                            />
                          ) : tab.kind === "explorer" ? (
                            <StandardSidebarSurfaceTab
                              key={tab.id}
                              dndData={dndData}
                              sortId={tab.id}
                              title={tab.explorer.title}
                              icon={
                                tab.explorer.selectedPath ? (
                                  <FileCode2 className="size-3.5 shrink-0" />
                                ) : (
                                  <FolderTree className="size-3.5 shrink-0" />
                                )
                              }
                              active={tab.id === selectedTabKey}
                              editing={editingExplorerId === tab.explorer.id}
                              renameValue={renameValue}
                              setRenameValue={setRenameValue}
                              submitRename={() =>
                                finishExplorerRename(tab.explorer)
                              }
                              onSelect={selectTab}
                              onRename={() => beginExplorerRename(tab.explorer)}
                              onClose={() => closeTabImmediately(tab)}
                              onDelete={() =>
                                setDeleteExplorerTarget(tab.explorer)
                              }
                              trailing={
                                project.capabilities.worktrees ? (
                                  <WorktreeIndicator
                                    status={
                                      worktreeStatuses[tab.explorer.worktreeId]
                                    }
                                    workers={workers}
                                    worktree={worktreeById.get(
                                      tab.explorer.worktreeId,
                                    )}
                                  />
                                ) : undefined
                              }
                            />
                          ) : tab.kind === "browser" ? (
                            <StandardSidebarSurfaceTab
                              key={tab.id}
                              dndData={dndData}
                              sortId={tab.id}
                              title={tab.browser.title}
                              icon={<Globe2 className="size-3.5 shrink-0" />}
                              active={tab.id === selectedTabKey}
                              editing={editingBrowserId === tab.browser.id}
                              renameValue={renameValue}
                              setRenameValue={setRenameValue}
                              submitRename={() =>
                                finishBrowserRename(tab.browser)
                              }
                              onSelect={selectTab}
                              onRename={() => beginBrowserRename(tab.browser)}
                              onClose={() => closeTabImmediately(tab)}
                              onDelete={() =>
                                setDeleteBrowserTarget(tab.browser)
                              }
                              trailing={
                                <WorkerPlacementIndicator
                                  workerId={tab.browser.workerId}
                                  workers={workers}
                                />
                              }
                            />
                          ) : tab.kind === "code" ? (
                            <StandardSidebarSurfaceTab
                              key={tab.id}
                              dndData={dndData}
                              sortId={tab.id}
                              title={tab.codeTab.title}
                              icon={<Code2 className="size-3.5 shrink-0" />}
                              status={
                                <span
                                  className={cn(
                                    "ml-auto size-[5px] rounded-full bg-muted-foreground/40",
                                    tab.codeTab.status === "running" &&
                                      "bg-emerald-400",
                                    tab.codeTab.status === "starting" &&
                                      "animate-pulse bg-amber-500",
                                    tab.codeTab.status === "failed" &&
                                      "bg-red-400",
                                  )}
                                  title={`Editor ${tab.codeTab.status}`}
                                />
                              }
                              active={tab.id === selectedTabKey}
                              editing={editingCodeId === tab.codeTab.id}
                              renameValue={renameValue}
                              setRenameValue={setRenameValue}
                              submitRename={() => finishCodeRename(tab.codeTab)}
                              onSelect={selectTab}
                              onRename={() => beginCodeRename(tab.codeTab)}
                              onClose={() => closeTabImmediately(tab)}
                              onDelete={() => setDeleteCodeTarget(tab.codeTab)}
                              trailing={
                                project.capabilities.worktrees ? (
                                  <WorktreeIndicator
                                    status={
                                      worktreeStatuses[tab.codeTab.worktreeId]
                                    }
                                    workers={workers}
                                    worktree={worktreeById.get(
                                      tab.codeTab.worktreeId,
                                    )}
                                  />
                                ) : undefined
                              }
                            />
                          ) : (
                            <StandardSidebarSurfaceTab
                              key={tab.id}
                              dndData={dndData}
                              sortId={tab.id}
                              title={tab.view.title}
                              icon={
                                tab.view.kind === "remote-desktop" ? (
                                  <MonitorUp className="size-3.5 shrink-0" />
                                ) : (
                                  <GitCommitHorizontal className="size-3.5 shrink-0" />
                                )
                              }
                              active={tab.id === selectedTabKey}
                              editing={editingProjectViewId === tab.view.id}
                              renameValue={renameValue}
                              setRenameValue={setRenameValue}
                              submitRename={() =>
                                finishProjectViewRename(tab.view)
                              }
                              onSelect={selectTab}
                              onRename={() => beginProjectViewRename(tab.view)}
                              onClose={() => closeTabImmediately(tab)}
                              onDelete={() =>
                                setDeleteProjectViewTarget(tab.view)
                              }
                              trailing={
                                tab.view.kind === "history" ? (
                                  <WorktreeIndicator
                                    status={
                                      tab.view.worktreeId
                                        ? worktreeStatuses[tab.view.worktreeId]
                                        : undefined
                                    }
                                    workers={workers}
                                    worktree={
                                      tab.view.worktreeId
                                        ? worktreeById.get(tab.view.worktreeId)
                                        : undefined
                                    }
                                  />
                                ) : undefined
                              }
                            />
                          );
                        },
                      )}
                    </SortableContext>
                    <ProjectSidebarFileTree
                      activePath={filePreviewPath}
                      error={fileTreeError}
                      explorer={fileExplorer}
                      loading={fileTreeLoading}
                      onCreateFolder={(parentPath, authorization) => {
                        if (!fileExplorer) {
                          return Promise.reject(
                            new Error(
                              "The project file explorer is unavailable.",
                            ),
                          );
                        }
                        return onFileCreateFolder(
                          fileExplorer,
                          parentPath,
                          authorization,
                        );
                      }}
                      onDelete={(entry, authorization) => {
                        if (!fileExplorer) {
                          return Promise.reject(
                            new Error(
                              "The project file explorer is unavailable.",
                            ),
                          );
                        }
                        return onFileDelete(fileExplorer, entry, authorization);
                      }}
                      onOpenGraph={
                        fileGraphAvailable && fileExplorer
                          ? (entry) => onFileOpenGraph(fileExplorer, entry)
                          : undefined
                      }
                      onOpenNative={
                        fileRevealLabel && fileExplorer
                          ? (entry, localFolder) =>
                              onFileOpenNative(fileExplorer, entry, localFolder)
                          : undefined
                      }
                      onOpenNativeRoot={
                        fileRevealLabel && fileExplorer
                          ? (localFolder) =>
                              onFileOpenNativeRoot(fileExplorer, localFolder)
                          : undefined
                      }
                      onOpenTerminal={
                        fileExplorer
                          ? (entry) => onFileOpenTerminal(fileExplorer, entry)
                          : undefined
                      }
                      onPin={(entry) => {
                        if (fileExplorer) onFilePin(fileExplorer, entry);
                      }}
                      onPreview={(entry) => {
                        if (fileExplorer) onFilePreview(fileExplorer, entry);
                      }}
                      onRename={(entry, name, authorization) => {
                        if (!fileExplorer) {
                          return Promise.reject(
                            new Error(
                              "The project file explorer is unavailable.",
                            ),
                          );
                        }
                        return onFileRename(
                          fileExplorer,
                          entry,
                          name,
                          authorization,
                        );
                      }}
                      onRetry={onFileTreeRetry}
                      pinningPath={fileTreePinningPath}
                      revealLabel={fileRevealLabel}
                      workerId={fileTreeWorkerId}
                      workerOnline={fileTreeWorkerOnline}
                    />
                  </div>
                ) : null}
              </ProjectOverviewTab>
            );
          })}
        </SortableContext>
      </div>

      {projectRevealError ? (
        <InlineAlert
          tone="error"
          className="fixed bottom-5 right-5 z-50 max-w-md border-destructive bg-destructive px-4 py-3 text-destructive-foreground shadow-xl"
          dismissLabel="Dismiss project reveal error"
          icon={false}
          onDismiss={() => setProjectRevealError(null)}
        >
          Could not reveal project: {projectRevealError}
        </InlineAlert>
      ) : null}

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete agent?</DialogTitle>
            <DialogDescription>
              {deleteTarget?.status === "running" ||
              deleteTarget?.status === "waiting-for-approval"
                ? "Stop the active agent before removing this tab."
                : `“${deleteTarget?.title ?? "This agent"}” will move to Archive for 90 days if it has conversation history. Empty agents are deleted immediately.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={
                deleteTarget?.status === "running" ||
                deleteTarget?.status === "waiting-for-approval"
              }
              onClick={() => {
                if (deleteTarget) onDeleteChat(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(removeProjectTarget) && !deleteConfirmationOpen}
        onOpenChange={(open) => {
          if (!open && !deleteConfirmationOpen) closeRemoveProject();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove project?</DialogTitle>
            <DialogDescription>
              “{removeProjectTarget?.name}” will be unlinked from Cantrip.{" "}
              {removeProjectTarget?.folderManagement === "external"
                ? "The attached folder remains unchanged on its worker and can be added again later."
                : removeProjectTarget?.originKind === "managed-folder"
                  ? "The folder remains on its worker and can be added again later using its path."
                  : "Its repository remains on the worker and can be re-linked later."}
            </DialogDescription>
          </DialogHeader>
          {removeProjectTarget?.source ? (
            <code className="block break-all rounded-md bg-muted px-3 py-2 text-xs">
              {removeProjectTarget.source.displayPath}
            </code>
          ) : null}
          {removeProjectTarget?.source &&
          removeProjectTarget.folderManagement !== "external" ? (
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-destructive"
                checked={deleteLocalFiles}
                onChange={(event) => setDeleteLocalFiles(event.target.checked)}
              />
              <span>
                <span className="font-medium">Also delete local files</span>
                <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                  Permanently removes the local project files from the worker.
                  The owning worker must be online.
                </span>
              </span>
            </label>
          ) : null}
          {removeProjectError ? (
            <p className="text-sm text-destructive">{removeProjectError}</p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={removeProjectPending}
              onClick={closeRemoveProject}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={removeProjectPending}
              onClick={() => {
                const action = projectRemovalAction(
                  deleteLocalFiles,
                  removeProjectTarget?.originKind === "managed-folder",
                );
                if (action === "confirm-delete") {
                  setDeleteConfirmationOpen(true);
                } else {
                  void submitRemoveProject(action === "delete");
                }
              }}
              variant={deleteLocalFiles ? "destructive" : "default"}
            >
              {removeProjectPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              {deleteLocalFiles
                ? removeProjectTarget?.originKind === "managed-folder"
                  ? "Continue to delete"
                  : "Delete files and remove"
                : "Unlink project"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(removeProjectTarget) && deleteConfirmationOpen}
        onOpenChange={(open) => {
          if (!open && deleteConfirmationOpen) closeRemoveProject();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete local files permanently?</DialogTitle>
            <DialogDescription>
              This deletes “{removeProjectTarget?.name}” at the exact path below
              and unlinks the project. Cantrip and Git cannot recover these
              files.
            </DialogDescription>
          </DialogHeader>
          <code className="block break-all rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
            {removeProjectTarget?.source?.displayPath ?? "Source unavailable"}
          </code>
          {removeProjectError ? (
            <p className="text-sm text-destructive">{removeProjectError}</p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={removeProjectPending}
              onClick={() => {
                setRemoveProjectError(null);
                setDeleteConfirmationOpen(false);
              }}
              variant="outline"
            >
              Back
            </Button>
            <Button
              variant="destructive"
              onClick={() => void submitRemoveProject(true)}
              pending={removeProjectPending}
              pendingLabel="Deleting…"
            >
              <Trash2 className="size-4" />
              Delete folder permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(deleteTerminalTarget)}
        onOpenChange={(open) => {
          if (!open && !deleteTerminalPending) {
            setDeleteTerminalError(null);
            setDeleteTerminalTarget(null);
          }
        }}
      >
        <DialogContent showClose={!deleteTerminalPending}>
          <DialogHeader>
            <DialogTitle>
              {deleteTerminalTarget?.kind === "run-configuration" &&
              deleteTerminalTarget.status === "running"
                ? "Stop and close Run terminal?"
                : "Delete terminal?"}
            </DialogTitle>
            <DialogDescription>
              {deleteTerminalTarget?.kind === "run-configuration" &&
              deleteTerminalTarget.status === "running"
                ? `“${deleteTerminalTarget.title}” will be stopped immediately and its terminal tab removed. The shared Run configuration remains available.`
                : `“${deleteTerminalTarget?.title}” will be closed and removed from this project.`}
            </DialogDescription>
          </DialogHeader>
          {deleteTerminalError ? (
            <InlineAlert tone="error">{deleteTerminalError}</InlineAlert>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button disabled={deleteTerminalPending} variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              pending={deleteTerminalPending}
              pendingLabel="Stopping and closing…"
              onClick={() => {
                if (!deleteTerminalTarget) return;
                if (
                  deleteTerminalTarget.kind === "run-configuration" &&
                  deleteTerminalTarget.status === "running"
                ) {
                  setDeleteTerminalPending(true);
                  setDeleteTerminalError(null);
                  void onStopAndCloseRunTerminal(deleteTerminalTarget)
                    .then(() => setDeleteTerminalTarget(null))
                    .catch((error: unknown) =>
                      setDeleteTerminalError(
                        error instanceof Error
                          ? error.message
                          : "Could not stop and close this Run terminal.",
                      ),
                    )
                    .finally(() => setDeleteTerminalPending(false));
                  return;
                }
                onDeleteTerminal(deleteTerminalTarget.id);
                setDeleteTerminalTarget(null);
              }}
            >
              {deleteTerminalTarget?.kind === "run-configuration" &&
              deleteTerminalTarget?.status === "running"
                ? "Stop and close"
                : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(deleteExplorerTarget)}
        onOpenChange={(open) => !open && setDeleteExplorerTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete explorer?</DialogTitle>
            <DialogDescription>
              “{deleteExplorerTarget?.title}” will be removed. Project files are
              not changed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteExplorerTarget)
                  onDeleteExplorer(deleteExplorerTarget.id);
                setDeleteExplorerTarget(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(deleteBrowserTarget)}
        onOpenChange={(open) => !open && setDeleteBrowserTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete browser?</DialogTitle>
            <DialogDescription>
              “{deleteBrowserTarget?.title}” and its saved address will be
              removed from this project.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteBrowserTarget)
                  onDeleteBrowser(deleteBrowserTarget.id);
                setDeleteBrowserTarget(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(deleteProjectViewTarget)}
        onOpenChange={(open) => !open && setDeleteProjectViewTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteProjectViewTarget?.title}?</DialogTitle>
            <DialogDescription>
              {deleteProjectViewTarget?.kind === "remote-desktop"
                ? "This removes the remote desktop tab only. Project files are not changed."
                : "This removes the tab only. It does not change repository history or GitHub issues."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteProjectViewTarget) {
                  onDeleteProjectView(deleteProjectViewTarget.id);
                }
                setDeleteProjectViewTarget(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(deleteCodeTarget)}
        onOpenChange={(open) => !open && setDeleteCodeTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Code tab?</DialogTitle>
            <DialogDescription>
              “{deleteCodeTarget?.title}” will stop its editor and remove this
              tab. Its persistent worker profile and project files are kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteCodeTarget) onDeleteCode(deleteCodeTarget.id);
                setDeleteCodeTarget(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
