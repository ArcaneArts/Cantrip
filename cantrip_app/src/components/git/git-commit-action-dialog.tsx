import type { GitCommitAction, GitCommitActionResult } from "@cantrip/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

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
import { Input } from "@/components/ui/input";
import {
  applyProjectWorktreeCommitAction,
  previewProjectWorktreeCommitAction,
} from "@/lib/api";

import { GitPatchView } from "./git-patch-view";
import { useReviewedOperation } from "./reviewed-operation";

export type CommitActionKind = "cherryPick" | "revert" | "amend" | "fixup";

export interface CommitActionTarget {
  hash: string;
  shortHash: string;
  subject: string;
  parents: string[];
  isHead: boolean;
}

export interface CommitActionRequest {
  kind: CommitActionKind;
  target: CommitActionTarget;
}

export interface CommitActionEditor {
  range: boolean;
  fromRevision: string;
  toRevision: string;
  mainlineParent: number | null;
  message: string;
}

export function commitActionFromEditor(
  request: CommitActionRequest,
  editor: CommitActionEditor,
): GitCommitAction {
  switch (request.kind) {
    case "cherryPick":
      return {
        type: "cherryPick",
        selection: editor.range
          ? {
              type: "range",
              fromRevision: editor.fromRevision,
              toRevision: editor.toRevision,
            }
          : { type: "commits", revisions: [request.target.hash] },
      };
    case "revert":
      return {
        type: "revert",
        revision: request.target.hash,
        mainlineParent: editor.mainlineParent,
      };
    case "amend":
      return {
        type: "amend",
        message: editor.message.trim() || null,
      };
    case "fixup":
      return { type: "fixup", revision: request.target.hash };
  }
}

function titleFor(kind: CommitActionKind): string {
  switch (kind) {
    case "cherryPick":
      return "Cherry-pick commit";
    case "revert":
      return "Revert commit";
    case "amend":
      return "Amend HEAD";
    case "fixup":
      return "Create fixup commit";
  }
}

export function GitCommitActionDialog({
  onConflict,
  onOpenChange,
  projectId,
  request,
  worktreeId,
}: {
  onConflict(paths: string[]): void;
  onOpenChange(open: boolean): void;
  projectId: string;
  request: CommitActionRequest | null;
  worktreeId: string;
}) {
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<CommitActionEditor>({
    range: false,
    fromRevision: "",
    toRevision: "",
    mainlineParent: null,
    message: "",
  });
  const [result, setResult] = useState<GitCommitActionResult | null>(null);
  const reviewedOperation = useReviewedOperation({
    preview: (action: GitCommitAction) =>
      previewProjectWorktreeCommitAction(projectId, worktreeId, action),
    apply: ({ preview, request: action }) =>
      applyProjectWorktreeCommitAction(
        projectId,
        worktreeId,
        action,
        preview.token,
      ),
    missingReviewMessage: "Review the commit action first.",
    onSuccess: (next) => {
      queryClient.setQueryData(
        ["worktree-status", projectId, worktreeId],
        next.status,
      );
      void queryClient.invalidateQueries({
        queryKey: ["worktree-history", projectId, worktreeId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["worktree-commit", projectId, worktreeId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["worktree-revision-candidates", projectId, worktreeId],
      });
      if (
        next.operation &&
        next.operation.state !== "completed" &&
        next.operation.state !== "aborted"
      ) {
        setResult(next);
      } else {
        onOpenChange(false);
      }
    },
  });
  useEffect(() => {
    setEditor({
      range: false,
      fromRevision: request?.target.hash ?? "",
      toRevision: request?.target.hash ?? "",
      mainlineParent:
        request?.kind === "revert" && request.target.parents.length > 1
          ? 1
          : null,
      message: "",
    });
    reviewedOperation.reset();
    setResult(null);
  }, [request]);
  const reviewedAction = reviewedOperation.request;
  const preview = reviewedOperation.preview;
  const apply = reviewedOperation.apply;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!request) return;
    const action = commitActionFromEditor(request, editor);
    setResult(null);
    reviewedOperation.review(action);
  };
  const invalidRange =
    editor.range &&
    (!/^[0-9a-f]{40,64}$/u.test(editor.fromRevision) ||
      !/^[0-9a-f]{40,64}$/u.test(editor.toRevision));
  const conflictPaths = result?.operation?.conflictedPaths ?? [];

  return (
    <Dialog open={Boolean(request)} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {request ? titleFor(request.kind) : "Commit action"}
          </DialogTitle>
          <DialogDescription>
            {request
              ? `${request.target.shortHash} · ${request.target.subject}`
              : "Review this Git operation."}
          </DialogDescription>
        </DialogHeader>

        {result?.operation ? (
          <div className="grid min-h-0 gap-4 overflow-auto">
            <div className="rounded-lg bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
              <p className="flex items-center gap-2 font-medium">
                <AlertTriangle className="size-4" />
                {result.operation.state === "conflicted"
                  ? "Commit action needs conflict resolution"
                  : "Commit action is awaiting a Git decision"}
              </p>
              <p className="mt-1 text-xs">
                Step {result.operation.currentStep} of{" "}
                {result.operation.totalSteps} is preserved in the selected
                worktree.
              </p>
              {conflictPaths.length ? (
                <p className="mt-2 break-all font-mono text-xs">
                  {conflictPaths.join(", ")}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                onClick={() => {
                  onConflict(conflictPaths);
                  onOpenChange(false);
                }}
              >
                Open Working changes
              </Button>
            </DialogFooter>
          </div>
        ) : reviewedAction ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
            {preview.isPending ? (
              <div className="grid h-48 place-items-center">
                <Loader2 className="size-5 animate-spin" />
              </div>
            ) : preview.error ? (
              <p className="overflow-auto rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                {preview.error instanceof Error
                  ? preview.error.message
                  : "Commit action preview failed."}
              </p>
            ) : preview.data ? (
              <>
                <div className="shrink-0 space-y-1 rounded-lg bg-muted/30 p-3 text-xs">
                  <p className="font-medium">{preview.data.summary}</p>
                  <p className="text-muted-foreground">
                    {preview.data.resolvedRevisions.length} commit selection ·{" "}
                    {preview.data.files.length} affected files
                  </p>
                  {preview.data.wouldConflict ? (
                    <p className="text-amber-700 dark:text-amber-300">
                      This preview produces conflicts. Apply only if you want to
                      enter the resolution workflow.
                    </p>
                  ) : null}
                  {preview.data.checkpointRef ? (
                    <p className="break-all font-mono text-muted-foreground">
                      Recovery: {preview.data.checkpointRef}
                    </p>
                  ) : null}
                  {preview.data.warnings.map((warning) => (
                    <p
                      key={warning}
                      className="text-amber-700 dark:text-amber-300"
                    >
                      {warning}
                    </p>
                  ))}
                </div>
                <div className="min-h-64 flex-1 overflow-hidden rounded-lg border">
                  <GitPatchView
                    error={null}
                    loading={false}
                    newLabel="After action"
                    oldLabel="Current HEAD"
                    onClose={() => undefined}
                    patch={preview.data.patch}
                    path="Commit action preview"
                    showClose={false}
                    subtitle="Exact selected-worktree patch"
                    truncated={preview.data.patchTruncated}
                  />
                </div>
              </>
            ) : null}
            {apply.error ? (
              <p className="shrink-0 text-sm text-destructive">
                {apply.error instanceof Error
                  ? apply.error.message
                  : "Commit action failed."}
              </p>
            ) : null}
            <DialogFooter className="shrink-0">
              <Button
                variant="outline"
                disabled={apply.isPending}
                onClick={reviewedOperation.reset}
              >
                Back
              </Button>
              <Button
                disabled={!preview.data || apply.isPending}
                className={
                  preview.data?.destructive
                    ? "bg-destructive text-white hover:bg-destructive/90"
                    : undefined
                }
                onClick={reviewedOperation.applyReviewed}
              >
                {apply.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                Apply action
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="grid gap-4 py-3">
              {request?.kind === "cherryPick" ? (
                <>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={editor.range}
                      onChange={(event) =>
                        setEditor({ ...editor, range: event.target.checked })
                      }
                    />
                    Cherry-pick an inclusive ancestry range
                  </label>
                  {editor.range ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Input
                        aria-label="First commit"
                        placeholder="First full commit hash"
                        className="font-mono text-xs"
                        value={editor.fromRevision}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            fromRevision: event.target.value.trim(),
                          })
                        }
                      />
                      <Input
                        aria-label="Last commit"
                        placeholder="Last full commit hash"
                        className="font-mono text-xs"
                        value={editor.toRevision}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            toRevision: event.target.value.trim(),
                          })
                        }
                      />
                    </div>
                  ) : null}
                </>
              ) : request?.kind === "revert" &&
                request.target.parents.length > 1 ? (
                <label className="grid gap-1 text-sm">
                  Mainline parent
                  <NativeSelect
                    className="h-9 rounded-md border bg-background px-3"
                    value={editor.mainlineParent ?? 1}
                    onChange={(event) =>
                      setEditor({
                        ...editor,
                        mainlineParent: Number(event.target.value),
                      })
                    }
                  >
                    {request.target.parents.map((parent, index) => (
                      <option key={parent} value={index + 1}>
                        Parent {index + 1} · {parent.slice(0, 10)}
                      </option>
                    ))}
                  </NativeSelect>
                  <span className="text-xs text-muted-foreground">
                    Git keeps this parent's side and reverses the merge relative
                    to it.
                  </span>
                </label>
              ) : request?.kind === "amend" ? (
                <label className="grid gap-1 text-sm">
                  Replacement message (optional)
                  <textarea
                    className="min-h-32 rounded-md border bg-background p-3"
                    placeholder="Leave blank to keep the current message and amend staged changes"
                    value={editor.message}
                    onChange={(event) =>
                      setEditor({ ...editor, message: event.target.value })
                    }
                  />
                  <span className="text-xs text-muted-foreground">
                    Amend is available only for current HEAD. Cantrip creates a
                    recovery ref first.
                  </span>
                </label>
              ) : request?.kind === "fixup" ? (
                <p className="rounded-lg bg-muted/30 p-3 text-sm text-muted-foreground">
                  The currently staged changes become a <code>fixup!</code>{" "}
                  commit targeting this revision. Unstaged changes block the
                  operation.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  The selected commit's inverse patch will be previewed against
                  current HEAD.
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={invalidRange}>
                Preview exact effect
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
