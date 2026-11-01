import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/error-message";

const RECONNECT_DELAY_MS = 5_000;

export function WorkspaceReconnectBanner({
  error,
  retry,
}: {
  error: unknown;
  retry(): void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [remainingMs, setRemainingMs] = useState(RECONNECT_DELAY_MS);
  const [attempted, setAttempted] = useState(false);
  const remaining = useRef(RECONNECT_DELAY_MS);
  const fired = useRef(false);
  const cancelTimer = useRef(() => {});
  const paused = hovered || focused;

  const reconnect = useCallback(() => {
    if (fired.current) return;
    fired.current = true;
    cancelTimer.current();
    setAttempted(true);
    setRemainingMs(0);
    retry();
  }, [retry]);

  useEffect(() => {
    remaining.current = RECONNECT_DELAY_MS;
    fired.current = false;
    setRemainingMs(RECONNECT_DELAY_MS);
    setAttempted(false);
  }, [retry]);

  useEffect(() => {
    if (paused || fired.current) return;
    const startedAt = performance.now();
    const duration = remaining.current;
    let stopped = false;
    const timeLeft = () =>
      Math.max(0, duration - (performance.now() - startedAt));
    const update = setInterval(() => setRemainingMs(timeLeft()), 100);
    const timeout = setTimeout(reconnect, duration);
    const cancel = () => {
      if (stopped) return;
      stopped = true;
      remaining.current = timeLeft();
      clearInterval(update);
      clearTimeout(timeout);
    };
    cancelTimer.current = cancel;
    return cancel;
  }, [paused, reconnect]);

  const pause = () => {
    cancelTimer.current();
    setRemainingMs(remaining.current);
  };
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-3 border-b border-amber-500/30 px-3 py-2 text-sm"
      data-workspace-reconnect=""
      onMouseEnter={() => {
        pause();
        setHovered(true);
      }}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => {
        pause();
        setFocused(true);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}
    >
      <div className="min-w-0 flex-1">
        <p>Workspace connection unavailable</p>
        {error ? (
          <p className="break-words text-xs text-muted-foreground">
            {errorMessage(error)}
          </p>
        ) : null}
      </div>
      <Button
        size="sm"
        variant="outline"
        className="relative overflow-hidden"
        disabled={attempted}
        onClick={reconnect}
        title="Reconnects automatically after five seconds. Hover over this area or focus the button to pause."
      >
        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-0.5 bg-amber-500/20"
        >
          <span
            className="block h-full bg-amber-500 transition-[width] duration-100 ease-linear motion-reduce:transition-none"
            data-reconnect-progress=""
            style={{
              width: `${100 * (1 - remainingMs / RECONNECT_DELAY_MS)}%`,
            }}
          />
        </span>
        {attempted ? "Reconnecting…" : "Reconnect"}
        {!attempted ? (
          <span aria-hidden="true" className="text-xs text-muted-foreground">
            {paused ? "Paused" : `${Math.ceil(remainingMs / 1000)}s`}
          </span>
        ) : null}
      </Button>
    </div>
  );
}
