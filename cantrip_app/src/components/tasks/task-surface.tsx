import type {
  ChatAttachmentSummary,
  ChatSummary,
  ReasoningEffort,
  SettingsBundle,
  TaskDetail,
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
import { ModelReasoningPicker } from "@/components/chat/model-reasoning-picker";
import { PermissionProfileControl } from "@/components/chat/permission-profile-control";
import { Button } from "@/components/ui/button";
import {
  chatAttachmentContentUrl,
  deleteChatAttachment,
  getChatPermissionProfiles,
  getChatReasoning,
  getMessages,
  getTask,
  getTaskAttachments,
  startTaskPlanning,
  updateChatModel,
  updateChatPermissionProfile,
  updateChatReasoning,
  updateTaskDraft,
  uploadChatAttachment,
} from "@/lib/api";
import { errorMessage } from "@/lib/error-message";
import { requestResponse } from "@/lib/api-client";
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
): string {
  return JSON.stringify([briefMarkdown, attachmentIds]);
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
  workerName,
  workerOnline,
}: {
  chat: ChatSummary;
  onRename(title: string): void;
  settings: SettingsBundle | undefined;
  workerName?: string;
  workerOnline: boolean;
}) {
  const queryClient = useQueryClient();
  const [brief, setBrief] = useState("");
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
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort | null>(chat.reasoningEffort);
  const rowVersionRef = useRef(1);
  const pendingDeletionIdsRef = useRef(new Set<string>());
  const failedDraftSignatureRef = useRef<string | null>(null);
  const savedSignatureRef = useRef(taskDraftSignature("", []));
  const fileInputRef = useRef<HTMLInputElement>(null);
  const briefRef = useRef(brief);
  const attachmentIdsRef = useRef(attachmentIds);
  briefRef.current = brief;
  attachmentIdsRef.current = attachmentIds;

  useEffect(() => setTitleDraft(chat.title), [chat.title]);

  const task = useQuery({
    queryFn: () => getTask(chat.id),
    queryKey: ["task", chat.id],
    refetchInterval: chat.status === "running" ? 2_000 : false,
  });
  const taskAttachments = useQuery({
    enabled: Boolean(task.data),
    queryFn: () => getTaskAttachments(chat.id),
    queryKey: ["task-attachments", chat.id],
  });
  const messages = useQuery({
    enabled:
      task.data?.state === "planning" || task.data?.state === "finalizing",
    queryFn: () => getMessages(chat.id),
    queryKey: ["messages", chat.id],
    refetchInterval: chat.status === "running" ? 1_000 : false,
  });

  useEffect(() => {
    if (!task.data || initialized) return;
    setBrief(task.data.briefMarkdown);
    setAttachmentIds(task.data.draftAttachmentIds);
    rowVersionRef.current = task.data.rowVersion;
    savedSignatureRef.current = taskDraftSignature(
      task.data.briefMarkdown,
      task.data.draftAttachmentIds,
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
  const selectModel = useMutation({
    mutationFn: (modelId: string) => updateChatModel(chat.id, modelId),
    onSuccess: async (updated) => {
      setReasoningEffort(updated.reasoningEffort);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["chats", chat.projectId] }),
        queryClient.invalidateQueries({
          queryKey: ["chat-reasoning", chat.id],
        }),
      ]);
    },
  });
  const selectReasoning = useMutation({
    mutationFn: (effort: ReasoningEffort | null) =>
      updateChatReasoning(chat.id, effort),
    onMutate: setReasoningEffort,
    onSuccess: async (state) => {
      setReasoningEffort(state.reasoningEffort);
      await queryClient.invalidateQueries({
        queryKey: ["chats", chat.projectId],
      });
    },
    onError: () => setReasoningEffort(chat.reasoningEffort),
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

  const currentSignature = taskDraftSignature(brief, attachmentIds);
  const dirty = initialized && currentSignature !== savedSignatureRef.current;
  const saveDraft = useMutation({
    mutationFn: (snapshot: {
      attachmentIds: string[];
      briefMarkdown: string;
      signature: string;
    }) =>
      updateTaskDraft(chat.id, {
        briefMarkdown: snapshot.briefMarkdown,
        draftAttachmentIds: snapshot.attachmentIds,
        rowVersion: rowVersionRef.current,
      }).then((updated) => ({ snapshot, updated })),
    onSuccess: ({ snapshot, updated }) => {
      failedDraftSignatureRef.current = null;
      rowVersionRef.current = updated.rowVersion;
      queryClient.setQueryData(["task", chat.id], updated);
      if (
        snapshot.signature ===
        taskDraftSignature(briefRef.current, attachmentIdsRef.current)
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
    );
    if (signature === savedSignatureRef.current) {
      if (!task.data) throw new Error("Task is still loading.");
      return task.data;
    }
    const result = await saveDraft.mutateAsync({
      attachmentIds: [...attachmentIdsRef.current],
      briefMarkdown: briefRef.current,
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
      task.data?.state !== "draft"
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      mutateDraft({
        attachmentIds: [...attachmentIdsRef.current],
        briefMarkdown: briefRef.current,
        signature: taskDraftSignature(
          briefRef.current,
          attachmentIdsRef.current,
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
    task.data?.state,
    mutateDraft,
  ]);

  const planning = useMutation({
    mutationFn: async () => {
      const saved = await saveCurrentDraft();
      return startTaskPlanning(chat.id, {
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
      const response = await requestResponse(
        chatAttachmentContentUrl(attachment.id),
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const pastedText = await response.text();
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
    setAttachmentIds(result.data.draftAttachmentIds);
    rowVersionRef.current = result.data.rowVersion;
    savedSignatureRef.current = taskDraftSignature(
      result.data.briefMarkdown,
      result.data.draftAttachmentIds,
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
        workerName={workerName}
        workerOnline={workerOnline}
        onReload={async () => (await task.refetch()).data ?? null}
      />
    );
  }

  if (mode === "implementation" && task.data.finalPlanMarkdown) {
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
  const canPlan =
    brief.trim().length > 0 &&
    selectedModelId.length > 0 &&
    pendingAttachments.length === 0 &&
    !conflict &&
    !saveDraft.isPending &&
    !planning.isPending &&
    workerOnline &&
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

      {!workerOnline ? (
        <div className="flex shrink-0 items-center gap-3 border-b bg-muted/35 px-5 py-3 text-sm">
          <WifiOff className="size-4 text-muted-foreground" />
          <span>
            {workerName ?? "The selected worker"} is offline. Your Task draft is
            saved and planning can begin when it reconnects.
          </span>
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
            size="sm"
            variant="ghost"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip className="size-4" /> Attach
          </Button>
          <ModelReasoningPicker
            disabled={planning.isPending}
            models={settings?.models ?? []}
            modelPending={selectModel.isPending}
            onSelectModel={(modelId) => selectModel.mutate(modelId)}
            onSelectReasoning={(effort) => selectReasoning.mutate(effort)}
            reasoningEffort={reasoningEffort}
            reasoningPending={selectReasoning.isPending}
            reasoningState={reasoningState.data}
            selectedModelId={selectedModelId}
          />
          <span className="ml-1 text-[11px] text-muted-foreground">
            Implementation access
          </span>
          <PermissionProfileControl
            onChange={(id) => selectPermission.mutate(id)}
            pending={selectPermission.isPending}
            state={permissionProfiles.data}
          />
          <span className="min-w-0 flex-1" />
          <Button disabled={!canPlan} onClick={() => planning.mutate()}>
            {planning.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            {mode === "failed" ? "Retry planning" : "Plan Task"}
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Planning is always read-only. Implementation access is reserved for
          the Goal.
        </p>
        {attachmentNotice ||
        planning.isError ||
        selectModel.isError ||
        selectReasoning.isError ||
        selectPermission.isError ? (
          <p className="mt-2 text-xs text-destructive">
            {attachmentNotice ??
              errorMessage(
                planning.error ??
                  selectModel.error ??
                  selectReasoning.error ??
                  selectPermission.error,
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
