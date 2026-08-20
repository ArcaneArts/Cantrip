import {
  CantripDecryptionError,
  clearSensitiveBytes,
  decryptPrivateDisplayLabel,
  encryptPrivateDisplayLabel,
} from "@cantrip/crypto";
import {
  privateDisplayLabelOpaqueSchema,
  type PrivateDisplayLabelAvailability,
  type PrivateDisplayLabelOpaque,
  type PrivateDisplayLabelRecordKind,
} from "@cantrip/protocol/private-labels";

import {
  clientEncryption,
  type ClientEncryptionIdentity,
  type ClientEncryptionService,
  type ClientEncryptionStatus,
} from "./client-encryption";

export class PrivateDisplayLabelClientError extends Error {
  constructor(
    readonly state: Exclude<PrivateDisplayLabelAvailability, "ready">,
    message: string,
  ) {
    super(message);
    this.name = "PrivateDisplayLabelClientError";
  }
}

function unavailableState(
  status: Exclude<ClientEncryptionStatus, "ready">,
): Exclude<PrivateDisplayLabelAvailability, "ready"> {
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
    throw new PrivateDisplayLabelClientError(
      unavailableState(snapshot.status),
      "Private display-label encryption is unavailable for this account.",
    );
  }
  if (!sameIdentity(snapshot.identity, input.identity)) {
    throw new PrivateDisplayLabelClientError(
      "locked",
      "Encryption is locked for this server and account.",
    );
  }
  if (!snapshot.masterKeyRevision) {
    throw new PrivateDisplayLabelClientError(
      "missing",
      "The account encryption key revision is unavailable.",
    );
  }
  if (
    input.keyRevision !== undefined &&
    input.keyRevision !== snapshot.masterKeyRevision
  ) {
    throw new PrivateDisplayLabelClientError(
      "stale",
      "The private display label uses another account key revision.",
    );
  }
  return {
    keyRevision: snapshot.masterKeyRevision,
    key: input.service.componentKey({
      component: "private-surface-metadata",
      identity: input.identity,
      keyRevision: snapshot.masterKeyRevision,
    }),
  };
}

function parseOpaque(value: unknown): PrivateDisplayLabelOpaque {
  const parsed = privateDisplayLabelOpaqueSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const candidate = value as {
    protectedLabel?: {
      formatVersion?: unknown;
      envelope?: { version?: unknown };
    };
  } | null;
  if (
    candidate?.protectedLabel?.formatVersion !== undefined &&
    (candidate.protectedLabel.formatVersion !== 1 ||
      candidate.protectedLabel.envelope?.version !== 1)
  ) {
    throw new PrivateDisplayLabelClientError(
      "unsupported",
      "The private display-label format is not supported.",
    );
  }
  throw new PrivateDisplayLabelClientError(
    value === null || value === undefined ? "missing" : "corrupt",
    "The private display-label envelope is missing or corrupt.",
  );
}

export async function encodePrivateDisplayLabelForClient(input: {
  identity: ClientEncryptionIdentity;
  label: string;
  recordKind: PrivateDisplayLabelRecordKind;
  rowId: string;
  service?: ClientEncryptionService;
}): Promise<PrivateDisplayLabelOpaque> {
  const material = componentKey({
    identity: input.identity,
    service: input.service ?? clientEncryption,
  });
  try {
    return await encryptPrivateDisplayLabel({
      ownerId: input.identity.ownerId,
      recordKind: input.recordKind,
      rowId: input.rowId,
      keyRevision: material.keyRevision,
      componentKey: material.key,
      label: input.label,
    });
  } finally {
    clearSensitiveBytes(material.key);
  }
}

export async function decodePrivateDisplayLabelForClient(input: {
  identity: ClientEncryptionIdentity;
  opaque: unknown;
  recordKind: PrivateDisplayLabelRecordKind;
  rowId: string;
  service?: ClientEncryptionService;
}): Promise<string> {
  const opaque = parseOpaque(input.opaque);
  const material = componentKey({
    identity: input.identity,
    keyRevision: opaque.protectedLabel.keyRevision,
    service: input.service ?? clientEncryption,
  });
  try {
    return await decryptPrivateDisplayLabel({
      ownerId: input.identity.ownerId,
      recordKind: input.recordKind,
      rowId: input.rowId,
      keyRevision: material.keyRevision,
      componentKey: material.key,
      opaque,
    });
  } catch (error) {
    if (error instanceof PrivateDisplayLabelClientError) throw error;
    if (error instanceof CantripDecryptionError) {
      throw new PrivateDisplayLabelClientError(
        "corrupt",
        "The private display label could not be authenticated.",
      );
    }
    throw error;
  } finally {
    clearSensitiveBytes(material.key);
  }
}
