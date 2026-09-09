import {
  clearSensitiveBytes,
  decryptNativeSettingsSnapshot,
} from "@cantrip/crypto";
import {
  nativeSettingsStateSchema,
  type NativeThreadSettings,
} from "@cantrip/protocol";
import {
  clientEncryption,
  ClientEncryptionError,
  type ClientEncryptionService,
} from "./client-encryption";
import {
  getClientSessionIdentitySnapshot,
  clientSessionIdentityMatches,
  type ClientSessionIdentitySnapshot,
} from "./client-session";

type TrustedOptions = {
  service?: ClientEncryptionService;
  identity?: () => ClientSessionIdentitySnapshot | null;
  identityMatches?: (expected: ClientSessionIdentitySnapshot) => boolean;
};

/** Open the last confirmed selection. The caller must separately decide whether
 * this binding still describes the active placement; it is never a desired value. */
export async function openNativeSettingsState(input: {
  chatId: string;
  state: unknown;
  options?: TrustedOptions;
}): Promise<NativeThreadSettings | null> {
  const state = nativeSettingsStateSchema.parse(input.state);
  if (state.chatId !== input.chatId)
    throw new Error("Native settings belong to another chat.");
  if (!state.effective) return null;
  const { binding, effective } = state;
  if (
    !binding ||
    binding.chatId !== input.chatId ||
    effective.context.settingsVersion.epoch !== binding.nativeEpoch
  )
    throw new Error("Native settings do not match their observation binding.");

  const service = input.options?.service ?? clientEncryption;
  const identity = (
    input.options?.identity ?? getClientSessionIdentitySnapshot
  )();
  const identityMatches =
    input.options?.identityMatches ?? clientSessionIdentityMatches;
  const unlocked = service.getSnapshot();
  if (
    !identity ||
    unlocked.status !== "ready" ||
    unlocked.identity?.ownerId !== identity.userId ||
    unlocked.identity.serverId !== identity.serverId ||
    !identityMatches(identity)
  )
    throw new ClientEncryptionError(
      "locked",
      "Encryption must be unlocked for this account.",
    );

  // Old confirmed selections remain readable after key rotation. The component
  // service supplies an owned copy of the requested revision, never a cached key.
  const keyRevision = effective.protectedContent.keyRevision;
  const componentKey = service.componentKey({
    component: "chat-content",
    identity: unlocked.identity,
    keyRevision,
  });
  try {
    const settings = await decryptNativeSettingsSnapshot({
      ownerId: identity.userId,
      serverId: identity.serverId,
      componentKey,
      keyRevision,
      context: {
        chatId: input.chatId,
        workerId: binding.workerId,
        threadId: binding.threadId,
        runtimeGeneration: binding.runtimeGeneration,
        settingsVersion: {
          epoch: binding.nativeEpoch,
          revision: effective.context.settingsVersion.revision,
        },
      },
      snapshot: effective,
    });
    // A lock, unlock or account switch during WebCrypto must not repopulate
    // settings in the newly selected identity's view.
    if (!identityMatches(identity) || service.getSnapshot() !== unlocked)
      throw new ClientEncryptionError(
        "locked",
        "The encryption session changed while reading settings.",
      );
    return settings;
  } finally {
    clearSensitiveBytes(componentKey);
  }
}
