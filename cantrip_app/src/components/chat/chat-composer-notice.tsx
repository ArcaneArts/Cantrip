import {
  CircleAlert,
  CircleCheck,
  Info,
  Loader2,
  TriangleAlert,
} from "lucide-react";

import { cn } from "@/lib/utils";

export const CHAT_COMPOSER_NOTICE_AUTO_DISMISS_MS = 4_000;

export type ChatComposerNoticeTone =
  "error" | "neutral" | "success" | "warning";

export function scheduleChatComposerNoticeDismiss(
  onDismiss: () => void,
  autoDismissMs = CHAT_COMPOSER_NOTICE_AUTO_DISMISS_MS,
): () => void {
  if (autoDismissMs <= 0) return () => undefined;
  const timer = window.setTimeout(onDismiss, autoDismissMs);
  return () => window.clearTimeout(timer);
}

export function ChatComposerNotice({
  loading = false,
  message,
  tone = "neutral",
}: {
  loading?: boolean;
  message: string;
  tone?: ChatComposerNoticeTone;
}) {
  const Icon = loading
    ? Loader2
    : tone === "error"
      ? CircleAlert
      : tone === "success"
        ? CircleCheck
        : tone === "warning"
          ? TriangleAlert
          : Info;

  return (
    <div
      aria-live="polite"
      data-slot="chat-composer-notice"
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "mb-2 flex min-h-6 items-center justify-center gap-2 px-3 text-center text-xs text-muted-foreground",
        tone === "error" && "text-destructive",
        tone === "success" && "text-emerald-700 dark:text-emerald-300",
        tone === "warning" && "text-amber-700 dark:text-amber-300",
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn("size-3.5 shrink-0", loading && "animate-spin")}
      />
      <span>{message}</span>
    </div>
  );
}
