import type { ChatGoalCreate, ThreadGoal } from "@cantrip/protocol";
import { Loader2, Pause, Play, Target, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

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

const STATUS_LABELS: Record<ThreadGoal["status"], string> = {
  active: "Running",
  paused: "Paused",
  blocked: "Blocked",
  usageLimited: "Usage limited",
  budgetLimited: "Budget reached",
  complete: "Complete",
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
  error,
  goal,
  onClear,
  onCreate,
  onOpenChange,
  onUpdate,
  open,
  pending,
}: {
  error?: string | null;
  goal: ThreadGoal | null;
  onClear(): void;
  onCreate(input: ChatGoalCreate): void;
  onOpenChange(open: boolean): void;
  onUpdate(status: "active" | "paused"): void;
  open: boolean;
  pending: boolean;
}) {
  const [objective, setObjective] = useState("");
  const [tokenBudget, setTokenBudget] = useState("");
  useEffect(() => {
    if (open) return;
    setObjective("");
    setTokenBudget("");
  }, [open]);

  const parsedBudget = tokenBudget.trim() ? Number(tokenBudget) : null;
  const valid =
    objective.trim().length > 0 &&
    (parsedBudget === null ||
      (Number.isSafeInteger(parsedBudget) && parsedBudget > 0));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || pending) return;
    onCreate({
      objective: objective.trim(),
      tokenBudget: parsedBudget,
    });
  };

  const progress =
    goal?.tokenBudget && goal.tokenBudget > 0
      ? Math.min(100, (goal.tokensUsed / goal.tokenBudget) * 100)
      : null;

  return (
    <>
      {goal ? (
        <section
          aria-label="Codex goal"
          className="mb-2 rounded-xl border border-violet-500/25 bg-violet-500/5 p-3 shadow-sm"
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
                <Badge variant="outline">{STATUS_LABELS[goal.status]}</Badge>
              </div>
              <p className="mt-1 line-clamp-2 text-sm leading-5">
                {goal.objective}
              </p>
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
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {goal.status === "active" ? (
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
              ) : goal.status === "paused" || goal.status === "blocked" ? (
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
      ) : null}

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start a Codex goal</DialogTitle>
            <DialogDescription>
              Codex will keep taking turns toward a clear stopping condition.
              You can pause or clear the goal at any time.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={submit}>
            <label className="block space-y-1.5 text-sm">
              <span>Objective</span>
              <textarea
                autoFocus
                rows={5}
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                placeholder="Implement the feature, run the relevant checks, and stop when the work is ready for review."
                className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm leading-5 outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span>Token budget (optional)</span>
              <input
                type="number"
                min={1}
                step={1_000}
                value={tokenBudget}
                onChange={(event) => setTokenBudget(event.target.value)}
                placeholder="No limit"
                className="h-9 w-full rounded-md border bg-background px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!valid || pending}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Start goal
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
