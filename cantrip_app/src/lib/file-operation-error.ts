import { CantripApiError } from "@/lib/api-client";
/** An encrypted worker error; codes never depend on parsing display text. */
export class FileOperationError extends Error {
  constructor(
    message: string,
    readonly code?: "text-preview-required" | "file-version-changed",
  ) {
    super(message);
  }
}
export function requiresTextPreview(error: unknown): boolean {
  return (
    error instanceof FileOperationError &&
    error.code === "text-preview-required"
  );
}

export function retryFileRead(count: number, error: unknown): boolean {
  return (
    !requiresTextPreview(error) &&
    !(error instanceof CantripApiError && [429, 503].includes(error.status)) &&
    count < 3
  );
}
