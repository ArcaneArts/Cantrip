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

import {
  WorkerEncryptionError,
  type WorkerEncryptionService,
} from "./worker-encryption.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type EndpointContentSchema<T> = { parse(value: unknown): T };

function componentKey(input: {
  context: EndpointContentContext;
  keyRevision?: number;
  service: WorkerEncryptionService;
}): { key: Uint8Array; keyRevision: number; ownerId: string } {
  try {
    const context = endpointContentContextSchema.parse(input.context);
    const material = input.service.componentKey(
      context.domain,
      input.keyRevision,
    );
    if (
      input.keyRevision !== undefined &&
      input.keyRevision !== material.keyRevision
    ) {
      clearSensitiveBytes(material.key);
      throw new Error("Protected endpoint content uses a stale key.");
    }
    return { ...material, ownerId: input.service.ownerId() };
  } catch (error) {
    if (error instanceof WorkerEncryptionError) {
      throw new Error("Endpoint content encryption is unavailable.");
    }
    throw error;
  }
}

export async function protectWorkerEndpointContent<T>(input: {
  context: EndpointContentContext;
  content: T;
  schema: EndpointContentSchema<T>;
  service: WorkerEncryptionService;
}): Promise<EndpointContentOpaque> {
  const context = endpointContentContextSchema.parse(input.context);
  const material = componentKey({ context, service: input.service });
  const plaintext = encoder.encode(
    JSON.stringify(input.schema.parse(input.content)),
  );
  try {
    return await encryptEndpointContentPayload({
      ownerId: material.ownerId,
      context,
      keyRevision: material.keyRevision,
      componentKey: material.key,
      plaintext,
    });
  } finally {
    clearSensitiveBytes(plaintext);
    clearSensitiveBytes(material.key);
  }
}

export async function openWorkerEndpointContent<T>(input: {
  context: EndpointContentContext;
  opaque: unknown;
  schema: EndpointContentSchema<T>;
  service: WorkerEncryptionService;
}): Promise<T> {
  const context = endpointContentContextSchema.parse(input.context);
  const opaque = endpointContentOpaqueSchema.parse(input.opaque);
  const material = componentKey({
    context,
    keyRevision: opaque.keyRevision,
    service: input.service,
  });
  let plaintext: Uint8Array | null = null;
  try {
    plaintext = await decryptEndpointContentPayload({
      ownerId: material.ownerId,
      context,
      keyRevision: material.keyRevision,
      componentKey: material.key,
      opaque,
    });
    return input.schema.parse(JSON.parse(decoder.decode(plaintext)));
  } catch (error) {
    if (error instanceof CantripDecryptionError) {
      throw new Error("Protected endpoint content could not be authenticated.");
    }
    throw error;
  } finally {
    if (plaintext) clearSensitiveBytes(plaintext);
    clearSensitiveBytes(material.key);
  }
}
