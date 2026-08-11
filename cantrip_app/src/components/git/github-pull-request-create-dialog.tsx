import {
  type GitAgentDraftResult,
  githubPullRequestCreateSchema,
  type GitStatus,
  type GithubPullRequestCreate,
  type GithubPullRequestSummary,
} from "@cantrip/protocol";
import { useMutation } from "@tanstack/react-query";
import { ExternalLink, Loader2, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createGithubPullRequest,
  generateProjectWorktreeGitDraft,
} from "@/lib/api";
import { errorMessage } from "@/lib/error-message";

import { GitAgentDraftDialog } from "./git-agent-draft-dialog";

export function parsePullRequestCsv(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
}

export function parseLinkedIssueNumbers(value: string): number[] | null {
  const parts = value
    .split(",")
    .map((part) => part.trim().replace(/^#/u, ""))
    .filter(Boolean);
  const numbers = parts.map(Number);
  return numbers.every((number) => Number.isInteger(number) && number > 0)
    ? [...new Set(numbers)]
    : null;
}

export function pullRequestBranchChoices(status: GitStatus): {
  bases: string[];
  heads: string[];
  initialBase: string;
  initialHead: string;
} {
  const heads = status.branches
    .filter(({ kind }) => kind === "local")
    .map(({ name }) => name);
  const remoteBranches = status.branches
    .filter(({ kind }) => kind === "remote")
    .map(({ name }) => name.split("/").slice(1).join("/"))
    .filter(Boolean);
  const bases = [...new Set([...heads, ...remoteBranches])];
  const initialHead = status.branch || heads[0] || "";
  const initialBase =
    bases.find((branch) => branch === "main" && branch !== initialHead) ??
    bases.find((branch) => branch === "master" && branch !== initialHead) ??
    bases.find((branch) => branch !== initialHead) ??
    "";
  return { bases, heads, initialBase, initialHead };
}

function errorText(error: unknown): string {
  return errorMessage(error, "The pull request could not be created.");
}

const emptyDraft = {
  base: "",
  head: "",
  title: "",
  body: "",
  draft: false,
  labels: "",
  reviewers: "",
  linkedIssues: "",
};

export function GithubPullRequestCreateDialog({
  onCreated,
  onOpenChange,
  open,
  projectId,
  status,
  worktreeId,
}: {
  onCreated(pullRequest: GithubPullRequestSummary): void;
  onOpenChange(open: boolean): void;
  open: boolean;
  projectId: string;
  status: GitStatus;
  worktreeId: string;
}) {
  const [form, setForm] = useState(emptyDraft);
  const branches = useMemo(() => pullRequestBranchChoices(status), [status]);
  const [created, setCreated] = useState<{
    pullRequest: GithubPullRequestSummary;
    warnings: string[];
  } | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentDraft, setAgentDraft] = useState<GitAgentDraftResult | null>(
    null,
  );
  const linkedIssueNumbers = parseLinkedIssueNumbers(form.linkedIssues);
  const request = githubPullRequestCreateSchema.safeParse({
    base: form.base,
    head: form.head,
    title: form.title,
    body: form.body,
    draft: form.draft,
    labels: parsePullRequestCsv(form.labels),
    reviewers: parsePullRequestCsv(form.reviewers),
    linkedIssueNumbers: linkedIssueNumbers ?? [],
  });
  const create = useMutation({
    mutationFn: (input: GithubPullRequestCreate) =>
      createGithubPullRequest(projectId, worktreeId, input),
    onSuccess: (result) => {
      setCreated(result);
      onCreated(result.pullRequest);
    },
  });
  const generateDraft = useMutation({
    mutationFn: () =>
      generateProjectWorktreeGitDraft(projectId, worktreeId, {
        task: "draft-pr-description",
        baseRevision: form.base,
        headRevision: form.head,
        instructions: null,
        pullRequestNumber: null,
      }),
    onSuccess: setAgentDraft,
  });
  useEffect(() => {
    if (open) {
      setForm({
        ...emptyDraft,
        base: branches.initialBase,
        head: branches.initialHead,
      });
      setCreated(null);
      create.reset();
      generateDraft.reset();
      setAgentDraft(null);
      setAgentOpen(false);
    }
  }, [open, branches.initialBase, branches.initialHead]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (request.success && linkedIssueNumbers !== null) {
      create.mutate(request.data);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create pull request</DialogTitle>
          <DialogDescription>
            GitHub receives the selected worktree branch only after the worker
            verifies its local and published tips match.
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-4">
            <div className="rounded-lg bg-muted/40 p-4">
              <p className="font-medium">
                #{created.pullRequest.number} {created.pullRequest.title}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {created.pullRequest.headRef} → {created.pullRequest.baseRef}
                {created.pullRequest.draft ? " · draft" : ""}
              </p>
            </div>
            {created.warnings.map((warning) => (
              <p
                key={warning}
                className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-300"
              >
                {warning}
              </p>
            ))}
            <DialogFooter>
              <Button variant="outline" asChild>
                <a
                  href={created.pullRequest.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink className="size-4" /> Open in GitHub
                </a>
              </Button>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-medium">
                Head branch
                <select
                  className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={form.head}
                  onChange={(event) =>
                    setForm({ ...form, head: event.target.value })
                  }
                >
                  <option value="">Select local branch</option>
                  {branches.heads.map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-medium">
                Base branch
                <input
                  list="github-pr-base-branches"
                  className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={form.base}
                  onChange={(event) =>
                    setForm({ ...form, base: event.target.value })
                  }
                />
                <datalist id="github-pr-base-branches">
                  {branches.bases.map((branch) => (
                    <option key={branch} value={branch} />
                  ))}
                </datalist>
              </label>
            </div>
            <label className="block text-xs font-medium">
              Title
              <input
                autoFocus
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={form.title}
                onChange={(event) =>
                  setForm({ ...form, title: event.target.value })
                }
              />
            </label>
            <div className="block text-xs font-medium">
              <div className="flex items-center justify-between gap-2">
                <span>Markdown body</span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  disabled={!form.base || !form.head || generateDraft.isPending}
                  onClick={() => {
                    setAgentOpen(true);
                    generateDraft.mutate();
                  }}
                >
                  <Sparkles className="size-3.5" /> Draft description
                </Button>
              </div>
              <textarea
                aria-label="Markdown body"
                className="mt-1 min-h-40 w-full resize-y rounded-md border bg-background p-3 text-sm"
                value={form.body}
                onChange={(event) =>
                  setForm({ ...form, body: event.target.value })
                }
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-medium">
                Labels (comma separated)
                <input
                  className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                  placeholder="feature, needs-review"
                  value={form.labels}
                  onChange={(event) =>
                    setForm({ ...form, labels: event.target.value })
                  }
                />
              </label>
              <label className="text-xs font-medium">
                Reviewers (comma separated)
                <input
                  className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                  placeholder="octocat, reviewer"
                  value={form.reviewers}
                  onChange={(event) =>
                    setForm({ ...form, reviewers: event.target.value })
                  }
                />
              </label>
            </div>
            <label className="block text-xs font-medium">
              Linked issues (comma separated)
              <input
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                placeholder="#12, #34"
                value={form.linkedIssues}
                onChange={(event) =>
                  setForm({ ...form, linkedIssues: event.target.value })
                }
              />
              {linkedIssueNumbers === null ? (
                <span className="mt-1 block text-destructive">
                  Enter positive issue numbers separated by commas.
                </span>
              ) : linkedIssueNumbers.length > 0 ? (
                <span className="mt-1 block text-muted-foreground">
                  The body will append{" "}
                  {linkedIssueNumbers.map((n) => `Closes #${n}`).join(", ")}.
                </span>
              ) : null}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={form.draft}
                onChange={(event) =>
                  setForm({ ...form, draft: event.target.checked })
                }
              />
              Create as draft
            </label>
            {create.error ? (
              <p className="text-sm text-destructive">
                {errorText(create.error)}
              </p>
            ) : null}
            {!request.success && form.title.trim() ? (
              <p className="text-xs text-destructive">
                {request.error.issues[0]?.message}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={create.isPending}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  create.isPending ||
                  !request.success ||
                  linkedIssueNumbers === null
                }
              >
                {create.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                Create pull request
              </Button>
            </DialogFooter>
          </form>
        )}
        <GitAgentDraftDialog
          draft={agentDraft}
          error={generateDraft.error ? errorText(generateDraft.error) : null}
          loading={generateDraft.isPending}
          onApply={(text) => setForm((current) => ({ ...current, body: text }))}
          onOpenChange={setAgentOpen}
          onRegenerate={() => generateDraft.mutate()}
          open={agentOpen}
          task="draft-pr-description"
        />
      </DialogContent>
    </Dialog>
  );
}
