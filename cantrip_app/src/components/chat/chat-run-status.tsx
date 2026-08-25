import type { ChatSummary, InferenceProgressSnapshot } from "@cantrip/protocol";
import { Bot, Pause } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface ChatRunStatusProps {
  automationPaused: boolean;
  hasLiveActivity: boolean;
  hasStreamingFinalAnswer: boolean;
  inferenceProgress: InferenceProgressSnapshot | null;
  syncingCodeGraph: boolean;
  status: ChatSummary["status"];
  waitingForPlanAnswer: boolean;
}

function prefillPercent(progress: InferenceProgressSnapshot): number | null {
  if (
    progress.precision === "indeterminate" ||
    progress.fractionComplete === null
  ) {
    return null;
  }
  return Math.min(100, Math.floor(progress.fractionComplete * 100));
}

export function formatPrefillTokenCount(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`;
  return `${Math.round(tokens / 1_000)}k`;
}

function PrefillProgressStatus({
  progress,
}: {
  progress: InferenceProgressSnapshot;
}) {
  const percent = prefillPercent(progress);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPointerType = useRef<string | null>(null);
  const cancelClose = () => {
    if (closeTimer.current === null) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      setPopoverOpen(false);
      closeTimer.current = null;
    }, 160);
  };
  useEffect(
    () => () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    },
    [],
  );
  const handlePointerEnter = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType !== "mouse") return;
    cancelClose();
    setPopoverOpen(true);
  };
  const handlePointerLeave = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse") scheduleClose();
  };
  const label = percent === null ? "Prefilling" : `Prefilling ${percent}%`;
  const tokenLabel =
    progress.completedTokens === null
      ? "Prompt token counts unavailable"
      : progress.totalTokens === null
        ? `${formatPrefillTokenCount(progress.completedTokens)} tokens prefetched`
        : `${formatPrefillTokenCount(progress.completedTokens)} of ${formatPrefillTokenCount(progress.totalTokens)} prompt tokens`;

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverAnchor asChild>
        <button
          aria-label={`${label}. ${tokenLabel}`}
          className="flex items-center gap-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onBlur={scheduleClose}
          onClick={() => {
            if (
              lastPointerType.current === null ||
              lastPointerType.current === "mouse"
            ) {
              setPopoverOpen(true);
            } else {
              setPopoverOpen((current) => !current);
            }
            lastPointerType.current = null;
          }}
          onFocus={() => {
            if (
              lastPointerType.current === null ||
              lastPointerType.current === "mouse"
            ) {
              cancelClose();
              setPopoverOpen(true);
            }
          }}
          onPointerDown={(event) => {
            lastPointerType.current = event.pointerType;
          }}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
          type="button"
        >
          <svg
            aria-label="Prompt prefill progress"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={percent ?? undefined}
            aria-valuetext={percent === null ? "Unavailable" : `${percent}%`}
            className="size-[18px] shrink-0 -rotate-90 text-[#ff168f]"
            role="progressbar"
            viewBox="0 0 20 20"
          >
            <circle
              className="text-border"
              cx="10"
              cy="10"
              fill="none"
              pathLength="100"
              r="7.5"
              stroke="currentColor"
              strokeDasharray={percent === null ? "3 3" : undefined}
              strokeWidth="2"
            />
            {percent !== null ? (
              <circle
                cx="10"
                cy="10"
                fill="none"
                pathLength="100"
                r="7.5"
                stroke="currentColor"
                strokeDasharray={`${percent} 100`}
                strokeLinecap="round"
                strokeWidth="2"
              />
            ) : null}
          </svg>
          <span className="chat-working-shimmer">{label}</span>
        </button>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-60 space-y-2 p-3"
        onBlurCapture={scheduleClose}
        onFocusCapture={cancelClose}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        side="top"
        sideOffset={6}
      >
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold tabular-nums">{label}</p>
          <span className="text-[10px] capitalize text-muted-foreground">
            {progress.precision}
          </span>
        </div>
        <div
          aria-label="Prompt prefill progress"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={percent ?? undefined}
          aria-valuetext={percent === null ? "Unavailable" : `${percent}%`}
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
        >
          <div
            className={cn(
              "h-full rounded-full bg-[#ff168f]",
              percent === null && "w-1/3 motion-safe:animate-pulse",
            )}
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>
        <p className="text-xs tabular-nums text-muted-foreground">
          {tokenLabel}
        </p>
      </PopoverContent>
    </Popover>
  );
}

export function ChatRunStatus({
  automationPaused,
  hasLiveActivity,
  hasStreamingFinalAnswer,
  inferenceProgress,
  syncingCodeGraph,
  status,
  waitingForPlanAnswer,
}: ChatRunStatusProps) {
  if (status !== "running" && status !== "waiting-for-approval") return null;

  if (status === "running" && !automationPaused && !waitingForPlanAnswer) {
    if (hasLiveActivity && !hasStreamingFinalAnswer && !inferenceProgress) {
      return null;
    }
    if (hasStreamingFinalAnswer) {
      return (
        <div
          aria-live="polite"
          className="text-sm"
          data-elite-ignore=""
          role="status"
        >
          <span className="chat-working-shimmer">Finishing...</span>
        </div>
      );
    }
    if (inferenceProgress?.phase === "prefill") {
      return (
        <div
          aria-live="polite"
          className="text-sm"
          data-elite-ignore=""
          role="status"
        >
          <PrefillProgressStatus progress={inferenceProgress} />
        </div>
      );
    }
    const label = inferenceProgress
      ? (() => {
          if (inferenceProgress.phase === "queued") return "Queued...";
          if (inferenceProgress.phase === "loading") return "Loading model...";
          if (inferenceProgress.phase === "generating") return "Generating...";
          return "Working...";
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
