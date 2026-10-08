import type {
  ChatAttachmentSummary,
  ChatComposerDraft,
} from "@cantrip/protocol";

export interface ComposerAttachmentState {
  attachment: ChatAttachmentSummary;
  contentUrl: string;
  error: string | null;
  localPreview: boolean;
  uploading: boolean;
}

export function restoreComposerDraftAttachments(
  chatId: string,
  draft: ChatComposerDraft | null,
  contentUrl: (id: string) => string,
): ComposerAttachmentState[] {
  const seen = new Set<string>();
  return (draft?.attachments ?? []).flatMap((attachment) => {
    if (
      attachment.chatId !== chatId ||
      attachment.status !== "ready" ||
      attachment.id.startsWith("local-") ||
      seen.has(attachment.id)
    )
      return [];
    seen.add(attachment.id);
    return [
      {
        attachment,
        contentUrl: contentUrl(attachment.id),
        error: null,
        localPreview: false,
        uploading: false,
      },
    ];
  });
}

export function composerDraftWithAttachments(
  draft: Omit<ChatComposerDraft, "attachments">,
  items: readonly ComposerAttachmentState[],
): ChatComposerDraft | null {
  const attachments = items
    .filter(
      ({ attachment, error, uploading, localPreview }) =>
        !error &&
        !uploading &&
        !localPreview &&
        attachment.status === "ready" &&
        !attachment.id.startsWith("local-"),
    )
    .map(({ attachment }) => attachment);
  return draft.text || attachments.length
    ? { ...draft, ...(attachments.length ? { attachments } : {}) }
    : null;
}
