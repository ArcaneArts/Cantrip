import type {
  ChatAttachmentKind,
  ChatAttachmentSource,
  ChatAttachmentSummary,
} from "@cantrip/protocol";
import {
  protectAttachmentUpload,
  openAttachmentOpaqueSummary,
  openAttachmentDownload,
} from "@/lib/attachment-encryption";
import { requestResponse, request } from "@/lib/api-client";
import {
  attachmentUploadOpaqueSchema,
  chatAttachmentOpaqueSummarySchema,
  attachmentDownloadOpaqueSchema,
} from "@cantrip/protocol/attachment-content";
import { getActiveServerUrl } from "@/lib/server-connections";

export async function uploadChatAttachment(
  chatId: string,
  file: File,
  kind: ChatAttachmentKind,
  source: ChatAttachmentSource,
) {
  const attachmentId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const previewText =
      kind === "text"
        ? new TextDecoder("utf-8", { fatal: false })
            .decode(bytes.subarray(0, 16_000))
            .slice(0, 8_000)
        : null;
    const upload = await protectAttachmentUpload({
      attachmentId,
      operationId,
      chatId,
      bytes,
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      kind,
      source,
      previewText,
    });
    const response = await requestResponse(
      `/api/chats/${encodeURIComponent(chatId)}/attachments`,
      {
        method: "POST",
        body: JSON.stringify(attachmentUploadOpaqueSchema.parse(upload)),
        credentials: "include",
        headers: {
          accept: "application/json",
          "content-type": "application/octet-stream",
        },
      },
    );
    return openAttachmentOpaqueSummary(
      chatAttachmentOpaqueSummarySchema.parse(await response.json()),
    );
  } finally {
    bytes.fill(0);
  }
}

export async function deleteChatAttachment(attachmentId: string) {
  await request(`/api/attachments/${encodeURIComponent(attachmentId)}`, {
    method: "DELETE",
  });
}

export function chatAttachmentContentUrl(attachmentId: string): string {
  return `${getActiveServerUrl()}/api/attachments/${encodeURIComponent(attachmentId)}/content`;
}

export async function loadChatAttachmentContent(
  attachment: ChatAttachmentSummary,
): Promise<Blob> {
  const operationId = crypto.randomUUID();
  const download = attachmentDownloadOpaqueSchema.parse(
    await request(
      `/api/attachments/${encodeURIComponent(attachment.id)}/content?operationId=${encodeURIComponent(operationId)}`,
    ),
  );
  const bytes = await openAttachmentDownload(attachment, download);
  try {
    return new Blob([bytes.slice().buffer as ArrayBuffer], {
      type: attachment.mimeType,
    });
  } finally {
    bytes.fill(0);
  }
}
