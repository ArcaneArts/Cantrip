import type { ChatMessage } from "@cantrip/protocol";
import { Bot, Check, Copy, GitFork, Loader2, Pencil, User } from "lucide-react";
import { memo, type FormEvent, type RefObject } from "react";

import {
  ActivityGroup,
  CompletedTurnActivityGroup,
} from "@/components/chat/activity";
import type { AgentTranscriptEntry } from "@/components/chat/agent-turn-projection";
import {
  editableMessageAttachments,
  editableMessageText,
} from "@/components/chat/latest-message-edit";
import { MessageContent } from "@/components/chat/message-content";
import { SubagentLifecycleCard } from "@/components/chat/subagent-lifecycle-card";
import { formatTurnMetadata } from "@/components/chat/timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface EditingSentMessage {
  error: string | null;
  id: string;
  text: string;
}

export interface ChatTranscriptEntriesProps {
  copiedMessageId: string | null;
  editedMessageRef: RefObject<HTMLTextAreaElement | null>;
  editingSentMessage: EditingSentMessage | null;
  entries: readonly AgentTranscriptEntry[];
  forkPending: boolean;
  latestEditableMessageId: string | null;
  latestLiveActivityGroupKey: string | null;
  retryPending: boolean;
  onCancelEditingMessage(): void;
  onChangeEditingMessage(messageId: string, text: string): void;
  onCopyResponse(messageId: string, text: string): Promise<void>;
  onEditMessage(message: ChatMessage): void;
  onForkMessage(messageId: string): void;
  onOpenFile(path: string): void;
  onSubmitEditedMessage(message: ChatMessage, event?: FormEvent): void;
  onViewSubagent?: (agentKey: string) => void;
  onViewTrajectory?: (turnKey: string) => void;
}

export const ChatTranscriptEntries = memo(function ChatTranscriptEntries({
  copiedMessageId,
  editedMessageRef,
  editingSentMessage,
  entries,
  forkPending,
  latestEditableMessageId,
  latestLiveActivityGroupKey,
  retryPending,
  onCancelEditingMessage,
  onChangeEditingMessage,
  onCopyResponse,
  onEditMessage,
  onForkMessage,
  onOpenFile,
  onSubmitEditedMessage,
  onViewSubagent,
  onViewTrajectory,
}: ChatTranscriptEntriesProps) {
  return entries.map((transcriptEntry) => {
    if (transcriptEntry.type === "agent") {
      if (!onViewSubagent) return null;
      return (
        <SubagentLifecycleCard
          agent={transcriptEntry.agent}
          key={"agent:" + transcriptEntry.agent.key}
          onOpen={onViewSubagent}
        />
      );
    }
    const entry = transcriptEntry.entry;
    if (entry.type === "activityGroup") {
      if (entry.kind === "turn") {
        return (
          <CompletedTurnActivityGroup
            endedAt={entry.endedAt}
            key={entry.key}
            onViewTrajectory={onViewTrajectory}
            startedAt={entry.startedAt}
            turnId={entry.turnId}
            turnKey={entry.turnKey}
          >
            {entry.messages.map((message) => (
              <MessageContent
                key={message.id}
                message={message}
                onOpenFile={onOpenFile}
              />
            ))}
          </CompletedTurnActivityGroup>
        );
      }
      if (entry.kind === "compaction") {
        return (
          <div
            data-turn-id={entry.turnId ?? undefined}
            data-turn-key={entry.turnKey}
            key={entry.key}
          >
            {entry.messages.map((message) => (
              <MessageContent
                key={message.id}
                message={message}
                onOpenFile={onOpenFile}
              />
            ))}
          </div>
        );
      }
      const groupedActivities = entry.messages.flatMap((message) =>
        message.content.flatMap((item) =>
          item.type === "activity" ? [item.activity] : [],
        ),
      );
      return (
        <ActivityGroup
          activities={groupedActivities}
          active={entry.key === latestLiveActivityGroupKey}
          key={entry.key}
          onViewTrajectory={onViewTrajectory}
          turnId={entry.turnId}
          turnKey={entry.turnKey}
        />
      );
    }
    const message = entry.message;
    const turnMetadata = formatTurnMetadata(entry.turnMetadata);
    const user = message.role === "user";
    const system = message.role === "system";
    const workThought =
      message.role === "assistant" &&
      message.content.every(
        (item) =>
          (item.type === "text" && item.phase === "commentary") ||
          (item.type === "activity" && item.activity.type === "reasoning"),
      );
    const assistantText =
      message.role === "assistant"
        ? message.content
            .flatMap((item) =>
              item.type === "text" && item.phase !== "commentary"
                ? [item.text]
                : [],
            )
            .join("\n\n")
        : "";
    const editingThisMessage = user && editingSentMessage?.id === message.id;
    const messageAttachments = user ? editableMessageAttachments(message) : [];
    return (
      <div
        key={message.id}
        data-chat-history-anchor={user ? message.id : undefined}
        className={cn("flex gap-3", user && "justify-end")}
      >
        {!user && !workThought ? (
          <div
            className={cn(
              "mt-1 grid size-7 shrink-0 place-items-center rounded-lg border bg-card",
              system && "border-destructive/30 text-destructive",
            )}
          >
            <Bot className="size-3.5" />
          </div>
        ) : null}
        <div
          data-chat-message-role={user ? "user" : undefined}
          className={cn(
            "min-w-0",
            user &&
              "max-w-[85%] overflow-hidden rounded-2xl border border-transparent bg-muted/80 px-4 py-3 text-foreground sm:max-w-[42rem]",
            editingThisMessage && "w-full",
            !user && !system && "flex-1 py-1",
            system &&
              "max-w-[85%] overflow-hidden rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-destructive",
          )}
        >
          {user && message.mode !== "default" ? (
            <Badge
              variant="outline"
              className={cn(
                "mb-2 h-5 capitalize",
                message.mode === "goal"
                  ? "border-violet-500/30 text-violet-600 dark:text-violet-400"
                  : "border-sky-500/30 text-sky-600 dark:text-sky-400",
              )}
            >
              {message.mode} mode
            </Badge>
          ) : null}
          {editingThisMessage ? (
            <form
              className="space-y-3"
              onSubmit={(event) => onSubmitEditedMessage(message, event)}
            >
              <textarea
                ref={editedMessageRef}
                aria-label="Edit latest message"
                className="max-h-[min(60vh,32rem)] min-h-40 w-full field-sizing-content resize-y overflow-y-auto bg-transparent text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground"
                disabled={retryPending}
                onChange={(event) =>
                  onChangeEditingMessage(message.id, event.target.value)
                }
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    onSubmitEditedMessage(message);
                  }
                }}
                rows={1}
                value={editingSentMessage.text}
              />
              {messageAttachments.length > 0 ? (
                <MessageContent
                  message={{
                    ...message,
                    content: messageAttachments.map((attachment) => ({
                      type: "attachment" as const,
                      attachment,
                    })),
                  }}
                  onOpenFile={onOpenFile}
                />
              ) : null}
              {editingSentMessage.error ? (
                <p className="text-xs text-destructive" role="alert">
                  {editingSentMessage.error}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button
                  disabled={retryPending}
                  onClick={onCancelEditingMessage}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </Button>
                <Button
                  disabled={
                    retryPending ||
                    (!editingSentMessage.text.trim() &&
                      messageAttachments.length === 0)
                  }
                  size="sm"
                  type="submit"
                >
                  {retryPending ? <Loader2 className="animate-spin" /> : null}
                  Send
                </Button>
              </div>
            </form>
          ) : (
            <MessageContent message={message} onOpenFile={onOpenFile} />
          )}
          {user && message.providerName ? (
            <p className="mt-1.5 truncate text-[10px] text-muted-foreground">
              {message.providerName}
              {message.providerModelName
                ? " · " + message.providerModelName
                : ""}
            </p>
          ) : null}
          {assistantText ? (
            <div className="mt-2 flex items-center gap-1 text-muted-foreground">
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                title="Copy response"
                onClick={() => void onCopyResponse(message.id, assistantText)}
              >
                {copiedMessageId === message.id ? (
                  <Check className="size-3.5" />
                ) : (
                  <Copy className="size-3.5" />
                )}
                <span className="sr-only">Copy response</span>
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                title="Fork agent from this response"
                disabled={forkPending}
                onClick={() => onForkMessage(message.id)}
              >
                <GitFork className="size-3.5" />
                <span className="sr-only">Fork agent from this response</span>
              </Button>
              {turnMetadata ? (
                <span className="ml-1 text-[10px] tabular-nums text-muted-foreground/70">
                  {turnMetadata}
                </span>
              ) : null}
            </div>
          ) : null}
          {user &&
          !editingThisMessage &&
          latestEditableMessageId === message.id ? (
            <div className="mt-2 flex justify-end">
              <Button
                aria-label="Edit and resend latest message"
                className="size-7 text-muted-foreground"
                onClick={() => onEditMessage(message)}
                size="icon"
                title="Edit and resend"
                type="button"
                variant="ghost"
              >
                <Pencil className="size-3.5" />
              </Button>
            </div>
          ) : null}
        </div>
        {user ? (
          <div className="mt-1 grid size-7 shrink-0 place-items-center rounded-lg bg-muted">
            <User className="size-3.5" />
          </div>
        ) : null}
      </div>
    );
  });
});
