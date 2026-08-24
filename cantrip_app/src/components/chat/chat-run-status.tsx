import type { ChatSummary, InferenceProgressSnapshot } from "@cantrip/protocol";
import { Bot, Pause } from "lucide-react";

interface ChatRunStatusProps {
  automationPaused: boolean;
  hasLiveActivity: boolean;
  inferenceProgress: InferenceProgressSnapshot | null;
  syncingCodeGraph: boolean;
  status: ChatSummary["status"];
  waitingForPlanAnswer: boolean;
}

export function ChatRunStatus({
  automationPaused,
  hasLiveActivity,
  inferenceProgress,
  syncingCodeGraph,
  status,
  waitingForPlanAnswer,
}: ChatRunStatusProps) {
  if (status !== "running" && status !== "waiting-for-approval") return null;

  if (status === "running" && !automationPaused && !waitingForPlanAnswer) {
    if (hasLiveActivity && !inferenceProgress) return null;
    const label = inferenceProgress
      ? (() => {
          if (inferenceProgress.phase === "queued") return "Queued...";
          if (inferenceProgress.phase === "loading") return "Loading model...";
          if (inferenceProgress.phase === "generating") return "Generating...";
          if (
            inferenceProgress.precision !== "indeterminate" &&
            inferenceProgress.fractionComplete !== null
          ) {
            const percent = Math.min(
              100,
              Math.floor(inferenceProgress.fractionComplete * 100),
            );
            return `Prefilling ${percent}%...`;
          }
          return "Prefilling...";
        })()
      : syncingCodeGraph
        ? "Syncing CodeGraph..."
        : "Working...";
    return (
      <div
        aria-live="polite"
        className="text-sm"
        data-elite-ignore=""
        role="status"
      >
        <span className="chat-working-shimmer">{label}</span>
      </div>
    );
  }

  const label =
    status === "waiting-for-approval"
      ? "Codex is waiting for your approval…"
      : automationPaused
        ? "Pause requested — Codex will hold at its next safe boundary…"
        : "Codex is waiting for your plan answer…";

  return (
    <div
      aria-live="polite"
      className="flex items-center gap-3 text-sm text-muted-foreground"
      data-elite-ignore=""
      role="status"
    >
      <div className="grid size-7 place-items-center rounded-lg border bg-card">
        {automationPaused ? (
          <Pause className="size-3.5 text-amber-500" />
        ) : (
          <Bot className="size-3.5" />
        )}
      </div>
      <span>{label}</span>
    </div>
  );
}
