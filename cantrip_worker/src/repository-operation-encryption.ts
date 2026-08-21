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

import {
  WorkerEncryptionError,
  type WorkerEncryptionService,
} from "./worker-encryption.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_REPLAY_RECORDS = 10_000;

export type RepositoryOperationContentSchema<T> = { parse(value: unknown): T };

function componentKey(input: {
  keyRevision?: number;
  service: WorkerEncryptionService;
}): { key: Uint8Array; keyRevision: number; ownerId: string } {
  try {
    const material = input.service.componentKey("repository-content");
    if (
      input.keyRevision !== undefined &&
      input.keyRevision !== material.keyRevision
    ) {
      clearSensitiveBytes(material.key);
      throw new Error("Protected repository content uses a stale key.");
    }
    return { ...material, ownerId: input.service.ownerId() };
  } catch (error) {
    if (error instanceof WorkerEncryptionError) {
      throw new Error("Repository content encryption is unavailable.");
    }
    throw error;
  }
}

export async function protectWorkerRepositoryOperationContent<T>(input: {
  context: RepositoryOperationContext;
  content: T;
  schema: RepositoryOperationContentSchema<T>;
  service: WorkerEncryptionService;
}): Promise<RepositoryOperationOpaque> {
  const material = componentKey({ service: input.service });
  const plaintext = encoder.encode(
    JSON.stringify(input.schema.parse(input.content)),
  );
  try {
    return await encryptRepositoryOperationPayload({
      ownerId: material.ownerId,
      context: input.context,
      keyRevision: material.keyRevision,
      componentKey: material.key,
      plaintext,
    });
  } finally {
    clearSensitiveBytes(plaintext);
    clearSensitiveBytes(material.key);
  }
}

export async function openWorkerRepositoryOperationContent<T>(input: {
  context: RepositoryOperationContext;
  opaque: unknown;
  schema: RepositoryOperationContentSchema<T>;
  service: WorkerEncryptionService;
}): Promise<T> {
  const opaque = repositoryOperationOpaqueSchema.parse(input.opaque);
  const material = componentKey({
    service: input.service,
    keyRevision: opaque.keyRevision,
  });
  let plaintext: Uint8Array | null = null;
  try {
    plaintext = await decryptRepositoryOperationPayload({
      ownerId: material.ownerId,
      context: input.context,
      keyRevision: material.keyRevision,
      componentKey: material.key,
      opaque,
    });
    return input.schema.parse(JSON.parse(decoder.decode(plaintext)));
  } catch (error) {
    if (error instanceof CantripDecryptionError) {
      throw new Error(
        "Protected repository content could not be authenticated.",
      );
    }
    throw error;
  } finally {
    if (plaintext) clearSensitiveBytes(plaintext);
    clearSensitiveBytes(material.key);
  }
}

export class RepositoryOperationReplayGuard {
  readonly #completed = new Map<string, true>();

  reserve(context: RepositoryOperationContext): void {
    const key = JSON.stringify([
      context.serverId,
      context.projectId,
      context.worktreeId,
      context.operationId,
    ]);
    if (this.#completed.has(key)) {
      throw new Error("Protected repository operation was already completed.");
    }
    this.#completed.set(key, true);
    while (this.#completed.size > MAX_REPLAY_RECORDS) {
      const oldest = this.#completed.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#completed.delete(oldest);
    }
  }
}
