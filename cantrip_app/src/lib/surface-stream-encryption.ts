import {
  CantripDecryptionError,
  clearSensitiveBytes,
  decryptSurfaceStreamPayload,
  encryptSurfaceStreamPayload,
} from "@cantrip/crypto";
import {
  surfaceStreamOpaqueSchema,
  type SurfaceStreamContext,
  type SurfaceStreamOpaque,
} from "@cantrip/protocol/surface-stream";

import type { ClientSessionContext } from "./client-session";
import { getClientSession } from "./client-session";
import type { ClientEncryptionService } from "./client-encryption";
import { ClientEncryptionError, clientEncryption } from "./client-encryption";

type TrustedOptions = {
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type ContentSchema<T> = { parse(value: unknown): T };

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

export async function protectSurfaceStreamContent<T>(input: {
  context: Omit<SurfaceStreamContext, "serverId">;
  content: T;
  schema: ContentSchema<T>;
  options?: TrustedOptions;
}): Promise<SurfaceStreamOpaque> {
  const encryption = encryptionContext(input.options ?? {});
  const plaintext = encoder.encode(
    JSON.stringify(input.schema.parse(input.content)),
  );
  try {
    return await encryptSurfaceStreamPayload({
      ownerId: encryption.ownerId,
      context: { ...input.context, serverId: encryption.serverId },
      keyRevision: encryption.keyRevision,
      componentKey: encryption.componentKey,
      plaintext,
    });
  } finally {
    clearSensitiveBytes(plaintext);
    clearSensitiveBytes(encryption.componentKey);
  }
}

export async function openSurfaceStreamContent<T>(input: {
  context: Omit<SurfaceStreamContext, "serverId">;
  opaque: unknown;
  schema: ContentSchema<T>;
  options?: TrustedOptions;
}): Promise<T> {
  const opaque = surfaceStreamOpaqueSchema.parse(input.opaque);
  const encryption = encryptionContext(input.options ?? {});
  let plaintext: Uint8Array | null = null;
  try {
    if (opaque.keyRevision !== encryption.keyRevision) {
      throw new CantripDecryptionError();
    }
    plaintext = await decryptSurfaceStreamPayload({
      ownerId: encryption.ownerId,
      context: { ...input.context, serverId: encryption.serverId },
      keyRevision: encryption.keyRevision,
      componentKey: encryption.componentKey,
      opaque,
    });
    return input.schema.parse(JSON.parse(decoder.decode(plaintext)));
  } catch {
    throw new ClientEncryptionError(
      "decryption-failed",
      "Protected surface content could not be authenticated.",
    );
  } finally {
    if (plaintext) clearSensitiveBytes(plaintext);
    clearSensitiveBytes(encryption.componentKey);
  }
}
