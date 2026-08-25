import type { ChatAttachmentSummary, ChatMessage } from "@cantrip/protocol";
import { memo, useState } from "react";

import { Activity } from "@/components/chat/activity";
import {
  AttachmentPreview,
  AttachmentViewerDialog,
} from "@/components/chat/attachment-preview";
import { Markdown } from "@/components/chat/markdown";
import { chatAttachmentContentUrl } from "@/lib/api";

export const MessageContent = memo(function MessageContent({
  message,
  onOpenFile,
}: {
  message: ChatMessage;
  onOpenFile(path: string): void;
}) {
  const [viewingAttachment, setViewingAttachment] =
    useState<ChatAttachmentSummary | null>(null);
  return (
    <>
      <div
        className="min-w-0 max-w-full space-y-3"
        data-elite-global-key={[
          "chat-message",
          message.chatId,
          message.id,
        ].join(":")}
      >
        {message.content.map((item, index) =>
          item.type === "text" ? (
            item.phase === "commentary" ? (
              <div key={"text:" + index} className="text-muted-foreground">
                <Markdown onOpenFile={onOpenFile}>{item.text}</Markdown>
              </div>
            ) : (
              <Markdown key={"text:" + index} onOpenFile={onOpenFile}>
                {item.text}
              </Markdown>
            )
          ) : item.type === "attachment" ? (
            <AttachmentPreview
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
