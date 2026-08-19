import type { ThreadGoal } from "@cantrip/protocol";
import { Loader2, Pause, Play, Target, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const STATUS_LABELS: Record<
  Exclude<ThreadGoal["status"], "complete">,
  string
> = {
  active: "Running",
  paused: "Paused",
  blocked: "Blocked",
  usageLimited: "Usage limited",
  budgetLimited: "Budget reached",
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
  onUpdate,
  pending,
}: {
  error?: string | null;
  goal: ThreadGoal | null;
  onClear(): void;
  onUpdate(status: "active" | "paused"): void;
  pending: boolean;
}) {
  if (!goal || goal.status === "complete") return null;
  const progress =
    goal.tokenBudget && goal.tokenBudget > 0
      ? Math.min(100, (goal.tokensUsed / goal.tokenBudget) * 100)
      : null;

  return (
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
          {error ? (
            <p className="mt-2 text-xs text-destructive">{error}</p>
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
  );
}
