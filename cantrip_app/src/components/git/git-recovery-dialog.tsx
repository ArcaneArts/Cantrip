import type {
  GitRecoveryAction,
  GitRecoveryCandidate,
  GitRecoveryPreview,
} from "@cantrip/protocol";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertTriangle,
  GitBranchPlus,
  Loader2,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  applyProjectWorktreeRecovery,
  getProjectWorktreeRecoveryCandidates,
  previewProjectWorktreeRecovery,
} from "@/lib/api";
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
import { cn } from "@/lib/utils";

type RecoveryKind = "reflog" | "dangling";
type RecoveryMode = GitRecoveryAction["type"];

export function defaultRecoveryBranch(candidate: GitRecoveryCandidate): string {
  const date = (candidate.occurredAt ?? new Date().toISOString()).slice(0, 10);
  return `recovery/${date}-${candidate.shortHash.slice(0, 8)}`;
}

export function recoveryAction(
  mode: RecoveryMode,
  target: string,
  branch: string,
  resetMode: "soft" | "mixed" | "hard",
): GitRecoveryAction | null {
  const name = branch.trim();
  if (!target) return null;
  if (mode === "reset") return { type: mode, target, mode: resetMode };
  return name ? { type: mode, target, branch: name } : null;
}

function RecoveryPreviewCard({ preview }: { preview: GitRecoveryPreview }) {
  return (
    <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
      <div className="flex items-start gap-2">
        {preview.destructive ? (
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
        ) : (
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
        )}
        <div>
          <p className="font-medium text-foreground">{preview.summary}</p>
          {preview.checkpointRef ? (
            <p className="mt-1 break-all text-muted-foreground">
              Recovery checkpoint: {preview.checkpointRef}
            </p>
          ) : null}
        </div>
      </div>
      {preview.warnings.length ? (
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          {preview.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      <div className="grid grid-cols-2 gap-2 text-muted-foreground">
        <span>{preview.commitsRemoved.length} commits affected</span>
        <span>{preview.files.length} files differ</span>
      </div>
      {preview.status.files.length ? (
        <div className="space-y-1 text-muted-foreground">
          <p>{preview.status.files.length} local changes are present:</p>
          {preview.status.files.slice(0, 8).map((file) => (
            <code key={file.path} className="block truncate text-[11px]">
              {file.indexStatus}
              {file.worktreeStatus} {file.path}
            </code>
          ))}
          {preview.status.files.length > 8 ? (
            <p>+{preview.status.files.length - 8} more paths</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function GitRecoveryDialog({
  onOpenChange,
  open,
  projectId,
  worktreeId,
}: {
  onOpenChange(open: boolean): void;
  open: boolean;
  projectId: string;
  worktreeId: string;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<RecoveryKind>("reflog");
  const [selected, setSelected] = useState<GitRecoveryCandidate | null>(null);
  const [mode, setMode] = useState<RecoveryMode>("createBranch");
  const [branch, setBranch] = useState("");
  const [resetMode, setResetMode] = useState<"soft" | "mixed" | "hard">(
    "mixed",
  );
  const [preview, setPreview] = useState<GitRecoveryPreview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const candidates = useInfiniteQuery({
    queryKey: ["git-recovery", projectId, worktreeId, kind],
    queryFn: ({ pageParam }) =>
      getProjectWorktreeRecoveryCandidates(
        projectId,
        worktreeId,
        kind,
        pageParam,
      ),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: open,
  });
  const entries = useMemo(
    () => candidates.data?.pages.flatMap((page) => page.entries) ?? [],
    [candidates.data],
  );
  const action = selected
    ? recoveryAction(mode, selected.hash, branch, resetMode)
    : null;
  const previewMutation = useMutation({
    mutationFn: (input: GitRecoveryAction) =>
      previewProjectWorktreeRecovery(projectId, worktreeId, input),
    onSuccess: (next) => {
      setPreview(next);
      setConfirmation("");
    },
  });
  const applyMutation = useMutation({
    mutationFn: async () => {
      if (!preview) throw new Error("Preview the recovery action first.");
      return applyProjectWorktreeRecovery(projectId, worktreeId, {
        action: preview.action,
        token: preview.token,
        confirmation,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["worktree-history", projectId, worktreeId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["worktree-status", projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["git-recovery", projectId],
      });
      setPreview(null);
      setConfirmation("");
      onOpenChange(false);
    },
  });

  useEffect(() => {
    setSelected(null);
    setPreview(null);
    setConfirmation("");
  }, [kind, open, worktreeId]);
  useEffect(() => {
    setPreview(null);
    setConfirmation("");
  }, [mode, branch, resetMode, selected]);

  const selectCandidate = (candidate: GitRecoveryCandidate) => {
    setSelected(candidate);
    setBranch(defaultRecoveryBranch(candidate));
  };
  const error =
    previewMutation.error ?? applyMutation.error ?? candidates.error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-4xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Recovery</DialogTitle>
          <DialogDescription>
            Recover reference movements and unreachable commits in this explicit
            worktree.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
          <div className="flex min-h-64 flex-1 flex-col overflow-hidden rounded-md border">
            <div className="flex items-center gap-1 border-b p-1">
              {(["reflog", "dangling"] as const).map((candidate) => (
                <Button
                  key={candidate}
                  size="sm"
                  variant={kind === candidate ? "outline" : "ghost"}
                  className="h-7 capitalize"
                  onClick={() => setKind(candidate)}
                >
                  {candidate === "reflog" ? "Reference log" : "Lost commits"}
                </Button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {entries.map((entry, index) => (
                <button
                  type="button"
                  key={`${entry.selector}-${index}`}
                  onClick={() => selectCandidate(entry)}
                  className={cn(
                    "grid w-full grid-cols-[6.5rem_1fr] gap-2 px-3 py-2 text-left text-xs hover:bg-muted/60",
                    selected?.selector === entry.selector &&
                      selected.hash === entry.hash &&
                      "bg-muted",
                  )}
                >
                  <code className="truncate text-muted-foreground">
                    {entry.selector}
                  </code>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {entry.subject || entry.shortHash}
                    </span>
                    <span className="block truncate text-muted-foreground">
                      {entry.explanation}
                    </span>
                  </span>
                </button>
              ))}
              {candidates.isLoading ? (
                <div className="flex h-32 items-center justify-center text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                </div>
              ) : null}
              {!candidates.isLoading && entries.length === 0 ? (
                <p className="p-6 text-center text-xs text-muted-foreground">
                  No{" "}
                  {kind === "reflog" ? "reference movements" : "lost commits"}{" "}
                  found.
                </p>
              ) : null}
              {candidates.hasNextPage ? (
                <Button
                  variant="ghost"
                  className="w-full rounded-none"
                  disabled={candidates.isFetchingNextPage}
                  onClick={() => candidates.fetchNextPage()}
                >
                  {candidates.isFetchingNextPage ? "Loading…" : "Load more"}
                </Button>
              ) : null}
            </div>
          </div>

          <div className="w-full space-y-3 md:w-80">
            {selected ? (
              <>
                <div className="rounded-md bg-muted/40 p-3 text-xs">
                  <div className="font-medium">{selected.shortHash}</div>
                  <div className="mt-1 break-all text-muted-foreground">
                    {selected.hash}
                  </div>
                </div>
                <label className="block space-y-1 text-xs">
                  <span>Recovery action</span>
                  <select
                    value={mode}
                    onChange={(event) =>
                      setMode(event.target.value as RecoveryMode)
                    }
                    className="h-9 w-full rounded-md border bg-background px-2"
                  >
                    <option value="createBranch">Create recovery branch</option>
                    <option value="restoreBranch">
                      Restore existing branch
                    </option>
                    <option value="reset">Reset this worktree</option>
                  </select>
                </label>
                {mode === "reset" ? (
                  <label className="block space-y-1 text-xs">
                    <span>Reset mode</span>
                    <select
                      value={resetMode}
                      onChange={(event) =>
                        setResetMode(event.target.value as typeof resetMode)
                      }
                      className="h-9 w-full rounded-md border bg-background px-2"
                    >
                      <option value="soft">Soft — keep index and files</option>
                      <option value="mixed">Mixed — unstage, keep files</option>
                      <option value="hard">
                        Hard — overwrite tracked files
                      </option>
                    </select>
                  </label>
                ) : (
                  <label className="block space-y-1 text-xs">
                    <span>Branch name</span>
                    <Input
                      value={branch}
                      onChange={(event) => setBranch(event.target.value)}
                    />
                  </label>
                )}
                {!preview ? (
                  <Button
                    className="w-full"
                    disabled={!action || previewMutation.isPending}
                    onClick={() => action && previewMutation.mutate(action)}
                  >
                    {previewMutation.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : mode === "createBranch" ? (
                      <GitBranchPlus className="size-4" />
                    ) : (
                      <RotateCcw className="size-4" />
                    )}
                    Preview exact changes
                  </Button>
                ) : (
                  <>
                    <RecoveryPreviewCard preview={preview} />
                    <label className="block space-y-1 text-xs">
                      <span>Type the confirmation exactly</span>
                      <code className="block select-all break-all text-[11px] text-muted-foreground">
                        {preview.confirmation}
                      </code>
                      <Input
                        value={confirmation}
                        onChange={(event) =>
                          setConfirmation(event.target.value)
                        }
                        autoComplete="off"
                      />
                    </label>
                    <Button
                      variant="default"
                      className={cn(
                        "w-full",
                        preview.destructive &&
                          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
                      )}
                      disabled={
                        confirmation !== preview.confirmation ||
                        applyMutation.isPending
                      }
                      onClick={() => applyMutation.mutate()}
                    >
                      {applyMutation.isPending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : null}
                      Apply recovery action
                    </Button>
                  </>
                )}
              </>
            ) : (
              <div className="flex h-48 items-center justify-center rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
                Select a reference movement or lost commit to recover it.
              </div>
            )}
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error instanceof Error ? error.message : "Recovery failed."}
              </p>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
