import {
  CantripDecryptionError,
  clearSensitiveBytes,
  decryptRemoteSurfaceStreamPayload,
  encryptRemoteSurfaceStreamPayload,
} from "@cantrip/crypto";
import type { RemoteSurfaceStreamContext } from "@cantrip/protocol/remote-surface-stream";

import type { ClientSessionContext } from "./client-session";
import { getClientSession } from "./client-session";
import type { ClientEncryptionService } from "./client-encryption";
import { ClientEncryptionError, clientEncryption } from "./client-encryption";

type TrustedOptions = {
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
};

function encryptionContext(options: TrustedOptions) {
  const service = options.service ?? clientEncryption;
  const session = (options.session ?? getClientSession)();
  const snapshot = service.getSnapshot();
  if (
    !session ||
    snapshot.status !== "ready" ||
    !snapshot.masterKeyRevision ||
    snapshot.identity?.ownerId !== session.user.id ||
    snapshot.identity.serverId !== session.serverId
  ) {
    throw new ClientEncryptionError(
      "locked",
      "Encryption must be unlocked for this account.",
    );
  }
  return {
    componentKey: service.componentKey({
      component: "surface-private-state",
      identity: snapshot.identity,
      keyRevision: snapshot.masterKeyRevision,
    }),
    keyRevision: snapshot.masterKeyRevision,
    ownerId: session.user.id,
    serverId: session.serverId,
  };
}

export async function protectRemoteSurfaceStreamPayload(input: {
  context: Omit<RemoteSurfaceStreamContext, "serverId">;
  payload: Uint8Array;
  options?: TrustedOptions;
}): Promise<Uint8Array> {
  const encryption = encryptionContext(input.options ?? {});
  try {
    return await encryptRemoteSurfaceStreamPayload({
      ownerId: encryption.ownerId,
      context: { ...input.context, serverId: encryption.serverId },
      keyRevision: encryption.keyRevision,
      componentKey: encryption.componentKey,
      plaintext: input.payload,
    });
  } finally {
    clearSensitiveBytes(encryption.componentKey);
  }
}

export async function openRemoteSurfaceStreamPayload(input: {
  context: Omit<RemoteSurfaceStreamContext, "serverId">;
  protectedPayload: Uint8Array;
  options?: TrustedOptions;
}): Promise<Uint8Array> {
  const encryption = encryptionContext(input.options ?? {});
  try {
    return await decryptRemoteSurfaceStreamPayload({
      ownerId: encryption.ownerId,
      context: { ...input.context, serverId: encryption.serverId },
      keyRevision: encryption.keyRevision,
      componentKey: encryption.componentKey,
      protectedPayload: input.protectedPayload,
    });
  } catch (error) {
    if (error instanceof CantripDecryptionError) {
      throw new ClientEncryptionError(
        "decryption-failed",
        "Protected Remote Surface content could not be authenticated.",
      );
    }
    throw error;
  } finally {
    clearSensitiveBytes(encryption.componentKey);
  }
}
