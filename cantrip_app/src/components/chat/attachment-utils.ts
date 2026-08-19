export const LARGE_PASTE_THRESHOLD = 4_000;
export const MAX_COMPOSER_ATTACHMENTS = 20;
export const MAX_ATTACHMENT_BYTES = 25 * 1_024 * 1_024;

export type ComposerAttachmentKind = "audio" | "file" | "image" | "text";

const TEXT_EXTENSIONS = new Set([
  "c",
  "cc",
  "conf",
  "cpp",
  "css",
  "csv",
  "dart",
  "env",
  "go",
  "h",
  "hpp",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "kts",
  "log",
  "md",
  "mjs",
  "properties",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "svg",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

export function attachmentKind(
  fileName: string,
  mimeType: string,
): ComposerAttachmentKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("text/")) return "text";
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(extension) ? "text" : "file";
}

export function largePasteFileName(now = new Date()): string {
  return `pasted-text-${now
    .toISOString()
    .replace(/[:.]/gu, "-")
    .replace("T", "-")
    .replace("Z", "")}.txt`;
}

export function shouldAttachPastedText(text: string): boolean {
  return text.length > LARGE_PASTE_THRESHOLD;
}

export function pastedTextAttachmentLabel(
  previewText: string | null,
  fallback: string,
): string {
  const firstContentLine = previewText
    ?.split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  return firstContentLine?.slice(0, 200) || fallback;
}

export function insertComposerText(
  current: string,
  inserted: string,
  start: number,
  end = start,
): { caret: number; text: string } {
  const before = current.slice(0, start);
  const after = current.slice(end);
  const prefix = before && !before.endsWith("\n") ? "\n" : "";
  const suffix = after && !after.startsWith("\n") ? "\n" : "";
  const text = `${before}${prefix}${inserted}${suffix}${after}`;
  return { caret: before.length + prefix.length + inserted.length, text };
}

export function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}
