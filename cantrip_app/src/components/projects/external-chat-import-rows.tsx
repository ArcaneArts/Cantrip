import type { ChatImportJobSummary } from "@cantrip/protocol";
import {
  Archive,
  CircleAlert,
  ExternalLink,
  Loader2,
  RotateCcw,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  activeImportStates,
  importStateLabel,
  type ExternalChatImportCandidate,
} from "./external-chat-import-model";

const updatedDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function ExternalChatCandidateRow({
  candidate,
  checked,
  disabled,
  matchedWorktreeLabel,
  onCheckedChange,
}: {
  candidate: ExternalChatImportCandidate;
  checked: boolean;
  disabled: boolean;
  matchedWorktreeLabel: string;
  onCheckedChange(checked: boolean): void;
}) {
  const job = candidate.existingJob;
  return (
    <label
      className={cn(
        "grid cursor-pointer grid-cols-[1.25rem_minmax(0,1fr)] gap-3 px-3 py-3 transition-colors hover:bg-muted/50",
        disabled && "cursor-default opacity-70 hover:bg-transparent",
      )}
    >
      <input
        type="checkbox"
        className="mt-0.5 size-4"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
      <span className="min-w-0">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">
            {candidate.thread.title}
          </span>
          {candidate.thread.archived ? (
            <Badge variant="outline" className="gap-1 text-[9px]">
              <Archive className="size-3" /> Archived
            </Badge>
          ) : null}
          {job ? (
            <Badge
              variant={job.state === "succeeded" ? "secondary" : "outline"}
              className="text-[9px]"
            >
              {importStateLabel(job)}
            </Badge>
          ) : null}
        </span>
        {candidate.thread.preview ? (
          <span className="mt-1 block truncate text-xs text-muted-foreground">
            {candidate.thread.preview}
          </span>
        ) : null}
        <span className="mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
          <span>
            {updatedDate.format(new Date(candidate.thread.updatedAt))}
          </span>
          <span>{candidate.sourceWorkerName}</span>
          <span>{candidate.thread.modelProvider}</span>
          <span>{matchedWorktreeLabel}</span>
          <span className="max-w-full truncate font-mono">
            {candidate.thread.cwd}
          </span>
          {candidate.thread.git?.branch ? (
            <span>{candidate.thread.git.branch}</span>
          ) : null}
        </span>
      </span>
    </label>
  );
}

export function ImportJobRow({
  job,
  pendingRetry,
  title,
  onOpenChat,
  onRetry,
}: {
  job: ChatImportJobSummary;
  pendingRetry: boolean;
  title?: string;
  onOpenChat(chatId: string): void;
  onRetry(job: ChatImportJobSummary): void;
}) {
  const active = activeImportStates.has(job.state);
  return (
    <div className="space-y-2 px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {job.sourceMetadata?.title ?? title ?? "Codex chat import"}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {importStateLabel(job)} · {job.progress.message}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {job.chatId ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onOpenChat(job.chatId!)}
            >
              <ExternalLink className="size-3.5" />
              {job.state === "succeeded" ? "Open chat" : "Open transcript"}
            </Button>
          ) : null}
          {job.error?.retryable ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pendingRetry}
              onClick={() => onRetry(job)}
            >
              {pendingRetry ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw className="size-3.5" />
              )}
              Retry
            </Button>
          ) : null}
        </div>
      </div>
      {active ? (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-foreground transition-[width]"
            style={{ width: `${job.progress.percent}%` }}
          />
        </div>
      ) : null}
      {job.error ? (
        <p className="flex gap-1.5 text-xs text-destructive">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          {job.error.message}
        </p>
      ) : null}
      {job.attachmentWarningCount > 0 ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {job.attachmentWarningCount} attachment
          {job.attachmentWarningCount === 1 ? " was" : "s were"} unavailable and
          preserved as {job.attachmentWarningCount === 1 ? "a" : ""}
          placeholder{job.attachmentWarningCount === 1 ? "" : "s"}.
        </p>
      ) : null}
    </div>
  );
}
