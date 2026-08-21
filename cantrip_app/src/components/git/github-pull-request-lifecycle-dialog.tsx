import type {
  GithubPullRequestDetail,
  GithubPullRequestLifecycleAction,
  GithubPullRequestLifecyclePreview,
} from "@cantrip/protocol";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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
  applyGithubPullRequestLifecycle,
  previewGithubPullRequestLifecycle,
} from "@/lib/api";
import { errorMessage } from "@/lib/error-message";

import { useReviewedOperation } from "./reviewed-operation";

export function pullRequestLifecycleLabel(
  action: GithubPullRequestLifecycleAction,
): string {
  switch (action.type) {
    case "close":
      return "Close pull request";
    case "reopen":
      return "Reopen pull request";
    case "mark-ready":
      return "Mark ready for review";
    case "merge":
      return `${action.method[0]!.toUpperCase()}${action.method.slice(1)} pull request`;
  }
}

export function lifecycleConfirmationMatches(
  preview: GithubPullRequestLifecyclePreview,
  confirmation: string,
): boolean {
  return (
    preview.confirmationPhrase === null ||
    preview.confirmationPhrase === confirmation
  );
}

function errorText(error: unknown): string {
  return errorMessage(error, "The pull request action failed.");
}

export function GithubPullRequestLifecycleDialog({
  action: initialAction,
  onApplied,
  onOpenChange,
  projectId,
  pullRequestNumber,
  worktreeId,
}: {
  action: GithubPullRequestLifecycleAction | null;
  onApplied(detail: GithubPullRequestDetail): void;
  onOpenChange(open: boolean): void;
  projectId: string;
  pullRequestNumber: number;
  worktreeId: string;
}) {
  const [method, setMethod] = useState<"merge" | "squash" | "rebase">(
    initialAction?.type === "merge" ? initialAction.method : "squash",
  );
  const [commitTitle, setCommitTitle] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const action = useMemo<GithubPullRequestLifecycleAction | null>(
    () =>
      initialAction?.type === "merge"
        ? {
            type: "merge",
            method,
            commitTitle: commitTitle.trim() || null,
            commitMessage: commitMessage.trim() || null,
          }
        : initialAction,
    [commitMessage, commitTitle, initialAction, method],
  );
  const reviewedOperation = useReviewedOperation({
    preview: (input: GithubPullRequestLifecycleAction) =>
      previewGithubPullRequestLifecycle(
        projectId,
        worktreeId,
        pullRequestNumber,
        input,
      ),
    apply: ({ preview: review }) =>
      applyGithubPullRequestLifecycle(
        projectId,
        worktreeId,
        pullRequestNumber,
        {
          action: review.action,
          token: review.token,
          confirmation,
        },
      ),
    onSuccess: (detail) => {
      onApplied(detail);
      onOpenChange(false);
    },
  });
  const preview = reviewedOperation.preview;
  const apply = reviewedOperation.apply;
  useEffect(() => {
    if (!initialAction) return;
    setMethod(initialAction.type === "merge" ? initialAction.method : "squash");
    setCommitTitle("");
    setCommitMessage("");
    setConfirmation("");
    reviewedOperation.reset();
  }, [initialAction]);
  const reviewed = preview.data;
  const pending = reviewedOperation.busy;

  return (
    <Dialog
      open={initialAction !== null}
      onOpenChange={(open) => {
        if (!open && apply.isPending) return;
        if (!open) reviewedOperation.reset();
        onOpenChange(open);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {action ? pullRequestLifecycleLabel(action) : "Pull request action"}
          </DialogTitle>
          <DialogDescription>
            Cantrip re-fetches the pull request before applying the exact
            reviewed action. Any changed head, base, checks, reviews, or state
            invalidates this preview.
          </DialogDescription>
        </DialogHeader>

        {!reviewed ? (
          <div className="space-y-4">
            {action?.type === "merge" ? (
              <>
                <label className="block text-xs font-medium">
                  Merge method
                  <NativeSelect
                    className="mt-1 w-full px-2"
                    value={method}
                    onChange={(event) =>
                      setMethod(
                        event.target.value as "merge" | "squash" | "rebase",
                      )
                    }
                  >
                    <option value="merge">Merge commit</option>
                    <option value="squash">Squash and merge</option>
                    <option value="rebase">Rebase and merge</option>
                  </NativeSelect>
                </label>
                <label className="block text-xs font-medium">
                  Commit title (optional)
                  <input
                    className="mt-1 w-full"
                    value={commitTitle}
                    onChange={(event) => setCommitTitle(event.target.value)}
                  />
                </label>
                <label className="block text-xs font-medium">
                  Commit message (optional)
                  <textarea
                    className="mt-1 min-h-24 w-full resize-y rounded-md border bg-background p-3 text-sm"
                    value={commitMessage}
                    onChange={(event) => setCommitMessage(event.target.value)}
                  />
                </label>
              </>
            ) : null}
            {preview.error ? (
              <p className="text-sm text-destructive">
                {errorText(preview.error)}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                disabled={pending || !action}
                onClick={() => action && reviewedOperation.review(action)}
              >
                {preview.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                Review action
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg bg-muted/30 p-3 text-sm">
              <p className="font-medium">
                #{reviewed.number} {reviewed.title}
              </p>
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                {reviewed.headRef} {reviewed.headSha.slice(0, 7)} →{" "}
                {reviewed.baseRef} {reviewed.baseSha.slice(0, 7)}
              </p>
              <p className="mt-2 text-xs capitalize text-muted-foreground">
                Mergeability: {reviewed.mergeableState} · checks:{" "}
                {reviewed.checksState} · reviews:{" "}
                {reviewed.reviewDecision.replaceAll("-", " ")}
              </p>
            </div>
            {reviewed.warnings.map((warning) => (
              <p
                key={warning}
                className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300"
              >
                <AlertTriangle className="size-4 shrink-0" /> {warning}
              </p>
            ))}
            {reviewed.confirmationPhrase ? (
              <label className="block text-xs font-medium">
                Type{" "}
                <span className="font-mono">{reviewed.confirmationPhrase}</span>{" "}
                to confirm
                <input
                  autoFocus
                  className="mt-1 h-9 w-full rounded-md border bg-background px-3 font-mono text-sm"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </label>
            ) : null}
            {apply.error ? (
              <p className="text-sm text-destructive">
                {errorText(apply.error)}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setConfirmation("");
                  reviewedOperation.reset();
                }}
              >
                Back
              </Button>
              <Button
                disabled={
                  pending ||
                  !lifecycleConfirmationMatches(reviewed, confirmation)
                }
                onClick={reviewedOperation.applyReviewed}
              >
                {apply.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                Apply reviewed action
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
