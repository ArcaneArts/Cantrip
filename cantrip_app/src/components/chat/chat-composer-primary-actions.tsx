import { Loader2, Pause, Play, Send, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ChatComposerPrimaryActions({
  active,
  onPauseChange,
  onStop,
  pauseDisabled,
  pausePending,
  paused,
  sendDisabled,
  sendPending,
  stopDisabled,
  stopPending,
}: {
  active: boolean;
  onPauseChange(paused: boolean): void;
  onStop(): void;
  pauseDisabled: boolean;
  pausePending: boolean;
  paused: boolean;
  sendDisabled: boolean;
  sendPending: boolean;
  stopDisabled: boolean;
  stopPending: boolean;
}) {
  if (!active) {
    return (
      <Button
        size="icon"
        type="submit"
        className="size-8 shrink-0 rounded-lg"
        disabled={sendDisabled}
      >
        {sendPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Send className="size-3.5" />
        )}
        <span className="sr-only">Send prompt</span>
      </Button>
    );
  }

  return (
    <>
      <Button
        type="button"
        size="icon"
        variant="outline"
        className={cn(
          "size-8 shrink-0 rounded-lg",
          paused &&
            "border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-300",
        )}
        disabled={pauseDisabled}
        onClick={() => onPauseChange(!paused)}
        title={
          paused
            ? "Resume automatic agent work"
            : "Pause after the current safe boundary"
        }
        aria-label={paused ? "Resume automatic agent work" : "Pause agent"}
      >
        {pausePending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : paused ? (
          <Play className="size-3.5" />
        ) : (
          <Pause className="size-3.5" />
        )}
      </Button>
      <Button
        size="icon"
        type="button"
        variant="outline"
        className="size-8 shrink-0 rounded-lg border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
        disabled={stopDisabled}
        title="Stop current operation"
        aria-label="Stop current operation"
        onClick={onStop}
      >
        {stopPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Square className="size-3 fill-current" />
        )}
      </Button>
    </>
  );
}
