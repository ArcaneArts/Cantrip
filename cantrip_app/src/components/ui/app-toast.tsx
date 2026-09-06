import { CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

export const APP_TOAST_AUTO_DISMISS_MS = 6_000;
export const APP_TOAST_VIEWPORT_CLASS_NAME =
  "pointer-events-none fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-[max(0.75rem,env(safe-area-inset-left))] right-[max(0.75rem,env(safe-area-inset-right))] top-[max(0.75rem,env(safe-area-inset-top))] z-[100] flex flex-col items-end gap-2 overflow-hidden";

export type AppToastTone = "error" | "info" | "warning";

export type AppToastInput = {
  message: string;
  title: string;
  tone: AppToastTone;
};

export function scheduleAppToastDismiss(
  onDismiss: () => void,
  autoDismissMs: number,
): () => void {
  if (autoDismissMs <= 0) return () => undefined;
  const timer = window.setTimeout(onDismiss, autoDismissMs);
  return () => window.clearTimeout(timer);
}

export function AppToast({
  autoDismissMs = APP_TOAST_AUTO_DISMISS_MS,
  className,
  dismissLabel = "Dismiss notification",
  message,
  onDismiss,
  title,
  tone,
}: AppToastInput & {
  autoDismissMs?: number;
  className?: string;
  dismissLabel?: string;
  onDismiss(): void;
}) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    return scheduleAppToastDismiss(() => onDismissRef.current(), autoDismissMs);
  }, [autoDismissMs, message, title, tone]);

  const Icon =
    tone === "error" ? CircleAlert : tone === "warning" ? TriangleAlert : Info;

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      data-slot="app-toast"
      data-tone={tone}
      className={cn(
        "pointer-events-auto flex w-full max-w-96 items-start gap-2.5 rounded-lg border bg-neutral-950/95 px-3 py-2.5 text-left text-xs text-neutral-100 shadow-2xl backdrop-blur-xl",
        tone === "error"
          ? "border-destructive/70"
          : tone === "warning"
            ? "border-amber-500/60"
            : "border-white/20",
        className,
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "error"
            ? "text-red-400"
            : tone === "warning"
              ? "text-amber-300"
              : "text-neutral-300",
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-neutral-100">{title}</span>
        <span className="mt-0.5 block break-words text-neutral-300">
          {message}
        </span>
      </span>
      <button
        aria-label={dismissLabel}
        className="-mr-1 -mt-1 grid size-7 shrink-0 place-items-center rounded-md text-neutral-400 transition-colors hover:bg-white/10 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
        onClick={onDismiss}
        title={dismissLabel}
        type="button"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
