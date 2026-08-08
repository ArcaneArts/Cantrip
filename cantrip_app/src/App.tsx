import type {
  BrowserSummary,
  ChatMessage,
  ChatSummary,
  ExplorerSummary,
  GithubRepository,
  ModelProfileSummary,
  ProjectSummary,
  ProjectViewKind,
  ProjectViewSummary,
  QueuedPrompt,
  SettingsBundle,
  SkillSummary,
  TerminalSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Bot,
  Check,
  CircleAlert,
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
  Plus,
  RefreshCw,
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
} from "react";

import { Activity, ActivityGroup } from "@/components/chat/activity";
import { Markdown } from "@/components/chat/markdown";
import { PromptQueue } from "@/components/chat/prompt-queue";
import {
  activeSkillMention,
  filterSkills,
  insertSkillMention,
  skillMentionSegments,
} from "@/components/chat/skill-mentions";
import { buildChatTimeline } from "@/components/chat/timeline";
import {
  filterSlashCommands,
  slashCommandQuery,
  type SlashCommandSuggestion,
} from "@/components/chat/slash-commands";
import {
  GitHistoryView,
  type GitHistoryHeaderState,
} from "@/components/git/git-history";
import { ProjectChatList } from "@/components/sidebar/project-chat-list";
import { SettingsPage } from "@/components/settings/settings-page";
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
  createChat,
  createChatConsole,
  createExplorer,
  createGithubProject,
  createProjectView,
  createTerminal,
  compactChat,
  deleteChat,
  deleteBrowser,
  deleteExplorer,
  deleteProjectView,
  deleteTerminal,
  deleteQueuedPrompt,
  forkChat,
  getChats,
  getBrowsers,
  getCachedGithubRepositories,
  getExplorers,
  getGithubRepositories,
  getGithubStatus,
  getMessages,
  getProjects,
  getProjectViews,
  getQueuedPrompts,
  getServerBootstrap,
  getSettings,
  getSkills,
  getTerminals,
  getWorkers,
  renameChat,
  renameExplorer,
  renameProjectView,
  renameTerminal,
  removeProject,
  reorderProjectTabs,
  reorderProjects,
  reorderQueuedPrompts,
  startTurn,
  steerQueuedPrompt,
  syncChat,
  updateChatModel,
  updateBrowser,
  updateQueuedPrompt,
} from "@/lib/api";
import {
  isDesktopRuntime,
  openDesktopPopout,
  parseDesktopPopoutTarget,
  updateDesktopWindowTheme,
  updateDesktopWindowTitle,
  type DesktopPopoutTarget,
} from "@/lib/desktop-popout";
import { browserUpdateForPageState } from "@/lib/browser-page-state";
import { cn } from "@/lib/utils";

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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function MessageContent({ message }: { message: ChatMessage }) {
  return (
    <div className="min-w-0 max-w-full space-y-3">
      {message.content.map((item, index) =>
        item.type === "text" ? (
          <Markdown key={`text:${index}`}>{item.text}</Markdown>
        ) : (
          <Activity
            key={`activity:${item.activity.id}`}
            activity={item.activity}
          />
        ),
      )}
    </div>
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
  onRename,
  settings,
  syncEnabled,
}: {
  chat: ChatSummary;
  onCreateChat(): void;
  onDelete(): void;
  onForked(chat: ChatSummary): void;
  onRename(title: string): void;
  settings: SettingsBundle | undefined;
  syncEnabled: boolean;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
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
  const commandListRef = useRef<HTMLDivElement>(null);
  const skillListRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const selectedModelId =
    chat.modelId ?? settings?.preferences.defaultModelId ?? "";
  const selectedModel = settings?.models.find(
    (model) => model.id === selectedModelId,
  );
  const messages = useQuery({
    queryFn: () => getMessages(chat.id),
    queryKey: ["messages", chat.id],
    refetchInterval: chat.status === "running" ? 750 : 3_000,
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
    refetchInterval: 750,
    retry: false,
  });
  const queuedPrompts = useQuery({
    queryFn: () => getQueuedPrompts(chat.id),
    queryKey: ["prompt-queue", chat.id],
    refetchInterval: chat.status === "running" ? 750 : 3_000,
  });
  const skills = useQuery({
    enabled: Boolean(selectedModelId && draft.includes("$")),
    queryFn: () => getSkills(chat.id),
    queryKey: ["skills", chat.id, selectedModelId],
    retry: false,
    staleTime: 30_000,
  });
  const timeline = useMemo(
    () => buildChatTimeline(messages.data ?? []),
    [messages.data],
  );
  const slashQuery = slashCommandQuery(draft);
  const slashSuggestions = useMemo(
    () => (slashQuery === null ? [] : filterSlashCommands(slashQuery)),
    [slashQuery],
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
  const send = useMutation({
    mutationFn: (text: string) => startTurn(chat.id, text, selectedModelId),
    onSuccess: async () => {
      setDraft("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["messages", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["chats", chat.projectId] }),
        queryClient.invalidateQueries({ queryKey: ["prompt-queue", chat.id] }),
      ]);
    },
  });
  const updatePrompt = useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: { text?: string; frozen?: boolean };
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
    if (
      !text ||
      !selectedModelId ||
      send.isPending ||
      selectModel.isPending ||
      updatePrompt.isPending
    ) {
      return;
    }
    if (editingPrompt) {
      updatePrompt.mutate(
        {
          id: editingPrompt.id,
          input: { text, frozen: editingPrompt.frozen },
        },
        {
          onSuccess: () => {
            setEditingPrompt(null);
            setDraft("");
          },
        },
      );
      return;
    }
    send.mutate(text);
  };

  const executeSlashCommand = async ({ command }: SlashCommandSuggestion) => {
    const name = command.name;
    setDraft("");
    setSlashMenuDismissed(true);
    setCommandNotice(null);

    if (name === "compact") {
      compact.mutate();
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
      if (prompt) send.mutate(prompt);
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

          {chat.status === "running" ? (
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <div className="grid size-7 place-items-center rounded-lg border bg-card">
                <Loader2 className="size-3.5 animate-spin" />
              </div>
              {selectedModel?.name ?? "Agent"} is working through Codex…
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
              aria-label="Slash commands"
              className="chat-composer-surface absolute inset-x-0 bottom-[calc(100%+0.5rem)] max-h-72 overflow-y-auto rounded-xl border p-1.5 shadow-2xl"
            >
              {slashSuggestions.map((suggestion, index) => (
                <button
                  key={suggestion.invocation}
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
                  onClick={() => void executeSlashCommand(suggestion)}
                >
                  <span className="w-36 shrink-0 font-mono text-sm font-medium">
                    {suggestion.invocation}
                  </span>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {suggestion.command.description}
                  </span>
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
          <PromptQueue
            prompts={queuedPrompts.data ?? []}
            editingPromptId={editingPrompt?.id ?? null}
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
          <div className="chat-composer-surface flex items-end gap-2 rounded-2xl border p-2 shadow-xl shadow-background/20 focus-within:ring-2 focus-within:ring-ring">
            <div className="min-w-0 flex-1">
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
                      if (suggestion) void executeSlashCommand(suggestion);
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
                <select
                  aria-label="Chat model"
                  value={selectedModelId}
                  disabled={chat.status === "running" || selectModel.isPending}
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
              </div>
            </div>
            <Button
              size="icon"
              type="submit"
              disabled={
                !draft.trim() ||
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
          {send.isError ||
          selectModel.isError ||
          compact.isError ||
          updatePrompt.isError ||
          removePrompt.isError ||
          steerPrompt.isError ||
          reorderPrompts.isError ? (
            <p className="mt-2 text-xs text-destructive">
              {errorText(
                send.error ??
                  selectModel.error ??
                  compact.error ??
                  updatePrompt.error ??
                  removePrompt.error ??
                  steerPrompt.error ??
                  reorderPrompts.error,
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
  const desktopRuntime = useMemo(() => isDesktopRuntime(), []);
  const popoutTarget = useMemo(
    () =>
      desktopRuntime ? parseDesktopPopoutTarget(window.location.search) : null,
    [desktopRuntime],
  );
  const isPopout = popoutTarget !== null;
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    popoutTarget?.projectId ?? null,
  );
  const [selectedChatId, setSelectedChatId] = useState<string | null>(
    popoutTarget?.kind === "chat" ? popoutTarget.tabId : null,
  );
  const [selectedBrowserId, setSelectedBrowserId] = useState<string | null>(
    popoutTarget?.kind === "browser" ? popoutTarget.tabId : null,
  );
  const [selectedExplorerId, setSelectedExplorerId] = useState<string | null>(
    popoutTarget?.kind === "explorer" ? popoutTarget.tabId : null,
  );
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(
    popoutTarget?.kind === "terminal" ? popoutTarget.tabId : null,
  );
  const [selectedProjectViewId, setSelectedProjectViewId] = useState<
    string | null
  >(popoutTarget?.kind === "view" ? popoutTarget.tabId : null);
  const [showImporter, setShowImporter] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [gitHistoryHeader, setGitHistoryHeader] =
    useState<GitHistoryHeaderState | null>(null);
  const [popoutPending, setPopoutPending] = useState(false);
  const [popoutError, setPopoutError] = useState<string | null>(null);

  const openCreatedTab = (
    projectId: string,
    kind: "browser" | "chat" | "explorer" | "terminal" | "view",
    tabId: string,
  ) => {
    setSelectedProjectId(projectId);
    setSelectedChatId(kind === "chat" ? tabId : null);
    setSelectedTerminalId(kind === "terminal" ? tabId : null);
    setSelectedExplorerId(kind === "explorer" ? tabId : null);
    setSelectedBrowserId(kind === "browser" ? tabId : null);
    setSelectedProjectViewId(kind === "view" ? tabId : null);
    setShowImporter(false);
    setShowSettings(false);
    setMobileNavigationOpen(false);
  };

  const bootstrap = useQuery({
    queryFn: getServerBootstrap,
    queryKey: ["server-bootstrap"],
  });
  const workers = useQuery({
    queryFn: getWorkers,
    queryKey: ["workers"],
    refetchInterval: 3_000,
  });
  const settings = useQuery({ queryFn: getSettings, queryKey: ["settings"] });
  const projects = useQuery({
    queryFn: getProjects,
    queryKey: ["projects"],
    refetchInterval: (query) =>
      query.state.data?.some((project) => project.setupStatus === "cloning")
        ? 750
        : false,
  });
  const chats = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getChats(selectedProjectId!),
    queryKey: ["chats", selectedProjectId],
    refetchInterval: 1_000,
  });
  const terminals = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getTerminals(selectedProjectId!),
    queryKey: ["terminals", selectedProjectId],
    refetchInterval: 1_000,
  });
  const explorers = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getExplorers(selectedProjectId!),
    queryKey: ["explorers", selectedProjectId],
    refetchInterval: 1_000,
  });
  const browsers = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getBrowsers(selectedProjectId!),
    queryKey: ["browsers", selectedProjectId],
    refetchInterval: 1_000,
  });
  const projectViews = useQuery({
    enabled: Boolean(selectedProjectId),
    queryFn: () => getProjectViews(selectedProjectId!),
    queryKey: ["project-views", selectedProjectId],
    refetchInterval: 1_000,
  });
  const newChat = useMutation({
    mutationFn: (projectId: string) => createChat(projectId, "New chat"),
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
    mutationFn: (projectId: string) => createTerminal(projectId, "Terminal"),
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
      openCreatedTab(terminal.projectId, "terminal", terminal.id);
    },
  });
  const newExplorer = useMutation({
    mutationFn: (projectId: string) => createExplorer(projectId, "Explorer"),
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
  const newProjectView = useMutation({
    mutationFn: ({
      projectId,
      kind,
    }: {
      projectId: string;
      kind: ProjectViewKind;
    }) =>
      createProjectView(
        projectId,
        kind,
        kind === "history" ? "History" : "Issues",
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
      setSelectedProjectId(forked.projectId);
      setSelectedTerminalId(null);
      setSelectedExplorerId(null);
      setSelectedBrowserId(null);
      setSelectedChatId(forked.id);
    },
  });
  const deleteChatMutation = useMutation({
    mutationFn: deleteChat,
    onSuccess: async (_value, deletedId) => {
      if (selectedChatId === deletedId) setSelectedChatId(null);
      await queryClient.invalidateQueries({
        queryKey: ["chats", selectedProjectId],
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
      if (selectedTerminalId === deletedId) setSelectedTerminalId(null);
      await queryClient.invalidateQueries({
        queryKey: ["terminals", selectedProjectId],
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
      if (selectedExplorerId === deletedId) setSelectedExplorerId(null);
      await queryClient.invalidateQueries({
        queryKey: ["explorers", selectedProjectId],
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
      if (selectedBrowserId === deletedId) setSelectedBrowserId(null);
      await queryClient.invalidateQueries({
        queryKey: ["browsers", selectedProjectId],
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
      if (selectedProjectViewId === deletedId) setSelectedProjectViewId(null);
      await queryClient.invalidateQueries({
        queryKey: ["project-views", selectedProjectId],
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
        setSelectedChatId(null);
        setSelectedTerminalId(null);
        setSelectedExplorerId(null);
        setSelectedBrowserId(null);
        setSelectedProjectViewId(null);
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
  const reorderTabsMutation = useMutation({
    mutationFn: ({ projectId, ids }: { projectId: string; ids: string[] }) =>
      reorderProjectTabs(projectId, ids),
    onMutate: async ({ projectId, ids }) => {
      const chatKey = ["chats", projectId] as const;
      const terminalKey = ["terminals", projectId] as const;
      const explorerKey = ["explorers", projectId] as const;
      const browserKey = ["browsers", projectId] as const;
      const viewKey = ["project-views", projectId] as const;
      await Promise.all([
        queryClient.cancelQueries({ queryKey: chatKey }),
        queryClient.cancelQueries({ queryKey: terminalKey }),
        queryClient.cancelQueries({ queryKey: explorerKey }),
        queryClient.cancelQueries({ queryKey: browserKey }),
        queryClient.cancelQueries({ queryKey: viewKey }),
      ]);
      const previousChats = queryClient.getQueryData<ChatSummary[]>(chatKey);
      const previousTerminals =
        queryClient.getQueryData<TerminalSummary[]>(terminalKey);
      const previousExplorers =
        queryClient.getQueryData<ExplorerSummary[]>(explorerKey);
      const previousBrowsers =
        queryClient.getQueryData<BrowserSummary[]>(browserKey);
      const previousViews =
        queryClient.getQueryData<ProjectViewSummary[]>(viewKey);
      const positions = new Map(ids.map((id, position) => [id, position]));
      queryClient.setQueryData<ChatSummary[]>(chatKey, (current = []) =>
        current
          .map((chat) => ({
            ...chat,
            position: positions.get(`chat:${chat.id}`) ?? chat.position,
          }))
          .sort((a, b) => a.position - b.position),
      );
      queryClient.setQueryData<TerminalSummary[]>(terminalKey, (current = []) =>
        current
          .map((terminal) => ({
            ...terminal,
            position:
              positions.get(`terminal:${terminal.id}`) ?? terminal.position,
          }))
          .sort((a, b) => a.position - b.position),
      );
      queryClient.setQueryData<ExplorerSummary[]>(explorerKey, (current = []) =>
        current
          .map((explorer) => ({
            ...explorer,
            position:
              positions.get(`explorer:${explorer.id}`) ?? explorer.position,
          }))
          .sort((a, b) => a.position - b.position),
      );
      queryClient.setQueryData<BrowserSummary[]>(browserKey, (current = []) =>
        current
          .map((browser) => ({
            ...browser,
            position:
              positions.get(`browser:${browser.id}`) ?? browser.position,
          }))
          .sort((a, b) => a.position - b.position),
      );
      queryClient.setQueryData<ProjectViewSummary[]>(viewKey, (current = []) =>
        current
          .map((view) => ({
            ...view,
            position: positions.get(`view:${view.id}`) ?? view.position,
          }))
          .sort((a, b) => a.position - b.position),
      );
      return {
        browserKey,
        chatKey,
        explorerKey,
        terminalKey,
        viewKey,
        previousChats,
        previousBrowsers,
        previousExplorers,
        previousTerminals,
        previousViews,
      };
    },
    onError: (_error, _input, context) => {
      queryClient.setQueryData(context?.chatKey ?? [], context?.previousChats);
      queryClient.setQueryData(
        context?.terminalKey ?? [],
        context?.previousTerminals,
      );
      queryClient.setQueryData(
        context?.explorerKey ?? [],
        context?.previousExplorers,
      );
      queryClient.setQueryData(
        context?.browserKey ?? [],
        context?.previousBrowsers,
      );
      queryClient.setQueryData(context?.viewKey ?? [], context?.previousViews);
    },
    onSettled: (_data, _error, input) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["chats", input.projectId] }),
        queryClient.invalidateQueries({
          queryKey: ["terminals", input.projectId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["explorers", input.projectId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["browsers", input.projectId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["project-views", input.projectId],
        }),
      ]),
  });

  const onlineWorker = workers.data?.find((worker) => worker.online) ?? null;
  const selectedProject = projects.data?.find(
    (project) => project.id === selectedProjectId,
  );
  const selectedProjectView = projectViews.data?.find(
    (view) => view.id === selectedProjectViewId,
  );
  const gitHistoryProject = selectedProjectView ? selectedProject : undefined;
  const selectedChat = chats.data?.find((chat) => chat.id === selectedChatId);
  const selectedTerminal = terminals.data?.find(
    (terminal) => terminal.id === selectedTerminalId,
  );
  const linkedConsoleChat = selectedTerminal?.linkedChatId
    ? chats.data?.find((chat) => chat.id === selectedTerminal.linkedChatId)
    : undefined;
  const activeChat = selectedChat ?? linkedConsoleChat;
  const selectedExplorer = explorers.data?.find(
    (explorer) => explorer.id === selectedExplorerId,
  );
  const selectedBrowser = browsers.data?.find(
    (browser) => browser.id === selectedBrowserId,
  );
  const currentSurface = useMemo<{
    target: DesktopPopoutTarget;
    title: string;
  } | null>(() => {
    if (showImporter || showSettings) return null;
    if (gitHistoryProject && selectedProjectView) {
      return {
        target: {
          kind: "view",
          projectId: gitHistoryProject.id,
          tabId: selectedProjectView.id,
        },
        title: selectedProjectView.title,
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
    if (selectedTerminal) {
      return {
        target: {
          kind: "terminal",
          projectId: selectedTerminal.projectId,
          tabId: selectedTerminal.id,
        },
        title: selectedTerminal.linkedChatId
          ? `${linkedConsoleChat?.title ?? "Chat"} · Codex console`
          : selectedTerminal.title,
      };
    }
    if (selectedChat) {
      return {
        target: {
          kind: "chat",
          projectId: selectedChat.projectId,
          tabId: selectedChat.id,
        },
        title: selectedChat.title,
      };
    }
    return null;
  }, [
    gitHistoryProject,
    linkedConsoleChat?.title,
    selectedBrowser,
    selectedChat,
    selectedExplorer,
    selectedProjectView,
    selectedTerminal,
    showImporter,
    showSettings,
  ]);
  const activePopout = desktopRuntime && !isPopout ? currentSurface : null;
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
  const showChatConsole = (chat: ChatSummary) => {
    const existing = terminals.data?.find(
      (terminal) => terminal.linkedChatId === chat.id,
    );
    if (existing) {
      openCreatedTab(chat.projectId, "terminal", existing.id);
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
    if (showImporter || showSettings) setSelectedProjectViewId(null);
  }, [showImporter, showSettings]);

  useEffect(() => {
    if (!projects.data) return;
    if (projects.data.length === 0) {
      setShowImporter(true);
      setShowSettings(false);
      setSelectedProjectId(null);
      return;
    }
    if (!projects.data.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(projects.data[0]?.id ?? null);
    }
  }, [projects.data, selectedProjectId]);

  useEffect(() => {
    if (
      !chats.data ||
      !terminals.data ||
      !explorers.data ||
      !browsers.data ||
      !projectViews.data
    )
      return;
    if (chats.data.some((chat) => chat.id === selectedChatId)) return;
    if (terminals.data.some((terminal) => terminal.id === selectedTerminalId))
      return;
    if (explorers.data.some((explorer) => explorer.id === selectedExplorerId))
      return;
    if (browsers.data.some((browser) => browser.id === selectedBrowserId))
      return;
    if (projectViews.data.some((view) => view.id === selectedProjectViewId))
      return;
    const first = [
      ...chats.data.map((chat) => ({
        id: chat.id,
        kind: "chat",
        position: chat.position,
      })),
      ...terminals.data.flatMap((terminal) =>
        terminal.linkedChatId
          ? []
          : [
              {
                id: terminal.id,
                kind: "terminal",
                position: terminal.position,
              },
            ],
      ),
      ...explorers.data.map((explorer) => ({
        id: explorer.id,
        kind: "explorer",
        position: explorer.position,
      })),
      ...browsers.data.map((browser) => ({
        id: browser.id,
        kind: "browser",
        position: browser.position,
      })),
      ...projectViews.data.map((view) => ({
        id: view.id,
        kind: "view",
        position: view.position,
      })),
    ].sort((left, right) => left.position - right.position)[0];
    setSelectedChatId(first?.kind === "chat" ? first.id : null);
    setSelectedTerminalId(first?.kind === "terminal" ? first.id : null);
    setSelectedExplorerId(first?.kind === "explorer" ? first.id : null);
    setSelectedBrowserId(first?.kind === "browser" ? first.id : null);
    setSelectedProjectViewId(first?.kind === "view" ? first.id : null);
  }, [
    browsers.data,
    chats.data,
    explorers.data,
    projectViews.data,
    selectedChatId,
    selectedBrowserId,
    selectedExplorerId,
    selectedProjectViewId,
    selectedTerminalId,
    terminals.data,
  ]);

  return (
    <main className="flex h-svh overflow-hidden bg-background text-foreground">
      {!isPopout ? (
        <aside
          data-slot="app-sidebar"
          className="hidden w-72 shrink-0 flex-col border-r bg-background md:flex"
        >
          <div className="flex h-16 items-center gap-3 border-b px-4">
            <div className="grid size-9 place-items-center rounded-xl border bg-background shadow-sm">
              <WandSparkles className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-semibold tracking-tight">Cantrip</p>
            </div>
            <StatusDot online={Boolean(onlineWorker)} />
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
              explorers={explorers.data ?? []}
              projectViews={projectViews.data ?? []}
              terminals={terminals.data ?? []}
              selectedProjectId={selectedProjectId}
              selectedBrowserId={selectedBrowserId}
              selectedChatId={selectedChatId}
              selectedExplorerId={selectedExplorerId}
              selectedProjectViewId={selectedProjectViewId}
              selectedTerminalId={selectedTerminalId}
              creatingChat={newChat.isPending}
              creatingBrowser={newBrowser.isPending}
              creatingExplorer={newExplorer.isPending}
              creatingTerminal={newTerminal.isPending}
              creatingView={newProjectView.isPending}
              onCreateChat={(projectId) => newChat.mutate(projectId)}
              onCreateBrowser={(projectId) => newBrowser.mutate(projectId)}
              onCreateExplorer={(projectId) => newExplorer.mutate(projectId)}
              onCreateHistory={(projectId) =>
                newProjectView.mutate({ projectId, kind: "history" })
              }
              onCreateIssues={(projectId) =>
                newProjectView.mutate({ projectId, kind: "issues" })
              }
              onCreateTerminal={(projectId) => newTerminal.mutate(projectId)}
              onRenameChat={(chatId, title) =>
                renameChatMutation.mutate({ chatId, title })
              }
              onDuplicateChat={(chatId) => forkChatMutation.mutate(chatId)}
              onDeleteChat={(chatId) => deleteChatMutation.mutate(chatId)}
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
              onReorderProjects={(ids) => reorderProjectsMutation.mutate(ids)}
              onReorderTabs={(projectId, ids) =>
                reorderTabsMutation.mutate({ projectId, ids })
              }
              onSelectProject={(projectId) => {
                setSelectedProjectViewId(null);
                setSelectedProjectId(projectId);
                setSelectedChatId(null);
                setSelectedTerminalId(null);
                setSelectedExplorerId(null);
                setSelectedBrowserId(null);
                setShowImporter(false);
                setShowSettings(false);
              }}
              onSelectChat={(chatId) => {
                setSelectedProjectViewId(null);
                setSelectedTerminalId(null);
                setSelectedExplorerId(null);
                setSelectedBrowserId(null);
                setSelectedChatId(chatId);
                setShowImporter(false);
                setShowSettings(false);
              }}
              onSelectTerminal={(terminalId) => {
                setSelectedProjectViewId(null);
                setSelectedChatId(null);
                setSelectedExplorerId(null);
                setSelectedBrowserId(null);
                setSelectedTerminalId(terminalId);
                setShowImporter(false);
                setShowSettings(false);
              }}
              onSelectExplorer={(explorerId) => {
                setSelectedProjectViewId(null);
                setSelectedChatId(null);
                setSelectedTerminalId(null);
                setSelectedBrowserId(null);
                setSelectedExplorerId(explorerId);
                setShowImporter(false);
                setShowSettings(false);
              }}
              onSelectBrowser={(browserId) => {
                setSelectedProjectViewId(null);
                setSelectedChatId(null);
                setSelectedTerminalId(null);
                setSelectedExplorerId(null);
                setSelectedBrowserId(browserId);
                setShowImporter(false);
                setShowSettings(false);
              }}
              onSelectProjectView={(viewId) => {
                setSelectedChatId(null);
                setSelectedTerminalId(null);
                setSelectedExplorerId(null);
                setSelectedBrowserId(null);
                setSelectedProjectViewId(viewId);
                setShowImporter(false);
                setShowSettings(false);
              }}
            />
          </nav>

          <div className="border-t p-3">
            <div className="flex items-center gap-3 rounded-lg px-2 py-2">
              <div className="grid size-8 place-items-center rounded-full bg-muted">
                <User className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">Local User</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {onlineWorker?.name ?? "Worker offline"}
                </p>
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                onClick={() => {
                  setShowSettings(true);
                  setShowImporter(false);
                }}
              >
                <Settings className="size-4" />
                <span className="sr-only">Open settings</span>
              </Button>
            </div>
          </div>
        </aside>
      ) : null}

      <section className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {!isPopout ? (
          <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b px-4 sm:px-6">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                <span className="truncate">
                  {showImporter
                    ? "GitHub repositories"
                    : showSettings
                      ? "Settings"
                      : gitHistoryProject
                        ? (selectedProjectView?.title ?? "Git")
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
                                : (selectedProject?.github?.nameWithOwner ??
                                  "Cantrip")}
                </span>
                {gitHistoryProject && gitHistoryHeader ? (
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
              <p className="truncate text-xs text-muted-foreground">
                {showImporter ? (
                  "Add a worker-owned source"
                ) : showSettings ? (
                  "Account preferences"
                ) : gitHistoryProject ? (
                  <>
                    {gitHistoryProject.github?.nameWithOwner ??
                      gitHistoryProject.name}
                    {gitHistoryHeader ? (
                      selectedProjectView?.kind === "issues" ? (
                        ` · ${gitHistoryHeader.issueCount ?? "…"} ${gitHistoryHeader.issueState} issues`
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
                ) : selectedBrowser ? (
                  selectedBrowser.url
                ) : selectedExplorer ? (
                  (selectedProject?.source?.displayPath ?? "Explorer")
                ) : selectedTerminal ? (
                  selectedTerminal.linkedChatId ? (
                    (selectedProject?.source?.displayPath ?? "Chat")
                  ) : (
                    (selectedProject?.source?.displayPath ?? "Terminal")
                  )
                ) : selectedChat ? (
                  (selectedProject?.source?.displayPath ?? "Chat")
                ) : (
                  (selectedProject?.source?.displayPath ??
                  "Choose a project to begin")
                )}
              </p>
            </div>
            <div className="flex items-center gap-2 md:hidden">
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
              selectedProjectView?.kind === "history" &&
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
                <Button
                  size="icon"
                  variant="ghost"
                  aria-pressed={Boolean(linkedConsoleChat)}
                  disabled={!linkedConsoleChat && openChatConsole.isPending}
                  onClick={() =>
                    linkedConsoleChat
                      ? openCreatedTab(
                          linkedConsoleChat.projectId,
                          "chat",
                          linkedConsoleChat.id,
                        )
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
              ) : null}
              {!isPopout ? (
                <>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => {
                      setShowSettings(true);
                      setShowImporter(false);
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
                    }}
                  >
                    <Plus className="size-4" />
                    Project
                  </Button>
                </>
              ) : null}
            </div>
            <div className="ml-auto hidden items-center gap-2 md:flex">
              {gitHistoryProject &&
              selectedProjectView?.kind === "history" &&
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
                <Button
                  size="icon"
                  variant="ghost"
                  aria-pressed={Boolean(linkedConsoleChat)}
                  disabled={!linkedConsoleChat && openChatConsole.isPending}
                  onClick={() =>
                    linkedConsoleChat
                      ? openCreatedTab(
                          linkedConsoleChat.projectId,
                          "chat",
                          linkedConsoleChat.id,
                        )
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
              ) : null}
              {!showImporter && !showSettings && selectedProject ? (
                <Badge variant="outline" className="gap-2">
                  <StatusDot online={Boolean(onlineWorker)} />
                  {onlineWorker?.name ?? "Worker offline"}
                </Badge>
              ) : null}
            </div>
          </header>
        ) : null}

        {isPopout && activeChat && !showImporter && !showSettings ? (
          <div className="absolute right-3 top-3 z-40">
            <Button
              size="icon"
              variant="outline"
              className="size-9 bg-background/75 shadow-md backdrop-blur-xl"
              aria-pressed={Boolean(linkedConsoleChat)}
              disabled={!linkedConsoleChat && openChatConsole.isPending}
              onClick={() =>
                linkedConsoleChat
                  ? openCreatedTab(
                      linkedConsoleChat.projectId,
                      "chat",
                      linkedConsoleChat.id,
                    )
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

        {showSettings ? (
          <SettingsPage />
        ) : showImporter ? (
          <RepositoryImporter
            projects={projects.data ?? []}
            workerId={onlineWorker?.workerId ?? null}
          />
        ) : gitHistoryProject ? (
          <GitHistoryView
            view={selectedProjectView?.kind ?? "history"}
            standalone={isPopout}
            project={gitHistoryProject}
            onHeaderChange={setGitHistoryHeader}
          />
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
            <ExplorerView explorer={selectedExplorer} />
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
                onExit={() => {
                  openCreatedTab(
                    linkedConsoleChat.projectId,
                    "chat",
                    linkedConsoleChat.id,
                  );
                }}
              />
            ) : (
              <TerminalView terminal={selectedTerminal} />
            )}
          </Suspense>
        ) : selectedChat ? (
          <ChatTranscript
            chat={selectedChat}
            settings={settings.data}
            syncEnabled={
              terminals.data?.some(
                (terminal) => terminal.linkedChatId === selectedChat.id,
              ) ?? false
            }
            onCreateChat={() => newChat.mutate(selectedChat.projectId)}
            onDelete={() => deleteChatMutation.mutate(selectedChat.id)}
            onForked={(forked) => {
              setSelectedProjectId(forked.projectId);
              setSelectedTerminalId(null);
              setSelectedExplorerId(null);
              setSelectedBrowserId(null);
              setSelectedChatId(forked.id);
            }}
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
                  Start a Codex chat, shell, file explorer, or browser in{" "}
                  {selectedProject.name}.
                </p>
                <div className="mt-5 flex justify-center gap-2">
                  <Button
                    disabled={newChat.isPending || !selectedProject.source}
                    onClick={() => newChat.mutate(selectedProject.id)}
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
                    onClick={() => newTerminal.mutate(selectedProject.id)}
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
                    onClick={() => newExplorer.mutate(selectedProject.id)}
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
                }}
              >
                <Plus className="size-4" />
                Add from GitHub
              </Button>
            </div>
          </div>
        )}
      </section>

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
              explorers={explorers.data ?? []}
              projectViews={projectViews.data ?? []}
              terminals={terminals.data ?? []}
              selectedProjectId={selectedProjectId}
              selectedBrowserId={selectedBrowserId}
              selectedChatId={selectedChatId}
              selectedExplorerId={selectedExplorerId}
              selectedProjectViewId={selectedProjectViewId}
              selectedTerminalId={selectedTerminalId}
              creatingChat={newChat.isPending}
              creatingBrowser={newBrowser.isPending}
              creatingExplorer={newExplorer.isPending}
              creatingTerminal={newTerminal.isPending}
              creatingView={newProjectView.isPending}
              onCreateChat={(projectId) => newChat.mutate(projectId)}
              onCreateBrowser={(projectId) => newBrowser.mutate(projectId)}
              onCreateExplorer={(projectId) => newExplorer.mutate(projectId)}
              onCreateHistory={(projectId) =>
                newProjectView.mutate({ projectId, kind: "history" })
              }
              onCreateIssues={(projectId) =>
                newProjectView.mutate({ projectId, kind: "issues" })
              }
              onCreateTerminal={(projectId) => newTerminal.mutate(projectId)}
              onRenameChat={(chatId, title) =>
                renameChatMutation.mutate({ chatId, title })
              }
              onDuplicateChat={(chatId) => forkChatMutation.mutate(chatId)}
              onDeleteChat={(chatId) => deleteChatMutation.mutate(chatId)}
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
              onReorderProjects={(ids) => reorderProjectsMutation.mutate(ids)}
              onReorderTabs={(projectId, ids) =>
                reorderTabsMutation.mutate({ projectId, ids })
              }
              onSelectProject={(projectId) => {
                setSelectedProjectViewId(null);
                setSelectedProjectId(projectId);
                setSelectedChatId(null);
                setSelectedTerminalId(null);
                setSelectedExplorerId(null);
                setSelectedBrowserId(null);
              }}
              onSelectChat={(chatId) => {
                setSelectedProjectViewId(null);
                setSelectedTerminalId(null);
                setSelectedExplorerId(null);
                setSelectedBrowserId(null);
                setSelectedChatId(chatId);
                setMobileNavigationOpen(false);
                setShowImporter(false);
                setShowSettings(false);
              }}
              onSelectTerminal={(terminalId) => {
                setSelectedProjectViewId(null);
                setSelectedChatId(null);
                setSelectedExplorerId(null);
                setSelectedBrowserId(null);
                setSelectedTerminalId(terminalId);
                setMobileNavigationOpen(false);
                setShowImporter(false);
                setShowSettings(false);
              }}
              onSelectExplorer={(explorerId) => {
                setSelectedProjectViewId(null);
                setSelectedChatId(null);
                setSelectedTerminalId(null);
                setSelectedBrowserId(null);
                setSelectedExplorerId(explorerId);
                setMobileNavigationOpen(false);
                setShowImporter(false);
                setShowSettings(false);
              }}
              onSelectBrowser={(browserId) => {
                setSelectedProjectViewId(null);
                setSelectedChatId(null);
                setSelectedTerminalId(null);
                setSelectedExplorerId(null);
                setSelectedBrowserId(browserId);
                setMobileNavigationOpen(false);
                setShowImporter(false);
                setShowSettings(false);
              }}
              onSelectProjectView={(viewId) => {
                setSelectedChatId(null);
                setSelectedTerminalId(null);
                setSelectedExplorerId(null);
                setSelectedBrowserId(null);
                setSelectedProjectViewId(viewId);
                setMobileNavigationOpen(false);
                setShowImporter(false);
                setShowSettings(false);
              }}
            />
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
