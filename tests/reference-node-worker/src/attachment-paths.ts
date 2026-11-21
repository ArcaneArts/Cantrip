import path from "node:path";
export const MAX_ATTACHMENT_BYTES = 25 * 1_024 * 1_024;
export const MAX_ATTACHMENT_CHUNK_BYTES = 256 * 1_024;

export function safeAttachmentFileName(value: string): string {
  const base = path.basename(value.replaceAll("\\", "/")).normalize("NFKC");
  const sanitized = base
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/[^\p{L}\p{N}._()\[\] -]/gu, "_")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^\.+/u, "")
    .slice(0, 180);
  return sanitized || "attachment";
}
