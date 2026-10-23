import type { ThreadGoal } from "@cantrip/protocol";
import { Loader2, Pause, Pencil, Play, Target, Trash2 } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
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

const STATUS_LABELS: Record<
  Exclude<ThreadGoal["status"], "complete"> | "failed",
  string
> = {
  active: "Running",
  paused: "Paused",
  blocked: "Blocked",
  usageLimited: "Usage limited",
  budgetLimited: "Budget reached",
  failed: "Failed",
};

export function formatGoalElapsed(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(wholeSeconds / 3_600);
  const minutes = Math.floor((wholeSeconds % 3_600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${wholeSeconds % 60}s`;
  return `${wholeSeconds}s`;
}

export function GoalPanel({
  automationPaused = false,
  executionFailed = false,
  error,
  goal,
  onClear,
  onEdit,
  onUpdate,
  pending,
}: {
  automationPaused?: boolean;
  executionFailed?: boolean;
  error?: string | null;
  goal: ThreadGoal | null;
  onClear(): void;
  onEdit?(objective: string): Promise<unknown>;
  onUpdate(status: "active" | "paused"): void;
  pending: boolean;
}) {
  if (!goal || goal.status === "complete") return null;
  const status = executionFailed
    ? "failed"
    : automationPaused && goal.status === "active"
      ? "paused"
      : goal.status;
  const progress =
    goal.tokenBudget && goal.tokenBudget > 0
      ? Math.min(100, (goal.tokensUsed / goal.tokenBudget) * 100)
      : null;

  return (
    <section
      aria-label="Codex goal"
      data-slot="goal-panel"
      className="mb-2 rounded-xl border border-violet-500/30 bg-[var(--popover-solid)] p-3 text-popover-foreground shadow-lg"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-violet-500/15 text-violet-600 dark:text-violet-400">
          <Target className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
              Goal
            </span>
            <Badge variant="outline">{STATUS_LABELS[status]}</Badge>
          </div>
          <GoalObjective goal={goal} onEdit={onEdit} pending={pending} />
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>{formatGoalElapsed(goal.timeUsedSeconds)}</span>
            <span>
              {goal.tokensUsed.toLocaleString()} tokens
              {goal.tokenBudget
                ? ` / ${goal.tokenBudget.toLocaleString()}`
                : ""}
            </span>
          </div>
          {progress !== null ? (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-violet-500 transition-[width]"
                style={{ width: `${progress}%` }}
              />
            </div>
          ) : null}
          {error ? (
            <p className="mt-2 text-xs text-destructive">{error}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {status === "active" ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8"
              title="Pause goal after the current turn"
              disabled={pending}
              onClick={() => onUpdate("paused")}
            >
              {pending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Pause className="size-3.5" />
              )}
              <span className="sr-only">Pause goal</span>
            </Button>
          ) : status === "paused" ||
            status === "blocked" ||
            status === "failed" ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8"
              title="Resume goal"
              disabled={pending}
              onClick={() => onUpdate("active")}
            >
              {pending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
              <span className="sr-only">Resume goal</span>
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8 text-muted-foreground hover:text-destructive"
            title="Clear goal"
            disabled={pending}
            onClick={onClear}
          >
            <Trash2 className="size-3.5" />
            <span className="sr-only">Clear goal</span>
          </Button>
        </div>
      </div>
    </section>
  );
}

function GoalObjective({
  goal,
  onEdit,
  pending,
}: {
  goal: ThreadGoal;
  onEdit?: (objective: string) => Promise<unknown>;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(goal.objective);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const busy = pending || saving;
  async function save() {
    if (!onEdit || !draft.trim() || busy) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onEdit(draft.trim());
      setOpen(false);
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) setOpen(next);
      }}
    >
      <button
        type="button"
        aria-label="View and edit goal"
        className="mt-1 flex w-full items-start gap-2 text-left text-sm leading-5 hover:text-violet-500"
        onClick={() => {
          setDraft(goal.objective);
          setSaveError(null);
          setOpen(true);
        }}
      >
        <span className="line-clamp-2 min-w-0 flex-1">{goal.objective}</span>
        <Pencil aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      </button>
      <DialogContent
        className="max-w-2xl"
        onEscapeKeyDown={(event) => {
          if (saving) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (saving) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Goal objective</DialogTitle>
          <DialogDescription>
            Review or edit the objective. Saving keeps the goal’s current status
            and usage.
          </DialogDescription>
        </DialogHeader>
        <textarea
          aria-label="Goal objective"
          className="min-h-64 w-full resize-y rounded-md border bg-background p-3 text-sm leading-6"
          value={draft}
          maxLength={100_000}
          readOnly={!onEdit}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
        />
        {saveError ? (
          <p role="alert" className="text-sm text-destructive">
            {saveError}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={saving}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          {onEdit ? (
            <Button
              type="button"
              disabled={
                busy || !draft.trim() || draft.trim() === goal.objective
              }
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save goal"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
