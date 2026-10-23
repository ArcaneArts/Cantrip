import type { ReactNode } from "react";
import { PanelToolbar } from "@/components/workspace/panel-toolbar";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Pause, Play, Square } from "lucide-react";
import { useChatExecutionControls } from "@/components/chat/use-chat-execution-controls";
import { Button } from "@/components/ui/button";
import { getChats } from "@/lib/api";
import { errorMessage as errorText } from "@/lib/error-message";

/** The PTY's running state means the shell is alive, not that a turn is active.
 * Read the same canonical chat cache as the GUI; input remains server-resolved
 * even when that observation is stale or unavailable. */
export function LinkedConsoleControls({
  actions,
  chatId,
  projectId,
}: {
  actions?: ReactNode;
  chatId: string;
  projectId: string;
}) {
  const projectChatQueryKey = ["chats", projectId] as const;
  const chats = useQuery({
    queryKey: projectChatQueryKey,
    queryFn: () => getChats(projectId),
  });
  const chat = chats.data?.find((entry) => entry.id === chatId);
  const { setAutomationPaused, interrupt } = useChatExecutionControls({
    chatId,
    projectId,
    projectChatQueryKey,
  });
  const paused = chat?.automationPaused ?? false;
  let status = chats.isPending
    ? "Loading agent status…"
    : "Agent status unavailable";
  if (chat) {
    if (chat.hasPendingPlanQuestion) status = "Waiting for an answer";
    else if (chat.status === "waiting-for-approval")
      status = "Waiting for approval";
    else if (chat.status === "failed") status = "Last turn failed";
    else if (paused) status = "Automatic work paused";
    else status = chat.status === "running" ? "Working" : "Ready";
  }
  if (setAutomationPaused.isPending)
    status = setAutomationPaused.variables
      ? "Pausing at the next safe boundary…"
      : "Resuming…";
  return (
    <div className="shrink-0" data-slot="linked-console-controls">
      <PanelToolbar aria-label="Agent console controls">
        <span
          role="status"
          className="min-w-0 flex-1 text-xs text-muted-foreground"
        >
          {status}
          {paused &&
          (chat?.hasPendingPlanQuestion ||
            chat?.status === "waiting-for-approval" ||
            chat?.status === "failed") &&
          !setAutomationPaused.isPending
            ? " · automatic work paused"
            : ""}
        </span>
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="size-8 shrink-0"
          disabled={setAutomationPaused.isPending}
          aria-label={paused ? "Resume automatic agent work" : "Pause agent"}
          title={
            paused
              ? "Resume automatic agent work"
              : "Pause after the current safe boundary"
          }
          onClick={() => setAutomationPaused.mutate(!paused)}
        >
          {setAutomationPaused.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : paused ? (
            <Play className="size-3.5" />
          ) : (
            <Pause className="size-3.5" />
          )}
        </Button>
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="size-8 shrink-0 text-destructive"
          disabled={interrupt.isPending}
          aria-label="Stop current operation"
          title="Stop current operation"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => interrupt.mutate()}
        >
          {interrupt.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Square className="size-3 fill-current" />
          )}
        </Button>
        {actions}
      </PanelToolbar>
      {chats.error ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          Could not read agent status: {errorText(chats.error)}
        </p>
      ) : null}
      {setAutomationPaused.error ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          Could not change pause state: {errorText(setAutomationPaused.error)}
        </p>
      ) : null}
      {interrupt.error ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          Could not stop the agent: {errorText(interrupt.error)}
        </p>
      ) : null}
    </div>
  );
}
