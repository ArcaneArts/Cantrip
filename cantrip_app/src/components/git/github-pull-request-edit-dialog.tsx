import {
  githubPullRequestDetailsUpdateSchema,
  type GithubPullRequestDetailsUpdate,
  type GithubPullRequestOverview,
} from "@cantrip/protocol";
import { Loader2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorMessage } from "@/lib/error-message";

import { parsePullRequestCsv } from "./github-pull-request-create-dialog";

export function GithubPullRequestEditDialog({
  detail,
  error,
  onOpenChange,
  onSave,
  open,
  pending,
}: {
  detail: GithubPullRequestOverview;
  error: unknown;
  onOpenChange(open: boolean): void;
  onSave(details: GithubPullRequestDetailsUpdate): Promise<void>;
  open: boolean;
  pending: boolean;
}) {
  const [title, setTitle] = useState(detail.title);
  const [body, setBody] = useState(detail.body ?? "");
  const [labels, setLabels] = useState(
    detail.labels.map((label) => label.name).join(", "),
  );
  const [reviewers, setReviewers] = useState(
    detail.requestedReviewers.join(", "),
  );
  useEffect(() => {
    if (!open) return;
    setTitle(detail.title);
    setBody(detail.body ?? "");
    setLabels(detail.labels.map((label) => label.name).join(", "));
    setReviewers(detail.requestedReviewers.join(", "));
  }, [detail, open]);
  const request = githubPullRequestDetailsUpdateSchema.safeParse({
    title,
    body,
    labels: parsePullRequestCsv(labels),
    reviewers: parsePullRequestCsv(reviewers),
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!request.success) return;
    try {
      await onSave(request.data);
      onOpenChange(false);
    } catch {
      // The mutation error remains visible in this dialog.
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit pull request</DialogTitle>
          <DialogDescription>
            Update the title, description, labels, and requested reviewers on
            GitHub.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <label className="block text-xs font-medium">
            Title
            <input
              autoFocus
              className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="block text-xs font-medium">
            Description
            <textarea
              className="mt-1 min-h-44 w-full resize-y rounded-md border bg-background p-3 text-sm"
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium">
              Labels
              <input
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                placeholder="bug, frontend"
                value={labels}
                onChange={(event) => setLabels(event.target.value)}
              />
            </label>
            <label className="text-xs font-medium">
              Reviewers
              <input
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                placeholder="octocat, monalisa"
                value={reviewers}
                onChange={(event) => setReviewers(event.target.value)}
              />
            </label>
          </div>
          {error ? (
            <p className="text-sm text-destructive">
              {errorMessage(error, "The pull request could not be updated.")}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={pending}
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button disabled={pending || !request.success} type="submit">
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
