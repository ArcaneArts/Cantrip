import type { ChatSummary } from "@cantrip/protocol";
import { Bot, Pause } from "lucide-react";

interface ChatRunStatusProps {
  automationPaused: boolean;
  hasLiveActivity: boolean;
  syncingCodeGraph: boolean;
  status: ChatSummary["status"];
  waitingForPlanAnswer: boolean;
}

export function ChatRunStatus({
  automationPaused,
  hasLiveActivity,
  syncingCodeGraph,
  status,
  waitingForPlanAnswer,
}: ChatRunStatusProps) {
  if (status !== "running" && status !== "waiting-for-approval") return null;

  if (status === "running" && !automationPaused && !waitingForPlanAnswer) {
    if (hasLiveActivity) return null;
    return (
      <div
        aria-live="polite"
        className="text-sm"
        data-elite-ignore=""
        role="status"
      >
        <span className="chat-working-shimmer">
          {syncingCodeGraph ? "Syncing CodeGraph..." : "Working..."}
        </span>
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
