import type {
  GitInteractiveRebaseTodoAction,
  GitManagedOperationAction,
  GitManagedOperationRecord,
  GitMergeRebaseAction,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  GitMerge,
  GitPullRequestArrow,
  Loader2,
  Play,
  RotateCcw,
  SearchCheck,
  SkipForward,
  WandSparkles,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  amendProjectWorktreeGitOperation,
  controlProjectWorktreeGitOperation,
  getProjectWorktreeGitOperation,
  getProjectWorktreeRevisionCandidates,
  previewProjectWorktreeGitOperation,
  startProjectWorktreeGitOperation,
} from "@/lib/api";
import { useAppLiveStatus } from "@/lib/app-live-react";
import { liveResourceRefreshInterval } from "@/lib/live-resource-refresh";
import { cn } from "@/lib/utils";

import { GitPatchView } from "./git-patch-view";
import { GitConflictResolver } from "./git-conflict-resolver";
import { useReviewedOperation } from "./reviewed-operation";

type GitInteractiveRebaseAction = Extract<
  GitMergeRebaseAction,
  { type: "interactiveRebase" }
>;

const rewriteActions: GitInteractiveRebaseTodoAction[] = [
  "pick",
  "reword",
  "edit",
  "squash",
  "fixup",
  "drop",
];

export function gitOperationEditorRef(
  action: GitManagedOperationAction | null,
): string {
  if (!action) return "";
  if (action.type === "bisect") return action.goodRef;
  return action.type === "interactiveRebase"
    ? action.upstreamRef
    : action.sourceRef;
}

function withGitOperationEditorRef(
  action: GitManagedOperationAction,
  value: string,
): GitManagedOperationAction {
  if (action.type === "bisect") return { ...action, goodRef: value };
  return action.type === "interactiveRebase"
    ? { ...action, upstreamRef: value }
    : { ...action, sourceRef: value };
}

export function gitOperationIsActive(
  operation: GitManagedOperationRecord | null | undefined,
): boolean {
  return Boolean(
    operation &&
    ["queued", "running", "conflicted", "awaiting-user-action"].includes(
      operation.state,
    ),
  );
}

export function gitOperationControlActions(
  operation: GitManagedOperationRecord,
): Array<"continue" | "skip" | "abort" | "good" | "bad" | "reset"> {
  if (!gitOperationIsActive(operation)) return [];
  if (operation.type === "bisect") return ["good", "bad", "skip", "reset"];
  return operation.type === "merge" || operation.type === "stash"
    ? ["continue", "abort"]
    : ["continue", "skip", "abort"];
}

export function gitOperationSourceLabel(
  operation: GitManagedOperationRecord,
): string {
  if (operation.type === "bisect") {
    return `Good ${operation.sourceRef ?? operation.sourceRevision ?? "?"} · Bad ${operation.targetRevision.slice(0, 10)}`;
  }
  if (operation.type !== "stash") {
    return operation.sourceRef ?? operation.sourceRevision ?? "Recorded action";
  }
  const source = operation.sourceRef ?? "stash";
  const [action, ...rest] = source.split(":");
  return `${action === "branch" ? "Create branch from" : action} ${rest.at(-1) ?? "stash"}`;
}

function OperationState({
  operation,
}: {
  operation: GitManagedOperationRecord;
}) {
  const active = gitOperationIsActive(operation);
  const Icon =
    operation.state === "completed"
      ? Check
      : operation.state === "conflicted"
        ? AlertTriangle
        : operation.state === "aborted" || operation.state === "failed"
          ? X
          : Loader2;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
        operation.state === "completed"
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : operation.state === "conflicted"
            ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
            : operation.state === "failed"
              ? "bg-destructive/10 text-destructive"
              : "bg-muted text-muted-foreground",
      )}
    >
      <Icon
        className={cn(
          "size-3",
          active && operation.state === "running" && "animate-spin",
        )}
      />
      {operation.state}
    </span>
  );
}

export function GitOperationPanel({
  initialAction,
  onClose,
  onOpenWorkingChanges,
  projectId,
  worktreeId,
}: {
  initialAction: GitMergeRebaseAction | null;
  onClose(): void;
  onOpenWorkingChanges(): void;
  projectId: string;
  worktreeId: string;
}) {
  const queryClient = useQueryClient();
  const gitResourcesLive = useAppLiveStatus() === "live";
  const [editor, setEditor] = useState<GitManagedOperationAction | null>(
    initialAction,
  );
  const [amendMessage, setAmendMessage] = useState("");
  useEffect(() => {
    if (initialAction) setEditor(initialAction);
  }, [initialAction]);
  const operation = useQuery({
    queryKey: ["git-operation", projectId, worktreeId],
    queryFn: () => getProjectWorktreeGitOperation(projectId, worktreeId),
    refetchInterval: (query) =>
      gitOperationIsActive(query.state.data?.operation)
        ? liveResourceRefreshInterval(gitResourcesLive, 2_000)
        : false,
  });
  const refs = useQuery({
    queryKey: ["worktree-revision-candidates", projectId, worktreeId],
    queryFn: () => getProjectWorktreeRevisionCandidates(projectId, worktreeId),
  });
  const reviewedOperation = useReviewedOperation({
    preview: (action: GitManagedOperationAction) =>
      previewProjectWorktreeGitOperation(projectId, worktreeId, action),
    apply: ({ preview, request }) =>
      startProjectWorktreeGitOperation(
        projectId,
        worktreeId,
        request,
        preview.token,
      ),
    missingReviewMessage: "Review the operation first.",
    requestsEqual: (left, right) =>
      JSON.stringify(left) === JSON.stringify(right),
    resolveReviewedRequest: (_request, preview) => preview.action,
    onSuccess: (result) => {
      queryClient.setQueryData(
        ["git-operation", projectId, worktreeId],
        result,
      );
      setEditor(null);
      invalidateGitQueries();
    },
  });
  const reviewedAction = reviewedOperation.request;
  const preview = reviewedOperation.preview;
  const start = reviewedOperation.apply;
  const control = useMutation({
    mutationFn: (
      action: "continue" | "skip" | "abort" | "good" | "bad" | "reset",
    ) => {
      const current = operation.data?.operation;
      if (!current) throw new Error("No active Git operation was found.");
      return controlProjectWorktreeGitOperation(
        projectId,
        worktreeId,
        current.id,
        action,
      );
    },
    onSuccess: (result) => {
      queryClient.setQueryData(
        ["git-operation", projectId, worktreeId],
        result,
      );
      invalidateGitQueries();
    },
  });
  const amend = useMutation({
    mutationFn: () => {
      const current = operation.data?.operation;
      if (!current) throw new Error("No active Git operation was found.");
      return amendProjectWorktreeGitOperation(
        projectId,
        worktreeId,
        current.id,
        amendMessage.trim() || null,
      );
    },
    onSuccess: (result) => {
      queryClient.setQueryData(
        ["git-operation", projectId, worktreeId],
        result,
      );
      setAmendMessage("");
      invalidateGitQueries();
    },
  });
  const invalidateGitQueries = () => {
    void queryClient.invalidateQueries({
      queryKey: ["worktree-status", projectId, worktreeId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["worktree-history", projectId, worktreeId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["worktree-branches", projectId, worktreeId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["worktree-revision-candidates", projectId, worktreeId],
    });
  };
  const current = operation.data?.operation ?? null;
  const active = gitOperationIsActive(current);
  const interactiveEdit =
    current?.type === "rebase" &&
    current.state === "awaiting-user-action" &&
    current.pausedAction === "edit";
  const candidates = useMemo(
    () =>
      (refs.data ?? []).filter(
        (candidate, index, all) =>
          !candidate.current &&
          all.findIndex(({ name }) => name === candidate.name) === index,
      ),
    [refs.data],
  );
  const submitEditor = (event: FormEvent) => {
    event.preventDefault();
    if (editor?.type === "bisect") {
      if (!editor.goodRef.trim() || !editor.badRef.trim()) return;
      reviewedOperation.review(editor);
      return;
    }
    const selectedRef = gitOperationEditorRef(editor).trim();
    if (!editor || !selectedRef) return;
    const action = withGitOperationEditorRef(editor, selectedRef);
    reviewedOperation.review(action);
  };
  const updateInteractiveTodo = (
    update: (action: GitInteractiveRebaseAction) => GitInteractiveRebaseAction,
  ) => {
    if (reviewedAction?.type === "interactiveRebase") {
      reviewedOperation.updateRequest(update(reviewedAction));
    }
  };
  const previewMatchesAction = reviewedOperation.previewMatchesRequest;

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-full min-w-0 flex-col border-l bg-background shadow-2xl md:w-[min(48rem,78vw)]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <GitPullRequestArrow className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Git operations</p>
          <p className="truncate text-[10px] text-muted-foreground">
            Durable merge, rebase, bisect, stash, and conflict progress
          </p>
        </div>
        {!active ? (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() => setEditor({ type: "merge", sourceRef: "" })}
            >
              <GitMerge className="size-3.5" /> Merge
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() => setEditor({ type: "rebase", sourceRef: "" })}
            >
              <GitPullRequestArrow className="size-3.5" /> Rebase
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() =>
                setEditor({
                  type: "interactiveRebase",
                  upstreamRef: "",
                  todo: [],
                })
              }
            >
              <WandSparkles className="size-3.5" /> Rewrite
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() =>
                setEditor({ type: "bisect", goodRef: "", badRef: "HEAD" })
              }
            >
              <SearchCheck className="size-3.5" /> Bisect
            </Button>
          </>
        ) : null}
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          onClick={onClose}
        >
          <X className="size-4" />
          <span className="sr-only">Close Git operations</span>
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {operation.isLoading ? (
          <div className="grid h-48 place-items-center text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : operation.error ? (
          <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {operation.error instanceof Error
              ? operation.error.message
              : "Git operation state could not be loaded."}
          </p>
        ) : current ? (
          <div className="space-y-4">
            <div className="rounded-xl border p-4">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold capitalize">
                  {current.type}
                </p>
                <OperationState operation={current} />
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  {current.currentHead.slice(0, 10)}
                </span>
              </div>
              <p className="mt-2 break-all text-xs text-muted-foreground">
                {gitOperationSourceLabel(current)}
                {current.targetRef
                  ? ` → ${current.targetRef.replace(/^refs\/heads\//u, "")}`
                  : ""}
              </p>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{
                    width: `${Math.min(100, (current.currentStep / current.totalSteps) * 100)}%`,
                  }}
                />
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Step {current.currentStep} of {current.totalSteps} ·{" "}
                {current.pendingCommits.length} pending
              </p>
              {current.checkpointRef ? (
                <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">
                  Recovery: {current.checkpointRef}
                </p>
              ) : null}
            </div>

            {current.conflictedPaths.length ? (
              <div className="space-y-2">
                <GitConflictResolver
                  projectId={projectId}
                  worktreeId={worktreeId}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onOpenWorkingChanges}
                >
                  Open Working changes
                </Button>
              </div>
            ) : null}

            {interactiveEdit ? (
              <div className="space-y-3 rounded-xl border p-4">
                <div>
                  <p className="text-sm font-medium">Edit step paused</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Change files and stage them in Working changes, optionally
                    replace the commit message, then amend and continue.
                  </p>
                </div>
                <textarea
                  className="min-h-20 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder="Replacement commit message (optional)"
                  value={amendMessage}
                  onChange={(event) => setAmendMessage(event.target.value)}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onOpenWorkingChanges}
                  >
                    Open Working changes
                  </Button>
                  <Button
                    size="sm"
                    disabled={amend.isPending}
                    onClick={() => amend.mutate()}
                  >
                    {amend.isPending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : null}
                    Amend and continue
                  </Button>
                </div>
                {amend.error ? (
                  <p className="text-xs text-destructive">
                    {amend.error instanceof Error
                      ? amend.error.message
                      : "The edit step could not be amended."}
                  </p>
                ) : null}
              </div>
            ) : null}

            {active ? (
              <div className="flex flex-wrap gap-2">
                {gitOperationControlActions(current).map((action) => (
                  <Button
                    key={action}
                    size="sm"
                    variant="outline"
                    className={
                      action === "abort" || action === "reset"
                        ? "border-destructive/40 text-destructive hover:bg-destructive/10"
                        : undefined
                    }
                    disabled={
                      control.isPending ||
                      (action === "continue" &&
                        current.conflictedPaths.length > 0)
                    }
                    onClick={() => control.mutate(action)}
                  >
                    {action === "continue" ? (
                      <Play className="size-3.5" />
                    ) : action === "good" || action === "bad" ? (
                      <Check className="size-3.5" />
                    ) : action === "skip" ? (
                      <SkipForward className="size-3.5" />
                    ) : (
                      <RotateCcw className="size-3.5" />
                    )}
                    <span className="capitalize">
                      {action === "reset" ? "Reset bisect" : action}
                    </span>
                  </Button>
                ))}
              </div>
            ) : null}
            {control.error ? (
              <p className="text-sm text-destructive">
                {control.error instanceof Error
                  ? control.error.message
                  : "Git operation control failed."}
              </p>
            ) : null}
            {current.error ? (
              <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                {current.error}
              </p>
            ) : null}
            {current.output ? (
              <pre className="max-h-64 overflow-auto rounded-xl bg-muted/30 p-3 text-[11px] whitespace-pre-wrap text-muted-foreground">
                {current.output}
              </pre>
            ) : null}
          </div>
        ) : (
          <div className="grid h-48 place-items-center text-center text-sm text-muted-foreground">
            No durable Git operation has been recorded for this worktree yet.
          </div>
        )}
      </div>

      <Dialog
        open={Boolean(editor)}
        onOpenChange={(open) => {
          if (!open && !start.isPending) {
            setEditor(null);
            reviewedOperation.reset();
          }
        }}
      >
        <DialogContent className="flex max-h-[92vh] max-w-3xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="capitalize">
              {editor?.type === "interactiveRebase"
                ? "Rewrite current branch"
                : editor?.type === "bisect"
                  ? "Bisect history"
                  : `${editor?.type ?? "Git"} current branch`}
            </DialogTitle>
            <DialogDescription>
              Select the source, review the exact effect, then start the durable
              operation.
            </DialogDescription>
          </DialogHeader>
          {!reviewedAction ? (
            <form onSubmit={submitEditor}>
              <div className="grid gap-3 py-4">
                {editor?.type === "bisect" ? (
                  <>
                    <label className="grid gap-1 text-xs">
                      <span>Known-good revision</span>
                      <input
                        autoFocus
                        list="git-operation-refs"

                        placeholder="Tag, branch, or commit"
                        value={editor.goodRef}
                        onChange={(event) =>
                          setEditor({ ...editor, goodRef: event.target.value })
                        }
                      />
                    </label>
                    <label className="grid gap-1 text-xs">
                      <span>Known-bad revision</span>
                      <input
                        list="git-operation-refs"

                        placeholder="HEAD"
                        value={editor.badRef}
                        onChange={(event) =>
                          setEditor({ ...editor, badRef: event.target.value })
                        }
                      />
                    </label>
                    <datalist id="git-operation-refs">
                      {candidates.map((candidate) => (
                        <option
                          key={`${candidate.kind}:${candidate.name}`}
                          value={candidate.name}
                        >
                          {candidate.shortHash}
                        </option>
                      ))}
                    </datalist>
                  </>
                ) : (
                  <>
                    <NativeSelect
                      autoFocus
                      aria-label="Operation source ref"

                      value={gitOperationEditorRef(editor)}
                      onChange={(event) =>
                        editor &&
                        setEditor(
                          withGitOperationEditorRef(editor, event.target.value),
                        )
                      }
                    >
                      <option value="">Select a branch or tag</option>
                      {candidates.map((candidate) => (
                        <option
                          key={`${candidate.kind}:${candidate.name}`}
                          value={candidate.name}
                        >
                          {candidate.name} · {candidate.shortHash}
                        </option>
                      ))}
                    </NativeSelect>
                    <input
                      placeholder="Or enter a revision"
                      value={gitOperationEditorRef(editor)}
                      onChange={(event) =>
                        editor &&
                        setEditor(
                          withGitOperationEditorRef(editor, event.target.value),
                        )
                      }
                    />
                  </>
                )}
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditor(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={
                    editor?.type === "bisect"
                      ? !editor.goodRef.trim() || !editor.badRef.trim()
                      : !gitOperationEditorRef(editor).trim()
                  }
                >
                  {editor?.type === "interactiveRebase"
                    ? "Load commit plan"
                    : editor?.type === "bisect"
                      ? "Review bisect"
                      : "Review operation"}
                </Button>
              </DialogFooter>
            </form>
          ) : preview.isPending ? (
            <div className="grid h-64 place-items-center">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : preview.error ? (
            <div className="space-y-4">
              <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                {preview.error instanceof Error
                  ? preview.error.message
                  : "Operation preview failed."}
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={reviewedOperation.reset}>
                  Back
                </Button>
              </DialogFooter>
            </div>
          ) : preview.data ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
              {preview.data.publishedRefs.length > 0 ? (
                <div className="shrink-0 rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm">
                  <p className="flex items-center gap-2 font-semibold text-destructive">
                    <AlertTriangle className="size-4" /> Published history will
                    be rewritten
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    These commits are already reachable from{" "}
                    {preview.data.publishedRefs.join(", ")}. Cantrip will not
                    update those refs automatically; doing so requires a
                    separate reviewed force-with-lease push.
                  </p>
                </div>
              ) : null}
              {reviewedAction?.type === "interactiveRebase" ? (
                <div className="min-h-0 shrink overflow-auto rounded-lg border">
                  <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium">Interactive todo</p>
                      <p className="text-[10px] text-muted-foreground">
                        Reorder every selected commit and choose how Git
                        rewrites it.
                      </p>
                    </div>
                    {!previewMatchesAction ? (
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        disabled={preview.isPending}
                        onClick={() => reviewedOperation.review(reviewedAction)}
                      >
                        Validate plan
                      </Button>
                    ) : (
                      <span className="text-[10px] text-emerald-600">
                        Validated
                      </span>
                    )}
                  </div>
                  <div className="divide-y">
                    {reviewedAction.todo.map((item, index) => {
                      const commit = preview.data.commits.find(
                        ({ hash }) => hash === item.revision,
                      );
                      return (
                        <div
                          key={item.revision}
                          className="grid grid-cols-[auto_7rem_minmax(0,1fr)] items-start gap-2 px-2 py-2"
                        >
                          <div className="flex pt-0.5">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-6"
                              disabled={index === 0}
                              onClick={() =>
                                updateInteractiveTodo((current) => {
                                  const todo = [...current.todo];
                                  [todo[index - 1], todo[index]] = [
                                    todo[index]!,
                                    todo[index - 1]!,
                                  ];
                                  return { ...current, todo };
                                })
                              }
                            >
                              <ArrowUp className="size-3" />
                              <span className="sr-only">Move commit up</span>
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-6"
                              disabled={
                                index === reviewedAction.todo.length - 1
                              }
                              onClick={() =>
                                updateInteractiveTodo((current) => {
                                  const todo = [...current.todo];
                                  [todo[index], todo[index + 1]] = [
                                    todo[index + 1]!,
                                    todo[index]!,
                                  ];
                                  return { ...current, todo };
                                })
                              }
                            >
                              <ArrowDown className="size-3" />
                              <span className="sr-only">Move commit down</span>
                            </Button>
                          </div>
                          <NativeSelect
                            aria-label={`Action for ${commit?.shortHash ?? item.revision.slice(0, 10)}`}
                            className="h-7 rounded border bg-background px-2 text-xs"
                            value={item.action}
                            onChange={(event) =>
                              updateInteractiveTodo((current) => ({
                                ...current,
                                todo: current.todo.map(
                                  (candidate, itemIndex) =>
                                    itemIndex === index
                                      ? {
                                          ...candidate,
                                          action: event.target
                                            .value as GitInteractiveRebaseTodoAction,
                                          message:
                                            event.target.value === "reword"
                                              ? (candidate.message ??
                                                commit?.subject ??
                                                "Reworded commit")
                                              : null,
                                        }
                                      : candidate,
                                ),
                              }))
                            }
                          >
                            {rewriteActions.map((action) => (
                              <option key={action} value={action}>
                                {action}
                              </option>
                            ))}
                          </NativeSelect>
                          <div className="min-w-0">
                            <p className="truncate text-xs">
                              {commit?.subject ?? item.revision}
                              <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                                {commit?.shortHash ??
                                  item.revision.slice(0, 10)}
                              </span>
                            </p>
                            {item.action === "reword" ? (
                              <textarea
                                className="mt-1 min-h-14 w-full resize-y rounded border bg-background px-2 py-1 text-xs"
                                value={item.message ?? ""}
                                onChange={(event) =>
                                  updateInteractiveTodo((current) => ({
                                    ...current,
                                    todo: current.todo.map(
                                      (candidate, itemIndex) =>
                                        itemIndex === index
                                          ? {
                                              ...candidate,
                                              message: event.target.value,
                                            }
                                          : candidate,
                                    ),
                                  }))
                                }
                              />
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              <div className="shrink-0 space-y-1 rounded-lg bg-muted/30 p-3 text-xs">
                <p className="font-medium">{preview.data.summary}</p>
                <p className="text-muted-foreground">
                  {preview.data.context.totalSteps} steps ·{" "}
                  {preview.data.files.length} affected files
                </p>
                {preview.data.warnings.map((warning) => (
                  <p
                    key={warning}
                    className="text-amber-700 dark:text-amber-300"
                  >
                    {warning}
                  </p>
                ))}
                {preview.data.context.checkpointRef ? (
                  <p className="break-all font-mono text-muted-foreground">
                    Recovery: {preview.data.context.checkpointRef}
                  </p>
                ) : null}
                {preview.data.todoText ? (
                  <details className="pt-1">
                    <summary className="cursor-pointer font-medium">
                      Exact validated Git todo
                    </summary>
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-background p-2 font-mono text-[10px]">
                      {preview.data.todoText}
                    </pre>
                  </details>
                ) : null}
              </div>
              <div className="min-h-64 flex-1 overflow-hidden rounded-lg border">
                <GitPatchView
                  error={null}
                  loading={false}
                  newLabel="After operation"
                  oldLabel="Current HEAD"
                  onClose={() => undefined}
                  patch={preview.data.patch}
                  path={`${reviewedAction.type} preview`}
                  showClose={false}
                  subtitle="Exact selected-worktree patch"
                  truncated={preview.data.patchTruncated}
                />
              </div>
              {start.error ? (
                <p className="text-sm text-destructive">
                  {start.error instanceof Error
                    ? start.error.message
                    : "Git operation failed to start."}
                </p>
              ) : null}
              <DialogFooter className="shrink-0">
                <Button
                  variant="outline"
                  disabled={start.isPending}
                  onClick={reviewedOperation.reset}
                >
                  Back
                </Button>
                <Button
                  disabled={start.isPending || !previewMatchesAction}
                  className={
                    preview.data.destructive
                      ? "bg-destructive text-white hover:bg-destructive/90"
                      : undefined
                  }
                  onClick={reviewedOperation.applyReviewed}
                >
                  {start.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : null}
                  Start{" "}
                  {reviewedAction.type === "interactiveRebase"
                    ? "rewrite"
                    : reviewedAction.type}
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </aside>
  );
}
