import type { PlanStep } from "@cantrip/protocol";
import { CheckCircle2, Circle, Loader2 } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type PlanProgressSummary = {
  completedCount: number;
  currentStepNumber: number;
  isComplete: boolean;
  total: number;
};

export function summarizePlanProgress(
  steps: PlanStep[],
): PlanProgressSummary | null {
  if (steps.length === 0) return null;

  const inProgressIndex = steps.findIndex(
    (step) => step.status === "inProgress",
  );
  const pendingIndex = steps.findIndex((step) => step.status === "pending");
  const currentIndex =
    inProgressIndex >= 0
      ? inProgressIndex
      : pendingIndex >= 0
        ? pendingIndex
        : steps.length - 1;
  const completedCount = steps.filter(
    (step) => step.status === "completed",
  ).length;

  return {
    completedCount,
    currentStepNumber: currentIndex + 1,
    isComplete: completedCount === steps.length,
    total: steps.length,
  };
}

function StepStatusIcon({
  loading,
  status,
}: {
  loading: boolean;
  status: PlanStep["status"];
}) {
  if (status === "completed") {
    return (
      <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
    );
  }
  if (status === "inProgress" && loading) {
    return (
      <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-sky-500" />
    );
  }
  return <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />;
}

export function PlanProgressDetails({
  explanation,
  loading,
  steps,
  summary,
}: {
  explanation: string | null;
  loading: boolean;
  steps: PlanStep[];
  summary: PlanProgressSummary;
}) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">Plan progress</h2>
        <span className="shrink-0 text-xs text-muted-foreground">
          {summary.completedCount} of {summary.total} complete
        </span>
      </div>
      {explanation ? (
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {explanation}
        </p>
      ) : null}
      <ol className="mt-3 space-y-2" aria-label="Plan steps">
        {steps.map((step, index) => (
          <li
            key={`${index}:${step.step}`}
            aria-current={step.status === "inProgress" ? "step" : undefined}
            className="flex gap-2 text-sm"
          >
            <StepStatusIcon loading={loading} status={step.status} />
            <span
              className={cn(
                "min-w-0 leading-5",
                step.status !== "inProgress" && "text-muted-foreground",
              )}
            >
              {step.step}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

export function ChatPlanProgress({
  explanation,
  loading,
  steps,
}: {
  explanation: string | null;
  loading: boolean;
  steps: PlanStep[];
}) {
  const summary = summarizePlanProgress(steps);
  if (!summary) return null;

  const summaryText = `Step ${summary.currentStepNumber} / ${summary.total}`;
  const currentStatus = steps[summary.currentStepNumber - 1]?.status;

  return (
    <div className="mb-2 flex justify-end">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${summaryText}. ${summary.completedCount} of ${summary.total} steps complete. Show plan progress.`}
            className="chat-composer-surface inline-flex h-9 items-center gap-2 rounded-full border px-3 text-xs font-medium text-foreground shadow-lg transition-colors hover:bg-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {summary.isComplete ? (
              <CheckCircle2 className="size-4 text-emerald-500" />
            ) : currentStatus === "inProgress" && loading ? (
              <Loader2 className="size-4 animate-spin text-sky-500" />
            ) : (
              <Circle className="size-4 text-muted-foreground" />
            )}
            <span>{summaryText}</span>
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
            <span className="text-muted-foreground">
              {summary.completedCount} complete
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="top"
          sideOffset={6}
          className="max-h-[min(26rem,calc(100svh-8rem))] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto p-3"
        >
          <PlanProgressDetails
            explanation={explanation}
            loading={loading}
            steps={steps}
            summary={summary}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
