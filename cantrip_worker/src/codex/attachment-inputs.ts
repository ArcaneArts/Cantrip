import type { ChatAttachmentSummary } from "@cantrip/protocol";

export interface LocalRuntimeAttachment extends ChatAttachmentSummary {
  path: string;
}

export function attachmentPromptText(
  prompt: string,
  attachments: readonly LocalRuntimeAttachment[],
  imageInputSupported: boolean,
  location: "worker" | "Linux workspace" = "worker",
): string {
  if (!attachments.length) return prompt;
  const references = attachments.map(
    (attachment) =>
      `- ${attachment.fileName} (${attachment.mimeType}, ${attachment.sizeBytes} bytes): ${attachment.path}`,
  );
  const hasUnsupportedImages =
    !imageInputSupported &&
    attachments.some((attachment) => attachment.kind === "image");
  return `${prompt}\n\nAttachments are stored outside the repository ${location === "worker" ? "on this worker" : "in this Linux workspace"}. Read them from these paths as needed:\n${references.join("\n")}${
    hasUnsupportedImages
      ? "\n\nThe selected model is text-only. Image files were not sent as model image input; inspect their listed paths with the current environment tools if needed."
      : ""
  }`;
}
