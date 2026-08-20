import {
  CantripDecryptionError,
  clearSensitiveBytes,
  decryptSurfacePrivateState,
  encryptSurfacePrivateState,
} from "@cantrip/crypto";
import {
  surfacePrivateStateOpaqueSchema,
  type SurfacePrivateStateAvailability,
  type SurfacePrivateStateContext,
  type SurfacePrivateStateOpaque,
  type SurfacePrivateStateProtectedContent,
} from "@cantrip/protocol/surface-private-state";

import {
  clientEncryption,
  type ClientEncryptionIdentity,
  type ClientEncryptionService,
  type ClientEncryptionStatus,
} from "./client-encryption";

export class SurfacePrivateStateClientError extends Error {
  constructor(
    readonly state: Exclude<SurfacePrivateStateAvailability, "ready">,
    message: string,
  ) {
    super(message);
    this.name = "SurfacePrivateStateClientError";
  }
}

function unavailableState(
  status: Exclude<ClientEncryptionStatus, "ready">,
): Exclude<SurfacePrivateStateAvailability, "ready"> {
  switch (status) {
    case "corrupt":
      return "corrupt";
    case "revoked":
      return "revoked";
    case "unsupported-version":
      return "unsupported";
    case "unavailable":
      return "missing";
    case "locked":
      return "locked";
  }
}

function sameIdentity(
  left: ClientEncryptionIdentity | null,
  right: ClientEncryptionIdentity,
): boolean {
  return left?.ownerId === right.ownerId && left.serverId === right.serverId;
}

function componentKey(input: {
  identity: ClientEncryptionIdentity;
  keyRevision?: number;
  service: ClientEncryptionService;
}): { key: Uint8Array; keyRevision: number } {
  const snapshot = input.service.getSnapshot();
  if (snapshot.status !== "ready") {
    throw new SurfacePrivateStateClientError(
      unavailableState(snapshot.status),
      "Surface private-state encryption is unavailable for this account.",
    );
  }
  if (!sameIdentity(snapshot.identity, input.identity)) {
    throw new SurfacePrivateStateClientError(
      "wrong-recipient",
      "Encryption is unlocked for another server or account.",
    );
  }
  if (!snapshot.masterKeyRevision) {
    throw new SurfacePrivateStateClientError(
      "missing",
      "The account encryption key revision is unavailable.",
    );
  }
  if (
    input.keyRevision !== undefined &&
    input.keyRevision !== snapshot.masterKeyRevision
  ) {
    throw new SurfacePrivateStateClientError(
      "stale",
      "The protected surface state uses another account key revision.",
    );
  }
  return {
    keyRevision: snapshot.masterKeyRevision,
    key: input.service.componentKey({
      component: "surface-private-state",
      identity: input.identity,
      keyRevision: snapshot.masterKeyRevision,
    }),
  };
}

function parseOpaque(value: unknown): SurfacePrivateStateOpaque {
  const parsed = surfacePrivateStateOpaqueSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const candidate = value as {
    protectedState?: {
      formatVersion?: unknown;
      envelope?: { version?: unknown };
    };
  } | null;
  if (
    candidate?.protectedState?.formatVersion !== undefined &&
    (candidate.protectedState.formatVersion !== 1 ||
      candidate.protectedState.envelope?.version !== 1)
  ) {
    throw new SurfacePrivateStateClientError(
      "unsupported",
      "The protected surface-state format is not supported.",
    );
  }
  throw new SurfacePrivateStateClientError(
    value === null || value === undefined ? "missing" : "corrupt",
    "The protected surface-state envelope is missing or corrupt.",
  );
}

export async function encodeSurfacePrivateStateForClient(input: {
  identity: ClientEncryptionIdentity;
  context: SurfacePrivateStateContext;
  content: SurfacePrivateStateProtectedContent;
  service?: ClientEncryptionService;
}): Promise<SurfacePrivateStateOpaque> {
  if (input.context.serverId !== input.identity.serverId) {
    throw new SurfacePrivateStateClientError(
      "wrong-recipient",
      "The surface state targets another server.",
    );
  }
  const material = componentKey({
    identity: input.identity,
    service: input.service ?? clientEncryption,
  });
  try {
    return await encryptSurfacePrivateState({
      ownerId: input.identity.ownerId,
      context: input.context,
      keyRevision: material.keyRevision,
      componentKey: material.key,
      content: input.content,
    });
  } finally {
    clearSensitiveBytes(material.key);
  }
}

export async function decodeSurfacePrivateStateForClient(input: {
  identity: ClientEncryptionIdentity;
  context: SurfacePrivateStateContext;
  opaque: unknown;
  service?: ClientEncryptionService;
}): Promise<SurfacePrivateStateProtectedContent> {
  if (input.context.serverId !== input.identity.serverId) {
    throw new SurfacePrivateStateClientError(
      "wrong-recipient",
      "The surface state belongs to another server.",
    );
  }
  const opaque = parseOpaque(input.opaque);
  const material = componentKey({
    identity: input.identity,
    keyRevision: opaque.protectedState.keyRevision,
    service: input.service ?? clientEncryption,
  });
  try {
    return await decryptSurfacePrivateState({
      ownerId: input.identity.ownerId,
      context: input.context,
      keyRevision: material.keyRevision,
      componentKey: material.key,
      opaque,
    });
  } catch (error) {
    if (error instanceof SurfacePrivateStateClientError) throw error;
    if (error instanceof CantripDecryptionError) {
      throw new SurfacePrivateStateClientError(
        "corrupt",
        "The protected surface state could not be authenticated.",
      );
    }
    throw error;
  } finally {
    clearSensitiveBytes(material.key);
  }
}
