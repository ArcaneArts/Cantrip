import type { WorkerChatAttachment } from "@cantrip/protocol";

export interface LocalRuntimeAttachment extends WorkerChatAttachment {
  path: string;
}

export function attachmentPromptText(
  prompt: string,
  attachments: readonly LocalRuntimeAttachment[],
  imageInputSupported: boolean,
): string {
  if (!attachments.length) return prompt;
  const references = attachments.map(
    (attachment) =>
      `- ${attachment.fileName} (${attachment.mimeType}, ${attachment.sizeBytes} bytes): ${attachment.path}`,
  );
  const hasUnsupportedImages =
    !imageInputSupported &&
    attachments.some((attachment) => attachment.kind === "image");
  return `${prompt}\n\nAttachments are stored outside the repository on this worker. Read them from these paths as needed:\n${references.join("\n")}${
    hasUnsupportedImages
      ? "\n\nThe selected model is text-only. Image files were not sent as model image input; inspect their worker paths with local tools if needed."
      : ""
  }`;
}
