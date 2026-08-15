import type {
  ChatImportCreate,
  ChatImportJobSummary,
  ProjectSummary,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  Download,
  HardDrive,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  createChatImports,
  getChatImports,
  getExternalChatHistory,
  getSettings,
  retryChatImport,
} from "@/lib/api";
import { useAppLiveStatus } from "@/lib/app-live-react";
import { errorMessage } from "@/lib/error-message";
import { cn } from "@/lib/utils";

import {
  chatImportIdempotencyKey,
  externalChatImportCandidates,
  externalChatWorktreeLabel,
  filterExternalChatImportCandidates,
  mergeChatImportJobs,
  readyChatImportModels,
  selectableExternalChatCandidateKeys,
  summarizeChatImportJobs,
} from "./external-chat-import-model";
import {
  ExternalChatCandidateRow,
  ImportJobRow,
} from "./external-chat-import-rows";

export function ExternalChatImportSettings({
  desktopRuntime,
  onOpenChat,
  project,
  workers,
  worktrees,
}: {
  desktopRuntime: boolean;
  onOpenChat(chatId: string): void;
  project: ProjectSummary;
  workers: Array<{ name: string; workerId: string }>;
  worktrees: ProjectWorktreeSummary[];
}) {
  const queryClient = useQueryClient();
  const liveStatus = useAppLiveStatus();
  const [open, setOpen] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [destinationWorktreeId, setDestinationWorktreeId] =
    useState("automatic");
  const [modelId, setModelId] = useState("");
  const [routeId, setRouteId] = useState("automatic");
  const [accountId, setAccountId] = useState("automatic");
  const [permissionProfileId, setPermissionProfileId] = useState(":workspace");
  const [planMode, setPlanMode] = useState<"default" | "plan">("default");
  const [consented, setConsented] = useState(false);

  const discovery = useQuery({
    enabled: desktopRuntime,
    queryFn: () => getExternalChatHistory(project.id, includeArchived),
    queryKey: ["external-chat-history", project.id, includeArchived],
    retry: false,
    staleTime: 30_000,
  });
  const jobs = useQuery({
    enabled: desktopRuntime,
    queryFn: () => getChatImports(project.id),
    queryKey: ["chat-import-jobs", project.id],
    refetchInterval: liveStatus === "live" ? false : 2_000,
    retry: false,
  });
  const settings = useQuery({
    enabled: desktopRuntime && open,
    queryFn: getSettings,
    queryKey: ["settings"],
  });

  const candidates = useMemo(
    () => externalChatImportCandidates(discovery.data, jobs.data),
    [discovery.data, jobs.data],
  );
  const visibleCandidates = useMemo(
    () => filterExternalChatImportCandidates(candidates, search),
    [candidates, search],
  );
  const selectedCandidates = candidates
    .filter(({ key }) => selectedKeys.has(key))
    .slice(0, 50);
  const selectableVisibleKeys =
    selectableExternalChatCandidateKeys(visibleCandidates);
  const readyWorktrees = worktrees.filter(
    ({ lifecycleState }) => lifecycleState === "ready",
  );
  const workersById = new Map(
    workers.map(({ name, workerId }) => [workerId, name]),
  );
  const models = readyChatImportModels(settings.data);
  const selectedModel = models.find(({ id }) => id === modelId) ?? null;
  const routes = selectedModel?.routes.filter(({ enabled }) => enabled) ?? [];
  const selectedRoute = routes.find(({ id }) => id === routeId) ?? null;
  const selectedProvider = settings.data?.providers.find(
    ({ id }) => id === selectedRoute?.providerId,
  );
  const accounts =
    selectedProvider?.accounts.filter(({ enabled }) => enabled) ?? [];
  const recentJobs = [...(jobs.data ?? [])].reverse().slice(0, 20);
  const summary = summarizeChatImportJobs(jobs.data ?? []);
  const sourceMessages =
    discovery.data?.workers.flatMap((worker) => [
      ...(worker.error ? [worker.error.message] : []),
      ...worker.sources.flatMap((source) =>
        source.message ? [`${worker.workerName}: ${source.message}`] : [],
      ),
    ]) ?? [];
  const hasSupportedSource = Boolean(
    discovery.data?.workers.some(
      (worker) => worker.status !== "unsupported" || worker.sources.length > 0,
    ),
  );

  useEffect(() => {
    if (!open || !settings.data || modelId) return;
    const available = readyChatImportModels(settings.data);
    const preferred = available.find(
      ({ id }) => id === settings.data.preferences.defaultModelId,
    );
    setModelId(preferred?.id ?? available[0]?.id ?? "");
  }, [modelId, open, settings.data]);

  useEffect(() => {
    setOpen(false);
    setIncludeArchived(false);
    setSearch("");
    setSelectedKeys(new Set());
    setDestinationWorktreeId("automatic");
    setModelId("");
    setRouteId("automatic");
    setAccountId("automatic");
    setPermissionProfileId(":workspace");
    setPlanMode("default");
    setConsented(false);
  }, [project.id]);

  const createImports = useMutation({
    mutationFn: () => {
      const target =
        destinationWorktreeId === "automatic"
          ? undefined
          : {
              kind: "worktree" as const,
              projectId: project.id,
              worktreeId: destinationWorktreeId,
            };
      const input: ChatImportCreate = {
        imports: selectedCandidates.map((candidate) => ({
          sourceKind: candidate.source.kind,
          sourceWorkerId: candidate.sourceWorkerId,
          sourceId: candidate.source.sourceId,
          sourceThreadId: candidate.thread.sourceThreadId,
          idempotencyKey: chatImportIdempotencyKey(candidate),
          target,
          modelId,
          modelRouteId: routeId === "automatic" ? null : routeId,
          providerAccountId: accountId === "automatic" ? null : accountId,
          permissionProfileId,
          planMode,
        })),
      };
      return createChatImports(project.id, input);
    },
    onSuccess: (created) => {
      queryClient.setQueryData<ChatImportJobSummary[]>(
        ["chat-import-jobs", project.id],
        (current) => mergeChatImportJobs(current, created),
      );
      setSelectedKeys(new Set());
      setConsented(false);
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: ["chat-import-jobs", project.id],
      }),
  });
  const retry = useMutation({
    mutationFn: (job: ChatImportJobSummary) =>
      retryChatImport(job.id, { stateRevision: job.stateRevision }),
    onSuccess: (updated) => {
      queryClient.setQueryData<ChatImportJobSummary[]>(
        ["chat-import-jobs", project.id],
        (current) => mergeChatImportJobs(current, [updated]),
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: ["chat-import-jobs", project.id],
      }),
  });

  if (!desktopRuntime) return null;
  if (
    !discovery.isLoading &&
    !discovery.isError &&
    discovery.data &&
    !hasSupportedSource
  ) {
    return null;
  }

  const allVisibleSelected =
    selectableVisibleKeys.length > 0 &&
    selectableVisibleKeys.every((key) => selectedKeys.has(key));
  const importError = createImports.error ?? retry.error;
  const importDisabled =
    selectedCandidates.length === 0 ||
    selectedCandidates.length > 50 ||
    !consented ||
    !selectedModel ||
    (destinationWorktreeId !== "automatic" &&
      !readyWorktrees.some(({ id }) => id === destinationWorktreeId)) ||
    (routeId !== "automatic" && !selectedRoute) ||
    (accountId !== "automatic" &&
      !accounts.some(({ id }) => id === accountId)) ||
    createImports.isPending;

  return (
    <>
      <section aria-labelledby="external-codex-history-title">
        <div className="mb-3">
          <h2 id="external-codex-history-title" className="font-semibold">
            ChatGPT Codex
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Continue compatible chats found by your desktop workers.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 border-y px-4 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="rounded-lg bg-muted p-2.5">
              {discovery.isLoading || discovery.isFetching ? (
                <Loader2 className="size-5 animate-spin" />
              ) : candidates.length ? (
                <Check className="size-5 text-emerald-500" />
              ) : (
                <HardDrive className="size-5" />
              )}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {discovery.isLoading
                  ? "Looking for ChatGPT Codex history…"
                  : discovery.isError
                    ? "Codex history could not be checked"
                    : candidates.length
                      ? "ChatGPT Codex found"
                      : "No matching Codex chats found"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {discovery.isError
                  ? errorMessage(discovery.error)
                  : candidates.length
                    ? `${candidates.length} chat${candidates.length === 1 ? "" : "s"} match this project${summary.succeeded ? ` · ${summary.succeeded} imported` : ""}`
                    : (sourceMessages[0] ??
                      "No safe root chats currently match this project.")}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={discovery.isFetching}
              onClick={() => void discovery.refetch()}
            >
              <RefreshCw
                className={cn("size-4", discovery.isFetching && "animate-spin")}
              />
              Refresh
            </Button>
            <Button
              size="sm"
              disabled={discovery.isLoading}
              onClick={() => setOpen(true)}
            >
              <Download className="size-4" />
              {candidates.length ? "Import chats" : "Browse chats"}
            </Button>
          </div>
        </div>
      </section>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-5xl gap-4">
          <DialogHeader>
            <DialogTitle>Import ChatGPT Codex chats</DialogTitle>
            <DialogDescription>
              Choose chats to copy into Cantrip. The originals remain untouched;
              Cantrip stores a canonical history copy and creates a new managed
              Codex thread for future messages. Credentials and authentication
              files are never copied.
            </DialogDescription>
          </DialogHeader>

          {sourceMessages.length || discovery.data?.truncated ? (
            <div className="flex gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              <span>
                {sourceMessages.slice(0, 3).join(" ")}
                {discovery.data?.truncated
                  ? " The available history list was truncated; refine the source or refresh after reducing its size."
                  : ""}
              </span>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-56 flex-1">
              <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
              <Input
                aria-label="Search matching Codex chats"
                className="pl-9"
                placeholder="Search chats, workers, paths, or branches"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <label className="flex h-9 items-center gap-2 rounded-md border px-3 text-xs">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(event) => {
                  setIncludeArchived(event.target.checked);
                  setSelectedKeys(new Set());
                }}
              />
              Include archived
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={!selectableVisibleKeys.length}
              onClick={() =>
                setSelectedKeys((current) => {
                  const next = new Set(current);
                  if (allVisibleSelected) {
                    for (const key of selectableVisibleKeys) next.delete(key);
                  } else {
                    for (const key of selectableVisibleKeys) {
                      if (next.size >= 50) break;
                      next.add(key);
                    }
                  }
                  return next;
                })
              }
            >
              {allVisibleSelected ? "Clear visible" : "Select visible"}
            </Button>
          </div>

          <div className="max-h-[min(42vh,28rem)] overflow-y-auto border-y">
            <div className="divide-y">
              {visibleCandidates.map((candidate) => (
                <ExternalChatCandidateRow
                  key={candidate.key}
                  candidate={candidate}
                  checked={selectedKeys.has(candidate.key)}
                  disabled={
                    Boolean(candidate.existingJob) ||
                    (!selectedKeys.has(candidate.key) &&
                      selectedKeys.size >= 50)
                  }
                  matchedWorktreeLabel={
                    worktrees.find(
                      ({ id }) => id === candidate.thread.match.worktreeId,
                    )?.name ??
                    (candidate.thread.match.kind === "git-origin"
                      ? "Matched by Git origin"
                      : "Project replica")
                  }
                  onCheckedChange={(checked) =>
                    setSelectedKeys((current) => {
                      const next = new Set(current);
                      if (checked && next.size < 50) next.add(candidate.key);
                      else next.delete(candidate.key);
                      return next;
                    })
                  }
                />
              ))}
              {!visibleCandidates.length ? (
                <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                  {discovery.isFetching
                    ? "Refreshing Codex history…"
                    : search
                      ? `No chats match “${search.trim()}”.`
                      : "No matching chats are available."}
                </div>
              ) : null}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1.5 text-xs font-medium">
              Destination
              <select
                className="h-9 rounded-md border bg-transparent px-3 text-sm"
                value={destinationWorktreeId}
                onChange={(event) =>
                  setDestinationWorktreeId(event.target.value)
                }
              >
                <option value="automatic">Automatic server placement</option>
                {readyWorktrees.map((worktree) => (
                  <option key={worktree.id} value={worktree.id}>
                    {externalChatWorktreeLabel(worktree, workersById)}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-xs font-medium">
              Cantrip model for future messages
              <select
                className="h-9 rounded-md border bg-transparent px-3 text-sm"
                value={modelId}
                onChange={(event) => {
                  setModelId(event.target.value);
                  setRouteId("automatic");
                  setAccountId("automatic");
                }}
              >
                {!models.length ? (
                  <option value="">No model is configured</option>
                ) : null}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-xs font-medium">
              Provider route
              <select
                className="h-9 rounded-md border bg-transparent px-3 text-sm"
                value={routeId}
                disabled={!selectedModel}
                onChange={(event) => {
                  setRouteId(event.target.value);
                  setAccountId("automatic");
                }}
              >
                <option value="automatic">Automatic route</option>
                {routes.map((route) => (
                  <option key={route.id} value={route.id}>
                    {route.providerName} · {route.modelName}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-xs font-medium">
              Provider account
              <select
                className="h-9 rounded-md border bg-transparent px-3 text-sm"
                value={accountId}
                disabled={!selectedRoute || !accounts.length}
                onChange={(event) => setAccountId(event.target.value)}
              >
                <option value="automatic">Automatic account</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.label}
                    {account.email ? ` · ${account.email}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-xs font-medium">
              Permissions
              <select
                className="h-9 rounded-md border bg-transparent px-3 text-sm"
                value={permissionProfileId}
                onChange={(event) => setPermissionProfileId(event.target.value)}
              >
                <option value=":workspace">Workspace access</option>
                <option value=":read-only">Read only</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-xs font-medium">
              Conversation mode
              <select
                className="h-9 rounded-md border bg-transparent px-3 text-sm"
                value={planMode}
                onChange={(event) =>
                  setPlanMode(event.target.value as "default" | "plan")
                }
              >
                <option value="default">Default</option>
                <option value="plan">Plan mode</option>
              </select>
            </label>
          </div>

          {settings.isSuccess && !models.length ? (
            <p className="flex gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <CircleAlert className="size-4 shrink-0" />
              Configure a model in App Settings → Models before importing.
            </p>
          ) : null}

          <label className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-xs leading-5">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0"
              checked={consented}
              onChange={(event) => setConsented(event.target.checked)}
            />
            <span>
              I understand the selected transcript history and safe available
              attachments will be copied from the source worker to this Cantrip
              server. Only selected chats are read in full.
            </span>
          </label>

          {importError ? (
            <p className="flex gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <CircleAlert className="size-4 shrink-0" />
              {errorMessage(importError)}
            </p>
          ) : null}

          {recentJobs.length ? (
            <section aria-labelledby="chat-import-activity-title">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3
                  id="chat-import-activity-title"
                  className="text-sm font-semibold"
                >
                  Import activity
                </h3>
                <p className="text-[10px] text-muted-foreground">
                  {summary.active} active · {summary.succeeded} ready ·{" "}
                  {summary.failed} needs attention
                </p>
              </div>
              <div className="max-h-48 divide-y overflow-y-auto border-y">
                {recentJobs.map((job) => (
                  <ImportJobRow
                    key={job.id}
                    job={job}
                    pendingRetry={
                      retry.isPending && retry.variables?.id === job.id
                    }
                    title={
                      candidates.find(
                        (candidate) =>
                          candidate.sourceWorkerId === job.sourceWorkerId &&
                          candidate.source.sourceId === job.sourceId &&
                          candidate.thread.sourceThreadId ===
                            job.sourceThreadId,
                      )?.thread.title
                    }
                    onOpenChat={onOpenChat}
                    onRetry={(target) => retry.mutate(target)}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <DialogFooter className="items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">
              {selectedCandidates.length} selected · maximum 50 per import
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>
                Close
              </Button>
              <Button
                disabled={importDisabled}
                onClick={() => createImports.mutate()}
              >
                {createImports.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Download className="size-4" />
                )}
                Import {selectedCandidates.length || "selected"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
