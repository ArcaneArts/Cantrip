import { Clock3, Loader2, Pause, Play, Send, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChatNativeSuspension } from "@cantrip/protocol";
import {
  nativeSuspensionView,
  persistedTurnElapsed,
} from "./native-suspension-view";

import { Button } from "@/components/ui/button";
import { formatRunningAgentDuration } from "@/components/chat/chat-run-duration";
import { cn } from "@/lib/utils";

function RunningAgentDuration({
  paused,
  startedAtMs,
  nativeSuspension,
}: {
  paused: boolean;
  startedAtMs: number | null;
  nativeSuspension?: ChatNativeSuspension;
}) {
  const [elapsedMs, setElapsedMs] = useState(() =>
    startedAtMs === null
      ? 0
      : (persistedTurnElapsed(startedAtMs, Date.now(), nativeSuspension) ??
        Math.max(0, Date.now() - startedAtMs)),
  );
  const timingRef = useRef({
    pausedAtMs: paused && startedAtMs !== null ? Date.now() : null,
    startedAtMs,
    totalPausedMs: 0,
  });

  useEffect(() => {
    const nowMs = Date.now();
    const timing = timingRef.current;
    if (timing.startedAtMs !== startedAtMs) {
      timing.startedAtMs = startedAtMs;
      timing.totalPausedMs = 0;
      timing.pausedAtMs = paused && startedAtMs !== null ? nowMs : null;
    } else if (paused) {
      timing.pausedAtMs ??= nowMs;
    } else if (timing.pausedAtMs !== null) {
      timing.totalPausedMs += Math.max(0, nowMs - timing.pausedAtMs);
      timing.pausedAtMs = null;
    }

    const updateElapsed = () => {
      if (startedAtMs === null) {
        setElapsedMs(0);
        return;
      }
      const retained = persistedTurnElapsed(
        startedAtMs,
        Date.now(),
        nativeSuspension,
      );
      if (retained !== null) {
        setElapsedMs(retained);
        return;
      }
      const current = timingRef.current;
      const sampledAtMs = current.pausedAtMs ?? Date.now();
      setElapsedMs(
        Math.max(0, sampledAtMs - startedAtMs - current.totalPausedMs),
      );
    };
    updateElapsed();
    if (
      startedAtMs === null ||
      (nativeSuspension?.active ? !!nativeSuspension.pausedAt : paused)
    )
      return;
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [paused, startedAtMs, nativeSuspension]);

  if (startedAtMs === null) return null;
  const elapsed = formatRunningAgentDuration(elapsedMs);
  return (
    <span
      className="flex shrink-0 items-center gap-1 px-1 text-xs text-muted-foreground tabular-nums"
      title={`Agent working for ${elapsed}`}
      aria-label={`Agent working for ${elapsed}`}
    >
      <Clock3 aria-hidden="true" className="size-3.5" />
      <span>{elapsed}</span>
    </span>
  );
}

export function ChatComposerPrimaryActions({
  active,
  agentStartedAtMs,
  onPauseChange,
  onStop,
  pauseDisabled,
  pausePending,
  paused,
  nativeSuspension,
  pauseRequested,
  sendDisabled,
  sendPending,
  stopDisabled,
  stopPending,
}: {
  active: boolean;
  agentStartedAtMs: number | null;
  onPauseChange(paused: boolean): void;
  onStop(): void;
  pauseDisabled: boolean;
  pausePending: boolean;
  paused: boolean;
  nativeSuspension?: ChatNativeSuspension;
  pauseRequested?: boolean;
  sendDisabled: boolean;
  sendPending: boolean;
  stopDisabled: boolean;
  stopPending: boolean;
}) {
  const recovery = nativeSuspensionView(
    nativeSuspension,
    pausePending ? pauseRequested : undefined,
  );
  const label =
    recovery?.label ?? (paused ? "Resume automatic agent work" : "Pause agent");
  if (!active && !recovery) {
    return (
      <>
        {paused && !nativeSuspension?.active ? (
          <Button
            size="icon"
            type="button"
            variant="outline"
            className="size-8 shrink-0 rounded-lg"
            disabled={pauseDisabled || pausePending}
            onClick={() => onPauseChange(false)}
            title="Resume automatic agent work"
            aria-label="Resume automatic agent work"
          >
            {pausePending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
          </Button>
        ) : null}
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
      </>
    );
  }

  return (
    <>
      {recovery ? (
        <span role="status" className="text-xs text-muted-foreground">
          {recovery.status}
        </span>
      ) : null}
      {recovery?.error ? (
        <span role="alert" className="max-w-64 text-xs text-destructive">
          {recovery.error}
        </span>
      ) : null}
      <RunningAgentDuration
        paused={paused}
        startedAtMs={agentStartedAtMs}
        nativeSuspension={nativeSuspension}
      />
      <Button
        type="button"
        size="icon"
        variant="outline"
        className={cn(
          "size-8 shrink-0 rounded-lg",
          paused &&
            "border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-300",
        )}
        disabled={pauseDisabled || recovery?.pending || recovery?.blocked}
        onClick={() => onPauseChange(recovery?.nextPaused ?? !paused)}
        title={
          recovery
            ? label
            : paused
              ? "Resume automatic agent work"
              : "Pause after the current safe boundary"
        }
        aria-label={label}
      >
        {pausePending || recovery?.pending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : recovery ? (
          !recovery.nextPaused ? (
            <Play className="size-3.5" />
          ) : (
            <Pause className="size-3.5" />
          )
        ) : paused ? (
          <Play className="size-3.5" />
        ) : (
          <Pause className="size-3.5" />
        )}
      </Button>
      {recovery?.resumeAlso ? (
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="size-8 shrink-0"
          disabled={pauseDisabled}
          aria-label="Resume automatic agent work"
          title="Resume automatic agent work"
          onClick={() => onPauseChange(false)}
        >
          <Play className="size-3.5" />
        </Button>
      ) : null}
      <Button
        size="icon"
        type="button"
        variant="outline"
        className="size-8 shrink-0 rounded-lg border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
        disabled={stopDisabled}
        title="Stop current operation"
        aria-label="Stop current operation"
        onPointerDown={(event) => event.preventDefault()}
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
