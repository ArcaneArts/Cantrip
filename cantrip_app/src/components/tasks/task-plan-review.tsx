import {
  TASK_ADDITIONAL_DIRECTION_LIMIT,
  type ChatSummary,
  type TaskDetail,
  type TaskQuestionAnswer,
  type WorkerSummary,
} from "@cantrip/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  ClipboardCopy,
  Eye,
  Loader2,
  Pencil,
  Play,
  RefreshCw,
  Save,
  Undo2,
  WifiOff,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { Markdown } from "@/components/chat/markdown";
import { Button } from "@/components/ui/button";
import {
  beginTaskImplementation,
  continueTaskPlanning,
  retryTaskPlanning,
  updateTaskPlan,
} from "@/lib/api";
import { CantripApiError } from "@/lib/api-client";
import { clientEncryption } from "@/lib/client-encryption";
import { errorMessage } from "@/lib/error-message";
import {
  ensureTaskWorkerEncryption,
  taskWorkerEncryptionCanAttempt,
  taskWorkerEncryptionMessage,
  taskWorkerEncryptionReadiness,
} from "@/lib/task-worker-encryption";
import { cn } from "@/lib/utils";

import { TaskQuestionList } from "./task-question-list";
import {
  taskReviewInputSignature,
  unansweredRequiredTaskQuestions,
} from "./task-review-state";

const TaskMarkdownEditor = lazy(() =>
  import("./task-markdown-editor").then((module) => ({
    default: module.TaskMarkdownEditor,
  })),
);

const TASK_REVIEW_AUTOSAVE_DELAY_MS = 650;

interface TaskReviewSession {
  additionalDirection: string;
  answers: TaskQuestionAnswer[];
  editing: boolean;
  planDraft: string;
  planningRound: number;
  previewingEdit: boolean;
}

const taskReviewSessions = new Map<string, TaskReviewSession>();

function initialReviewSession(task: TaskDetail): TaskReviewSession {
  const cached = taskReviewSessions.get(task.chatId);
  if (cached?.planningRound === task.planningRound) return cached;
  return {
    additionalDirection: task.additionalDirection,
    answers: task.currentAnswers,
    editing: false,
    planDraft: task.planMarkdown ?? "",
    planningRound: task.planningRound,
    previewingEdit: false,
  };
}

function isConflictError(error: unknown): boolean {
  return error instanceof CantripApiError && error.status === 409;
}

export function taskReviewSaveLabel(input: {
  conflict: boolean;
  dirty: boolean;
  failed: boolean;
  saving: boolean;
}): string {
  if (input.conflict) return "Save conflict";
  if (input.failed) return "Autosave failed";
  if (input.saving) return "Saving answers…";
  return input.dirty ? "Answers not saved" : "Answers saved";
}

export function TaskPlanReview({
  chat,
  onReload,
  task,
  worker,
}: {
  chat: ChatSummary;
  onReload(): Promise<TaskDetail | null>;
  task: TaskDetail;
  worker?: WorkerSummary;
}) {
  const queryClient = useQueryClient();
  const encryptionSnapshot = useSyncExternalStore(
    clientEncryption.subscribe,
    clientEncryption.getSnapshot,
    clientEncryption.getSnapshot,
  );
  const workerEncryptionReadiness = taskWorkerEncryptionReadiness(
    worker,
    encryptionSnapshot,
  );
  const workerEncryptionMessage = taskWorkerEncryptionMessage(
    workerEncryptionReadiness,
    worker?.name,
  );
  const initial = initialReviewSession(task);
  const [planDraft, setPlanDraft] = useState(initial.planDraft);
  const [editing, setEditing] = useState(initial.editing);
  const [previewingEdit, setPreviewingEdit] = useState(initial.previewingEdit);
  const [answers, setAnswers] = useState(initial.answers);
  const [additionalDirection, setAdditionalDirection] = useState(
    initial.additionalDirection,
  );
  const [conflict, setConflict] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const [operationNotice, setOperationNotice] = useState<string | null>(null);
  const rowVersionRef = useRef(task.rowVersion);
  const planningRoundRef = useRef(task.planningRound);
  const basePlanRef = useRef(task.planMarkdown ?? "");
  const savedInputsRef = useRef(
    taskReviewInputSignature(task.currentAnswers, task.additionalDirection),
  );
  const planDraftRef = useRef(planDraft);
  const answersRef = useRef(answers);
  const directionRef = useRef(additionalDirection);
  const failedInputSignatureRef = useRef<string | null>(null);
  const continueOperationIdRef = useRef<string | null>(null);
  const implementationOperationIdRef = useRef<string | null>(null);
  const retryOperationIdRef = useRef<string | null>(null);
  planDraftRef.current = planDraft;
  answersRef.current = answers;
  directionRef.current = additionalDirection;

  const inputSignature = taskReviewInputSignature(answers, additionalDirection);
  const inputDirty = inputSignature !== savedInputsRef.current;
  const planDirty = planDraft !== basePlanRef.current;

  const adoptServerTask = (next: TaskDetail) => {
    const nextPlan = next.planMarkdown ?? "";
    setPlanDraft(nextPlan);
    setAnswers(next.currentAnswers);
    setAdditionalDirection(next.additionalDirection);
    setEditing(false);
    setPreviewingEdit(false);
    setConflict(false);
    setShowValidation(false);
    setOperationNotice(null);
    failedInputSignatureRef.current = null;
    rowVersionRef.current = next.rowVersion;
    planningRoundRef.current = next.planningRound;
    basePlanRef.current = nextPlan;
    savedInputsRef.current = taskReviewInputSignature(
      next.currentAnswers,
      next.additionalDirection,
    );
    taskReviewSessions.set(next.chatId, {
      additionalDirection: next.additionalDirection,
      answers: next.currentAnswers,
      editing: false,
      planDraft: nextPlan,
      planningRound: next.planningRound,
      previewingEdit: false,
    });
  };

  useEffect(() => {
    taskReviewSessions.set(chat.id, {
      additionalDirection,
      answers,
      editing,
      planDraft,
      planningRound: planningRoundRef.current,
      previewingEdit,
    });
  }, [
    additionalDirection,
    answers,
    chat.id,
    editing,
    planDraft,
    previewingEdit,
  ]);

  useEffect(() => {
    if (
      task.rowVersion === rowVersionRef.current &&
      task.planningRound === planningRoundRef.current
    ) {
      return;
    }
    if (planDirty || inputDirty) {
      setConflict(true);
      return;
    }
    adoptServerTask(task);
  }, [inputDirty, planDirty, task]);

  const saveReview = useMutation({
    mutationFn: (snapshot: {
      additionalDirection: string;
      answers: TaskQuestionAnswer[];
      inputSignature: string;
      planMarkdown?: string;
    }) =>
      updateTaskPlan(chat.id, {
        rowVersion: rowVersionRef.current,
        answers: snapshot.answers,
        additionalDirection: snapshot.additionalDirection,
        ...(snapshot.planMarkdown !== undefined
          ? { planMarkdown: snapshot.planMarkdown }
          : {}),
      }).then((updated) => ({ snapshot, updated })),
    onSuccess: ({ snapshot, updated }) => {
      failedInputSignatureRef.current = null;
      rowVersionRef.current = updated.rowVersion;
      queryClient.setQueryData(["task", chat.id], updated);
      if (
        snapshot.inputSignature ===
        taskReviewInputSignature(answersRef.current, directionRef.current)
      ) {
        savedInputsRef.current = snapshot.inputSignature;
      }
      if (
        snapshot.planMarkdown !== undefined &&
        snapshot.planMarkdown === planDraftRef.current
      ) {
        basePlanRef.current = snapshot.planMarkdown;
      }
      setConflict(false);
    },
    onError: (error, snapshot) => {
      failedInputSignatureRef.current = snapshot.inputSignature;
      if (isConflictError(error)) setConflict(true);
    },
  });
  const mutateReview = saveReview.mutate;

  useEffect(() => {
    if (
      !inputDirty ||
      conflict ||
      saveReview.isPending ||
      planDirty ||
      failedInputSignatureRef.current === inputSignature
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      mutateReview({
        additionalDirection: directionRef.current,
        answers: [...answersRef.current],
        inputSignature: taskReviewInputSignature(
          answersRef.current,
          directionRef.current,
        ),
      });
    }, TASK_REVIEW_AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    conflict,
    inputDirty,
    inputSignature,
    mutateReview,
    planDirty,
    saveReview.isPending,
  ]);

  const prepareWorkerEncryption = async () => {
    const encryption = await ensureTaskWorkerEncryption({ worker });
    queryClient.setQueryData<WorkerSummary[]>(["workers"], (current) =>
      current?.map((candidate) =>
        candidate.workerId === worker?.workerId
          ? { ...candidate, encryption }
          : candidate,
      ),
    );
  };
  const warmWorkerEncryption = () => {
    if (!taskWorkerEncryptionCanAttempt(workerEncryptionReadiness)) return;
    void prepareWorkerEncryption().catch(() => undefined);
  };

  const continuePlanning = useMutation({
    mutationFn: async (operationId: string) => {
      warmWorkerEncryption();
      return continueTaskPlanning(chat.id, {
        operationId,
        rowVersion: rowVersionRef.current,
        answers: answersRef.current,
        additionalDirection: directionRef.current,
      });
    },
    onMutate: () => setOperationNotice(null),
    onSuccess: (updated) => {
      continueOperationIdRef.current = null;
      queryClient.setQueryData(["task", chat.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["messages", chat.id] });
      void queryClient.invalidateQueries({
        queryKey: ["chats", chat.projectId],
      });
    },
    onError: (error) => {
      if (isConflictError(error)) setConflict(true);
      setOperationNotice(errorMessage(error));
    },
  });
  const retryPlanning = useMutation({
    mutationFn: async (operationId: string) => {
      await prepareWorkerEncryption();
      return retryTaskPlanning(chat.id, {
        operationId,
        rowVersion: rowVersionRef.current,
      });
    },
    onMutate: () => setOperationNotice(null),
    onSuccess: (updated) => {
      retryOperationIdRef.current = null;
      queryClient.setQueryData(["task", chat.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["messages", chat.id] });
      void queryClient.invalidateQueries({
        queryKey: ["chats", chat.projectId],
      });
    },
    onError: (error) => {
      if (isConflictError(error)) setConflict(true);
      setOperationNotice(errorMessage(error));
    },
  });
  const beginImplementation = useMutation({
    mutationFn: async (operationId: string) => {
      warmWorkerEncryption();
      return beginTaskImplementation(chat.id, {
        operationId,
        rowVersion: rowVersionRef.current,
        answers: answersRef.current,
        additionalDirection: directionRef.current,
      });
    },
    onMutate: () => setOperationNotice(null),
    onSuccess: (updated) => {
      implementationOperationIdRef.current = null;
      queryClient.setQueryData(["task", chat.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["messages", chat.id] });
      void queryClient.invalidateQueries({
        queryKey: ["chats", chat.projectId],
      });
      void queryClient.invalidateQueries({ queryKey: ["goal", chat.id] });
    },
    onError: (error) => {
      if (isConflictError(error)) setConflict(true);
      setOperationNotice(errorMessage(error));
    },
  });

  const savePlan = async () => {
    if (!planDraft.trim()) {
      setOperationNotice("The plan cannot be empty.");
      return;
    }
    setOperationNotice(null);
    await saveReview
      .mutateAsync({
        additionalDirection,
        answers: [...answers],
        inputSignature,
        planMarkdown: planDraft,
      })
      .then(() => {
        setEditing(false);
        setPreviewingEdit(false);
      })
      .catch((error) => setOperationNotice(errorMessage(error)));
  };

  const missingRequired = unansweredRequiredTaskQuestions(
    task.currentQuestions,
    answers,
  );
  const immutableFinalizationPending =
    task.state === "failed" &&
    task.lastError?.operationKind === "finalize" &&
    Boolean(task.finalPlanMarkdown && task.goalPrompt);
  const dispatchActive = ["queued", "claimed", "running", "paused"].includes(
    task.dispatch?.state ?? "",
  );
  const dispatchQueued = task.dispatch?.state === "queued";
  const operationallyBlocked =
    conflict ||
    planDirty ||
    inputDirty ||
    saveReview.isPending ||
    continuePlanning.isPending ||
    beginImplementation.isPending ||
    retryPlanning.isPending ||
    chat.status === "running" ||
    immutableFinalizationPending ||
    dispatchActive;
  const reviewFieldsDisabled =
    conflict ||
    saveReview.isPending ||
    continuePlanning.isPending ||
    beginImplementation.isPending ||
    retryPlanning.isPending ||
    immutableFinalizationPending ||
    dispatchActive ||
    chat.status === "running";
  const saveLabel = taskReviewSaveLabel({
    conflict,
    dirty: inputDirty,
    failed: saveReview.isError && !conflict,
    saving: saveReview.isPending,
  });
  const failed = task.state === "failed";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {failed && task.lastError ? (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-destructive/30 bg-destructive/5 px-5 py-3 text-sm text-destructive">
          <CircleAlert className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">{task.lastError.message}</span>
          <Button
            disabled={
              !taskWorkerEncryptionCanAttempt(workerEncryptionReadiness) ||
              retryPlanning.isPending ||
              saveReview.isPending ||
              planDirty ||
              inputDirty ||
              conflict ||
              dispatchActive
            }
            size="sm"
            variant="outline"
            onClick={() => {
              retryOperationIdRef.current ??= crypto.randomUUID();
              retryPlanning.mutate(retryOperationIdRef.current);
            }}
          >
            {retryPlanning.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {task.lastError.operationKind === "finalize"
              ? "Retry implementation"
              : "Retry planning"}
          </Button>
          {immutableFinalizationPending ? (
            <span className="basis-full text-xs text-muted-foreground">
              The final plan is immutable. Retry resumes Goal startup without
              rerunning finalization.
            </span>
          ) : null}
        </div>
      ) : null}
      {dispatchQueued ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-violet-500/25 bg-violet-500/5 px-5 py-3 text-sm">
          <RefreshCw className="size-4 text-violet-500" />
          <span>
            Queued for the next Plan + Goal cycle. Review fields are locked once
            queued.
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
            This plan changed in another window. Copy your local plan or reload
            the newest server version.
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void navigator.clipboard.writeText(planDraft)}
          >
            <ClipboardCopy className="size-3.5" /> Copy local plan
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void onReload().then((next) => next && adoptServerTask(next))
            }
          >
            <RefreshCw className="size-3.5" /> Reload
          </Button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-5 py-5 sm:px-8 sm:py-7">
          <div className="flex flex-wrap items-center gap-2 border-b pb-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold">Implementation plan</h2>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Round {task.planningRound} · {task.currentQuestions.length} open
                question{task.currentQuestions.length === 1 ? "" : "s"}
                {task.planAuthorship !== "agent"
                  ? " · includes user edits"
                  : ""}
              </p>
            </div>
            {editing ? (
              <>
                <Button
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => setPreviewingEdit((current) => !current)}
                >
                  {previewingEdit ? (
                    <Pencil className="size-3.5" />
                  ) : (
                    <Eye className="size-3.5" />
                  )}
                  {previewingEdit ? "Edit" : "Preview"}
                </Button>
                <Button
                  disabled={saveReview.isPending}
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setPlanDraft(basePlanRef.current);
                    setEditing(false);
                    setPreviewingEdit(false);
                    setOperationNotice(null);
                  }}
                >
                  <Undo2 className="size-3.5" /> Cancel
                </Button>
                <Button
                  disabled={!planDirty || saveReview.isPending || conflict}
                  size="sm"
                  type="button"
                  onClick={() => void savePlan()}
                >
                  {saveReview.isPending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Save className="size-3.5" />
                  )}
                  Save plan
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                type="button"
                variant="outline"
                onClick={() => setEditing(true)}
              >
                <Pencil className="size-3.5" /> Edit Plan
              </Button>
            )}
          </div>

          <div
            className={cn(
              "min-h-96 py-6",
              editing && !previewingEdit && "h-[min(62vh,720px)] py-3",
            )}
          >
            {editing && !previewingEdit ? (
              <Suspense
                fallback={
                  <div className="grid h-full place-items-center text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" />
                  </div>
                }
              >
                <TaskMarkdownEditor
                  ariaLabel="Task plan"
                  onChange={setPlanDraft}
                  onSave={() => void savePlan()}
                  placeholder="Refine the implementation plan…"
                  value={planDraft}
                />
              </Suspense>
            ) : (
              <Markdown>{planDraft}</Markdown>
            )}
          </div>

          <section aria-labelledby="task-questions-heading" className="mt-4">
            <div className="mb-3">
              <h2 id="task-questions-heading" className="text-sm font-semibold">
                Planning questions
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Answers become input to the next planning or finalization pass.
              </p>
            </div>
            <TaskQuestionList
              answers={answers}
              disabled={reviewFieldsDisabled}
              onChange={(next) => {
                setAnswers(next);
                setShowValidation(false);
              }}
              questions={task.currentQuestions}
              showValidation={showValidation}
            />
          </section>

          <label className="mt-6 block">
            <span className="text-sm font-medium">Additional direction</span>
            <span className="ml-2 text-xs text-muted-foreground">
              Optional · applies to the next action
            </span>
            <textarea
              className="mt-2 min-h-28 w-full resize-y border bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-violet-500 disabled:opacity-60"
              disabled={reviewFieldsDisabled}
              maxLength={TASK_ADDITIONAL_DIRECTION_LIMIT}
              placeholder="Add constraints, corrections, or areas to investigate…"
              value={additionalDirection}
              onChange={(event) => setAdditionalDirection(event.target.value)}
            />
          </label>

          <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span
              className={cn(
                (conflict || saveReview.isError) && "text-destructive",
              )}
              role="status"
            >
              {saveLabel}
            </span>
            {planDirty ? (
              <span className="text-amber-500">
                Save or cancel the plan edit before continuing.
              </span>
            ) : null}
          </div>

          {operationNotice ? (
            <p className="mt-3 text-xs text-destructive" role="alert">
              {operationNotice}
            </p>
          ) : null}
          {showValidation && missingRequired.length > 0 ? (
            <p className="mt-3 text-xs text-destructive" role="alert">
              Answer {missingRequired.length} required question
              {missingRequired.length === 1 ? "" : "s"} before continuing.
            </p>
          ) : null}

          <div className="mt-6 flex flex-wrap justify-end gap-2 border-t pt-4">
            <Button
              disabled={operationallyBlocked}
              type="button"
              variant="outline"
              onClick={() => {
                setShowValidation(true);
                if (missingRequired.length === 0) {
                  continueOperationIdRef.current ??= crypto.randomUUID();
                  continuePlanning.mutate(continueOperationIdRef.current);
                }
              }}
            >
              {continuePlanning.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Continue Planning
            </Button>
            <Button
              disabled={operationallyBlocked}
              type="button"
              onClick={() => {
                setShowValidation(true);
                if (missingRequired.length === 0) {
                  implementationOperationIdRef.current ??= crypto.randomUUID();
                  beginImplementation.mutate(
                    implementationOperationIdRef.current,
                  );
                }
              }}
            >
              {beginImplementation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              Begin Implementation
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
