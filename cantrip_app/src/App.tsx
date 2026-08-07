import type {
  ChatMessage,
  ChatSummary,
  GithubRepository,
  ProjectSummary,
  SettingsBundle,
  TerminalSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Check,
  Copy,
  FolderGit2,
  GitFork,
  GitBranch,
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
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import { Activity, ActivityGroup } from "@/components/chat/activity";
import { Markdown } from "@/components/chat/markdown";
import { buildChatTimeline } from "@/components/chat/timeline";
import { GitHistoryView } from "@/components/git/git-history";
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
  createChat,
  createGithubProject,
  createTerminal,
  deleteChat,
  deleteTerminal,
  forkChat,
  getChats,
  getGithubRepositories,
  getGithubStatus,
  getMessages,
  getProjects,
  getServerBootstrap,
  getSettings,
  getTerminals,
  getWorkers,
  renameChat,
  renameTerminal,
  removeProject,
  reorderProjectTabs,
  reorderProjects,
  startTurn,
  updateChatModel,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const TerminalView = lazy(() =>
  import("@/components/terminal/terminal-view").then((module) => ({
    default: module.TerminalView,
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
  onClose,
  onImported,
  workerId,
}: {
  onClose(): void;
  onImported(project: ProjectSummary): void;
  workerId: string | null;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
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
  const importProject = useMutation({
    mutationFn: (repository: GithubRepository) =>
      createGithubProject({
        workerId: workerId!,
        repositoryId: repository.id,
        nameWithOwner: repository.nameWithOwner,
        url: repository.url,
      }),
    onSuccess: async (project) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({
          queryKey: ["github-repositories", workerId],
        }),
      ]);
      onImported(project);
    },
  });

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (repositories.data ?? []).filter((repository) =>
      needle
        ? `${repository.nameWithOwner} ${repository.description ?? ""}`
            .toLowerCase()
            .includes(needle)
        : true,
    );
  }, [repositories.data, search]);
  const visibleRepositories = filtered.slice(0, 100);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-4 border-b px-5 py-4 sm:px-8">
        <div>
          <h1 className="font-semibold tracking-tight">Add from GitHub</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Cantrip clones one repository into a worker-owned source folder.
          </p>
        </div>
        <Button size="icon" variant="ghost" onClick={onClose}>
          <X className="size-4" />
          <span className="sr-only">Close repository picker</span>
        </Button>
      </header>

      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 overflow-hidden p-5 sm:p-8">
        {!workerId ? (
          <Card>
            <CardHeader>
              <CardTitle>No worker available</CardTitle>
              <CardDescription>
                Start the local worker before importing a repository.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : github.isLoading ? (
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
              <Badge variant="secondary" className="w-fit gap-2 px-3 py-2">
                <StatusDot online />@{github.data.login}
              </Badge>
            </div>

            {repositories.isLoading ? (
              <div className="grid flex-1 place-items-center text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
              </div>
            ) : repositories.isError ? (
              <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                {errorText(repositories.error)}
              </p>
            ) : (
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                {visibleRepositories.map((repository) => (
                  <div
                    key={repository.id}
                    className="flex items-center gap-4 rounded-xl border bg-card p-4"
                  >
                    <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
                      {repository.isPrivate ? (
                        <Lock className="size-4" />
                      ) : repository.isFork ? (
                        <GitFork className="size-4" />
                      ) : (
                        <FolderGit2 className="size-4" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {repository.nameWithOwner}
                      </p>
                      <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                        {repository.description ?? "No description"}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant={repository.imported ? "outline" : "default"}
                      disabled={repository.imported || importProject.isPending}
                      onClick={() => importProject.mutate(repository)}
                    >
                      {repository.imported ? (
                        <Check className="size-4" />
                      ) : importProject.isPending &&
                        importProject.variables?.id === repository.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Plus className="size-4" />
                      )}
                      {repository.imported ? "Added" : "Add"}
                    </Button>
                  </div>
                ))}
                {filtered.length === 0 ? (
                  <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                    No matching repositories.
                  </p>
                ) : null}
                {filtered.length > visibleRepositories.length ? (
                  <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                    Showing the first {visibleRepositories.length} of{" "}
                    {filtered.length} repositories. Search to narrow the list.
                  </p>
                ) : null}
              </div>
            )}

            {importProject.isError ? (
              <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {errorText(importProject.error)}
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
  onForked,
  settings,
}: {
  chat: ChatSummary;
  onForked(chat: ChatSummary): void;
  settings: SettingsBundle | undefined;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
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
  const timeline = useMemo(
    () => buildChatTimeline(messages.data ?? []),
    [messages.data],
  );
  const send = useMutation({
    mutationFn: (text: string) => startTurn(chat.id, text, selectedModelId),
    onSuccess: async () => {
      setDraft("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["messages", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["chats", chat.projectId] }),
      ]);
    },
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
    mutationFn: (messageId: string) => forkChat(chat.id, messageId),
    onSuccess: async (forked) => {
      await queryClient.invalidateQueries({
        queryKey: ["chats", chat.projectId],
      });
      onForked(forked);
    },
  });

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (
      !text ||
      !selectedModelId ||
      send.isPending ||
      selectModel.isPending ||
      chat.status === "running"
    ) {
      return;
    }
    send.mutate(text);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-8">
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

      <form onSubmit={submit} className="border-t bg-background p-4 sm:px-8">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-end gap-2 rounded-xl border bg-card p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring">
            <div className="min-w-0 flex-1">
              <textarea
                rows={1}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder="Ask Cantrip to work on this repository…"
                className="max-h-48 min-h-10 w-full resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted-foreground"
              />
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
                      {model.providerName} / {model.name}
                      {model.reasoningEffort
                        ? ` (${model.reasoningEffort})`
                        : ""}
                    </option>
                  ))}
                </select>
                <span className="text-[11px] text-muted-foreground">
                  Applies to the next message
                </span>
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
                chat.status === "running"
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
          {send.isError || selectModel.isError ? (
            <p className="mt-2 text-xs text-destructive">
              {errorText(send.error ?? selectModel.error)}
            </p>
          ) : (
            <p className="mt-2 text-center text-[11px] text-muted-foreground">
              Enter to send · Shift+Enter for a new line
            </p>
          )}
        </div>
      </form>
    </div>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(
    null,
  );
  const [showImporter, setShowImporter] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [gitHistoryProjectId, setGitHistoryProjectId] = useState<string | null>(
    null,
  );

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
  const projects = useQuery({ queryFn: getProjects, queryKey: ["projects"] });
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
  const newChat = useMutation({
    mutationFn: (projectId: string) => createChat(projectId, "New chat"),
    onSuccess: async (chat) => {
      await queryClient.invalidateQueries({
        queryKey: ["chats", chat.projectId],
      });
      setSelectedTerminalId(null);
      setSelectedChatId(chat.id);
    },
  });
  const newTerminal = useMutation({
    mutationFn: (projectId: string) => createTerminal(projectId, "Terminal"),
    onSuccess: async (terminal) => {
      await queryClient.invalidateQueries({
        queryKey: ["terminals", terminal.projectId],
      });
      setSelectedProjectId(terminal.projectId);
      setSelectedChatId(null);
      setSelectedTerminalId(terminal.id);
      setGitHistoryProjectId(null);
      setShowImporter(false);
      setShowSettings(false);
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
      }
      if (gitHistoryProjectId === projectId) setGitHistoryProjectId(null);
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
      await Promise.all([
        queryClient.cancelQueries({ queryKey: chatKey }),
        queryClient.cancelQueries({ queryKey: terminalKey }),
      ]);
      const previousChats = queryClient.getQueryData<ChatSummary[]>(chatKey);
      const previousTerminals =
        queryClient.getQueryData<TerminalSummary[]>(terminalKey);
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
      return { chatKey, terminalKey, previousChats, previousTerminals };
    },
    onError: (_error, _input, context) => {
      queryClient.setQueryData(context?.chatKey ?? [], context?.previousChats);
      queryClient.setQueryData(
        context?.terminalKey ?? [],
        context?.previousTerminals,
      );
    },
    onSettled: (_data, _error, input) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["chats", input.projectId] }),
        queryClient.invalidateQueries({
          queryKey: ["terminals", input.projectId],
        }),
      ]),
  });

  const onlineWorker = workers.data?.find((worker) => worker.online) ?? null;
  const selectedProject = projects.data?.find(
    (project) => project.id === selectedProjectId,
  );
  const gitHistoryProject = projects.data?.find(
    (project) => project.id === gitHistoryProjectId,
  );
  const selectedChat = chats.data?.find((chat) => chat.id === selectedChatId);
  const selectedTerminal = terminals.data?.find(
    (terminal) => terminal.id === selectedTerminalId,
  );
  useEffect(() => {
    const preference = settings.data?.preferences.theme ?? "system";
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark =
        preference === "dark" || (preference === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };
    apply();
    if (preference === "system") {
      media.addEventListener("change", apply);
      return () => media.removeEventListener("change", apply);
    }
  }, [settings.data?.preferences.theme]);

  useEffect(() => {
    if (showImporter || showSettings) setGitHistoryProjectId(null);
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
    if (!chats.data || !terminals.data) return;
    if (chats.data.some((chat) => chat.id === selectedChatId)) return;
    if (terminals.data.some((terminal) => terminal.id === selectedTerminalId))
      return;
    setSelectedChatId(chats.data[0]?.id ?? null);
    setSelectedTerminalId(
      chats.data[0] ? null : (terminals.data[0]?.id ?? null),
    );
  }, [chats.data, selectedChatId, selectedTerminalId, terminals.data]);

  return (
    <main className="flex h-svh overflow-hidden bg-background text-foreground">
      <aside className="hidden w-72 shrink-0 flex-col border-r bg-card/40 md:flex">
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
            projects={projects.data ?? []}
            chats={chats.data ?? []}
            terminals={terminals.data ?? []}
            selectedProjectId={selectedProjectId}
            selectedChatId={selectedChatId}
            selectedTerminalId={selectedTerminalId}
            gitHistoryProjectId={gitHistoryProjectId}
            creatingChat={newChat.isPending}
            creatingTerminal={newTerminal.isPending}
            onCreateChat={(projectId) => newChat.mutate(projectId)}
            onCreateTerminal={(projectId) => newTerminal.mutate(projectId)}
            onRenameChat={(chatId, title) =>
              renameChatMutation.mutate({ chatId, title })
            }
            onDuplicateChat={(chatId) => forkChatMutation.mutate(chatId)}
            onDeleteChat={(chatId) => deleteChatMutation.mutate(chatId)}
            onRenameTerminal={(terminalId, title) =>
              renameTerminalMutation.mutate({ terminalId, title })
            }
            onDeleteTerminal={(terminalId) =>
              deleteTerminalMutation.mutate(terminalId)
            }
            onOpenGitHistory={(projectId) => {
              setSelectedProjectId(projectId);
              setGitHistoryProjectId(projectId);
              setShowImporter(false);
              setShowSettings(false);
            }}
            onRemoveProject={(projectId, deleteLocalFiles) =>
              removeProjectMutation.mutate({ projectId, deleteLocalFiles })
            }
            onReorderProjects={(ids) => reorderProjectsMutation.mutate(ids)}
            onReorderTabs={(projectId, ids) =>
              reorderTabsMutation.mutate({ projectId, ids })
            }
            onSelectProject={(projectId) => {
              setGitHistoryProjectId(null);
              setSelectedProjectId(projectId);
              setSelectedChatId(null);
              setSelectedTerminalId(null);
              setShowImporter(false);
              setShowSettings(false);
            }}
            onSelectChat={(chatId) => {
              setGitHistoryProjectId(null);
              setSelectedTerminalId(null);
              setSelectedChatId(chatId);
              setShowImporter(false);
              setShowSettings(false);
            }}
            onSelectTerminal={(terminalId) => {
              setGitHistoryProjectId(null);
              setSelectedChatId(null);
              setSelectedTerminalId(terminalId);
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

      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b px-4 sm:px-6">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {showImporter
                ? "GitHub repositories"
                : showSettings
                  ? "Settings"
                  : gitHistoryProject
                    ? "Git history"
                    : selectedTerminal
                      ? selectedTerminal.title
                      : (selectedProject?.github?.nameWithOwner ?? "Cantrip")}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {showImporter
                ? "Add a worker-owned source"
                : showSettings
                  ? "Account preferences"
                  : gitHistoryProject
                    ? (gitHistoryProject.github?.nameWithOwner ??
                      gitHistoryProject.name)
                    : selectedTerminal
                      ? (selectedProject?.source?.displayPath ?? "Terminal")
                      : (selectedProject?.source?.displayPath ??
                        "Choose a project to begin")}
            </p>
          </div>
          <div className="flex items-center gap-2 md:hidden">
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setMobileNavigationOpen(true)}
            >
              <PanelLeft className="size-4" />
              <span className="sr-only">Open projects and chats</span>
            </Button>
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
          </div>
          {!showImporter && !showSettings && selectedProject ? (
            <Badge variant="outline" className="hidden gap-2 sm:flex">
              <StatusDot online={Boolean(onlineWorker)} />
              {onlineWorker?.name ?? "Worker offline"}
            </Badge>
          ) : null}
        </header>

        {showSettings ? (
          <SettingsPage onClose={() => setShowSettings(false)} />
        ) : showImporter ? (
          <RepositoryImporter
            workerId={onlineWorker?.workerId ?? null}
            onClose={() => setShowImporter(false)}
            onImported={(project) => {
              setSelectedProjectId(project.id);
              setSelectedChatId(null);
              setShowImporter(false);
              setShowSettings(false);
            }}
          />
        ) : gitHistoryProject ? (
          <GitHistoryView
            project={gitHistoryProject}
            onClose={() => setGitHistoryProjectId(null)}
          />
        ) : selectedTerminal ? (
          <Suspense
            fallback={
              <div className="grid flex-1 place-items-center text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
              </div>
            }
          >
            <TerminalView terminal={selectedTerminal} />
          </Suspense>
        ) : selectedChat ? (
          <ChatTranscript
            chat={selectedChat}
            settings={settings.data}
            onForked={(forked) => {
              setSelectedProjectId(forked.projectId);
              setSelectedTerminalId(null);
              setSelectedChatId(forked.id);
            }}
          />
        ) : selectedProject ? (
          <div className="grid flex-1 place-items-center p-6 text-center">
            <div>
              <div className="mx-auto grid size-12 place-items-center rounded-2xl border bg-card">
                <SquareTerminal className="size-5" />
              </div>
              <h1 className="mt-4 font-semibold">No tabs yet</h1>
              <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                Start a Codex chat or a shell rooted in {selectedProject.name}.
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
              </div>
              {newChat.isError ? (
                <p className="mt-3 text-xs text-destructive">
                  {errorText(newChat.error)}
                </p>
              ) : null}
            </div>
          </div>
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
              projects={projects.data ?? []}
              chats={chats.data ?? []}
              terminals={terminals.data ?? []}
              selectedProjectId={selectedProjectId}
              selectedChatId={selectedChatId}
              selectedTerminalId={selectedTerminalId}
              gitHistoryProjectId={gitHistoryProjectId}
              creatingChat={newChat.isPending}
              creatingTerminal={newTerminal.isPending}
              onCreateChat={(projectId) => newChat.mutate(projectId)}
              onCreateTerminal={(projectId) => newTerminal.mutate(projectId)}
              onRenameChat={(chatId, title) =>
                renameChatMutation.mutate({ chatId, title })
              }
              onDuplicateChat={(chatId) => forkChatMutation.mutate(chatId)}
              onDeleteChat={(chatId) => deleteChatMutation.mutate(chatId)}
              onRenameTerminal={(terminalId, title) =>
                renameTerminalMutation.mutate({ terminalId, title })
              }
              onDeleteTerminal={(terminalId) =>
                deleteTerminalMutation.mutate(terminalId)
              }
              onOpenGitHistory={(projectId) => {
                setSelectedProjectId(projectId);
                setGitHistoryProjectId(projectId);
                setMobileNavigationOpen(false);
                setShowImporter(false);
                setShowSettings(false);
              }}
              onRemoveProject={(projectId, deleteLocalFiles) => {
                removeProjectMutation.mutate({ projectId, deleteLocalFiles });
                setMobileNavigationOpen(false);
              }}
              onReorderProjects={(ids) => reorderProjectsMutation.mutate(ids)}
              onReorderTabs={(projectId, ids) =>
                reorderTabsMutation.mutate({ projectId, ids })
              }
              onSelectProject={(projectId) => {
                setGitHistoryProjectId(null);
                setSelectedProjectId(projectId);
                setSelectedChatId(null);
                setSelectedTerminalId(null);
              }}
              onSelectChat={(chatId) => {
                setGitHistoryProjectId(null);
                setSelectedTerminalId(null);
                setSelectedChatId(chatId);
                setMobileNavigationOpen(false);
                setShowImporter(false);
                setShowSettings(false);
              }}
              onSelectTerminal={(terminalId) => {
                setGitHistoryProjectId(null);
                setSelectedChatId(null);
                setSelectedTerminalId(terminalId);
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
