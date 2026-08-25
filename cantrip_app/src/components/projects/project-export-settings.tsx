import type {
  ChatSummary,
  ProjectExportResult,
  ProjectSummary,
  ProjectWorktreeSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowUpFromLine,
  Check,
  CircleAlert,
  ExternalLink,
  FolderGit2,
  Loader2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { createProjectExport, previewProjectExport } from "@/lib/api";
import { ensureChatWorkerEncryption } from "@/lib/chat-worker-encryption";
import { openCodexThread } from "@/lib/codex-deep-link";
import { listDesktopWorkers } from "@/lib/desktop-worker";
import { ensurePrivateLabelWorkerEncryption } from "@/lib/private-label-worker-encryption";
import { getActiveServerUrl } from "@/lib/server-connections";
import { cn } from "@/lib/utils";

const DEFAULT_MAX_CHATS = 20;

function normalizedServerUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "").toLowerCase();
}

function defaultWorktreeId(worktrees: ProjectWorktreeSummary[]): string {
  const ready = worktrees.filter(
    (worktree) => worktree.lifecycleState === "ready",
  );
  return (
    ready.find((worktree) => worktree.isPrimary)?.id ??
    ready.find((worktree) => worktree.isDefault)?.id ??
    ready[0]?.id ??
    ""
  );
}

export function ProjectExportSettings({
  chats,
  desktopRuntime,
  project,
  workers,
  worktrees,
}: {
  chats: ChatSummary[];
  desktopRuntime: boolean;
  project: ProjectSummary;
  workers: WorkerSummary[];
  worktrees: ProjectWorktreeSummary[];
}) {
  const [open, setOpen] = useState(false);
  const [worktreeId, setWorktreeId] = useState(() =>
    defaultWorktreeId(worktrees),
  );
  const [selectedChatIds, setSelectedChatIds] = useState<Set<string>>(
    new Set(),
  );
  const [result, setResult] = useState<ProjectExportResult | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const exportOperationId = useRef(crypto.randomUUID());
  const readyWorktrees = useMemo(
    () => worktrees.filter((worktree) => worktree.lifecycleState === "ready"),
    [worktrees],
  );
  const selectedWorktree = readyWorktrees.find(
    (worktree) => worktree.id === worktreeId,
  );
  const selectedWorker = workers.find(
    (worker) => worker.workerId === selectedWorktree?.workerId,
  );
  const eligibleChats = chats.filter(
    (chat) =>
      chat.experience === "agent" &&
      chat.status !== "running" &&
      chat.status !== "waiting-for-approval",
  );
  const preview = useQuery({
    enabled: open && Boolean(worktreeId) && !result,
    queryFn: () =>
      previewProjectExport(project.id, {
        target: { kind: "codex-local" },
        worktreeId,
      }),
    queryKey: ["project-export-preview", project.id, worktreeId],
    retry: false,
  });
  const desktopWorkers = useQuery({
    enabled: desktopRuntime && Boolean(result),
    queryFn: listDesktopWorkers,
    queryKey: ["desktop-workers"],
    retry: false,
  });
  const maximum = preview.data?.maxChats ?? DEFAULT_MAX_CHATS;
  const successful =
    result?.outcomes.filter((outcome) => outcome.status === "exported") ?? [];
  const failed =
    result?.outcomes.filter((outcome) => outcome.status === "failed") ?? [];
  const localExportWorker = Boolean(
    result &&
    desktopWorkers.data?.some(
      (worker) =>
        worker.running &&
        worker.workerId === result.workerId &&
        normalizedServerUrl(worker.serverUrl) ===
          normalizedServerUrl(getActiveServerUrl()),
    ),
  );

  useEffect(() => {
    exportOperationId.current = crypto.randomUUID();
    setOpen(false);
    setWorktreeId(defaultWorktreeId(worktrees));
    setSelectedChatIds(new Set());
    setResult(null);
    setOpenError(null);
  }, [project.id]);

  useEffect(() => {
    setWorktreeId((current) =>
      readyWorktrees.some(({ id }) => id === current)
        ? current
        : defaultWorktreeId(readyWorktrees),
    );
  }, [readyWorktrees]);

  const createExport = useMutation({
    mutationFn: async () => {
      if (!selectedWorker) throw new Error("Select an available worktree.");
      const encryptionWorker = {
        encryption: selectedWorker.encryption,
        online: selectedWorker.online,
        workerId: selectedWorker.workerId,
      };
      await ensurePrivateLabelWorkerEncryption({ worker: encryptionWorker });
      await ensureChatWorkerEncryption({ worker: encryptionWorker });
      return createProjectExport(project.id, {
        operationId: exportOperationId.current,
        target: { kind: "codex-local" },
        worktreeId,
        chatIds: [...selectedChatIds],
      });
    },
    onSuccess: (next) => setResult(next),
  });

  const resetDialog = () => {
    exportOperationId.current = crypto.randomUUID();
    setSelectedChatIds(new Set());
    setResult(null);
    setOpenError(null);
    createExport.reset();
  };

  const setDialogOpen = (next: boolean) => {
    setOpen(next);
    if (next) resetDialog();
  };

  return (
    <>
      <section aria-labelledby="project-export-title">
        <div className="mb-3">
          <h2 id="project-export-title" className="font-semibold">
            Export project
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Continue this project and selected conversations in another system.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 border-y px-4 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="rounded-lg bg-muted p-2.5">
              <FolderGit2 className="size-5" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium">Codex</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Use an existing Cantrip worktree as a Codex project and create
                fresh native threads from selected chats.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            disabled={!readyWorktrees.length}
            onClick={() => setDialogOpen(true)}
          >
            <ArrowUpFromLine className="size-4" />
            Export to Codex
          </Button>
        </div>
      </section>

      <Dialog open={open} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-4xl gap-4">
          <DialogHeader>
            <DialogTitle>
              {result ? "Codex export report" : "Export project to Codex"}
            </DialogTitle>
            <DialogDescription>
              {result
                ? "Cantrip verified each newly created native Codex thread before reporting success."
                : "Choose the existing project folder Codex should use, then select the conversations to recreate there."}
            </DialogDescription>
          </DialogHeader>

          {result ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg bg-muted/45 p-4">
                  <p className="text-sm font-medium">
                    {successful.length} exported
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {failed.length
                      ? `${failed.length} failed without changing existing Codex threads.`
                      : "All selected chats are available as new Codex threads."}
                  </p>
                </div>
                <div className="rounded-lg bg-muted/45 p-4">
                  <p className="text-sm font-medium">
                    {preview.data?.worktree.name ?? selectedWorktree?.name}
                  </p>
                  <p className="mt-1 break-all text-xs text-muted-foreground">
                    {preview.data?.worktree.displayPath ??
                      selectedWorktree?.displayPath}
                  </p>
                </div>
              </div>
              <div className="divide-y border-y">
                {result.outcomes.map((outcome) => {
                  const chat = chats.find(({ id }) => id === outcome.chatId);
                  return (
                    <div
                      key={outcome.chatId}
                      className="flex items-start justify-between gap-3 px-3 py-3"
                    >
                      <div className="flex min-w-0 items-start gap-2">
                        {outcome.status === "exported" ? (
                          <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                        ) : (
                          <X className="mt-0.5 size-4 shrink-0 text-destructive" />
                        )}
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {chat?.title ?? "Cantrip chat"}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {outcome.status === "exported"
                              ? `${outcome.messageCount} messages${outcome.reused ? " · existing export reused" : ""}`
                              : outcome.message}
                          </p>
                        </div>
                      </div>
                      {outcome.status === "exported" && localExportWorker ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setOpenError(null);
                            void openCodexThread(outcome.threadId).catch(
                              (error: unknown) =>
                                setOpenError(
                                  error instanceof Error
                                    ? error.message
                                    : "Could not open Codex.",
                                ),
                            );
                          }}
                        >
                          <ExternalLink className="size-4" />
                          Open
                        </Button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {successful.length > 0 && !localExportWorker ? (
                <p className="rounded-lg bg-muted/45 px-3 py-2 text-xs text-muted-foreground">
                  Open Codex on{" "}
                  {preview.data?.worker.name ?? "the export worker"}. The
                  exported project uses the selected folder above.
                </p>
              ) : null}
              {openError ? (
                <p className="flex gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <CircleAlert className="size-4 shrink-0" />
                  {openError}
                </p>
              ) : null}
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Close
                </Button>
                <Button onClick={resetDialog}>Export more chats</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <label className="grid gap-1.5 text-xs font-medium">
                Existing project folder
                <NativeSelect
                  value={worktreeId}
                  onChange={(event) => {
                    setWorktreeId(event.target.value);
                    setSelectedChatIds(new Set());
                  }}
                >
                  {readyWorktrees.map((worktree) => {
                    const worker = workers.find(
                      ({ workerId }) => workerId === worktree.workerId,
                    );
                    return (
                      <option key={worktree.id} value={worktree.id}>
                        {worktree.name} · {worker?.name ?? worktree.workerId}
                      </option>
                    );
                  })}
                </NativeSelect>
              </label>

              <div
                className={cn(
                  "rounded-lg bg-muted/45 p-3 text-xs text-muted-foreground",
                  preview.data &&
                    !preview.data.available &&
                    "bg-destructive/10 text-destructive",
                )}
              >
                {preview.isLoading ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin" />
                    Checking Codex on the selected worker…
                  </span>
                ) : preview.isError ? (
                  "Cantrip could not inspect Codex on this worker."
                ) : preview.data?.available ? (
                  `Ready to create native threads in ${preview.data.destinationLabel}. The project folder itself will not be copied.`
                ) : (
                  (preview.data?.message ?? "Choose a ready worktree.")
                )}
              </div>

              {preview.data ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <section className="rounded-lg border p-3">
                    <h3 className="text-xs font-semibold">Preserved</h3>
                    <ul className="mt-2 space-y-2">
                      {preview.data.preserves.map((item) => (
                        <li key={item.id} className="text-xs">
                          <span className="font-medium">{item.label}</span>
                          <span className="mt-0.5 block text-muted-foreground">
                            {item.description}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                  <section className="rounded-lg border p-3">
                    <h3 className="text-xs font-semibold">
                      Flattened or omitted
                    </h3>
                    <ul className="mt-2 space-y-2">
                      {preview.data.flattens.map((item) => (
                        <li key={item.id} className="text-xs">
                          <span className="font-medium">{item.label}</span>
                          <span className="mt-0.5 block text-muted-foreground">
                            {item.description}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                </div>
              ) : null}

              <section aria-labelledby="project-export-chats-title">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3
                    id="project-export-chats-title"
                    className="text-sm font-semibold"
                  >
                    Chats
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {selectedChatIds.size} selected · maximum {maximum}
                  </p>
                </div>
                <div className="max-h-72 divide-y overflow-y-auto border-y">
                  {chats.map((chat) => {
                    const eligible = eligibleChats.some(
                      (candidate) => candidate.id === chat.id,
                    );
                    const selected = selectedChatIds.has(chat.id);
                    const reason =
                      chat.experience === "task"
                        ? "Tasks are not supported yet"
                        : !eligible
                          ? "Wait for this chat to finish"
                          : null;
                    return (
                      <label
                        key={chat.id}
                        className={cn(
                          "flex items-center gap-3 px-3 py-2.5 text-sm",
                          eligible ? "cursor-pointer" : "opacity-55",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={
                            !eligible ||
                            (!selected && selectedChatIds.size >= maximum)
                          }
                          onChange={(event) =>
                            setSelectedChatIds((current) => {
                              const next = new Set(current);
                              if (event.target.checked && next.size < maximum) {
                                next.add(chat.id);
                              } else {
                                next.delete(chat.id);
                              }
                              return next;
                            })
                          }
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {chat.title}
                        </span>
                        {reason ? (
                          <span className="text-[10px] text-muted-foreground">
                            {reason}
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                  {!chats.length ? (
                    <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                      This project has no chats to export.
                    </p>
                  ) : null}
                </div>
              </section>

              {createExport.isError ? (
                <p className="flex gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <CircleAlert className="size-4 shrink-0" />
                  {createExport.error instanceof Error
                    ? createExport.error.message
                    : "The export could not be started."}
                </p>
              ) : null}

              <DialogFooter className="items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">
                  Existing Codex projects and threads are never modified.
                </p>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    disabled={
                      !preview.data?.available ||
                      !selectedChatIds.size ||
                      createExport.isPending
                    }
                    onClick={() => createExport.mutate()}
                  >
                    {createExport.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ArrowUpFromLine className="size-4" />
                    )}
                    Export {selectedChatIds.size || "selected"}
                  </Button>
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
