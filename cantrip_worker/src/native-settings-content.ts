import {
  clearSensitiveBytes,
  encryptNativeSettingsSnapshot,
  decryptNativeSettingsSnapshot,
} from "@cantrip/crypto";
import type {
  NativeSettingsSnapshotContext,
  ProtectedNativeSettingsSnapshot,
} from "@cantrip/protocol";
import type { WorkerEncryptionService } from "./worker-encryption.js";

type Service = Pick<
  WorkerEncryptionService,
  "componentKey" | "ownerId" | "serverIdentity"
>;

export async function protectNativeSettingsSnapshot(input: {
  service: Service;
  context: NativeSettingsSnapshotContext;
  settings: unknown;
}): Promise<ProtectedNativeSettingsSnapshot> {
  const component = input.service.componentKey("chat-content");
  try {
    return await encryptNativeSettingsSnapshot({
      ownerId: input.service.ownerId(),
      serverId: input.service.serverIdentity(),
      componentKey: component.key,
      keyRevision: component.keyRevision,
      context: input.context,
      settings: input.settings,
    });
  } finally {
    clearSensitiveBytes(component.key);
  }
}

export async function openNativeSettingsSnapshot(input: {
  service: Service;
  context: NativeSettingsSnapshotContext;
  snapshot: ProtectedNativeSettingsSnapshot;
}) {
  const component = input.service.componentKey(
    "chat-content",
    input.snapshot.protectedContent.keyRevision,
  );
  try {
    return await decryptNativeSettingsSnapshot({
      ownerId: input.service.ownerId(),
      serverId: input.service.serverIdentity(),
      componentKey: component.key,
      keyRevision: component.keyRevision,
      context: input.context,
      snapshot: input.snapshot,
    });
  } finally {
    clearSensitiveBytes(component.key);
  }
}
