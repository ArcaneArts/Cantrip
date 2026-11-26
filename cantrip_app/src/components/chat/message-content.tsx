import type { ChatAttachmentSummary, ChatMessage } from "@cantrip/protocol";
import { memo, useCallback, useState } from "react";

import { Activity } from "@/components/chat/activity";
import { AutomationRunLink } from "./automation-run-link";
import {
  AttachmentPreview,
  AttachmentViewerDialog,
} from "@/components/chat/attachment-preview";
import { Markdown } from "@/components/chat/markdown";
import { CouncilHandoffLink } from "@/components/council/council-handoff-link";
import { chatAttachmentContentUrl } from "@/lib/api";

export const MessageContent = memo(function MessageContent({
  buttonTooltips,
  message,
  onOpenFile,
  trackGlobalKey = true,
}: {
  buttonTooltips?: boolean;
  message: Pick<ChatMessage, "chatId" | "id" | "worktreeId" | "content">;
  onOpenFile(path: string, worktreeId?: string | null): void;
  trackGlobalKey?: boolean;
}) {
  const [viewingAttachment, setViewingAttachment] =
    useState<ChatAttachmentSummary | null>(null);
  const openMessageFile = useCallback(
    (path: string) => onOpenFile(path, message.worktreeId),
    [onOpenFile, message.worktreeId],
  );
  return (
    <>
      <div
        className="min-w-0 max-w-full space-y-3"
        data-elite-global-key={
          trackGlobalKey
            ? ["chat-message", message.chatId, message.id].join(":")
            : undefined
        }
      >
        {message.content.map((item, index) =>
          item.type === "text" ? (
            item.automation ? (
              <div key={"text:" + index} className="space-y-2">
                <AutomationRunLink source={item.automation} />
                {item.automation.targetKind === "project" ? (
                  <Markdown onOpenFile={openMessageFile}>{item.text}</Markdown>
                ) : null}
              </div>
            ) : item.councilPeerMessage ? (
              <CouncilHandoffLink
                key={"text:" + index}
                agentId={message.chatId}
                source={item.councilPeerMessage}
              />
            ) : item.phase === "commentary" ? (
              <div key={"text:" + index} className="text-muted-foreground">
                <Markdown onOpenFile={openMessageFile}>{item.text}</Markdown>
              </div>
            ) : (
              <Markdown key={"text:" + index} onOpenFile={openMessageFile}>
                {item.text}
              </Markdown>
            )
          ) : item.type === "attachment" ? (
            <AttachmentPreview
              buttonTooltips={buttonTooltips}
              key={"attachment:" + item.attachment.id}
              attachment={item.attachment}
              contentUrl={chatAttachmentContentUrl(item.attachment.id)}
              onOpen={() => setViewingAttachment(item.attachment)}
            />
          ) : (
            <Activity
              key={"activity:" + item.activity.id}
              activity={item.activity}
            />
          ),
        )}
      </div>
      <AttachmentViewerDialog
        buttonTooltips={buttonTooltips}
        attachment={viewingAttachment}
        contentUrl={
          viewingAttachment
            ? chatAttachmentContentUrl(viewingAttachment.id)
            : null
        }
        open={viewingAttachment !== null}
        onOpenChange={(open) => {
          if (!open) setViewingAttachment(null);
        }}
      />
    </>
  );
});
