import type { ChatCommunication, ChatMessage } from "@cantrip/protocol";
import { ArrowDownLeft, ArrowUpRight, Bot } from "lucide-react";
import { Markdown } from "./markdown";
import { cn } from "@/lib/utils";

export function messageCommunication(
  message: ChatMessage,
): ChatCommunication | undefined {
  return message.content.flatMap((item) =>
    item.type === "text" && item.chatCommunication
      ? [item.chatCommunication]
      : [],
  )[0];
}

/** A first-class message row; never hidden in the turn's tool accordion. */
export function AgentChatMessage({
  message,
  communication,
  onOpenFile,
}: {
  message: ChatMessage;
  communication: ChatCommunication;
  onOpenFile(path: string, worktreeId?: string | null): void;
}) {
  const sent = communication.direction === "sent";
  return (
    <div
      className={cn("flex gap-3", sent && "justify-end")}
      data-slot="agent-chat-message"
      data-direction={communication.direction}
    >
      {!sent && (
        <div className="mt-1 grid size-7 shrink-0 place-items-center rounded-lg border bg-card">
          <Bot className="size-3.5" aria-label="Agent" />
        </div>
      )}
      <div className="min-w-0 max-w-[85%] rounded-2xl border border-violet-500/20 bg-violet-500/5 px-4 py-3 sm:max-w-[42rem]">
        <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          {sent ? (
            <ArrowUpRight className="size-3.5" />
          ) : (
            <ArrowDownLeft className="size-3.5" />
          )}
          <span>
            {sent
              ? `Sent to ${communication.targetTitle}`
              : `From ${communication.sourceTitle}`}
          </span>
          <span className="rounded border px-1.5 py-0.5 text-[10px]">
            Agent
          </span>
        </div>
        {message.content.map((item, index) =>
          item.type === "text" ? (
            <Markdown
              key={index}
              onOpenFile={(path) => onOpenFile(path, message.worktreeId)}
            >
              {item.text}
            </Markdown>
          ) : null,
        )}
      </div>
      {sent && (
        <div className="mt-1 grid size-7 shrink-0 place-items-center rounded-lg border bg-card">
          <Bot className="size-3.5" aria-label="Agent" />
        </div>
      )}
    </div>
  );
}
