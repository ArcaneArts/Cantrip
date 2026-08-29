import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type {
  ChatSummary,
  CodeTabSummary,
  ExplorerSummary,
  GitStatus,
  ProjectSummary,
  ProjectViewSummary,
  ProjectWorktreeCreate,
  ProjectWorktreeSummary,
  TerminalSummary,
  TunnelSummary,
  WorkerSummary,
  WorktreePolicy,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  Archive,
  Cable,
  CircleAlert,
  Code2,
  Database,
  ExternalLink,
  FolderTree,
  GitBranch,
  GitFork,
  History,
  Loader2,
  Lock,
  Bot,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Route,
  ScanLine,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Trash2,
  Unlock,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-menu";
import { McpServerSettings } from "@/components/settings/mcp-server-settings";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  WorktreeCreateDialog,
  worktreeHasConflicts,
  type WorktreeStatusMap,
} from "@/components/worktrees/worktree-control";
import {
  createProjectWorktree,
  getCodeGraphWorktreeStatus,
  lockProjectWorktree,
  pruneProjectWorktrees,
  reconcileProjectWorktrees,
  requestCodeGraphWorktreeAction,
  removeProjectWorktree,
  unlockProjectWorktree,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAppLiveStatus } from "@/lib/app-live-react";
import { codeGraphSettingsRefreshIntervalMs } from "@/lib/codegraph-refresh";
import { updateProjectWorktreePolicy } from "@/lib/project-encryption";
import { WorkflowCenter } from "@/components/workflows/workflow-center";
import { ProjectAutomationsSettings } from "./project-automations-settings";
import { ProjectArchiveSettings } from "./project-archive-settings";
import { ProjectReplicaSettings } from "./project-replica-settings";
import { ExternalChatImportSettings } from "./external-chat-import";
import { ProjectExportSettings } from "./project-export-settings";
import { ProjectGithubConversion } from "./project-github-conversion";
import { SkillsSettings } from "@/components/settings/skills-settings";
import { TunnelSettings } from "@/components/settings/tunnel-settings";
import { PolicyAssignmentControls } from "@/components/settings/policy-assignment-controls";
import {
  SettingsNavigationLayout,
  type SettingsNavigationSection,
} from "@/components/settings/settings-navigation";

const createdDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export type ProjectSettingsSection =
  | "general"
  | "archive"
  | "automations"
  | "workflows"
  | "replicas"
  | "worktrees"
  | "tunnels"
  | "skills"
  | "mcp"
  | "policies";

export const projectSettingsSections: readonly SettingsNavigationSection<ProjectSettingsSection>[] =
  [
    {
      id: "general",
      label: "General",
      description: "Project source and data",
      icon: SlidersHorizontal,
      searchItems: [
        {
          id: "project-details",
          label: "Project details",
          description: "Repository, source location, worker, and date added.",
          keywords: ["folder github metadata"],
        },
        {
          id: "github-conversion",
          label: "GitHub repository",
          description: "Convert a managed folder into a GitHub repository.",
          keywords: ["git remote publish"],
        },
        {
          id: "external-chat-import",
          label: "Import external chats",
          description: "Bring supported conversations into this project.",
        },
        {
          id: "project-export",
          label: "Export project data",
          description: "Create a portable export of project conversations.",
          keywords: ["backup archive download"],
        },
      ],
    },
    {
      id: "archive",
      label: "Archive",
      description: "Archived conversations",
      icon: Archive,
      searchItems: [
        {
          id: "archived-chats",
          label: "Archived chats",
          description: "Browse and restore archived project conversations.",
        },
      ],
    },
    {
      id: "automations",
      label: "Automations",
      description: "Scheduled project tasks",
      icon: CalendarClock,
      searchItems: [
        {
          id: "project-automations",
          label: "Project automations",
          description: "Create and manage recurring project work.",
          keywords: ["schedule cron heartbeat"],
        },
      ],
    },
    {
      id: "workflows",
      label: "Workflows",
      description: "Reusable task graphs",
      icon: Workflow,
      searchItems: [
        {
          id: "project-workflows",
          label: "Project workflows",
          description: "Build and run reusable multi-step workflows.",
          keywords: ["nodes execution task graph"],
        },
      ],
    },
    {
      id: "replicas",
      label: "Replicas",
      description: "Worker placement",
      icon: Database,
      searchItems: [
        {
          id: "project-placement",
          label: "Project placement",
          description: "Choose where this project's source is hosted.",
        },
        {
          id: "worker-replicas",
          label: "Worker replicas",
          description: "Manage source copies across connected workers.",
          keywords: ["sync clone machine"],
        },
      ],
    },
    {
      id: "worktrees",
      label: "Worktrees",
      description: "Git isolation and CodeGraph",
      icon: GitFork,
      searchItems: [
        {
          id: "worktree-policy",
          label: "Worktree policy",
          description: "Control whether agents isolate source changes.",
          keywords: ["agent managed required for writes direct primary"],
        },
        {
          id: "worktree-inventory",
          label: "Worktrees",
          description: "Manage Git checkouts, branches, and bound tabs.",
          keywords: ["refresh prune lock remove"],
        },
        {
          id: "codegraph",
          label: "CodeGraph",
          description: "Inspect and manage worktree code indexes.",
          keywords: ["index status rebuild"],
        },
      ],
    },
    {
      id: "tunnels",
      label: "Tunnels",
      description: "Network forwarding",
      icon: Route,
      searchItems: [
        {
          id: "project-tunnels",
          label: "Project tunnels",
          description: "Manage project ports, endpoints, and connections.",
          keywords: ["tcp http forwarding"],
        },
      ],
    },
    {
      id: "policies",
      label: "Policies",
      description: "Project instructions",
      icon: ShieldCheck,
      searchItems: [
        {
          id: "policy-assignments",
          label: "Project policy assignments",
          description: "Choose agent policies that apply to this project.",
          keywords: ["instructions rules mandatory inherited"],
        },
      ],
    },
    {
      id: "skills",
      label: "Skills",
      description: "Project agent capabilities",
      icon: Sparkles,
      searchItems: [
        {
          id: "project-skills",
          label: "Project skills",
          description: "Manage reusable project-specific agent guidance.",
          keywords: ["skill md instructions"],
        },
      ],
    },
    {
      id: "mcp",
      label: "MCP",
      description: "Project tool servers",
      icon: Cable,
      searchItems: [
        {
          id: "project-mcp-servers",
          label: "Project MCP servers",
          description: "Configure MCP tools available in this project.",
          keywords: ["stdio HTTP tools context protocol"],
        },
      ],
    },
  ];

export function projectSettingsTabsForProject(
  project: Pick<ProjectSummary, "capabilities">,
  worktrees: readonly ProjectWorktreeSummary[] = [],
  workers: readonly WorkerSummary[] = [],
): readonly SettingsNavigationSection<ProjectSettingsSection>[] {
  return projectSettingsSections
    .filter(
      ({ id }) =>
        (id !== "replicas" || project.capabilities.replicas) &&
        (id !== "worktrees" || project.capabilities.worktrees),
    )
    .map((section) =>
      section.id === "worktrees"
        ? {
            ...section,
            searchItems: [
              ...section.searchItems,
              ...worktrees.map((worktree) => {
                const worker = workers.find(
                  ({ workerId }) => workerId === worktree.workerId,
                );
                return {
                  id: `worktree:${worktree.id}`,
                  label: worktree.name,
                  description: worktree.displayPath,
                  keywords: [
                    worktree.path,
                    worktree.branch ?? "detached",
                    worktree.head ?? "",
                    worker?.name ?? worktree.workerId,
                    worktree.isPrimary ? "primary" : "isolated",
                    worktree.locked ? "locked" : "unlocked",
                  ],
                };
              }),
            ],
          }
        : section,
    );
}

const policies: Array<{
  description: string;
  label: string;
  value: WorktreePolicy;
}> = [
  {
    value: "agent-managed",
    label: "Agent managed",
    description: "Let agents create and select isolated worktrees when useful.",
  },
  {
    value: "required-for-writes",
    label: "Required for writes",
    description:
      "Keep Primary read-only for agents and require isolated writes.",
  },
  {
    value: "direct",
    label: "Direct",
    description: "Allow agents to make changes directly in Primary.",
  },
];

export function projectWorktreeState(
  worktree: ProjectWorktreeSummary,
  status: GitStatus | undefined,
  online: boolean,
): { label: string; tone: "default" | "danger" | "muted" | "warning" } {
  if (!online) return { label: "Worker offline", tone: "muted" };
  if (worktree.lifecycleState !== "ready") {
    return { label: worktree.lifecycleState, tone: "warning" };
  }
  if (!status) return { label: "Status unavailable", tone: "muted" };
  if (worktreeHasConflicts(status)) {
    return { label: "Conflicts", tone: "danger" };
  }
  if (status.files.length) {
    return {
      label: `${status.files.length} changed ${status.files.length === 1 ? "file" : "files"}`,
      tone: "warning",
    };
  }
  return { label: "Clean", tone: "default" };
}

export function projectWorktreeBindings(
  worktreeId: string,
  chats: ChatSummary[],
  terminals: TerminalSummary[],
  explorers: ExplorerSummary[],
  views: ProjectViewSummary[],
  codeTabs: CodeTabSummary[] = [],
): string[] {
  return [
    ...chats
      .filter(({ activeWorktreeId }) => activeWorktreeId === worktreeId)
      .map(({ title }) => title),
    ...terminals
      .filter(({ worktreeId: id }) => id === worktreeId)
      .map(({ title }) => title),
    ...explorers
      .filter(({ worktreeId: id }) => id === worktreeId)
      .map(({ title }) => title),
    ...codeTabs
      .filter(({ worktreeId: id }) => id === worktreeId)
      .map(({ title }) => title),
    ...views
      .filter(({ worktreeId: id }) => id === worktreeId)
      .map(({ title }) => title),
  ];
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </div>
  );
}

function CodeGraphWorktreeControls({
  available,
  enabled,
  projectId,
  worktreeId,
}: {
  available: boolean;
  enabled: boolean;
  projectId: string;
  worktreeId: string;
}) {
  const queryClient = useQueryClient();
  const codeGraphResourcesLive = useAppLiveStatus() === "live";
  const queryKey = ["codegraph", projectId, worktreeId] as const;
  const status = useQuery({
    enabled: enabled && available,
    queryKey,
    queryFn: () => getCodeGraphWorktreeStatus(projectId, worktreeId),
    refetchInterval: (query) =>
      codeGraphSettingsRefreshIntervalMs(
        query.state.data,
        codeGraphResourcesLive,
      ),
    retry: false,
  });
  const action = useMutation({
    mutationFn: (kind: "sync" | "rebuild") =>
      requestCodeGraphWorktreeAction(projectId, worktreeId, kind),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  if (!enabled) return null;
  if (!available) {
    return (
      <p className="mt-1 truncate text-[10px] text-muted-foreground">
        CodeGraph unavailable
      </p>
    );
  }
  if (status.isLoading) {
    return (
      <p className="mt-1 truncate text-[10px] text-muted-foreground">
        CodeGraph · checking…
      </p>
    );
  }
  if (!status.data) {
    return (
      <p className="mt-1 truncate text-[10px] text-muted-foreground">
        CodeGraph unavailable
      </p>
    );
  }
  const active =
    status.data.state === "indexing" ||
    status.data.state === "syncing" ||
    status.data.state === "queued";
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
      <span className="truncate" title={status.data.statusMessage ?? undefined}>
        CodeGraph · {status.data.state}
        {status.data.fileCount !== null
          ? ` · ${status.data.fileCount.toLocaleString()} files`
          : ""}
        {status.data.lastSuccessfulSyncAt
          ? ` · synced ${new Date(status.data.lastSuccessfulSyncAt).toLocaleString()}`
          : ""}
        {status.data.statusMessage && status.data.state === "degraded"
          ? ` · ${status.data.statusMessage}`
          : ""}
      </span>
      <Button
        size="icon"
        variant="ghost"
        className="size-5 shrink-0"
        disabled={active || action.isPending}
        title="Resync CodeGraph"
        onClick={() => action.mutate("sync")}
      >
        <RefreshCw className={cn("size-3", active && "animate-spin")} />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-5 shrink-0"
        disabled={active || action.isPending}
        title="Rebuild CodeGraph index"
        onClick={() => action.mutate("rebuild")}
      >
        <Database className="size-3" />
      </Button>
    </div>
  );
}

export function ProjectSettingsPage({
  chats,
  codeTabs,
  desktopRuntime,
  explorers,
  initialSection = "general",
  initialWorkflowId,
  mobileSectionOpen,
  onCreateChat,
  onCreateCode,
  onCreateExplorer,
  onCreateHistory,
  onCreateTerminal,
  onRestoreChat,
  onOpenTunnelOwner,
  onOpenImportedChat,
  onOpenPolicySettings,
  onMobileSectionOpenChange,
  project,
  projectViews,
  statuses,
  terminals,
  workers,
  worktrees,
}: {
  chats: ChatSummary[];
  codeTabs: CodeTabSummary[];
  desktopRuntime: boolean;
  explorers: ExplorerSummary[];
  initialSection?: ProjectSettingsSection;
  initialWorkflowId?: string | null;
  mobileSectionOpen?: boolean;
  onCreateChat(worktreeId: string): void;
  onCreateCode(worktreeId: string): void;
  onCreateExplorer(worktreeId: string): void;
  onCreateHistory(worktreeId: string): void;
  onCreateTerminal(worktreeId: string): void;
  onRestoreChat?(chat: ChatSummary): void;
  onOpenTunnelOwner?(tunnel: TunnelSummary): void;
  onOpenImportedChat(chatId: string): void;
  onOpenPolicySettings?(policyId?: string): void;
  onMobileSectionOpenChange?(open: boolean): void;
  project: ProjectSummary;
  projectViews: ProjectViewSummary[];
  statuses: WorktreeStatusMap;
  terminals: TerminalSummary[];
  workers: WorkerSummary[];
  worktrees: ProjectWorktreeSummary[];
}) {
  const queryClient = useQueryClient();
  const visibleSettingsSections = useMemo(
    () => projectSettingsTabsForProject(project, worktrees, workers),
    [project, workers, worktrees],
  );
  const normalizedInitialSection = visibleSettingsSections.some(
    ({ id }) => id === initialSection,
  )
    ? initialSection
    : "general";
  const [section, setSection] = useState<ProjectSettingsSection>(
    normalizedInitialSection,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [pruneOpen, setPruneOpen] = useState(false);
  const [allowExternalPrune, setAllowExternalPrune] = useState(false);
  const [removeTarget, setRemoveTarget] =
    useState<ProjectWorktreeSummary | null>(null);
  const [forceRemove, setForceRemove] = useState(false);
  const [settingsSearchQuery, setSettingsSearchQuery] = useState("");
  const projectWorker = workers.find(
    ({ workerId }) => workerId === project.source?.workerId,
  );

  useEffect(() => {
    setSection(normalizedInitialSection);
  }, [normalizedInitialSection]);

  const updatePolicy = useMutation({
    mutationFn: (policy: WorktreePolicy) =>
      updateProjectWorktreePolicy(project.id, policy),
    onSuccess: (updated) => {
      queryClient.setQueryData<ProjectSummary[]>(["projects"], (current = []) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
    },
  });
  const reconcile = useMutation({
    mutationFn: () => reconcileProjectWorktrees(project.id),
    onSuccess: (next) => {
      queryClient.setQueryData(["worktrees", project.id], next);
      void queryClient.invalidateQueries({
        queryKey: ["worktree-status", project.id],
      });
    },
  });
  const createWorktree = useMutation({
    mutationFn: (input: ProjectWorktreeCreate) =>
      createProjectWorktree(project.id, input),
    onSuccess: (created) => {
      queryClient.setQueryData<ProjectWorktreeSummary[]>(
        ["worktrees", project.id],
        (current = []) => [
          ...current.filter(({ id }) => id !== created.id),
          created,
        ],
      );
    },
  });
  const lockWorktree = useMutation({
    mutationFn: (worktree: ProjectWorktreeSummary) =>
      worktree.locked
        ? unlockProjectWorktree(project.id, worktree.id)
        : lockProjectWorktree(
            project.id,
            worktree.id,
            "Locked from Project Settings",
          ),
    onSuccess: (updated) => {
      queryClient.setQueryData<ProjectWorktreeSummary[]>(
        ["worktrees", project.id],
        (current = []) =>
          current.map((item) => (item.id === updated.id ? updated : item)),
      );
    },
  });
  const prune = useMutation({
    mutationFn: () => pruneProjectWorktrees(project.id, allowExternalPrune),
    onSuccess: (next) => {
      queryClient.setQueryData(["worktrees", project.id], next);
      setPruneOpen(false);
      setAllowExternalPrune(false);
    },
  });
  const remove = useMutation({
    mutationFn: (target: ProjectWorktreeSummary) =>
      removeProjectWorktree(project.id, target.id, {
        allowExternal: target.origin === "external",
        force: forceRemove,
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData<ProjectWorktreeSummary[]>(
        ["worktrees", project.id],
        (current = []) =>
          current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setRemoveTarget(null);
      setForceRemove(false);
    },
  });
  const operationError = useMemo(
    () =>
      updatePolicy.error ??
      reconcile.error ??
      createWorktree.error ??
      lockWorktree.error ??
      prune.error ??
      remove.error,
    [
      createWorktree.error,
      lockWorktree.error,
      prune.error,
      reconcile.error,
      remove.error,
      updatePolicy.error,
    ],
  );
  const pendingInventory =
    reconcile.isPending ||
    createWorktree.isPending ||
    lockWorktree.isPending ||
    prune.isPending ||
    remove.isPending;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-slot="project-settings"
    >
      <SettingsNavigationLayout<ProjectSettingsSection>
        activeSection={section}
        ariaLabel="Project settings categories"
        initialMobileSectionOpen={normalizedInitialSection !== "general"}
        mobileSectionOpen={mobileSectionOpen}
        searchPlaceholder="Search all project settings"
        searchQuery={settingsSearchQuery}
        sections={visibleSettingsSections}
        title={`${project.name} settings`}
        onSearchQueryChange={setSettingsSearchQuery}
        onMobileSectionOpenChange={onMobileSectionOpenChange}
        onSectionChange={setSection}
      >
        {section === "automations" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ProjectAutomationsSettings
              chats={chats}
              githubAvailable={project.capabilities.github}
              projectId={project.id}
              workers={workers}
            />
          </div>
        ) : null}
        {section === "archive" ? (
          <ProjectArchiveSettings
            projectId={project.id}
            onRestoreChat={onRestoreChat}
          />
        ) : null}
        {section === "workflows" ? (
          <div className="min-h-0 w-full flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
            <WorkflowCenter
              chats={chats}
              directFolder={!project.capabilities.git}
              initialWorkflowId={initialWorkflowId}
              projectId={project.id}
              worker={projectWorker ?? null}
              onOpenHistory={onCreateHistory}
            />
          </div>
        ) : null}
        {section === "replicas" ? (
          <ProjectReplicaSettings project={project} workers={workers} />
        ) : null}
        {section === "policies" ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
            <PolicyAssignmentControls
              scope={{ kind: "project", id: project.id, name: project.name }}
              onEditPolicy={onOpenPolicySettings}
              onManagePolicies={onOpenPolicySettings}
            />
          </div>
        ) : null}
        <div
          className={cn(
            "min-h-0 w-full flex-1 space-y-4 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8",
            section !== "general" && section !== "worktrees" && "hidden",
          )}
        >
          {section === "worktrees" && operationError ? (
            <div className="flex gap-2 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              <span>
                {operationError instanceof Error
                  ? operationError.message
                  : "The project setting could not be updated."}
              </span>
            </div>
          ) : null}

          {section === "general" ? (
            <section aria-labelledby="project-details-title">
              <div className="mb-3">
                <h2 id="project-details-title" className="font-semibold">
                  Project details
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Server-owned metadata for this worker-backed source.
                </p>
              </div>
              <dl className="divide-y border-y">
                <DetailRow
                  label={
                    project.originKind === "managed-folder"
                      ? "Folder"
                      : "Repository"
                  }
                >
                  {project.github ? (
                    <a
                      className="inline-flex items-center gap-1.5 hover:underline"
                      href={project.github.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {project.github.nameWithOwner}
                      <ExternalLink className="size-3.5" />
                    </a>
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      {project.name}
                      <Badge variant="secondary">
                        {project.folderManagement === "external"
                          ? "Attached folder"
                          : "Managed folder"}
                      </Badge>
                    </span>
                  )}
                </DetailRow>
                <DetailRow label="Source location">
                  <code className="break-all text-xs">
                    {project.source?.displayPath ?? "Source unavailable"}
                  </code>
                </DetailRow>
                <DetailRow label="Worker">
                  <span className="inline-flex items-center gap-2">
                    <span
                      className={cn(
                        "size-2 rounded-full bg-muted-foreground",
                        projectWorker?.online && "bg-emerald-500",
                      )}
                    />
                    {projectWorker?.name ??
                      project.source?.workerId ??
                      "Unknown"}
                    <span className="text-xs text-muted-foreground">
                      {projectWorker?.online ? "Online" : "Offline"}
                    </span>
                  </span>
                </DetailRow>
                <DetailRow label="Added">
                  {createdDate.format(new Date(project.createdAt))}
                </DetailRow>
              </dl>
            </section>
          ) : null}

          {section === "general" ? (
            project.originKind === "managed-folder" &&
            project.folderManagement !== "external" ? (
              <ProjectGithubConversion project={project} workers={workers} />
            ) : null
          ) : null}

          {section === "general" ? (
            <ExternalChatImportSettings
              desktopRuntime={desktopRuntime}
              project={project}
              workers={workers}
              worktrees={worktrees}
              onOpenChat={onOpenImportedChat}
            />
          ) : null}

          {section === "general" ? (
            <ProjectExportSettings
              chats={chats}
              desktopRuntime={desktopRuntime}
              project={project}
              workers={workers}
              worktrees={worktrees}
            />
          ) : null}

          {section === "worktrees" ? (
            <section aria-labelledby="worktree-policy-title">
              <div className="mb-3">
                <h2 id="worktree-policy-title" className="font-semibold">
                  Worktree policy
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Controls whether agents may write to Primary or should isolate
                  their changes.
                </p>
              </div>
              <div className="divide-y border-y">
                {policies.map((policy) => {
                  const selected = project.worktreePolicy === policy.value;
                  return (
                    <button
                      key={policy.value}
                      type="button"
                      aria-pressed={selected}
                      disabled={updatePolicy.isPending}
                      className={cn(
                        "grid min-h-14 w-full gap-1 px-3 py-2.5 text-left transition-colors hover:bg-muted/60 disabled:opacity-60 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center sm:gap-4",
                        selected && "bg-muted/60",
                      )}
                      onClick={() => updatePolicy.mutate(policy.value)}
                    >
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {selected ? (
                          <span className="size-2 rounded-full bg-foreground" />
                        ) : (
                          <span className="size-2 rounded-full border" />
                        )}
                        {policy.label}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {policy.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}

          {section === "worktrees" ? (
            <section aria-labelledby="worktrees-title">
              <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 id="worktrees-title" className="font-semibold">
                    Worktrees{" "}
                    <span className="text-muted-foreground">
                      ({worktrees.length})
                    </span>
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Physical checkouts on the project worker and the tabs
                    currently bound to them.
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pendingInventory || !projectWorker?.online}
                    onClick={() => reconcile.mutate()}
                  >
                    <RefreshCw
                      className={cn(
                        "size-4",
                        reconcile.isPending && "animate-spin",
                      )}
                    />
                    Refresh
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pendingInventory || !projectWorker?.online}
                    onClick={() => setPruneOpen(true)}
                  >
                    <ScanLine className="size-4" /> Prune
                  </Button>
                  <Button
                    size="sm"
                    disabled={pendingInventory || !projectWorker?.online}
                    onClick={() => setCreateOpen(true)}
                  >
                    <Plus className="size-4" /> New worktree
                  </Button>
                </div>
              </div>

              <div className="border-y">
                <div className="hidden grid-cols-[minmax(13rem,1fr)_minmax(9rem,0.7fr)_minmax(10rem,0.8fr)_2.5rem] gap-4 border-b px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground md:grid">
                  <span>Worktree</span>
                  <span>Git state</span>
                  <span>Worker / bindings</span>
                  <span className="sr-only">Actions</span>
                </div>
                <div className="divide-y">
                  {worktrees.map((worktree) => {
                    const worker = workers.find(
                      ({ workerId }) => workerId === worktree.workerId,
                    );
                    const status = statuses[worktree.id];
                    const state = projectWorktreeState(
                      worktree,
                      status,
                      worker?.online ?? false,
                    );
                    const bindings = projectWorktreeBindings(
                      worktree.id,
                      chats,
                      terminals,
                      explorers,
                      projectViews,
                      codeTabs,
                    );
                    return (
                      <div
                        key={worktree.id}
                        data-high-contrast-row
                        className="grid gap-2 px-3 py-2.5 odd:bg-muted/[0.18] md:grid-cols-[minmax(13rem,1fr)_minmax(9rem,0.7fr)_minmax(10rem,0.8fr)_2.5rem] md:items-center md:gap-4"
                      >
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-2">
                            {worktree.isPrimary ? (
                              <GitBranch className="size-4 shrink-0" />
                            ) : (
                              <GitFork className="size-4 shrink-0 text-violet-500" />
                            )}
                            <span className="truncate text-sm font-medium">
                              {worktree.name}
                            </span>
                            {worktree.isPrimary ? (
                              <Badge variant="secondary" className="text-[9px]">
                                Primary
                              </Badge>
                            ) : null}
                            {worktree.origin === "external" ? (
                              <Badge variant="outline" className="text-[9px]">
                                External
                              </Badge>
                            ) : null}
                            {worktree.locked ? (
                              <Lock className="size-3.5 shrink-0 text-muted-foreground" />
                            ) : null}
                          </div>
                          <p
                            className="mt-1 truncate font-mono text-[10px] text-muted-foreground"
                            title={worktree.displayPath}
                          >
                            {worktree.displayPath}
                          </p>
                        </div>
                        <div className="min-w-0 text-xs">
                          <p className="truncate text-foreground">
                            {worktree.branch ??
                              `Detached ${worktree.head?.slice(0, 8) ?? "HEAD"}`}
                          </p>
                          <p
                            className={cn(
                              "mt-1 truncate text-muted-foreground capitalize",
                              state.tone === "warning" &&
                                "text-amber-600 dark:text-amber-400",
                              state.tone === "danger" && "text-destructive",
                            )}
                          >
                            {state.label}
                            {status?.ahead ? ` · ${status.ahead} ahead` : ""}
                            {status?.behind ? ` · ${status.behind} behind` : ""}
                          </p>
                          <CodeGraphWorktreeControls
                            available={Boolean(worker?.codegraph.available)}
                            enabled={
                              worktree.lifecycleState === "ready" &&
                              Boolean(worker?.online)
                            }
                            projectId={project.id}
                            worktreeId={worktree.id}
                          />
                        </div>
                        <div className="min-w-0 text-xs">
                          <p className="truncate">
                            {worker?.name ?? worktree.workerId}
                            {!worker?.online ? " · offline" : ""}
                          </p>
                          <p
                            className="mt-1 truncate text-muted-foreground"
                            title={bindings.join("\n")}
                          >
                            {bindings.length
                              ? `${bindings.length} bound: ${bindings.join(", ")}`
                              : "No bound tabs"}
                          </p>
                        </div>
                        <DropdownMenuPrimitive.Root>
                          <DropdownMenuPrimitive.Trigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-8 justify-self-end"
                            >
                              {lockWorktree.isPending || remove.isPending ? (
                                <Loader2 className="size-4 animate-spin" />
                              ) : (
                                <MoreHorizontal className="size-4" />
                              )}
                              <span className="sr-only">
                                Actions for {worktree.name}
                              </span>
                            </Button>
                          </DropdownMenuPrimitive.Trigger>
                          <DropdownMenuPrimitive.Portal>
                            <StyledDropdownMenuContent
                              align="end"
                              sideOffset={4}
                              className="min-w-52"
                            >
                              <DropdownMenuPrimitive.Label className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                                Open on this worktree
                              </DropdownMenuPrimitive.Label>
                              <StyledDropdownMenuItem
                                disabled={
                                  worktree.lifecycleState !== "ready" ||
                                  !worker?.online
                                }
                                onSelect={() => onCreateChat(worktree.id)}
                              >
                                <Bot className="size-4" /> New agent
                              </StyledDropdownMenuItem>
                              <StyledDropdownMenuItem
                                disabled={
                                  worktree.lifecycleState !== "ready" ||
                                  !worker?.online
                                }
                                onSelect={() => onCreateTerminal(worktree.id)}
                              >
                                <SquareTerminal className="size-4" /> Terminal
                              </StyledDropdownMenuItem>
                              <StyledDropdownMenuItem
                                disabled={
                                  worktree.lifecycleState !== "ready" ||
                                  !worker?.online
                                }
                                onSelect={() => onCreateExplorer(worktree.id)}
                              >
                                <FolderTree className="size-4" /> Explorer
                              </StyledDropdownMenuItem>
                              <StyledDropdownMenuItem
                                disabled={
                                  worktree.lifecycleState !== "ready" ||
                                  !worker?.online
                                }
                                onSelect={() => onCreateCode(worktree.id)}
                              >
                                <Code2 className="size-4" /> Code
                              </StyledDropdownMenuItem>
                              <StyledDropdownMenuItem
                                disabled={
                                  worktree.lifecycleState !== "ready" ||
                                  !worker?.online
                                }
                                onSelect={() => onCreateHistory(worktree.id)}
                              >
                                <History className="size-4" /> Git
                              </StyledDropdownMenuItem>
                              {!worktree.isPrimary ? (
                                <>
                                  <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
                                  <StyledDropdownMenuItem
                                    disabled={
                                      pendingInventory || !worker?.online
                                    }
                                    onSelect={() =>
                                      lockWorktree.mutate(worktree)
                                    }
                                  >
                                    {worktree.locked ? (
                                      <Unlock className="size-4" />
                                    ) : (
                                      <Lock className="size-4" />
                                    )}
                                    {worktree.locked ? "Unlock" : "Lock"}
                                  </StyledDropdownMenuItem>
                                  <StyledDropdownMenuItem
                                    className="text-destructive focus:bg-destructive/10"
                                    disabled={
                                      pendingInventory || !worker?.online
                                    }
                                    onSelect={() => {
                                      setForceRemove(false);
                                      setRemoveTarget(worktree);
                                    }}
                                  >
                                    <Trash2 className="size-4" /> Remove
                                    worktree
                                  </StyledDropdownMenuItem>
                                </>
                              ) : null}
                            </StyledDropdownMenuContent>
                          </DropdownMenuPrimitive.Portal>
                        </DropdownMenuPrimitive.Root>
                      </div>
                    );
                  })}
                  {!worktrees.length ? (
                    <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                      No worktree inventory is available. Refresh after the
                      worker reconnects.
                    </div>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}
        </div>
        {section === "skills" ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
            <SkillsSettings project={project} />
          </div>
        ) : null}
        {section === "tunnels" ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
            <TunnelSettings onOpenOwner={onOpenTunnelOwner} project={project} />
          </div>
        ) : null}
        {section === "mcp" ? (
          <div className="min-h-0 w-full flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
            <McpServerSettings
              scope={{ kind: "project", projectId: project.id }}
            />
          </div>
        ) : null}
      </SettingsNavigationLayout>

      <WorktreeCreateDialog
        open={createOpen}
        pending={createWorktree.isPending}
        projectId={project.id}
        sourceWorktreeId={
          worktrees.find(({ isPrimary }) => isPrimary)?.id ?? null
        }
        onOpenChange={setCreateOpen}
        onSubmit={(input) =>
          createWorktree.mutateAsync(input).then(() => undefined)
        }
      />

      <Dialog open={pruneOpen} onOpenChange={setPruneOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Prune stale worktree metadata?</DialogTitle>
            <DialogDescription>
              Git will remove stale administrative records. Healthy checkouts
              and branches are not deleted.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4"
              checked={allowExternalPrune}
              onChange={(event) => setAllowExternalPrune(event.target.checked)}
            />
            <span>Also prune stale metadata for external worktrees.</span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPruneOpen(false)}>
              Cancel
            </Button>
            <Button disabled={prune.isPending} onClick={() => prune.mutate()}>
              {prune.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              Prune
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(removeTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveTarget(null);
            setForceRemove(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {removeTarget?.name}?</DialogTitle>
            <DialogDescription>
              The physical checkout will be removed after safety checks. Its Git
              branch is retained.
            </DialogDescription>
          </DialogHeader>
          {removeTarget?.origin === "external" ? (
            <p className="rounded-md bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
              This checkout was discovered outside Cantrip. Continuing
              explicitly authorizes removal of that external worktree.
            </p>
          ) : null}
          {removeTarget && statuses[removeTarget.id]?.files.length ? (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={forceRemove}
                onChange={(event) => setForceRemove(event.target.checked)}
              />
              <span>
                I understand this worktree has uncommitted changes and want to
                force its removal.
              </span>
            </label>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={Boolean(
                removeTarget &&
                statuses[removeTarget.id]?.files.length &&
                !forceRemove,
              )}
              onClick={() => {
                if (removeTarget) remove.mutate(removeTarget);
              }}
              pending={remove.isPending}
              pendingLabel="Removing…"
            >
              Remove worktree
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
