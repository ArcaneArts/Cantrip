import { createHash } from "node:crypto";
import {
  clearSensitiveBytes,
  decryptPayload,
  deriveFieldKey,
  encryptPayload,
} from "@cantrip/crypto";
import {
  encryptedPayloadEnvelopeSchema,
  type EncryptionAssociatedData,
} from "@cantrip/protocol/encryption";
import { z } from "zod";
import type { WorkerEncryptionService } from "./worker-encryption.js";

export const nativeResourceBindingSchema = z
  .object({
    threadId: z.string().min(1).max(255),
    turnId: z.string().min(1).max(255),
    checkpointId: z.string().min(1).max(255),
  })
  .strict();

export const protectedNativeResourcesSchema = z
  .object({
    formatVersion: z.literal(1),
    envelope: encryptedPayloadEnvelopeSchema,
  })
  .strict();

export type NativeResourceBinding = z.infer<typeof nativeResourceBindingSchema>;
export type ProtectedNativeResources = z.infer<
  typeof protectedNativeResourcesSchema
>;

export const nativeResourceProtectionRequestSchema = nativeResourceBindingSchema
  .extend({
    runnerGeneration: z.string().min(1).max(255),
    requestId: z.string().uuid(),
    seal: z.boolean(),
    value: z.unknown(),
  })
  .strict();

/** Pure metadata protection. It neither grants nor starts native execution. */
export interface NativeResourceProtection {
  seal(
    binding: NativeResourceBinding,
    value: unknown,
  ): Promise<ProtectedNativeResources>;
  open(binding: NativeResourceBinding, value: unknown): Promise<unknown>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const table = "native_turn_resources";
const field = "payload";
const component = "chat-content" as const;

function material(
  service: WorkerEncryptionService,
  input: NativeResourceBinding,
  revision?: number,
) {
  const binding = nativeResourceBindingSchema.parse(input);
  const ownerId = service.ownerId();
  const serverId = service.serverIdentity();
  const principalId = service.registration().principalId;
  // This attempts actual use of the current grant. No status-string readiness
  // checks, persisted component keys, or worker-private-key fallback participate.
  const granted = service.componentKey(component, revision);
  try {
    const associatedData: EncryptionAssociatedData = {
      component,
      table,
      field,
      ownerId,
      formatVersion: 1,
      keyRevision: granted.keyRevision,
      rowId: createHash("sha256")
        .update(
          JSON.stringify([
            "cantrip-native-turn-resources",
            1,
            serverId,
            principalId,
            binding.threadId,
            binding.turnId,
            binding.checkpointId,
          ]),
        )
        .digest("hex"),
    };
    return {
      associatedData,
      key: deriveFieldKey({
        componentKey: granted.key,
        ownerId,
        component,
        table,
        field,
        keyRevision: granted.keyRevision,
      }),
    };
  } finally {
    clearSensitiveBytes(granted.key);
  }
}

export function createNativeResourceProtection(
  service: WorkerEncryptionService,
): NativeResourceProtection {
  return {
    async seal(binding, value) {
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(value);
      } catch {
        throw new Error("Native resource state could not be serialized.");
      }
      if (serialized === undefined)
        throw new Error("Native resource state is not JSON data.");
      const encryption = material(service, binding);
      let plaintext: Uint8Array | undefined;
      try {
        plaintext = encoder.encode(serialized);
        return protectedNativeResourcesSchema.parse({
          formatVersion: 1,
          envelope: await encryptPayload({
            key: encryption.key,
            plaintext,
            associatedData: encryption.associatedData,
          }),
        });
      } finally {
        if (plaintext) clearSensitiveBytes(plaintext);
        clearSensitiveBytes(encryption.key);
      }
    },
    async open(binding, value) {
      const opaque = protectedNativeResourcesSchema.safeParse(value);
      if (!opaque.success)
        throw new Error(
          "Native resource protection format is invalid or unsupported.",
        );
      const encryption = material(
        service,
        binding,
        opaque.data.envelope.keyRevision,
      );
      let plaintext: Uint8Array | undefined;
      try {
        plaintext = await decryptPayload({
          key: encryption.key,
          envelope: opaque.data.envelope,
          associatedData: encryption.associatedData,
        });
        try {
          return JSON.parse(decoder.decode(plaintext)) as unknown;
        } catch {
          throw new Error("Native resource state is invalid or incompatible.");
        }
      } finally {
        if (plaintext) clearSensitiveBytes(plaintext);
        clearSensitiveBytes(encryption.key);
      }
    },
  };
}
