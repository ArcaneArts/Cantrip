import { createHash } from "node:crypto";
import path from "node:path";

export function codexAccountHome(
  dataDirectory: string,
  credentialHomeKey: string,
): string {
  const directoryName = createHash("sha256")
    .update(credentialHomeKey)
    .digest("hex");
  return path.join(dataDirectory, "codex-accounts", directoryName);
}
