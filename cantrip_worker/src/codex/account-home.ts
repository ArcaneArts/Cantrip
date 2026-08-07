import { createHash } from "node:crypto";
import path from "node:path";

export function codexAccountHome(
  dataDirectory: string,
  providerId: string,
): string {
  const directoryName = createHash("sha256").update(providerId).digest("hex");
  return path.join(dataDirectory, "codex-accounts", directoryName);
}
