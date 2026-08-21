import {
  CantripDecryptionError,
  clearSensitiveBytes,
  decryptRepositoryOperationPayload,
  encryptRepositoryOperationPayload,
} from "@cantrip/crypto";
import {
  repositoryOperationOpaqueSchema,
  type RepositoryOperationContext,
  type RepositoryOperationOpaque,
} from "@cantrip/protocol/repository-operation";

import type { ClientSessionContext } from "./client-session";
import { getClientSession } from "./client-session";
import type { ClientEncryptionService } from "./client-encryption";
import { ClientEncryptionError, clientEncryption } from "./client-encryption";

type TrustedOptions = {
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
};

type ContentSchema<T> = { parse(value: unknown): T };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

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
      component: "repository-content",
      identity: snapshot.identity,
      keyRevision: snapshot.masterKeyRevision,
    }),
    keyRevision: snapshot.masterKeyRevision,
    ownerId: session.user.id,
    serverId: session.serverId,
  };
}

export async function protectRepositoryOperationContent<T>(input: {
  context: Omit<RepositoryOperationContext, "serverId">;
  content: T;
  schema: ContentSchema<T>;
  options?: TrustedOptions;
}): Promise<RepositoryOperationOpaque> {
  const encryption = encryptionContext(input.options ?? {});
  const plaintext = encoder.encode(
    JSON.stringify(input.schema.parse(input.content)),
  );
  try {
    return await encryptRepositoryOperationPayload({
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

export async function openRepositoryOperationContent<T>(input: {
  context: Omit<RepositoryOperationContext, "serverId">;
  opaque: unknown;
  schema: ContentSchema<T>;
  options?: TrustedOptions;
}): Promise<T> {
  const opaque = repositoryOperationOpaqueSchema.parse(input.opaque);
  const encryption = encryptionContext(input.options ?? {});
  let plaintext: Uint8Array | null = null;
  try {
    if (opaque.keyRevision !== encryption.keyRevision) {
      throw new CantripDecryptionError();
    }
    plaintext = await decryptRepositoryOperationPayload({
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
      "Protected repository content could not be authenticated.",
    );
  } finally {
    if (plaintext) clearSensitiveBytes(plaintext);
    clearSensitiveBytes(encryption.componentKey);
  }
}
