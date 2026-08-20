import {
  githubIssueCreateSchema,
  type GithubIssueCreate,
  type GithubIssueDetail,
} from "@cantrip/protocol";
import { useMutation } from "@tanstack/react-query";
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
import { Input } from "@/components/ui/input";
import { createGithubIssue } from "@/lib/api";
import { errorMessage } from "@/lib/error-message";

const emptyDraft = { body: "", title: "" };

export function GithubIssueCreateDialog({
  onCreated,
  onOpenChange,
  open,
  projectId,
}: {
  onCreated(issue: GithubIssueDetail): void;
  onOpenChange(open: boolean): void;
  open: boolean;
  projectId: string;
}) {
  const [draft, setDraft] = useState(emptyDraft);
  const request = githubIssueCreateSchema.safeParse(draft);
  const create = useMutation({
    mutationFn: (input: GithubIssueCreate) =>
      createGithubIssue(projectId, input),
    onSuccess: (issue) => {
      onCreated(issue);
      onOpenChange(false);
    },
  });

  useEffect(() => {
    if (!open) return;
    setDraft(emptyDraft);
    create.reset();
  }, [open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (request.success) create.mutate(request.data);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create issue</DialogTitle>
          <DialogDescription>
            Add a new issue to this project&apos;s GitHub repository.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <label className="grid gap-1.5 text-sm">
            Title
            <Input
              autoFocus
              maxLength={256}
              placeholder="Briefly describe the problem or request"
              value={draft.title}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  title: event.target.value,
                }))
              }
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            Description
            <textarea
              className="min-h-52 w-full resize-y rounded-xl border bg-background p-3 text-sm outline-none ring-ring placeholder:text-muted-foreground focus:ring-2"
              maxLength={1_000_000}
              placeholder="Add context, reproduction steps, or acceptance criteria. Markdown is supported."
              value={draft.body}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  body: event.target.value,
                }))
              }
            />
          </label>
          {create.isError ? (
            <p className="text-sm text-destructive">
              {errorMessage(create.error, "The issue could not be created.")}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={create.isPending}
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={!request.success || create.isPending}
              type="submit"
            >
              {create.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              Create issue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
