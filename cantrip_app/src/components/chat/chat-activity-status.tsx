import type { ChatSummary } from "@cantrip/protocol";
import { CircleHelp, CirclePause, Loader2 } from "lucide-react";

export function ChatActivityStatus({ chat }: { chat: ChatSummary }) {
  return chat.hasPendingPlanQuestion ? (
    <CircleHelp
      className="ml-auto size-3.5 text-amber-500"
      aria-label="Codex is waiting for a Plan Mode answer"
    />
  ) : chat.automationPaused ? (
    <CirclePause
      className="ml-auto size-3.5 text-amber-500"
      aria-label="Agent automation is paused"
    />
  ) : chat.status === "running" ? (
    <Loader2 className="ml-auto size-3 animate-spin" />
  ) : chat.hasUnreadCompletion ? (
    <span
      aria-label="Agent turn finished; open to dismiss"
      className="ml-auto size-1.5 shrink-0 rounded-full bg-sky-400"
      role="status"
      title="Agent turn finished"
    />
  ) : null;
}
