import {
  CantripDecryptionError,
  clearSensitiveBytes,
  decryptEndpointContentPayload,
  encryptEndpointContentPayload,
} from "@cantrip/crypto";
import {
  endpointContentContextSchema,
  endpointContentOpaqueSchema,
  type EndpointContentContext,
  type EndpointContentOpaque,
} from "@cantrip/protocol/endpoint-content";

import type { ClientSessionContext } from "./client-session";
import { getClientSession } from "./client-session";
import type { ClientEncryptionService } from "./client-encryption";
import { ClientEncryptionError, clientEncryption } from "./client-encryption";

type TrustedOptions = {
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
};

type ContentSchema<T> = { parse(value: unknown): T };
export type ClientEndpointContentContext = Omit<
  EndpointContentContext,
  "serverId"
>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function encryptionContext(
  context: ClientEndpointContentContext,
  options: TrustedOptions,
) {
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
  const completeContext = endpointContentContextSchema.parse({
    ...context,
    serverId: session.serverId,
  });
  return {
    componentKey: service.componentKey({
      component: completeContext.domain,
      identity: snapshot.identity,
      keyRevision: snapshot.masterKeyRevision,
    }),
    context: completeContext,
    keyRevision: snapshot.masterKeyRevision,
    ownerId: session.user.id,
  };
}

export async function protectEndpointContent<T>(input: {
  context: ClientEndpointContentContext;
  content: T;
  schema: ContentSchema<T>;
  options?: TrustedOptions;
}): Promise<EndpointContentOpaque> {
  const encryption = encryptionContext(input.context, input.options ?? {});
  const plaintext = encoder.encode(
    JSON.stringify(input.schema.parse(input.content)),
  );
  try {
    return await encryptEndpointContentPayload({
      ownerId: encryption.ownerId,
      context: encryption.context,
      keyRevision: encryption.keyRevision,
      componentKey: encryption.componentKey,
      plaintext,
    });
  } finally {
    clearSensitiveBytes(plaintext);
    clearSensitiveBytes(encryption.componentKey);
  }
}

/** Borrows plaintext until completion; the caller is responsible for clearing it. */
export async function protectEndpointBytes(input: {
  context: ClientEndpointContentContext;
  plaintext: Uint8Array;
  options?: TrustedOptions;
}): Promise<EndpointContentOpaque> {
  const encryption = encryptionContext(input.context, input.options ?? {});
  try {
    return await encryptEndpointContentPayload({
      ownerId: encryption.ownerId,
      context: encryption.context,
      keyRevision: encryption.keyRevision,
      componentKey: encryption.componentKey,
      plaintext: input.plaintext,
    });
  } finally {
    clearSensitiveBytes(encryption.componentKey);
  }
}

/** Returns an owned plaintext buffer; its caller must clear it after use. */
export async function openEndpointBytes(input: {
  context: ClientEndpointContentContext;
  opaque: unknown;
  options?: TrustedOptions;
}): Promise<Uint8Array> {
  const opaque = endpointContentOpaqueSchema.parse(input.opaque);
  const encryption = encryptionContext(input.context, input.options ?? {});
  try {
    if (opaque.keyRevision !== encryption.keyRevision)
      throw new CantripDecryptionError();
    return await decryptEndpointContentPayload({
      ownerId: encryption.ownerId,
      context: encryption.context,
      keyRevision: encryption.keyRevision,
      componentKey: encryption.componentKey,
      opaque,
    });
  } catch {
    throw new ClientEncryptionError(
      "decryption-failed",
      "Protected endpoint content could not be authenticated.",
    );
  } finally {
    clearSensitiveBytes(encryption.componentKey);
  }
}

export async function openEndpointContent<T>(input: {
  context: ClientEndpointContentContext;
  opaque: unknown;
  schema: ContentSchema<T>;
  options?: TrustedOptions;
}): Promise<T> {
  const opaque = endpointContentOpaqueSchema.parse(input.opaque);
  const encryption = encryptionContext(input.context, input.options ?? {});
  let plaintext: Uint8Array | null = null;
  try {
    if (opaque.keyRevision !== encryption.keyRevision) {
      throw new CantripDecryptionError();
    }
    plaintext = await decryptEndpointContentPayload({
      ownerId: encryption.ownerId,
      context: encryption.context,
      keyRevision: encryption.keyRevision,
      componentKey: encryption.componentKey,
      opaque,
    });
    return input.schema.parse(JSON.parse(decoder.decode(plaintext)));
  } catch {
    throw new ClientEncryptionError(
      "decryption-failed",
      "Protected endpoint content could not be authenticated.",
    );
  } finally {
    if (plaintext) clearSensitiveBytes(plaintext);
    clearSensitiveBytes(encryption.componentKey);
  }
}
