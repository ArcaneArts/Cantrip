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
  WorkerEncryptionError,
  type WorkerEncryptionService,
} from "./worker-encryption.js";

export class PrivateDisplayLabelWorkerError extends Error {
  constructor(
    readonly state: Exclude<PrivateDisplayLabelAvailability, "ready">,
    message: string,
  ) {
    super(message);
    this.name = "PrivateDisplayLabelWorkerError";
  }
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
    throw new PrivateDisplayLabelWorkerError(
      "unsupported",
      "The private display-label format is not supported.",
    );
  }
  throw new PrivateDisplayLabelWorkerError(
    value === null || value === undefined ? "missing" : "corrupt",
    "The private display-label envelope is missing or corrupt.",
  );
}

function componentKey(input: {
  keyRevision?: number;
  ownerId: string;
  service: WorkerEncryptionService;
}): { key: Uint8Array; keyRevision: number } {
  const status = input.service.status();
  if (status.error?.toLowerCase().includes("revok")) {
    throw new PrivateDisplayLabelWorkerError(
      "revoked",
      "The worker's private display-label grant was revoked.",
    );
  }
  try {
    if (input.service.ownerId() !== input.ownerId) {
      throw new PrivateDisplayLabelWorkerError(
        "locked",
        "The worker encryption key belongs to another account.",
      );
    }
    const material = input.service.componentKey("private-surface-metadata");
    if (
      input.keyRevision !== undefined &&
      input.keyRevision !== material.keyRevision
    ) {
      clearSensitiveBytes(material.key);
      throw new PrivateDisplayLabelWorkerError(
        "stale",
        "The private display label uses another worker key revision.",
      );
    }
    return material;
  } catch (error) {
    if (error instanceof PrivateDisplayLabelWorkerError) throw error;
    if (error instanceof WorkerEncryptionError) {
      throw new PrivateDisplayLabelWorkerError(
        "missing",
        "The worker does not have an active private display-label grant.",
      );
    }
    throw error;
  }
}

export async function encodePrivateDisplayLabelForWorker(input: {
  label: string;
  ownerId: string;
  recordKind: PrivateDisplayLabelRecordKind;
  rowId: string;
  service: WorkerEncryptionService;
}): Promise<PrivateDisplayLabelOpaque> {
  const material = componentKey(input);
  try {
    return await encryptPrivateDisplayLabel({
      ownerId: input.ownerId,
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

export async function decodePrivateDisplayLabelForWorker(input: {
  opaque: unknown;
  ownerId: string;
  recordKind: PrivateDisplayLabelRecordKind;
  rowId: string;
  service: WorkerEncryptionService;
}): Promise<string> {
  const opaque = parseOpaque(input.opaque);
  const material = componentKey({
    ...input,
    keyRevision: opaque.protectedLabel.keyRevision,
  });
  try {
    return await decryptPrivateDisplayLabel({
      ownerId: input.ownerId,
      recordKind: input.recordKind,
      rowId: input.rowId,
      keyRevision: material.keyRevision,
      componentKey: material.key,
      opaque,
    });
  } catch (error) {
    if (error instanceof PrivateDisplayLabelWorkerError) throw error;
    if (error instanceof CantripDecryptionError) {
      throw new PrivateDisplayLabelWorkerError(
        "corrupt",
        "The private display label could not be authenticated.",
      );
    }
    throw error;
  } finally {
    clearSensitiveBytes(material.key);
  }
}
