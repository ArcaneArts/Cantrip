import { createHash, createHmac } from "node:crypto";
import {
  clearSensitiveBytes,
  decryptPayload,
  deriveFieldKey,
  encryptPayload,
} from "@cantrip/crypto";
import {
  encryptionAssociatedDataSchema,
  type EncryptedPayloadEnvelope,
} from "@cantrip/protocol/encryption";
import type { WorkerEncryptionService } from "./worker-encryption.js";

export interface NativeCommandContentContext {
  chatId: string;
  operationId: string;
  direction: "request" | "result" | "terminal-result";
}
type EncryptionService = Pick<
  WorkerEncryptionService,
  "componentKey" | "ownerId" | "serverIdentity"
>;

function material(
  service: EncryptionService,
  context: NativeCommandContentContext,
  revision?: number,
) {
  const component = service.componentKey("chat-content", revision);
  try {
    const associatedData = encryptionAssociatedDataSchema.parse({
      ownerId: service.ownerId(),
      component: "chat-content",
      table: "native-command-admission",
      rowId: createHash("sha256")
        .update(
          JSON.stringify([
            service.serverIdentity(),
            context.chatId,
            context.operationId,
          ]),
        )
        .digest("hex"),
      field: context.direction,
      formatVersion: 1,
      keyRevision: component.keyRevision,
    });
    return {
      associatedData,
      key: deriveFieldKey({
        componentKey: component.key,
        ownerId: associatedData.ownerId,
        component: associatedData.component,
        table: associatedData.table,
        field: associatedData.field,
        keyRevision: associatedData.keyRevision,
      }),
    };
  } finally {
    clearSensitiveBytes(component.key);
  }
}

/** Opaque durable input/results; neither raw RPC content nor guessable hashes are published. */
export async function protectNativeCommandContent(input: {
  service: EncryptionService;
  context: NativeCommandContentContext;
  content: unknown;
}): Promise<{ envelope: EncryptedPayloadEnvelope; digest: string }> {
  const serialized = JSON.stringify(input.content);
  if (serialized === undefined)
    throw new Error("Native command content must be JSON.");
  const { key, associatedData } = material(input.service, input.context);
  const plaintext = new TextEncoder().encode(serialized);
  try {
    // Stable for an identical operation, but keyed to prevent offline guessing
    // of short prompts, answers or credentials from the admission digest.
    const digest = createHmac("sha256", key)
      .update(JSON.stringify(associatedData))
      .update(plaintext)
      .digest("hex");
    return {
      envelope: await encryptPayload({ key, plaintext, associatedData }),
      digest,
    };
  } finally {
    clearSensitiveBytes(plaintext);
    clearSensitiveBytes(key);
  }
}

export async function openNativeCommandContent(input: {
  service: EncryptionService;
  context: NativeCommandContentContext;
  envelope: EncryptedPayloadEnvelope;
}): Promise<unknown> {
  const { key, associatedData } = material(
    input.service,
    input.context,
    input.envelope.keyRevision,
  );
  try {
    const plaintext = await decryptPayload({
      key,
      associatedData,
      envelope: input.envelope,
    });
    try {
      return JSON.parse(new TextDecoder().decode(plaintext));
    } finally {
      clearSensitiveBytes(plaintext);
    }
  } finally {
    clearSensitiveBytes(key);
  }
}
