import {
  anonymousRecoveryArtifactSchema,
  type AnonymousRecoveryArtifact,
} from "@cantrip/protocol/encryption";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

import {
  ClientEncryptionError,
  clientEncryption,
  type ClientEncryptionIdentity,
  type ClientEncryptionService,
} from "./client-encryption";

const maximumRecoveryArtifactBytes = 64 * 1_024;

export async function createAnonymousRecoveryArtifactText(input: {
  identity: ClientEncryptionIdentity;
  service?: ClientEncryptionService;
}): Promise<string> {
  const artifact = await (
    input.service ?? clientEncryption
  ).createAnonymousRecoveryArtifact(input.identity);
  return serializeAnonymousRecoveryArtifact(artifact);
}

export function serializeAnonymousRecoveryArtifact(
  artifact: AnonymousRecoveryArtifact,
): string {
  return `${JSON.stringify(anonymousRecoveryArtifactSchema.parse(artifact), null, 2)}\n`;
}

export function parseAnonymousRecoveryArtifactText(text: string) {
  if (
    new TextEncoder().encode(text).byteLength > maximumRecoveryArtifactBytes
  ) {
    throw new ClientEncryptionError(
      "recovery-artifact-invalid",
      "The anonymous recovery file is too large.",
    );
  }
  try {
    return anonymousRecoveryArtifactSchema.parse(JSON.parse(text));
  } catch (error) {
    if (error instanceof ClientEncryptionError) throw error;
    throw new ClientEncryptionError(
      "recovery-artifact-invalid",
      "The anonymous recovery file is invalid or unsupported.",
    );
  }
}

export function anonymousRecoveryArtifactFileName(now = new Date()): string {
  return `cantrip-anonymous-recovery-${now.toISOString().slice(0, 10)}.cantrip-recovery.json`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

export async function saveAnonymousRecoveryArtifact(
  text: string,
): Promise<void> {
  const fileName = anonymousRecoveryArtifactFileName();
  if (
    Capacitor.isNativePlatform() &&
    typeof window !== "undefined" &&
    !("__TAURI_INTERNALS__" in window)
  ) {
    const path = `cantrip-recovery/${fileName}`;
    try {
      await Filesystem.writeFile({
        data: bytesToBase64(new TextEncoder().encode(text)),
        directory: Directory.Cache,
        path,
        recursive: true,
      });
      const { uri } = await Filesystem.getUri({
        directory: Directory.Cache,
        path,
      });
      await Share.share({
        dialogTitle: "Save Cantrip recovery file",
        files: [uri],
        title: "Cantrip anonymous recovery",
      });
    } finally {
      await Filesystem.deleteFile({ directory: Directory.Cache, path }).catch(
        () => undefined,
      );
    }
    return;
  }
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.download = fileName;
  anchor.href = url;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
}
