import type {
  ChatAttachmentSummary,
  ChatMessage,
  ChatSummary,
} from "@cantrip/protocol";

export function latestEditableUserMessage(
  messages: readonly ChatMessage[],
  status: ChatSummary["status"],
  automationPaused: boolean,
): ChatMessage | null {
  if (
    automationPaused ||
    status === "running" ||
    status === "waiting-for-approval"
  ) {
    return null;
  }
  const latest = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  return latest?.modelId && latest.modelRouteId ? latest : null;
}

export function editableMessageText(message: ChatMessage): string {
  return message.content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n\n");
}

export function editableMessageAttachments(
  message: ChatMessage,
): ChatAttachmentSummary[] {
  return message.content.flatMap((item) =>
    item.type === "attachment" ? [item.attachment] : [],
  );
}
