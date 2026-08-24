import {
  TASK_PRIORITY_MAX,
  TASK_PRIORITY_MIN,
  type ChatAttachmentSummary,
  type ChatSummary,
  type SettingsBundle,
  type TaskDetail,
  type TaskWorkerSummary,
  type WorkerSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  ClipboardCopy,
  FilePlus2,
  ListTodo,
  Loader2,
  Paperclip,
  Play,
  RefreshCw,
  WifiOff,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type DragEvent,
} from "react";

import {
  AttachmentPreview,
  AttachmentViewerDialog,
} from "@/components/chat/attachment-preview";
import {
  attachmentKind,
  insertComposerText,
  largePasteFileName,
  MAX_ATTACHMENT_BYTES,
  MAX_COMPOSER_ATTACHMENTS,
  shouldAttachPastedText,
} from "@/components/chat/attachment-utils";
import { AgentInspectContent } from "@/components/chat/agent-inspect-content";
import { PermissionProfileControl } from "@/components/chat/permission-profile-control";
import { Button } from "@/components/ui/button";
import {
  chatAttachmentContentUrl,
  deleteChatAttachment,
  getChatPermissionProfiles,
  getTask,
  getTaskAttachments,
  getTaskWorkers,
  loadChatAttachmentContent,
  startTaskDirectly,
  startTaskPlanning,
  updateChatPermissionProfile,
  updateTaskDraft,
  uploadChatAttachment,
} from "@/lib/api";
import { errorMessage } from "@/lib/error-message";
import { clientEncryption } from "@/lib/client-encryption";
import { useAppLiveStatus } from "@/lib/app-live-react";
import { liveResourceRefreshInterval } from "@/lib/live-resource-refresh";
import { useChatMessageHistory } from "@/lib/use-chat-message-history";
import {
  ensureTaskWorkerEncryption,
  taskWorkerEncryptionCanAttempt,
  taskWorkerEncryptionMessage,
  taskWorkerEncryptionReadiness,
} from "@/lib/task-worker-encryption";
import { cn } from "@/lib/utils";

import { TaskPlanReview } from "./task-plan-review";
import { TaskImplementationDashboard } from "./task-implementation-dashboard";

const TaskMarkdownEditor = lazy(() =>
  import("./task-markdown-editor").then((module) => ({
    default: module.TaskMarkdownEditor,
  })),
);

const TASK_AUTOSAVE_DELAY_MS = 700;

interface PendingTaskAttachment {
  contentUrl: string;
  error: string | null;
  file: File;
  id: string;
  source: "file" | "paste";
}

export type TaskSurfaceMode =
  "activity" | "draft" | "failed" | "implementation" | "review";

export function taskSurfaceMode(task: TaskDetail): TaskSurfaceMode {
  if (task.state === "planning" || task.state === "finalizing") {
    return "activity";
  }
  if (
    task.state === "failed" &&
    task.implementationStartedAt &&
    task.finalPlanMarkdown
  ) {
    return "implementation";
  }
  if (
    task.state === "failed" &&
    task.stableStateBeforeFailure === "review" &&
    task.planMarkdown
  ) {
    return "review";
  }
  if (task.state === "review") return "review";
  if (task.state === "failed") return "failed";
  if (
    task.state === "implementing" ||
    task.state === "paused" ||
    task.state === "blocked" ||
    task.state === "complete"
  ) {
    return "implementation";
  }
  return "draft";
}

export function taskDraftSignature(
  briefMarkdown: string,
  attachmentIds: readonly string[],
  planGoalEnabled = false,
  priority = 0,
  requestedTaskWorkerId: string | null = null,
): string {
  return JSON.stringify([
    briefMarkdown,
    attachmentIds,
    planGoalEnabled,
    priority,
    requestedTaskWorkerId,
  ]);
}

export function taskAutosaveLabel(input: {
  conflict: boolean;
  dirty: boolean;
  failed: boolean;
  saving: boolean;
}): string {
  if (input.conflict) return "Save conflict";
  if (input.failed) return "Autosave failed";
  if (input.saving) return "Saving…";
  return input.dirty ? "Unsaved changes" : "Saved";
}

export function TaskSurface({
  chat,
  onRename,
  settings,
  worker,
}: {
  chat: ChatSummary;
  onRename(title: string): void;
  settings: SettingsBundle | undefined;
  worker?: WorkerSummary;
}) {
  const queryClient = useQueryClient();
  const taskResourcesLive = useAppLiveStatus() === "live";
  const encryptionSnapshot = useSyncExternalStore(
    clientEncryption.subscribe,
    clientEncryption.getSnapshot,
    clientEncryption.getSnapshot,
  );
  const workerName = worker?.name;
  const workerEncryptionReadiness = taskWorkerEncryptionReadiness(
    worker,
    encryptionSnapshot,
  );
  const workerEncryptionMessage = taskWorkerEncryptionMessage(
    workerEncryptionReadiness,
    workerName,
  );
  const [brief, setBrief] = useState("");
  const [planGoalEnabled, setPlanGoalEnabled] = useState(false);
  const [priority, setPriority] = useState(0);
  const [requestedTaskWorkerId, setRequestedTaskWorkerId] = useState<
    string | null
  >(null);
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [attachmentRecords, setAttachmentRecords] = useState(
    () => new Map<string, ChatAttachmentSummary>(),
  );
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingTaskAttachment[]
  >([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [viewingAttachment, setViewingAttachment] =
    useState<ChatAttachmentSummary | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [titleDraft, setTitleDraft] = useState(chat.title);
  const rowVersionRef = useRef(1);
  const pendingDeletionIdsRef = useRef(new Set<string>());
  const failedDraftSignatureRef = useRef<string | null>(null);
  const savedSignatureRef = useRef(taskDraftSignature("", []));
  const fileInputRef = useRef<HTMLInputElement>(null);
  const briefRef = useRef(brief);
  const planGoalEnabledRef = useRef(planGoalEnabled);
  const priorityRef = useRef(priority);
  const requestedTaskWorkerIdRef = useRef(requestedTaskWorkerId);
  const attachmentIdsRef = useRef(attachmentIds);
  briefRef.current = brief;
  planGoalEnabledRef.current = planGoalEnabled;
  priorityRef.current = priority;
  requestedTaskWorkerIdRef.current = requestedTaskWorkerId;
  attachmentIdsRef.current = attachmentIds;

  useEffect(() => setTitleDraft(chat.title), [chat.title]);

  const task = useQuery({
    queryFn: () => getTask(chat.id),
    queryKey: ["task", chat.id],
    refetchInterval: liveResourceRefreshInterval(
      taskResourcesLive,
      chat.status === "running" ? 2_000 : false,
    ),
  });
  const taskAttachments = useQuery({
    enabled: Boolean(task.data),
    queryFn: () => getTaskAttachments(chat.id),
    queryKey: ["task-attachments", chat.id],
  });
  const taskWorkers = useQuery({
    queryFn: getTaskWorkers,
    queryKey: ["task-workers"],
    staleTime: 30_000,
  });
  const messages = useChatMessageHistory({
    autoLoadOlder: true,
    chatId: chat.id,
    enabled:
      task.data?.state === "planning" || task.data?.state === "finalizing",
    refetchInterval: liveResourceRefreshInterval(
      taskResourcesLive,
      chat.status === "running" ? 1_000 : false,
    ),
  });

  useEffect(() => {
    if (!task.data || initialized) return;
    setBrief(task.data.briefMarkdown);
    setPlanGoalEnabled(task.data.planGoalEnabled);
    setPriority(task.data.priority);
    setRequestedTaskWorkerId(task.data.requestedTaskWorkerId);
    setAttachmentIds(task.data.draftAttachmentIds);
    rowVersionRef.current = task.data.rowVersion;
    savedSignatureRef.current = taskDraftSignature(
      task.data.briefMarkdown,
      task.data.draftAttachmentIds,
      task.data.planGoalEnabled,
      task.data.priority,
      task.data.requestedTaskWorkerId,
    );
    setInitialized(true);
  }, [initialized, task.data]);

  useEffect(() => {
    if (!taskAttachments.data) return;
    setAttachmentRecords(
      new Map(
        taskAttachments.data.map((attachment) => [attachment.id, attachment]),
      ),
    );
  }, [taskAttachments.data]);

  const selectedModelId =
    chat.modelId ?? settings?.preferences.defaultModelId ?? "";
  const permissionProfiles = useQuery({
    enabled: Boolean(selectedModelId),
    queryFn: () => getChatPermissionProfiles(chat.id),
    queryKey: ["permission-profiles", chat.id, selectedModelId],
    retry: false,
    staleTime: 30_000,
  });
  const selectPermission = useMutation({
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

  const currentSignature = taskDraftSignature(
    brief,
    attachmentIds,
    planGoalEnabled,
    priority,
    requestedTaskWorkerId,
  );
  const dirty = initialized && currentSignature !== savedSignatureRef.current;
  const saveDraft = useMutation({
    mutationFn: (snapshot: {
      attachmentIds: string[];
      briefMarkdown: string;
      planGoalEnabled: boolean;
      priority: number;
      requestedTaskWorkerId: string | null;
      signature: string;
    }) =>
      updateTaskDraft(chat.id, {
        briefMarkdown: snapshot.briefMarkdown,
        draftAttachmentIds: snapshot.attachmentIds,
        planGoalEnabled: snapshot.planGoalEnabled,
        priority: snapshot.priority,
        requestedTaskWorkerId: snapshot.requestedTaskWorkerId,
        rowVersion: rowVersionRef.current,
      }).then((updated) => ({ snapshot, updated })),
    onSuccess: ({ snapshot, updated }) => {
      failedDraftSignatureRef.current = null;
      rowVersionRef.current = updated.rowVersion;
      queryClient.setQueryData(["task", chat.id], updated);
      if (
        snapshot.signature ===
        taskDraftSignature(
          briefRef.current,
          attachmentIdsRef.current,
          planGoalEnabledRef.current,
          priorityRef.current,
          requestedTaskWorkerIdRef.current,
        )
      ) {
        savedSignatureRef.current = snapshot.signature;
      }
      for (const attachmentId of pendingDeletionIdsRef.current) {
        if (
          updated.draftAttachmentIds.includes(attachmentId) ||
          attachmentIdsRef.current.includes(attachmentId)
        ) {
          continue;
        }
        pendingDeletionIdsRef.current.delete(attachmentId);
        void deleteChatAttachment(attachmentId).catch((error) =>
          setAttachmentNotice(errorMessage(error)),
        );
      }
    },
    onError: (error, snapshot) => {
      failedDraftSignatureRef.current = snapshot.signature;
      if (typeof error === "object" && error !== null && "status" in error) {
        if ((error as { status?: unknown }).status === 409) setConflict(true);
      }
    },
  });
  const mutateDraft = saveDraft.mutate;

  const saveCurrentDraft = async (): Promise<TaskDetail> => {
    const signature = taskDraftSignature(
      briefRef.current,
      attachmentIdsRef.current,
      planGoalEnabledRef.current,
      priorityRef.current,
      requestedTaskWorkerIdRef.current,
    );
    if (signature === savedSignatureRef.current) {
      if (!task.data) throw new Error("Task is still loading.");
      return task.data;
    }
    const result = await saveDraft.mutateAsync({
      attachmentIds: [...attachmentIdsRef.current],
      briefMarkdown: briefRef.current,
      planGoalEnabled: planGoalEnabledRef.current,
      priority: priorityRef.current,
      requestedTaskWorkerId: requestedTaskWorkerIdRef.current,
      signature,
    });
    savedSignatureRef.current = signature;
    return result.updated;
  };

  useEffect(() => {
    if (
      !initialized ||
      !dirty ||
      conflict ||
      saveDraft.isPending ||
      failedDraftSignatureRef.current === currentSignature ||
      task.data?.state !== "draft" ||
      (task.data.dispatch !== null && task.data.dispatch.state !== "queued")
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      mutateDraft({
        attachmentIds: [...attachmentIdsRef.current],
        briefMarkdown: briefRef.current,
        planGoalEnabled: planGoalEnabledRef.current,
        priority: priorityRef.current,
        requestedTaskWorkerId: requestedTaskWorkerIdRef.current,
        signature: taskDraftSignature(
          briefRef.current,
          attachmentIdsRef.current,
          planGoalEnabledRef.current,
          priorityRef.current,
          requestedTaskWorkerIdRef.current,
        ),
      });
    }, TASK_AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    conflict,
    currentSignature,
    dirty,
    initialized,
    saveDraft.isPending,
    task.data?.dispatch,
    task.data?.state,
    mutateDraft,
  ]);

  const starting = useMutation({
    mutationFn: async () => {
      const saved = await saveCurrentDraft();
      if (taskWorkerEncryptionCanAttempt(workerEncryptionReadiness)) {
        void ensureTaskWorkerEncryption({ worker })
          .then((encryption) => {
            queryClient.setQueryData<WorkerSummary[]>(["workers"], (current) =>
              current?.map((candidate) =>
                candidate.workerId === worker?.workerId
                  ? { ...candidate, encryption }
                  : candidate,
              ),
            );
          })
          .catch(() => undefined);
      }
      const start = saved.planGoalEnabled
        ? startTaskPlanning
        : startTaskDirectly;
      return start(chat.id, {
        operationId: crypto.randomUUID(),
        rowVersion: saved.rowVersion,
      });
    },
    onSuccess: async (updated) => {
      queryClient.setQueryData(["task", chat.id], updated);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["messages", chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["chats", chat.projectId] }),
      ]);
    },
  });

  const attachFiles = async (files: File[], source: "file" | "paste") => {
    setAttachmentNotice(null);
    const available = Math.max(
      0,
      MAX_COMPOSER_ATTACHMENTS -
        attachmentIdsRef.current.length -
        pendingAttachments.length,
    );
    const accepted = files
      .slice(0, available)
      .filter((file) => file.size <= MAX_ATTACHMENT_BYTES);
    if (files.length > available) {
      setAttachmentNotice(
        `A Task can include up to ${MAX_COMPOSER_ATTACHMENTS} attachments.`,
      );
    } else if (accepted.length !== files.length) {
      setAttachmentNotice("Attachments must be 25 MB or smaller.");
    }
    const pending = accepted.map((file) => ({
      contentUrl: URL.createObjectURL(file),
      error: null,
      file,
      id: `local-${crypto.randomUUID()}`,
      source,
    }));
    setPendingAttachments((current) => [...current, ...pending]);
    await Promise.all(
      pending.map(async (item) => {
        try {
          await ensureTaskWorkerEncryption({ worker });
          const uploaded = await uploadChatAttachment(
            chat.id,
            item.file,
            attachmentKind(item.file.name, item.file.type),
            source,
          );
          URL.revokeObjectURL(item.contentUrl);
          setAttachmentRecords((current) =>
            new Map(current).set(uploaded.id, uploaded),
          );
          setAttachmentIds((current) => [...current, uploaded.id]);
          setPendingAttachments((current) =>
            current.filter(({ id }) => id !== item.id),
          );
        } catch (error) {
          setPendingAttachments((current) =>
            current.map((candidate) =>
              candidate.id === item.id
                ? { ...candidate, error: errorMessage(error) }
                : candidate,
            ),
          );
        }
      }),
    );
  };

  const removeTaskAttachment = (attachmentId: string) => {
    setAttachmentIds((current) => current.filter((id) => id !== attachmentId));
    setAttachmentRecords((current) => {
      const next = new Map(current);
      next.delete(attachmentId);
      return next;
    });
    pendingDeletionIdsRef.current.add(attachmentId);
  };

  const restoreTaskAttachmentText = async (
    attachment: ChatAttachmentSummary,
  ) => {
    setAttachmentNotice(null);
    try {
      const pastedText = await loadChatAttachmentContent(attachment).then(
        (blob) => blob.text(),
      );
      setBrief(
        (current) =>
          insertComposerText(current, pastedText, current.length).text,
      );
      removeTaskAttachment(attachment.id);
    } catch (error) {
      setAttachmentNotice(
        `Could not restore pasted text: ${errorMessage(error)}`,
      );
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length > 0) {
      event.preventDefault();
      void attachFiles(files, "paste");
      return;
    }
    const text = event.clipboardData.getData("text/plain");
    if (shouldAttachPastedText(text)) {
      const file = new File([text], largePasteFileName(), {
        type: "text/plain",
      });
      const attachmentCount =
        attachmentIdsRef.current.length + pendingAttachments.length;
      if (
        attachmentCount >= MAX_COMPOSER_ATTACHMENTS ||
        file.size > MAX_ATTACHMENT_BYTES
      ) {
        setAttachmentNotice(
          attachmentCount >= MAX_COMPOSER_ATTACHMENTS
            ? `A Task can include up to ${MAX_COMPOSER_ATTACHMENTS} attachments. The pasted text was kept in the brief.`
            : "The paste is too large to attach, so it was kept in the brief.",
        );
        return;
      }
      event.preventDefault();
      void attachFiles([file], "paste");
    }
  };

  const reloadServerDraft = async () => {
    const result = await task.refetch();
    if (!result.data) return;
    setBrief(result.data.briefMarkdown);
    setPlanGoalEnabled(result.data.planGoalEnabled);
    setPriority(result.data.priority);
    setRequestedTaskWorkerId(result.data.requestedTaskWorkerId);
    setAttachmentIds(result.data.draftAttachmentIds);
    rowVersionRef.current = result.data.rowVersion;
    savedSignatureRef.current = taskDraftSignature(
      result.data.briefMarkdown,
      result.data.draftAttachmentIds,
      result.data.planGoalEnabled,
      result.data.priority,
      result.data.requestedTaskWorkerId,
    );
    setConflict(false);
    pendingDeletionIdsRef.current.clear();
    await taskAttachments.refetch();
  };

  if (task.isError) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center p-6 text-center">
        <div>
          <CircleAlert className="mx-auto size-6 text-destructive" />
          <p className="mt-3 text-sm text-destructive">
            {errorMessage(task.error)}
          </p>
          <Button
            className="mt-4"
            variant="outline"
            onClick={() => void task.refetch()}
          >
            <RefreshCw className="size-4" /> Retry
          </Button>
        </div>
      </div>
    );
  }
  if (task.isLoading || !task.data || !initialized) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  const mode = taskSurfaceMode(task.data);
  if (mode === "activity") {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-3 border-b px-5 py-3">
          <Loader2 className="size-4 animate-spin text-violet-500" />
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {task.data.state === "finalizing"
                ? "Finalizing Task"
                : "Planning Task"}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              Read-only investigation · round {task.data.planningRound}
            </p>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden p-4 sm:p-6">
          <AgentInspectContent active messages={messages.data ?? []} visible />
        </div>
      </div>
    );
  }

  if (mode === "review" && task.data.planMarkdown) {
    return (
      <TaskPlanReview
        chat={chat}
        task={task.data}
        worker={worker}
        onReload={async () => (await task.refetch()).data ?? null}
      />
    );
  }

  if (mode === "implementation") {
    return (
      <TaskImplementationDashboard
        chat={chat}
        initialTask={task.data}
        workerName={workerName}
      />
    );
  }

  const autosaveLabel = taskAutosaveLabel({
    conflict,
    dirty,
    failed: saveDraft.isError && !conflict,
    saving: saveDraft.isPending,
  });
  const attachmentList = attachmentIds.flatMap((id) => {
    const attachment = attachmentRecords.get(id);
    return attachment ? [attachment] : [];
  });
  const configuredTaskWorkers = (taskWorkers.data ?? []).filter(
    (candidate) => candidate.enabled,
  );
  const selectedTaskWorker: TaskWorkerSummary | undefined =
    requestedTaskWorkerId === null
      ? undefined
      : configuredTaskWorkers.find(
          (candidate) => candidate.id === requestedTaskWorkerId,
        );
  const eligibleTaskWorkers = configuredTaskWorkers.filter(
    (candidate) => !planGoalEnabled || candidate.allowsPlanGoal,
  );
  const hasEligibleTaskWorker = requestedTaskWorkerId
    ? Boolean(
        selectedTaskWorker &&
        (!planGoalEnabled || selectedTaskWorker.allowsPlanGoal),
      )
    : eligibleTaskWorkers.length > 0;
  const dispatchQueued = task.data.dispatch?.state === "queued";
  const draftEditable =
    task.data.state === "draft" &&
    !["claimed", "running", "paused"].includes(task.data.dispatch?.state ?? "");
  const canStart =
    brief.trim().length > 0 &&
    hasEligibleTaskWorker &&
    pendingAttachments.length === 0 &&
    !conflict &&
    !saveDraft.isPending &&
    !starting.isPending &&
    !dispatchQueued &&
    draftEditable &&
    chat.status !== "running";

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files")) setDraggingFiles(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDraggingFiles(false);
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setDraggingFiles(false);
        void attachFiles(Array.from(event.dataTransfer.files), "file");
      }}
      onPaste={handlePaste}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2.5 sm:px-6">
        <ListTodo className="size-4 text-violet-500" />
        <input
          aria-label="Task title"
          className="min-w-40 flex-1 bg-transparent text-sm font-medium outline-none"
          maxLength={200}
          value={titleDraft}
          onBlur={() => {
            const title = titleDraft.trim();
            if (title && title !== chat.title) onRename(title);
            else setTitleDraft(chat.title);
          }}
          onChange={(event) => setTitleDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <span
          className={cn(
            "text-[11px] text-muted-foreground",
            (conflict || saveDraft.isError) && "text-destructive",
          )}
          role="status"
        >
          {autosaveLabel}
        </span>
      </div>

      {mode === "failed" && task.data.lastError ? (
        <div className="flex shrink-0 items-start gap-3 border-b border-destructive/30 bg-destructive/5 px-5 py-3 text-sm text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{task.data.lastError.message}</span>
        </div>
      ) : null}

      {dispatchQueued ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-violet-500/25 bg-violet-500/5 px-5 py-3 text-sm">
          <ListTodo className="size-4 text-violet-500" />
          <span>
            Queued for a Task Worker. You can keep editing until it is claimed.
          </span>
        </div>
      ) : null}

      {workerEncryptionMessage ? (
        <div className="flex shrink-0 items-center gap-3 border-b bg-muted/35 px-5 py-3 text-sm">
          {workerEncryptionReadiness === "offline" ? (
            <WifiOff className="size-4 text-muted-foreground" />
          ) : (
            <CircleAlert className="size-4 text-muted-foreground" />
          )}
          <span>{workerEncryptionMessage}</span>
        </div>
      ) : null}

      {conflict ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/5 px-5 py-3 text-xs">
          <CircleAlert className="size-4 text-amber-500" />
          <span className="min-w-0 flex-1">
            This Task changed elsewhere. Reload the server copy or copy your
            unsaved brief first.
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void navigator.clipboard.writeText(brief)}
          >
            <ClipboardCopy className="size-3.5" /> Copy unsaved
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void reloadServerDraft()}
          >
            <RefreshCw className="size-3.5" /> Reload
          </Button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="grid h-full place-items-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          }
        >
          <TaskMarkdownEditor
            ariaLabel="Task brief"
            onChange={setBrief}
            onSave={() => void saveCurrentDraft().catch(() => undefined)}
            placeholder="Describe the outcome, constraints, and context for this Task…"
            readOnly={!draftEditable}
            value={brief}
          />
        </Suspense>
      </div>

      <div className="shrink-0 border-t bg-background/95 px-4 py-3 backdrop-blur sm:px-6">
        {attachmentList.length > 0 || pendingAttachments.length > 0 ? (
          <div className="mb-3 flex max-h-40 gap-2 overflow-x-auto pb-1">
            {attachmentList.map((attachment) => (
              <AttachmentPreview
                key={attachment.id}
                attachment={attachment}
                contentUrl={chatAttachmentContentUrl(attachment.id)}
                onOpen={() => setViewingAttachment(attachment)}
                onRemove={() => removeTaskAttachment(attachment.id)}
                onRestoreText={
                  attachment.source === "paste"
                    ? () => restoreTaskAttachmentText(attachment)
                    : undefined
                }
              />
            ))}
            {pendingAttachments.map((pending) => {
              const presentation = {
                fileName: pending.file.name,
                id: pending.id,
                kind: attachmentKind(pending.file.name, pending.file.type),
                mimeType: pending.file.type || "application/octet-stream",
                previewText: null,
                sizeBytes: pending.file.size,
                source: pending.source,
              };
              return (
                <AttachmentPreview
                  key={pending.id}
                  attachment={presentation}
                  contentUrl={pending.contentUrl}
                  error={pending.error}
                  uploading={!pending.error}
                  onRestoreText={
                    pending.source === "paste"
                      ? async () => {
                          const pastedText = await pending.file.text();
                          setBrief(
                            (current) =>
                              insertComposerText(
                                current,
                                pastedText,
                                current.length,
                              ).text,
                          );
                          URL.revokeObjectURL(pending.contentUrl);
                          setPendingAttachments((current) =>
                            current.filter(({ id }) => id !== pending.id),
                          );
                        }
                      : undefined
                  }
                  onRemove={
                    pending.error
                      ? () => {
                          URL.revokeObjectURL(pending.contentUrl);
                          setPendingAttachments((current) =>
                            current.filter(({ id }) => id !== pending.id),
                          );
                        }
                      : undefined
                  }
                />
              );
            })}
          </div>
        ) : null}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            className="hidden"
            multiple
            type="file"
            onChange={(event) => {
              void attachFiles(Array.from(event.target.files ?? []), "file");
              event.target.value = "";
            }}
          />
          <Button
            disabled={!draftEditable}
            size="sm"
            variant="ghost"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip className="size-4" /> Attach
          </Button>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Worker
            <select
              aria-label="Task Worker"
              className="h-8 max-w-48 rounded-md border bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              disabled={!draftEditable || taskWorkers.isLoading}
              value={requestedTaskWorkerId ?? ""}
              onChange={(event) =>
                setRequestedTaskWorkerId(event.target.value || null)
              }
            >
              <option value="">Auto</option>
              {requestedTaskWorkerId && !selectedTaskWorker ? (
                <option value={requestedTaskWorkerId}>
                  Unavailable Task Worker
                </option>
              ) : null}
              {configuredTaskWorkers.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                  {planGoalEnabled && !candidate.allowsPlanGoal
                    ? " (Direct only)"
                    : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Priority
            <input
              aria-label="Task priority"
              className="h-8 w-20 rounded-md border bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              disabled={!draftEditable}
              max={TASK_PRIORITY_MAX}
              min={TASK_PRIORITY_MIN}
              step={1}
              type="number"
              value={priority}
              onChange={(event) => {
                const value = event.currentTarget.valueAsNumber;
                if (Number.isInteger(value)) {
                  setPriority(
                    Math.max(
                      TASK_PRIORITY_MIN,
                      Math.min(TASK_PRIORITY_MAX, value),
                    ),
                  );
                }
              }}
            />
          </label>
          <span className="ml-1 text-[11px] text-muted-foreground">
            Implementation access
          </span>
          <PermissionProfileControl
            onChange={(id) => selectPermission.mutate(id)}
            pending={selectPermission.isPending}
            state={permissionProfiles.data}
          />
          <span className="min-w-0 flex-1" />
          <button
            aria-checked={planGoalEnabled}
            className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            role="switch"
            type="button"
            disabled={!draftEditable}
            onClick={() => setPlanGoalEnabled((current) => !current)}
          >
            <span
              className={cn(
                "relative h-5 w-9 rounded-full bg-muted-foreground/25 transition-colors",
                planGoalEnabled && "bg-violet-500",
              )}
            >
              <span
                className={cn(
                  "absolute left-0.5 top-0.5 size-4 rounded-full bg-background shadow-sm transition-transform",
                  planGoalEnabled && "translate-x-4",
                )}
              />
            </span>
            Plan + Goal
          </button>
          <Button disabled={!canStart} onClick={() => starting.mutate()}>
            {starting.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            {dispatchQueued
              ? "Queued"
              : mode === "failed"
                ? planGoalEnabled
                  ? "Retry planning"
                  : "Retry Task"
                : planGoalEnabled
                  ? "Add Plan + Goal Task"
                  : "Add Task"}
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          {planGoalEnabled
            ? "The Task queues for one read-only planning cycle. Implementation access is reserved for its Goal."
            : "The saved prompt queues as a normal agent turn and starts when an eligible Task Worker has capacity."}
        </p>
        {!taskWorkers.isLoading && configuredTaskWorkers.length === 0 ? (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            Configure and enable a Task Worker in Settings before adding this
            Task to the queue.
          </p>
        ) : null}
        {requestedTaskWorkerId && !hasEligibleTaskWorker ? (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            The selected Task Worker is unavailable or cannot run Plan + Goal
            Tasks.
          </p>
        ) : null}
        {attachmentNotice ||
        starting.isError ||
        taskWorkers.isError ||
        selectPermission.isError ? (
          <p className="mt-2 text-xs text-destructive">
            {attachmentNotice ??
              errorMessage(
                starting.error ?? taskWorkers.error ?? selectPermission.error,
              )}
          </p>
        ) : null}
      </div>

      {draggingFiles ? (
        <div className="pointer-events-none absolute inset-3 z-40 grid place-items-center rounded-2xl border-2 border-dashed border-violet-500 bg-background/90 backdrop-blur">
          <div className="text-center">
            <FilePlus2 className="mx-auto size-6 text-violet-500" />
            <p className="mt-2 text-sm font-medium">
              Attach files to this Task
            </p>
          </div>
        </div>
      ) : null}

      <AttachmentViewerDialog
        attachment={viewingAttachment}
        contentUrl={
          viewingAttachment
            ? chatAttachmentContentUrl(viewingAttachment.id)
            : null
        }
        open={viewingAttachment !== null}
        onOpenChange={(open) => !open && setViewingAttachment(null)}
      />
    </div>
  );
}
