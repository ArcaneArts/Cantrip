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

import {
  WorkerEncryptionError,
  type WorkerEncryptionService,
} from "./worker-encryption.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_ACTIVE_STREAMS = 10_000;
const MAX_REPLAY_RECORDS = 10_000;

export type SurfaceStreamContentSchema<T> = { parse(value: unknown): T };

function componentKey(input: {
  keyRevision?: number;
  service: WorkerEncryptionService;
}): { key: Uint8Array; keyRevision: number; ownerId: string } {
  try {
    const material = input.service.componentKey("surface-private-state");
    if (
      input.keyRevision !== undefined &&
      input.keyRevision !== material.keyRevision
    ) {
      clearSensitiveBytes(material.key);
      throw new Error("Protected surface content uses a stale key revision.");
    }
    return { ...material, ownerId: input.service.ownerId() };
  } catch (error) {
    if (error instanceof WorkerEncryptionError) {
      throw new Error("Surface stream encryption is unavailable.");
    }
    throw error;
  }
}

export async function protectWorkerSurfaceStreamContent<T>(input: {
  context: SurfaceStreamContext;
  content: T;
  schema: SurfaceStreamContentSchema<T>;
  service: WorkerEncryptionService;
}): Promise<SurfaceStreamOpaque> {
  const material = componentKey(input);
  const plaintext = encoder.encode(
    JSON.stringify(input.schema.parse(input.content)),
  );
  try {
    return await encryptSurfaceStreamPayload({
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

export async function openWorkerSurfaceStreamContent<T>(input: {
  context: SurfaceStreamContext;
  opaque: unknown;
  schema: SurfaceStreamContentSchema<T>;
  service: WorkerEncryptionService;
}): Promise<T> {
  const opaque = surfaceStreamOpaqueSchema.parse(input.opaque);
  const material = componentKey({
    service: input.service,
    keyRevision: opaque.keyRevision,
  });
  let plaintext: Uint8Array | null = null;
  try {
    plaintext = await decryptSurfaceStreamPayload({
      ownerId: material.ownerId,
      context: input.context,
      keyRevision: material.keyRevision,
      componentKey: material.key,
      opaque,
    });
    return input.schema.parse(JSON.parse(decoder.decode(plaintext)));
  } catch (error) {
    if (error instanceof CantripDecryptionError) {
      throw new Error("Protected surface content could not be authenticated.");
    }
    throw error;
  } finally {
    if (plaintext) clearSensitiveBytes(plaintext);
    clearSensitiveBytes(material.key);
  }
}

function replayKey(context: SurfaceStreamContext): string {
  return JSON.stringify([
    context.serverId,
    context.surfaceKind,
    context.surfaceId,
    context.operationId,
    context.direction,
  ]);
}

export class SurfaceStreamReplayGuard {
  readonly #completed = new Map<string, true>();
  readonly #next = new Map<string, number>();

  reserve(context: SurfaceStreamContext): void {
    const key = replayKey(context);
    if (this.#completed.has(key)) {
      throw new Error("Protected surface operation was already completed.");
    }
    const activeSequence = this.#next.get(key);
    if (activeSequence === undefined && this.#next.size >= MAX_ACTIVE_STREAMS) {
      throw new Error("Too many protected surface operations are active.");
    }
    const expected = activeSequence ?? 0;
    if (context.sequence !== expected) {
      throw new Error(
        `Expected protected surface sequence ${expected}, received ${context.sequence}.`,
      );
    }
    this.#next.set(key, context.sequence + 1);
  }

  accept(context: SurfaceStreamContext, complete: boolean): void {
    const key = replayKey(context);
    if (this.#next.get(key) !== context.sequence + 1) {
      throw new Error("Protected surface sequence was not reserved.");
    }
    if (complete) {
      this.#next.delete(key);
      this.#completed.delete(key);
      this.#completed.set(key, true);
      while (this.#completed.size > MAX_REPLAY_RECORDS) {
        const oldest = this.#completed.keys().next().value;
        if (typeof oldest !== "string") break;
        this.#completed.delete(oldest);
      }
    }
  }

  release(context: Omit<SurfaceStreamContext, "sequence">): void {
    const key = replayKey({ ...context, sequence: 0 });
    this.#next.delete(key);
    this.#completed.delete(key);
  }
}
