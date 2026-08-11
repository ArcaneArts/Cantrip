import type { GitActionResult, GitStatus } from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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
  applyProjectWorktreeGitForcePush,
  previewProjectWorktreeGitForcePush,
} from "@/lib/api";
import { errorMessage } from "@/lib/error-message";

function errorText(error: unknown): string {
  return errorMessage(error, "Force push failed.");
}

export function gitPushRequiresLease(
  status: Pick<GitStatus, "ahead" | "behind"> | null | undefined,
): boolean {
  return Boolean(status && status.ahead > 0 && status.behind > 0);
}

export function gitForcePushConfirmationMatches(
  expected: string,
  confirmation: string,
): boolean {
  return expected.length > 0 && confirmation === expected;
}

export function GitForcePushDialog({
  onApplied,
  onOpenChange,
  open,
  projectId,
  worktreeId,
}: {
  onApplied?(result: GitActionResult): void;
  onOpenChange(open: boolean): void;
  open: boolean;
  projectId: string;
  worktreeId: string;
}) {
  const queryClient = useQueryClient();
  const [confirmation, setConfirmation] = useState("");
  const preview = useQuery({
    enabled: open,
    queryKey: ["git-force-push-preview", projectId, worktreeId, open],
    queryFn: () => previewProjectWorktreeGitForcePush(projectId, worktreeId),
    refetchOnMount: "always",
    retry: false,
  });
  const expectedConfirmation = preview.data
    ? `${preview.data.remote}/${preview.data.remoteBranch}`
    : "";
  const apply = useMutation({
    mutationFn: () => {
      if (!preview.data) throw new Error("Review the force push first.");
      return applyProjectWorktreeGitForcePush(
        projectId,
        worktreeId,
        preview.data.token,
      );
    },
    onSuccess: (result) => {
      queryClient.setQueryData(
        ["worktree-status", projectId, worktreeId],
        result.status,
      );
      void queryClient.invalidateQueries({
        queryKey: ["worktree-history", projectId, worktreeId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["git-force-push-preview", projectId, worktreeId],
      });
      onApplied?.(result);
      onOpenChange(false);
    },
  });
  useEffect(() => {
    if (!open) {
      setConfirmation("");
      apply.reset();
    }
  }, [open]);
  const remoteCommits = useMemo(
    () => preview.data?.remoteCommits ?? [],
    [preview.data?.remoteCommits],
  );
  const localCommits = useMemo(
    () => preview.data?.localCommits ?? [],
    [preview.data?.localCommits],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="size-5" /> Replace published history
          </DialogTitle>
          <DialogDescription>
            Cantrip only permits this through an exact, reviewed
            force-with-lease push. A changed remote fails safely.
          </DialogDescription>
        </DialogHeader>

        {preview.isLoading ? (
          <div className="grid min-h-48 place-items-center text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : preview.error ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            {errorText(preview.error)}
          </div>
        ) : preview.data ? (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1 text-sm">
            <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4">
              <p className="font-medium">{preview.data.summary}</p>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                Lease: {preview.data.expectedRemoteHead}
              </p>
              {preview.data.warnings.map((warning) => (
                <p key={warning} className="mt-2 text-xs text-destructive">
                  {warning}
                </p>
              ))}
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <section className="overflow-hidden rounded-lg border">
                <h3 className="border-b px-3 py-2 text-xs font-medium">
                  Removed from remote ({preview.data.remoteCommitCount})
                </h3>
                <div className="max-h-48 overflow-y-auto">
                  {remoteCommits.map((commit) => (
                    <div
                      key={commit.hash}
                      className="flex gap-2 px-3 py-1.5 text-xs"
                    >
                      <span className="shrink-0 font-mono text-muted-foreground">
                        {commit.shortHash}
                      </span>
                      <span className="min-w-0 truncate">{commit.subject}</span>
                    </div>
                  ))}
                  {preview.data.remoteCommitsTruncated ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">
                      Showing the first {remoteCommits.length} commits.
                    </p>
                  ) : null}
                </div>
              </section>
              <section className="overflow-hidden rounded-lg border">
                <h3 className="border-b px-3 py-2 text-xs font-medium">
                  Published from local ({preview.data.localCommitCount})
                </h3>
                <div className="max-h-48 overflow-y-auto">
                  {localCommits.map((commit) => (
                    <div
                      key={commit.hash}
                      className="flex gap-2 px-3 py-1.5 text-xs"
                    >
                      <span className="shrink-0 font-mono text-muted-foreground">
                        {commit.shortHash}
                      </span>
                      <span className="min-w-0 truncate">{commit.subject}</span>
                    </div>
                  ))}
                  {preview.data.localCommitsTruncated ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">
                      Showing the first {localCommits.length} commits.
                    </p>
                  ) : null}
                </div>
              </section>
            </div>

            <label className="block text-xs">
              Type <strong className="font-mono">{expectedConfirmation}</strong>{" "}
              to confirm
              <input
                autoComplete="off"
                className="mt-2 h-9 w-full rounded-md border bg-background px-3 font-mono text-sm"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
            {apply.error ? (
              <p className="text-sm text-destructive">
                {errorText(apply.error)}
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            disabled={apply.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={
              !preview.data ||
              !gitForcePushConfirmationMatches(
                expectedConfirmation,
                confirmation,
              ) ||
              apply.isPending
            }
            onClick={() => apply.mutate()}
          >
            {apply.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : null}
            Force push with lease
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
