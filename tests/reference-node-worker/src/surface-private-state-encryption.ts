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
  WorkerEncryptionError,
  type WorkerEncryptionService,
} from "./worker-encryption.js";

export class SurfacePrivateStateWorkerError extends Error {
  constructor(
    readonly state: Exclude<SurfacePrivateStateAvailability, "ready">,
    message: string,
  ) {
    super(message);
    this.name = "SurfacePrivateStateWorkerError";
  }
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
    throw new SurfacePrivateStateWorkerError(
      "unsupported",
      "The protected surface-state format is not supported.",
    );
  }
  throw new SurfacePrivateStateWorkerError(
    value === null || value === undefined ? "missing" : "corrupt",
    "The protected surface-state envelope is missing or corrupt.",
  );
}

function componentKey(input: {
  keyRevision?: number;
  ownerId: string;
  service: WorkerEncryptionService;
}): { key: Uint8Array; keyRevision: number } {
  const status = input.service.status();
  if (status.error?.toLowerCase().includes("revok")) {
    throw new SurfacePrivateStateWorkerError(
      "revoked",
      "The worker's surface private-state grant was revoked.",
    );
  }
  try {
    if (input.service.ownerId() !== input.ownerId) {
      throw new SurfacePrivateStateWorkerError(
        "wrong-recipient",
        "The worker encryption key belongs to another account.",
      );
    }
    const material = input.service.componentKey("surface-private-state");
    if (
      input.keyRevision !== undefined &&
      input.keyRevision !== material.keyRevision
    ) {
      clearSensitiveBytes(material.key);
      throw new SurfacePrivateStateWorkerError(
        "stale",
        "The protected surface state uses another worker key revision.",
      );
    }
    return material;
  } catch (error) {
    if (error instanceof SurfacePrivateStateWorkerError) throw error;
    if (error instanceof WorkerEncryptionError) {
      throw new SurfacePrivateStateWorkerError(
        "missing-grant",
        "The worker does not have an active surface private-state grant.",
      );
    }
    throw error;
  }
}

export async function encodeSurfacePrivateStateForWorker(input: {
  ownerId: string;
  context: SurfacePrivateStateContext;
  content: SurfacePrivateStateProtectedContent;
  service: WorkerEncryptionService;
}): Promise<SurfacePrivateStateOpaque> {
  const material = componentKey(input);
  try {
    return await encryptSurfacePrivateState({
      ownerId: input.ownerId,
      context: input.context,
      keyRevision: material.keyRevision,
      componentKey: material.key,
      content: input.content,
    });
  } finally {
    clearSensitiveBytes(material.key);
  }
}

export async function decodeSurfacePrivateStateForWorker(input: {
  ownerId: string;
  context: SurfacePrivateStateContext;
  opaque: unknown;
  service: WorkerEncryptionService;
}): Promise<SurfacePrivateStateProtectedContent> {
  const opaque = parseOpaque(input.opaque);
  const material = componentKey({
    ...input,
    keyRevision: opaque.protectedState.keyRevision,
  });
  try {
    return await decryptSurfacePrivateState({
      ownerId: input.ownerId,
      context: input.context,
      keyRevision: material.keyRevision,
      componentKey: material.key,
      opaque,
    });
  } catch (error) {
    if (error instanceof SurfacePrivateStateWorkerError) throw error;
    if (error instanceof CantripDecryptionError) {
      throw new SurfacePrivateStateWorkerError(
        "corrupt",
        "The protected surface state could not be authenticated.",
      );
    }
    throw error;
  } finally {
    clearSensitiveBytes(material.key);
  }
}
